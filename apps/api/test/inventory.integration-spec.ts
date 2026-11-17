import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { setTimeout } from 'node:timers/promises';
import { DatabaseService } from '../src/database/database.service.js';
import { InventoryRepository } from '../src/inventory/inventory.repository.js';
import { InventoryService } from '../src/inventory/inventory.service.js';
import type { RedisService } from '../src/redis/redis.service.js';
import { OutboxService } from '../src/outbox/outbox.service.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
const workerUrl = process.env.TEST_DATABASE_WORKER_URL;
const redisUrl = process.env.TEST_REDIS_URL;
if (!adminUrl || !appUrl || !workerUrl || !redisUrl) {
  throw new Error(
    'Set TEST_DATABASE_ADMIN_URL, TEST_DATABASE_APP_URL, TEST_DATABASE_WORKER_URL and TEST_REDIS_URL',
  );
}
const databaseTargets = [adminUrl, appUrl, workerUrl].map((value) => {
  const url = new URL(value);
  if (url.pathname !== '/reactivecore_test') {
    throw new Error('Integration tests require the reactivecore_test database');
  }
  return url.host;
});
if (new Set(databaseTargets).size !== 1) {
  throw new Error(
    'All test database URLs must target the same PostgreSQL server',
  );
}

const admin = new Pool({
  connectionString: adminUrl,
  connectionTimeoutMillis: 5000,
});
const database = new DatabaseService(appUrl);
const worker = new DatabaseService(workerUrl);
const inventory = new InventoryService(database, new InventoryRepository());

async function fixture(quantity: number) {
  const tenantId = randomUUID();
  const pharmacyId = randomUUID();
  const medicineId = randomUUID();
  const stockId = randomUUID();
  await admin.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
    tenantId,
    'Integration test',
  ]);
  try {
    await admin.query(
      'INSERT INTO pharmacies (id, tenant_id, name) VALUES ($1, $2, $3)',
      [pharmacyId, tenantId, 'Pharmacy'],
    );
    await admin.query(
      'INSERT INTO medicines (id, tenant_id, name) VALUES ($1, $2, $3)',
      [medicineId, tenantId, 'Medicine'],
    );
    await admin.query(
      'INSERT INTO stocks (id, tenant_id, pharmacy_id, medicine_id, quantity) VALUES ($1, $2, $3, $4, $5)',
      [stockId, tenantId, pharmacyId, medicineId, quantity],
    );
    return {
      tenantId,
      pharmacyId,
      medicineId,
      quantity: 1,
      idempotencyKey: randomUUID(),
    };
  } finally {
    tenants.push(tenantId);
  }
}

const tenants: string[] = [];
afterEach(async () => {
  for (const tenantId of tenants.splice(0)) {
    for (const table of [
      'event_outbox',
      'mutation_receipts',
      'sales',
      'stocks',
      'medicines',
      'pharmacies',
    ]) {
      await admin.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    }
    await admin.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  }
});
afterAll(async () => {
  await Promise.all([
    admin.end(),
    database.onModuleDestroy(),
    worker.onModuleDestroy(),
  ]);
});

async function state(tenantId: string) {
  const {
    rows: [row],
  } = await admin.query(
    `SELECT quantity,
      (SELECT count(*)::int FROM sales WHERE tenant_id = $1) AS sales,
      (SELECT count(*)::int FROM mutation_receipts WHERE tenant_id = $1) AS receipts,
      (SELECT count(*)::int FROM event_outbox WHERE tenant_id = $1) AS events
     FROM stocks WHERE tenant_id = $1`,
    [tenantId],
  );
  return row;
}

it('allows only one concurrent sale of the last unit', async () => {
  const command = await fixture(1);
  const results = await Promise.allSettled([
    inventory.sell(command),
    inventory.sell({ ...command, idempotencyKey: randomUUID() }),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { status: 409 },
  });
  expect(await state(command.tenantId)).toEqual({
    quantity: 0,
    sales: 1,
    receipts: 1,
    events: 1,
  });
});

it('reuses the committed result and rejects a changed request', async () => {
  const command = await fixture(5);
  const [one, two] = await Promise.all([
    inventory.sell(command),
    inventory.sell(command),
  ]);
  expect(one).toEqual(two);
  await expect(
    inventory.sell({ ...command, quantity: 2 }),
  ).rejects.toHaveProperty('status', 409);
  expect(await state(command.tenantId)).toEqual({
    quantity: 4,
    sales: 1,
    receipts: 1,
    events: 1,
  });
});

it('rolls back stock, sale and receipt when the outbox write fails', async () => {
  const command = await fixture(3);
  const constraint = `integration_${randomUUID().replaceAll('-', '')}`;
  await admin.query(
    `ALTER TABLE event_outbox ADD CONSTRAINT ${constraint} CHECK (tenant_id <> '${command.tenantId}'::uuid) NOT VALID`,
  );
  try {
    await expect(inventory.sell(command)).rejects.toHaveProperty(
      'code',
      '23514',
    );
    expect(await state(command.tenantId)).toEqual({
      quantity: 3,
      sales: 0,
      receipts: 0,
      events: 0,
    });
  } finally {
    await admin.query(`ALTER TABLE event_outbox DROP CONSTRAINT ${constraint}`);
  }
});

it('isolates tenant rows and denies the worker access to stock', async () => {
  const tenantA = await fixture(2);
  const tenantB = await fixture(4);
  await database.tenantTransaction(tenantA.tenantId, async (client) => {
    const result = await client.query('SELECT tenant_id FROM stocks');
    expect(result.rows).toEqual([{ tenant_id: tenantA.tenantId }]);
  });
  expect((await database.query('SELECT id FROM stocks')).rows).toEqual([]);
  await expect(
    inventory.sell({ ...tenantB, tenantId: tenantA.tenantId }),
  ).rejects.toHaveProperty('status', 409);
  await expect(worker.query('SELECT id FROM stocks')).rejects.toHaveProperty(
    'code',
    '42501',
  );
});

it('retries a durable event after publication fails and claims it only once', async () => {
  const command = await fixture(2);
  await inventory.sell(command);
  const unavailable = {
    publish: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
  };
  const firstWorker = new OutboxService(
    worker,
    unavailable as unknown as RedisService,
  );
  await expect(firstWorker.publishNext()).rejects.toThrow('Redis unavailable');
  expect(await state(command.tenantId)).toEqual({
    quantity: 1,
    sales: 1,
    receipts: 1,
    events: 1,
  });

  const publisher = createClient({ url: redisUrl, disableOfflineQueue: true });
  const subscriber = publisher.duplicate();
  publisher.on('error', () => {});
  subscriber.on('error', () => {});
  try {
    await Promise.all([publisher.connect(), subscriber.connect()]);
    const listener = vi.fn<(message: string) => void>();
    await subscriber.subscribe('reactivecore:invalidation', (message) => {
      if (JSON.parse(message).tenantId === command.tenantId) listener(message);
    });
    const publish = vi.fn((channel: string, message: string) =>
      publisher.publish(channel, message),
    );
    const restarted = new OutboxService(worker, {
      publish,
    } as unknown as RedisService);
    await setTimeout(1100);
    const results = await Promise.all([
      restarted.publishNext(),
      restarted.publishNext(),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(JSON.parse(listener.mock.calls[0][0])).toMatchObject({
      tenantId: command.tenantId,
      type: 'stock.updated',
    });
    const result = await admin.query(
      'SELECT attempts, published_at FROM event_outbox WHERE tenant_id = $1',
      [command.tenantId],
    );
    expect(result.rows[0]).toMatchObject({
      attempts: 2,
      published_at: expect.any(Date),
    });
  } finally {
    if (subscriber.isOpen) subscriber.destroy();
    if (publisher.isOpen) publisher.destroy();
  }
}, 10000);

it('reclaims an abandoned outbox lease after it expires', async () => {
  const command = await fixture(2);
  await inventory.sell(command);
  const abandonedToken = randomUUID();
  await admin.query(
    `UPDATE event_outbox
     SET lease_token = $2, available_at = now() + interval '30 seconds', attempts = 1
     WHERE tenant_id = $1`,
    [command.tenantId, abandonedToken],
  );

  const publish = vi.fn().mockResolvedValue(0);
  const replacement = new OutboxService(worker, {
    publish,
  } as unknown as RedisService);
  expect(await replacement.publishNext()).toBe(false);

  await admin.query(
    "UPDATE event_outbox SET available_at = now() - interval '1 second' WHERE tenant_id = $1",
    [command.tenantId],
  );
  expect(await replacement.publishNext()).toBe(true);
  expect(publish).toHaveBeenCalledTimes(1);
  const result = await admin.query(
    'SELECT attempts, published_at, lease_token FROM event_outbox WHERE tenant_id = $1',
    [command.tenantId],
  );
  expect(result.rows[0]).toMatchObject({
    attempts: 2,
    published_at: expect.any(Date),
    lease_token: null,
  });
});
