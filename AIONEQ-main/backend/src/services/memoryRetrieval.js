/*
 * Hybrid memory retrieval.
 *
 * The question this module answers: "given what this user asked, which of THEIR
 * memories are actually about it?" It must work when the user describes an
 * event with completely different words than the memory used, so keyword
 * matching alone is not enough - and it must not dump the whole archive into
 * the model.
 *
 * Three independent signals are gathered, then blended:
 *
 *   1. SEMANTIC   - cosine similarity between the question vector and each
 *                   memory vector, via the RLS-scoped match_memory_vectors RPC.
 *                   This is what catches "why am I nervous about my next
 *                   interview?" against "I struggled to explain my answers
 *                   confidently during the HR interview".
 *   2. KEYWORD    - Postgres full-text search over search_vector (which covers
 *                   title, content, transcript, extracted text, tags, topics,
 *                   keywords, entities and the AI summary).
 *   3. LEXICAL    - the existing in-process relevanceScore, which is good at
 *                   entity matches and title matches.
 *
 * Then: metadata filters (type / status), a relevance floor, near-duplicate
 * removal, a context budget, and finally a bounded selection.
 *
 * Ownership is enforced three times over: RLS on every query, an explicit
 * user_id filter on every result, and the fact that the vector RPC runs as the
 * invoker. Retrieval cannot cross users by construction.
 *
 * Every function here returns a plain array or object. Failures degrade to a
 * weaker signal rather than throwing, so an out-of-date schema still yields
 * keyword retrieval instead of an error.
 */

import { createClient } from '@supabase/supabase-js'
import { config } from '../config/config.js'
import { relevanceScore } from '../utils/textRelevance.js'
import { sanitizeExcerpt } from '../utils/promptSafety.js'
import { embed, activeEmbeddingIdentity } from '../utils/llmClient.js'
import { questionEmbeddingText } from '../utils/embeddings.js'
import { matchMemoryVectorsWithClient } from '../models/memory.model.js'

const SNIPPET_LENGTH = 500
const MAX_CANDIDATES = 60

/** Valid values for the internal `strategy` option. Anything else means hybrid. */
const RETRIEVAL_STRATEGIES = new Set(['hybrid', 'lexical', 'vector'])

/** Columns retrieval needs. Derived columns are optional (migration may be old). */
const EXT_COLUMNS =
  'id,user_id,type,title,content,transcript,extracted_text,tags,event_date,created_at,updated_at,' +
  'ai_summary,topics,keywords,entities,processing_status,source_kind'
const BASE_COLUMNS = 'id,user_id,type,title,content,tags,event_date,created_at,updated_at'

function clientFor(token) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

function truncate(text, max = SNIPPET_LENGTH) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function dateValue(m) {
  const n = Date.parse(m?.event_date || m?.updated_at || m?.created_at || 0)
  return Number.isFinite(n) ? n : 0
}

/** Everything searchable about a memory, as one string. */
function haystack(m) {
  return [
    m.title,
    m.content,
    m.transcript,
    m.extracted_text,
    m.ai_summary,
    Array.isArray(m.tags) ? m.tags.join(' ') : '',
    Array.isArray(m.topics) ? m.topics.join(' ') : '',
    Array.isArray(m.keywords) ? m.keywords.join(' ') : '',
    Array.isArray(m.entities) ? m.entities.join(' ') : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** The excerpt handed to the model. Prefers real user words over a summary. */
function bestSnippet(m) {
  const userText = m.content || m.transcript || m.extracted_text || ''
  if (userText.trim()) return truncate(userText, SNIPPET_LENGTH)
  // No user prose (rare: an empty voice file). Fall back to the AI summary,
  // which is derived from the memory and clearly labelled as such by the caller.
  return truncate(m.ai_summary || m.title, SNIPPET_LENGTH)
}

// ------------------------------------------------------- signal 1: vector ---

async function semanticCandidates(client, userId, question, limit) {
  if (config.embeddingMode === 'off') return new Map()

  // Refuse to search an embedding space we cannot name. This happens when
  // EMBEDDING_MODE=remote without EMBEDDING_MODEL: without an identity we could
  // not tell our own vectors from another model's, so semantic search is skipped
  // and keyword retrieval carries the answer rather than risking a cross-space
  // false positive.
  const model = activeEmbeddingIdentity()
  if (!model) return new Map()

  let embedded
  try {
    embedded = await embed({ input: questionEmbeddingText(question) })
  } catch {
    return new Map() // provider down or misconfigured: keyword retrieval still works
  }
  if (!embedded?.vector?.length) return new Map()

  // The RPC goes through the SAME client the caller supplied, so it is already
  // bound to the caller's token and the memory_vectors RLS policy still applies.
  const rows = await matchMemoryVectorsWithClient(client, {
    userId,
    vector: embedded.vector,
    minSimilarity: config.vectorMinSimilarity,
    limit,
    model,
  })
  return new Map(rows.map((r) => [r.memoryId, r.similarity]))
}

/**
 * Fetches the real memory rows for ids that only the vector search found.
 *
 * This exists because of a genuine defect found during the Phase 2 evaluation:
 * candidate gathering originally built its pool from keyword + recency results
 * ONLY, so a memory that vector search matched but full-text search missed was
 * discarded. With an archive larger than the recency window that silently
 * removes the one signal that exists to catch paraphrases. Without this, hybrid
 * retrieval cannot beat keyword retrieval on the cases it was built for.
 */
async function rowsForIds(client, ids) {
  const missing = [...ids].filter((id) => id)
  if (!missing.length) return []
  try {
    const { data, error } = await client
      .from('memories')
      .select(EXT_COLUMNS)
      .in('id', missing)
    if (!error && Array.isArray(data)) return data
  } catch {
    /* fall through to the base column set */
  }
  try {
    const { data, error } = await client.from('memories').select(BASE_COLUMNS).in('id', missing)
    if (!error && Array.isArray(data)) return data
  } catch {
    /* nothing to add */
  }
  return []
}

// ------------------------------------------------------ signal 2: keyword ---

async function keywordCandidates(client, question, limit) {
  const out = []
  // Try the enriched column set first, then fall back to the base set so an
  // un-migrated database still returns results.
  for (const columns of [EXT_COLUMNS, BASE_COLUMNS]) {
    try {
      const { data, error } = await client
        .from('memories')
        .select(columns)
        .textSearch('search_vector', question, { config: 'english', type: 'websearch' })
        .limit(limit)
      if (!error && data?.length) {
        out.push(...data)
        break
      }
    } catch {
      /* try the next column set */
    }
  }
  return out
}

/** Recency candidates. Also the only way to reach a memory FTS misses. */
async function recencyCandidates(client, limit) {
  try {
    const { data, error } = await client
      .from('memories')
      .select(BASE_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (!error && data) return data
  } catch {
    /* table missing */
  }
  return []
}

// ------------------------------------------------------------- scoring -----

/**
 * Calibrates a raw cosine into 0..1 against this vectorizer's actual range.
 *
 * WHY THIS IS NEEDED - measured, not assumed. On the evaluation corpus
 * (backend/eval, 51 memories, 54 questions) the local hashed vectorizer produces
 * cosine values that look like this:
 *
 *     gold question->memory pairs   p25 0.062  p50 0.203  p75 0.313
 *     non-gold pairs                p25 0.043  p50 0.081  p75 0.149
 *
 * A good match therefore scores about 0.2-0.35, NOT 0.8. Feeding that straight
 * into a blend weighted for a 0..1 signal means a strong semantic match can
 * never outrank a weak keyword match. The previous version of this file had
 * exactly that bug and it made hybrid retrieval score WORSE than either of its
 * own components (measured: hybrid top-1 accuracy 27.9% vs vector-only 51.2%).
 *
 * The mapping is a documented affine rescale from the noise floor
 * (VECTOR_MIN_SIMILARITY, the measured non-gold 95th percentile) up to
 * VECTOR_SIMILARITY_ANCHOR (the measured gold 95th percentile). Both constants
 * are configuration, not magic numbers baked into the formula.
 *
 * CALIBRATION WARNING: both defaults were derived from the synthetic evaluation
 * corpus. Re-derive them against real user archives before production - see
 * backend/eval/runRetrievalEval.mjs and the note in .env.example.
 */
export function calibrateSimilarity(cosineValue) {
  if (!Number.isFinite(cosineValue)) return 0
  const floor = config.vectorMinSimilarity
  const anchor = Math.max(config.vectorSimilarityAnchor, floor + 1e-6)
  const scaled = (cosineValue - floor) / (anchor - floor)
  return Math.max(0, Math.min(1, scaled))
}

/**
 * Blends the three signals into one 0..1 score.
 *
 * DESIGN RULE discovered by the Phase 2 evaluation: there must be exactly ONE
 * formula, and every signal must be on the same 0..1 scale. The previous
 * implementation had two branches - "has vector" and "no vector" - and the two
 * branches returned incomparable numbers (a single-word full-text OR match with
 * no vector scored 0.48 while a genuine cosine-0.55 semantic match scored 0.33).
 * Ranking then followed whichever branch a memory happened to fall into rather
 * than how relevant it actually was.
 *
 * A missing vector score is now simply "no semantic evidence" (0), which keeps
 * the function continuous and monotonic in every input.
 *
 * Weights, all 0..1 and all summing to 1 for the two main terms:
 *   semantic  config.retrievalVectorWeight - how much paraphrase understanding
 *             is trusted relative to literal word overlap.
 *   lexical   the remainder - existing in-process relevanceScore.
 *   keyword   a small fixed bonus, NOT a dominant term. Postgres websearch FTS
 *             ORs query terms, so `keywordMatched` is true for a row that shares
 *             a single common word. Weighting that heavily (it used to be worth
 *             0.45 of the total) collapsed the discrimination that relevanceScore
 *             had already computed.
 */
function blendedScore({
  vectorSimilarity,
  lexical,
  keywordMatched = false,
  strategy = 'hybrid',
  typeFilterBoost = 0,
}) {
  const lexicalPart = Math.max(0, Math.min(1, lexical || 0))
  const semantic = calibrateSimilarity(vectorSimilarity)
  const boost = Number.isFinite(typeFilterBoost) ? typeFilterBoost : 0

  if (strategy === 'lexical') {
    // Keyword evidence is already inside relevanceScore; the bonus only breaks ties.
    return Math.max(0, Math.min(1, lexicalPart + (keywordMatched ? 0.05 : 0) + boost))
  }
  if (strategy === 'vector') {
    return Math.max(0, Math.min(1, semantic + boost))
  }

  const w = config.retrievalVectorWeight
  const blended = w * semantic + (1 - w) * lexicalPart + (keywordMatched ? 0.05 : 0)
  return Math.max(0, Math.min(1, blended + boost))
}

/** Tokens shared by two texts, used to drop near-duplicate results. */
function signature(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
  )
}

function jaccardish(a, b) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.min(a.size, b.size)
}

// -------------------------------------------------------------- public -----

/**
 * Retrieve and rank the authenticated user's memories for a question.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} client RLS-scoped client
 * @param {string} userId
 * @param {string} question
 * @param {object} opts
 * @param {string[]} [opts.types] restrict to these memory types
 * @param {number} [opts.limit] max results
 * @param {number} [opts.minScore] relevance floor
 * @param {'hybrid'|'lexical'|'vector'} [opts.strategy]
 *   Which signals to gather. 'hybrid' is the product behaviour. The other two
 *   exist so retrieval quality can be measured and compared signal-by-signal
 *   (see eval/runRetrievalEval.mjs) - this is an internal service option and is
 *   deliberately NOT accepted from any HTTP request, so a caller cannot ask for
 *   a weaker strategy than the one configured for them.
 * @returns {Promise<Array>} scored memory objects
 */
export async function retrieveMemories(client, userId, question, opts = {}) {
  const q = String(question || '').trim()
  const limit = Math.min(opts.limit ?? config.retrievalMaxMemories, config.retrievalMaxMemories)
  const minScore = opts.minScore ?? 0.1
  if (!q || !userId) return []

  const strategy = RETRIEVAL_STRATEGIES.has(opts.strategy) ? opts.strategy : 'hybrid'
  const useVector = strategy !== 'lexical' && config.embeddingMode !== 'off'
  const useKeyword = strategy !== 'vector'

  const candidateLimit = Math.max(MAX_CANDIDATES, config.retrievalCandidateLimit)

  // --- gather candidates -------------------------------------------------
  const [vectorScores, keywordRows, recencyRows] = await Promise.all([
    useVector ? semanticCandidates(client, userId, q, candidateLimit) : Promise.resolve(new Map()),
    useKeyword ? keywordCandidates(client, q, candidateLimit) : Promise.resolve([]),
    useKeyword ? recencyCandidates(client, Math.floor(candidateLimit / 2)) : Promise.resolve([]),
  ])

  const byId = new Map()
  const absorb = (rows, { keywordMatched = false } = {}) => {
    for (const row of rows || []) {
      if (!row?.id || row.user_id !== userId) continue // explicit owner check
      const existing = byId.get(row.id)
      byId.set(row.id, existing ? { ...existing, ...row, keywordMatched: existing.keywordMatched || keywordMatched } : { ...row, keywordMatched })
    }
  }
  absorb(keywordRows, { keywordMatched: true })
  absorb(recencyRows)

  // A vector hit is an id plus a score, not a row. Fetch the actual memory so a
  // purely-semantic match (paraphrase with no shared keywords) can actually be
  // scored and rendered instead of being dropped for want of a row.
  if (vectorScores.size) {
    const missing = [...vectorScores.keys()].filter((id) => !byId.has(id))
    absorb(await rowsForIds(client, missing))
  }

  // Vector hits are ids only; their rows arrive via keyword/recency. Any vector
  // id we have no row for cannot be used (we must never render an id-only stub),
  // so it is simply not a candidate.
  if (!byId.size) return []

  // --- score -------------------------------------------------------------
  const typeSet = Array.isArray(opts.types) && opts.types.length ? new Set(opts.types) : null
  const scored = []

  for (const m of byId.values()) {
    if (typeSet && !typeSet.has(m.type)) continue
    // A memory that failed processing has no usable text; never rank it as a
    // confident answer source.
    if (m.processing_status === 'failed') continue

    const parts = [m.title, m.content, m.transcript, m.extracted_text, ...(m.tags || []), ...(m.keywords || []), ...(m.entities || []), ...(m.topics || [])]
    const lexical = relevanceScore(q, parts)
    // An AI summary is derived, so it is a weaker signal than the user's words.
    let summarySignal = 0
    if (m.ai_summary && lexical < 0.05) summarySignal = relevanceScore(q, [m.ai_summary]) * 0.45
    const bestLexical = Math.max(lexical, summarySignal)
    const hasVector = vectorScores.has(m.id)

    // A candidate must have at least one REAL relevance signal. Full-text search
    // ORs query words, so a row can match on a single common word and earn the
    // `keywordMatched` bonus while sharing nothing meaningful with the question.
    // Counting that as a hit is exactly how an unrelated memory ends up in the
    // prompt and gets cited, so it is excluded here.
    if (!hasVector && bestLexical < 0.05) continue

    const score = blendedScore({
      vectorSimilarity: hasVector ? vectorScores.get(m.id) : null,
      lexical: bestLexical,
      keywordMatched: m.keywordMatched,
      strategy,
      // A small nudge for memories whose type the caller asked about.
      typeFilterBoost: typeSet ? 0.05 : 0,
    })

    scored.push({ m, score, hasVector })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return dateValue(b.m) - dateValue(a.m) // newer first as a stable tiebreak
  })

  // --- floor + dedup -----------------------------------------------------
  const selected = []
  const seenSignatures = []
  for (const { m, score, hasVector } of scored) {
    if (score < minScore) break
    const sig = signature(bestSnippet(m))
    // Near-duplicates add noise, not information. Keep the better-scoring one.
    if (sig.size && seenSignatures.some((s) => jaccardish(sig, s) >= 0.85)) continue
    seenSignatures.push(sig)

    const { text: snippet, injection } = sanitizeExcerpt(bestSnippet(m), m.id, userId)
    selected.push({
      memoryId: m.id,
      title: m.title,
      type: m.type,
      eventDate: m.event_date,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
      snippet,
      // True when the excerpt is the AI summary rather than the user's words.
      excerptIsSummary: !(m.content || '').trim() && !(m.transcript || '').trim() && !(m.extracted_text || '').trim() && Boolean(m.ai_summary),
      aiSummary: m.ai_summary || null,
      topics: Array.isArray(m.topics) ? m.topics : [],
      hasFile: Boolean(m.file_url),
      processingStatus: m.processing_status || 'ready',
      injection,
      score: Number(score.toFixed(4)),
      matchedBy: [
        hasVector ? 'semantic' : null,
        m.keywordMatched ? 'keyword' : null,
        score > 0 ? 'lexical' : null,
      ]
        .filter(Boolean)
        .join('+'),
    })
    if (selected.length >= limit) break
  }

  return selected
}

/**
 * Records which memory answered a question, so relevance can be reviewed later
 * without ever logging the user's memory text. Only ids, scores and counts.
 */
export async function recordRetrievalTrace(token, userId, question, results) {
  if (!config.contextDebug) return
  console.log(
    `[MEMORY RETRIEVAL] ${JSON.stringify({
      userId,
      questionLength: String(question || '').length,
      selected: results.map((r) => ({ id: r.memoryId, score: r.score, matchedBy: r.matchedBy })),
    })}`
  )
}

export { blendedScore }