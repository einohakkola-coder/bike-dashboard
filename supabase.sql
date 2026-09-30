-- Run once in Supabase → SQL Editor.
-- One row per user holding their saved routes, ride history and settings.
create table if not exists public.user_data (
  user_id    uuid primary key references auth.users on delete cascade default auth.uid(),
  routes     jsonb not null default '[]',
  rides      jsonb not null default '[]',
  settings   jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

-- each user can only see and change their own row
create policy "own data" on public.user_data
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
