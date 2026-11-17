# Module 06 — Observer les stocks en direct, de PostgreSQL à Next.js

Ce module relie le [Mutation Engine](Module%2005.md) au navigateur. Après un transfert, la page **Stocks en direct** affiche les nouveaux soldes sans rechargement et sans polling côté navigateur.

## 1. Démarrer le laboratoire

Utilisez Node.js 24 ou plus récent et Docker Compose v2. Depuis la racine du dépôt, préparez le [laboratoire isolé du Module 05](Module%2005%20consolid%C3%A9.md).

```bash
npm ci
node scripts/module05-lab.mjs setup
npm run build
```

Les droits de lecture du journal et les tables de stock existent déjà dans les migrations 001 à 005 du monorepo. Aucune migration supplémentaire ni correction SQL du Module 05 n’est nécessaire pour ce dépôt.

Démarrez l’API, le worker et Next.js dans trois terminaux différents. Le port API du laboratoire est 4400 par défaut.

```bash
node scripts/module05-lab.mjs api
```

```bash
node scripts/module05-lab.mjs worker
```

```bash
source .env.module05-lab
REACTIVECORE_API_URL="http://127.0.0.1:${PORT}" npm run start -w @reactivecore/web
```

Ouvrez `http://localhost:3000/inventory`. Saisissez la valeur locale de `DEV_API_TOKEN` dans le formulaire. Le jeton reste en mémoire dans l’onglet. Une fois les deux pharmacies **En direct**, lancez un transfert d’une unité. Vérifiez que la source perd une unité et que la destination en gagne une.

## 2. Observer le protocole SSE

Le navigateur appelle une route Next.js de même origine. Elle retransmet la requête et le flux à NestJS, sans placer le jeton dans l’URL ni dans le code JavaScript généré. L’API de laboratoire reste liée à `127.0.0.1`. La route `POST /api/reactive/subscribe` utilise une requête Fetch pour envoyer le jeton en en-tête.

Pour observer directement l’API sans navigateur, exécutez depuis la racine du dépôt.

```bash
source .env.module05-lab
DEV_API_TOKEN="$DEV_API_TOKEN" PORT="$PORT" bash scripts/test-stream.sh
```

Un événement a cette forme. La séquence réelle dépend du journal local.

```text
id: 42
event: snapshot
data: {"seq":"42","data":[{"id":"…","medicineId":"…","quantity":9,"version":"2"}]}
```

Le premier événement fournit le stock complet et sa frontière de snapshot. Les suivants contiennent aussi l’état complet de la pharmacie. Arrêtez la commande avec **Ctrl+C** pour fermer l’abonnement. Le serveur envoie un commentaire de maintien de connexion toutes les quinze secondes. Quand la sortie réseau est pleine, il ne conserve que le dernier snapshot en attente.

Le guard fixe l’identité de développement côté serveur et la route vérifie que la pharmacie figure dans les droits de ce principal. PostgreSQL RLS filtre les lectures par tenant. Le corps de la requête peut choisir la pharmacie autorisée et le filtre `availableOnly`. Il ne peut pas fournir un autre tenant.

## 3. Suivre un transfert jusqu’au navigateur

1. La mutation valide les deux stocks, le reçu et les événements du journal et de l’outbox dans une seule transaction.
2. Le worker publie un signal Redis. L’index inversé du Module 04 peut déclencher plus tôt la relecture des abonnements concernés.
3. Chaque instance NestJS lit aussi les changements PostgreSQL par lots de cent séquences complètes. Elle ne coupe jamais une séquence au milieu de ses ordinaux. Un changement sans rapport avec les dépendances permet d’avancer le curseur sans réexécuter la requête.
4. Une réexécution lit l’horloge et le stock dans un seul snapshot `REPEATABLE READ READ ONLY`. Le serveur transmet le nouveau résultat s’il a changé.
5. `useReactiveQuery('inventory.list', { pharmacyId }, token)` affiche le résultat. La couche SSE utilise le handler `stocks.list` déjà enregistré dans le Query Engine.

Le transfert est envoyé par `mutate('inventory.transfer', …)`. Si le résultat HTTP est incertain, le bouton de reprise renvoie exactement la même commande avec la même clé d’idempotence. La vue des stocks est mise à jour par SSE.

## 4. Vérifier les pannes et la reconnexion

### Couper Redis

```bash
docker compose -p reactivecore-module05 --env-file .env.module05-lab stop redis
```

Avec la page ouverte, effectuez un transfert. Les deux stocks doivent changer malgré la coupure. La récupération vient de la lecture périodique du journal PostgreSQL côté NestJS. Redémarrez Redis et effectuez un nouveau transfert.

```bash
docker compose -p reactivecore-module05 --env-file .env.module05-lab up -d --wait redis
```

### Redémarrer l’API

Arrêtez la commande `node scripts/module05-lab.mjs api` sans fermer l’onglet, puis relancez-la. La page doit afficher **Reconnexion…** puis **En direct**. Le hook ouvre un nouvel abonnement, attend un snapshot complet et compare sa séquence en `BigInt` à celle déjà affichée. Un snapshot plus ancien ne remplace pas le dernier état connu. Les erreurs réseau déclenchent une reconnexion avec délai croissant et les erreurs d’accès arrêtent les tentatives.

Deux onglets ou instances peuvent rattraper leurs changements indépendamment grâce au journal. Les notifications Redis ne portent pas la responsabilité de la reprise.

## 5. Exécuter les vérifications automatisées

```bash
npm test
npm run test:e2e -w @reactivecore/api
node scripts/module05-lab.mjs test
npm run build
```

Les tests couvrent le passage d’un lot à l’autre sans perdre un ordinal, l’ignorance des changements hors dépendances, l’annulation d’un abonnement encore en cours d’ouverture et la reprise du journal sur plusieurs contextes NestJS sans livraison Redis.

### Périmètre du module

Le flux HTTP est spécialisé pour les stocks du laboratoire. La reconnexion fournit un état complet. Le serveur ne rejoue pas chaque frame SSE passée et ne conserve pas de curseur durable côté navigateur. La récupération suppose que la mutation écrit son changement dans le journal et que celui-ci est encore disponible. Une écriture SQL externe au moteur ne produit pas d’invalidation. Le guard local doit être remplacé par une authentification réelle avant un déploiement partagé.
