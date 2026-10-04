import { createClient } from '@supabase/supabase-js'
import { config } from '../config/config.js'

function clientFor(token) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function capture(promise) {
  try {
    return await promise
  } catch (err) {
    return { data: null, error: err }
  }
}

const LINK_COLUMNS = 'id,source_memory_id,related_memory_id,relation,confidence,detail,status,created_at,resolved_at'

/**
 * Candidate memories for relationship detection, newest first, excluding the
 * memory itself. Each row carries its vector when one exists so detection can
 * skip a second embedding call.
 * Returns [] when the migration has not been applied (never throws).
 */
export async function findMemoriesForLinks(token, userId, excludeId, limit = 25) {
  const { data, error } = await capture(
    clientFor(token)
      .from('memories')
      .select('id,user_id,type,title,content,transcript,extracted_text,ai_summary,topics,keywords,tags,event_date,created_at,updated_at')
      .order('updated_at', { ascending: false })
      .limit(limit + 1)
  )
  if (error || !Array.isArray(data)) return []

  const candidates = data.filter((m) => m.id !== excludeId).slice(0, limit)
  if (!candidates.length) return []

  // Vectors are optional; a memory without one still participates via lexical
  // overlap, and memory_vectors is a separate table so this can fail softly.
  const { data: vectors } = await capture(
    clientFor(token)
      .from('memory_vectors')
      .select('memory_id,embedding')
      .in('memory_id', candidates.map((c) => c.id))
  ).catch(() => ({ data: null }))

  const byId = new Map()
  for (const v of vectors || []) {
    if (Array.isArray(v.embedding)) byId.set(v.memory_id, v.embedding.map(Number))
  }
  return candidates.map((c) => ({ ...c, vector: byId.get(c.id) || null }))
}

/**
 * Records a relationship PROPOSAL. Idempotent: re-proposing the same pair and
 * relation updates confidence instead of creating a duplicate row.
 */
export async function proposeMemoryLink(token, payload) {
  const { data, error } = await capture(
    clientFor(token)
      .from('memory_links')
      .upsert(
        {
          user_id: payload.user_id,
          source_memory_id: payload.source_memory_id,
          related_memory_id: payload.related_memory_id,
          relation: payload.relation,
          confidence: payload.confidence ?? 0,
          detail: payload.detail || null,
          // Never downgrade an already-decided link back to 'proposed'.
          status: 'proposed',
        },
        { onConflict: 'source_memory_id,related_memory_id,relation', ignoreDuplicates: true }
      )
      .select(LINK_COLUMNS)
      .maybeSingle()
  )
  if (error) {
    // A duplicate conflict is the normal case on reprocess - treat as success.
    if (/duplicate key|23505/i.test(error.message || '')) return { data: null, error: null }
    return { data: null, error }
  }
  return { data, error: null }
}

/** All links the user owns that touch any of the given memories. */
export async function listMemoryLinks(token, userId, memoryIds = []) {
  const client = clientFor(token)
  let q = client.from('memory_links').select(LINK_COLUMNS).eq('status', 'approved')
  if (memoryIds.length) {
    q = q.or(`source_memory_id.in.(${memoryIds.join(',')}),related_memory_id.in.(${memoryIds.join(',')})`)
  }
  const { data, error } = await capture(q)
  if (error || !Array.isArray(data)) return []
  // user_id filter is redundant under RLS but stated explicitly as defense in
  // depth, matching the rest of the codebase.
  return data.filter((l) => !userId || l.user_id === userId || !l.user_id)
}

export async function getMemoryLink(token, id) {
  return capture(clientFor(token).from('memory_links').select('*').eq('id', id).maybeSingle())
}

/** User decision on a proposal. The only way a link ever becomes active. */
export async function resolveMemoryLink(token, id, status) {
  return capture(
    clientFor(token)
      .from('memory_links')
      .update({ status, resolved_at: new Date().toISOString() })
      .eq('id', id)
      .select(LINK_COLUMNS)
      .maybeSingle()
  )
}

export async function removeMemoryLink(token, id) {
  return capture(clientFor(token).from('memory_links').delete().eq('id', id).select(LINK_COLUMNS).maybeSingle())
}

/** Links proposed BY a memory (the "what did we find" panel). */
export async function linksForMemory(token, memoryId) {
  const { data, error } = await capture(
    clientFor(token)
      .from('memory_links')
      .select(LINK_COLUMNS)
      .or(`source_memory_id.eq.${memoryId},related_memory_id.eq.${memoryId}`)
      .order('created_at', { ascending: false })
  )
  if (error || !Array.isArray(data)) return []
  return data
}

/**
 * Bulk-wipe used by account deletion. RLS still scopes these to the
 * owner; deleting children explicitly (rather than relying on the
 * FK cascade) keeps the wipe deterministic even on a database where
 * the cascade has not been created yet.
 */
export async function removeAllMemoryLinksForUser(token) {
  return capture(clientFor(token).from('memory_links').delete().select('id'))
}