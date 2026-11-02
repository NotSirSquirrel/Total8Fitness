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
