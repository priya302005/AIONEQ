/*
 * Shared dynamic text-relevance scoring.
 *
 * Everything is computed at request time from the actual query and the actual
 * stored text. There are no hardcoded keywords, memory names, or IDs anywhere
 * in this file - an empty table plus a brand-new memory works exactly like a
 * populated one.
 *
 * Signals combined into one 0..1 score:
 *   - token overlap with prefix/stem tolerance (trip ~ trips, plan ~ planning)
 *   - exact normalized-phrase presence (whole question substring)
 *   - entity overlap (capitalized words such as names / product names)
 * The caller supplies the haystack pieces (title, content, tags, keywords...).
 */

export function tokenize(text) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) || []
  )
}

/*
 * Function words are ignored when scoring relevance: a generic "I"/"the"/"for"
 * in the query must never qualify an unrelated memory or conversation. Only
 * content words (nouns/verbs/topics) drive matching. Fully generic list - no
 * user-specific terms anywhere.
 */
export const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'into', 'is', 'it', 'no', 'not', 'of', 'off', 'on', 'or', 'so', 'such',
  'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'those',
  'to', 'was', 'were', 'will', 'with', 'would', 'should', 'could', 'can',
  'may', 'might', 'must', 'shall', 'do', 'does', 'did', 'doing', 'done',
  'have', 'has', 'had', 'having', 'am', 'been', 'being', 'about', 'above',
  'after', 'again', 'against', 'all', 'also', 'any', 'before', 'because',
  'below', 'between', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'same', 'than', 'too', 'very', 'just', 'only', 'own', 'once', 'here',
  'when', 'where', 'why', 'how', 'while', 'during', 'until', 'via', 'up',
  'down', 'over', 'under', 'out',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she',
  'her', 'them', 'us',
  'what', 'which', 'who', 'whom', 'whose',
  'don', "don't", 'doesn', "doesn't", 'didn', "didn't", 'can\'t', 'cant',
  'i\'m', 'im', 'i\'ve', 'ive', 'i\'ll', 'it\'s', 'that\'s',
])

export function contentTokens(text) {
  return tokenize(text).filter((t) => !STOPWORDS.has(t))
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n))
}

function stemEquals(a, b) {
  if (a === b) return true
  // Prefix/stem tolerance, but avoid matching on 1-2 char tokens ("be"~"been"
  // is fine; "a"~"am" is noise).
  const longer = a.length >= b.length ? a : b
  const shorter = a.length >= b.length ? b : a
  if (longer.length < 3 || shorter.length < 2) return false
  return longer.startsWith(shorter)
}

function tokenHits(qTokens, hayTokens) {
  let hits = 0
  for (const t of qTokens) {
    for (const h of hayTokens) {
      if (stemEquals(h, t)) {
        hits++
        break
      }
    }
  }
  return hits
}

function bigramOverlap(qTokens, hayTokens) {
  if (qTokens.length < 2) return 0
  const qBigrams = new Set()
  for (let i = 0; i < qTokens.length - 1; i++) qBigrams.add(`${qTokens[i]}|${qTokens[i + 1]}`)
  const hBigrams = new Set()
  for (let i = 0; i < hayTokens.length - 1; i++) hBigrams.add(`${hayTokens[i]}|${hayTokens[i + 1]}`)
  let hits = 0
  for (const b of qBigrams) if (hBigrams.has(b)) hits++
  return qBigrams.size ? hits / qBigrams.size : 0
}

function entityOverlap(question, text) {
  const names = (s) =>
    (String(s || '').match(/\b[A-Z][a-zA-Z0-9&'-]{1,}\b/g) || []).map((w) => w.toLowerCase())
  const qNames = new Set(names(question))
  const hNames = new Set(names(text))
  if (!qNames.size) return 0
  let hits = 0
  for (const n of qNames) if (hNames.has(n)) hits++
  return Math.min(0.2, hits * 0.1)
}

function normalizedPhrase(question) {
  return String(question || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * 0..1 relevance of `question` against an item described by haystack parts.
 */
export function relevanceScore(question, parts) {
  const qTokens = contentTokens(question)
  if (!qTokens.length) return 0

  const all = (Array.isArray(parts) ? parts : [parts]).filter((p) => p != null && String(p))
  const text = all.join(' ')
  if (!text.trim()) return 0

  const hayTokens = tokenize(text)
  const coverage = qTokens.length ? tokenHits(qTokens, hayTokens) / qTokens.length : 0
  const bigram = bigramOverlap(qTokens, hayTokens) * 0.3

  let phrase = 0
  if (qTokens.length >= 2 && text.includes(normalizedPhrase(question))) phrase = 0.25

  const entity = entityOverlap(question, text)

  let score = coverage + bigram + phrase + entity

  // Title presence is a strong signal: boost when the exact title words form a
  // large part of the question (handles "the interview memory" -> title "Interview").
  const firstPart = String(all[0] || '')
  if (firstPart) {
    const titleTokens = tokenize(firstPart)
    const titleCover = titleTokens.length ? tokenHits(qTokens, titleTokens) / qTokens.length : 0
    if (titleCover >= 0.5) score += 0.2
  }

  return clamp01(score)
}

/** Normalize a bunch of "Item" objects into a comparable text key for dedup. */
export function textKey(text) {
  return tokenize(text).join(' ')
}