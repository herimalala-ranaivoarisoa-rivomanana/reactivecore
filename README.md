# ReactiveCore

**A self-hosted backend with real-time queries, PostgreSQL transactions, and offline mutation support.**

You supply the schema, queries, mutations, and access policies. ReactiveCore isolates data by tenant and delivers query updates over HTTP/SSE. The TypeScript SDK reconnects subscriptions and provides a persistent offline mutation queue.

This guide creates a ReactiveCore backend and a separate Vue or Next.js frontend for a live item list. You can replace either example with your own application.

**Release status.** The latest prerelease includes a Linux amd64 runtime, a TypeScript SDK, and SHA-256 checksums. MultiDB continues development with PostgreSQL and a MySQL preview. [ReactiveCore v0.1.1](https://github.com/herimalala-ranaivoarisoa-rivomanana/reactivecore/releases/tag/v0.1.1) · [ReactiveCore MultiDB](https://github.com/herimalala-ranaivoarisoa-rivomanana/reactivecore-multidb)

[Local setup](#1-install-the-prerequisites) · [Development token](#6-sign-a-local-development-token-and-query-the-api) · [Live test](#7-watch-a-live-update-and-replay-a-mutation) · [Vue and Next.js](#8-create-and-run-a-frontend) · [Offline writes](#add-offline-writes-to-a-frontend) · [Deployment](#9-configure-a-production-deployment) · [Tests](#verify-the-engine)

## 1. Install the prerequisites

Install Node.js 24 or later, npm, Docker with the Compose plugin, and curl. Use Bash for the commands below. Open each backend terminal in the `reactivecore` directory you clone here. The guide uses the sibling directory `../my-project` for your backend project. Step 8 names the terminal and directory for your frontend.

```sh
git clone https://github.com/herimalala-ranaivoarisoa-rivomanana/reactivecore.git
cd reactivecore
npm ci
npm run build
```

## 2. Create a project and add two functions

Run steps 1–4 from the repository root in your setup terminal. Start with a new `../my-project` directory. If you already created this example, keep your existing directory and continue with the first incomplete step.

```sh
npm run project -- init ../my-project
cp scripts/test-fixtures/project/application.mjs ../my-project/application.mjs
cp scripts/test-fixtures/project/migrations/001_items.sql ../my-project/migrations/
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';

const path = '../my-project/project.json';
const { name } = JSON.parse(readFileSync(path, 'utf8'));
const { queries, mutations } = JSON.parse(
  readFileSync('scripts/test-fixtures/project/project.json', 'utf8'),
);
writeFileSync(path, JSON.stringify({ name, queries, mutations }, null, 2) + '\n');
JS
npm run project -- codegen ../my-project
```

These commands create the backend project, copy the example, and generate `../my-project/client.ts`. Step 8 creates the frontend separately. The CLI uses the directory name `my-project` as the project name.

| File | What to change for your application |
| --- | --- |
| `project.json` | Describe each public function's argument and result types. Code generation supports scalars, objects, and homogeneous arrays. |
| `application.mjs` | Export a factory that registers NestJS providers with `ReactiveQuery` and `ReactiveMutation` and declares which functions can be called over HTTP. |
| `migrations/*.sql` | Define your tables, indexes, row-level security policies, and runtime grants. Add a numbered migration for each later schema change. |
| `client.ts` | Import the generated `createClient` in a TypeScript app. Rerun `codegen` after changing the manifest. |

Read the [example application](scripts/test-fixtures/project/application.mjs) and its [migration](scripts/test-fixtures/project/migrations/001_items.sql). The `items.list` query filters by the authenticated tenant and registers a table dependency. The `items.create` mutation validates the title, inserts a row, and calls `ctx.recordChange` in the same transaction. The change journal lets the engine refresh subscriptions that depend on the affected table. The database policy also enforces the tenant boundary.

## 3. Start PostgreSQL and Redis

Create a local environment file outside the engine repository. The example uses an isolated Compose project with its own volumes and ports.

```sh
cat > ../my-project/.env.compose <<'ENV'
POSTGRES_DB=postgres
POSTGRES_USER=reactivecore
POSTGRES_PASSWORD=local_admin_password
POSTGRES_PORT=56432
REDIS_PASSWORD=local_redis_password
REDIS_PORT=57379
ENV

docker compose -p reactivecore-guide --env-file ../my-project/.env.compose up -d --wait
docker compose -p reactivecore-guide --env-file ../my-project/.env.compose ps
```

Both services should report healthy. The Compose file binds PostgreSQL and Redis to loopback. Use these sample passwords only on a local machine.

## 4. Provision the database and register a tenant

```sh
export RC_PROVISION_ADMIN_URL=postgresql://reactivecore:local_admin_password@127.0.0.1:56432/postgres
export RC_PROVISION_APP_PASSWORD=local_app_password
export RC_PROVISION_WORKER_PASSWORD=local_worker_password

npm run project -- provision ../my-project
TENANT_ID=$(node -p 'crypto.randomUUID()')
USER_ID=$(node -p 'crypto.randomUUID()')
npm run project -- tenant ../my-project "$TENANT_ID"
printf 'TENANT_ID=%s\nUSER_ID=%s\n' "$TENANT_ID" "$USER_ID" > ../my-project/.env.identity

unset RC_PROVISION_ADMIN_URL RC_PROVISION_APP_PASSWORD RC_PROVISION_WORKER_PASSWORD
```

Provisioning creates `reactivecore_my_project`, applies core and project migrations, and enables the application and worker logins. Rerun `provision` to apply new migrations. Applied files are checked against recorded hashes. Keep their contents intact and add a new numbered file for schema changes. On a reused cluster, use the existing role passwords because provisioning preserves them.

## 5. Run the API and worker in separate terminals

Keep these terminals open as you work through steps 6–8.

| Terminal | What runs there |
| --- | --- |
| A | API at `http://127.0.0.1:4000` |
| B | Outbox worker |
| C | Health checks, JWT generation and mutations |
| D | Live SSE stream for step 7 |
| E | Vue or Next.js development server for step 8 |

**Terminal A, from the repository root.** Start the API with a local JWT signing secret.

```sh
export NODE_ENV=development
export DATABASE_URL=postgresql://reactivecore_app:local_app_password@127.0.0.1:56432/reactivecore_my_project
export REDIS_URL=redis://:local_redis_password@127.0.0.1:57379
export RC_JWT_ISSUER=urn:reactivecore:local
export RC_JWT_AUDIENCE=reactivecore:my-project
export RC_JWT_DEV_SECRET=local-development-signing-secret-only
export RC_HOST=127.0.0.1 PORT=4000
export RC_CORS_ORIGINS=http://localhost:5173,http://localhost:3000
npm run project -- serve ../my-project
```

**Terminal B, from the repository root.** Start the worker that publishes changes from the transactional outbox.

```sh
export DATABASE_URL=postgresql://reactivecore_worker:local_worker_password@127.0.0.1:56432/reactivecore_my_project
export REDIS_URL=redis://:local_redis_password@127.0.0.1:57379
npm run project -- worker ../my-project
```

**Terminal C, from the repository root.** The first endpoint should return `{"status":"alive"}`, the second `{"status":"ready"}`, and the third should report PostgreSQL and Redis as `up`.

```sh
curl -fsS http://127.0.0.1:4000/api/health/live
curl -fsS http://127.0.0.1:4000/api/health/ready
curl -fsS http://127.0.0.1:4000/api/health
```

## 6. Sign a local development token and query the API

**Terminal C, from the repository root.** Create a helper that issues a 15-minute development JWT for the tenant and user saved in step 4. It uses the signing secret, issuer and audience from Terminal A.

```sh
cat > ../my-project/sign-dev-token.mjs <<'JS'
import { SignJWT } from 'jose';

const token = await new SignJWT({
  tenant_id: process.env.TENANT_ID,
  scope: 'query mutation subscribe',
})
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(process.env.USER_ID)
  .setIssuer('urn:reactivecore:local')
  .setAudience('reactivecore:my-project')
  .setIssuedAt()
  .setExpirationTime('15m')
  .sign(new TextEncoder().encode('local-development-signing-secret-only'));

console.log('TOKEN=' + token);
JS
```

Generate or renew the token with this command. Run it from the repository root so Node can resolve the installed `jose` package.

```sh
(
  umask 077
  node --env-file=../my-project/.env.identity --input-type=module \
    < ../my-project/sign-dev-token.mjs > ../my-project/.env.token
)
source ../my-project/.env.token
```

The command saves the JWT to `../my-project/.env.token`. To see the value to paste into Vue or Next.js, run the following in Terminal C and copy the printed line.

```sh
source ../my-project/.env.token
printf '%s\n' "$TOKEN"
```

Use the JWT value alone in the browser's **Development token** field. In the shell, send it with the `Bearer` prefix as shown below. Keep the token local and regenerate it after it expires.

```sh
curl -fsS http://127.0.0.1:4000/api/v1/session \
  -H "Authorization: Bearer $TOKEN"
printf '\n'
curl -fsS http://127.0.0.1:4000/api/v1/query \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"items.list","args":{}}'
printf '\n'
```

The session response identifies your tenant, user and scopes. The query should show `{"seq":"0","data":[]}` on a fresh tenant. If you already created items, it shows the current list and sequence.

## 7. Watch a live update and replay a mutation

**Terminal D, from the repository root.** Load the saved token, open the live stream and leave it running.

```sh
source ../my-project/.env.token
curl -fsSN http://127.0.0.1:4000/api/v1/subscribe \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"items.list","args":{}}'
```

The stream sends the current snapshot as soon as it opens. On a fresh tenant you should see this frame, followed by a blank line. The command stays open so it can receive future updates.

```text
id: 0
event: snapshot
data: {"seq":"0","data":[]}
```

**Terminal C, from the repository root.** Load the same token and send the same request twice. Generate the key once, outside the loop.

```sh
source ../my-project/.env.token
KEY=$(node -p 'crypto.randomUUID()')
for attempt in 1 2; do
  curl -fsS http://127.0.0.1:4000/api/v1/mutation \
    -H "Authorization: Bearer $TOKEN" \
    -H "Idempotency-Key: $KEY" \
    -H 'Content-Type: application/json' \
    -d '{"name":"items.create","args":{"title":"First live item"}}' || break
  printf '\n'
done
```

Terminal C prints two JSON responses like these. Your item ID will differ. The item ID and `commitSeq` should match across both responses.

```jsonl
{"data":{"id":"a340a044-3346-41f2-804b-13a45d41b361","title":"First live item"},"commitSeq":"1","replayed":false}
{"data":{"id":"a340a044-3346-41f2-804b-13a45d41b361","title":"First live item"},"commitSeq":"1","replayed":true}
```

Terminal D receives one updated snapshot for the committed write. The retry returns the original receipt without adding another row.

```text
id: 1
event: snapshot
data: {"seq":"1","data":[{"id":"a340a044-3346-41f2-804b-13a45d41b361","title":"First live item"}]}
```

If the initial snapshot arrives but the update does not, rerun the query from step 6. If it includes the new item, check that Terminal D loaded the same token and that the worker is running in Terminal B. A `401` means you should verify the JWT with the session command in step 6. If it expired, generate a fresh one, reload it in Terminal C and reopen the stream in Terminal D.

Use a fresh key for a new action. When retrying an action whose outcome is unknown, keep its original key and arguments. Press Ctrl+C in Terminal D when you finish.

## 8. Create and run a frontend

Choose either Vue with Vite or Next.js. Start the chosen example in Terminal E from the repository root. Keep the API and worker running in A and B and use Terminal C to read or renew the token. If you change the allowed origins in step 5, restart the API.

### Option A: Vue with Vite

Keep the API and worker running. In a new terminal at the ReactiveCore repository root, scaffold a Vue and TypeScript app next to the backend and install the SDK from a local tarball.

```sh
(cd .. && npm create vite@latest my-project-web -- --template vue-ts --no-interactive)
SDK_TARBALL=$(npm pack -w @reactivecore/client --pack-destination "$(cd ../my-project && pwd)" --silent)
cp ../my-project/client.ts ../my-project-web/src/reactivecore-client.ts

cd ../my-project-web
npm install
npm install "../my-project/$SDK_TARBALL"
```

Run the block in one terminal so `SDK_TARBALL` contains the filename produced by `npm pack`. After changing the backend's function contracts, rerun `codegen` from the ReactiveCore repository and copy the new file into `src/reactivecore-client.ts`.

From `my-project-web`, replace the starter component with the following:

```sh
cat > src/App.vue <<'VUE'
<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { createClient } from './reactivecore-client';

const token = ref('');
const items = ref<{ id: string; title: string }[]>([]);
const status = ref('Enter a development token to connect.');
let active: AbortController | undefined;

async function connect() {
  active?.abort();
  const subscription = new AbortController();
  active = subscription;
  const accessToken = token.value.trim();
  token.value = '';
  items.value = [];
  status.value = 'Waiting for the first snapshot…';
  const client = createClient('http://127.0.0.1:4000', () => accessToken);

  try {
    for await (const snapshot of client.subscribe('items.list', {}, subscription.signal)) {
      if (subscription.signal.aborted) return;
      items.value = snapshot.data;
      status.value = 'Receiving snapshots.';
    }
  } catch (error) {
    if (!subscription.signal.aborted) {
      status.value = error instanceof Error ? error.message : 'Subscription failed.';
    }
  }
}

onUnmounted(() => active?.abort());
</script>

<template>
  <main>
    <h1>Live items</h1>
    <form @submit.prevent="connect">
      <label for="token">Development token</label>
      <input id="token" v-model="token" type="password" autocomplete="off" required />
      <button type="submit">Connect</button>
    </form>
    <p role="status">{{ status }}</p>
    <ul>
      <li v-for="item in items" :key="item.id">{{ item.title }}</li>
    </ul>
  </main>
</template>
VUE

npm run dev -- --port 5173 --strictPort
```

1. Open `http://localhost:5173`. Use this exact origin because the API's CORS setting in step 5 allows it.
2. In Terminal C, print the saved JWT using the command in step 6. Paste the printed value into **Development token** and click **Connect**. The first snapshot shows the current server list.
3. Run the mutation from step 7 again with a fresh idempotency key and a new title. The new item should appear in Vue without a page refresh.
4. If the token expires, rerun step 6 and connect with the new token. The example holds the token in memory. In your application, pass a token provider from your authentication layer so the SDK can obtain a current token on reconnect.

### Option B: Next.js with the App Router

This example needs the running API and worker from step 5, the generated client from step 2, and a development JWT from step 6. If you skipped token generation, do it before opening the page. [Generate a development JWT](#6-sign-a-local-development-token-and-query-the-api)

In Terminal E, start from the ReactiveCore repository root. Run this block in one terminal to create the Next.js app and install the SDK archive produced by `npm pack`.

```sh
(cd .. && npx --yes create-next-app@latest my-project-next --ts --app --src-dir --no-tailwind --use-npm --yes --skip-install)
SDK_TARBALL=$(npm pack -w @reactivecore/client --pack-destination "$(cd ../my-project && pwd)" --silent)
cp ../my-project/client.ts ../my-project-next/src/reactivecore-client.ts

cd ../my-project-next
npm install "../my-project/$SDK_TARBALL"
```

Keep Terminal E in `my-project-next`. Replace the starter layout and home page. The layout uses system fonts, and the Client Component opens the subscription in the browser.

```sh
cat > src/app/layout.tsx <<'TSX'
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
TSX

cat > src/app/page.tsx <<'TSX'
'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createClient } from '../reactivecore-client';

export default function Home() {
  const [token, setToken] = useState('');
  const [items, setItems] = useState<{ id: string; title: string }[]>([]);
  const [status, setStatus] = useState('Enter a development token to connect.');
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => active.current?.abort(), []);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accessToken = token.trim();
    if (!accessToken) return;

    active.current?.abort();
    const subscription = new AbortController();
    active.current = subscription;
    setToken('');
    setItems([]);
    setStatus('Waiting for the first snapshot…');

    const client = createClient('http://127.0.0.1:4000', () => accessToken);
    try {
      for await (const snapshot of client.subscribe('items.list', {}, subscription.signal)) {
        if (subscription.signal.aborted) return;
        setItems(snapshot.data);
        setStatus('Receiving snapshots.');
      }
    } catch (error) {
      if (!subscription.signal.aborted) {
        setStatus(error instanceof Error ? error.message : 'Subscription failed.');
      }
    }
  }

  return (
    <main>
      <h1>Live items</h1>
      <form onSubmit={connect}>
        <label htmlFor="token">Development token</label>
        <input id="token" value={token} onChange={(event) => setToken(event.target.value)}
          type="password" autoComplete="off" required />
        <button type="submit">Connect</button>
      </form>
      <p role="status">{status}</p>
      <ul>{items.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
    </main>
  );
}
TSX

npm run dev -- --port 3000
```

1. Open `http://localhost:3000`. This exact browser origin is allowed by the API configuration in step 5.
2. In **Terminal C**, from the `reactivecore` repository root, print the JWT saved in step 6.

   ```sh
   source ../my-project/.env.token
   printf '%s\n' "$TOKEN"
   ```

3. Paste the printed JWT into **Development token** and click **Connect**. The page should show **Receiving snapshots.** and display **First live item** if step 7 succeeded. An empty list with that status means the tenant has no items yet.
4. From Terminal C, create an item with a new key. With the page still open, **Item from Next.js check** should appear without reloading.

   ```sh
   source ../my-project/.env.token
   curl -fsS http://127.0.0.1:4000/api/v1/mutation \
     -H "Authorization: Bearer $TOKEN" \
     -H "Idempotency-Key: $(node -p 'crypto.randomUUID()')" \
     -H 'Content-Type: application/json' \
     -d '{"name":"items.create","args":{"title":"Item from Next.js check"}}'
   ```

5. If you get `401`, confirm that the session command in step 6 accepts the token. A development token lasts 15 minutes. When it expires, run the generation command again in Terminal C, print the fresh JWT and reconnect in the browser. The example keeps the token in memory. Use a token provider from your authentication layer in production.

Both examples display live data. To add offline writes, wire a **Create** button and an operation list to the queue below. In Next.js, initialize IndexedDB from browser code, for example in an effect inside a Client Component.

### Add offline writes to a frontend

The queue works in browser code written with Vue, Next.js, Svelte, or plain TypeScript. The SDK persists operations and retries them. Your frontend decides which local state to show, when to sync, and whether people can reopen the app and read cached data offline.

#### 1. Open the queue for the signed-in user

On sign-in, call `GET /api/v1/session` with the active access token and check the response. The server returns the verified issuer, audience, tenant ID, and user ID. Use these values with the API origin to isolate the browser queue. Set up a new queue when the account or tenant changes.

```ts
type SessionIdentity = {
  issuer: string;
  audience: string;
  tenantId: string;
  userId: string;
};

export async function readSession(origin: string, token: string): Promise<SessionIdentity> {
  const response = await fetch(new URL('/api/v1/session', origin), {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Session check failed (HTTP ${response.status})`);
  return response.json();
}
```

To reopen the queue after a reload without network access, your app needs to recover the last verified identity through its local sign-in flow. Use it to scope local reads. Confirm the identity with the server before enabling sends again. A queue scoped to another account can remain on the device and must only resume under that account.

#### 2. Connect the queue to your interface

Save the following browser example as `src/offline-items.ts` next to the generated client from step 8. It uses the `items.create` function from step 2. Use `render` to replace your framework's list of local operations. Supply a token provider bound to the verified account so a queued mutation cannot use a different account's token during a session switch.

```ts
import {
  OfflineQueue,
  ReactiveCoreError,
  createIndexedDbStore,
  type OfflineOperation,
} from '@reactivecore/client';
import { createClient } from './reactivecore-client';

type ItemInput = { title: string };

export function openItemQueue(
  origin: string,
  session: { issuer: string; audience: string; tenantId: string; userId: string },
  getAccessToken: () => Promise<string>,
  isSameSessionActive: () => boolean,
  render: (operations: OfflineOperation<ItemInput>[]) => void,
) {
  const lifetime = new AbortController();
  const client = createClient(origin, getAccessToken);
  const scope = JSON.stringify([
    new URL(origin).origin, session.issuer, session.audience,
    session.tenantId, session.userId,
  ]);
  const queue = new OfflineQueue(createIndexedDbStore<ItemInput>('rc-operations'), scope);

  async function refresh() {
    const operations = await queue.list();
    if (!lifetime.signal.aborted) render(operations);
  }

  async function sync() {
    await queue.sync(
      async (operation) => {
        try {
          const result = await client.mutate(
            'items.create', operation.args, operation.key, lifetime.signal,
          );
          return { state: 'confirmed', commitSeq: result.commitSeq };
        } catch (error) {
          if (error instanceof ReactiveCoreError) {
            if (error.status === 409) return { state: 'conflict', message: error.message };
            if (error.status === 400 || error.status === 403 || error.status === 404) {
              return { state: 'rejected', message: error.message };
            }
          }
          return { state: 'retry' };
        }
      },
      () => !lifetime.signal.aborted && navigator.onLine && isSameSessionActive(),
      () => { void refresh().catch(console.error); },
    );
    await refresh();
  }

  function requestSync() {
    void sync().catch(console.error);
  }

  window.addEventListener('online', requestSync);
  const timer = window.setInterval(requestSync, 5_000);
  requestSync();

  return {
    async create(title: string) {
      const operation = await queue.enqueue({ title });
      await refresh();
      requestSync();
      return operation.key;
    },
    async cancel(key: string) {
      const cancelled = await queue.cancel(key);
      await refresh();
      return cancelled;
    },
    dispose() {
      lifetime.abort();
      window.removeEventListener('online', requestSync);
      window.clearInterval(timer);
    },
  };
}
```

Wire the form's **Create** button to `create(title)`. The queue writes the operation before the frontend displays it. Use `operation.args.title` for the label, `operation.state` for the status, and `operation.key` for the **Cancel** button. Show that button for `pending` operations. If `cancel(key)` returns `false`, use the refreshed state because a send may already have started. Call `dispose()` when signing out, switching accounts, or unmounting the code that owns the queue.

The `online` event starts a sync pass and the timer lets delayed retries resume. Browser network status only indicates whether the device appears connected. A timeout or interrupted request can leave the server outcome unknown. The queue reuses the original arguments and idempotency key on retry so a previously committed write can be replayed safely.

#### 3. Reconcile the local operation with server data

Keep the latest `items.list` snapshot alongside the operation list. The starter example assigns item IDs on the server, so you can show local operations in a separate activity list. When a confirmed operation's `commitSeq` is at or below the latest snapshot's `seq`, the snapshot has caught up to that commit. Compare sequence strings with `BigInt`, for example `BigInt(snapshot.seq) >= BigInt(operation.commitSeq)` when a commit sequence is present. An item can be outside the current query's filters or limit even after catch-up.

For a single optimistic list like the tasks demo, extend both your mutation and its client manifest to accept a client-generated UUID. Validate it on the server, use it as the inserted row ID, and handle collisions. Generate it with `crypto.randomUUID()` when enqueuing, keep it in the persisted arguments, and merge the provisional row with the SSE row using that UUID. Keep the operation's idempotency key separate. It identifies the write attempt across retries, while the UUID identifies the row.

PostgreSQL applies the mutation transactionally when it reaches the server. For writes such as inventory transfers, you can show a pending operation separately and keep the last confirmed balance on screen until a new snapshot arrives.

#### 4. Verify in a browser

1. Open the frontend online and confirm that the subscription has delivered its first snapshot.
2. In browser developer tools, select **Network → Offline**. Create two items. Both should show `pending`. Cancel one and check that its status becomes `cancelled`.
3. Restore the connection. The other item should become `confirmed` and appear once in the live list. The cancelled item should stay absent from the server list.
4. To repeat the test across a page reload, serve the app shell offline, for example with a service worker, and restore the appropriate local queue. Cache query snapshots separately if the screen should also show the last confirmed data offline. Test a switch to another account and check that it cannot send the first account's pending operations.

On a TypeScript mobile or desktop frontend, reuse the queue with a platform-specific `OfflineStore`, such as a SQLite implementation. Implement its update operation as one atomic read, transition, and write. A frontend in another language can implement the same lifecycle against the HTTP and SSE endpoints.

### Proposed Next.js offline starter

An optional starter would make offline behavior reproducible across new Next.js projects. It would connect the frontend to the SDK's persistent mutation queue and ReactiveCore's PostgreSQL transactions, then verify the integration with an automated browser test. The shared queue and the HTTP/SSE protocol would remain usable from Vue and other frontends.

| Benefit | What the starter would provide |
| --- | --- |
| Faster setup | Run the app, create a task offline, reload the page, and resume synchronization when the connection returns. |
| Consistent behavior across projects | Persist operations in IndexedDB, isolate the queue by user and tenant, and support cancellation before the first send. |
| Safe retries after a disconnect | If PostgreSQL commits a mutation and the response is lost, retry with the original idempotency key so the server can return the stored result without applying the write again. |
| Regression coverage | Run the complete offline scenario in a browser after updates to Next.js, the SDK, or the backend. |
| Executable example | Follow one action from the form and IndexedDB through the PostgreSQL transaction to the confirmed view delivered by SSE. |

Each application decides how to present pending operations. A task can appear immediately as a provisional row. A sales app can show a pending sale and keep the last confirmed stock on screen. If two devices sell the last unit offline, the server can accept one sale and reject the other during synchronization when the mutation checks and updates stock in the same transaction. **The local write records the intent. The server transaction validates the business operation.**

The starter's test should state which cache behaviors it covers. Reloading the entry screen, viewing previously fetched data, and opening a page that has never been visited are separate scenarios.

The first automated test should open the app online, go offline, create two operations, reload, and cancel one before reconnecting. After reconnecting, it should verify on the server that the retained operation committed exactly once and the cancelled operation created no row. The browser should receive the confirmed result through SSE.

## 9. Configure a production deployment

See the [operations guide](OPERATIONS.md) for release artifacts, container deployment, database backup and recovery, and upgrades. ReactiveCore is distributed under the [MIT License](LICENSE).

1. Run provisioning as an administrative job. Give the API the `reactivecore_app` database URL and the worker the `reactivecore_worker` URL. Store the credentials and Redis URL in your deployment's secret manager.
2. Configure an identity provider to sign RS256 access tokens. Set `RC_JWT_ISSUER`, `RC_JWT_AUDIENCE`, and `RC_JWKS_URL` on the API. Use an HTTPS JWKS URL. Include `iat` and `exp` and give tokens a lifetime of at most one hour. The issuer must supply a UUID in `sub`, the authorized tenant UUID in `tenant_id`, and a space-separated `scope` with the allowed operations. Use the application function policies for permissions within a tenant.
3. Serve the API over HTTPS. Allow the frontend origins in `RC_CORS_ORIGINS` and configure the reverse proxy to stream SSE without response buffering. Set `RC_HOST` and `PORT` for your deployment. If you override `RC_INVALIDATION_CHANNEL`, give the API and worker the same value.
4. Monitor `/api/health/live` and `/api/health/ready`. Monitor Redis separately through `/api/health`. The durable change log lets the subscription engine catch up when Redis is unavailable. Deploy trusted project modules with the API and use separate deployments and credentials for applications operated by independent teams.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Compose cannot bind a port | Pick free ports in `.env.compose` and update every URL that uses them. |
| PostgreSQL rejects a password | Confirm the role and password for that cluster. Existing volumes preserve initialized credentials. |
| `401` | Regenerate an expired token and compare its issuer, audience, and signature with the API configuration. |
| `403` | Check the JWT scopes and the function's access policy. |
| Query works but SSE updates are delayed | Check the worker and Redis, verify that query dependencies and mutation changes use the same table, and check proxy buffering. |
| Browser reports a CORS error | Add the exact frontend origin to `RC_CORS_ORIGINS` and restart the API. |

To stop the local environment, stop the API, worker, and SSE client with Ctrl+C, then run the following. The named volumes retain your data.

```sh
docker compose -p reactivecore-guide --env-file ../my-project/.env.compose down
```

## Database maintenance

Commit sequences are ordered within each tenant. When upgrading from a version with a global clock, apply the migration before restarting the runtime. Journal pruning and receipt response compaction are available as a scheduled maintenance job. [Upgrade and retention instructions](OPERATIONS.md#upgrade-to-tenant-commit-clocks)

## Verify the engine

```sh
npm run build
npm test
node --test packages/client/test/offline.test.mjs
node scripts/test-infra.mjs
node --env-file=.env.reactivecore-test scripts/test-project.mjs
```

The integration test creates a temporary project and verifies generated types, migrations, idempotency, live updates, worker acknowledgement, and restoration from a PostgreSQL backup.
