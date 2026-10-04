/*
 * Deterministic local text embedder.
 *
 * Why this exists instead of a dependency:
 *   The AI provider is a LOCAL llama.cpp server that must stay on localhost and
 *   must work with no internet. Requiring an API key for embeddings would make
 *   the whole retrieval layer fail closed on the user's machine, and no embedding
 *   means the assistant can only do keyword matching - which fails exactly on
 *   the questions this system exists for ("why am I nervous about my next
 *   interview?" vs "I struggled to explain my answers confidently during the
 *   HR round").
 *
 * What it does:
 *   A hashed bag-of-features vector. Features are:
 *     - word unigrams and bigrams (content words only, lightly stemmed)
 *     - character 4-grams  -> gives morphological robustness
 *                              (confidently ~ confidence, nervous ~ anxiety is
 *                              still partial, "interview"/"interviews" exact)
 *   Each feature is hashed to a bucket, weighted, and the vector is
 *   L2-normalized so cosine similarity is a dot product.
 *
 * Properties that matter here:
 *   - Deterministic: the same text always yields the same vector, so a memory's
 *     stored vector stays valid across restarts and processes.
 *   - No network, no model file, no GPU: ~1ms for a few KB of text.
 *   - Not a transformer. It captures lexical and sub-word similarity well and
 *     abstract semantics only weakly. It is therefore ALWAYS combined with the
 *     Postgres full-text search and the existing lexical scorer (hybrid
 *     retrieval), never used alone.
 *   - Set EMBEDDING_MODE=remote to use llama.cpp /embedding or any
 *     OpenAI-compatible /v1/embeddings endpoint instead. Same 384-d default so
 *     the storage and search layer do not care which backend produced it.
 */

import { contentTokens, STOPWORDS } from './textRelevance.js'

const HASH_PRIME = 0x01000193 // FNV-1a offset basis, mixed for int hashing
const HASH_OFFSET = 0x811c9dc5

function hash(str) {
  let h = HASH_OFFSET
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, HASH_PRIME)
  }
  // Avalanche so neighbouring strings do not land in neighbouring buckets.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * Deliberately tiny suffix stripper. Not a real stemmer: it only folds the
 * inflections that make the same word look different ("planning" vs "plan").
 * Anything more aggressive starts merging distinct words.
 */
function fold(token) {
  if (token.length <= 3) return token
  for (const suffix of ['ingly', 'edly', 'ing', 'ers', 'est', 'ed', 'es', 's']) {
    if (token.length - suffix.length >= 3 && token.endsWith(suffix)) {
      return token.slice(0, token.length - suffix.length)
    }
  }
  return token
}

function charNGrams(text, n = 4) {
  const padded = ` ${text} `
  const grams = []
  for (let i = 0; i + n <= padded.length; i++) {
    grams.push(padded.slice(i, i + n))
  }
  return grams
}

/** Extracts the weighted feature list used for hashing. */
export function embedFeatures(text) {
  const raw = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (!raw) return []

  const features = []
  const words = contentTokens(raw) // stopword-free, so "i" / "the" carry no weight
  const folded = words.map(fold)

  for (const w of folded) features.push([`w:${w}`, 1])
  for (let i = 0; i + 1 < folded.length; i++) {
    features.push([`b:${folded[i]}_${folded[i + 1]}`, 0.8])
  }

  // Sub-word signal: covers spelling variants, plurals, and compound words the
  // word-level features miss. Down-weighted so it refines rather than dominates.
  const textForGrams = folded.join(' ')
  for (const g of charNGrams(textForGrams, 4)) features.push([`c:${g}`, 0.35])

  return features
}

/**
 * L2-normalized embedding of `text` with `dim` buckets (default from config).
 * Never throws; an empty input yields a zero vector, which never matches.
 */
export function embedLocal(text, dim) {
  const size = Math.max(64, Math.floor(dim) || 384)
  const vec = new Array(size).fill(0)
  for (const [feature, weight] of embedFeatures(text)) {
    const bucket = hash(feature) % size
    // Sign from a second hash bit keeps unrelated features from always adding
    // up in the same direction (reduces the "everything looks similar" bias).
    const sign = (hash(`sign:${feature}`) & 1) === 0 ? 1 : -1
    vec[bucket] += weight * sign
  }
  let norm = 0
  for (const v of vec) norm += v * v
  if (norm === 0) return vec
  norm = Math.sqrt(norm)
  for (let i = 0; i < size; i++) vec[i] = Number((vec[i] / norm).toFixed(6))
  return vec
}

/** Cosine similarity of two equal-length vectors (0 on any mismatch). */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

/**
 * Text used to represent a memory in vector space. Deliberately includes the
 * title and the AI summary so a memory whose body is thin is still findable by
 * what it is about.
 */
export function memoryEmbeddingText(memory) {
  return [
    memory?.title,
    memory?.ai_summary,
    memory?.summary,
    Array.isArray(memory?.topics) ? memory.topics.join(' ') : '',
    Array.isArray(memory?.keywords) ? memory.keywords.join(' ') : '',
    Array.isArray(memory?.tags) ? memory.tags.join(' ') : '',
    memory?.transcript,
    memory?.extracted_text,
    memory?.content,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Text used to represent a user QUESTION in vector space. */
export function questionEmbeddingText(question) {
  return String(question || '').trim()
}

/** Strips anything Postgres jsonb would reject, and keeps the array compact. */
export function toJsonVector(vector) {
  return (Array.isArray(vector) ? vector : []).map((v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return 0
    // 6 decimals is far below the noise floor of this scoring model and keeps
    // the stored jsonb roughly half the size of the raw float list.
    return Math.round(n * 1e6) / 1e6
  })
}

/** Identity of the local vectorizer's output space. Bump when the maths changes. */
export const LOCAL_VECTOR_MODEL = 'local-hash-v1'

/**
 * The canonical identity of an embedding space: which model produced a vector,
 * and at what dimension.
 *
 * WHY THIS EXISTS. The `memory_vectors.model` column was being written but never
 * read back. That is not a cosmetic gap - it is a correctness hazard, and a
 * dimension-independent one:
 *
 *   - Change the model at the SAME dimension (local 384 -> a remote 384-d model,
 *     or one remote model to another). `match_memory_vectors` filters on `dim`,
 *     which still matches, so old and new vectors are compared across two
 *     unrelated spaces. Cosine returns confident non-zero numbers for pairs that
 *     have nothing to do with each other. That is a silent FALSE-POSITIVE
 *     generator, which is strictly worse than finding nothing.
 *   - Change the model at a DIFFERENT dimension. The `dim` filter quietly
 *     excludes every stored vector, so most of the archive becomes unsearchable
 *     by meaning with no error, no log line, and no hint to the operator.
 *
 * Storing and matching on this single string makes both cases impossible: a
 * mismatch yields an EMPTY vector result (retrieval falls back to keyword search
 * and the UI reports stale indexing) rather than wrong or missing answers.
 *
 * It is a pure function of configuration on purpose - no network probe, no
 * cache - so the writer and every reader are guaranteed to agree, in any
 * process, at any time.
 *
 * @param {{mode:string, embeddingModel?:string|null, embeddingDim:number}} cfg
 * @returns {string|null} identity, or null when no space is configured
 */
export function embeddingIdentity({ mode, embeddingModel, embeddingDim }) {
  if (mode === 'off') return null
  const dim = Math.max(64, Math.floor(Number(embeddingDim)) || 384)
  if (mode === 'local') return `${LOCAL_VECTOR_MODEL}@${dim}`
  if (mode === 'remote') {
    // A remote provider that reports no model name gives us nothing to key on, so
    // refuse rather than file every vector under the same untraceable label.
    const model = String(embeddingModel || '').trim()
    if (!model) return null
    return `${model}@${dim}`
  }
  return null
}


export { STOPWORDS }