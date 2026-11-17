import type { PoolClient } from 'pg';
import type { Dependency } from './dependency.types.js';

export interface QueryPrincipal {
  userId: string;
  tenantId: string;
  roles: readonly string[];
}

export interface DependencyCollector {
  add(dependency: Dependency): void;
  snapshot(): Dependency[];
}

export interface QueryContext {
  principal: QueryPrincipal;
  client: PoolClient;
  dependencies: DependencyCollector;
}
