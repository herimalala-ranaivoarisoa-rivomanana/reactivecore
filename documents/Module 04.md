# Module 04 — Indexer les dépendances et reprendre les invalidations

Le [Module 03](Module%2003.md) introduit les requêtes réactives et les notifications Redis. Ce module ajoute un journal PostgreSQL qui permet aux instances NestJS de rattraper un changement même si sa notification Redis n’arrive jamais.

## 1. Appliquer la migration

Sur une installation du Module 03, appliquez uniquement `db/migrations/004_commit_log.sql` aux bases de développement et de test. Sur une base neuve, appliquez les migrations 001 à 004 dans l’ordre. La migration 003 du dépôt crée déjà les rôles du Module 02.

Depuis la racine du dépôt, avec PostgreSQL démarré et la base `reactivecore_test` créée selon le Module 02, exécutez ces commandes une fois.

```bash
docker compose up -d --wait

docker compose exec -T postgres sh -c '
  exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
' < db/migrations/004_commit_log.sql

docker compose exec -T postgres sh -c '
  exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d reactivecore_test
' < db/migrations/004_commit_log.sql
```

La migration est transactionnelle. Vérifiez que chaque commande affiche `COMMIT`. Le rôle d’administration du conteneur doit appliquer cette migration. L’API conserve le rôle `reactivecore_app`, et le worker conserve `reactivecore_worker`. Aucun nouveau secret n’est nécessaire.

## 2. Donner un ordre aux commits

Un identifiant attribué par `IDENTITY` peut être réservé par une transaction qui se valide après une transaction avec un identifiant plus grand. Un consommateur qui avance son curseur en suivant ces identifiants peut donc ignorer une entrée validée plus tard.

ReactiveCore utilise une ligne dans `reactive_commit_clock`. Après les écritures métier, la transaction appelle `reactive_append_changes`. La fonction incrémente l’horloge, écrit le lot dans `reactive_change_log` et conserve le verrou PostgreSQL jusqu’à la fin de la transaction.

- Une transaction suivante doit attendre que la précédente se valide ou s’annule.
- Un rollback annule le changement métier, le reçu, l’outbox, le journal et l’incrément de l’horloge.
- Un lot partage une séquence `seq`. `ordinal` ordonne ses événements. La position `(seq, ordinal)` identifie une entrée dans le journal.
- Les ventes refusées avec un reçu actif et les rejeux idempotents ne créent aucun changement de stock. Ils n’avancent pas l’horloge.

L’heure `recorded_at` correspond à l’écriture de la ligne. Elle ne sert pas de frontière. La séquence est un `BIGINT` PostgreSQL, transmis en chaîne décimale et comparé avec `BigInt` côté serveur.

La fonction SQL est détenue par l’administrateur et dispose d’un `search_path` contrôlé. Elle utilise le tenant de la transaction, puis écrit le lot et l’horloge ensemble. Le rôle applicatif n’a aucun droit d’écriture directe sur ces tables. Ses lectures du journal sont soumises à RLS. Le worker garde uniquement ses droits sur l’outbox. La ligne d’horloge est globale, ce qui simplifie la preuve d’ordre au prix d’un point de contention.

## 3. Sélectionner les abonnements concernés

L’index inversé associe un couple tenant–table aux abonnements qui lisent cette partie des données. Lors d’une invalidation, le moteur ne vérifie que les dépendances des abonnements de ce groupe. Il remplace les entrées d’un abonnement après une nouvelle lecture et les retire à la désinscription.

| Dépendance | Exemple |
| --- | --- |
| Document | Un identifiant précis dans `stocks`. |
| Égalité | `pharmacy_id = pharmaA`. Les valeurs peuvent être des chaînes, nombres, booléens ou `null`. |
| Intervalle numérique | `quantity > 0` ou `quantity <= 10`. |
| Table | Toute modification de `stocks` dans le tenant. |

Une mise à jour peut entrer dans un filtre ou en sortir. Le moteur compare l’état avant et l’état après. Une insertion n’a qu’un état après, une suppression qu’un état avant. Un état `null` désigne une ligne absente. Avec des champs inconnus, le moteur conserve le candidat sauf si une condition connue suffit à exclure la ligne.

`stocks.list` enregistre le prédicat de la pharmacie même quand la liste est vide. Avec `availableOnly: true`, il ajoute `quantity > 0`. Une future insertion dans cet intervalle pourra donc invalider la requête.

## 4. Raccorder le snapshot au journal

Le Query Executor lit la valeur visible de l’horloge et les données métier dans la même transaction PostgreSQL `REPEATABLE READ READ ONLY`. Une réponse de `POST /api/reactive/query` inclut ainsi `data`, `dependencies` et `snapshotSeq`.

L’installation d’un abonnement vérifie le journal après la première lecture. Si un changement du tenant est intervenu, le moteur relit les données. Les réexécutions sont sérialisées par abonnement et bornées à deux lectures par rafraîchissement. S’il y a encore une invalidation en attente, le gestionnaire programme la suite. Une notification porte toujours la séquence de **son propre snapshot**. Elle n’affirme pas représenter le dernier commit disponible.

Le lecteur du journal accepte une plage `afterSeq < seq <= throughSeq` et renvoie les événements du tenant dans l’ordre `(seq, ordinal)`. Toutes les entrées d’un même lot restent dans la même plage. En arrière-plan, le gestionnaire lit l’horloge puis vérifie, pour chaque abonnement actif, s’il existe un changement du tenant après sa position couverte. Ce contrôle a lieu environ toutes les secondes. Un changement déclenche une nouvelle lecture conservatrice. Une plage sans changement du tenant peut être marquée comme couverte.

La révision visible augmente lorsque le contenu du résultat change. Un rejeu ou une réconciliation qui retrouve le même contenu peut avancer la position couverte sans émettre une nouvelle notification.

## 5. Faire l’expérience d’une panne

Lancez l’API et le worker comme au [Module 03](Module%2003.md), avec la configuration de laboratoire du Module 02. Une vente écrit un événement d’outbox et une ligne du journal avec le même identifiant. Redis accélère l’invalidation par prédicat. Le polling PostgreSQL permet la reprise même si le worker est arrêté ou si Redis est inaccessible.

Pour reproduire l’expérience avec un abonnement actif côté NestJS, utilisez le test d’intégration suivant. Il démarre deux contextes NestJS indépendants, désactive la livraison Redis, effectue une vente, puis vérifie que les deux contextes convergent. Il ferme et recrée ensuite un contexte pour vérifier le nouveau snapshot.

```bash
npm run test:integration -w @reactivecore/api -- -t 'recovers journal changes on two instances'
```

Vous pouvez aussi arrêter Redis dans le laboratoire, effectuer une vente avec une nouvelle clé via la commande du Module 02, puis vérifier qu’un abonnement serveur actif voit le nouveau stock. Redémarrez Redis à la fin de l’exercice.

```bash
docker compose stop redis
# Envoyez la vente et observez le callback de l’abonnement NestJS.
docker compose up -d --wait redis
```

Après un redémarrage NestJS, le consommateur doit recréer son abonnement. Le nouveau contexte relit PostgreSQL et repart d’un snapshot cohérent.

## 6. Valider le module

Avec PostgreSQL et Redis démarrés, et les migrations appliquées sur `reactivecore_test`, exécutez les tests sur la configuration dédiée du Module 02.

```bash
npm test
npm run test:e2e -w @reactivecore/api
npm run test:integration -w @reactivecore/api
npm run build
```

Les tests vérifient l’ordre obtenu avec deux transactions concurrentes, les ordinaux d’un lot, le rollback complet si le journal échoue, la stabilité du snapshot, le filtrage RLS, les intervalles et la reprise par polling. Le flux Redis du Module 03 reste couvert par un test d’intégration.

### Périmètre de la garantie

La reprise concerne les mutations ReactiveCore qui écrivent dans le journal. Une modification SQL externe qui contourne le moteur ne déclenche pas ce protocole. Un abonnement peut converger directement vers un snapshot récent sans notifier chaque état intermédiaire. Les abonnements restent en mémoire. Le module ne conserve pas de curseur de navigateur entre deux connexions et n’effectue aucune purge automatique du journal. Une future politique de rétention doit imposer un nouveau snapshot si le curseur demandé est antérieur à la plage conservée.

Le Module 05 pourra s’appuyer sur ce journal pour enrichir le moteur de mutations, ses résultats et ses garanties de rejeu.
