import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ChangeLogService,
  type JournalChange,
} from '../reactive/changelog/change-log.service.js';

const stockEventTypes = {
  insert: 'stock.inserted',
  update: 'stock.updated',
  delete: 'stock.deleted',
};

@Injectable()
export class MutationCommitService {
  constructor(private readonly journal: ChangeLogService) {}

  async commitChanges(
    client: PoolClient,
    tenantId: string,
    changes: readonly (JournalChange & {
      notification?: Record<string, unknown>;
    })[],
  ): Promise<string> {
    if (changes.length === 0)
      throw new Error('A successful mutation must record a change');
    const seq = await this.journal.append(client, changes);
    const events = changes.map(({ notification, ...change }) => ({
      event_id: change.eventId,
      event_type:
        change.table === 'stocks'
          ? stockEventTypes[change.operation]
          : 'reactive.changed',
      aggregate_id: change.documentId,
      payload: {
        ...notification,
        ...change,
        tenantId,
        schemaVersion: 1,
        commitSeq: seq,
      },
    }));
    await client.query(
      `INSERT INTO event_outbox (tenant_id, commit_seq, event_id, event_type, aggregate_id, payload)
       SELECT $1, $2, event_id, event_type, aggregate_id, payload
       FROM jsonb_to_recordset($3::jsonb)
         AS event(event_id uuid, event_type text, aggregate_id uuid, payload jsonb)`,
      [tenantId, seq, JSON.stringify(events)],
    );
    return seq;
  }
}
