# Worthit

Le garde-fou anti-achat-impulsif : site complet + backend Express avec abonnement Stripe et agent IA « Worthy ».

## Démarrage rapide (2 minutes, sans aucune clé)

```powershell
cd C:\Users\abell\worthit
npm install
npm start
```

Ouvre **http://localhost:3000** — le site fonctionne immédiatement :
- l'agent Worthy répond avec le **cerveau local** (règles scriptées, pas d'IA distante) ;
- le bouton « Passer Premium » active le Premium en **mode démo** (pas de paiement).

## Brancher les vraies API

Copie `.env.example` en `.env`, puis remplis les clés que tu veux activer. Redémarre le serveur après chaque modification du `.env`.

### 1. Stripe (paiement réel en mode test)

1. Crée un compte sur https://dashboard.stripe.com (gratuit).
2. Reste en **mode Test** (interrupteur en haut à droite du dashboard).
3. Copie ta clé secrète de test (`sk_test_...`) depuis https://dashboard.stripe.com/test/apikeys dans `STRIPE_SECRET_KEY`.
4. Relance le serveur : le bouton « Passer Premium » redirige maintenant vers une vraie page Stripe Checkout.
5. Paye avec la carte de test : **4242 4242 4242 4242**, n'importe quelle date future, n'importe quel CVC.
6. Au retour sur le site, ton statut Premium est activé (vérifié côté serveur via l'API Stripe).

> En production tu ajouteras un webhook (`stripe listen --forward-to localhost:3000/api/webhook` en local,
> ou un endpoint webhook dans le dashboard) et son secret dans `STRIPE_WEBHOOK_SECRET`.
> Le webhook est la source de vérité : il gère aussi la désactivation quand un abonnement est annulé.

### 2. OpenAI (le vrai cerveau de Worthy)

1. Crée une clé sur https://platform.openai.com/api-keys.
2. Colle-la dans `OPENAI_API_KEY`.
3. Relance : Worthy répond maintenant via `gpt-4o-mini` (modifiable avec `OPENAI_MODEL`), avec ton profil
   budgétaire injecté dans le prompt système.
4. Si l'API échoue (quota, réseau), le cerveau local reprend automatiquement — l'utilisateur n'est jamais bloqué.

## Règles de sécurité (importantes)

- Les clés ne vont **que** dans `.env`, jamais dans le code, jamais côté front, jamais dans Git.
- Le front ne parle qu'à **ton** serveur ; c'est le serveur qui parle à Stripe et OpenAI.
- Les numéros de carte ne transitent jamais par ton serveur : Stripe Checkout les gère sur ses pages.

## Architecture

```
public/index.html   Le site complet (un seul fichier, fonts incluses)
server.js           Express : statique + /api/chat + /api/create-checkout-session
                    + /api/verify-session + /api/me + /api/webhook
data/premium.json   Qui est Premium (créé automatiquement — remplace par une vraie BDD en prod)
```

Le front garde un identifiant client anonyme (`localStorage`) transmis à Stripe comme
`client_reference_id` : c'est lui qui relie un paiement à un navigateur. En production,
remplace-le par de vrais comptes utilisateurs.
