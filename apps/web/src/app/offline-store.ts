import { OfflineQueue, type OfflineOperation, type OfflineStore } from "../../../../packages/client/src/offline";

export async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function browserQueue<Args>(name: string, scope: string) {
  async function database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = ({ oldVersion }) => {
        if (oldVersion === 0) {
          request.result.createObjectStore("transfers", { keyPath: "key" }).createIndex("scope", "scope");
        } else {
          const cursor = request.transaction!.objectStore("transfers").openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            // An earlier client may already have sent this operation.
            row.update({
              ...row.value,
              state: row.value.rejection ? "rejected" : "retry",
              message: row.value.rejection,
              attempts: 1,
              resumeAt: 0,
            });
            row.continue();
          };
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function transaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore, result: (data: T) => void) => void,
  ): Promise<T> {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("transfers", mode);
        let result: T;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
        run(tx.objectStore("transfers"), (data) => { result = data; });
      });
    } finally {
      db.close();
    }
  }

  function read<T>(request: IDBRequest<T>, resolve: (result: T) => void) {
    request.onsuccess = () => resolve(request.result);
  }

  const store: OfflineStore<Args> = {
    add: (entry) => transaction("readwrite", (table) => { table.add(entry); }),
    list: (scope) => transaction("readonly", (table, result) => read(table.index("scope").getAll(scope), result)),
    update: (key, transition) => transaction("readwrite", (table, result) => {
      read(table.get(key), (entry?: OfflineOperation<Args>) => {
        const next = entry && transition(entry);
        if (next) table.put(next);
        result(next);
      });
    }),
  };

  return new OfflineQueue(store, scope);
}
