# Module 08 — Créer un projet ReactiveCore avec la CLI

La CLI permet à un opérateur de préparer et de lancer un projet sans ajouter ses fonctions au moteur ReactiveCore. Le projet généré fournit un exemple de liste d’éléments, une mutation de création et un client TypeScript.

## Créer le projet

Depuis la racine du moteur, avec Node.js 24 ou supérieur et PostgreSQL 16 disponible, lancez les commandes suivantes.

```bash
npm ci
npm run build
npm run project -- init ../mon-projet
```

| Fichier généré | Rôle |
| --- | --- |
| `application.mjs` | Module NestJS de confiance et fonctions exposées, chargé au démarrage. |
| `migrations/001_items.sql` | Migre le schéma métier et définit ses politiques RLS. |
| `project.json` | Définit les noms et les types des opérations du client. |
| `client.ts` | Expose `query`, `mutate` et `subscribe` avec les types du projet. |

La CLI refuse d’écraser un dossier existant. Après avoir fait évoluer les contrats dans `project.json`, relancez `npm run project -- codegen ../mon-projet`. Les déclarations du manifeste acceptent les scalaires `string`, `number`, `boolean` et `null`, les objets et les tableaux à type unique. Les handlers définissent la validation et l’autorisation côté serveur. Les types générés expriment le contrat côté client.

Pour installer le SDK dans un projet extérieur au monorepo, produisez le paquet avec `npm pack -w @reactivecore/client`, puis installez le tarball dans le projet avec npm.

## Préparer la base

Configurez `RC_PROVISION_ADMIN_URL` avec un compte d’administration PostgreSQL du cluster choisi. La commande crée `reactivecore_mon_projet`, applique les migrations du moteur puis celles du projet, et enregistre leur empreinte. Une nouvelle exécution applique les versions ajoutées. Modifier, retirer ou insérer rétroactivement une migration déjà couverte est refusé.

```bash
npm run project -- provision ../mon-projet
tenant=$(node -p 'crypto.randomUUID()')
npm run project -- tenant ../mon-projet "$tenant"
```

Pour amorcer les comptes d’un cluster neuf, fournissez en plus `RC_PROVISION_APP_PASSWORD` et `RC_PROVISION_WORKER_PASSWORD` lors du provisionnement. Ces valeurs activent les rôles applicatif et worker si leur connexion est encore désactivée. Les comptes déjà actifs conservent leurs identifiants. Pour des équipes qui administrent du code indépendamment, utilisez des clusters ou frontières d’exécution et identifiants réellement séparés. Les rôles PostgreSQL du moteur sont communs aux bases d’un même cluster dans ce modèle d’exploitation.

Le compte d’administration sert aux migrations et à la création des tenants. Le processus HTTP doit utiliser le rôle applicatif. Le processus outbox utilise le rôle worker. Les migrations du projet sont du SQL de confiance exécuté dans une transaction et ne doivent pas gérer elles-mêmes cette transaction.

## Lancer ou déployer les processus

Dans l’environnement du processus HTTP, configurez `DATABASE_URL` avec le compte `reactivecore_app` et la base du projet. Fournissez `REDIS_URL`, `RC_JWT_ISSUER` et `RC_JWKS_URL`. L’audience par défaut est `reactivecore:mon-projet`. Configurez le fournisseur d’identité comme dans le [Module 07](Module%2007.md), en utilisant l’UUID du tenant créé plus haut. Le processus écoute sur `127.0.0.1:4000` par défaut. Pour un déploiement, gérez-le avec votre superviseur et votre proxy TLS.

```bash
npm run project -- serve ../mon-projet
```

Dans un processus distinct, configurez `DATABASE_URL` avec `reactivecore_worker` et la même base, puis démarrez le worker.

```bash
npm run project -- worker ../mon-projet
```

Les deux commandes vérifient que l’URL désigne la base attendue. Par défaut, elles partagent un canal Redis propre au projet. Le mode JWT HS256 du laboratoire reste réservé à `development` et `test`.

## Vérifier le flux complet

Sur le laboratoire isolé du Module 05, exécutez le test suivant après la compilation.

```bash
node scripts/module05-lab.mjs setup
node --env-file=.env.module05-lab scripts/test-project.mjs
```

Le test génère un projet temporaire, compile son client typé, prépare sa base, vérifie qu’une migration appliquée ne peut pas être réécrite, et qu’une migration en échec est annulée. Un client Node.js ouvre ensuite un abonnement et reçoit l’élément créé par une mutation. Le test vérifie aussi l’acquittement de l’événement par le worker. Les ressources temporaires du test sont supprimées à la fin.

Cette CLI est destinée à un opérateur de confiance. Le provisionnement public, les déploiements distants via une interface d’administration et l’exécution de code fourni par des utilisateurs externes nécessitent un plan de contrôle et une isolation supplémentaires.
