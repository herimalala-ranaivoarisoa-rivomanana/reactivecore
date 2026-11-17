import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { defineConfig } from 'vitest/config';

if (existsSync('.env.integration')) {
  loadEnvFile('.env.integration');
}

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    include: ['test/*.integration-spec.ts'],
  },
});
