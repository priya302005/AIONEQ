/*
 * Memory search for the UI.
 *
 * Shares its ranking with the assistant's retrieval path (memoryRetrieval.js) so
 * "search my memories" and "what do you remember about X" agree on what counts
 * as relevant - but returns FULL rows rather than excerpts, because the user is
 * browsing their archive, not building a prompt.
 */

import { config } from '../config/config.js'
import { retrieveMemories } from './memoryRetrieval.js'
import { findMemoryById } from '../models/memory.model.js'

/**
 * Searches the caller's own memories.
 *
 * @param {string} token
 * @param {string} userId the authenticated user - retrieval can never cross it
 * @param {string} query
 * @param {{type?:string|null, limit?:number}} [opts]
 * @returns {Promise<object[]>} memory rows, best match first
 */
export async function searchMemories(token, userId, query, opts = {}) {
  const limit = Math.min(opts.limit || config.memorySearchMaxLimit, config.memorySearchMaxLimit)
  if (!String(query || '').trim()) return []

  // RLS-scoped client built from the caller's own token.
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const hits = await retrieveMemories(client, userId, query, {
    limit,
    // The search box should feel responsive, not strict: a weak match is still
    // worth showing ranked last rather than hiding a real memory.
    minScore: 0.04,
    types: opts.type ? [opts.type] : null,
  })

  // Re-read the full rows so the list can render previews and open any of them.
  const rows = await Promise.all(hits.map((h) => findMemoryById(token, h.memoryId)))
  const scores = new Map(hits.map((h) => [h.memoryId, h]))

  return rows
    .filter((r) => r && r.data && r.data.user_id === userId)
    .map((r) => ({
      ...r.data,
      // Derived fields used by the results list. Never expose the vector itself.
      _search: {
        score: scores.get(r.data.id)?.score ?? 0,
        matchedBy: scores.get(r.data.id)?.matchedBy || '',
      },
    }))
    .sort((a, b) => b._search.score - a._search.score)
}

export default searchMemories