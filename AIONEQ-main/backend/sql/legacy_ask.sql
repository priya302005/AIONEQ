-- Legacy (referral) Ask: lets an ACTIVE grant recipient run semantic search over
-- the owner's memories, and lets the owner exclude individual memories.
-- Idempotent. Run in the Supabase SQL editor after security.sql.

-- 1. Memory-level exclusion. A true value hides the memory from every recipient
--    (text, vectors, AI answers). The owner always still sees their own rows.
alter table public.memories
  add column if not exists legacy_excluded boolean not null default false;

-- 2. Recipients read only non-excluded memories (replaces the policy in security.sql).
drop policy if exists "memories_select_legacy" on public.memories;
create policy "memories_select_legacy" on public.memories
  for select using (
    not legacy_excluded
    and exists (
      select 1 from public.legacy_grants lg
      where lg.owner_id = memories.user_id
        and lg.recipient_user_id = auth.uid()
        and lg.status = 'active'
    )
  );

-- 3. Vectors: without this the owner-only policy returns nothing to a recipient,
--    so semantic search silently degrades to keyword-only. Revoking the grant or
--    excluding the memory removes access immediately (checked per query).
drop policy if exists "memory_vectors_select_legacy" on public.memory_vectors;
create policy "memory_vectors_select_legacy" on public.memory_vectors
  for select using (
    exists (
      select 1
        from public.legacy_grants lg
        join public.memories m on m.user_id = lg.owner_id
       where m.id = memory_vectors.memory_id
         and not m.legacy_excluded
         and lg.owner_id = memory_vectors.user_id
         and lg.recipient_user_id = auth.uid()
         and lg.status = 'active'
    )
  );
