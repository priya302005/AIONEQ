-- EchoMind: memory context enrichment columns + search coverage
-- Idempotent. Run in your Supabase dashboard (SQL Editor -> New query) AFTER
-- memories.sql / query.sql. Safe to run at any time.
--
-- What this adds:
--   - memories.keywords   text[]   (LLM-extracted topic words)
--   - memories.entities   text[]   (named entities found in the content)
--   - memories.ai_summary text     (one factual sentence, content-only)
--   - the search_vector trigger now covers those columns too, so retrieval
--     finds memories by their enriched terms as well as their raw content.
--
-- The original user content is never rewritten by enrichment: these columns
-- sit next to it and everything stored here is derived strictly from it.

alter table public.memories add column if not exists keywords text[];
alter table public.memories add column if not exists entities text[];
alter table public.memories add column if not exists ai_summary text;

create or replace function public.set_memories_search_vector()
returns trigger
language plpgsql
as $$
begin
  new.search_vector := to_tsvector('english'::regconfig,
    coalesce(new.title, '') || ' ' ||
    coalesce(new.content, '') || ' ' ||
    coalesce(array_to_string(new.tags, ' '), '') || ' ' ||
    coalesce(array_to_string(new.keywords, ' '), '') || ' ' ||
    coalesce(array_to_string(new.entities, ' '), '') || ' ' ||
    coalesce(new.ai_summary, ''));
  return new;
end;
$$;

drop trigger if exists trg_memories_search_vector on public.memories;
create trigger trg_memories_search_vector
  before insert or update of title, content, tags, keywords, entities, ai_summary on public.memories
  for each row execute function public.set_memories_search_vector();

-- Backfill so existing rows are searchable by the newly covered columns.
update public.memories
set search_vector = to_tsvector('english'::regconfig,
  coalesce(title, '') || ' ' ||
  coalesce(content, '') || ' ' ||
  coalesce(array_to_string(tags, ' '), '') || ' ' ||
  coalesce(array_to_string(keywords, ' '), '') || ' ' ||
  coalesce(array_to_string(entities, ' '), '') || ' ' ||
  coalesce(ai_summary, ''));