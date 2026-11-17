# Module 05 — Construire le Mutation Engine transactionnel

Le [Module 04](Module%2004.md) relie les snapshots des requêtes au journal PostgreSQL. Le Module 05 ajoute un moteur qui exécute une commande, la protège contre les rejeux et valide ensemble les écritures métier, le journal et l’outbox.

## 1. Préparer les bases du laboratoire

Sur des bases déjà au Module 04, appliquez uniquement `005_mutation_engine.sql`. Sur des bases neuves, appliquez les migrations 001 à 005 dans l’ordre. Conservez les rôles et les fichiers d’environnement du [Module 02](Module%2002.md).

Depuis la racine du dépôt, exécutez ces commandes une fois pour chaque base déjà préparée.

```bash
npm ci
docker compose up -d --wait

docker compose exec -T postgres sh -c '
  exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
' < db/migrations/005_mutation_engine.sql

docker compose exec -T postgres sh -c '
  exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d reactivecore_test
' < db/migrations/005_mutation_engine.sql
```

Sur la base de développement, chargez le seed du Module 02 s’il est absent, puis ajoutez la pharmacie de destination et son stock initial de trois unités. Le seed ne remet pas à zéro un stock existant. Exécutez-le avant d’ouvrir les abonnements.

```bash
docker compose exec -T postgres sh -c '
  exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
' < db/seeds/002_transfer_demo.sql
```

Le moteur réutilise la table `stocks` et l’outbox existante. Une vente et un transfert affectent donc les mêmes données et les mêmes abonnements. Les reçus du nouvel endpoint sont stockés séparément pour préserver la compatibilité des clés déjà enregistrées par `/api/inventory/sell`. La vente historique réutilise le nouvel exécuteur transactionnel et la même écriture journal–outbox.

## 2. Déclarer une mutation

`@ReactiveMutation` associe un nom, une validation et une politique d’autorisation à une méthode d’un provider NestJS. Le registre découvre ces méthodes au démarrage et refuse les noms en double. Le moteur valide et autorise la commande avant toute exécution ou lecture du reçu.

```typescript
@ReactiveMutation({
  name: 'inventory.transfer',
  validate: validateTransfer,
  authorize: authorizeTransfer,
})
async transfer(ctx: MutationContext, args: TransferArgs) {
  // Utiliser ctx.client pour chaque opération SQL.
  // Déclarer les changements avec ctx.recordChange().
}
```

L’identité est fournie par le guard du laboratoire. Le corps HTTP ne peut définir ni tenant, ni principal, ni pharmacies autorisées. La mutation contrôle l’accès aux deux pharmacies et vérifie leur appartenance au tenant via PostgreSQL RLS. Le jeton de développement protège un scénario local. Une application réelle doit obtenir ces droits à partir d’une identité vérifiée.

## 3. Suivre une transaction et son rejeu

1. PostgreSQL exécute la commande en `SERIALIZABLE` avec le rôle applicatif et le contexte tenant.
2. La clé du reçu contient le tenant, le principal, le nom de mutation et la clé d’idempotence. Le moteur calcule une empreinte des arguments normalisés, avec les clés JSON dans un ordre stable.
3. Une requête déjà validée avec les mêmes arguments renvoie les mêmes `data` et `commitSeq`, avec `replayed: true`. Une autre commande dans cette même portée renvoie HTTP 409.
4. La mutation de transfert débite le stock source et crédite le stock destination sur le même client SQL. Elle verrouille les lignes existantes dans l’ordre des pharmacies pour limiter les interblocages et crée le stock destination s’il est absent. Les mises à jour vérifient la version lue et refusent un stock négatif.
5. Le moteur exige au moins un changement déclaré pour une mutation réussie. Il attribue la séquence en fin de transaction, écrit les événements du journal et de l’outbox, puis complète le reçu. Les deux changements d’un transfert partagent une séquence et ont des ordinaux distincts.

Un transfert refusé annule son reçu. Il peut donc être retenté après correction des conditions métier. Le point d’entrée historique de vente conserve sa politique du Module 03 et mémorise le refus déterministe pour stock insuffisant.

Sur SQLSTATE `40001` ou `40P01`, le moteur recommence **la transaction entière** avec un délai exponentiel aléatoire. Il s’arrête après six tentatives et renvoie HTTP 503 si elles sont épuisées. Les timeouts locaux du Module 04 restent en vigueur. Le moteur réutilise le pool applicatif et le worker conserve son propre processus et rôle SQL.

Les handlers doivent limiter leurs effets à PostgreSQL. Le contexte fournit un client SQL et le code s’appuie sur la discipline des handlers pour déclarer toutes leurs écritures. Le contrôle de présence d’un événement ne prouve pas à lui seul qu’une entrée couvre chaque ligne modifiée.

## 4. Essayer un transfert et un conflit de version

Démarrez l’API avec le rôle applicatif.

```bash
node --env-file=apps/api/.env.inventory --run dev:api
```

Dans un autre terminal, saisissez le jeton de développement et créez une clé.

```bash
read -rsp 'Jeton local : ' dev_token
printf '\n'
key=$(node -p 'require("node:crypto").randomUUID()')

curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:4000/api/mutations/execute \
  -H 'Content-Type: application/json' \
  -H "X-Dev-Token: $dev_token" \
  -H "Idempotency-Key: $key" \
  --data '{"name":"inventory.transfer","args":{"sourcePharmacyId":"22222222-2222-4222-8222-222222222222","destinationPharmacyId":"66666666-6666-4666-8666-666666666666","medicineId":"33333333-3333-4333-8333-333333333333","quantity":1}}'
```

Relancez la commande avec la même clé. Vérifiez que `transferId` et `commitSeq` restent identiques. Changez la quantité avec cette clé pour observer HTTP 409. Avec une nouvelle clé, fournissez `expectedSourceVersion` ou `expectedDestinationVersion` sous forme de chaîne décimale. Une version obsolète provoque HTTP 409 avant les écritures. À la fin, exécutez `unset dev_token`.

## 5. Vérifier la reprise

- **Interruption avant le commit.** PostgreSQL annule les deux mises à jour, le reçu et les événements.
- **Réponse perdue après le commit.** Renvoyez les mêmes arguments avec la même clé pour retrouver le reçu. Si l’issue est inconnue, gardez cette clé tant que vous vérifiez ou rejouez la demande.
- **Redis arrêté.** La mutation reste fonctionnelle. L’outbox attend la reprise du worker et le moteur de requêtes peut converger en interrogeant directement le journal PostgreSQL.

Redis Pub/Sub accélère la notification. Une publication peut être dupliquée après une interruption du worker. Le journal reste durable et la transaction n’appelle aucun service externe.

## 6. Tester et mesurer

Exécutez les suites avec PostgreSQL et Redis démarrés, puis compilez les deux applications. La suite d’intégration utilise `reactivecore_test`.

```bash
npm test
npm run test:e2e -w @reactivecore/api
npm run test:integration -w @reactivecore/api
npm run build
```

Le script de charge effectue des transferts dans les deux sens sur les stocks de démonstration. Il écrit dans la base de l’API locale. Lancez-le sur un laboratoire isolé avec assez de stock des deux côtés, pendant que l’API est démarrée.

```bash
node --env-file=apps/api/.env.inventory scripts/load-mutations.mjs 20 4
```

Les arguments indiquent le nombre de requêtes et leur concurrence. Le script affiche les statuts, le débit total et le débit des succès, puis les latences p50, p95 et p99 en millisecondes, réponses d’erreur incluses. Un HTTP 409 peut signaler un manque de stock. Les erreurs réseau et les HTTP 503 doivent être examinés séparément. Augmentez progressivement la concurrence et observez le coût du verrou d’horloge global.

- [ ] Une opération de transfert modifie atomiquement les deux stocks.
- [ ] Un rejeu concurrent renvoie le reçu existant sans nouvelle écriture.
- [ ] Une clé utilisée pour un autre contenu et une version obsolète renvoient HTTP 409.
- [ ] Un échec du journal annule les écritures et les événements.
- [ ] Les tests, les compilations et l’essai de charge sont terminés.

Le prochain module pourra utiliser les reçus et les frontières de commit pour synchroniser les commandes clientes et traiter les conflits hors ligne.
