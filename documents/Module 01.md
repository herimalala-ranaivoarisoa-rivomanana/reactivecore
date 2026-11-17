# Module 01 — Installer et vérifier ReactiveCore

À la fin de ce module, vous saurez lancer les services du projet, vérifier l’état de l’API et distinguer un problème de configuration d’un échec de test.

## 1. Comprendre le projet

ReactiveCore est un monorepo npm qui contient deux applications.

| Composant | Emplacement | Rôle |
| --- | --- | --- |
| Next.js | `apps/web` | Affiche la page d’accueil et l’état des services sur le port 3000. |
| NestJS | `apps/api` | Expose `GET /api/health` sur le port 4000. |
| PostgreSQL 16 | `compose.yaml` | Répond à une requête SQL de vérification. |
| Redis 7.4 | `compose.yaml` | Répond à une commande `PING` authentifiée. |

Le serveur Next.js appelle l’API NestJS. L’API interroge ensuite PostgreSQL et Redis et renvoie le résultat au serveur web.

## 2. Installer les dépendances

Ouvrez un terminal à la racine du dépôt. Il vous faut Node.js 24 ou une version plus récente, npm et Docker avec le plugin Compose.

```bash
node --version
npm --version
docker compose version
npm ci
```

`npm ci` installe les versions du fichier `package-lock.json` pour les deux applications.

## 3. Configurer les services locaux

Dans l’environnement cloud préparé, réutilisez les fichiers `.env` existants. Sur une installation neuve, créez les fichiers ci-dessous. Remplacez chaque mot de passe d’exemple par une valeur locale distincte, identique dans les deux fichiers. Vous pouvez générer une valeur compatible avec une URL en exécutant `openssl rand -hex 24` pour chaque service.

Dans `.env`, à la racine du dépôt, renseignez les variables lues par Docker Compose.

```dotenv
POSTGRES_DB=reactivecore
POSTGRES_USER=reactivecore
POSTGRES_PASSWORD=remplacer_mot_de_passe_postgres
REDIS_PASSWORD=remplacer_mot_de_passe_redis
```

Dans `apps/api/.env`, renseignez les URL que NestJS utilise pour joindre les services.

```dotenv
DATABASE_URL=postgresql://reactivecore:remplacer_mot_de_passe_postgres@127.0.0.1:5432/reactivecore
REDIS_URL=redis://:remplacer_mot_de_passe_redis@127.0.0.1:6379
```

Git ignore ces deux fichiers. Si vous changez les ports exposés par Compose, reportez-les dans les URL de l’API. PostgreSQL initialise son utilisateur et son mot de passe au premier démarrage d’un volume vide.

Démarrez les services et attendez que les deux conteneurs soient déclarés sains.

```bash
docker compose up -d --wait
docker compose ps
```

## 4. Démarrer et vérifier les applications

Dans un premier terminal à la racine du dépôt, démarrez l’API en mode surveillance.

```bash
npm run dev:api
```

Dans un second terminal, vérifiez la réponse de l’API, puis démarrez le serveur web.

```bash
curl -fsS http://127.0.0.1:4000/api/health
npm run dev:web
```

La réponse attendue contient `"status":"healthy"`, `"postgres":"up"` et `"redis":"up"`. Ouvrez ensuite `http://localhost:3000` sur la machine qui exécute le serveur. La section **Infrastructure Status** doit afficher **API: healthy**, **PostgreSQL: up** et **Redis: up**. Si la page affiche **Backend unavailable**, vérifiez d’abord que la commande `curl` atteint l’API.

## 5. Lancer les tests et la compilation

Exécutez les commandes suivantes depuis la racine du dépôt. Gardez PostgreSQL et Redis démarrés pour le test de bout en bout.

```bash
npm test
npm run test:e2e -w @reactivecore/api
npm run build
```

Le test unitaire vérifie un comportement du contrôleur sans dépendre de l’infrastructure. Le test de bout en bout lance une instance NestJS, appelle `/api/health` et vérifie les réponses de PostgreSQL et Redis. La compilation vérifie le code des deux applications et produit leurs fichiers de sortie.

## 6. Comprendre les corrections

- **Imports ESM.** Les imports relatifs de l’API utilisent l’extension `.js`. TypeScript résout ces imports vers les fichiers source `.ts`, puis Node.js charge les fichiers `.js` produits par la compilation.
- **Variables d’environnement.** `nest start --env-file .env` transmet le fichier à Node.js au démarrage. L’option `--env-file` est refusée dans `NODE_OPTIONS`.
- **Test de bout en bout.** L’API expose une route de santé préfixée par `/api`. Le test vérifie cette route et le contenu de sa réponse.
- **Rendu Next.js.** La page se compile à l’avance. La section d’état attend une requête avec `connection()` et affiche un message d’attente grâce à `Suspense` pendant l’appel à l’API.
- **Polices.** La page utilise les polices système définies dans le CSS. La compilation web peut ainsi s’exécuter sans téléchargement depuis Google Fonts.

## 7. Observer une panne et rétablir le service

Avec les deux applications démarrées, arrêtez uniquement PostgreSQL, puis interrogez de nouveau l’API.

```bash
docker compose stop postgres
curl -fsS http://127.0.0.1:4000/api/health
docker compose up -d --wait
curl -fsS http://127.0.0.1:4000/api/health
```

Pendant la panne, l’API répond avec `"status":"degraded"`, PostgreSQL à `"down"` et Redis à `"up"`. Après le redémarrage, vérifiez que l’état revient à `"healthy"`. Pour terminer la séance, arrêtez les applications avec **Ctrl+C**, puis exécutez `docker compose down` pour arrêter les services en conservant leurs volumes.
