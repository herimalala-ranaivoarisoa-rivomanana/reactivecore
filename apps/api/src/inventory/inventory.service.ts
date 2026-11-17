import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';

import { createHash, randomUUID } from 'node:crypto';

import { DatabaseService } from '../database/database.service.js';
import { InventoryRepository } from './inventory.repository.js';

import type { SellMedicineCommand, SaleResult } from './inventory.types.js';

@Injectable()
export class InventoryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: InventoryRepository,
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

    return this.database.tenantTransaction(tenantId, async (client) => {
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
          result: SaleResult | null;
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
        throw new ConflictException('Insufficient stock or stock not found');
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

      await client.query(
        `
          INSERT INTO event_outbox (
            event_id,
            tenant_id,
            event_type,
            aggregate_id,
            payload
          )
          VALUES ($1, $2, $3, $4, $5::jsonb)
          `,
        [
          randomUUID(),
          tenantId,
          'stock.updated',
          stock.id,
          JSON.stringify({
            saleId,
            stockId: stock.id,
            pharmacyId,
            medicineId,
            remainingQuantity: stock.quantity,
            version: stock.version,
          }),
        ],
      );

      await client.query(
        `
          UPDATE mutation_receipts
          SET result = $3::jsonb
          WHERE tenant_id = $1
            AND idempotency_key = $2
          `,
        [tenantId, idempotencyKey, JSON.stringify(result)],
      );

      return result;
    });
  }
}
