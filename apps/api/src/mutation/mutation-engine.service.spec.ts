import type { DatabaseService } from '../database/database.service.js';
import type { MutationCommitService } from './mutation-commit.service.js';
import { MutationEngineService } from './mutation-engine.service.js';
import type { MutationRegistryService } from './mutation-registry.service.js';

function scenario() {
  const serializableTenantTransaction = vi.fn();
  const engine = new MutationEngineService(
    { serializableTenantTransaction } as unknown as DatabaseService,
    {} as MutationRegistryService,
    {} as MutationCommitService,
  );
  return { engine, serializableTenantTransaction };
}

it('retries the whole transaction on serialization failures and deadlocks', async () => {
  const { engine, serializableTenantTransaction } = scenario();
  serializableTenantTransaction
    .mockRejectedValueOnce({ code: '40001' })
    .mockRejectedValueOnce({ code: '40P01' })
    .mockResolvedValueOnce('committed');
  const write = vi.fn();
  await expect(engine.runSerializable('tenant', write)).resolves.toBe(
    'committed',
  );
  expect(serializableTenantTransaction.mock.calls).toEqual(
    Array.from({ length: 3 }, () => ['tenant', write]),
  );
});

it('surfaces an ambiguous connection failure without automatically retrying', async () => {
  const { engine, serializableTenantTransaction } = scenario();
  const error = Object.assign(new Error('connection lost'), { code: '08006' });
  serializableTenantTransaction.mockRejectedValue(error);
  await expect(engine.runSerializable('tenant', vi.fn())).rejects.toBe(error);
  expect(serializableTenantTransaction).toHaveBeenCalledTimes(1);
});

it('bounds retries and reports an exhausted transaction as unavailable', async () => {
  const { engine, serializableTenantTransaction } = scenario();
  serializableTenantTransaction.mockRejectedValue({ code: '40001' });
  await expect(
    engine.runSerializable('tenant', vi.fn()),
  ).rejects.toHaveProperty('status', 503);
  expect(serializableTenantTransaction).toHaveBeenCalledTimes(6);
});
