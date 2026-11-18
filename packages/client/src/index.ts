export interface Snapshot<T> {
  seq: string;
  data: T;
}

export interface MutationResult<T> {
  commitSeq: string;
  replayed: boolean;
  data: T;
}

export class ReactiveCoreError extends Error {
  constructor(readonly status: number) {
    super(`ReactiveCore request failed (HTTP ${status})`);
  }
}

async function* snapshots<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<Snapshot<T>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let event = '';
  let data: string[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line === '') {
          const value = event === 'snapshot' && data.length
            ? JSON.parse(data.join('\n')) as Snapshot<T> : undefined;
          event = '';
          data = [];
          if (value && typeof value.seq === 'string' && /^\d{1,19}$/.test(value.seq)) yield value;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}

export class ReactiveCoreClient {
  constructor(
    private readonly origin: string,
    private readonly token: () => string | Promise<string>,
  ) {}

  private async request(operation: string, name: string, args: unknown, signal?: AbortSignal, key?: string) {
    const headers = new Headers({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await this.token()}`,
    });
    if (key) headers.set('Idempotency-Key', key);
    const response = await fetch(new URL(`/api/v1/${operation}`, this.origin), {
      method: 'POST', headers, body: JSON.stringify({ name, args }), signal,
      redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReactiveCoreError(response.status);
    }
    return response;
  }

  async query<T>(name: string, args: unknown, signal?: AbortSignal): Promise<Snapshot<T>> {
    return (await this.request('query', name, args, signal)).json();
  }

  async mutate<T>(name: string, args: unknown, key: string, signal?: AbortSignal): Promise<MutationResult<T>> {
    return (await this.request('mutation', name, args, signal, key)).json();
  }

  async *subscribe<T>(name: string, args: unknown, signal: AbortSignal): AsyncGenerator<Snapshot<T>> {
    let seq: bigint | undefined;
    let delay = 250;
    while (!signal.aborted) {
      try {
        const response = await this.request('subscribe', name, args, signal);
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
          await response.body?.cancel();
          throw new ReactiveCoreError(502);
        }
        for await (const snapshot of snapshots<T>(response.body)) {
          if (signal.aborted) return;
          delay = 250;
          const next = BigInt(snapshot.seq);
          if (seq === undefined || next > seq) {
            seq = next;
            yield snapshot;
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ReactiveCoreError && error.status < 500 && error.status !== 429) throw error;
      }
      await pause(delay, signal);
      delay = Math.min(delay * 2, 5000);
    }
  }
}

export * from "./offline.js";
