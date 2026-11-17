# Module 02 — Construire un moteur transactionnel PostgreSQL

Ce module prolonge le [Module 01](Module%2001.md). À la fin, vous pourrez enregistrer une vente de médicament, rejouer une demande sans vendre deux fois et vérifier qu’une panne de Redis laisse l’événement de vente disponible dans PostgreSQL.

L’exemple utilise un tenant de démonstration. Le point d’entrée HTTP est réservé au développement local. Le moteur de requêtes réactives viendra au Module 03.

## 1. Préparer le laboratoire

Depuis la racine du dépôt, installez les dépendances verrouillées et démarrez les services.

```bash
npm ci
docker compose up -d --wait
```

Le dépôt utilise les pilotes `pg` et `redis`, la validation NestJS avec `class-validator` et `class-transformer`, et Vitest pour les tests.

### Créer le schéma et les données de démonstration

Exécutez les trois migrations une seule fois sur une base du Module 01 qui ne contient pas encore les tables du Module 02. Le compte du conteneur PostgreSQL exécute les migrations. `ON_ERROR_STOP` arrête la commande dès la première erreur.

```bash
module02_psql() {
  docker compose exec -T postgres sh -c '
    exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${1:-$POSTGRES_DB}"
  ' sh "$@"
}

module02_migrate() {
  for migration in db/migrations/*.sql; do
    module02_psql "$@" < "$migration" || return 1
  done
}

module02_migrate && module02_psql < db/seeds/001_demo.sql
```

Vérifiez que chaque migration affiche `COMMIT` avant d’appliquer le seed. Le seed crée une pharmacie, un médicament et dix unités de stock. Le relancer conserve les ventes et le stock restant.

### Activer les comptes locaux

Ouvrez une session PostgreSQL interactive avec le compte du conteneur.

```bash
docker compose exec postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Dans `psql`, choisissez deux mots de passe distincts. Pour ce laboratoire, une valeur produite par `openssl rand -hex 24` peut être utilisée directement dans une URL de connexion.

```sql
\password reactivecore_app
\password reactivecore_worker
ALTER ROLE reactivecore_app LOGIN;
ALTER ROLE reactivecore_worker LOGIN;
\q
```

| Processus | Compte SQL | Accès |
| --- | --- | --- |
| Migrations et seed | Administrateur du conteneur | Création du schéma et chargement du jeu de données. |
| API | `reactivecore_app` | Lecture et écritures métier autorisées, avec filtrage par tenant. |
| Worker | `reactivecore_worker` | Lecture des événements de tous les tenants et mise à jour de leur état de publication. |

Créez `apps/api/.env.inventory` pour l’API du Module 02. Remplacez les valeurs d’exemple, adaptez le nom de la base et les ports si besoin, et reprenez votre URL Redis du Module 01. Générez un jeton local distinct avec `openssl rand -hex 24`.

```dotenv
NODE_ENV=development
DEV_API_TOKEN=remplacer_jeton_local
DATABASE_URL=postgresql://reactivecore_app:remplacer_mot_de_passe_app@127.0.0.1:5432/reactivecore
REDIS_URL=redis://:remplacer_mot_de_passe_redis@127.0.0.1:6379
```

Dans `apps/api/.env.worker`, configurez séparément les identifiants du worker.

```dotenv
DATABASE_URL=postgresql://reactivecore_worker:remplacer_mot_de_passe_worker@127.0.0.1:5432/reactivecore
REDIS_URL=redis://:remplacer_mot_de_passe_redis@127.0.0.1:6379
```

Git ignore ces fichiers. Gardez le jeton et les mots de passe dans votre environnement local.

## 2. Comprendre l’isolation multi-tenant

Les organisations partagent les mêmes tables. Les pharmacies, médicaments, stocks, ventes, reçus et événements sont liés à un tenant. Les clés étrangères composites empêchent, par exemple, l’association d’un stock du tenant A à un médicament du tenant B. La contrainte `CHECK (quantity >= 0)` protège l’intégrité du stock.

La *Row-Level Security* (RLS) limite les lignes visibles et modifiables par le rôle applicatif. `DatabaseService.tenantTransaction()` vérifie le rôle SQL et exécute `set_config('app.tenant_id', ..., true)` sur la connexion de la transaction. Le contexte disparaît à la fin du commit ou du rollback. Toutes les requêtes de la transaction passent par ce même client PostgreSQL.

Le tenant de démonstration est fixé côté serveur. `POST /api/inventory/sell` exige `NODE_ENV=development` et vérifie `X-Dev-Token`. NestJS valide le corps et refuse les champs supplémentaires, y compris `tenantId`. Une application multi-tenant réelle doit obtenir le tenant et les droits sur la pharmacie à partir d’une identité authentifiée. Le paramètre de session PostgreSQL applique ce contexte après autorisation.

## 3. Suivre une vente

1. Le service calcule l’empreinte de la commande et réserve `(tenant_id, idempotency_key)` avec `INSERT … ON CONFLICT DO NOTHING`.
2. Si la clé correspond à une commande déjà validée, le service renvoie son reçu. Une autre quantité ou une autre référence avec cette clé renvoie HTTP 409.
3. Le dépôt décrémente le stock avec un seul `UPDATE … WHERE quantity >= $4 RETURNING …`. Si deux transactions disputent la dernière unité, PostgreSQL verrouille la ligne et réévalue la condition après la première vente.
4. La vente, le reçu et l’événement `stock.updated` sont enregistrés sur la même connexion et deviennent visibles au même commit.
5. Si le stock est insuffisant ou si une écriture échoue, PostgreSQL annule toutes les écritures de la transaction.

Le reçu conserve le même `saleId` lors d’un rejeu. Au stade du Module 02, une tentative refusée pour stock insuffisant est annulée avec son reçu. Le [Module 03](Module%2003.md) fait évoluer ce comportement en mémorisant ce refus sous la même clé. La version du stock est une chaîne JSON pour préserver la précision du `BIGINT` PostgreSQL.

### Essayer la route

Depuis la racine, compilez d’abord l’API pour préparer le worker, puis démarrez l’API avec la configuration du Module 02.

```bash
npm run build -w @reactivecore/api
node --env-file=apps/api/.env.inventory --run dev:api
```

Dans un second terminal, saisissez le jeton sans l’afficher, puis générez une clé pour cette commande.

```bash
read -rsp 'Jeton local : ' dev_token
printf '\n'
key=$(node -p 'require("node:crypto").randomUUID()')

curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:4000/api/inventory/sell \
  -H 'Content-Type: application/json' \
  -H "X-Dev-Token: $dev_token" \
  -H "Idempotency-Key: $key" \
  --data '{"pharmacyId":"22222222-2222-4222-8222-222222222222","medicineId":"33333333-3333-4333-8333-333333333333","quantity":1}'
```

Relancez uniquement la commande `curl` avec la même clé. Vous devez retrouver la même vente. Changez ensuite la quantité sans changer la clé pour observer HTTP 409. Générez une nouvelle clé pour une nouvelle vente, puis effacez le jeton de la session avec `unset dev_token`.

## 4. Publier et reprendre les événements

Le worker tourne dans un processus NestJS distinct. Il réserve une ligne disponible avec `FOR UPDATE SKIP LOCKED`, puis enregistre un jeton et un bail de trente secondes. Il publie sur `reactivecore:invalidation` après la fin de cette requête PostgreSQL. Il marque enfin l’événement comme publié si son jeton détient encore le bail. Une erreur de publication déclenche une nouvelle tentative avec un délai croissant plafonné. Après un arrêt brutal, un autre worker peut reprendre la ligne à l’expiration du bail.

```bash
npm run start:worker -w @reactivecore/api
```

Pour observer la publication, ouvrez un autre terminal puis abonnez-vous avant de lancer une nouvelle vente.

```bash
docker compose exec redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SUBSCRIBE reactivecore:invalidation'
```

Essayez ensuite une vente pendant une coupure de Redis. Vérifiez que `/api/health` indique `degraded` et que la vente reste acceptée si le stock suffit. Depuis le terminal où `module02_psql` est défini, vérifiez que l’événement est en attente.

```bash
docker compose stop redis
# Envoyez une vente avec une nouvelle clé, puis vérifiez l’outbox.
printf '%s\n' 'SELECT event_id, attempts FROM event_outbox WHERE published_at IS NULL ORDER BY id;' | module02_psql
docker compose up -d --wait redis
```

Après le redémarrage, le worker reprendra les événements en attente. Consultez `published_at` pour confirmer leur acquittement PostgreSQL. Redis Pub/Sub transmet les messages aux abonnés connectés au moment de la publication. Un abonné reconnecté doit relire l’état PostgreSQL. Une interruption après publication mais avant acquittement peut produire un doublon. Les consommateurs doivent utiliser `eventId` pour le reconnaître. L’identifiant de ligne de l’outbox ne fournit aucun ordre global des commits.

## 5. Vérifier les garanties

Créez une base de test dédiée depuis le terminal contenant la fonction `module02_psql`. Les rôles SQL existent déjà dans le cluster local. Appliquez les migrations pour créer les tables, privilèges et politiques dans cette base. Les tests créent et nettoient leurs propres données.

```bash
printf '%s\n' 'CREATE DATABASE reactivecore_test;' | module02_psql postgres &&
  module02_migrate reactivecore_test
```

Configurez `apps/api/.env.integration` avec les URL de la base `reactivecore_test`. Remplacez les paramètres d’exemple. Utilisez une instance Redis réservée au laboratoire.

```dotenv
TEST_DATABASE_ADMIN_URL=postgresql://reactivecore:remplacer_mot_de_passe_admin@127.0.0.1:5432/reactivecore_test
TEST_DATABASE_APP_URL=postgresql://reactivecore_app:remplacer_mot_de_passe_app@127.0.0.1:5432/reactivecore_test
TEST_DATABASE_WORKER_URL=postgresql://reactivecore_worker:remplacer_mot_de_passe_worker@127.0.0.1:5432/reactivecore_test
TEST_REDIS_URL=redis://:remplacer_mot_de_passe_redis@127.0.0.1:6379
```

Depuis la racine, exécutez les suites et la compilation. Arrêtez l’API et le worker avant de recompiler et gardez PostgreSQL et Redis démarrés.

```bash
npm test
npm run test:e2e -w @reactivecore/api
npm run test:integration -w @reactivecore/api
npm run build
```

La suite d’intégration vérifie les ventes concurrentes sur la dernière unité, les rejeux simultanés, le conflit de clé, l’annulation complète sur échec de l’outbox, l’isolation RLS ainsi que la reprise d’un événement après un échec de publication ou l’expiration d’un bail.

### Checklist

- [ ] Les migrations et le seed sont appliqués.
- [ ] L’API et le worker utilisent leurs rôles SQL dédiés.
- [ ] Une vente réduit le stock et écrit un reçu et un événement.
- [ ] Un rejeu conserve le même reçu et un changement de paramètres renvoie HTTP 409.
- [ ] La vente fonctionne pendant une panne Redis et l’événement est publié après reprise.
- [ ] Les tests et les deux compilations réussissent.

Le Module 03 utilisera ce socle pour le moteur de requêtes réactives. Il suivra les lectures affectées par chaque mutation et déclenchera leur réexécution à partir d’un état PostgreSQL cohérent.
