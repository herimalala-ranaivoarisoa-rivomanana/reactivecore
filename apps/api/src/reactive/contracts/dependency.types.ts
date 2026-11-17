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
      equals: Record<string, string>;
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

  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}
