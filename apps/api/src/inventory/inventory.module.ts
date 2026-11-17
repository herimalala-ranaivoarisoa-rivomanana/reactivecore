import { MutationModule } from '../mutation/mutation.module.js';
import { TransferMutationService } from './transfer-mutation.service.js';
import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { InventoryRepository } from './inventory.repository.js';
import { InventoryService } from './inventory.service.js';

import { StockQueriesService } from './stock-queries.service.js';
import { StockQueryRepository } from './stock-query.repository.js';

@Module({
  imports: [DatabaseModule, MutationModule],
  providers: [
    TransferMutationService,
    InventoryRepository,
    InventoryService,
    StockQueriesService,
    StockQueryRepository,
  ],
  exports: [InventoryService],
})
export class InventoryModule {}
