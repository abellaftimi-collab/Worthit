-- Worthit — streak calculé côté serveur
-- À exécuter dans Supabase : Project → SQL Editor → New query, après les migrations précédentes.
--
-- Avant cette migration, le streak était fixé à 1 à l'inscription et n'augmentait jamais :
-- aucun mécanisme ne le faisait progresser jour après jour. Il est désormais recalculé par le
-- serveur à chaque synchronisation, à partir de la dernière date d'activité connue.

alter table profiles add column if not exists last_active_date date;
