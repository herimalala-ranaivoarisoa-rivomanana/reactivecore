import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const project = 'reactivecore-module05';
const file = '.env.module05-lab';
const [action, flag] = process.argv.slice(2);
const actions = ['setup', 'reset-test', 'api', 'worker', 'test', 'load', 'status'];
if (!actions.includes(action) || (action === 'reset-test' ? flag !== '--yes' : flag !== undefined)) {
  throw new Error(`Usage: node scripts/module05-lab.mjs ${actions.join('|')} (reset-test requires --yes)`);
}

const secret = () => randomBytes(24).toString('hex');
if (action === 'setup' && !existsSync(file)) {
  const defaults = {
    POSTGRES_DB: 'reactivecore_lab',
    POSTGRES_USER: 'reactivecore',
    POSTGRES_PASSWORD: secret(),
    POSTGRES_PORT: '55432',
    REDIS_PORT: '56379',
    REDIS_PASSWORD: secret(),
    LAB_APP_PASSWORD: secret(),
    LAB_WORKER_PASSWORD: secret(),
    DEV_API_TOKEN: secret(),
    PORT: '4400',
  };
  writeFileSync(file, Object.entries(defaults).map(([key, value]) => `${key}=${value}\n`).join(''), {
    mode: 0o600, flag: 'wx',
  });
}

if (!existsSync(file)) throw new Error('Run setup first');
const config = parseEnv(readFileSync(file, 'utf8'));
if (config.POSTGRES_DB !== 'reactivecore_lab' || config.POSTGRES_USER !== 'reactivecore') {
  throw new Error('The lab requires the reactivecore_lab database and the reactivecore administrator');
}
for (const key of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'LAB_APP_PASSWORD', 'LAB_WORKER_PASSWORD', 'DEV_API_TOKEN']) {
  if (!/^[a-f0-9]{48}$/.test(config[key] ?? '')) throw new Error(`Invalid lab setting: ${key}`);
}
for (const key of ['POSTGRES_PORT', 'REDIS_PORT', 'PORT']) {
  if (!/^[0-9]{1,5}$/.test(config[key] ?? '') || +config[key] < 1 || +config[key] > 65535) {
    throw new Error(`Invalid lab port: ${key}`);
  }
}
const env = { ...process.env, ...config };

function run(command, args, { input, capture = false, extra = {} } = {}) {
  const result = spawnSync(command, args, {
    env: { ...env, ...extra }, input, encoding: 'utf8',
    stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout?.trim();
}

const composeArgs = ['compose', '-p', project, '--env-file', file, '-f', 'compose.yaml'];
const compose = (args, options) => run('docker', [...composeArgs, ...args], options);
const psql = (database, input, capture = false) => compose(
  ['exec', '-T', '-e', 'LAB_APP_PASSWORD', '-e', 'LAB_WORKER_PASSWORD', 'postgres',
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', config.POSTGRES_USER, '-d', database],
  { input, capture },
);

const migrations = [
  '001_initial.sql', '002_rls.sql', '003_roles.sql', '004_commit_log.sql', '005_mutation_engine.sql',
];

function migrate(database) {
  psql(database, 'CREATE TABLE IF NOT EXISTS public.lab_schema_migrations (name text PRIMARY KEY);');
  const applied = new Set(psql(database, 'SELECT name FROM public.lab_schema_migrations;', true).split('\n'));
  for (const migration of migrations) {
    if (applied.has(migration)) continue;
    const source = readFileSync(`db/migrations/${migration}`, 'utf8');
    if (!/COMMIT;\s*$/.test(source)) throw new Error(`Missing final COMMIT in ${migration}`);
    psql(database, source.replace(/COMMIT;\s*$/, `INSERT INTO public.lab_schema_migrations VALUES ('${migration}');\nCOMMIT;\n`));
    console.log(`${database}: ${migration}`);
  }
}

function testDatabaseExists() {
  return psql('postgres', "SELECT 1 FROM pg_database WHERE datname = 'reactivecore_test';", true) === '1';
}

function prepareTest() {
  if (!testDatabaseExists()) {
    psql('postgres', 'CREATE DATABASE reactivecore_test;');
  }
  migrate('reactivecore_test');
}

const pg = (user, password, database = config.POSTGRES_DB) =>
  `postgresql://${user}:${password}@127.0.0.1:${config.POSTGRES_PORT}/${database}`;
const app = (database) => pg('reactivecore_app', config.LAB_APP_PASSWORD, database);
const worker = (database) => pg('reactivecore_worker', config.LAB_WORKER_PASSWORD, database);
const redis = `redis://:${config.REDIS_PASSWORD}@127.0.0.1:${config.REDIS_PORT}`;

switch (action) {
  case 'setup':
    compose(['up', '-d', '--wait']);
    migrate(config.POSTGRES_DB);
    psql('postgres', `\\getenv app_password LAB_APP_PASSWORD
\\getenv worker_password LAB_WORKER_PASSWORD
ALTER ROLE reactivecore_app LOGIN PASSWORD :'app_password';
ALTER ROLE reactivecore_worker LOGIN PASSWORD :'worker_password';
`);
    prepareTest();
    for (const seed of ['001_demo.sql', '002_transfer_demo.sql']) {
      psql(config.POSTGRES_DB, readFileSync(`db/seeds/${seed}`, 'utf8'));
    }
    break;
  case 'reset-test': {
    const marker = "SELECT to_regclass('public.lab_schema_migrations') IS NOT NULL;";
    if (psql(config.POSTGRES_DB, marker, true) !== 't') throw new Error('Lab migration marker missing');
    if (testDatabaseExists()) {
      if (psql('reactivecore_test', marker, true) !== 't') throw new Error('Refusing to reset an unmarked test database');
      psql('postgres', 'DROP DATABASE reactivecore_test;');
    }
    prepareTest();
    break;
  }
  case 'api':
    run('node', ['apps/api/dist/main.js'], {
      extra: { NODE_ENV: 'development', DATABASE_URL: app(), REDIS_URL: redis },
    });
    break;
  case 'worker':
    run('node', ['apps/api/dist/outbox/outbox.worker.js'], {
      extra: { DATABASE_URL: worker(), REDIS_URL: redis },
    });
    break;
  case 'test':
    run('npm', ['run', 'test:integration', '-w', '@reactivecore/api'], {
      extra: {
        TEST_DATABASE_ADMIN_URL: pg(config.POSTGRES_USER, config.POSTGRES_PASSWORD, 'reactivecore_test'),
        TEST_DATABASE_APP_URL: app('reactivecore_test'),
        TEST_DATABASE_WORKER_URL: worker('reactivecore_test'),
        TEST_REDIS_URL: redis,
      },
    });
    break;
  case 'load':
    run('node', ['scripts/load-mutations.mjs', '20', '4']);
    break;
  case 'status':
    compose(['ps']);
    psql(config.POSTGRES_DB, 'SELECT * FROM public.reactive_commit_clock; SELECT name FROM public.lab_schema_migrations ORDER BY name;');
    break;
}
