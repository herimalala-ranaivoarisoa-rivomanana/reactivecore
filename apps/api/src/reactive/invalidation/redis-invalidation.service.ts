import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createClient, type RedisClientType } from 'redis';
import { INVALIDATION_CHANNEL } from '../../outbox/invalidation-channel.js';
import type { ChangeDescriptor } from '../contracts/dependency.types.js';
import { SubscriptionManagerService } from '../subscriptions/subscription-manager.service.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && isUUID(value);
}

export function parseStockChange(
  message: string,
): ChangeDescriptor | undefined {
  let event: unknown;
  try {
    event = JSON.parse(message);
  } catch {
    return;
  }

  if (
    !record(event) ||
    event.type !== 'stock.updated' ||
    !uuid(event.eventId) ||
    !uuid(event.tenantId) ||
    !uuid(event.aggregateId)
  )
    return;

  const payload = event.payload;
  const change: ChangeDescriptor = {
    tenantId: event.tenantId.toLowerCase(),
    table: 'stocks',
    documentId: event.aggregateId.toLowerCase(),
    operation: 'update',
  };
  if (!record(payload)) return;
  if (payload.schemaVersion === undefined) {
    // Module 02 events may still be waiting in PostgreSQL.
    return change;
  }
  if (
    payload.schemaVersion !== 1 ||
    payload.tenantId !== event.tenantId ||
    payload.table !== change.table ||
    payload.documentId !== event.aggregateId ||
    payload.operation !== change.operation
  )
    return;

  for (const side of ['before', 'after'] as const) {
    const row = payload[side];
    if (record(row) && uuid(row.pharmacy_id)) {
      change[side] = { pharmacy_id: row.pharmacy_id.toLowerCase() };
      if (typeof row.quantity === 'number' && Number.isFinite(row.quantity)) {
        change[side].quantity = row.quantity;
      }
    }
  }
  return change;
}

@Injectable()
export class RedisInvalidationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisInvalidationService.name);
  private client?: RedisClientType;
  private subscribed = false;
  private subscribing = false;
  private retry?: ReturnType<typeof setTimeout>;

  constructor(private readonly subscriptions: SubscriptionManagerService) {}

  onModuleInit(): void {
    const client: RedisClientType = createClient({
      url: process.env.REDIS_URL,
    });
    this.client = client;
    client.on('error', (error: Error) => this.logger.warn(error.message));
    client.on('ready', () => {
      if (this.subscribed) this.subscriptions.reconcileAll();
      else void this.subscribe(client);
    });
    void client.connect().catch((error: unknown) => {
      if (this.client === client) this.logger.warn(error);
    });
  }

  private readonly receive = (message: string): void => {
    const change = parseStockChange(message);
    if (change) this.subscriptions.invalidate(change);
  };

  private async subscribe(client: RedisClientType): Promise<void> {
    if (
      this.client !== client ||
      !client.isReady ||
      this.subscribing ||
      this.subscribed
    )
      return;
    this.subscribing = true;
    try {
      await client.subscribe(INVALIDATION_CHANNEL, this.receive);
      if (this.client !== client) return;
      this.subscribed = true;
      this.subscriptions.reconcileAll();
    } catch (error) {
      if (this.client !== client) return;
      this.logger.warn(error);
      clearTimeout(this.retry);
      this.retry = setTimeout(() => void this.subscribe(client), 1000);
      this.retry.unref();
    } finally {
      this.subscribing = false;
    }
  }

  onModuleDestroy(): void {
    clearTimeout(this.retry);
    const client = this.client;
    this.client = undefined;
    if (client?.isOpen) client.destroy();
  }
}
