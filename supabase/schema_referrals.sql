-- Worthit — ajout du système de parrainage
-- À exécuter dans l'éditeur SQL de Supabase (Project → SQL Editor → New query), après schema.sql

alter table profiles add column if not exists referral_code text unique;
alter table profiles add column if not exists referred_by text;
alter table profiles add column if not exists referral_reward_given boolean default false;
alter table profiles add column if not exists pending_referral_days integer default 0;
create index if not exists profiles_referral_code_idx on profiles(referral_code);
