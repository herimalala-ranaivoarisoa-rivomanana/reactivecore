import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const file = '.env.reactivecore-test';
const secret = () => randomBytes(24).toString('hex');
if (!existsSync(file)) {
  const config = {
    POSTGRES_DB: 'postgres',
    POSTGRES_USER: 'reactivecore',
    POSTGRES_PASSWORD: secret(),
    POSTGRES_PORT: '55433',
    REDIS_PORT: '56380',
    REDIS_PASSWORD: secret(),
    LAB_APP_PASSWORD: secret(),
    LAB_WORKER_PASSWORD: secret(),
    DEV_API_TOKEN: secret(),
  };
  writeFileSync(
    file,
    Object.entries(config)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
    {
      mode: 0o600,
      flag: 'wx',
    },
  );
}

const result = spawnSync(
  'docker',
  [
    'compose',
    '-p',
    'reactivecore-test',
    '--env-file',
    file,
    'up',
    '-d',
    '--wait',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, ...parseEnv(readFileSync(file, 'utf8')) },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
