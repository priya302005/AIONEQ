import { createClient } from '@supabase/supabase-js'
import { config } from '../config/config.js'

const SNIPPET_LENGTH = 500

function truncate(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function clientFor(token) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

/*
 * Keyword-based retrieval (MVP).
 * TODO: swap in vector embeddings + cosine similarity here later without
 * changing the caller's interface (still returns { memoryId, title, type,
 * content, eventDate, snippet } objects).
 */
export default async function retrieveRelevantMemories(token, question, limit = 6) {
  const client = clientFor(token)
  const columns = 'id,title,type,content,event_date'
  let memories = []

  try {
    const { data, error } = await client
      .from('memories')
      .select(columns)
      .textSearch('search_vector', question, { config: 'english', type: 'websearch' })
      .limit(limit)
    if (!error && data?.length) memories = data
  } catch {
    /* search column missing -> fall back below */
  }

  if (!memories.length) {
    const { data } = await client
      .from('memories')
      .select(columns)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (data) memories = data
  }

  return memories.map((m) => ({
    memoryId: m.id,
    title: m.title,
    type: m.type,
    eventDate: m.event_date,
    snippet: truncate(m.content || `${m.title} (${m.type})`, SNIPPET_LENGTH),
  }))
}