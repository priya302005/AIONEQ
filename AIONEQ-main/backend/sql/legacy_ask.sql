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

-- 4. The owner's "memory AI" switch must also bind recipients. memory_settings is
--    private to its owner, so a recipient cannot read it directly. This function
--    returns only a yes/no, and only to a caller holding an ACTIVE grant from
--    that owner (anyone else gets false), so it cannot be used to probe accounts.
create or replace function public.legacy_owner_ai_enabled(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.legacy_grants lg
       where lg.owner_id = p_owner
         and lg.recipient_user_id = auth.uid()
         and lg.status = 'active'
    )
    then coalesce((select ms.memory_ai_enabled from public.memory_settings ms where ms.user_id = p_owner), true)
    else false
  end;
$$;

revoke all on function public.legacy_owner_ai_enabled(uuid) from public;
grant execute on function public.legacy_owner_ai_enabled(uuid) to authenticated;
