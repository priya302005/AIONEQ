import { createClient } from '@supabase/supabase-js'
import { config } from '../config/config.js'
import { sanitizeExcerpt } from './promptSafety.js'
import { relevanceScore } from './textRelevance.js'

const SNIPPET_LENGTH = 500
// Candidate pool fetched from the store, then re-ranked in-process. 20 is
// plenty for the MVP volume and keeps the FTS query cheap; the fallback path
// also uses it so ranking applies even when full-text finds no match.
const RANK_CANDIDATES = 20

const BASE_COLUMNS = 'id,user_id,title,type,content,tags,event_date,created_at,updated_at'
// Extended columns come from sql/context.sql (optional migration). If the
// migration has not been applied, retrieval retries with the base columns and
// simply contributes nothing extra - it never breaks.
const EXT_COLUMNS = `${BASE_COLUMNS},keywords,entities,ai_summary`

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

function sortByScore(rows) {
  const parse = (value) => {
    const n = Date.parse(value || 0)
    return Number.isFinite(n) ? n : 0
  }
  return rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Rows are { m, score } wrappers; plain rows (fallback shapes) read direct.
    const da = parse(a.m?.updated_at || a.m?.created_at || a.m?.event_date || a.updated_at || a.created_at || a.event_date)
    const db = parse(b.m?.updated_at || b.m?.created_at || b.m?.event_date || b.updated_at || b.created_at || b.event_date)
    return db - da
  })
}

/*
 * Scored retrieval core, factored so tests can inject a fake client (no live
 * DB needed to prove dynamic behavior). The Supabase client fetches fresh from
 * the store on every call - nothing is cached between requests.
 *
 * Flow (fully dynamic, per requirement):
 *   1. candidates = Postgres full-text match on search_vector (trigger-maintained
 *      from the row's actual title/content/tags) OR, if none, the most recent rows.
 *   2. defense in depth: keep only rows owned by the authenticated user.
 *   3. score every row 0..1 with dynamic question-overlap relevance
 *      (title + content + tags + optional enrichment terms).
 *
 * Returns the scored items (no threshold, no limit beyond the candidate pool)
 * so callers can apply their own thresholds/budgets - the context engine does.
 */
export async function retrieveScoredMemoriesFrom(client, userId, question, candidateLimit = RANK_CANDIDATES) {
  const q = String(question || '')
  let rows = []

  for (const columns of [EXT_COLUMNS, BASE_COLUMNS]) {
    try {
      const { data, error } = await client
        .from('memories')
        .select(columns)
        .textSearch('search_vector', q, { config: 'english', type: 'websearch' })
        .limit(candidateLimit)
      if (!error && data?.length) {
        rows = data
        break
      }
    } catch {
      /* try the next column set */
    }
  }

  if (!rows.length) {
    try {
      const { data, error } = await client
        .from('memories')
        .select(BASE_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(candidateLimit)
      if (!error && data) rows = data
    } catch {
      /* memories table missing -> no memory source */
    }
  }

  const owned = rows.filter((m) => m.user_id === userId)
  const scored = owned.map((m) => {
    const parts = [m.title, m.content, Array.isArray(m.tags) ? m.tags.join(' ') : '']
    if (Array.isArray(m.keywords)) parts.push(m.keywords.join(' '))
    if (Array.isArray(m.entities)) parts.push(m.entities.join(' '))

    let score = relevanceScore(q, parts)
    // A generated factual summary (sql/context.sql) is one more dynamic signal.
    if (score >= 0.05 && m.ai_summary) {
      score = Math.min(1, score + relevanceScore(q, [m.ai_summary]) * 0.45)
    }
    return { m, score }
  })

  return sortByScore(scored).map(({ m, score }) => {
    const raw = truncate(m.content || `${m.title} (${m.type})`, SNIPPET_LENGTH)
    const { text: snippet, injection } = sanitizeExcerpt(raw, m.id, userId)
    return {
      memoryId: m.id,
      title: m.title,
      type: m.type,
      eventDate: m.event_date,
      snippet,
      injection,
      score,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    }
  })
}

/**
 * Ranked retrieval for the compact-mode Ask path (kept for back-compat and the
 * small-model workflow). Same dynamic store, shaped to the old contract.
 */
export async function retrieveRelevantMemoriesFrom(client, userId, question, limit = 6) {
  const scored = await retrieveScoredMemoriesFrom(client, userId, question)
  return scored.slice(0, limit).map(({ score, createdAt, updatedAt, ...rest }) => rest)
}

export default async function retrieveRelevantMemories(token, userId, question, limit = 6) {
  return retrieveRelevantMemoriesFrom(clientFor(token), userId, question, limit)
}