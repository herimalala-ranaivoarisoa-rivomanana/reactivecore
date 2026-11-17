import type {
  ChangeDescriptor,
  Dependency,
} from '../contracts/dependency.types.js';
import { InvalidationService } from '../invalidation/invalidation.service.js';

const bucketKey = (tenant: string, table: string) =>
  JSON.stringify([tenant, table]);

export class DependencyIndex {
  private readonly buckets = new Map<string, Map<string, Dependency[]>>();
  private readonly keysBySubscription = new Map<string, Set<string>>();

  constructor(private readonly matcher: InvalidationService) {}

  replace(id: string, dependencies: readonly Dependency[]): void {
    this.remove(id);
    const keys = new Set<string>();
    for (const dependency of dependencies) {
      const key = bucketKey(dependency.tenantId, dependency.table);
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = new Map();
        this.buckets.set(key, bucket);
      }
      const predicates = bucket.get(id) ?? [];
      predicates.push(dependency);
      bucket.set(id, predicates);
      keys.add(key);
    }
    this.keysBySubscription.set(id, keys);
  }

  remove(id: string): void {
    for (const key of this.keysBySubscription.get(id) ?? []) {
      const bucket = this.buckets.get(key);
      bucket?.delete(id);
      if (bucket?.size === 0) this.buckets.delete(key);
    }
    this.keysBySubscription.delete(id);
  }

  candidates(change: ChangeDescriptor): Set<string> {
    const ids = new Set<string>();
    for (const [id, dependencies] of this.buckets.get(
      bucketKey(change.tenantId, change.table),
    ) ?? []) {
      if (
        dependencies.some((dependency) =>
          this.matcher.affects(dependency, change),
        )
      )
        ids.add(id);
    }
    return ids;
  }
}
