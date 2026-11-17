"use client";

import { useEffect, useState } from "react";

export interface Stock {
  id: string;
  medicineId: string;
  quantity: number;
  version: string;
}

interface Snapshot {
  seq: string;
  data: Stock[];
}

type StreamState = "connecting" | "live" | "reconnecting" | "error";

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<Snapshot>;
  return typeof snapshot.seq === "string" && /^\d{1,19}$/.test(snapshot.seq) && Array.isArray(snapshot.data);
}

async function readSnapshots(
  stream: ReadableStream<Uint8Array>,
  receive: (snapshot: Snapshot) => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let parts: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (event === "snapshot" && parts.length) {
            const snapshot: unknown = JSON.parse(parts.join("\n"));
            if (isSnapshot(snapshot)) receive(snapshot);
          }
          event = "";
          parts = [];
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trimStart();
        } else if (line.startsWith("data:")) {
          parts.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export function useReactiveQuery(
  name: "inventory.list",
  { pharmacyId, availableOnly = false }: { pharmacyId: string; availableOnly?: boolean },
  token: string,
) {
  const input = JSON.stringify({ name, args: { pharmacyId, availableOnly } });
  const [view, setView] = useState<{
    input: string; token: string; snapshot: Snapshot | null; state: StreamState;
  } | null>(null);

  useEffect(() => {
    const stop = new AbortController();
    let snapshot: Snapshot | null = null;
    let delay = 400;
    const publish = (state: StreamState) => {
      if (!stop.signal.aborted) setView({ input, token, snapshot, state });
    };

    async function connect() {
      while (!stop.signal.aborted) {
        try {
          const response = await fetch("/api/reactive/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Dev-Token": token },
            body: input,
            signal: stop.signal,
          });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            if (response.status >= 400 && response.status < 500 && response.status !== 429) {
              publish("error");
              return;
            }
          } else {
            await readSnapshots(response.body, (next) => {
              if (!snapshot || BigInt(next.seq) > BigInt(snapshot.seq)) snapshot = next;
              delay = 400;
              publish("live");
            });
          }
        } catch {
          if (stop.signal.aborted) return;
        }

        publish("reconnecting");
        await pause(delay, stop.signal);
        delay = Math.min(delay * 2, 5000);
      }
    }
    void connect();
    return () => stop.abort();
  }, [input, token]);

  return view?.input === input && view.token === token
    ? view
    : { snapshot: null, state: "connecting" as const };
}

export async function mutate(name: "inventory.transfer", args: object, token: string, key: string) {
  const response = await fetch("/api/reactive/mutate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Dev-Token": token, "Idempotency-Key": key },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  return { status: response.status, result };
}
