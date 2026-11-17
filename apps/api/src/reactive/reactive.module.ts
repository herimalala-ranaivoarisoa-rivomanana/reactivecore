import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { DatabaseModule } from '../database/database.module.js';

import { QueryRegistryService } from './registry/query-registry.service.js';
import { DependencyTrackerService } from './engine/dependency-tracker.service.js';
import { QueryExecutorService } from './engine/query-executor.service.js';
import { InvalidationService } from './invalidation/invalidation.service.js';
import { SubscriptionManagerService } from './subscriptions/subscription-manager.service.js';

import { ReactiveController } from './reactive.controller.js';
import { RedisInvalidationService } from './invalidation/redis-invalidation.service.js';

@Module({
  controllers: [ReactiveController],
  imports: [DatabaseModule, DiscoveryModule],
  providers: [
    QueryRegistryService,
    DependencyTrackerService,
    QueryExecutorService,
    InvalidationService,
    SubscriptionManagerService,
    RedisInvalidationService,
  ],
  exports: [
    QueryExecutorService,
    SubscriptionManagerService,
    InvalidationService,
  ],
})
export class ReactiveModule {}
