# ReactiveCore

ReactiveCore est un moteur auto-hébergé pour créer des backends transactionnels et temps réel. Chaque application fournit ses fonctions NestJS et ses propres migrations. Le moteur fournit l’API HTTP/SSE, l’authentification JWT, le journal PostgreSQL, l’outbox et un SDK TypeScript avec file hors ligne annulable avant envoi.

La branche [`demo`](https://github.com/herimalala-ranaivoarisoa-rivomanana/reactivecore/tree/demo) regroupe les interfaces Inventaire et Tâches ainsi que les guides pédagogiques.

## Créer un backend

Avec Node.js 24+, PostgreSQL 16 et Redis, depuis la racine du dépôt :

```bash
npm ci
npm run build
npm run project -- init ../mon-projet
```

Le dossier généré contient un module vide `application.mjs`, un manifeste `project.json`, un dossier `migrations` et un client `client.ts`. Définissez les fonctions de votre application avec `ReactiveQuery` et `ReactiveMutation`. Le module déclare également les fonctions exposées et leurs politiques d’accès. Les migrations métier doivent rattacher les données au tenant et accorder au rôle applicatif les privilèges nécessaires.

Complétez le manifeste pour générer les types du client. Il accepte les scalaires `string`, `number`, `boolean` et `null`, les objets et les tableaux à type unique.

```bash
npm run project -- codegen ../mon-projet
```

Le [projet de test](scripts/test-fixtures/project) montre le contrat minimal d’une requête, d’une mutation et d’une migration. Il est utilisé par le test d’intégration et n’est pas copié par la CLI.

## Provisionner et démarrer

Configurez `RC_PROVISION_ADMIN_URL` avec le compte PostgreSQL d’administration. Sur un cluster neuf, fournissez aussi `RC_PROVISION_APP_PASSWORD` et `RC_PROVISION_WORKER_PASSWORD`. La CLI active ces deux rôles lorsqu’ils ne disposent pas encore d’un accès. Elle ne change pas les mots de passe des rôles déjà actifs.

```bash
npm run project -- provision ../mon-projet
tenant=$(node -p 'crypto.randomUUID()')
npm run project -- tenant ../mon-projet "$tenant"
```

La CLI crée `reactivecore_mon_projet`, applique les migrations dans l’ordre et vérifie leurs empreintes aux lancements suivants. Les migrations déjà enregistrées par les versions antérieures restent reconnues à partir de leurs empreintes d’origine. Les données existantes restent dans leur base.

Configurez le processus API avec les variables suivantes.

| Variable | Valeur |
| --- | --- |
| `DATABASE_URL` | Connexion à la base du projet avec `reactivecore_app`. |
| `REDIS_URL` | Connexion au Redis du projet. |
| `RC_JWT_ISSUER` | Émetteur JWT autorisé. |
| `RC_JWT_AUDIENCE` | Audience exacte. Par défaut, la CLI utilise `reactivecore:mon-projet`. |
| `RC_JWKS_URL` | Adresse HTTPS des clés publiques RS256. |
| `RC_HOST`, `PORT`, `RC_CORS_ORIGINS` | Adresse, port et origines web autorisées selon le déploiement. |

L’émetteur doit fournir un UUID dans `sub`, le tenant autorisé dans `tenant_id`, et les opérations permises dans `scope` sous forme de mots séparés par des espaces. Les politiques métier du projet reçoivent aussi les claims vérifiées. Le mode HS256 avec `RC_JWT_DEV_SECRET` est réservé à `development` et `test`.

```bash
npm run project -- serve ../mon-projet
```

Dans un processus séparé, fournissez `DATABASE_URL` avec le rôle `reactivecore_worker` et la même base, puis lancez :

```bash
npm run project -- worker ../mon-projet
```

Le serveur et le worker utilisent par défaut un canal Redis propre au projet. Les rôles sont partagés à l’échelle d’un cluster PostgreSQL. Pour des équipes qui administrent du code indépendamment, isolez les déploiements et les identifiants. Les modules chargés par le moteur sont du code de confiance.

## Intégrer un client

Les opérations `POST /api/v1/query`, `/api/v1/mutation` et `/api/v1/subscribe` acceptent `{ name, args }` et `Authorization: Bearer <token>`. Une mutation requiert `Idempotency-Key`. Un abonnement fournit des snapshots SSE et le SDK reprend implicitement la connexion. Le rattrapage du journal PostgreSQL continue lorsque Redis est indisponible.

Vous pouvez installer `@reactivecore/client` depuis le workspace ou empaqueter sa version compilée avec `npm pack -w @reactivecore/client`. La file hors ligne s’intègre avec `OfflineQueue` et `createIndexedDbStore` dans le navigateur. Définissez un périmètre stable par projet, environnement, tenant et utilisateur authentifié. Le stockage natif est adaptable via `OfflineStore`. La mise en cache de l’interface et des lectures dépend de chaque application.

## Vérifier le moteur

```bash
npm test
node --test packages/client/test/offline.test.mjs
node scripts/test-infra.mjs
node --env-file=.env.reactivecore-test scripts/test-project.mjs
```

Le dernier test génère un projet vide, lui ajoute une application de test, crée une base temporaire et vérifie les migrations, les types, la mutation, le flux SSE et le worker. Il supprime la base temporaire après l’exécution.
