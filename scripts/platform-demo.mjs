import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { ReactiveCoreClient, ReactiveCoreError } from '@reactivecore/client';

const secret = process.env.DEV_API_TOKEN;
if (!secret) throw new Error('Load .env.module05-lab with node --env-file');
const key = new TextEncoder().encode(secret);
const tenant = '11111111-1111-4111-8111-111111111111';
const user = '55555555-5555-4555-8555-555555555555';
const pharmacy = '22222222-2222-4222-8222-222222222222';
const issuer = 'urn:reactivecore:lab';
const sign = (audience, scope = 'query mutation subscribe', tenantId = tenant) =>
  new SignJWT({ tenant_id: tenantId, pharmacy_ids: [pharmacy], scope })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('5m')
    .sign(key);

const tasks = new ReactiveCoreClient('http://127.0.0.1:4402', () => sign('tasks:lab'));
const inventory = new ReactiveCoreClient('http://127.0.0.1:4401', () => sign('inventory:lab'));
const wrong = new ReactiveCoreClient('http://127.0.0.1:4402', () => sign('inventory:lab'));
const readOnly = new ReactiveCoreClient('http://127.0.0.1:4402', () => sign('tasks:lab', 'query'));
const otherTenant = new ReactiveCoreClient('http://127.0.0.1:4402', () => sign('tasks:lab', 'query', randomUUID()));
const unauthorized = (status) => (error) => error instanceof ReactiveCoreError && error.status === status;

const timeout = AbortSignal.timeout(15_000);
assert.ok(Array.isArray((await inventory.query('stocks.list', { pharmacyId: pharmacy, availableOnly: false }, timeout)).data));
await assert.rejects(() => wrong.query('tasks.list', {}, timeout), unauthorized(401));
await assert.rejects(() => inventory.query('tasks.list', {}, timeout), unauthorized(404));
await assert.rejects(() => readOnly.mutate('tasks.create', { title: 'Forbidden' }, randomUUID(), timeout), unauthorized(403));

const controller = new AbortController();
const signal = AbortSignal.any([timeout, controller.signal]);
const stream = tasks.subscribe('tasks.list', {}, signal);
try {
  const initial = await stream.next();
  assert.equal(initial.done, false);
  const marker = process.env.RC_RESTART_MARKER;
  if (marker) {
    writeFileSync(marker, '');
    while (!existsSync(`${marker}.ready`)) await setTimeout(50, undefined, { signal });
  }
  const idempotencyKey = randomUUID();
  const args = { title: `Platform demo ${idempotencyKey}` };
  const created = await tasks.mutate('tasks.create', args, idempotencyKey, signal);
  const replay = await tasks.mutate('tasks.create', args, idempotencyKey, signal);
  assert.equal(created.replayed, false);
  assert.deepEqual(replay, { ...created, replayed: true });
  const next = await stream.next();
  assert.equal(next.done, false);
  assert.ok(BigInt(next.value.seq) > BigInt(initial.value.seq));
  assert.ok(next.value.data.some((task) => task.id === created.data.id));
  assert.deepEqual((await otherTenant.query('tasks.list', {}, signal)).data, []);
  console.log('Two projects: SDK queries, mutation replay, SSE, audience/scope rejection and tenant RLS verified.');
} finally {
  controller.abort();
  await stream.return();
}
