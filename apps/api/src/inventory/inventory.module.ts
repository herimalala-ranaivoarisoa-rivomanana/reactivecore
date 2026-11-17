import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryRepository } from './inventory.repository.js';
import { InventoryService } from './inventory.service.js';

import { StockQueriesService } from './stock-queries.service.js';
import { StockQueryRepository } from './stock-query.repository.js';

@Module({
  imports: [DatabaseModule],
  controllers: [InventoryController],
  providers: [
    InventoryRepository,
    InventoryService,
    StockQueriesService,
    StockQueryRepository,
  ],
  exports: [InventoryService],
})
export class InventoryModule {}
