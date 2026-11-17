import { InvalidationService } from './invalidation.service.js';

describe('InvalidationService', () => {
  const service = new InvalidationService();

  const dependency = {
    kind: 'predicate' as const,
    tenantId: 'tenant-a',
    table: 'stocks',
    index: 'idx_stocks_pharmacy',
    equals: {
      pharmacy_id: 'pharmacy-1',
    },
  };

  it('invalidates a matching pharmacy', () => {
    expect(
      service.affects(dependency, {
        tenantId: 'tenant-a',
        table: 'stocks',
        documentId: 'stock-1',
        operation: 'update',
        after: {
          pharmacy_id: 'pharmacy-1',
          quantity: 8,
        },
      }),
    ).toBe(true);
  });

  it('ignores a different tenant', () => {
    expect(
      service.affects(dependency, {
        tenantId: 'tenant-b',
        table: 'stocks',
        documentId: 'stock-1',
        operation: 'update',
      }),
    ).toBe(false);
  });

  it('ignores a known unrelated pharmacy', () => {
    expect(
      service.affects(dependency, {
        tenantId: 'tenant-a',
        table: 'stocks',
        documentId: 'stock-2',
        operation: 'update',
        before: {
          pharmacy_id: 'pharmacy-2',
        },
        after: {
          pharmacy_id: 'pharmacy-2',
        },
      }),
    ).toBe(false);
  });

  it('invalidates when predicate data is missing', () => {
    expect(
      service.affects(dependency, {
        tenantId: 'tenant-a',
        table: 'stocks',
        documentId: 'stock-3',
        operation: 'update',
      }),
    ).toBe(true);
  });

  it('invalidates both sides of a moved row', () => {
    const change = {
      tenantId: 'tenant-a',
      table: 'stocks',
      documentId: 'stock-4',
      operation: 'update' as const,
      before: {
        pharmacy_id: 'pharmacy-1',
      },
      after: {
        pharmacy_id: 'pharmacy-2',
      },
    };

    expect(service.affects(dependency, change)).toBe(true);

    expect(
      service.affects(
        {
          ...dependency,
          equals: {
            pharmacy_id: 'pharmacy-2',
          },
        },
        change,
      ),
    ).toBe(true);
  });
});

it('checks the existing side for insertions and deletions', () => {
  const service = new InvalidationService();
  const dependency = {
    kind: 'predicate' as const,
    tenantId: 'tenant-a',
    table: 'stocks',
    index: 'idx_stocks_pharmacy',
    equals: { pharmacy_id: 'pharmacy-1' },
  };
  const key = { tenantId: 'tenant-a', table: 'stocks', documentId: 'stock-1' };
  expect(
    service.affects(dependency, {
      ...key,
      operation: 'insert',
      after: { pharmacy_id: 'pharmacy-2' },
    }),
  ).toBe(false);
  expect(
    service.affects(dependency, {
      ...key,
      operation: 'delete',
      before: { pharmacy_id: 'pharmacy-1' },
    }),
  ).toBe(true);
});
