# Module 05 consolidé — Exécuter et vérifier le Mutation Engine

Cette consolidation rend le laboratoire reproductible depuis le monorepo. Le [Module 05](Module%2005.md) explique les transactions, les versions et l’idempotence. Ce guide prépare une installation isolée et décrit les vérifications à effectuer avant le Module 06.

## 1. Démarrer sur Ubuntu

Installez Node.js 24 ou plus récent, npm et Docker avec Compose v2. Depuis la racine du dépôt, exécutez les commandes suivantes.

```bash
node --version
docker compose version
npm ci
node scripts/module05-lab.mjs setup
node scripts/module05-lab.mjs status
npm run build
```

Le script crée `.env.module05-lab` avec des mots de passe aléatoires, un jeton local et des droits de lecture réservés au propriétaire. Git ignore ce fichier. Le projet Compose `reactivecore-module05` utilise des volumes séparés, PostgreSQL sur `127.0.0.1:55432`, Redis sur `127.0.0.1:56379` et l’API sur `127.0.0.1:4400` par défaut. Si un port est occupé, modifiez le port correspondant dans ce fichier local.

Le script crée `reactivecore_lab` et `reactivecore_test`, applique les migrations 001 à 005 dans l’ordre, configure les accès du rôle applicatif et du worker, puis charge les deux seeds dans la base de démonstration. Chaque migration est enregistrée dans sa propre transaction. Relancer `setup` conserve les ventes, transferts et stocks existants. Le journal de suivi est propre à ce laboratoire. Sur la base principale, suivez les instructions de migration incrémentale du Module 05.

Après `status`, les deux conteneurs doivent être sains et les cinq migrations doivent apparaître. L’horloge commence à zéro sur une base neuve.

## 2. Vérifier un transfert par HTTP

Démarrez l’API et le worker dans deux terminaux.

```bash
node scripts/module05-lab.mjs api
```

```bash
node scripts/module05-lab.mjs worker
```

Depuis un troisième terminal Bash, préparez une commande. Le fichier local contient le jeton. Gardez-le hors de Git et des sorties partagées.

```bash
source .env.module05-lab
key=$(node -p 'require("node:crypto").randomUUID()')
body='{"name":"inventory.transfer","args":{"sourcePharmacyId":"22222222-2222-4222-8222-222222222222","destinationPharmacyId":"66666666-6666-4666-8666-666666666666","medicineId":"33333333-3333-4333-8333-333333333333","quantity":1}}'

curl -fsS "http://127.0.0.1:${PORT}/api/mutations/execute" \
  -H 'Content-Type: application/json' \
  -H "X-Dev-Token: $DEV_API_TOKEN" \
  -H "Idempotency-Key: $key" \
  --data "$body"
```

Répétez uniquement la commande `curl`. Le premier appel doit renvoyer `replayed: false`. Le second doit renvoyer `replayed: true` avec le même `transferId` et le même `commitSeq`. Un changement de quantité avec cette clé doit renvoyer HTTP 409. Après validation, effacez les variables locales ou fermez le terminal.

La clé est vérifiée par le code TypeScript sans ajouter de dépendance. Les tests d’intégration passent par le même registre, la même validation et la même autorisation que la route HTTP. Les mises à jour vérifient la version du stock dans leur condition SQL. Pour un transfert de stock, le journal et l’outbox ont deux entrées, une par solde modifié, à la même séquence de commit.

## 3. Observer le worker et une coupure Redis

Le worker réserve un événement PostgreSQL avec `SKIP LOCKED` et un bail de 30 secondes. Il libère les verrous SQL avant l’appel Redis. Après publication, il acquitte l’événement s’il possède encore le bail. Si la publication échoue, il programme une nouvelle tentative.

Gardez l’API et le worker démarrés. Définissez cette fonction depuis la racine du dépôt.

```bash
lab_compose() { docker compose -p reactivecore-module05 --env-file .env.module05-lab "$@"; }
lab_compose stop redis
```

Effectuez un transfert avec une nouvelle clé. La mutation doit réussir. Cette commande affiche les événements du commit, dont `published_at` doit rester vide pendant la coupure.

```bash
lab_compose exec -T postgres sh -c '
  psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT commit_seq, published_at, attempts FROM event_outbox ORDER BY id DESC LIMIT 6;"
'
lab_compose up -d --wait redis
```

Relancez la lecture après quelques secondes. Le worker doit acquitter les événements en attente. Une interruption après publication mais avant acquittement peut faire republier le même `eventId` à l’expiration du bail. Les abonnés utilisent le journal PostgreSQL pour rattraper les notifications Redis manquées.

## 4. Lancer les tests isolés

```bash
npm test
node scripts/module05-lab.mjs test
npm run build
```

Le script `test` fournit à Vitest les connexions du laboratoire, avec des identifiants distincts pour l’administration des fixtures, l’API et le worker.

Les fixtures créent des tenants et stocks spécifiques à chaque scénario et suppriment leurs données après le test. Pour recréer **la base de test du laboratoire** en cas de données résiduelles, arrêtez les tests actifs avant d’exécuter la commande suivante. Elle supprime et recrée `reactivecore_test` dans le conteneur Compose dédié.

```bash
node scripts/module05-lab.mjs reset-test --yes
```

| Vérification | Résultat attendu |
| --- | --- |
| Même clé et arguments normalisés | Le reçu et la séquence sont réutilisés. |
| 30 transferts concurrents, 20 unités | Au plus 20 succès, stock jamais négatif et total conservé. |
| Échec du journal | Aucun solde, reçu ou événement partiel. |
| SQLSTATE `40001` ou `40P01` | Reprise de la transaction entière avec délai borné. |
| Redis indisponible | L’événement reste dans l’outbox et peut être acquitté après reprise. |
| Interruption simulée après publication | Le bail expire, le même `eventId` est publié à nouveau et le stock reste inchangé. |

`MutationEngineService.retryMetrics()` fournit les compteurs par processus des erreurs de sérialisation, interblocages, retries lancés et tentatives épuisées. Les tests vérifient également qu’une erreur de connexion à issue inconnue ne déclenche pas de retry automatique. Si la réponse client a été perdue, gardez la même clé pour rechercher le reçu par rejeu.

Le scénario après publication injecte une erreur avant l’acquittement et avance l’expiration du bail. Il vérifie le comportement de reprise avec PostgreSQL et Redis réels. Un test de coupure brutale du processus au même point reste à ajouter.

## 5. Mesurer la charge et clore le laboratoire

Avec l’API démarrée, lancez d’abord 20 transferts à concurrence 4.

```bash
node scripts/module05-lab.mjs load
```

Pour modifier la charge, utilisez directement le script avec le nombre de requêtes et la concurrence.

```bash
node --env-file=.env.module05-lab scripts/load-mutations.mjs 100 5
```

Comparez le débit total et le débit des succès. Les percentiles p50, p95 et p99 incluent les réponses d’erreur. Vérifiez le stock total avant et après, en tenant compte des autres opérations effectuées sur la base. Un petit essai de charge valide le comportement du laboratoire. Les mesures dépendent des ressources de la machine.

### Checklist avant le Module 06

- [ ] Les deux conteneurs sont sains et les cinq migrations sont appliquées.
- [ ] Les applications compilent et les tests passent.
- [ ] Le rejeu HTTP conserve le même reçu.
- [ ] Le test concurrent conserve le stock total.
- [ ] Le worker acquitte les événements après redémarrage de Redis.
- [ ] Le débit et les latences ont été mesurés.

Pour arrêter le laboratoire, quittez l’API et le worker avec **Ctrl+C**, puis exécutez `lab_compose down` dans le terminal où la fonction est définie. Docker conserve les volumes.

Le laboratoire utilise le guard de développement et le modèle d’autorisation des modules précédents. L’authentification utilisateur, la politique de rétention des reçus et les tests de coupure brutale de PostgreSQL restent des étapes de validation avant un déploiement en production.
