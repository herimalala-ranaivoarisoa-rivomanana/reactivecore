import { Module } from '@nestjs/common';

import { DatabaseModule } from './database/database.module.js';
import { RedisModule } from './redis/redis.module.js';
import { HealthModule } from './health/health.module.js';

import { InventoryModule } from './inventory/inventory.module.js';

import { ReactiveModule } from './reactive/reactive.module.js';

import { MutationModule } from './mutation/mutation.module.js';
import { MutationController } from './mutation/mutation.controller.js';
import { InventoryController } from './inventory/inventory.controller.js';
import { ReactiveController } from './reactive/reactive.controller.js';
import { ReactiveStreamController } from './reactive/reactive-stream.controller.js';

@Module({
  controllers: [
    InventoryController,
    MutationController,
    ReactiveController,
    ReactiveStreamController,
  ],
  imports: [
    DatabaseModule,
    RedisModule,
    HealthModule,
    InventoryModule,
    ReactiveModule,
    MutationModule,
  ],
})
export class AppModule {}
