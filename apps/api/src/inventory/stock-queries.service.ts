import { BadRequestException, Injectable } from '@nestjs/common';

import { validateSync, IsBoolean, IsUUID } from 'class-validator';

import { ReactiveQuery } from '../reactive/decorators/reactive-query.decorator.js';

import type { QueryContext } from '../reactive/contracts/query-context.js';

import { StockQueryRepository } from './stock-query.repository.js';

class StockQueryArgs {
  @IsUUID()
  pharmacyId!: string;

  @IsBoolean()
  availableOnly!: boolean;
}

@Injectable()
export class StockQueriesService {
  constructor(private readonly stocks: StockQueryRepository) {}

  @ReactiveQuery('stocks.list')
  async listStocks(ctx: QueryContext, rawArgs: unknown) {
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      throw new BadRequestException('Invalid arguments');
    }

    const input = rawArgs as Record<string, unknown>;

    if (
      Object.keys(input).some(
        (key) => key !== 'pharmacyId' && key !== 'availableOnly',
      )
    ) {
      throw new BadRequestException('Invalid stock query arguments');
    }

    const args = new StockQueryArgs();
    args.pharmacyId = input.pharmacyId as string;
    args.availableOnly = input.availableOnly as boolean;

    if (validateSync(args).length > 0) {
      throw new BadRequestException('Invalid stock query arguments');
    }

    // Une vérification d'autorisation par pharmacie
    // sera ajoutée ici dans la version sécurisée.

    return this.stocks.findByPharmacy(
      ctx,
      args.pharmacyId.toLowerCase(),
      args.availableOnly,
    );
  }
}
