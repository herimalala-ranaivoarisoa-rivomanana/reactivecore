# ReactiveCore

ReactiveCore is a self-hosted backend engine with transactional mutations, real-time queries over HTTP/SSE, and JWT authentication. The TypeScript SDK supports reconnecting subscriptions and a persistent offline mutation queue. Applications provide their own schema, functions, and access policies.

## Create a project

Use Node.js 24 or later, PostgreSQL 16, and Redis. Run the CLI from the ReactiveCore repository.

```sh
npm ci
npm run build
npm run project -- init ../my-project
```

Define trusted application code in `application.mjs` with `ReactiveQuery` and `ReactiveMutation`. Declare the functions exposed by the project and their access policies. Place application migrations in `migrations/`. Migrations must scope tenant data and grant the runtime role only the privileges it needs.

Update `project.json` with each function’s argument and result types, then regenerate the typed client. The manifest supports scalars, objects, and homogeneous arrays.

```sh
npm run project -- codegen ../my-project
```

## Provision the database

Set `RC_PROVISION_ADMIN_URL` to a PostgreSQL admin connection. On a new cluster, set `RC_PROVISION_APP_PASSWORD` and `RC_PROVISION_WORKER_PASSWORD` to enable the runtime logins. Provisioning preserves credentials for existing logins.

```sh
npm run project -- provision ../my-project
tenant=$(node -p 'crypto.randomUUID()')
npm run project -- tenant ../my-project "$tenant"
```

Provisioning creates `reactivecore_my_project` and applies core and project migrations in order. Subsequent runs check recorded migration hashes and apply pending migrations. Previously deployed core migration hashes are recognized for existing projects.

## Run the API and worker

Configure a separate environment for each process.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Project PostgreSQL URL. Use `reactivecore_app` for the API and `reactivecore_worker` for the worker. |
| `REDIS_URL` | Redis connection URL. |
| `RC_JWT_ISSUER` | Trusted JWT issuer. |
| `RC_JWT_AUDIENCE` | Exact JWT audience. The CLI defaults to `reactivecore:my-project`. |
| `RC_JWKS_URL` | HTTPS URL for the issuer’s RS256 verification keys. |
| `RC_HOST`, `PORT`, `RC_CORS_ORIGINS` | API bind address, port, and permitted browser origins. The default bind address is `127.0.0.1:4000`. |
| `RC_INVALIDATION_CHANNEL` | Optional Redis channel override. Use the same value for the API and worker. |

The issuer must provide a UUID in `sub`, the authorized tenant UUID in `tenant_id`, and a space-separated `scope` containing the allowed operations (`query`, `mutation`, `subscribe`). Project access policies receive the verified claims. HS256 with `RC_JWT_DEV_SECRET` is available in development and test only.

```sh
npm run project -- serve ../my-project
npm run project -- worker ../my-project
```

Run these commands in separate terminals or services. Project modules execute with trusted operator access. Use separate deployments and credentials for applications managed by independent teams.

## Client API

`POST /api/v1/query`, `/api/v1/mutation`, and `/api/v1/subscribe` accept `{ name, args }` and a bearer token. Mutations also require an `Idempotency-Key` header. Subscriptions return SSE snapshots. The SDK reconnects automatically, and the PostgreSQL change log provides a fallback when Redis is unavailable.

Use `@reactivecore/client` from the workspace or run `npm pack -w @reactivecore/client` after building. For offline mutations, pair `OfflineQueue` with `createIndexedDbStore` in browsers or supply an `OfflineStore` on another platform. Scope the queue by project, environment, tenant, and authenticated user. Applications manage their own read and UI caches.

## Verify the runtime

```sh
npm run build
npm test
node --test packages/client/test/offline.test.mjs
node scripts/test-infra.mjs
node --env-file=.env.reactivecore-test scripts/test-project.mjs
```

The integration test creates a temporary project and database, then verifies migration integrity, idempotent writes, SSE delivery, and worker acknowledgement.
