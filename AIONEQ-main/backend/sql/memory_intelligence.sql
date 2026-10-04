-- EchoMind: memory intelligence migration
-- Idempotent. Run in the Supabase dashboard (SQL Editor -> New query) AFTER
-- memories.sql and query.sql. Safe to run at any time and any number of times.
--
-- What this adds:
--   1. memories: processing status / transcript / extracted text / topics
--   2. memory_vectors: per-memory semantic vectors + a similarity search RPC
--   3. memory_links: duplicate / follow-up / supersedes PROPOSALS (user approved)
--   4. memory_settings: per-user AI-memory and conversation-memory controls
--   5. a widened search_vector trigger so transcripts, extracted document text
--      and AI topics are keyword-searchable too
--
-- Design constraints:
--   - Plain Postgres + jsonb vectors. No pgvector extension required, so this
--     runs on any Supabase project. (pgvector is used automatically if present -
--     see the optional block at the bottom.)
--   - The original user content is never rewritten. Everything derived lives in
--     its own column/table next to it.
--   - Every table is RLS-scoped to auth.uid(); the similarity RPC runs as the
--     invoker so RLS still applies to it.

-- ============================================================ memories ======

alter table public.memories add column if not exists transcript text;
alter table public.memories add column if not exists extracted_text text;
alter table public.memories add column if not exists topics text[];
alter table public.memories add column if not exists source_kind text;

alter table public.memories add column if not exists processing_status text;
alter table public.memories add column if not exists processing_stage text;
alter table public.memories add column if not exists processing_error text;
alter table public.memories add column if not exists processed_at timestamptz;

-- Backfill: rows that existed before this migration were fully usable already.
update public.memories
   set processing_status = 'ready',
       processed_at = coalesce(processed_at, updated_at, created_at)
 where processing_status is null;

alter table public.memories alter column processing_status set default 'ready';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'memories_processing_status_check'
  ) then
    alter table public.memories
      add constraint memories_processing_status_check
      check (processing_status in ('pending', 'processing', 'ready', 'partial', 'failed'));
  end if;
end $$;

-- Paging + status filters on the dashboard listing.
create index if not exists memories_user_created_idx
  on public.memories (user_id, created_at desc);
create index if not exists memories_user_status_idx
  on public.memories (user_id, processing_status);
create index if not exists memories_user_event_date_idx
  on public.memories (user_id, event_date desc nulls last);

-- ============================================================ vectors ======

create table if not exists public.memory_vectors (
  memory_id uuid primary key references public.memories (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  embedding jsonb not null,
  dim integer not null,
  model text not null default 'local-hash-v1',
  updated_at timestamptz not null default now()
);

create index if not exists memory_vectors_user_idx on public.memory_vectors (user_id);

alter table public.memory_vectors enable row level security;

drop policy if exists "memory_vectors_select_own" on public.memory_vectors;
create policy "memory_vectors_select_own" on public.memory_vectors
  for select using (auth.uid() = user_id);

-- Insert/update/delete go through the backend with the caller's JWT, so the
-- same owner policy covers them (no service-role writes anywhere).
drop policy if exists "memory_vectors_insert_own" on public.memory_vectors;
create policy "memory_vectors_insert_own" on public.memory_vectors
  for insert with check (auth.uid() = user_id);

drop policy if exists "memory_vectors_update_own" on public.memory_vectors;
create policy "memory_vectors_update_own" on public.memory_vectors
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "memory_vectors_delete_own" on public.memory_vectors;
create policy "memory_vectors_delete_own" on public.memory_vectors
  for delete using (auth.uid() = user_id);

-- Cosine similarity of two equal-length numeric JSON arrays. Returns 0 for any
-- mismatch so a changed embedding dimension can never produce a bogus match.
create or replace function public.cosine_similarity(a jsonb, b jsonb)
returns real
language plpgsql
immutable
as $$
declare
  n integer := coalesce(jsonb_array_length(a), 0);
  dot double precision := 0;
  na double precision := 0;
  nb double precision := 0;
  x double precision;
  y double precision;
  i integer;
begin
  if n = 0 or n <> coalesce(jsonb_array_length(b), -1) then
    return 0;
  end if;
  for i in 0..n - 1 loop
    x := (a ->> i)::double precision;
    y := (b ->> i)::double precision;
    dot := dot + x * y;
    na := na + x * x;
    nb := nb + y * y;
  end loop;
  if na = 0 or nb = 0 then
    return 0;
  end if;
  return (dot / sqrt(na * nb))::real;
end;
$$;

-- Semantic search over ONE user's vectors. security invoker (the default) means
-- the memory_vectors RLS policies above are enforced for this call too, so a
-- caller physically cannot receive another user's rows.
--
-- p_model is the caller's canonical embedding-space identity, e.g.
-- 'local-hash-v1@384' or 'nomic-embed-text-v1.5@768'. Filtering on it is what
-- makes changing the embedding model SAFE:
--
--   Same dimension, different model -> the old rows would still pass a `dim`
--   check and be scored against the new query vector in an unrelated space,
--   producing confident non-zero similarities for unrelated memories. Filtering
--   on the identity instead returns nothing, so retrieval falls back to keyword
--   search until the archive has been reindexed.
--
--   Different dimension -> both filters exclude the old rows, same safe outcome.
--
-- A NULL p_model disables only the identity filter and is kept for operators who
-- call this function by hand from the SQL editor. The backend never sends NULL.
create or replace function public.match_memory_vectors(
  p_query jsonb,
  p_user_id uuid,
  p_min_similarity real default 0.05,
  p_limit integer default 12,
  p_model text default null
)
returns table (memory_id uuid, similarity real)
language sql
stable
as $$
  select v.memory_id, public.cosine_similarity(v.embedding, p_query)::real as similarity
    from public.memory_vectors v
   where v.user_id = p_user_id
     and v.dim = jsonb_array_length(p_query)
     and (p_model is null or v.model = p_model)
     and public.cosine_similarity(v.embedding, p_query) >= coalesce(p_min_similarity, 0)
   order by public.cosine_similarity(v.embedding, p_query) desc
   limit least(greatest(coalesce(p_limit, 12), 1), 100);
$$;

-- ============================================================== links ======
-- Automatic findings are always PROPOSALS. Nothing merges, overwrites or hides
-- an original memory until the user approves (relation 'supersedes' +
-- status 'approved'). The user's original words are never replaced by an
-- inference.

create table if not exists public.memory_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_memory_id uuid not null references public.memories (id) on delete cascade,
  related_memory_id uuid not null references public.memories (id) on delete cascade,
  relation text not null check (relation in ('duplicate', 'follow_up', 'supersedes', 'related')),
  confidence real not null default 0,
  detail text,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (source_memory_id, related_memory_id, relation)
);

create index if not exists memory_links_user_idx on public.memory_links (user_id, status);
create index if not exists memory_links_source_idx on public.memory_links (source_memory_id);
create index if not exists memory_links_related_idx on public.memory_links (related_memory_id);

alter table public.memory_links enable row level security;

drop policy if exists "memory_links_select_own" on public.memory_links;
create policy "memory_links_select_own" on public.memory_links
  for select using (auth.uid() = user_id);

drop policy if exists "memory_links_insert_own" on public.memory_links;
create policy "memory_links_insert_own" on public.memory_links
  for insert with check (auth.uid() = user_id);

drop policy if exists "memory_links_update_own" on public.memory_links;
create policy "memory_links_update_own" on public.memory_links
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "memory_links_delete_own" on public.memory_links;
create policy "memory_links_delete_own" on public.memory_links
  for delete using (auth.uid() = user_id);

-- =========================================================== settings ======
-- One row per user, created lazily by the backend on first write.

create table if not exists public.memory_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Master switch: when off, the assistant answers without touching memories.
  memory_ai_enabled boolean not null default true,
  -- Whether previous conversations may be used as retrieval context.
  conversation_memory_enabled boolean not null default true,
  -- Whether voice/document extraction may run (audio transcription / text
  -- extraction) at save time. Turning this off keeps memory fully usable.
  processing_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.memory_settings enable row level security;

drop policy if exists "memory_settings_select_own" on public.memory_settings;
create policy "memory_settings_select_own" on public.memory_settings
  for select using (auth.uid() = user_id);

drop policy if exists "memory_settings_insert_own" on public.memory_settings;
create policy "memory_settings_insert_own" on public.memory_settings
  for insert with check (auth.uid() = user_id);

drop policy if exists "memory_settings_update_own" on public.memory_settings;
create policy "memory_settings_update_own" on public.memory_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Account deletion ("forget my data"): the owner must be able to remove
-- their own settings row. Without this policy the row can only disappear
-- via the auth.users cascade, which requires the service-role key, so a
-- self-service deletion would orphan it.
drop policy if exists "memory_settings_delete_own" on public.memory_settings;
create policy "memory_settings_delete_own" on public.memory_settings
  for delete using (auth.uid() = user_id);

-- ===================================================== search vector =======
-- Now covers transcripts, extracted document text and AI topics too, so a
-- memory uploaded as a PDF or a voice note is findable by keywords as well.

create or replace function public.set_memories_search_vector()
returns trigger
language plpgsql
as $$
begin
  new.search_vector := to_tsvector('english'::regconfig,
    coalesce(new.title, '') || ' ' ||
    coalesce(new.content, '') || ' ' ||
    coalesce(new.transcript, '') || ' ' ||
    coalesce(new.extracted_text, '') || ' ' ||
    coalesce(array_to_string(new.tags, ' '), '') || ' ' ||
    coalesce(array_to_string(new.keywords, ' '), '') || ' ' ||
    coalesce(array_to_string(new.entities, ' '), '') || ' ' ||
    coalesce(array_to_string(new.topics, ' '), '') || ' ' ||
    coalesce(new.ai_summary, ''));
  return new;
end;
$$;

drop trigger if exists trg_memories_search_vector on public.memories;
create trigger trg_memories_search_vector
  before insert or update of title, content, transcript, extracted_text, tags,
    keywords, entities, topics, ai_summary on public.memories
  for each row execute function public.set_memories_search_vector();

update public.memories
   set search_vector = to_tsvector('english'::regconfig,
    coalesce(title, '') || ' ' ||
    coalesce(content, '') || ' ' ||
    coalesce(transcript, '') || ' ' ||
    coalesce(extracted_text, '') || ' ' ||
    coalesce(array_to_string(tags, ' '), '') || ' ' ||
    coalesce(array_to_string(keywords, ' '), '') || ' ' ||
    coalesce(array_to_string(entities, ' '), '') || ' ' ||
    coalesce(array_to_string(topics, ' '), '') || ' ' ||
    coalesce(ai_summary, ''));

create index if not exists memories_search_vector_idx
  on public.memories using gin (search_vector);

-- ===================================================== optional pgvector ====
-- If the pgvector extension happens to be enabled on the project, add a proper
-- ANN index on top of the same jsonb-free representation. Purely optional and
-- additive: the jsonb path above keeps working either way.
--
--   create extension if not exists vector;
--   alter table public.memory_vectors
--     add column if not exists vec vector(384);
--   create index if not exists memory_vectors_vec_idx
--     on public.memory_vectors using hnsw (vec vector_cosine_ops);