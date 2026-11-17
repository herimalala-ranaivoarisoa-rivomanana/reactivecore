import { Module } from '@nestjs/common';

import { DatabaseModule } from './database/database.module.js';
import { RedisModule } from './redis/redis.module.js';
import { HealthModule } from './health/health.module.js';

import { InventoryModule } from './inventory/inventory.module.js';

import { ReactiveModule } from './reactive/reactive.module.js';

@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    HealthModule,
    InventoryModule,
    ReactiveModule,
  ],
})
export class AppModule {}
