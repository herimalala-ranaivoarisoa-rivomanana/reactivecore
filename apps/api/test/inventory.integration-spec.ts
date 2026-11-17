import {
  ChangeLogService,
  type JournalChange,
} from '../src/reactive/changelog/change-log.service.js';
import { RedisInvalidationService } from '../src/reactive/invalidation/redis-invalidation.service.js';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { setTimeout } from 'node:timers/promises';
import { DatabaseService } from '../src/database/database.service.js';
import { InventoryRepository } from '../src/inventory/inventory.repository.js';
import { InventoryModule } from '../src/inventory/inventory.module.js';
import { ReactiveModule } from '../src/reactive/reactive.module.js';
import { QueryExecutorService } from '../src/reactive/engine/query-executor.service.js';
import { SubscriptionManagerService } from '../src/reactive/subscriptions/subscription-manager.service.js';
import { INVALIDATION_CHANNEL } from '../src/outbox/invalidation-channel.js';
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
const journal = new ChangeLogService(database);
const inventory = new InventoryService(
  database,
  new InventoryRepository(),
  journal,
);

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
      stockId,
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
      'reactive_change_log',
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
    receipts: 2,
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

it('replays an insufficient-stock decision even after restocking', async () => {
  const command = await fixture(0);
  await expect(inventory.sell(command)).rejects.toHaveProperty('status', 409);
  await admin.query('UPDATE stocks SET quantity = 3 WHERE tenant_id = $1', [
    command.tenantId,
  ]);
  await expect(inventory.sell(command)).rejects.toHaveProperty('status', 409);
  expect(await state(command.tenantId)).toEqual({
    quantity: 3,
    sales: 0,
    receipts: 1,
    events: 0,
  });
});

it('reads a stable tenant snapshot and blocks writes in a query transaction', async () => {
  const command = await fixture(3);
  await fixture(7);
  await database.readOnlyTenantTransaction(command.tenantId, async (client) => {
    const first = await client.query('SELECT quantity FROM stocks');
    expect(first.rows).toEqual([{ quantity: 3 }]);
    await admin.query('UPDATE stocks SET quantity = 2 WHERE tenant_id = $1', [
      command.tenantId,
    ]);
    expect((await client.query('SELECT quantity FROM stocks')).rows).toEqual(
      first.rows,
    );
  });
  await expect(
    database.readOnlyTenantTransaction(command.tenantId, (client) =>
      client.query('UPDATE stocks SET quantity = 4'),
    ),
  ).rejects.toHaveProperty('code', '25006');
  expect((await database.query('SELECT id FROM stocks')).rows).toEqual([]);
});

it('refreshes a registered stock query from the worker through Redis', async () => {
  const command = await fixture(1);
  const other = await fixture(3);
  const publisher = createClient({ url: redisUrl, disableOfflineQueue: true });
  publisher.on('error', () => {});
  vi.stubEnv('REDIS_URL', redisUrl);
  const module = await Test.createTestingModule({
    imports: [InventoryModule, ReactiveModule],
  })
    .overrideProvider(DatabaseService)
    .useValue(new DatabaseService(appUrl))
    .compile();
  try {
    await publisher.connect();
    const count = async () =>
      Number(
        (await publisher.pubSubNumSub(INVALIDATION_CHANNEL))[
          INVALIDATION_CHANNEL
        ] ?? 0,
      );
    const original = await count();
    await module.init();
    await vi.waitFor(async () =>
      expect(await count()).toBeGreaterThan(original),
    );

    const executor = module.get(QueryExecutorService);
    const subscriptions = module.get(SubscriptionManagerService);
    const principal = {
      tenantId: command.tenantId,
      userId: randomUUID(),
      roles: [],
    };
    const args = { pharmacyId: command.pharmacyId, availableOnly: true };
    await expect(
      executor.execute(principal, 'unknown.query', args),
    ).rejects.toHaveProperty('status', 404);
    await expect(
      executor.execute(principal, 'stocks.list', {
        ...args,
        availableOnly: 'true',
      }),
    ).rejects.toHaveProperty('status', 400);
    const initial = await executor.execute(principal, 'stocks.list', args);
    expect(initial.dependencies).toMatchObject([
      { kind: 'predicate', equals: { pharmacy_id: command.pharmacyId } },
    ]);
    expect(initial.data).toMatchObject([{ quantity: 1 }]);

    const listener = vi.fn();
    const otherListener = vi.fn();
    const id = await subscriptions.subscribe(
      principal,
      'stocks.list',
      args,
      listener,
    );
    await subscriptions.subscribe(
      { ...principal, tenantId: other.tenantId },
      'stocks.list',
      { ...args, pharmacyId: other.pharmacyId },
      otherListener,
    );
    await inventory.sell(command);
    const outbox = new OutboxService(worker, {
      publish: publisher.publish.bind(publisher),
    } as unknown as RedisService);
    expect(await outbox.publishNext()).toBe(true);
    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith({
        subscriptionId: id,
        revision: 2,
        snapshotSeq: expect.any(String),
        data: [],
      }),
    );
    expect(listener).toHaveBeenCalledTimes(2);
    expect(otherListener).toHaveBeenCalledTimes(1);
  } finally {
    await module.close();
    if (publisher.isOpen) publisher.destroy();
    vi.unstubAllEnvs();
  }
}, 10000);

function journalEvent(stockId: string): JournalChange {
  return {
    eventId: randomUUID(),
    documentId: stockId,
    table: 'stocks',
    operation: 'update',
  };
}

it('serializes commit boundaries, groups ordinals and isolates the journal by tenant', async () => {
  const first = await fixture(1);
  const second = await fixture(1);
  const before = await journal.currentSeq();
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  let acquired = false;
  const a = database.tenantTransaction(first.tenantId, async (client) => {
    const seq = await journal.append(client, [
      journalEvent(first.stockId),
      journalEvent(first.stockId),
    ]);
    acquired = true;
    await gate;
    return seq;
  });
  let b: Promise<string> | undefined;
  try {
    await vi.waitFor(() => expect(acquired).toBe(true));
    let started = false;
    let assigned = false;
    b = database.tenantTransaction(second.tenantId, async (client) => {
      started = true;
      const seq = await journal.append(client, [journalEvent(second.stockId)]);
      assigned = true;
      return seq;
    });
    await vi.waitFor(() => expect(started).toBe(true));
    expect(await journal.currentSeq()).toBe(before);
    expect(assigned).toBe(false);
  } finally {
    unlock();
    await Promise.allSettled(b ? [a, b] : [a]);
  }
  const [firstSeq, secondSeq] = await Promise.all([a, b!]);
  expect(BigInt(secondSeq)).toBe(BigInt(firstSeq) + 1n);
  const rows = await journal.readAfter(first.tenantId, before, secondSeq);
  expect(rows.map(({ seq, ordinal }) => [seq, ordinal])).toEqual([
    [firstSeq, 0],
    [firstSeq, 1],
  ]);
  expect(
    (await database.query('SELECT * FROM reactive_change_log')).rows,
  ).toEqual([]);
  await expect(
    database.query('UPDATE reactive_commit_clock SET last_seq = 0'),
  ).rejects.toHaveProperty('code', '42501');
  await expect(
    worker.query('SELECT * FROM reactive_change_log'),
  ).rejects.toHaveProperty('code', '42501');
});

it('rolls back a journal write with its clock and keeps snapshot data aligned', async () => {
  const command = await fixture(2);
  const before = await journal.currentSeq();
  await expect(
    database.tenantTransaction(command.tenantId, async (client) => {
      await journal.append(client, [journalEvent(command.stockId)]);
      throw new Error('rollback journal');
    }),
  ).rejects.toThrow('rollback journal');
  expect(await journal.currentSeq()).toBe(before);
  expect(await journal.readAfter(command.tenantId, '0', before)).toEqual([]);

  await database.snapshotTenantTransaction(
    command.tenantId,
    async (client, seq) => {
      expect(seq).toBe(before);
      await inventory.sell(command);
      expect((await client.query('SELECT quantity FROM stocks')).rows).toEqual([
        { quantity: 2 },
      ]);
      expect(await database.currentCommitSeq(client)).toBe(seq);
    },
  );
  const after = await journal.currentSeq();
  const [row] = await journal.readAfter(command.tenantId, before, after);
  const outbox = await admin.query(
    'SELECT event_id FROM event_outbox WHERE tenant_id = $1',
    [command.tenantId],
  );
  expect(row).toMatchObject({
    eventId: outbox.rows[0].event_id,
    before: { quantity: 2 },
    after: { quantity: 1 },
  });
});

it('recovers journal changes on two instances with Redis delivery disabled and resnapshots after restart', async () => {
  const command = await fixture(2);
  const principal = {
    tenantId: command.tenantId,
    userId: randomUUID(),
    roles: [],
  };
  const args = { pharmacyId: command.pharmacyId, availableOnly: false };
  const open = async () => {
    const instance = await Test.createTestingModule({
      imports: [InventoryModule, ReactiveModule],
    })
      .overrideProvider(DatabaseService)
      .useValue(new DatabaseService(appUrl))
      .overrideProvider(RedisInvalidationService)
      .useValue({})
      .compile();
    await instance.init();
    return instance;
  };
  const instances = [await open()];
  try {
    instances.push(await open());
    const listeners = await Promise.all(
      instances.map(async (instance) => {
        const listener = vi.fn();
        await instance
          .get(SubscriptionManagerService)
          .subscribe(principal, 'stocks.list', args, listener);
        return listener;
      }),
    );
    await inventory.sell(command);
    const seq = await journal.currentSeq();
    await vi.waitFor(
      () => {
        for (const listener of listeners) {
          expect(listener).toHaveBeenLastCalledWith(
            expect.objectContaining({
              revision: 2,
              snapshotSeq: seq,
              data: [expect.objectContaining({ quantity: 1 })],
            }),
          );
        }
      },
      { timeout: 3000 },
    );

    await instances.pop()!.close();
    const restarted = await open();
    instances.push(restarted);
    const fresh = vi.fn();
    await restarted
      .get(SubscriptionManagerService)
      .subscribe(principal, 'stocks.list', args, fresh);
    expect(fresh).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        revision: 1,
        snapshotSeq: seq,
        data: [expect.objectContaining({ quantity: 1 })],
      }),
    );
  } finally {
    await Promise.all(instances.map((instance) => instance.close()));
  }
}, 10000);

it('rolls back the entire sale if the durable journal rejects the event', async () => {
  const command = await fixture(2);
  const before = await journal.currentSeq();
  const constraint = `integration_${randomUUID().replaceAll('-', '')}`;
  await admin.query(
    `ALTER TABLE reactive_change_log ADD CONSTRAINT ${constraint} CHECK (tenant_id <> '${command.tenantId}'::uuid) NOT VALID`,
  );
  try {
    await expect(inventory.sell(command)).rejects.toHaveProperty(
      'code',
      '23514',
    );
    expect(await state(command.tenantId)).toEqual({
      quantity: 2,
      sales: 0,
      receipts: 0,
      events: 0,
    });
    expect(await journal.currentSeq()).toBe(before);
  } finally {
    await admin.query(
      `ALTER TABLE reactive_change_log DROP CONSTRAINT ${constraint}`,
    );
  }
});
