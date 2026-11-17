import type {
  ChangeDescriptor,
  Dependency,
} from '../contracts/dependency.types.js';
import type {
  ExecutedQuery,
  QueryExecutorService,
} from '../engine/query-executor.service.js';
import { InvalidationService } from '../invalidation/invalidation.service.js';
import { SubscriptionManagerService } from './subscription-manager.service.js';

const principal = { tenantId: 'tenant-a', userId: 'user-a', roles: [] };
const dependency: Dependency = {
  tenantId: principal.tenantId,
  table: 'stocks',
  kind: 'document',
  documentId: 'initial-stock',
};
const change: ChangeDescriptor = {
  tenantId: principal.tenantId,
  table: 'stocks',
  documentId: 'initial-stock',
  operation: 'update',
};

function deferredQuery() {
  let resolve!: (result: ExecutedQuery) => void;
  const promise = new Promise<ExecutedQuery>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function scenario() {
  const execute = vi.fn<QueryExecutorService['execute']>();
  const manager = new SubscriptionManagerService(
    { execute } as unknown as QueryExecutorService,
    new InvalidationService(),
  );
  return { execute, manager, listener: vi.fn() };
}

it('retries an initial snapshot invalidated while it was reading', async () => {
  const { execute, manager, listener } = scenario();
  const first = deferredQuery();
  execute
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ data: 2, dependencies: [dependency] });
  const subscription = manager.subscribe(
    principal,
    'stocks.list',
    {},
    listener,
  );
  manager.invalidate(change);
  first.resolve({ data: 1, dependencies: [dependency] });
  const id = await subscription;
  expect(listener).toHaveBeenCalledExactlyOnceWith({
    subscriptionId: id,
    data: 2,
    revision: 1,
  });
  manager.unsubscribe(id);
});

it('rechecks a snapshot when a change affects a newly discovered dependency', async () => {
  const { execute, manager, listener } = scenario();
  const pending = deferredQuery();
  const nextDependency = { ...dependency, documentId: 'new-stock' };
  execute
    .mockResolvedValueOnce({ data: 1, dependencies: [dependency] })
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ data: 3, dependencies: [nextDependency] });
  const id = await manager.subscribe(principal, 'stocks.list', {}, listener);

  manager.invalidate({ ...change, tenantId: 'tenant-b' });
  expect(execute).toHaveBeenCalledTimes(1);

  manager.invalidate(change);
  manager.invalidate({ ...change, documentId: 'new-stock' });
  pending.resolve({ data: 2, dependencies: [nextDependency] });
  await vi.waitFor(() =>
    expect(listener).toHaveBeenLastCalledWith({
      subscriptionId: id,
      data: 3,
      revision: 2,
    }),
  );
  expect(listener).toHaveBeenCalledTimes(2);
  manager.unsubscribe(id);
});

it('reconciles without emitting identical results and respects unsubscribe', async () => {
  const { execute, manager, listener } = scenario();
  execute.mockResolvedValue({
    data: { a: 1, b: 2 },
    dependencies: [dependency],
  });
  const id = await manager.subscribe(principal, 'stocks.list', {}, listener);
  execute.mockResolvedValueOnce({
    data: { b: 2, a: 1 },
    dependencies: [dependency],
  });
  manager.reconcileAll();
  await Promise.resolve();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenCalledTimes(1);
  manager.unsubscribe(id);
  manager.invalidate(change);
  expect(execute).toHaveBeenCalledTimes(2);
});
