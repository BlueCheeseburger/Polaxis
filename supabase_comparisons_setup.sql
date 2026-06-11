-- ============================================================
-- Friends Comparison feature schema.
-- Run in Supabase SQL Editor.
-- ============================================================

-- A "comparison" is the multi-user chain that grows when friends
-- click "Compare your point" on a shared compass. The originating
-- share (primary user's result) anchors it; participants are appended
-- as new people join.
create table if not exists public.comparisons (
  id text primary key,                          -- e.g. "k7m3qp9xz2"
  primary_share_id text not null,               -- FK-ish to public.shares.id
  archetype_slug text,                          -- denormalized for URL building
  participants jsonb not null default '[]'::jsonb,
  -- participants is an array of:
  -- {
  --   role: "primary" | "friend",
  --   client_id_hash: "<sha256>",
  --   ip_hash: "<sha256>",
  --   archetype: "The Pragmatic Centrist",
  --   x: -2.3, y: 4.1,
  --   grouped_points: [...] | null,
  --   joined_at: "2026-05-08T..."
  -- }
  max_participants int not null default 6,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists comparisons_primary_share_idx
  on public.comparisons (primary_share_id);

-- Add archetype slug to shares so we can build {unique_id}-{archetype} URLs
-- without an extra join.
alter table public.shares
  add column if not exists archetype_slug text;

create index if not exists shares_archetype_slug_idx
  on public.shares (archetype_slug);

grant all on public.comparisons to service_role;
