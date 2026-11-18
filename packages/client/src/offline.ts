export type OfflineState = 'pending' | 'sending' | 'retry' | 'confirmed' | 'cancelled' | 'conflict' | 'rejected';

export interface OfflineOperation<Args> {
  key: string;
  scope: string;
  args: Args;
  createdAt: number;
  state: OfflineState;
  attempts: number;
  resumeAt: number;
  message?: string;
}

export interface OfflineStore<Args> {
  add(record: OfflineOperation<Args>): Promise<void>;
  list(scope: string): Promise<OfflineOperation<Args>[]>;
  // Implementations must run read, transition and write in one transaction.
  update(key: string, transition: (record: OfflineOperation<Args>) => OfflineOperation<Args> | undefined):
    Promise<OfflineOperation<Args> | undefined>;
}

export type OfflineResult =
  | { state: 'confirmed' }
  | { state: 'conflict' | 'rejected' | 'retry'; message?: string };

export function isOutstanding(state: OfflineState): boolean {
  return state === 'pending' || state === 'sending' || state === 'retry';
}

export class OfflineQueue<Args> {
  constructor(private readonly store: OfflineStore<Args>, private readonly scope: string) {}

  async enqueue(args: Args) {
    const entry: OfflineOperation<Args> = {
      key: crypto.randomUUID(), scope: this.scope, args,
      createdAt: Date.now(), state: 'pending', attempts: 0, resumeAt: 0,
    };
    await this.store.add(entry);
    return entry;
  }

  async list() {
    return (await this.store.list(this.scope)).sort(
      (left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key),
    );
  }

  async cancel(key: string): Promise<boolean> {
    const changed = await this.store.update(key, (entry) =>
      entry.scope === this.scope && entry.state === 'pending' && entry.attempts === 0
        ? { ...entry, state: 'cancelled' } : undefined,
    );
    return Boolean(changed);
  }

  async sync(send: (record: OfflineOperation<Args>) => Promise<OfflineResult>, canSend: () => boolean, notify: () => void) {
    for (const entry of await this.list()) {
      if (!canSend()) return;
      if (!isOutstanding(entry.state)) continue;
      const now = Date.now();
      const claimed = await this.store.update(entry.key, (current) =>
        current.scope === this.scope && isOutstanding(current.state) && current.resumeAt <= now
          ? { ...current, state: 'sending', attempts: current.attempts + 1, resumeAt: now + 30000 }
          : undefined,
      );
      if (!claimed) {
        // A concurrent tab might have cancelled this entry or acquired its lease.
        // Wait for the next cycle rather than skipping a potentially active command.
        return;
      }
      notify();

      let result: OfflineResult;
      try {
        result = await send(claimed);
      } catch {
        result = { state: 'retry', message: 'Envoi non confirmé. La même commande sera rejouée.' };
      }

      await this.store.update(entry.key, (current) => {
        if (current.state !== 'sending' || current.attempts !== claimed.attempts) return;
        const resumeAt = result.state === 'retry'
          ? Date.now() + Math.min(30000, 1000 * 2 ** Math.min(5, claimed.attempts - 1)) : 0;
        return { ...current, state: result.state, message: 'message' in result ? result.message : undefined, resumeAt };
      });
      notify();
      if (result.state === 'retry') return;
    }
  }
}
