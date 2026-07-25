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

> ⚠️ **`STRIPE_WEBHOOK_SECRET` est obligatoire pour que `/api/webhook` fonctionne.**
> Sans lui, impossible de vérifier qu'un événement vient réellement de Stripe : n'importe qui pourrait
> envoyer un faux « paiement réussi » et s'offrir le Premium. Le serveur refuse donc tout appel non signé.
>
> En local : `stripe listen --forward-to localhost:3000/api/webhook` affiche un secret `whsec_…` à coller
> dans `.env`. En production : crée l'endpoint dans le dashboard Stripe et récupère son secret.
> Le webhook est la source de vérité : il gère aussi la désactivation quand un abonnement est annulé.

### 2. OpenAI (le vrai cerveau de Worthy)

1. Crée une clé sur https://platform.openai.com/api-keys.
2. Colle-la dans `OPENAI_API_KEY`.
3. Relance : Worthy répond maintenant via `gpt-4o-mini` (modifiable avec `OPENAI_MODEL`), avec ton profil
   budgétaire injecté dans le prompt système.
4. Si l'API échoue (quota, réseau), le cerveau local reprend automatiquement — l'utilisateur n'est jamais bloqué.

> `/api/chat` est public (la démo doit marcher sans compte), donc il est plafonné à 15 appels IA
> par IP toutes les 5 minutes. Au-delà, le cerveau local répond : personne n'est bloqué, et la
> facture OpenAI ne peut pas s'envoler si quelqu'un décide de spammer l'endpoint.

### 3. Récap hebdomadaire par email (optionnel)

Un email chaque dimanche : « ta semaine — X € gardés, Y achats évités, série de Z jours ».
C'est le moteur de rétention (une raison de rouvrir l'app).

1. Crée un compte sur https://resend.com (gratuit, 3000 emails/mois) et une clé API → `RESEND_API_KEY`.
   - En test, tu peux envoyer depuis `onboarding@resend.dev` **vers ta propre adresse** sans rien vérifier.
   - En prod, vérifie un domaine dans Resend et mets `RESEND_FROM="Worthit <recap@tondomaine>"`.
2. Choisis un secret quelconque (ex : une longue chaîne aléatoire) → `CRON_SECRET`. Mets la **même valeur** :
   - dans `.env` / les variables Render,
   - dans les secrets GitHub : **Settings → Secrets and variables → Actions → New secret → `CRON_SECRET`**.
3. Le planificateur `.github/workflows/weekly-recap.yml` appelle l'endpoint chaque dimanche 18h UTC.
   Tu peux aussi le lancer à la main depuis l'onglet **Actions → Récap hebdomadaire → Run workflow**.

> **Sans `RESEND_API_KEY`, l'endpoint tourne en dry-run** : il calcule et renvoie qui recevrait quoi,
> sans rien envoyer. Pratique pour tout vérifier avant de brancher le vrai envoi.
> Seuls les utilisateurs actifs de la semaine (au moins 1 € économisé) reçoivent un email, et chacun
> peut se désinscrire en un clic (lien en bas de l'email, ou toggle dans ses Paramètres).

## Tests

```powershell
npm test
```

Démarre un vrai serveur, stubbe l'API OpenAI, et vérifie les routes, le refus des webhooks non
signés, l'authentification des routes privées et le plafond IA. Aucune clé nécessaire, aucun appel
réseau sortant. Les mêmes tests tournent en CI à chaque push (`.github/workflows/ci.yml`).

## Résiliation de l'abonnement

`POST /api/subscription/cancel` demande à Stripe d'arrêter le renouvellement
(`cancel_at_period_end`) : l'utilisateur garde Premium jusqu'à la fin de la période qu'il a déjà
payée, exactement ce que promettent les CGU. Le webhook `customer.subscription.deleted` retire
ensuite le Premium tout seul ; `customer.subscription.updated` couvre les fins moins propres
(impayé, litige, arrêt côté Stripe). `POST /api/subscription/resume` annule la résiliation tant
que la période n'est pas terminée.

Rien à configurer dans le dashboard Stripe : la résiliation passe par l'API, pas par le portail
client. `GET /api/subscription` renvoie l'état réel (statut, date de fin, résiliation programmée)
et n'est appelé qu'à l'ouverture de l'onglet Compte.

## Règles de sécurité (importantes)

- Les clés ne vont **que** dans `.env`, jamais dans le code, jamais côté front, jamais dans Git.
- Le front ne parle qu'à **ton** serveur ; c'est le serveur qui parle à Stripe et OpenAI.
- Les numéros de carte ne transitent jamais par ton serveur : Stripe Checkout les gère sur ses pages.
- `/api/webhook` n'accepte que les événements signés par Stripe (voir plus haut).
- **Aucun script tiers** ne s'exécute sur le site : le client Supabase est servi depuis
  `/vendor/supabase.js` (lu dans `node_modules`, version alignée sur `package.json`) et non
  depuis un CDN. Un CDN compromis pourrait sinon exécuter n'importe quel code sur une page où
  l'utilisateur est connecté.
- Chaque réponse porte `Content-Security-Policy` (dont `frame-ancestors 'none'` contre le
  clickjacking), `X-Content-Type-Options`, `Referrer-Policy` et HSTS en HTTPS.
- Toute route asynchrone passe par un emballage qui rattrape les erreurs : une requête ne peut
  plus rester sans réponse, ni faire tomber le process.
- Le lien de désinscription ouvre une **page de confirmation** (POST) : les antivirus et les
  aperçus de messagerie visitent les liens des emails et désabonnaient les gens à leur insu.

## Architecture

```
public/index.html   Le site complet (un seul fichier, fonts incluses)
public/og.png       Image de partage (réseaux sociaux) — régénérable, voir plus bas
server.js           Express : statique + /api/chat + /api/sync + /api/me
                    + /api/create-checkout-session + /api/verify-session + /api/webhook
                    + /api/subscription (état, /cancel, /resume)
/vendor/supabase.js Le client Supabase, servi par nous (aucun script tiers sur le site)
supabase/*.sql      Schéma de la base — à exécuter dans l'ordre, une seule fois chacune
extension/          L'extension navigateur (Chrome/Edge ; voir extension/SAFARI.md pour iOS)
public/sw.js        Service worker PWA (app installable, marche hors ligne)
public/manifest.webmanifest   Manifeste PWA (icônes, écran d'accueil)
test/smoke.js       Tests de fumée des routes API (`npm test`)
```

## Plateformes — ce qui marche où

| | Site / PWA | Interception à l'achat |
|---|---|---|
| **Ordinateur** (Mac, Windows, Linux) | ✅ | ✅ extension Chrome/Edge |
| **Android** | ✅ installable (écran d'accueil) | ❌ Chrome Android ne gère pas les extensions |
| **iPhone / iPad** | ✅ installable (Partager → Sur l'écran d'accueil) | ⚠️ possible dans **Safari** via un portage — voir `extension/SAFARI.md` |

**La PWA** (dashboard, budget, Worthy, récap) fonctionne partout : c'est le même site,
installable comme une app sur les deux mobiles.

**L'interception au moment de l'achat** dépend de ce que le système autorise :
- sur ordinateur, l'extension couvre tout le web ;
- sur iPhone, un portage Safari (nécessite un Mac + Xcode) couvre le shopping **dans Safari**,
  mais **jamais les applis natives** — iOS l'interdit à toute app, quel que soit le budget ;
- sur Android, il faudrait une app native avec service d'accessibilité (chantier séparé).

### Chemins d'achat interceptés

Clic sur un bouton d'achat (texte, `aria-label`, `title`, ou image seule), soumission de
formulaire de commande, et **arrivée directe sur une page panier/paiement**
(`/checkout`, `/panier`, `/cart`, `/commande`, `/kasse`, `/afrekenen`…).
Mots-clés couverts en fr/en/de/es/nl, y compris achat en 1 clic et portefeuilles
(Apple Pay, PayPal, Klarna…). Les frontières de mots évitent les faux positifs du type
« pa**rent**s » ou « trans**parent** ».

### Migrations Supabase

À exécuter dans **Project → SQL Editor → New query**, dans cet ordre (chacune est idempotente,
sans risque de la relancer par erreur) :

1. `schema.sql` — profils, objectifs, victoires
2. `schema_referrals.sql` — parrainage
3. `schema_friends.sql` — amis, tournoi hebdomadaire, semaine Premium offerte
4. `schema_streak.sql` — streak calculé côté serveur
5. `schema_badges.sql` — badges hebdomadaires du tournoi
6. `schema_email.sql` — préférence email + compteur d'achats évités de la semaine

Les comptes et les données vivent dans **Supabase** : le front s'authentifie avec l'anon key,
le serveur vérifie le jeton `Authorization: Bearer …` à chaque appel protégé, et c'est l'`id`
Supabase de l'utilisateur qui est transmis à Stripe comme `client_reference_id` — c'est lui qui
relie un paiement à un compte.

Le site utilise de **vraies URLs** (`/tarifs`, `/a-propos`…) : le serveur renvoie `index.html`
pour toute route non-API, et le routing se fait ensuite côté client (`history.pushState`).

### Régénérer l'image de partage

`public/og.png` (1200×630) et `public/apple-touch-icon.png` sont générés depuis un gabarit HTML
via Chrome headless. Si tu changes le slogan ou les couleurs, régénère-les — sinon les aperçus
de lien (WhatsApp, Slack, X, LinkedIn) resteront sur l'ancienne version.
