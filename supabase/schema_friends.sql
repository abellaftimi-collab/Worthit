-- Worthit — amis, tournoi hebdomadaire et semaine Premium offerte
-- À exécuter dans Supabase : Project → SQL Editor → New query, après schema.sql et schema_referrals.sql

-- Identifiant public à 8 chiffres, celui qu'on partage pour être ajouté en ami.
alter table profiles add column if not exists friend_id text unique;
create index if not exists profiles_friend_id_idx on profiles(friend_id);

-- Premium offert sans carte bancaire : tant que cette date est dans le futur, l'utilisateur est Premium.
alter table profiles add column if not exists premium_until timestamptz;
-- Chaque utilisateur ne peut recevoir la semaine offerte qu'une seule fois…
alter table profiles add column if not exists free_week_received boolean default false;
-- …et n'en distribue qu'un nombre limité (garde-fou anti-abus).
alter table profiles add column if not exists free_weeks_sent integer default 0;

-- Montant économisé sur la semaine en cours, pour le classement (remis à zéro chaque lundi).
alter table profiles add column if not exists week_saved numeric default 0;
alter table profiles add column if not exists week_start date;

create table if not exists friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',      -- 'pending' | 'accepted'
  created_at timestamptz default now(),
  unique (requester_id, addressee_id),
  constraint pas_soi_meme check (requester_id <> addressee_id)
);
create index if not exists friendships_requester_idx on friendships(requester_id);
create index if not exists friendships_addressee_idx on friendships(addressee_id);

alter table friendships enable row level security;
drop policy if exists "mes amitiés" on friendships;
create policy "mes amitiés" on friendships for all
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- Attribue un identifiant à 8 chiffres aux comptes déjà existants.
update profiles
   set friend_id = lpad((10000000 + (abs(hashtext(id::text)) % 90000000))::text, 8, '0')
 where friend_id is null;
