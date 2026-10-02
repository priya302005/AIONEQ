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

export async function createMemory(token, payload) {
  return withErrorCapture(
    clientFor(token)
      .from('memories')
      .insert(payload)
      .select()
      .single()
  )
}

export async function findMemories(token, { type, sort = '-created_at' } = {}) {
  const client = clientFor(token)
  let query = client.from('memories').select('*')
  if (type) query = query.eq('type', type)
  const descending = sort.startsWith('-')
  const column = descending ? sort.slice(1) : sort
  query = query.order(column || 'created_at', { ascending: !descending })
  return query
}

export async function findMemoryById(token, id) {
  return withErrorCapture(
    clientFor(token)
      .from('memories')
      .select('*')
      .eq('id', id)
      .maybeSingle()
  )
}

export async function updateMemoryRow(token, id, payload) {
  return withErrorCapture(
    clientFor(token)
      .from('memories')
      .update(payload)
      .eq('id', id)
      .select()
      .maybeSingle()
  )
}

export async function updateMemoryMetadata(token, id, payload) {
  return withErrorCapture(
    clientFor(token)
      .from('memories')
      .update(payload)
      .eq('id', id)
      .select()
      .maybeSingle()
  )
}

export async function removeMemoryRow(token, id) {
  return withErrorCapture(
    clientFor(token)
      .from('memories')
      .delete()
      .eq('id', id)
      .select()
      .maybeSingle()
  )
}

/** Bulk-wipe used by account deletion. RLS still scopes these to the owner. */
export async function removeAllMemoriesForUser(token) {
  return clientFor(token).from('memories').delete().select('file_url')
}