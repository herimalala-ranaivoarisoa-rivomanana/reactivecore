import 'reflect-metadata';
import type { MutationPrincipal } from './mutation.types.js';

export const MUTATION_METADATA = Symbol('reactivecore:mutation');

export interface MutationDefinition<Args = never> {
  name: string;
  validate(raw: unknown): Args;
  authorize(principal: MutationPrincipal, args: Args): void;
}

/** Registers a mutation handler with argument validation and authorization policies. */
export function ReactiveMutation<Args>(
  definition: MutationDefinition<Args>,
): MethodDecorator {
  if (!/^[a-z][a-z0-9_.-]{1,127}$/.test(definition.name)) {
    throw new Error('Invalid reactive mutation name');
  }
  return (_target, _name, descriptor) => {
    if (typeof descriptor.value !== 'function')
      throw new Error('Expected a mutation method');
    Reflect.defineMetadata(MUTATION_METADATA, definition, descriptor.value);
  };
}
