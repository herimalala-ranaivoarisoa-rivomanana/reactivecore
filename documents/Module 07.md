# Module 07 — Deux applications sur la même API temps réel

L’API versionnée de ReactiveCore se lance avec un module applicatif et une base PostgreSQL par déploiement. Le laboratoire fournit deux modules, Inventaire et Tâches, et un client TypeScript utilisable depuis Node.js ou le navigateur.

## Exécuter le laboratoire

```bash
npm ci
npm run build
node scripts/module05-lab.mjs setup
node scripts/module05-lab.mjs platform-setup
bash scripts/test-platform.sh
```

Le dernier script démarre deux instances, vérifie l’API avec le SDK, redémarre Tâches pendant un abonnement et contrôle sa reprise, puis arrête les deux instances. Il écrit une tâche de démonstration dans la base du laboratoire. Inventaire utilise le port 4401 et la base `reactivecore_lab`. Tâches utilise le port 4402 et la base `reactivecore_tasks`. Les fonctions Tâches et leur migration se trouvent dans `apps/api/src/projects/tasks` et `db/projects/tasks`.

Pour interagir avec les deux instances, lancez `node scripts/module05-lab.mjs platform-inventory` et `node scripts/module05-lab.mjs platform-tasks` dans des terminaux distincts. Le worker du Module 05 traite l’outbox d’Inventaire. Démarrez le worker de Tâches avec `node scripts/module05-lab.mjs platform-worker-tasks`. Les deux utilisent des canaux Redis distincts. Le polling PostgreSQL reste opérationnel si les workers ou Redis sont indisponibles.

## Appeler ReactiveCore depuis une autre application

Les trois routes utilisent `POST`, un corps JSON `{ name, args }` et un en-tête `Authorization: Bearer <token>`.

| Route | Réponse |
| --- | --- |
| `/api/v1/query` | Snapshot `{ seq, data }` |
| `/api/v1/mutation` | `{ commitSeq, data, replayed }`, avec en-tête `Idempotency-Key` requis |
| `/api/v1/subscribe` | Flux SSE d’événements `snapshot`, chacun avec `{ seq, data }` |

Une application non TypeScript peut utiliser ce contrat directement. Une application TypeScript peut installer le paquet du workspace. Pour le distribuer à un autre dépôt, construisez-le puis produisez son tarball avec `npm pack -w @reactivecore/client`.

```typescript
import { ReactiveCoreClient } from '@reactivecore/client';

const client = new ReactiveCoreClient(apiOrigin, getAccessToken);
const stop = new AbortController();

const updates = (async () => {
  for await (const snapshot of client.subscribe<{ id: string; title: string }[]>(
    'tasks.list', {}, stop.signal,
  )) {
    console.log(snapshot.data);
  }
})();

const key = crypto.randomUUID();
await client.mutate('tasks.create', { title: 'Préparer la version' }, key);
// En cas de résultat incertain, réutiliser la même clé et les mêmes arguments.
stop.abort();
await updates;
```

Le SDK retente les connexions interrompues avec temporisation et rappelle le fournisseur de jeton. Un abonnement reconstruit son état à partir d’un snapshot et ignore les séquences déjà vues. Les erreurs HTTP d’autorisation sont renvoyées à l’appelant. Le SDK ne relance pas une mutation de son propre chef.

## Déployer un projet sous le contrôle de l’opérateur

- Déclarez les handlers de confiance dans un module NestJS et exposez explicitement leurs noms et politiques avec `PlatformModule.forProject()`. L’entrée d’exemple `apps/api/dist/platform-main.js` sélectionne `RC_APPLICATION=inventory` ou `tasks`.
- Configurez `DATABASE_URL`, `REDIS_URL` et `RC_INVALIDATION_CHANNEL` par déploiement. Attribuez au worker du même projet son rôle SQL et le même canal. Le laboratoire partage un serveur PostgreSQL avec deux bases. Pour des projets administrés séparément, utilisez des identifiants distincts et restreignez leurs droits de connexion, ou utilisez des instances séparées.
- Pour un fournisseur d’identité, renseignez `RC_JWT_ISSUER`, `RC_JWT_AUDIENCE` et `RC_JWKS_URL` en HTTPS. Le serveur vérifie RS256, l’émetteur, l’audience exacte et l’expiration. Configurez un identifiant UUID dans `sub`, le tenant autorisé dans `tenant_id`, et les opérations permises dans `scope` sous forme de mots séparés par des espaces. Inventaire utilise aussi la liste UUID `pharmacy_ids`. L’émetteur doit attribuer ces droits à partir de données fiables. Le mode HS256 du laboratoire exige `NODE_ENV=development` ou `test`.
- Placez l’API derrière un proxy TLS qui transmet SSE sans buffering. Configurez `RC_HOST`, `PORT` et les origines web dans `RC_CORS_ORIGINS` selon le déploiement. Les anciennes routes de démonstration ne sont pas montées dans le module de plateforme.
- Utilisez `GET /api/health/live` et `GET /api/health/ready`. La sonde de disponibilité vérifie l’accès à PostgreSQL et à l’horloge. Redis absent ne rend pas la sonde négative. Les abonnements expirent avec le jeton, avec une limite locale de huit flux par utilisateur et tenant et de 500 par processus.

La configuration reste pilotée par l’opérateur. Cette étape fournit un déploiement par projet, un SDK et un contrat d’API. Le provisionnement public, la révocation immédiate, les quotas distribués, l’isolation de code client, les restaurations par projet et les garanties de capacité nécessitent des travaux supplémentaires.
