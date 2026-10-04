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

/**
 * Listed/searched columns. Deliberately includes derived columns so the
 * dashboard can show a memory's status and summary without a second request.
 */
const LIST_COLUMNS =
  'id,user_id,type,title,content,tags,event_date,created_at,updated_at,duration,mime_type,file_url,' +
  'ai_summary,topics,keywords,entities,processing_status,processing_stage,processing_error,processed_at,source_kind'

export async function findMemories(token, { type, sort = '-created_at' } = {}) {
  const client = clientFor(token)
  let query = client.from('memories').select(LIST_COLUMNS)
  if (type) query = query.eq('type', type)
  const descending = sort.startsWith('-')
  const column = descending ? sort.slice(1) : sort
  query = query.order(column || 'created_at', { ascending: !descending })
  return query
}

/**
 * Paged + filtered listing used by GET /api/memories.
 * Hard-capped so a large archive can never be pulled into memory or the browser
 * in one unbounded request.
 */
export async function listMemories(token, { type, status, limit, offset = 0, sort = '-created_at' } = {}) {
  const client = clientFor(token)
  let query = client.from('memories').select(LIST_COLUMNS)
  if (type) query = query.eq('type', type)
  if (status) query = query.eq('processing_status', status)

  const descending = String(sort).startsWith('-')
  const column = descending ? String(sort).slice(1) : String(sort)
  query = query.order(column || 'created_at', { ascending: !descending, nullsFirst: false })
  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query
  if (error) return { data: null, error, count: null }
  return { data: data || [], error: null, count }
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

/**
 * Derived-text columns (transcript / extracted_text / source_kind).
 * Separate from updateMemoryRow so an edit to a user-visible field can never
 * accidentally overwrite machine-derived content, and vice versa.
 */
export async function saveDerivedText(token, id, payload) {
  return withErrorCapture(clientFor(token).from('memories').update(payload).eq('id', id).select('id,transcript,extracted_text,source_kind').maybeSingle())
}

/** Derived metadata columns (summary / topics / keywords / entities). */
export async function saveDerivedMetadata(token, id, payload) {
  return withErrorCapture(clientFor(token).from('memories').update(payload).eq('id', id).select('id,ai_summary,topics,keywords,entities').maybeSingle())
}

/** Processing bookkeeping. */
export async function markProcessing(token, id, status, { stage = null, error = null, processedAt = null } = {}) {
  return withErrorCapture(
    clientFor(token)
      .from('memories')
      .update({
        processing_status: status,
        processing_stage: stage,
        processing_error: error,
        processed_at: processedAt,
      })
      .eq('id', id)
      .select('id,processing_status')
      .maybeSingle()
  )
}

/**
 * Clears derived state before a re-run so a failed reprocess cannot leave
 * stale metadata behind that looks current.
 */
export async function resetDerived(token, id) {
  return withErrorCapture(
    clientFor(token)
      .from('memories')
      .update({
        ai_summary: null,
        topics: null,
        keywords: null,
        entities: null,
        processing_status: 'pending',
        processing_stage: 'queued',
        processing_error: null,
        processed_at: null,
      })
      .eq('id', id)
      .select('id')
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

// ------------------------------------------------------------- vectors -----

export async function upsertMemoryVector(token, { memory_id, user_id, embedding, dim, model }) {
  return withErrorCapture(
    clientFor(token)
      .from('memory_vectors')
      .upsert({ memory_id, user_id, embedding, dim, model, updated_at: new Date().toISOString() }, { onConflict: 'memory_id' })
      .select('memory_id')
      .maybeSingle()
  )
}

export async function deleteMemoryVector(token, memoryId) {
  return withErrorCapture(clientFor(token).from('memory_vectors').delete().eq('memory_id', memoryId))
}

/**
 * Bulk-wipe used by account deletion. RLS still scopes these to the
 * owner; deleting explicitly (rather than relying on the FK cascade)
 * keeps the wipe deterministic even on a database where the cascade
 * has not been created yet.
 */
export async function removeAllMemoryVectorsForUser(token) {
  return withErrorCapture(clientFor(token).from('memory_vectors').delete().select('memory_id'))
}

/**
 * Semantic search against an already-scoped client. The client carries the
 * caller's token, so RLS applies exactly as it does for every other query.
 * The retrieval service uses this form so it reuses the SAME client instance it
 * was handed, instead of minting a fresh one from a token it does not have.
 */
export async function matchMemoryVectorsWithClient(client, { userId, vector, minSimilarity = 0, limit = 20, model }) {
  const { data, error } = await withErrorCapture(
    client.rpc('match_memory_vectors', {
      p_query: vector,
      p_user_id: userId,
      p_min_similarity: minSimilarity,
      p_limit: limit,
      // Scopes results to the caller's embedding space. Without it, vectors left
      // over from a previous embedding model could be scored against this query
      // in an unrelated space. See embeddingIdentity() in utils/embeddings.js.
      p_model: model ?? null,
    })
  )
  if (error || !Array.isArray(data)) return []
  return data
    .filter((r) => r && r.memory_id)
    .map((r) => ({ memoryId: r.memory_id, similarity: Number(r.similarity) || 0 }))
}

/**
 * Semantic search. Calls the match_memory_vectors RPC, which runs as the
 * INVOKER so the memory_vectors RLS policies still apply: a caller cannot
 * receive another user's rows even if p_user_id were tampered with.
 * Returns [] (never throws) when the migration has not been applied.
 */
export async function matchMemoryVectors(token, { userId, vector, minSimilarity = 0, limit = 20, model }) {
  return matchMemoryVectorsWithClient(clientFor(token), { userId, vector, minSimilarity, limit, model })
}

/**
 * How a user's stored vectors line up with the embedding space this process is
 * configured for. Powers the "your memories need reindexing" diagnostic and the
 * reindex CLI's --check mode, so a model change is visible instead of silent.
 *
 * Returns { total, current, stale, models: {identity: count}, needsReindex }.
 * Only ever reads the caller's own rows (RLS).
 */
export async function getVectorCoverageWithClient(client, { userId, model }) {
  const empty = { total: 0, current: 0, stale: 0, models: {}, needsReindex: false }
  if (!userId) return empty
  try {
    const { data, error } = await withErrorCapture(
      client.from('memory_vectors').select('memory_id, model').eq('user_id', userId)
    )
    if (error || !Array.isArray(data)) return empty

    const models = {}
    for (const row of data) {
      const key = String(row?.model ?? 'unknown')
      models[key] = (models[key] || 0) + 1
    }
    const total = data.length
    const current = model ? models[model] || 0 : total
    return { total, current, stale: total - current, models, needsReindex: current < total }
  } catch {
    return empty
  }
}