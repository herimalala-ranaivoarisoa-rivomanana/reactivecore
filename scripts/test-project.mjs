import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SignJWT } from 'jose';
import pg from 'pg';
import { ReactiveCoreClient } from '@reactivecore/client';

const exec = promisify(execFile);
const name = `items-${randomUUID().slice(0, 8)}`;
const database = name.replaceAll('-', '_');
const appPassword = process.env.LAB_APP_PASSWORD;
const workerPassword = process.env.LAB_WORKER_PASSWORD;
const adminPassword = process.env.POSTGRES_PASSWORD;
const redisPassword = process.env.REDIS_PASSWORD;
const tokenKey = process.env.DEV_API_TOKEN;
if (
  !appPassword ||
  !workerPassword ||
  !adminPassword ||
  !redisPassword ||
  !tokenKey
) {
  throw new Error(
    'Start the isolated lab and pass --env-file=.env.module05-lab',
  );
}

const parent = await mkdtemp(join(process.cwd(), '.project-smoke-'));
const directory = join(parent, name);
const pgUrl = (user, password, target) =>
  `postgresql://${user}:${password}@127.0.0.1:${process.env.POSTGRES_PORT}/${target}`;
const databaseName = `reactivecore_${database}`;
const issuer = 'urn:reactivecore:cli-test';
const tenant = randomUUID();
const env = {
  ...process.env,
  RC_PROVISION_ADMIN_URL: pgUrl('reactivecore', adminPassword, 'postgres'),
  DATABASE_URL: pgUrl('reactivecore_app', appPassword, databaseName),
  REDIS_URL: `redis://:${redisPassword}@127.0.0.1:${process.env.REDIS_PORT}`,
  NODE_ENV: 'development',
  RC_HOST: '127.0.0.1',
  PORT: '4403',
  RC_JWKS_URL: '',
  RC_JWT_AUDIENCE: `reactivecore:${name}`,
  RC_JWT_ISSUER: issuer,
  RC_JWT_DEV_SECRET: tokenKey,
};
const cli = (...args) =>
  exec(process.execPath, ['scripts/reactivecore.mjs', ...args], { env });
const origin = 'http://127.0.0.1:4403';
let server;
let worker;
let ownsDatabase = false;
const signal = AbortSignal.timeout(20_000);
const logs = [];

try {
  await cli('init', directory);
  await assert.rejects(cli('init', directory));
  await cli('codegen', directory);
  const typed = join(directory, 'type-smoke.ts');
  await writeFile(
    typed,
    `import { createClient } from './client.js';
const client = createClient('http://localhost', () => 'token');
void client.query('items.list', {});
// @ts-expect-error Invalid generated argument type
void client.mutate('items.create', { title: 42 }, 'id');
`,
  );
  await exec(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '--ignoreConfig',
    '--noEmit',
    '--strict',
    '--module',
    'nodenext',
    '--target',
    'ES2023',
    '--types',
    'node',
    typed,
  ]);
  const created = await cli('provision', directory);
  ownsDatabase = true;
  assert.match(created.stdout, /Applied project\/001_items.sql/);
  assert.doesNotMatch((await cli('provision', directory)).stdout, /Applied /);
  const migration = join(directory, 'migrations/001_items.sql');
  const original = await readFile(migration, 'utf8');
  await appendFile(migration, '\n-- Changed after installation\n');
  await assert.rejects(
    cli('provision', directory),
    /Applied migrations were changed/,
  );
  await writeFile(migration, original);
  const failing = join(directory, 'migrations/002_probe.sql');
  await writeFile(
    failing,
    'CREATE TABLE public.migration_probe (id int); SELECT missing_column;',
  );
  await assert.rejects(
    cli('provision', directory),
    /Migration failed: project\/002_probe.sql/,
  );
  await writeFile(failing, 'CREATE TABLE public.migration_probe (id int);');
  assert.match(
    (await cli('provision', directory)).stdout,
    /Applied project\/002_probe.sql/,
  );
  await cli('tenant', directory, tenant);

  await appendFile(join(directory, 'application.mjs'), `
if (process.env.RC_PROVISION_ADMIN_URL) throw new Error('Provisioning credentials reached the API');
`);
  server = spawn(
    process.execPath,
    ['scripts/reactivecore.mjs', 'serve', directory],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (chunk) => logs.push(String(chunk)));
  server.stderr.on('data', (chunk) => logs.push(String(chunk)));
  for (;;) {
    if (server.exitCode !== null)
      throw new Error('Generated project failed to start');
    try {
      if ((await fetch(`${origin}/api/health/ready`, { signal })).ok) break;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
    }
    await setTimeout(100, undefined, { signal });
  }
  const token = await new SignJWT({
    tenant_id: tenant,
    scope: 'query mutation subscribe',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(randomUUID())
    .setIssuer(issuer)
    .setAudience(env.RC_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(tokenKey));
  const client = new ReactiveCoreClient(origin, () => token);
  const stream = client.subscribe('items.list', {}, signal);
  try {
    assert.deepEqual((await stream.next()).value.data, []);
    const mutation = await client.mutate(
      'items.create',
      { title: 'Standalone project' },
      randomUUID(),
      signal,
    );
    assert.deepEqual((await stream.next()).value.data, [mutation.data]);
    assert.deepEqual((await client.query('items.list', {}, signal)).data, [
      mutation.data,
    ]);
  } finally {
    await stream.return();
  }
  worker = spawn(
    process.execPath,
    ['scripts/reactivecore.mjs', 'worker', directory],
    {
      env: {
        ...env,
        DATABASE_URL: pgUrl(
          'reactivecore_worker',
          workerPassword,
          databaseName,
        ),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  worker.stdout.on('data', (chunk) => logs.push(String(chunk)));
  worker.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const admin = new pg.Client({
    connectionString: pgUrl('reactivecore', adminPassword, databaseName),
  });
  await admin.connect();
  try {
    for (;;) {
      if (worker.exitCode !== null)
        throw new Error('Project worker failed to start');
      const { rows } = await admin.query(
        'SELECT published_at FROM public.event_outbox',
      );
      assert.equal(rows.length, 1);
      if (rows[0].published_at) break;
      await setTimeout(100, undefined, { signal });
    }
  } finally {
    await admin.end();
  }
  console.log(
    'CLI verified: generated types, repeatable and atomic migrations, live SDK update and worker acknowledgment.',
  );
} catch (error) {
  if (logs.length) console.error(logs.join(''));
  throw error;
} finally {
  for (const child of [worker, server]) {
    if (!child || child.exitCode !== null || child.signalCode !== null)
      continue;
    const closed = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await closed;
  }
  try {
    if (ownsDatabase) {
      const admin = new pg.Client({
        connectionString: env.RC_PROVISION_ADMIN_URL,
      });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE "${databaseName}"`);
      } finally {
        await admin.end();
      }
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
