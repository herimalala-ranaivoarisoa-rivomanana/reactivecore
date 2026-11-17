import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../database/database.service.js';

import { QueryRegistryService } from '../registry/query-registry.service.js';
import { DependencyTrackerService } from './dependency-tracker.service.js';

import type { QueryPrincipal } from '../contracts/query-context.js';

import type { Dependency } from '../contracts/dependency.types.js';

export interface ExecutedQuery {
  data: unknown;
  dependencies: Dependency[];
}

@Injectable()
export class QueryExecutorService {
  constructor(
    private readonly database: DatabaseService,
    private readonly registry: QueryRegistryService,
    private readonly tracker: DependencyTrackerService,
  ) {}

  async execute(
    principal: QueryPrincipal,
    name: string,
    args: unknown,
  ): Promise<ExecutedQuery> {
    const handler = this.registry.get(name);

    const collector = this.tracker.createCollector();

    const data = await this.database.readOnlyTenantTransaction(
      principal.tenantId,
      async (client) => {
        return handler(
          {
            principal,
            client,
            dependencies: collector,
          },
          args,
        );
      },
    );

    return {
      data,
      dependencies: collector.snapshot(),
    };
  }
}
