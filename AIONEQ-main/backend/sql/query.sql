-- EchoMind: AI Query module migration
-- Idempotent. Run this in your Supabase dashboard (SQL Editor -> New query).
-- Safe even if memories.sql already ran.

-- ---- memories (idempotent guard; identical to memories.sql) ----
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('voice', 'journal', 'email', 'document', 'story')),
  title text not null,
  content text not null default '',
  file_url text,
  tags text[] not null default '{}',
  event_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---- search vector for keyword retrieval (MVP: swap for embeddings later) ----
-- Note: the text search config must be cast to regconfig explicitly; without
-- the cast, recent Postgres versions reject the generated expression as not
-- immutable (42P17).
alter table public.memories add column if not exists search_vector tsvector
  generated always as (
    to_tsvector('english'::regconfig,
      coalesce(title, '') || ' ' ||
      coalesce(content, '') || ' ' ||
      coalesce(array_to_string(tags, ' '), '')
    )
  ) stored;

create index if not exists memories_search_vector_idx
  on public.memories using gin (search_vector);

-- ---- voice/document detail columns (idempotent) ----
alter table public.memories add column if not exists duration integer;
alter table public.memories add column if not exists mime_type text;

-- ---- RLS on memories (idempotent re-run of memories.sql policies) ----
alter table public.memories enable row level security;

drop policy if exists "memories_select_own" on public.memories;
create policy "memories_select_own" on public.memories
  for select using (auth.uid() = user_id);

drop policy if exists "memories_insert_own" on public.memories;
create policy "memories_insert_own" on public.memories
  for insert with check (auth.uid() = user_id);

drop policy if exists "memories_update_own" on public.memories;
create policy "memories_update_own" on public.memories
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "memories_delete_own" on public.memories;
create policy "memories_delete_own" on public.memories
  for delete using (auth.uid() = user_id);

-- ---- conversations ----
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'New conversation',
  messages jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_user_idx
  on public.conversations (user_id);

alter table public.conversations enable row level security;

drop policy if exists "conversations_select_own" on public.conversations;
create policy "conversations_select_own" on public.conversations
  for select using (auth.uid() = user_id);

drop policy if exists "conversations_insert_own" on public.conversations;
create policy "conversations_insert_own" on public.conversations
  for insert with check (auth.uid() = user_id);

drop policy if exists "conversations_update_own" on public.conversations;
create policy "conversations_update_own" on public.conversations
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "conversations_delete_own" on public.conversations;
create policy "conversations_delete_own" on public.conversations
  for delete using (auth.uid() = user_id);