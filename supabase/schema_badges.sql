-- Worthit — badges hebdomadaires du tournoi
-- À exécuter dans Supabase : Project → SQL Editor → New query, après les migrations précédentes.
--
-- La page Fonctionnalités promet « Trois badges chaque lundi » depuis le début, mais rien
-- ne les calculait. Pour calculer « Plus grosse progression », il faut garder une trace du
-- montant de la semaine précédente au moment où une nouvelle semaine démarre.

alter table profiles add column if not exists week_saved_prev numeric default 0;
