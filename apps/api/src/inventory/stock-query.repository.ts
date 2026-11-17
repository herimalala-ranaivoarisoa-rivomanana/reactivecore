import { Injectable } from '@nestjs/common';

import type { QueryContext } from '../reactive/contracts/query-context.js';

export interface StockQueryRow {
  id: string;
  medicineId: string;
  quantity: number;
  version: string;
}

@Injectable()
export class StockQueryRepository {
  async findByPharmacy(
    ctx: QueryContext,
    pharmacyId: string,
    availableOnly: boolean,
  ): Promise<StockQueryRow[]> {
    const result = await ctx.client.query<{
      id: string;
      medicine_id: string;
      quantity: number;
      version: string;
    }>(
      `
      SELECT
        id,
        medicine_id,
        quantity,
        version
      FROM stocks
      WHERE tenant_id = $1
        AND pharmacy_id = $2
        AND ($3::boolean = false OR quantity > 0)
      ORDER BY medicine_id
      `,
      [ctx.principal.tenantId, pharmacyId, availableOnly],
    );

    // Dépendance conservatrice : toute modification
    // de stock dans cette pharmacie peut affecter
    // le résultat, y compris une nouvelle insertion.
    ctx.dependencies.add({
      kind: 'predicate',
      tenantId: ctx.principal.tenantId,
      table: 'stocks',
      index: 'idx_stocks_pharmacy',
      equals: {
        pharmacy_id: pharmacyId,
      },
    });

    return result.rows.map((row) => ({
      id: row.id,
      medicineId: row.medicine_id,
      quantity: row.quantity,
      version: row.version,
    }));
  }
}
