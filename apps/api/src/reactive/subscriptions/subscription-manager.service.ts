import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  ChangeDescriptor,
  Dependency,
} from '../contracts/dependency.types.js';
import type { QueryPrincipal } from '../contracts/query-context.js';
import { QueryExecutorService } from '../engine/query-executor.service.js';
import { InvalidationService } from '../invalidation/invalidation.service.js';

export interface SubscriptionResult {
  subscriptionId: string;
  data: unknown;
  revision: number;
}

interface Subscription {
  principal: QueryPrincipal;
  name: string;
  args: unknown;
  listener: (result: SubscriptionResult) => void;
  dependencies: Dependency[];
  data: unknown;
  revision: number;
  generation: number;
  running: boolean;
  dirty: boolean;
  retry?: ReturnType<typeof setTimeout>;
}

@Injectable()
export class SubscriptionManagerService implements OnModuleDestroy {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly logger = new Logger(SubscriptionManagerService.name);
  private closed = false;

  constructor(
    private readonly executor: QueryExecutorService,
    private readonly invalidation: InvalidationService,
  ) {}

  async subscribe(
    principal: QueryPrincipal,
    name: string,
    args: unknown,
    listener: (result: SubscriptionResult) => void,
  ): Promise<string> {
    if (this.closed) throw new Error('Subscription manager is closed');
    const id = randomUUID();
    const subscription: Subscription = {
      principal: structuredClone(principal),
      name,
      args: structuredClone(args),
      listener,
      dependencies: [],
      data: undefined,
      revision: 0,
      generation: 0,
      running: false,
      dirty: true,
    };
    this.subscriptions.set(id, subscription);
    try {
      await this.refresh(id, subscription);
      if (!this.subscriptions.has(id))
        throw new Error('Subscription closed during initialization');
      return id;
    } catch (error) {
      this.unsubscribe(id);
      throw error;
    }
  }

  invalidate(change: ChangeDescriptor): void {
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.principal.tenantId !== change.tenantId) continue;
      // In-flight reads may discover dependencies absent from the previous snapshot.
      if (
        subscription.running ||
        subscription.dependencies.some((dependency) =>
          this.invalidation.affects(dependency, change),
        )
      ) {
        this.markDirty(id, subscription);
      }
    }
  }

  reconcileAll(): void {
    for (const [id, subscription] of this.subscriptions) {
      this.markDirty(id, subscription);
    }
  }

  private markDirty(id: string, subscription: Subscription): void {
    subscription.generation++;
    subscription.dirty = true;
    this.refreshInBackground(id, subscription);
  }

  private refreshInBackground(id: string, subscription: Subscription): void {
    if (subscription.running || subscription.retry) return;
    void this.refresh(id, subscription).catch((error: unknown) => {
      if (!this.subscriptions.has(id)) return;
      this.logger.warn(error);
      subscription.dirty = true;
      subscription.retry = setTimeout(() => {
        subscription.retry = undefined;
        this.refreshInBackground(id, subscription);
      }, 1000);
      subscription.retry.unref();
    });
  }

  private async refresh(id: string, subscription: Subscription): Promise<void> {
    subscription.running = true;
    try {
      while (subscription.dirty && this.subscriptions.has(id)) {
        subscription.dirty = false;
        const generation = subscription.generation;
        const result = await this.executor.execute(
          subscription.principal,
          subscription.name,
          subscription.args,
        );
        if (!this.subscriptions.has(id)) return;
        if (generation !== subscription.generation) continue;

        subscription.dependencies = result.dependencies;
        if (
          subscription.revision === 0 ||
          !isDeepStrictEqual(subscription.data, result.data)
        ) {
          subscription.data = result.data;
          subscription.revision++;
          try {
            subscription.listener({
              subscriptionId: id,
              data: structuredClone(result.data),
              revision: subscription.revision,
            });
          } catch (error) {
            this.logger.warn(error);
          }
        }
      }
    } finally {
      subscription.running = false;
    }
  }

  unsubscribe(id: string): void {
    clearTimeout(this.subscriptions.get(id)?.retry);
    this.subscriptions.delete(id);
  }

  onModuleDestroy(): void {
    this.closed = true;
    for (const id of this.subscriptions.keys()) this.unsubscribe(id);
  }
}
