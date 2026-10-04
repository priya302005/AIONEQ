/*
 * An in-memory stand-in for PostgREST + Postgres full-text search + RLS.
 *
 * WHY THIS EXISTS: the retrieval evaluation must run the REAL production code in
 * src/services/memoryRetrieval.js, not a reimplementation of it. That code talks
 * to Supabase through a chainable query builder, so this file implements just
 * enough of that builder to drive it offline and deterministically.
 *
 * HONEST LIMITATION - read this before trusting a number:
 *   This emulates Postgres full-text search; it is NOT Postgres. Specifically:
 *     - `websearch_to_tsquery` is approximated as: drop stopwords, fold each term
 *       to a crude stem, OR them together. So a row matches if it contains ANY
 *       query term, which is the behaviour that actually causes false positives.
 *     - `ts_rank` is approximated as the fraction of query terms present.
 *     - the Snowball English stemmer is approximated by the project's own suffix
 *       folder. Real FTS stems harder ("running" -> "run", "studies" -> "studi").
 *   Consequences: absolute scores here are a PROXY. What this harness measures
 *   faithfully is the JavaScript half - candidate gathering, the blended score,
 *   the relevance floor, near-duplicate removal, ordering and truncation - which
 *   is where every bug found in this phase actually lived. Only a live run
 *   against real Postgres can validate the SQL half.
 *
 * RLS: the fake client is constructed with the caller's user id and NO query can
 * ever return a row owned by anyone else. That mirrors the real
 * `auth.uid() = user_id` policies, so cross-user leakage shows up as zero
 * results here rather than being silently filtered by the harness.
 */

import { STOPWORDS } from '../src/utils/textRelevance.js'

/** Same aggressive-but-small suffix fold the local vectorizer uses. */
function fold(token) {
  if (token.length <= 3) return token
  for (const suffix of ['ingly', 'edly', 'ing', 'ers', 'est', 'ed', 'es', 's']) {
    if (token.length - suffix.length >= 3 && token.endsWith(suffix)) {
      return token.slice(0, token.length - suffix.length)
    }
  }
  return token
}

function terms(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(fold)
}

/** Approximation of websearch_to_tsquery: OR of all meaningful terms. */
export function ftsQueryTerms(question) {
  return [...new Set(terms(question))]
}

/**
 * The columns the widened `search_vector` trigger covers: title, content,
 * transcript, extracted text, tags, topics, keywords, entities and AI summary.
 */
function indexedText(row) {
  return [
    row.title,
    row.content,
    row.transcript,
    row.extracted_text,
    row.ai_summary,
    ...(row.tags || []),
    ...(row.topics || []),
    ...(row.keywords || []),
    ...(row.entities || []),
  ]
    .filter(Boolean)
    .join(' ')
}

/** Fraction of query terms present in the row (a ts_rank stand-in). */
export function ftsRank(row, queryTerms) {
  if (!queryTerms.length) return 0
  const doc = new Set(terms(indexedText(row)))
  let hit = 0
  for (const t of queryTerms) if (doc.has(t)) hit++
  return hit / queryTerms.length
}

export function ftsMatches(row, queryTerms) {
  if (!queryTerms.length) return false
  const doc = new Set(terms(indexedText(row)))
  return queryTerms.some((t) => doc.has(t))
}

function project(row, columns) {
  if (!columns) return { ...row }
  const wanted = columns.split(',').map((c) => c.trim())
  const out = {}
  for (const c of wanted) if (c in row) out[c] = row[c]
  return out
}/** Minimal thenable query builder. */
class Query {
  constructor(store, userId) {
    this.store = store
    this.userId = userId
    this.columns = null
    this._textSearch = null
    this._order = null
    this._limit = null
    this._filters = []
  }

  select(columns) {
    this.columns = columns
    return this
  }

  textSearch(_column, query, _opts) {
    this._textSearch = query
    return this
  }

  order(column, { ascending } = {}) {
    this._order = { column, ascending }
    return this
  }

  limit(n) {
    this._limit = n
    return this
  }

  eq(column, value) {
    this._filters.push([column, value])
    return this
  }

  /** PostgREST `.in(column, values)` - used to hydrate vector-only hits. */
  in(column, values) {
    this._in = this._in || []
    this._in.push([column, new Set(Array.isArray(values) ? values : [values])])
    return this
  }

  maybeSingle() {
    return this
  }

  then(resolve, reject) {
    try {
      // RLS: the caller can only ever see their own rows. Enforced here, before
      // any filter, so no query shape can escape it.
      let rows = this.store.filter((r) => r.user_id === this.userId)

      for (const [col, val] of this._filters) rows = rows.filter((r) => r[col] === val)
      for (const [col, set] of this._in || []) rows = rows.filter((r) => set.has(r[col]))

      if (this._textSearch) {
        const qt = ftsQueryTerms(this._textSearch)
        rows = rows.filter((r) => ftsMatches(r, qt))
        // Rank by term coverage, then let Postgres' implicit recency tiebreak
        // stand in as the row order.
        rows = rows
          .map((r) => ({ r, rank: ftsRank(r, qt) }))
          .sort((a, b) => b.rank - a.rank || String(b.r.created_at).localeCompare(String(a.r.created_at)))
          .map((x) => x.r)
      }

      if (this._order) {
        const { column, ascending } = this._order
        rows = [...rows].sort((a, b) => {
          const av = String(a[column] ?? '')
          const bv = String(b[column] ?? '')
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av)
        })
      }

      if (this._limit != null) rows = rows.slice(0, this._limit)
      return Promise.resolve({ data: rows.map((r) => project(r, this.columns)), error: null }).then(resolve, reject)
    } catch (err) {
      return Promise.resolve({ data: null, error: err }).then(resolve, reject)
    }
  }
}

/**
 * Vector search stand-in. Mirrors the SQL exactly on the points that matter:
 * rows whose stored `dim` differs from the query dimension are EXCLUDED, and so
 * are rows whose embedding-space identity differs from the caller's. The model
 * filter is the one that stops vectors from two unrelated embedding spaces being
 * compared - keep it in step with sql/memory_intelligence.sql.
 */
function matchVectors(rows, userId, vector, minSimilarity, limit, model) {
  const qDim = Array.isArray(vector) ? vector.length : 0
  const scored = []
  for (const r of rows) {
    if (r.user_id !== userId) continue
    if (r.dim !== qDim) continue
    if (model != null && r.model !== model) continue
    const sim = cosine(vector, r.embedding)
    if (sim >= (minSimilarity ?? 0)) scored.push({ memory_id: r.memory_id, similarity: Number(sim.toFixed(6)) })
  }
  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, Math.min(Math.max(limit ?? 12, 1), 100))
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

/** The client handed to the real retrieval service. */
export function createFakeSupabase({ userId, memories = [], vectors = [] }) {
  return {
    __userId: userId,
    __memories: memories,
    __vectors: vectors,
    from(table) {
      // The retrieval service reads `memories`; the drift diagnostic reads
      // `memory_vectors`. Both are RLS-scoped the same way.
      if (table === 'memory_vectors') {
        const q = new Query(vectors, userId)
        return q
      }
      if (table !== 'memories') {
        throw new Error(`eval harness: unexpected table "${table}"`)
      }
      return new Query(memories, userId)
    },
    rpc(fn, args) {
      if (fn !== 'match_memory_vectors') {
        return Promise.resolve({ data: null, error: new Error(`eval harness: unexpected rpc "${fn}"`) })
      }
      return Promise.resolve({
        data: matchVectors(vectors, userId, args.p_query, args.p_min_similarity, args.p_limit, args.p_model),
        error: null,
      })
    },
  }
}
