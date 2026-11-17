import type { PoolClient } from 'pg';
import type { QueryPrincipal } from '../reactive/contracts/query-context.js';
import type { JournalChange } from '../reactive/changelog/change-log.service.js';

export interface MutationPrincipal extends QueryPrincipal {
  allowedPharmacyIds: readonly string[];
}

export interface MutationRequest {
  principal: MutationPrincipal;
  name: string;
  args: unknown;
  idempotencyKey: string;
}

export interface MutationResult {
  data: unknown;
  commitSeq: string;
  replayed: boolean;
}

export interface MutationContext {
  client: PoolClient;
  principal: MutationPrincipal;
  recordChange(change: Omit<JournalChange, 'eventId'>): void;
}
