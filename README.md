# ReactiveCore

ReactiveCore is a self-hosted backend for applications that need PostgreSQL transactions, real-time queries over HTTP/SSE, and tenant isolation. You supply the schema, queries, mutations, and access policies. The TypeScript SDK supports reconnecting subscriptions and a persistent offline mutation queue.

This guide runs an item list as a separate project and shows how to replace it with your own application.

## 1. Install the prerequisites

Install Node.js 24 or later, npm, Docker with the Compose plugin, and curl. Run the commands below in a Bash shell from the ReactiveCore repository root, including when opening additional terminals.

```sh
git clone https://github.com/herimalala-ranaivoarisoa-rivomanana/reactivecore.git
cd reactivecore
npm ci
npm run build
```

## 2. Create a project and add two functions

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

The CLI requires a new directory and takes the project name from its lowercase directory slug. The generated files belong to your project.

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

Terminal A starts the API with a local JWT signing secret.

```sh
export NODE_ENV=development
export DATABASE_URL=postgresql://reactivecore_app:local_app_password@127.0.0.1:56432/reactivecore_my_project
export REDIS_URL=redis://:local_redis_password@127.0.0.1:57379
export RC_JWT_ISSUER=urn:reactivecore:local
export RC_JWT_DEV_SECRET=local-development-signing-secret-only
export RC_HOST=127.0.0.1 PORT=4000
npm run project -- serve ../my-project
```

Terminal B starts the worker that publishes invalidations from the transactional outbox.

```sh
export DATABASE_URL=postgresql://reactivecore_worker:local_worker_password@127.0.0.1:56432/reactivecore_my_project
export REDIS_URL=redis://:local_redis_password@127.0.0.1:57379
npm run project -- worker ../my-project
```

In a third terminal, check that the API process is alive and can read the PostgreSQL commit clock. The last endpoint reports the individual dependency statuses.

```sh
curl -fsS http://127.0.0.1:4000/api/health/live
curl -fsS http://127.0.0.1:4000/api/health/ready
curl -fsS http://127.0.0.1:4000/api/health
```

## 6. Sign a local development token and query the API

Create a short-lived JWT using the same secret, issuer, and audience as the API. The CLI defaults the audience to `reactivecore:<project-name>`.

```sh
node --env-file=../my-project/.env.identity --input-type=module > ../my-project/.env.token <<'JS'
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

source ../my-project/.env.token
curl -fsS http://127.0.0.1:4000/api/v1/session \
  -H "Authorization: Bearer $TOKEN"
curl -fsS http://127.0.0.1:4000/api/v1/query \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"items.list","args":{}}'
```

The session response identifies the tenant, user, and granted scopes. The first query returns `{"data":[],"seq":"0"}` on a fresh database. Sequence values are decimal strings.

## 7. Watch a live update and replay a mutation

In a fourth terminal, open the SSE stream and leave it running.

```sh
source ../my-project/.env.token
curl -fsSN http://127.0.0.1:4000/api/v1/subscribe \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"items.list","args":{}}'
```

You should receive the initial snapshot. Back in the third terminal, make the same mutation twice with one idempotency key.

```sh
KEY=$(node -p 'crypto.randomUUID()')
for attempt in 1 2; do
  curl -fsS http://127.0.0.1:4000/api/v1/mutation \
    -H "Authorization: Bearer $TOKEN" \
    -H "Idempotency-Key: $KEY" \
    -H 'Content-Type: application/json' \
    -d '{"name":"items.create","args":{"title":"First live item"}}'
  printf '\n'
done
```

The first response has `replayed: false`. The second has `replayed: true` with the same item ID and commit sequence. The subscriber receives a snapshot containing one item. Use a fresh key for each new action, and keep the original key and arguments when retrying an action whose outcome is unknown. Stop the stream with Ctrl+C.

## 8. Use the TypeScript SDK

Install the SDK as a workspace dependency or build a tarball with `npm pack -w @reactivecore/client` from this repository and install it in your application. Copy the generated client into your app or keep it in a shared project package.

```ts
import { createClient } from './client.js';

async function watchItems(getAccessToken: () => Promise<string>, signal: AbortSignal) {
  const client = createClient('http://127.0.0.1:4000', getAccessToken);

  for await (const snapshot of client.subscribe('items.list', {}, signal)) {
    console.log(snapshot.data);
  }
}
```

Pass a token provider from your authentication layer and abort the subscription when the screen closes or the user signs out. The SDK reconnects after transient failures. For browser calls, set `RC_CORS_ORIGINS` to the frontend origin, for example `http://localhost:3000`.

### Queue a mutation offline

Use the IndexedDB store in browsers. Include the project, API origin, tenant, and user in the queue scope. This keeps operations attached to the session that created them.

```ts
import {
  OfflineQueue,
  ReactiveCoreError,
  createIndexedDbStore,
} from '@reactivecore/client';
import { createClient } from './client.js';

export function itemQueue(
  origin: string,
  session: { tenantId: string; userId: string },
  getAccessToken: () => Promise<string>,
  render: () => void,
) {
  const client = createClient(origin, getAccessToken);
  const scope = JSON.stringify(['my-project', origin, session.tenantId, session.userId]);
  const queue = new OfflineQueue(createIndexedDbStore<{ title: string }>('rc-operations'), scope);

  async function sync() {
    await queue.sync(async (operation) => {
      try {
        const result = await client.mutate('items.create', operation.args, operation.key);
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
    }, () => navigator.onLine, render);
  }

  return { queue, sync };
}
```

1. Call `queue.enqueue({ title: 'Draft item' })` while offline. Read `queue.list()` to show the persisted state, including after reloading the page.
2. To cancel before the first send, call `queue.cancel(operation.key)`. A result of `true` confirms cancellation. Once claimed for sending, an operation may already have committed.
3. Reenable the network and call `sync()`. In an app, run it at startup, on reconnect, and on a periodic retry while the same session is active. Stop these triggers on sign-out. The engine reuses the operation key when delivery needs replay.
4. Confirm that a pending operation becomes `confirmed` and appears in the subscription. Verify separately that a cancelled operation stays `cancelled` and creates no row.

Applications own their read cache and optimistic UI. The server commits mutations transactionally when it receives them.

## 9. Configure a production deployment

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

## Verify the engine

```sh
npm run build
npm test
node --test packages/client/test/offline.test.mjs
node scripts/test-infra.mjs
node --env-file=.env.reactivecore-test scripts/test-project.mjs
```

The integration test creates a temporary project and verifies generated types, migrations, idempotency, live updates, and worker acknowledgement.
