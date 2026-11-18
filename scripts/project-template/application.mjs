import { randomUUID } from 'node:crypto';

export default function createApplication({
  Module,
  ReactiveQuery,
  ReactiveMutation,
  BadRequestException,
}) {
  function validateList(_principal, args) {
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Object.keys(args).length
    ) {
      throw new BadRequestException('items.list expects an empty object');
    }
  }

  function validateCreate(args) {
    if (
      !args ||
      typeof args !== 'object' ||
      Object.keys(args).length !== 1 ||
      typeof args.title !== 'string' ||
      !args.title.trim() ||
      Array.from(args.title.trim()).length > 120 ||
      args.title.includes('\u0000')
    ) {
      throw new BadRequestException('Expected a title of 1 to 120 characters');
    }
    return { title: args.title.trim() };
  }

  class ItemFunctions {
    async list(ctx) {
      ctx.dependencies.add({
        kind: 'table',
        tenantId: ctx.principal.tenantId,
        table: 'items',
      });
      const { rows } = await ctx.client.query(
        'SELECT id, title FROM public.items WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT 100',
        [ctx.principal.tenantId],
      );
      return rows;
    }

    async create(ctx, { title }) {
      const id = randomUUID();
      await ctx.client.query(
        'INSERT INTO public.items (id, tenant_id, title) VALUES ($1, $2, $3)',
        [id, ctx.principal.tenantId, title],
      );
      ctx.recordChange({
        table: 'items',
        documentId: id,
        operation: 'insert',
        before: null,
        after: { title },
      });
      return { id, title };
    }
  }

  const methods = ItemFunctions.prototype;
  ReactiveQuery('items.list')(
    methods,
    'list',
    Object.getOwnPropertyDescriptor(methods, 'list'),
  );
  ReactiveMutation({
    name: 'items.create',
    validate: validateCreate,
    authorize: () => {},
  })(methods, 'create', Object.getOwnPropertyDescriptor(methods, 'create'));
  class Application {}
  Module({ providers: [ItemFunctions] })(Application);
  return {
    application: Application,
    functions: {
      queries: { 'items.list': validateList },
      mutations: ['items.create'],
    },
  };
}
