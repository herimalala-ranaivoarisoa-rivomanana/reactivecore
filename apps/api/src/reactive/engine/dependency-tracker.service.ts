import { Injectable } from '@nestjs/common';
import type { Dependency } from '../contracts/dependency.types.js';
import type { DependencyCollector } from '../contracts/query-context.js';

export class QueryDependencyCollector implements DependencyCollector {
  private readonly dependencies = new Map<string, Dependency>();

  add(dependency: Dependency): void {
    const key =
      dependency.kind === 'predicate'
        ? JSON.stringify([
            dependency.kind,
            dependency.tenantId,
            dependency.table,
            dependency.index,
            Object.entries(dependency.equals).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ])
        : JSON.stringify([
            dependency.kind,
            dependency.tenantId,
            dependency.table,
            dependency.kind === 'document' ? dependency.documentId : null,
          ]);
    this.dependencies.set(key, structuredClone(dependency));
  }

  snapshot(): Dependency[] {
    return structuredClone([...this.dependencies.values()]);
  }
}

@Injectable()
export class DependencyTrackerService {
  createCollector(): DependencyCollector {
    return new QueryDependencyCollector();
  }
}
