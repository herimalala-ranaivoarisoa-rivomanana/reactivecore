import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { StockRow } from './inventory.types.js';

@Injectable()
export class InventoryRepository {
  async decrementStock(
    client: PoolClient,
    tenantId: string,
    pharmacyId: string,
    medicineId: string,
    quantity: number,
  ): Promise<StockRow | null> {
    const result = await client.query<StockRow>(
      `
      UPDATE stocks
      SET
        quantity = quantity - $4,
        version = version + 1,
        updated_at = NOW()
      WHERE tenant_id = $1
        AND pharmacy_id = $2
        AND medicine_id = $3
        AND quantity >= $4
      RETURNING id, quantity, version
      `,
      [tenantId, pharmacyId, medicineId, quantity],
    );

    return result.rows[0] ?? null;
  }

  async createSale(
    client: PoolClient,
    tenantId: string,
    pharmacyId: string,
    medicineId: string,
    quantity: number,
  ): Promise<string> {
    const saleId = randomUUID();

    await client.query(
      `
      INSERT INTO sales (
        id, tenant_id, pharmacy_id,
        medicine_id, quantity
      )
      VALUES ($1, $2, $3, $4, $5)
      `,
      [saleId, tenantId, pharmacyId, medicineId, quantity],
    );

    return saleId;
  }
}
