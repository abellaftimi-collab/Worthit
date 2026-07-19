-- Worthit — schéma Supabase
-- À exécuter dans l'éditeur SQL de Supabase (Project → SQL Editor → New query)

-- Profils utilisateurs (liés à auth.users, géré par Supabase Auth)
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nom text,
  status text,
  fonction text,
  income numeric default 0,
  rent numeric default 0,
  charges numeric default 0,
  weaknesses text[] default '{}',
  impulse_freq text,
  is_premium boolean default false,
  stripe_customer_id text,
  stripe_subscription_id text,
  streak integer default 0,
  saved_total numeric default 0,
  sous integer default 0,
  block_keywords text[] default '{}',
  price_limit numeric default 0,
  lang text default 'fr',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Objectifs d'épargne (un utilisateur peut en avoir plusieurs)
create table if not exists goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  name text not null,
  target numeric not null,
  current numeric default 0,
  created_at timestamptz default now()
);

-- Victoires enregistrées (achats évités)
create table if not exists victories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  item text not null,
  price numeric not null,
  goal_name text,
  created_at timestamptz default now()
);

-- Row Level Security : chaque utilisateur ne voit/modifie que ses propres données
alter table profiles enable row level security;
alter table goals enable row level security;
alter table victories enable row level security;

create policy "own profile" on profiles for all using (auth.uid() = id);
create policy "own goals" on goals for all using (auth.uid() = user_id);
create policy "own victories" on victories for all using (auth.uid() = user_id);
