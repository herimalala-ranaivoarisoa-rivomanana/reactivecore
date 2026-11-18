export type Scalar = string | number | boolean | null;
/** Optional lower and upper bounds for a numeric dependency predicate. */
export interface NumericRange {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

/** Tenant-scoped data a query depends on, at document, predicate, or table granularity. */
export type Dependency =
  | {
      kind: 'document';
      tenantId: string;
      table: string;
      documentId: string;
    }
  | {
      kind: 'predicate';
      tenantId: string;
      table: string;
      index: string;
      equals: Record<string, Scalar>;
      ranges?: Record<string, NumericRange>;
    }
  | {
      kind: 'table';
      tenantId: string;
      table: string;
    };

/**
 * A committed change used for invalidation. A null row is known to be absent.
 * An omitted row or field represents missing information and is matched conservatively.
 */
export interface ChangeDescriptor {
  tenantId: string;
  table: string;
  documentId: string;
  operation: 'insert' | 'update' | 'delete';

  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}
