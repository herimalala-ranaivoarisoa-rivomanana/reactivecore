import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { setTimeout } from 'node:timers/promises';
import { DatabaseService } from '../database/database.service.js';
import { OutboxModule } from './outbox.module.js';
import { OutboxService } from './outbox.service.js';

async function run() {
  const logger = new Logger('OutboxWorker');
  const app = await NestFactory.createApplicationContext(OutboxModule);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const database = app.get(DatabaseService);
    const { rows } = await database.query<{ safe: boolean }>(
      `SELECT current_user = 'reactivecore_worker'
              AND NOT rolsuper AND NOT rolbypassrls AS safe
       FROM pg_roles WHERE rolname = current_user`,
    );
    if (!rows[0]?.safe)
      throw new Error(
        'Outbox requires the restricted reactivecore_worker role',
      );

    const outbox = app.get(OutboxService);
    while (!stopping) {
      try {
        if (await outbox.publishNext()) continue;
      } catch (error) {
        logger.warn(error);
      }
      if (!stopping) await setTimeout(1000);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await app.close();
  }
}

run().catch((error: unknown) => {
  console.error('Outbox startup failed:', error);
  process.exitCode = 1;
});
