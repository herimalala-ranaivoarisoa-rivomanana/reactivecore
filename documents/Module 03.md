# Module 03 — Construire le Query Engine réactif

Le [Module 02](Module%2002.md) enregistre une vente et son événement dans la même transaction. Ce module utilise cet événement pour choisir quelles requêtes de stock relire et notifier les abonnés NestJS lorsque leurs résultats changent.

## 1. Préparer le laboratoire

Utilisez la base, le seed et les comptes PostgreSQL du Module 02. Le moteur réutilise `reactivecore_app` pour les lectures et les ventes, et `reactivecore_worker` pour l’outbox. Aucune migration supplémentaire n’est nécessaire. Les tests continuent à utiliser `reactivecore_test`.

```bash
npm ci
docker compose up -d --wait
npm run build -w @reactivecore/api
node --env-file=apps/api/.env.inventory --run dev:api
```

Dans un autre terminal, démarrez le worker pour que les ventes déclenchent des invalidations.

```bash
npm run start:worker -w @reactivecore/api
```

Les routes de laboratoire partagent le même guard. Il vérifie le jeton local et fournit une identité de démonstration fixée côté serveur. Cette identité représente le tenant de démonstration. Une application réelle doit vérifier les droits de l’utilisateur sur le tenant et la pharmacie.

## 2. Déclarer et exécuter une requête

Le décorateur `@ReactiveQuery('stocks.list')` identifie une méthode de `StockQueriesService`. Le registre découvre les méthodes décorées des providers NestJS instanciés au démarrage. Les noms doivent être uniques.

Le Query Executor résout le nom et crée un contexte d’exécution avec le principal, un client PostgreSQL et un collecteur de dépendances indépendant. Le handler valide ses arguments avant de transmettre la lecture au repository. Un nom inconnu renvoie HTTP 404 et des arguments invalides renvoient HTTP 400.

```bash
read -rsp 'Jeton local : ' dev_token
printf '\n'
curl -fsS http://127.0.0.1:4000/api/reactive/query \
  -H 'Content-Type: application/json' \
  -H "X-Dev-Token: $dev_token" \
  --data '{"name":"stocks.list","args":{"pharmacyId":"22222222-2222-4222-8222-222222222222","availableOnly":true}}'
unset dev_token
```

La réponse contient `data` et `dependencies`. Le stock initial de démonstration a une quantité de dix si aucune vente n’a encore eu lieu. La version du stock reste une chaîne pour préserver la précision du `BIGINT`. La dépendance désigne la table `stocks`, le tenant et la pharmacie.

## 3. Lire un snapshot cohérent

Une requête s’exécute en `REPEATABLE READ READ ONLY`. PostgreSQL conserve le même snapshot pour les lectures successives et refuse les écritures sur les tables persistantes. Le service installe le tenant avec `set_config('app.tenant_id', ..., true)`, sur le même client que les requêtes SQL. Le contexte disparaît au commit ou au rollback.

Les transactions métier et réactives limitent la durée d’une instruction SQL à cinq secondes et l’attente d’un verrou à deux secondes. Ces paramètres s’appliquent à la transaction et ne constituent pas une limite de durée globale pour le handler. Deux exécutions indépendantes peuvent observer des snapshots différents.

## 4. Capturer les dépendances

| Dépendance | Quand invalider |
| --- | --- |
| Document | Un changement touche la ligne suivie dans le même tenant. |
| Prédicat | L’ancienne ligne ou la nouvelle correspond aux égalités suivies. |
| Table | Une ligne de la table change dans le même tenant. |

Le repository déclare une dépendance sur tous les stocks de la pharmacie, y compris si la requête ne renvoie aucune ligne. Avec `availableOnly: true`, un stock à zéro peut entrer dans le résultat après un réapprovisionnement. Suivre uniquement les lignes déjà retournées laisserait ce changement passer.

Le moteur compare le tenant et la table avant le prédicat. Il examine les deux côtés d’une mise à jour pour détecter, par exemple, une ligne qui quitte une pharmacie. Une insertion utilise l’état après modification et une suppression l’état avant. Si les champs nécessaires manquent, le moteur invalide par prudence. Le nom d’index de la dépendance décrit le prédicat suivi. L’index PostgreSQL sert à accélérer la lecture SQL.

## 5. Suivre un abonnement NestJS

`SubscriptionManagerService.subscribe()` associe un principal, un nom et des arguments à un callback. Le premier résultat porte la révision 1. Une nouvelle lecture dont le résultat est identique ne déclenche pas de notification. Les dépendances sont tout de même remplacées à chaque lecture acceptée.

```typescript
const id = await subscriptions.subscribe(
  principal,
  'stocks.list',
  { pharmacyId, availableOnly: true },
  ({ data, revision }) => console.log(revision, data),
);

// À la fermeture de l’abonnement.
subscriptions.unsubscribe(id);
```

Le gestionnaire enregistre l’abonnement avant sa première lecture. Tant qu’une lecture est en cours, une invalidation du même tenant marque sa génération comme dépassée. Elle provoque une relecture même si les anciennes dépendances ne contenaient pas encore la ligne modifiée. Le gestionnaire écarte alors le résultat intermédiaire et relit la base avant de notifier. Ce mécanisme couvre les événements reçus localement pendant une lecture.

L’abonnement réside dans la mémoire du processus. `POST /api/reactive/query` exécute une lecture ponctuelle. Les abonnements côté navigateur et les hooks React feront l’objet d’un module ultérieur.

## 6. Relier une vente à sa requête

1. La vente enregistre `stock.updated` dans l’outbox avec le tenant, l’identifiant du stock, la pharmacie et les quantités avant et après la vente.
2. Après le commit, le worker publie l’événement sur `reactivecore:invalidation`.
3. Une connexion Redis dédiée reçoit le message et vérifie son format et sa version. Les événements encore en attente du Module 02 déclenchent une invalidation conservatrice compatible.
4. Le gestionnaire sélectionne les abonnements concernés puis le Query Executor relit PostgreSQL.

Une publication Redis sert de signal de relecture. Des publications dupliquées peuvent entraîner des lectures supplémentaires. La comparaison des résultats empêche une notification supplémentaire lorsque les données sont déjà à jour. À la reconnexion Redis, le processus relit tous ses abonnements actifs pour rattraper l’état actuel. Redis Pub/Sub ne rejoue pas les messages perdus. Cette réconciliation ne fournit ni historique de changements ni frontière de synchronisation durable.

### Contrat d’idempotence des refus

À partir du Module 03, une vente refusée pour stock insuffisant enregistre aussi un reçu. Réutiliser sa clé renvoie le même HTTP 409, même après réapprovisionnement. Une nouvelle tentative métier utilise une nouvelle clé. Une erreur technique pendant la transaction continue d’annuler le reçu, la vente et l’outbox.

## 7. Vérifier le moteur

Gardez PostgreSQL et Redis démarrés et utilisez les fichiers de configuration de test du Module 02. Arrêtez les processus de développement avant de recompiler.

```bash
npm test
npm run test:e2e -w @reactivecore/api
npm run test:integration -w @reactivecore/api
npm run build
```

Pour observer uniquement la chaîne complète dans le test d’intégration, lancez la commande suivante.

```bash
npm run test:integration -w @reactivecore/api -- -t 'refreshes a registered stock query'
```

Le test enregistre deux abonnements dans des tenants distincts, vend la dernière unité dans l’un des tenants, publie son événement via le worker et vérifie que seule la liste concernée est actualisée. D’autres tests vérifient le snapshot PostgreSQL, le refus d’écrire pendant une lecture, le filtrage RLS, l’idempotence et les invalidations concurrentes.

- [ ] `stocks.list` renvoie les données et la dépendance attendues.
- [ ] Une vente validée invalide la bonne pharmacie.
- [ ] Une invalidation pendant une lecture déclenche une nouvelle lecture.
- [ ] Un autre tenant ne reçoit aucun changement de résultat.
- [ ] Les tests et les deux compilations réussissent.

## Module suivant — Synchronisation durable

Le prochain module pourra indexer les dépendances pour éviter de parcourir tous les abonnements, puis introduire un journal et un curseur alignés sur la visibilité des commits. Une séquence `BIGINT IDENTITY` de l’outbox attribue des identifiants avant le commit et ne fournit donc pas un ordre fiable de validation. Le protocole devra raccorder un snapshot à une frontière de journal et permettre la reprise après une interruption.
