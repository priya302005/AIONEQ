-- EchoMind security hardening migration. Idempotent. Run in Supabase SQL Editor.

-- ---- legacy access: legacy_grants ----
create table if not exists public.legacy_grants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  recipient_email text not null,
  recipient_user_id uuid references auth.users (id) on delete cascade,
  grant_type text not null check (grant_type in ('full','text')) default 'full',
  status text not null check (status in ('pending','active','revoked')) default 'pending',
  claim_token_hash text not null,
  access_code_hash text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  activated_by uuid references auth.users (id) on delete set null
);

create index if not exists legacy_grants_owner_idx on public.legacy_grants (owner_id);
create index if not exists legacy_grants_recipient_email_idx on public.legacy_grants (recipient_email);
create index if not exists legacy_grants_recipient_user_idx on public.legacy_grants (recipient_user_id);

alter table public.legacy_grants enable row level security;

-- Owner manages their own grants.
drop policy if exists "legacy_grants_owner_select" on public.legacy_grants;
create policy "legacy_grants_owner_select" on public.legacy_grants
  for select using (auth.uid() = owner_id);

drop policy if exists "legacy_grants_owner_insert" on public.legacy_grants;
create policy "legacy_grants_owner_insert" on public.legacy_grants
  for insert with check (auth.uid() = owner_id);

drop policy if exists "legacy_grants_owner_update" on public.legacy_grants;
create policy "legacy_grants_owner_update" on public.legacy_grants
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "legacy_grants_owner_delete" on public.legacy_grants;
create policy "legacy_grants_owner_delete" on public.legacy_grants
  for delete using (auth.uid() = owner_id);

-- Intended recipients may see their own pending grant (to claim it) and any
-- grants where they are the active recipient. Uses the JWT email claim
-- (auth.jwt() -> 'email') instead of reading auth.users - policy subqueries
-- that SELECT auth.users fail with 42501 for roles without a grant on that
-- table (Supabase hides it by default), which would break every memories /
-- conversations read that chains through this policy.
drop policy if exists "legacy_grants_recipient_view" on public.legacy_grants;
create policy "legacy_grants_recipient_view" on public.legacy_grants
  for select using (
    (status = 'pending' and recipient_email = (auth.jwt() ->> 'email'))
    or recipient_user_id = auth.uid()
  );

-- One-shot claim: a pending grant flips to active with the caller bound in.
drop policy if exists "legacy_grants_claim" on public.legacy_grants;
create policy "legacy_grants_claim" on public.legacy_grants
  for update to authenticated
  using (
    status = 'pending'
    and recipient_user_id is null
    and recipient_email = (auth.jwt() ->> 'email')
  )
  with check (status = 'active' and recipient_user_id = auth.uid() and activated_by = auth.uid());

-- Account deletion ("forget my data"): a user must be able to remove
-- grants naming them as the recipient (revoking their own access into
-- someone else's archive). Without this policy the delete silently
-- matches zero rows under RLS and the grant is orphaned. Grants the
-- user OWNS are covered by legacy_grants_owner_delete above.
drop policy if exists "legacy_grants_recipient_delete" on public.legacy_grants;
create policy "legacy_grants_recipient_delete" on public.legacy_grants
  for delete using (recipient_user_id = auth.uid());

-- ---- memories: file_size for quota accounting ----
alter table public.memories add column if not exists file_size bigint;

-- ---- memories: read access for active legacy recipients ----
-- Grant recipients may READ the owner's memories (content + files), never
-- update or delete. grant_type 'text' is enforced at the app layer for file
-- serving; RLS here grants text visibility either way.
drop policy if exists "memories_select_legacy" on public.memories;
create policy "memories_select_legacy" on public.memories
  for select using (
    exists (
      select 1 from public.legacy_grants lg
      where lg.owner_id = memories.user_id
        and lg.recipient_user_id = auth.uid()
        and lg.status = 'active'
    )
  );

-- ---- conversations: read access for active legacy recipients ----
drop policy if exists "conversations_select_legacy" on public.conversations;
create policy "conversations_select_legacy" on public.conversations
  for select using (
    exists (
      select 1 from public.legacy_grants lg
      where lg.owner_id = conversations.user_id
        and lg.recipient_user_id = auth.uid()
        and lg.status = 'active'
    )
  );

-- ---- signed file serving helper ----
-- Used by the signed-URL file route. The server verifies an HMAC token that
-- binds (user_id, memory_id, expiry); only after that verification does it
-- call this function, which returns the file path ONLY when the given user
-- actually owns the memory. SECURITY DEFINER is safe here because the inputs
-- are cryptographic-verified server-side and the function returns nothing for
-- a non-owning pair.
create or replace function public.get_file_url_for_owner(p_user_id uuid, p_memory_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select file_url from public.memories
  where id = p_memory_id and user_id = p_user_id
  limit 1
$$;

revoke all on function public.get_file_url_for_owner(uuid, uuid) from public;
grant execute on function public.get_file_url_for_owner(uuid, uuid) to anon, authenticated, service_role;

-- Note: policies intentionally do NOT read auth.users here. Recipient identity
-- comes from the JWT claims (auth.jwt() ->> 'email'), so no grants are needed
-- on auth.users - that table stays hidden by default (42501-proof).