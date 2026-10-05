-- EchoMind: Memories table + Row Level Security
-- Run this in your Supabase dashboard: SQL Editor -> New query.
-- Requires the anon key (already in backend/.env) + a logged-in auth user.

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

create index if not exists memories_user_idx on public.memories (user_id);
create index if not exists memories_user_type_idx on public.memories (user_id, type);

-- Voice/document detail columns (idempotent)
alter table public.memories add column if not exists duration integer;
alter table public.memories add column if not exists mime_type text;

-- Fingerprint of the exact text the AI metadata was last derived from. When an
-- edit leaves that text unchanged, the pipeline reuses the stored summary
-- instead of spending another model call. Cleared by resetDerived() so an
-- explicit "process again" always redoes the work. Contains no user text: it is
-- a SHA-256 of it, so it cannot be read back to recover the note.
alter table public.memories add column if not exists analysis_hash text;

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