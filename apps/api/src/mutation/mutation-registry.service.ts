import {
  Injectable,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { MutationContext } from './mutation.types.js';
import {
  MUTATION_METADATA,
  type MutationDefinition,
} from './reactive-mutation.decorator.js';

interface Handler extends MutationDefinition<unknown> {
  execute(context: MutationContext, args: unknown): Promise<unknown>;
}

@Injectable()
export class MutationRegistryService implements OnApplicationBootstrap {
  private readonly handlers = new Map<string, Handler>();

  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders()) {
      if (wrapper.isAlias || !wrapper.instance) continue;
      const prototype = Object.getPrototypeOf(wrapper.instance);
      if (!prototype) continue;

      for (const property of Object.getOwnPropertyNames(prototype)) {
        const method = Object.getOwnPropertyDescriptor(
          prototype,
          property,
        )?.value;
        if (typeof method !== 'function') continue;
        const definition = Reflect.getOwnMetadata(MUTATION_METADATA, method) as
          MutationDefinition<unknown> | undefined;
        if (!definition) continue;
        if (this.handlers.has(definition.name))
          throw new Error(`Duplicate mutation: ${definition.name}`);
        this.handlers.set(definition.name, {
          ...definition,
          execute: method.bind(wrapper.instance),
        });
      }
    }
  }

  get(name: string): Handler {
    const handler = this.handlers.get(name);
    if (!handler) throw new NotFoundException('Unknown reactive mutation');
    return handler;
  }
}
