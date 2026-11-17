import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { StockRow } from './inventory.types.js';

interface TransferStock extends StockRow {
  pharmacy_id: string;
  medicine_id: string;
}

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

  async countPharmacies(
    client: PoolClient,
    tenantId: string,
    pharmacyIds: string[],
  ): Promise<number> {
    const { rowCount } = await client.query(
      'SELECT id FROM pharmacies WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
      [tenantId, pharmacyIds],
    );
    return rowCount ?? 0;
  }

  async lockTransferStocks(
    client: PoolClient,
    tenantId: string,
    medicineId: string,
    pharmacyIds: string[],
  ): Promise<TransferStock[]> {
    const { rows } = await client.query<TransferStock>(
      `SELECT id, pharmacy_id, medicine_id, quantity, version
       FROM stocks WHERE tenant_id = $1 AND medicine_id = $2 AND pharmacy_id = ANY($3::uuid[])
       ORDER BY pharmacy_id FOR UPDATE`,
      [tenantId, medicineId, pharmacyIds],
    );
    return rows;
  }

  async adjustStock(
    client: PoolClient,
    tenantId: string,
    stock: StockRow,
    delta: number,
  ): Promise<TransferStock | undefined> {
    const {
      rows: [updated],
    } = await client.query<TransferStock>(
      `UPDATE stocks SET quantity = quantity + $4, version = version + 1, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND version = $3 AND quantity + $4 >= 0
       RETURNING id, pharmacy_id, medicine_id, quantity, version`,
      [tenantId, stock.id, stock.version, delta],
    );
    return updated;
  }

  async insertStock(
    client: PoolClient,
    tenantId: string,
    pharmacyId: string,
    medicineId: string,
    quantity: number,
  ): Promise<TransferStock | undefined> {
    const {
      rows: [created],
    } = await client.query<TransferStock>(
      `INSERT INTO stocks (id, tenant_id, pharmacy_id, medicine_id, quantity)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, pharmacy_id, medicine_id) DO NOTHING
       RETURNING id, pharmacy_id, medicine_id, quantity, version`,
      [randomUUID(), tenantId, pharmacyId, medicineId, quantity],
    );
    return created;
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
