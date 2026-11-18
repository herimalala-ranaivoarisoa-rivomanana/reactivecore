import { BadRequestException, ConflictException, Injectable, Module } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { MutationContext } from '../../mutation/mutation.types.js';
import { ReactiveMutation } from '../../mutation/reactive-mutation.decorator.js';
import type { QueryContext } from '../../reactive/contracts/query-context.js';
import { ReactiveQuery } from '../../reactive/decorators/reactive-query.decorator.js';

export function validateList(_principal: unknown, args: unknown): void {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).length !== 0
  ) {
    throw new BadRequestException('tasks.list expects an empty object');
  }
}

interface CreateTask { title: string; id?: string }

function createArgs(raw: unknown): CreateTask {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => key !== "title" && key !== "id") ||
    !('title' in raw) ||
    typeof raw.title !== 'string' ||
    !raw.title.trim() ||
    Array.from(raw.title.trim()).length > 120 ||
    raw.title.includes('\u0000')
  ) {
    throw new BadRequestException('Expected a title of 1 to 120 characters');
  }
  if ('id' in raw) {
    if (typeof raw.id !== 'string' || !isUUID(raw.id, '4')) throw new BadRequestException('Expected a task UUID v4');
    return { title: raw.title.trim(), id: raw.id.toLowerCase() };
  }
  return { title: raw.title.trim() };
}

@Injectable()
class TasksFunctions {
  @ReactiveQuery('tasks.list')
  async list(ctx: QueryContext, args: unknown) {
    validateList(ctx.principal, args);
    ctx.dependencies.add({
      kind: 'table',
      tenantId: ctx.principal.tenantId,
      table: 'tasks',
    });
    const result = await ctx.client.query(
      'SELECT id, title FROM public.tasks WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT 100',
      [ctx.principal.tenantId],
    );
    return result.rows;
  }

  @ReactiveMutation({
    name: 'tasks.create',
    validate: createArgs,
    authorize: () => {},
  })
  async create(ctx: MutationContext, { title, id = randomUUID() }: CreateTask) {
    const result = await ctx.client.query(
      'INSERT INTO public.tasks (id, tenant_id, title) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [id, ctx.principal.tenantId, title],
    );
    if (result.rowCount !== 1) throw new ConflictException('Task ID already in use');
    ctx.recordChange({
      table: 'tasks',
      documentId: id,
      operation: 'insert',
      before: null,
      after: { title },
    });
    return { id, title };
  }
}

@Module({ providers: [TasksFunctions] })
export class TasksModule {}
