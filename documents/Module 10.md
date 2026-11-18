# Module 10 — Créer des tâches hors ligne

Tâches affiche immédiatement une ligne provisoire. Inventaire, au [Module 09](Module%2009.md), conserve les soldes confirmés pendant un transfert en attente. Les deux applications réutilisent la file du SDK et le même adaptateur de stockage IndexedDB.

## Démarrer la démo

Depuis la racine, avec Docker démarré et Node.js 24+ :

```bash
npm ci
node scripts/module05-lab.mjs setup
node scripts/module05-lab.mjs platform-setup
npm run build
```

Démarrez l’API Tâches dans un terminal, puis Next.js dans un autre :

```bash
node scripts/module05-lab.mjs platform-tasks
```

```bash
npm run start -w @reactivecore/web
```

Next.js utilise `http://127.0.0.1:4402` pour Tâches par défaut. Pour une autre adresse, définissez `REACTIVECORE_TASKS_URL` au démarrage de Next.js. Générez un jeton local temporaire depuis un terminal privé :

```bash
node --env-file=.env.module05-lab scripts/tasks-token.mjs
```

Le script affiche un jeton de développement valable 30 minutes. Ne le publiez pas. Ouvrez `http://localhost:3000/tasks` et collez-le dans le formulaire. Attendez **En direct**. Le worker est facultatif pour cet exercice. Avec `node scripts/module05-lab.mjs platform-worker-tasks`, Redis peut accélérer les mises à jour. Sinon le serveur relit son journal PostgreSQL.

## Vérifier la création hors ligne

1. Après la première visite en ligne, vérifiez dans **Application → Service Workers** que la page est contrôlée.
2. Dans Chromium, sélectionnez **F12 → Réseau → Offline**. Ajoutez une tâche et vérifiez qu’elle apparaît **En attente**.
3. Rechargez la page hors ligne et entrez le **même jeton précédemment vérifié**. La ligne et son état doivent réapparaître.
4. Repassez sur **No throttling**. La ligne doit passer à **Confirmée** et apparaître une seule fois.
5. Pour tester l’annulation, ajoutez une autre tâche hors ligne et cliquez sur **Annuler** avant de reconnecter le navigateur. La ligne doit conserver son état **Annulée** et rester absente de la liste serveur.

## Comprendre la synchronisation

Le navigateur génère l’identifiant de la tâche et une clé d’idempotence distincte. IndexedDB persiste les deux avant l’affichage. Une mutation `tasks.create` transmet le même identifiant et la même clé à chaque rejeu. PostgreSQL valide la tâche, le reçu et le journal ensemble. Un prochain snapshot SSE fusionne la ligne confirmée par son identifiant. L’API accepte encore les anciens appels avec seulement un titre.

Le serveur vérifie l’identité lors de la connexion. Le cache local est cloisonné par émetteur, audience, tenant et utilisateur. Le jeton reste en mémoire. Une empreinte du jeton déjà vérifié permet de retrouver cette identité sur le même navigateur hors ligne. Après expiration, obtenez un nouveau jeton et connectez-vous en ligne. Si l’identité est la même, sa file est reprise. Une identité différente ne vide pas la file du compte précédent et ne l’envoie pas.

La synchronisation s’exécute tant qu’un onglet est ouvert. Les commandes en état **En attente** sont annulables tant que leur premier envoi n’a pas commencé. Les soumissions au résultat incertain réutilisent leur clé. Les données stockées sur cet appareil restent accessibles à la personne qui contrôle le profil du navigateur. Les soldes, clés et règles de conservation des reçus restent du ressort du serveur.
