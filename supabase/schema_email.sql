-- Worthit — récap hebdomadaire par email
-- À exécuter dans Supabase : Project → SQL Editor → New query, après les migrations précédentes.

-- Préférence : recevoir le récap hebdo par email (activé par défaut, désinscription possible).
alter table profiles add column if not exists email_weekly boolean default true;

-- Nombre d'achats évités sur la semaine en cours (remis à zéro le lundi, comme week_saved).
alter table profiles add column if not exists week_count integer default 0;

-- Date du dernier récap envoyé (le lundi de la semaine résumée) : évite le double-envoi.
alter table profiles add column if not exists last_recap_sent date;

-- Email de l'utilisateur, dupliqué depuis auth.users : le récap le lit ici (PostgREST, fiable)
-- plutôt que via l'API admin Auth (N appels, parfois instable pendant une rotation de clés).
-- Rempli automatiquement à chaque synchronisation du profil.
alter table profiles add column if not exists email text;
