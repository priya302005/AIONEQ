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

/**
 * Lists the user's conversations, newest first.
 *
 * `search` matches the title OR the text of any message in the thread, so a
 * conversation can be found by something that was actually said inside it - the
 * question you asked weeks ago is usually not in the title. ilike is used
 * because Supabase search vectors are not guaranteed to exist on this table,
 * and RLS still scopes every row to the caller.
 */
export async function listConversations(token, { search = '', limit = 100 } = {}) {
  const term = String(search || '').trim()
  // Message bodies are only selected while searching. Fetching them on every
  // sidebar load would pull every stored chat into memory just to draw titles.
  const columns = term ? 'id,title,updated_at,user_id,messages' : 'id,title,updated_at,user_id'

  let query = clientFor(token)
    .from('conversations')
    .select(columns)
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (term) {
    // Escape the LIKE metacharacters so a user typing "50%" or "a_b" searches
    // for that literal text instead of turning into a wildcard.
    const safe = term.replace(/[%_]/g, (ch) => `\\${ch}`)
    query = query.or(`title.ilike.%${safe}%,messages.ilike.%${safe}%`)
  }
  return withErrorCapture(query)
}

export async function getConversation(token, id) {
  return withErrorCapture(
    clientFor(token)
      .from('conversations')
      .select('*')
      .eq('id', id)
      .maybeSingle()
  )
}

export async function createConversation(token, payload) {
  return withErrorCapture(
    clientFor(token)
      .from('conversations')
      .insert(payload)
      .select()
      .single()
  )
}

export async function updateConversationRow(token, id, payload) {
  return withErrorCapture(
    clientFor(token)
      .from('conversations')
      .update(payload)
      .eq('id', id)
      .select()
      .maybeSingle()
  )
}

export async function removeConversationRow(token, id) {
  return withErrorCapture(
    clientFor(token)
      .from('conversations')
      .delete()
      .eq('id', id)
      .select()
      .maybeSingle()
  )
}

export async function renameConversationRow(token, id, title) {
  return withErrorCapture(
    clientFor(token)
      .from('conversations')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .maybeSingle()
  )
}

/**
 * Bulk-wipe used by account deletion. `.select('id')` makes PostgREST
 * return the deleted rows so the caller can count what was removed.
 */
export async function removeAllConversationsForUser(token) {
  return clientFor(token).from('conversations').delete().select('id')
}