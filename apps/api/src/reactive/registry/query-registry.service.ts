import {
  Injectable,
  OnApplicationBootstrap,
  NotFoundException,
} from '@nestjs/common';

import { DiscoveryService } from '@nestjs/core';

import { REACTIVE_QUERY_METADATA } from '../decorators/reactive-query.decorator.js';

import type { QueryContext } from '../contracts/query-context.js';

export type QueryHandler = (
  ctx: QueryContext,
  args: unknown,
) => Promise<unknown>;

@Injectable()
export class QueryRegistryService implements OnApplicationBootstrap {
  private readonly handlers = new Map<string, QueryHandler>();

  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders()) {
      if (wrapper.isAlias) continue;
      const instance = wrapper.instance;

      if (!instance) continue;

      const prototype = Object.getPrototypeOf(instance);

      if (!prototype) continue;

      for (const methodName of Object.getOwnPropertyNames(prototype)) {
        if (methodName === 'constructor') continue;

        const method = Object.getOwnPropertyDescriptor(
          prototype,
          methodName,
        )?.value;

        if (typeof method !== 'function') continue;

        const queryName = Reflect.getMetadata(
          REACTIVE_QUERY_METADATA,
          method,
        ) as string | undefined;

        if (!queryName) continue;

        if (this.handlers.has(queryName)) {
          throw new Error(`Duplicate reactive query: ${queryName}`);
        }

        this.handlers.set(queryName, method.bind(instance));
      }
    }
  }

  get(name: string): QueryHandler {
    const handler = this.handlers.get(name);

    if (!handler) {
      throw new NotFoundException(`Unknown reactive query: ${name}`);
    }

    return handler;
  }

  list(): string[] {
    return [...this.handlers.keys()];
  }
}
