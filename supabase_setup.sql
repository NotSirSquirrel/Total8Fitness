-- Run once in Supabase: SQL Editor -> New query -> paste -> Run
create table if not exists public.user_data (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.user_data enable row level security;
create policy "users read and write only their own rows" on public.user_data
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- COROS linking (one row per account). RLS is enabled with NO policies, so the browser
-- can never read the token; only the coros-sync Edge Function (service role) can.
create table if not exists public.coros_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  region text not null default 'en',
  coros_email text,
  token text not null,
  last_sync_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.coros_links enable row level security;
