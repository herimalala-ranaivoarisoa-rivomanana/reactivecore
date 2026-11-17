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

## 5. Lancer les tests

Exécutez les commandes suivantes depuis la racine du dépôt. Gardez PostgreSQL et Redis démarrés pour le test de bout en bout.

```bash
npm test
npm run test:e2e -w @reactivecore/api
```

Le test unitaire vérifie un comportement du contrôleur sans dépendre de l’infrastructure. Le test de bout en bout lance une instance NestJS, appelle `/api/health` et vérifie les réponses de PostgreSQL et Redis.

## 6. Comprendre les corrections

- **Imports ESM.** Les imports relatifs de l’API utilisent l’extension `.js`. TypeScript résout ces imports vers les fichiers source `.ts`, puis Node.js charge les fichiers `.js` produits par la compilation.
- **Variables d’environnement.** `nest start --env-file .env` transmet le fichier à Node.js au démarrage. L’option `--env-file` est refusée dans `NODE_OPTIONS`.
- **Test de bout en bout.** L’API expose une route de santé préfixée par `/api`. Le test vérifie cette route et le contenu de sa réponse.
- **Rendu Next.js.** La page se compile à l’avance. La section d’état attend une requête avec `connection()` et affiche un message d’attente grâce à `Suspense` pendant l’appel à l’API.
- **Polices.** La page utilise les polices système définies dans le CSS. La compilation web peut ainsi s’exécuter sans téléchargement depuis Google Fonts.

## 7. Observer une panne et rétablir le service

Gardez l’API et le serveur web démarrés. Dans un autre terminal, à la racine du dépôt, vérifiez que les deux services sont d’abord à `up`.

```bash
curl -fsS http://127.0.0.1:4000/api/health
```

### Interrompre Redis

```bash
docker compose stop redis
curl -fsS http://127.0.0.1:4000/api/health
```

La réponse doit indiquer `degraded`, avec Redis à `down` et PostgreSQL à `up`. Si vous voyez encore `healthy`, attendez quelques secondes et relancez la requête, le temps que le client détecte la coupure.

```bash
docker compose start redis
```

Le client Redis tente de se reconnecter automatiquement. Relancez la requête de santé jusqu’à retrouver `healthy` avant de passer à PostgreSQL.

### Interrompre PostgreSQL

```bash
docker compose stop postgres
curl -fsS http://127.0.0.1:4000/api/health
```

La réponse doit indiquer `degraded`, avec PostgreSQL à `down` et Redis à `up`. Un refus de connexion peut être immédiat. Si la connexion reste en attente, le pool applique un délai de cinq secondes pour l’établissement d’une connexion.

```bash
docker compose start postgres
```

Attendez le démarrage de PostgreSQL, puis relancez la requête de santé et vérifiez que l’état revient à `healthy`. L’API renvoie un statut HTTP 200 pendant ces exercices. C’est le champ JSON `status` qui indique si un service est indisponible.

## 8. Vérifier les interfaces réseau et compiler

Sous Linux, avec les applications et les conteneurs démarrés, listez les ports en écoute.

```bash
ss -ltn | grep -E ':(3000|4000|5432|6379)([[:space:]]|$)'
docker compose ps
```

Vérifiez que PostgreSQL et Redis sont publiés sur `127.0.0.1:5432` et `127.0.0.1:6379` côté hôte. Une adresse locale `0.0.0.0` ou `[::]` indiquerait une écoute sur toutes les interfaces IPv4 ou IPv6. Lisez la colonne de l’adresse locale dans `ss`. Si Docker publie les ports sans socket d’écoute visible dans `ss`, vérifiez les adresses publiées dans `docker compose ps`.

Arrêtez les serveurs de développement avec **Ctrl+C** avant de compiler afin qu’ils cessent d’écrire dans les répertoires de sortie. Depuis la racine, lancez les deux compilations.

```bash
npm run build -w @reactivecore/api
npm run build -w @reactivecore/web
```

Les deux commandes doivent réussir avant de valider le module. Pour terminer la séance, exécutez `docker compose down` pour arrêter les services en conservant leurs volumes.

## 9. Diagnostiquer les problèmes courants

| Problème | Cause probable | Vérification ou correction |
| --- | --- | --- |
| `ECONNREFUSED` sur le port 5432 | PostgreSQL est arrêté ou le port est incorrect. | Vérifiez `docker compose ps` et le port dans `DATABASE_URL`. |
| `NOAUTH Authentication required` | Le client Redis se connecte sans mot de passe. | Vérifiez que `REDIS_URL` contient le mot de passe configuré par `REDIS_PASSWORD`. |
| `ECONNREFUSED` sur le port 6379 | Redis est arrêté ou le port est incorrect. | Vérifiez `docker compose ps` et le port dans `REDIS_URL`. |
| `Nest can't resolve dependencies` | Un fournisseur manque ou son module est mal raccordé. | Vérifiez `providers`, `exports` et `imports`. |
| `DATABASE_URL is required` | La variable manque ou le fichier `.env` est absent ou ignoré au lancement. | Vérifiez `apps/api/.env` et lancez l’API avec `npm run dev:api`. |
| `EADDRINUSE` sur le port 4000 | Un autre processus utilise ce port. | Identifiez le processus avec `ss -ltnp 'sport = :4000'`. |
| Next.js affiche **Backend unavailable** | L’API est inaccessible depuis le serveur web. | Testez directement `/api/health` et vérifiez `REACTIVECORE_API_URL` si vous l’avez définie. |
| L’API démarre mais PostgreSQL est à `down` | Le pool ouvre une connexion à la première requête. | Vérifiez `/api/health` après le démarrage. Si l’application doit refuser de démarrer sans PostgreSQL, ajoutez une requête de disponibilité explicite au démarrage. |

Dans ce module, NestJS attend la première connexion à Redis avant de démarrer l’API. Dans un module ultérieur, Redis deviendra optionnel pour les opérations transactionnelles qui peuvent continuer pendant une coupure. Le point de contrôle actuel `/api/health` est un prototype. Nous distinguerons ensuite `/api/health/live`, qui indique que le processus est vivant, et `/api/health/ready`, qui vérifie que les dépendances nécessaires sont disponibles.

## 10. Suivre l’installation

Cochez chaque étape après l’avoir vérifiée sur votre machine. Les cases servent au suivi manuel.

- [ ] Monorepo npm Workspaces créé
- [ ] Backend NestJS généré
- [ ] Frontend Next.js 16.4 généré
- [ ] PostgreSQL et Redis démarrés avec Docker
- [ ] `DatabaseModule` opérationnel
- [ ] `RedisModule` opérationnel
- [ ] `HealthModule` répond correctement
- [ ] Next.js affiche l’état du backend
- [ ] Interruptions et redémarrages de PostgreSQL et Redis vérifiés
- [ ] Compilations NestJS et Next.js réussies

## Prochain module — Conception transactionnelle

Nous construirons le schéma PostgreSQL multi-tenant, les repositories NestJS et leurs transactions. Nous ajouterons les contrôles de concurrence, l’idempotence, la *transactional outbox*, le journal des mutations, les premières fonctions `query()` et `mutation()`, puis les tests de concurrence avec plusieurs clients.

Deux cas serviront de fil conducteur. Nous empêcherons deux ventes simultanées de faire passer le stock sous zéro et vérifierons qu’une mutation validée peut être transmise aux abonnés après un redémarrage du serveur.

Le Module 01 met en place le socle NestJS, Next.js, PostgreSQL et Redis qui servira à développer progressivement des fonctionnalités inspirées de Convex.
