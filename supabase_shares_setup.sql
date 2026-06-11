-- ============================================================
-- Run this in Supabase SQL Editor to enable the sharing feature.
-- ============================================================

create table if not exists public.shares (
  id text primary key,
  client_id text not null,
  archetype text,
  title text,
  analysis text,
  x double precision not null,
  y double precision not null,
  grouped_points jsonb,
  party_match jsonb,
  created_at timestamptz not null default now()
);

create index if not exists shares_client_id_created_at_idx
  on public.shares (client_id, created_at desc);

-- Service role needs full access (matches existing tables in this project).
grant all on public.shares to service_role;
