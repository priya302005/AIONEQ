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

export async function listConversations(token) {
  return clientFor(token)
    .from('conversations')
    .select('id,title,updated_at')
    .order('updated_at', { ascending: false })
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