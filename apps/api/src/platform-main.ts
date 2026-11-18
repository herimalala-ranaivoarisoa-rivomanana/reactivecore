import { ForbiddenException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { InventoryModule } from './inventory/inventory.module.js';
import type { MutationPrincipal } from './mutation/mutation.types.js';
import {
  loadApplication,
  type Application,
} from './platform/load-application.js';
import { PlatformModule } from './platform/platform.module.js';
import type { Project } from './platform/project.js';
import { TasksModule, validateList } from './projects/tasks/tasks.module.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function authorizeStock(principal: MutationPrincipal, args: unknown): void {
  if (
    !args ||
    typeof args !== 'object' ||
    !('pharmacyId' in args) ||
    typeof args.pharmacyId !== 'string' ||
    !principal.allowedPharmacyIds.includes(args.pharmacyId.toLowerCase())
  ) {
    throw new ForbiddenException('Pharmacy not authorized');
  }
}

async function run() {
  const application = process.env.RC_APPLICATION;
  const project: Application | undefined = process.env.RC_APPLICATION_FILE
    ? await loadApplication(process.env.RC_APPLICATION_FILE)
    : application === 'inventory'
      ? {
          application: InventoryModule,
          functions: {
            queries: { 'stocks.list': authorizeStock },
            mutations: ['inventory.transfer'],
          },
        }
      : application === 'tasks'
        ? {
            application: TasksModule,
            functions: {
              queries: { 'tasks.list': validateList },
              mutations: ['tasks.create'],
            },
          }
        : undefined;
  if (!project) throw new Error('Unknown RC_APPLICATION');

  const auth: Project['auth'] = process.env.RC_JWKS_URL
    ? { jwks: new URL(process.env.RC_JWKS_URL) }
    : {
        developmentKey: new TextEncoder().encode(required('RC_JWT_DEV_SECRET')),
      };
  const app = await NestFactory.create(
    PlatformModule.forProject({
      ...project,
      issuer: required('RC_JWT_ISSUER'),
      audience: required('RC_JWT_AUDIENCE'),
      auth,
    }),
    { forceCloseConnections: true },
  );
  const origins = process.env.RC_CORS_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins?.length) app.enableCors({ origin: origins });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.listen(
    Number(process.env.PORT ?? 4000),
    process.env.RC_HOST ?? '127.0.0.1',
  );
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
