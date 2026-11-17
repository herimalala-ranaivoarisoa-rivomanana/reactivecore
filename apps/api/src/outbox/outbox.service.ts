import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { RedisService } from '../redis/redis.service.js';

import { INVALIDATION_CHANNEL } from './invalidation-channel.js';

interface OutboxEvent {
  event_id: string;
  tenant_id: string;
  event_type: string;
  aggregate_id: string;
  payload: unknown;
}

@Injectable()
export class OutboxService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async publishNext(): Promise<boolean> {
    const token = randomUUID();
    const {
      rows: [event],
    } = await this.database.query<OutboxEvent>(
      `WITH candidate AS (
         SELECT id FROM event_outbox
         WHERE published_at IS NULL AND available_at <= now()
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       UPDATE event_outbox AS event
       SET lease_token = $1, available_at = now() + interval '30 seconds',
           attempts = attempts + 1
       FROM candidate WHERE event.id = candidate.id
       RETURNING event.event_id, event.tenant_id, event.event_type,
                 event.aggregate_id, event.payload`,
      [token],
    );
    if (!event) return false;

    try {
      await this.redis.publish(
        INVALIDATION_CHANNEL,
        JSON.stringify({
          eventId: event.event_id,
          tenantId: event.tenant_id,
          type: event.event_type,
          aggregateId: event.aggregate_id,
          payload: event.payload,
        }),
      );
    } catch (error) {
      await this.database.query(
        `UPDATE event_outbox SET lease_token = NULL,
           available_at = now() + LEAST(attempts, 30) * interval '1 second'
         WHERE event_id = $1 AND lease_token = $2`,
        [event.event_id, token],
      );
      throw error;
    }

    await this.database.query(
      `UPDATE event_outbox SET published_at = now(), lease_token = NULL
       WHERE event_id = $1 AND lease_token = $2 AND available_at > now()`,
      [event.event_id, token],
    );
    return true;
  }
}
