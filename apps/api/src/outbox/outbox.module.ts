import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { OutboxService } from './outbox.service.js';

@Module({
  imports: [DatabaseModule, RedisModule],
  providers: [OutboxService],
})
export class OutboxModule {}
