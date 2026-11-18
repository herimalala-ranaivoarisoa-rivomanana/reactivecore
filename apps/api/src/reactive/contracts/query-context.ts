import type { PoolClient } from 'pg';
import type { Dependency } from './dependency.types.js';

/** Identity and claims verified by the configured JWT issuer. */
export interface QueryPrincipal {
  userId: string;
  tenantId: string;
  roles: readonly string[];
  claims?: Readonly<Record<string, unknown>>;
}

/** Collects the dependencies used to decide whether to rerun a query. */
export interface DependencyCollector {
  add(dependency: Dependency): void;
  snapshot(): Dependency[];
}

/** Tenant-scoped read-only transaction and dependency collector for a query handler. */
export interface QueryContext {
  principal: QueryPrincipal;
  client: PoolClient;
  dependencies: DependencyCollector;
}
