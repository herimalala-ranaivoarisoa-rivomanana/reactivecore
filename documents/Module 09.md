# Module 09 — Transferts hors ligne et confirmation ACID

La démo des stocks du [Module 06](Module%2006.md) conserve les derniers stocks confirmés et enregistre les transferts dans IndexedDB. Une commande est persistée avec sa clé d’idempotence avant le premier envoi. Un service worker conserve la page et ses ressources après une première visite en ligne.

## Vérifier dans Chromium

1. Démarrez le laboratoire du Module 06 et ouvrez `/inventory` sur localhost ou en HTTPS.
2. Entrez le jeton du laboratoire et attendez **En direct** sur les deux cartes. Dans **Application → Service Workers**, vérifiez que le service worker est actif.
3. Dans **Réseau**, sélectionnez **Offline**. Transférez une unité. La page doit annoncer une commande en attente et conserver les deux derniers stocks confirmés.
4. Rechargez la page en restant hors ligne. Entrez de nouveau le même jeton. Les stocks en cache et la commande en attente doivent réapparaître.
5. Repassez en ligne. Gardez la page ouverte. Le navigateur resoumet la commande avec la même clé. Le serveur vérifie les stocks actuels. Après confirmation, la file se vide et les cartes reçoivent les stocks à jour.

## Frontière transactionnelle

PostgreSQL valide les deux soldes, le reçu d’idempotence, le journal et l’outbox dans une transaction. Si la réponse se perd après le commit, la même clé permet de retrouver le résultat. Si la source a été épuisée entre-temps, le serveur peut refuser le transfert. Le refus reste visible et la commande sort de la file de synchronisation.

Le stockage local concerne cet appareil et ce jeton de démonstration. Le jeton n’est pas conservé par la page. Les soldes affichés hors ligne sont des snapshots. La synchronisation s’exécute dans un onglet ouvert. Vider les données du site efface les commandes non envoyées. Ces garanties concernent la démo d’inventaire. Les autres applications du SDK doivent encore intégrer leur propre stockage hors ligne.

## Consulter l’état d’une commande et l’annuler

Chaque commande possède un champ `state` persistant. L’historique de la page distingue les états suivants.

| État | Signification |
| --- | --- |
| `pending` | Enregistrée localement et jamais prise en charge pour un premier envoi. Le bouton **Annuler** est disponible. |
| `cancelled` | Annulée sur cet appareil. La synchronisation l’ignore. |
| `sending` | Premier envoi ou rejeu en cours. |
| `retry` | Résultat incertain ou service indisponible. La commande conserve sa clé pour le prochain essai. |
| `confirmed` | PostgreSQL a confirmé le transfert. |
| `conflict` ou `rejected` | Le serveur a refusé la commande. Son résultat reste visible. |

Pour tester l’annulation, ajoutez une commande hors ligne puis cliquez sur **Annuler** dans l’historique. Ajoutez une deuxième commande et rechargez toujours hors ligne. Après avoir ressaisi le même jeton, les deux états doivent réapparaître. Au retour du réseau, seule la deuxième commande doit modifier les stocks.

Le SDK exporte `OfflineQueue` et le contrat `OfflineStore`. Une application fournit sa persistance et un périmètre d’identité stable, par exemple projet, environnement, tenant et utilisateur authentifié. L’adaptateur doit appliquer chaque transition dans une transaction. Dans la démo, IndexedDB tranche la course entre **Annuler** et le début de l’envoi. Si l’envoi commence en premier, une annulation locale pourrait cacher un transfert déjà validé. Une correction après confirmation doit être une nouvelle opération métier.

Une ancienne commande enregistrée avant l’ajout du champ `state` peut avoir déjà été envoyée. La migration locale la classe à réessayer avec sa clé existante. Elle ne permet son annulation que si son absence d’envoi a été enregistrée, ce qui concerne les nouvelles commandes.
