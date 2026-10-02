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
-- Postgres rejects to_tsvector() inside a STORED generated column as "not
-- immutable" (42P17) on many Supabase/PG versions, even with the regconfig
-- cast or an IMMUTABLE wrapper. A trigger-maintained column sidesteps the
-- immutability check entirely and works on every PG version. The column is
-- still a plain tsvector, so the GIN index and .textSearch() calls are
-- unchanged.
alter table public.memories drop column if exists search_vector;
alter table public.memories add column search_vector tsvector;

create or replace function public.set_memories_search_vector()
returns trigger
language plpgsql
as $$
begin
  new.search_vector := to_tsvector('english'::regconfig,
    coalesce(new.title, '') || ' ' ||
    coalesce(new.content, '') || ' ' ||
    coalesce(array_to_string(new.tags, ' '), ''));
  return new;
end;
$$;

drop trigger if exists trg_memories_search_vector on public.memories;
create trigger trg_memories_search_vector
  before insert or update of title, content, tags on public.memories
  for each row execute function public.set_memories_search_vector();

-- Backfill any rows created before the trigger existed (idempotent).
update public.memories
  set search_vector = to_tsvector('english'::regconfig,
    coalesce(title, '') || ' ' ||
    coalesce(content, '') || ' ' ||
    coalesce(array_to_string(tags, ' '), ''));

create index if not exists memories_search_vector_idx
  on public.memories using gin (search_vector);

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