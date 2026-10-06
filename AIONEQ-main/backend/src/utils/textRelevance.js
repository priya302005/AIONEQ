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
  // Frequency adverbs and filler verbs. These carry no retrieval signal but the
  // prefix-tolerant stemmer would still match them inside ordinary words
  // ("ever" in "every"), which inflates irrelevant memories.
  'ever', 'never', 'always', 'often', 'sometimes', 'usually', 'still',
  'get', 'got', 'go', 'goes', 'went', 'make', 'made', 'say', 'said',
])

/*
 * Low-signal words: they still count, but only as a fraction of a real match.
 *
 * Measured failure: "tell me my kodaikalanal journey" retrieved a BE CSE memory
 * purely on the word "journey", because that word appears across unrelated
 * memories. Deleting these outright was tried and is worse - a memory that is
 * genuinely only about a trip then becomes unreachable.
 *
 * Weighting instead of deleting keeps them as a tie-breaker (a memory about
 * journeys still wins over an unrelated one when nothing else matches) while
 * ensuring they can never carry a match on their own.
 */
export const WEAK_TOKENS = new Set([
  'journey', 'journeys', 'trip', 'trips', 'travel', 'story', 'stories',
  'thing', 'things', 'stuff', 'moment', 'moments', 'time', 'times',
  'experience', 'experiences', 'event', 'events', 'detail', 'details',
  'info', 'information', 'share', 'shared', 'sharing', 'tell',
])

const WEAK_TOKEN_WEIGHT = 0.25

/** 1 for a real content token, a fraction for a vague one, 0 for a stopword. */
function tokenWeight(token) {
  if (STOPWORDS.has(token)) return 0
  return WEAK_TOKENS.has(token) ? WEAK_TOKEN_WEIGHT : 1
}

export function contentTokens(text) {
  return tokenize(text).filter((t) => !STOPWORDS.has(t))
}

/** Weighted coverage denominator, so vague words cannot dominate the score. */
function totalWeight(qTokens) {
  let sum = 0
  for (const t of qTokens) sum += tokenWeight(t)
  return sum
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n))
}

/**
 * Bounded Levenshtein distance. Returns `max + 1` once the edit budget is
 * exceeded so hopeless pairs cost nothing to compare.
 */
function editDistance(a, b, max) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      if (row[j] < best) best = row[j]
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[b.length]
}

/*
 * Typo tolerance.
 *
 * Real queries misspell proper nouns all the time - "kodaikalanal" for
 * "Kodaikanal", "jananni" for "Janani", "zoho" for "ZOHO". Prefix matching
 * cannot rescue these because the typo is in the middle of the word, so the
 * place name scored zero and the only surviving signal was a generic word
 * like "journey", which pulled in an unrelated memory.
 *
 * The budget scales with length so short words are not over-matched:
 * 4-6 chars allow 1 edit, 7+ allow 2. Anything shorter stays exact, because
 * allowing an edit there would make nearly every short word match something.
 */
function typoEquals(a, b) {
  const longer = a.length >= b.length ? a : b
  const shorter = a.length >= b.length ? b : a
  if (shorter.length < 4) return false
  const budget = longer.length >= 7 ? 2 : 1
  return editDistance(shorter, longer, budget) <= budget
}

function stemEquals(a, b) {
  if (a === b) return true
  // Prefix/stem tolerance, but avoid matching on 1-2 char tokens ("be"~"been"
  // is fine; "a"~"am" is noise).
  const longer = a.length >= b.length ? a : b
  const shorter = a.length >= b.length ? b : a
  if (longer.length < 3 || shorter.length < 2) return false
  if (longer.startsWith(shorter)) return true
  return typoEquals(a, b)
}

/** Summed weight of the query tokens found in the haystack. */
function tokenHits(qTokens, hayTokens) {
  let hits = 0
  for (const t of qTokens) {
    for (const h of hayTokens) {
      if (stemEquals(h, t)) {
        hits += tokenWeight(t)
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

/*
 * Split a question into independent clauses.
 *
 * Token coverage is "query tokens found in the memory / total query tokens", so
 * a longer question scores *lower* for the same match. Measured on a real
 * failure: the memory scored 0.68 for "tell me my life" but 0.00 for "tell me my
 * life i given journey my name and i am currently study and my dream are given"
 * - 3 content tokens vs 17, same memory, opposite outcome. The user had supplied
 * MORE relevant detail and got LESS recall.
 *
 * Scoring each clause independently and keeping the best match removes that
 * penalty. It cannot manufacture a match: a clause that shares nothing with the
 * memory still scores 0.
 */
export function queryClauses(question) {
  const raw = String(question || '')
  const parts = raw
    .split(/[?!.;,\n]+|\s(?:and|also|then|plus)\s/i)
    .map((s) => s.trim())
    .filter(Boolean)
  // Nothing to gain from splitting a single clause; also avoids scoring "".
  return parts.length > 1 ? parts : [raw]
}

function scoreOneQuestion(question, parts) {
  const qTokens = contentTokens(question)
  if (!qTokens.length) return 0

  const all = (Array.isArray(parts) ? parts : [parts]).filter((p) => p != null && String(p))
  const text = all.join(' ')
  if (!text.trim()) return 0

  const hayTokens = tokenize(text)
  // Divide by total weight, not raw token count, so a question made of vague
  // words scores near zero even when every one of them is present.
  const denominator = totalWeight(qTokens)
  const coverage = denominator ? tokenHits(qTokens, hayTokens) / denominator : 0
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
    const titleCover = denominator ? tokenHits(qTokens, titleTokens) / denominator : 0
    if (titleCover >= 0.5) score += 0.2
  }

  return clamp01(score)
}

/**
 * 0..1 relevance of `question` against an item described by haystack parts.
 *
 * Scores the whole question and each of its clauses, keeping the best: a
 * detailed question should retrieve at least as well as its most relevant
 * fragment, not worse than it.
 */
export function relevanceScore(question, parts) {
  let best = 0
  for (const clause of queryClauses(question)) {
    const s = scoreOneQuestion(clause, parts)
    if (s > best) best = s
  }
  return best
}

/** Normalize a bunch of "Item" objects into a comparable text key for dedup. */
export function textKey(text) {
  return tokenize(text).join(' ')
}

/**
 * Collapse whitespace and cut to `max` characters on a word boundary.
 * Shared by prompt builders so context text never blows past a token budget.
 */
export function truncate(text, max = 500) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (value.length <= max) return value
  const cut = value.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`
}