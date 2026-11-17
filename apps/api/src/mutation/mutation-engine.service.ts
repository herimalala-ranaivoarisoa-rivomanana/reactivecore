import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID, randomInt } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { isIdempotencyKey } from './idempotency-key.js';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import type { JournalChange } from '../reactive/changelog/change-log.service.js';
import { MutationCommitService } from './mutation-commit.service.js';
import { MutationRegistryService } from './mutation-registry.service.js';
import type { MutationRequest, MutationResult } from './mutation.types.js';

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${Array.from(value, canonicalJson).join(',')}]`;
  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  throw new BadRequestException('Mutation arguments must be JSON values');
}

@Injectable()
export class MutationEngineService {
  private readonly metrics = {
    serializationFailures: 0,
    deadlocks: 0,
    retries: 0,
    exhausted: 0,
  };

  retryMetrics() {
    return { ...this.metrics };
  }

  constructor(
    private readonly database: DatabaseService,
    private readonly registry: MutationRegistryService,
    private readonly commit: MutationCommitService,
  ) {}

  async runSerializable<T>(
    tenantId: string,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.database.serializableTenantTransaction(tenantId, run);
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code !== '40001' && code !== '40P01') throw error;
        if (code === '40001') this.metrics.serializationFailures++;
        else this.metrics.deadlocks++;
        if (attempt >= 5) {
          this.metrics.exhausted++;
          throw new ServiceUnavailableException(
            'Transaction retry limit exhausted',
            { cause: error },
          );
        }
        this.metrics.retries++;
        await setTimeout(randomInt(10, 21) * 2 ** attempt);
      }
    }
  }

  async execute({
    principal,
    name,
    args,
    idempotencyKey,
  }: MutationRequest): Promise<MutationResult> {
    if (!isIdempotencyKey(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be a UUID');
    }
    const handler = this.registry.get(name);
    const validated = handler.validate(args);
    handler.authorize(principal, validated);
    const hash = createHash('sha256')
      .update(canonicalJson(validated))
      .digest('hex');
    const key = [
      principal.tenantId,
      principal.userId,
      name,
      idempotencyKey.toLowerCase(),
    ];

    return this.runSerializable(principal.tenantId, async (client) => {
      await client.query(
        "SELECT set_config('app.principal_id', $1::uuid::text, true)",
        [principal.userId],
      );
      const reserved = await client.query(
        `INSERT INTO mutation_execution_receipts
           (tenant_id, principal_id, mutation_name, idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [...key, hash],
      );
      if (reserved.rowCount === 0) {
        const {
          rows: [receipt],
        } = await client.query<{
          request_hash: string;
          response: unknown;
          commit_seq: string | null;
        }>(
          `SELECT request_hash, response, commit_seq::text FROM mutation_execution_receipts
           WHERE tenant_id = $1 AND principal_id = $2 AND mutation_name = $3 AND idempotency_key = $4`,
          key,
        );
        if (!receipt?.commit_seq)
          throw new Error('Incomplete mutation receipt');
        if (receipt.request_hash !== hash)
          throw new ConflictException(
            'Idempotency key reused with different arguments',
          );
        return {
          data: receipt.response,
          commitSeq: receipt.commit_seq,
          replayed: true,
        };
      }

      const changes: JournalChange[] = [];
      const data = await handler.execute(
        {
          principal,
          client,
          recordChange: (change) =>
            changes.push({ ...structuredClone(change), eventId: randomUUID() }),
        },
        structuredClone(validated),
      );
      const response = JSON.stringify(data);
      if (response === undefined)
        throw new Error('A mutation must return a JSON result');
      const commitSeq = await this.commit.commitChanges(
        client,
        principal.tenantId,
        changes,
      );
      const completed = await client.query(
        `UPDATE mutation_execution_receipts SET response = $5::jsonb, commit_seq = $6
         WHERE tenant_id = $1 AND principal_id = $2 AND mutation_name = $3 AND idempotency_key = $4`,
        [...key, response, commitSeq],
      );
      if (completed.rowCount !== 1)
        throw new Error('Mutation receipt could not be completed');
      return { data: JSON.parse(response), commitSeq, replayed: false };
    });
  }
}
