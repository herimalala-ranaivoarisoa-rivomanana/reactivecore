import type {
  ChangeDescriptor,
  Dependency,
} from '../contracts/dependency.types.js';
import { InvalidationService } from '../invalidation/invalidation.service.js';
import { DependencyIndex } from './dependency-index.js';

const predicate: Dependency = {
  kind: 'predicate',
  tenantId: 'a',
  table: 'stocks',
  index: 'pharmacy',
  equals: { pharmacy_id: 'p', discontinued: false },
  ranges: { quantity: { gt: 0, lte: 10 } },
};
const change: ChangeDescriptor = {
  tenantId: 'a',
  table: 'stocks',
  documentId: 'stock',
  operation: 'insert',
  before: null,
  after: { pharmacy_id: 'p', discontinued: false, quantity: 1 },
};

it('indexes tables, documents and ranges, and atomically replaces buckets', () => {
  const index = new DependencyIndex(new InvalidationService());
  index.replace('range', [predicate]);
  index.replace('document', [
    { kind: 'document', tenantId: 'a', table: 'stocks', documentId: 'stock' },
  ]);
  index.replace('table', [{ kind: 'table', tenantId: 'a', table: 'stocks' }]);
  index.replace('other', [{ ...predicate, tenantId: 'b' }]);
  expect(index.candidates(change)).toEqual(
    new Set(['range', 'document', 'table']),
  );

  index.replace('range', [{ ...predicate, table: 'orders' }]);
  index.remove('document');
  expect(index.candidates(change)).toEqual(new Set(['table']));
  expect(index.candidates({ ...change, table: 'orders' })).toEqual(
    new Set(['range']),
  );
});

it('handles numeric boundaries and incomplete row values conservatively', () => {
  const index = new DependencyIndex(new InvalidationService());
  index.replace('range', [predicate]);
  for (const quantity of [0, 11]) {
    expect(
      index.candidates({ ...change, after: { ...change.after, quantity } }),
    ).toEqual(new Set());
  }
  expect(
    index.candidates({
      ...change,
      after: { pharmacy_id: 'p', discontinued: false },
    }),
  ).toEqual(new Set(['range']));
  expect(index.candidates({ ...change, after: { quantity: 0 } })).toEqual(
    new Set(),
  );
  expect(
    index.candidates({ ...change, after: { ...change.after, quantity: 10 } }),
  ).toEqual(new Set(['range']));
  expect(
    index.candidates({
      ...change,
      operation: 'delete',
      before: change.after,
      after: null,
    }),
  ).toEqual(new Set(['range']));
});
