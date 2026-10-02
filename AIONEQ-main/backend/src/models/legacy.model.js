import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config/config.js'

function clientFor(token) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function withErrorCapture(promise) {
  try {
    return await promise
  } catch (err) {
    return { data: null, error: err }
  }
}

export function hashSha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

export function generateClaimToken() {
  return crypto.randomBytes(24).toString('hex') // 48 hex chars
}

export async function createGrant(token, payload) {
  return withErrorCapture(
    clientFor(token)
      .from('legacy_grants')
      .insert(payload)
      .select()
      .single()
  )
}

export async function listGrants(token, ownerId) {
  return withErrorCapture(
    clientFor(token)
      .from('legacy_grants')
      .select('*')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false })
  )
}

export async function getGrantById(token, id) {
  return withErrorCapture(
    clientFor(token)
      .from('legacy_grants')
      .select('*')
      .eq('id', id)
      .maybeSingle()
  )
}

export async function findPendingGrantByEmail(token, email) {
  return withErrorCapture(
    clientFor(token)
      .from('legacy_grants')
      .select('*')
      .eq('recipient_email', email)
      .eq('status', 'pending')
      .maybeSingle()
  )
}

export async function revokeGrantRow(token, id) {
  return withErrorCapture(
    clientFor(token)
      .from('legacy_grants')
      .update({ status: 'revoked', revoked_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .maybeSingle()
  )
}

/** Claim: flips a pending grant to active for the signed-in recipient. */
export async function activateGrant(token, id, recipientUserId) {
  return withErrorCapture(
    clientFor(token)
      .from('legacy_grants')
      .update({
        status: 'active',
        recipient_user_id: recipientUserId,
        activated_at: new Date().toISOString(),
        activated_by: recipientUserId,
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select()
      .maybeSingle()
  )
}

/** Active legacy grants this user may read as a recipient. */
export async function listActiveGrantsForRecipient(token, recipientUserId) {
  const { data, error } = await withErrorCapture(
    clientFor(token)
      .from('legacy_grants')
      .select('*')
      .eq('recipient_user_id', recipientUserId)
      .eq('status', 'active')
  )
  return { data: data || [], error }
}

/** Pending grants issued to this email address (used by the claim UI). */
export async function listPendingGrantsForEmail(token, email) {
  const { data, error } = await withErrorCapture(
    clientFor(token)
      .from('legacy_grants')
      .select('*')
      .eq('recipient_email', email)
      .eq('status', 'pending')
  )
  return { data: data || [], error }
}

/** Read-only: memories of a legacy owner available to an active recipient. */
export async function findMemoriesByOwner(token, ownerId) {
  return withErrorCapture(
    clientFor(token)
      .from('memories')
      .select('id,title,type,event_date,created_at,file_url,mime_type,content')
      .eq('user_id', ownerId)
      .order('created_at', { ascending: false })
  )
}

/**
 * Returns the active grant (if any) that lets `recipientUserId` read
 * `ownerId`'s archive. Used by the file-serving path and ownership checks.
 */
export async function grantFor(recipientToken, ownerId, recipientUserId) {
  const { data, error } = await withErrorCapture(
    clientFor(recipientToken)
      .from('legacy_grants')
      .select('*')
      .eq('owner_id', ownerId)
      .eq('recipient_user_id', recipientUserId)
      .eq('status', 'active')
      .maybeSingle()
  )
  if (error || !data) return null
  return data
}