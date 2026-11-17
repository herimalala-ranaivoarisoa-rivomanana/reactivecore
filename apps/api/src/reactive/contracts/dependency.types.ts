export type Scalar = string | number | boolean | null;
export interface NumericRange {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

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

export interface ChangeDescriptor {
  tenantId: string;
  table: string;
  documentId: string;
  operation: 'insert' | 'update' | 'delete';

  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}
