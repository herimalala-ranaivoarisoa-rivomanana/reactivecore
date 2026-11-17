import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';

import { createHash, randomUUID } from 'node:crypto';
import type { JournalChange } from '../reactive/changelog/change-log.service.js';
import type { PoolClient } from 'pg';
import { MutationEngineService } from '../mutation/mutation-engine.service.js';
import { MutationCommitService } from '../mutation/mutation-commit.service.js';
import { InventoryRepository } from './inventory.repository.js';

import type { SellMedicineCommand, SaleResult } from './inventory.types.js';

type SaleOutcome = SaleResult | { rejected: 'insufficient_stock' };

@Injectable()
export class InventoryService {
  constructor(
    private readonly engine: MutationEngineService,
    private readonly repository: InventoryRepository,
    private readonly commit: MutationCommitService,
  ) {}

  async sell(command: SellMedicineCommand): Promise<SaleResult> {
    const { tenantId, pharmacyId, medicineId, quantity, idempotencyKey } =
      command;

    if (
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > 1_000_000
    ) {
      throw new BadRequestException('Quantity must be a positive safe integer');
    }

    const canonicalRequest = JSON.stringify({
      operation: 'stocks.sell',
      version: 1,
      pharmacyId,
      medicineId,
      quantity,
    });

    const requestHash = createHash('sha256')
      .update(canonicalRequest)
      .digest('hex');

    const outcome = await this.engine.runSerializable<SaleOutcome>(
      tenantId,
      async (client) => {
        const receiptInsert = await client.query(
          `
          INSERT INTO mutation_receipts (
            tenant_id,
            idempotency_key,
            request_hash
          )
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
          RETURNING idempotency_key
          `,
          [tenantId, idempotencyKey, requestHash],
        );

        if (receiptInsert.rowCount === 0) {
          const previous = await client.query<{
            request_hash: string;
            result: SaleOutcome | null;
          }>(
            `
            SELECT request_hash, result
            FROM mutation_receipts
            WHERE tenant_id = $1
              AND idempotency_key = $2
            `,
            [tenantId, idempotencyKey],
          );

          const receipt = previous.rows[0];

          if (!receipt) {
            throw new ConflictException('Idempotency receipt unavailable');
          }

          if (receipt.request_hash !== requestHash) {
            throw new ConflictException(
              'Idempotency key reused with different arguments',
            );
          }

          if (!receipt.result) {
            throw new ConflictException('Mutation result unavailable');
          }

          return receipt.result;
        }

        const stock = await this.repository.decrementStock(
          client,
          tenantId,
          pharmacyId,
          medicineId,
          quantity,
        );

        if (!stock) {
          const refusal = { rejected: 'insufficient_stock' } as const;
          await this.saveReceipt(client, command, refusal);
          return refusal;
        }

        const saleId = await this.repository.createSale(
          client,
          tenantId,
          pharmacyId,
          medicineId,
          quantity,
        );

        const result: SaleResult = {
          saleId,
          stockId: stock.id,
          remainingQuantity: stock.quantity,
          stockVersion: stock.version,
        };

        const change: JournalChange = {
          eventId: randomUUID(),
          table: 'stocks',
          documentId: stock.id,
          operation: 'update',
          before: {
            pharmacy_id: pharmacyId,
            medicine_id: medicineId,
            quantity: stock.quantity + quantity,
          },
          after: {
            pharmacy_id: pharmacyId,
            medicine_id: medicineId,
            quantity: stock.quantity,
          },
        };
        await this.saveReceipt(client, command, result);
        await this.commit.commitChanges(client, tenantId, [
          {
            ...change,
            notification: {
              saleId,
              stockId: stock.id,
              pharmacyId,
              medicineId,
              remainingQuantity: stock.quantity,
              version: stock.version,
              stockVersion: stock.version,
            },
          },
        ]);
        return result;
      },
    );
    if ('rejected' in outcome) {
      throw new ConflictException('Insufficient stock or stock not found');
    }
    return outcome;
  }

  private async saveReceipt(
    client: PoolClient,
    command: SellMedicineCommand,
    outcome: SaleOutcome,
  ): Promise<void> {
    await client.query(
      `UPDATE mutation_receipts SET result = $3::jsonb
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [command.tenantId, command.idempotencyKey, JSON.stringify(outcome)],
    );
  }
}
