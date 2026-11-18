import 'reflect-metadata';

export const REACTIVE_QUERY_METADATA = Symbol('reactivecore:query');

/** Registers a query handler under the given public function name. */
export function ReactiveQuery(name: string): MethodDecorator {
  if (!/^[a-z][a-z0-9_.-]{1,127}$/.test(name)) {
    throw new Error(`Invalid reactive query name: ${name}`);
  }

  return (_target, _propertyKey, descriptor) => {
    if (!descriptor?.value) {
      throw new Error('ReactiveQuery requires a method');
    }

    Reflect.defineMetadata(REACTIVE_QUERY_METADATA, name, descriptor.value);

    return descriptor;
  };
}
