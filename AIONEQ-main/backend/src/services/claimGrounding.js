/*
 * Claim grounding and citation validation.
 *
 * THE PROBLEM THIS SOLVES. Before this module, a citation was validated but the
 * SENTENCE carrying it was not. If a model answered "your sister Mara moved to
 * Lisbon in 2019 (cite: <a real, retrieved id>)" about memories that mention a
 * brother and a trip to Porto, the citation passed - it was a genuine retrieved
 * id - and the fabricated personal fact was shown to the user as established.
 * The prompt asked for grounding; nothing checked it.
 *
 * WHAT IT DOES. Purely and deterministically, with no model call:
 *
 *   1. Splits the answer into sentences, keeping (cite: <id>) markers attached
 *      to the sentence they belong to.
 *   2. Resolves each marker against the ids that were ACTUALLY supplied for this
 *      request.
 *   3. Applies three rules (below) and returns the text the user may see, plus
 *      the ids the citation chips may be built from.
 *
 * THE THREE RULES, in order of strictness.
 *
 *   R1  A marker naming an id that was not supplied is DELETED from the answer
 *       text and never returned. Zero false positives: the id either was or was
 *       not in this request's retrieved set. This is the security boundary - it
 *       is what stops a foreign, stale, or model-invented id from ever reaching
 *       citedMemories.
 *
 *   R2  A sentence that still carries a valid marker is KEPT. The system prompt
 *       requires a marker on every personal claim, so a cited sentence is
 *       grounded by the citation contract. Deleting a faithful paraphrase here
 *       would be the worst bug this module could have - silently destroying a
 *       correct answer. Weak attribution is measured (weakAttributions) instead
 *       of being filtered, so the evaluation can report it.
 *
 *   R3  A sentence with NO surviving marker is kept only if it shares evidence
 *       vocabulary with the excerpts that were supplied. Zero overlap is the
 *       strongest lexical evidence of invention available without a second model
 *       call, so such a sentence is removed. Short sentences and conversational
 *       scaffolding are exempt.
 *
 * THE ONE JUDGEMENT CALL. R3 can remove a correct answer that happens to share
 * no content word with its own source. That failure degrades to an explicit
 * "I could not find that" rather than to a wrong answer, which is the safe
 * direction, and eval/aiModelEval.mjs measures the rate so the trade-off is
 * visible instead of hidden.
 *
 * NOTHING HERE IS AN AUTHORIZATION DECISION. Ownership was already enforced by
 * RLS during retrieval. This module only decides what the user is shown, using
 * the same ids retrieval supplied.
 */

import { STOPWORDS } from '../utils/textRelevance.js'

/** Matches both citation forms the system prompt asks for. */
const CITE_RE = /\(\s*cite:\s*([0-9a-fA-F-]{36})\s*\)|\[\s*([0-9a-fA-F-]{36})\s*\]/g

/**
 * Splits on sentence boundaries, newlines, and completed citation markers, so a
 * bulleted multi-memory answer is checked unit by unit rather than as one giant
 * sentence.
 *
 * A citation ends the unit it belongs to, and stays attached to it (the marker
 * is a capture group, so split keeps it). Without this boundary a model that
 * runs several excerpts together ("from my notes: "..." (cite: A) from my
 * notes: "..." (cite: B) you also spent the summer in Lisbon.") produces one
 * fragment holding a valid citation, and an uncited fabrication rides along on
 * its authority.
 */
const UNIT_BREAK_RE =
  /(?<=[.!?])\s+|\n+|((?:\(\s*cite:\s*[0-9a-fA-F-]{36}\s*\)[ \t]*\.?[ \t]*)+)/

function splitSentences(text) {
  const parts = String(text || '')
    .split(UNIT_BREAK_RE)
    // split() inserts undefined where a capture group did not participate.
    .map((s) => (s || '').trim())
    .filter(Boolean)
  return parts.length ? parts : [String(text || '').trim()].filter(Boolean)
}

/**
 * Words that carry no evidentiary weight. Pronouns, connectives, restated
 * dates, and ordinary narrative glue are excluded so that "I", "your", "also"
 * can never be the thing that makes an invented sentence look grounded.
 */
const NON_EVIDENTIAL = new Set([
  ...STOPWORDS,
  'also', 'always', 'back', 'because', 'been', 'being', 'both', 'came', 'come',
  'does', 'doing', 'done', 'else', 'even', 'every', 'from', 'get', 'getting',
  'give', 'given', 'goes', 'going', 'gonna', 'here', 'however', 'into', 'just',
  'kind', 'like', 'little', 'made', 'make', 'many', 'maybe', 'might', 'more',
  'most', 'much', 'need', 'needs', 'never', 'next', 'nothing', 'often', 'only',
  'other', 'others', 'over', 'please', 'quite', 'really', 'said', 'same',
  'says', 'see', 'seen', 'shall', 'since', 'some', 'something', 'still',
  'sure', 'take', 'takes', 'tell', 'than', 'that', 'their', 'them', 'then',
  'there', 'these', 'they', 'thing', 'things', 'think', 'this', 'those',
  'though', 'through', 'thus', 'told', 'took', 'try', 'under', 'until', 'upon',
  'very', 'want', 'wanted', 'well', 'were', 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'whose', 'will', 'with', 'within', 'without', 'would',
  'your', 'yours', 'yes', 'yet', 'you', 'youve',
])

/**
 * Words that mark an assertion ABOUT THE USER rather than talk to them.
 * Deliberately narrow: it has to catch "you moved to Lisbon" without catching
 * "let me know if you want more".
 */
const FACTUAL_CLAIM_RE = new RegExp(
  [
    // first-person statements of fact
    String.raw`\b(?:i|we)\b[^.?!"]{0,80}\b(?:am|is|are|was|were|have|has|had|did|do|does|decided|switched|joined|left|moved|started|stopped|quit|bought|sold|met|visited|live|lives|living|prefer|prefers|preferred|plan|plans|planned|want|wants|wanted|use|used|owns|own|worked|works|studied|study|studying|finished)\b`,
    // second-person statements about the user's history
    String.raw`\byou(?:r)?\b[^.?!"]{0,60}\b(?:are|were|is|was|have|had|did|got|get|said|told|wrote|mentioned|decided|switched|moved|joined|left|started|stopped|quit|accepted|applied|declined|rejected|bought|sold|met|visited|finished|chose|own|owns|prefer|preferred)\b`,
    // a dated personal detail
    String.raw`\b(?:in|on|during|since|until|between)\s+(?:19|20)\d{2}\b`,
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
  ].join('|'),
  'i'
)

/**
 * Conversational scaffolding: an offer, a hedge, an invitation, a question back
 * to the user, an explicit statement that nothing was found, or a reaction.
 * None of these assert a personal fact, so none of them are filtered.
 */
const CONVERSATIONAL_RE = new RegExp(
  [
    String.raw`^\s*(hi|hey|hello|thanks|thank you|ok|okay|sure|got it)\b`,
    String.raw`\b(?:let me know|would you like|do you want|want me to|can i help|anything else|`
      + String.raw`feel free|hope (?:that|this)|good luck|tell me more|ask you (?:a|one|another) `
      + String.raw`follow[- ]up|if you(?:'|’)?d like|is there anything)\b`,
    // the honest path: saying what was NOT found. Both the uncontracted and the
    // contracted spellings are listed: the model almost always writes "I don't
    // have", and the contracted form was missing, so an honest denial could be
    // treated as an unsupported assertion and deleted.
    String.raw`\b(?:could ?n'?t|could not|can ?not|can'?t|did ?n'?t|did not|don'?t|does ?n'?t|`
      + String.raw`does not|do not|doesn'?t|no) (?:find|have|has|had|know|mention|see)\b`,
    String.raw`\bno saved memor|\bno memory of|\bnot in your saved|\bnothing (?:about|in) (?:your|it)\b`,
    // hedged interpretation - allowed to stand, and never a bare fact
    String.raw`\b(?:may be|might be|possibly|perhaps|it'?s possible|could mean|seems|`
      + String.raw`suggests|sounds? like|one (?:reason|possibility)|may also|likely)\b`,
    // evaluative reactions ("that sounds great", "that is a lovely commitment")
    String.raw`^\s*(?:that|it|this|those|these)?\s*(?:sounds?|seems?|is|are|was|were|feels?)\s+`
      + String.raw`(?:an?\s+)?(?:good|great|nice|lovely|wonderful|amazing|awesome|rough|tough|hard|`
      + String.raw`a lot|like a lot|right|true|honest|clear)\b`,
    // questions back to the user
    String.raw`\?\s*$`,
  ].join('|'),
  'i'
)

/**
 * A statement that something is ABSENT: "I don't have a name", "there is no
 * record of your passport", "I couldn't find that".
 *
 * These matter more than they look. A denial is mostly built from the very words
 * it denies, so lexical support is inverted for it: "I don't have a name" scores
 * full support against a memory reading "my name is Janani", purely because
 * "name" appears in both. Treating that overlap as evidence would let a denial be
 * reported as a grounded fact - the one failure mode grounding must never produce,
 * because it turns "I know nothing" into a confident answer.
 *
 * So a denial is never counted as a supported claim, whatever it overlaps. It is
 * also kept rather than deleted: an honest "I don't have that" is truthful, and
 * deleting it would replace honesty with silence.
 */
const DENIAL_RE = new RegExp(
  [
    // Contracted forms. CONVERSATIONAL_RE covers "do not have" but not "don't
    // have", which is how the phrase actually reaches the model.
    String.raw`\b(?:don'?t|doesn'?t|didn'?t|could ?n'?t|can'?t|won'?t|would ?n'?t|`
      + String.raw`should ?n'?t|isn'?t|aren'?t|wasn'?t|weren'?t)\s+`
      + String.raw`(?:have|has|had|know|knows|knowing|find|finds|found|see|sees|seen|`
      + String.raw`mention|mentions|stated|state|say|says|record|records)\b`,
    // Uncontracted equivalents.
    String.raw`\b(?:do|does|did|is|are|was|were|could|can|will|would|should) not\s+`
      + String.raw`(?:have|has|had|know|find|see|mention|record)\b`,
    // Absence phrased as a noun.
    String.raw`\b(?:no|none|not any|neither|nor)\s+(?:record|records|memory|memories|`
      + String.raw`mention|mentions|details?|information|info|recordings?)\b`,
    String.raw`\b(?:there (?:is|are|was|were) no|nothing (?:about|in|on|for))\b`,
    String.raw`\bnot in your saved\b|\bno saved memor`,
  ].join('|'),
  'i'
)

/** A quoted passage is the user speaking, not the model asserting. */
const QUOTE_RE = /["“][^"”]{4,}["”]/

/** Content words of a sentence, evidence-bearing only. */
function evidenceWords(text) {
  const words = normalize(text)
    .toLowerCase()
    .match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) || []
  const out = new Set()
  for (const w of words) {
    if (w.length < 4) continue
    if (STOPWORDS.has(w) || NON_EVIDENTIAL.has(w)) continue
    out.add(w)
  }
  return out
}

/** Naive suffix folding so "moved"/"moving"/"moves" compare equal. */
function fold(word) {
  for (const suffix of ['ingly', 'edly', 'ing', 'ers', 'est', 'ed', 'es', 's']) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix)) {
      return word.slice(0, word.length - suffix.length)
    }
  }
  return word
}

function foldSet(words) {
  const out = new Set()
  for (const w of words) out.add(fold(w))
  return out
}

/** Pre-folds the excerpt of every memory that was supplied for this request. */
function buildEvidenceIndex(memories) {
  const byId = new Map()
  for (const m of memories || []) {
    const id = String(m.memoryId || '').toLowerCase()
    if (!id) continue
    const topics = Array.isArray(m.topics) ? m.topics.join(' ') : String(m.topics || '')
    byId.set(id, foldSet(evidenceWords(`${m.title || ''} ${m.snippet || ''} ${topics}`)))
  }
  return byId
}

/** Share of a sentence's evidence words that appear in `haystack`. */
function supportRatio(sentenceWords, haystack) {
  if (!sentenceWords.size || !haystack.size) return 0
  let hits = 0
  for (const w of sentenceWords) if (haystack.has(w)) hits++
  return hits / sentenceWords.size
}

/**
 * Support threshold for R3. Low on purpose: this catches a wholly invented
 * detail, it does not grade prose. A correct answer paraphrases ("you took the
 * job in Porto" vs "I accepted the Porto offer"), so only near-zero overlap
 * should count as invention.
 */
const CLAIM_SUPPORT_THRESHOLD = 0.34

/**
 * Minimum evidence words before an UNCITED sentence is treated as an assertion
 * worth removing. "You did." carries no claim and is never filtered. A sentence
 * that is recognisably a personal-fact statement bypasses this minimum: "You own
 * a kayak." has one evidence word and must still be caught.
 */
const MIN_ASSERTION_EVIDENCE_WORDS = 2

/** Support share below which a valid citation is flagged as weak attribution. */
const WEAK_ATTRIBUTION_THRESHOLD = 0.34

/**
 * Used when a caller supplies no fallback and filtering leaves nothing. An
 * empty answer string would render as an empty bubble that looks like a bug;
 * saying "I could not find that" is the truthful version of the same event.
 */
const DEFAULT_FALLBACK = 'I could not find that in your memories.'

/**
 * Typographic quotes are normalised before matching. Models emit "don’t" with a
 * curly apostrophe as readily as "don't", and a rule that only recognises the
 * ASCII form would silently stop protecting the honest answer.
 */
function normalize(text) {
  return String(text || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
}

/** Is this sentence conversational scaffolding rather than an assertion? */
function isConversational(sentence) {
  return CONVERSATIONAL_RE.test(normalize(sentence).trim())
}

/**
 * Public: is this sentence making an assertion about the user's life?
 * Kept narrow on purpose, and exported for tests and for the evaluation's
 * claim-density metric.
 */
export function isFactualClaim(sentence) {
  const text = normalize(sentence).trim()
  if (!text || text.length < 12) return false
  if (isConversational(text)) return false
  // A pure question back to the user is not a claim.
  if (text.includes('?') && !FACTUAL_CLAIM_RE.test(text)) return false
  // The user quoted back their own words: a quotation, not an assertion.
  if (QUOTE_RE.test(text) && !/\b(?:you|your)\b/i.test(text)) return false
  return FACTUAL_CLAIM_RE.test(text)
}

/**
 * Validates an answer against the memories that were actually retrieved.
 *
 * @param {object} params
 * @param {string} params.answer  the model's answer text
 * @param {Array}  params.memories retrieved memories ({ memoryId, snippet, ... })
 * @param {string} [params.honestFallback] returned when nothing survives
 * @returns {{
 *   answer: string,
 *   changed: boolean,
 *   supportedClaimCount: number,
 *   citedClaimCount: number,
 *   removedClaims: string[],
 *   removedCitations: string[],
 *   invalidCitations: string[],
 *   citedMemoryIds: string[],
 *   weakAttributions: number,
 * }}
 */
export function groundAnswer({ answer, memories = [], honestFallback = '' } = {}) {
  const text = String(answer || '')
  const index = buildEvidenceIndex(memories)
  // The union is the most generous evidence base any sentence may draw on.
  const allEvidence = new Set()
  for (const set of index.values()) for (const w of set) allEvidence.add(w)

  const keptIds = new Set()
  const invalidCitations = new Set()
  const removedCitations = new Set()
  const removedClaims = []
  const output = []
  let supportedClaimCount = 0
  let citedClaimCount = 0
  let weakAttributions = 0
  let droppedSomething = false
  // Sentences that actually asserted something, as opposed to scaffolding, a
  // hedge, or a denial. Used to tell "the model answered" from "the model only
  // said it had nothing".
  let substantiveKept = 0

  const clean = (s) => s.replace(/\s{2,}/g, ' ').trim()

  for (const sentence of splitSentences(text)) {
    // ---- R1: rewrite every marker in place, keeping only supplied ids. ----
    // Replaced per match by id rather than from a queue, so a removed marker
    // can never consume - and shift onto - a neighbouring valid one.
    const validMarkers = new Set()
    CITE_RE.lastIndex = 0
    let match
    while ((match = CITE_RE.exec(sentence)) !== null) {
      const id = (match[1] || match[2] || '').toLowerCase()
      if (index.has(id)) validMarkers.add(id)
      else {
        // Not one of the ids supplied for this request: fabricated, foreign, or
        // left over from an earlier turn. Never displayed, never returned.
        invalidCitations.add(id)
        removedCitations.add(id)
        droppedSomething = true
      }
    }

    const keptText = clean(
      sentence.replace(CITE_RE, (raw, a, b) =>
        validMarkers.has((a || b || '').toLowerCase()) ? raw : ''
      )
    )

    if (validMarkers.size) {
      // ---- R2: a surviving citation grounds the sentence it is attached to.
      for (const id of validMarkers) keptIds.add(id)
      // A denial that cites a real memory is still a denial, not an answer:
      // "I don't have a name [cite: ...]" must not be reported as a grounded
      // claim just because it pointed at a genuine id.
      if (!DENIAL_RE.test(keptText)) {
        citedClaimCount++
        substantiveKept++
      }
      if (
        supportRatio(foldSet(evidenceWords(sentence.replace(CITE_RE, ' '))), allEvidence) <
        WEAK_ATTRIBUTION_THRESHOLD
      ) {
        // Measured, not filtered: R2 keeps it, the evaluation reports it.
        weakAttributions++
      }
      output.push(keptText)
      continue
    }

    // ---- R3: no surviving citation - is it in the supplied excerpts at all?
    const words = foldSet(evidenceWords(keptText))
    if (supportRatio(words, allEvidence) >= CLAIM_SUPPORT_THRESHOLD) {
      // Support is necessary but not sufficient. A denial borrows its words from
      // the very thing it denies, so overlap alone would let "I don't have a
      // name" pass as a grounded fact whenever "name" is in the evidence.
      // Crediting it here is what turns ignorance into a confident answer.
      if (!DENIAL_RE.test(keptText)) {
        supportedClaimCount++
        substantiveKept++
      }
      output.push(keptText)
      continue
    }

    // No overlap with anything supplied. Only a genuine assertion is removed.
    const minWords = isFactualClaim(keptText) ? 0 : MIN_ASSERTION_EVIDENCE_WORDS
    if (words.size < minWords || isConversational(keptText)) {
      output.push(keptText)
      continue
    }

    removedClaims.push(sentence)
    droppedSomething = true
  }

  let groundedAnswer = output.filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim()

  // Nothing substantive survived: never leave a bare shell or an empty bubble,
  // and never let a filtered answer read as if it were complete.
  if (!groundedAnswer || (removedClaims.length && !citedClaimCount && !supportedClaimCount)) {
    groundedAnswer = honestFallback || DEFAULT_FALLBACK
  }
  // NOTE: no "everything that survived was a denial" override here on purpose.
  // An honest "I couldn't find anything about that in your memories" is a
  // legitimate answer and must reach the user verbatim - it is not replaced by a
  // fallback, because that would trade a truthful reply for a generic one. The
  // denial guard above therefore only stops a denial being *counted* as a
  // grounded claim; it never deletes or rewrites the denial itself.

  return {
    answer: groundedAnswer,
    changed: droppedSomething || groundedAnswer !== text,
    supportedClaimCount,
    citedClaimCount,
    removedClaims,
    removedCitations: [...removedCitations],
    invalidCitations: [...invalidCitations],
    citedMemoryIds: [...keptIds],
    weakAttributions,
  }
}

/**
 * Convenience for callers that only need the validated citation list. Ids that
 * were not supplied are dropped, exactly as before this module existed.
 */
/**
 * Turns a stream of token deltas into whole sentences, as they complete.
 *
 * The safety argument for streaming rests on one property of groundAnswer: it
 * decides each sentence independently. So a sentence can be checked the instant
 * its final punctuation arrives and released to the user without waiting for the
 * rest of the answer - the verdict cannot change later, because no later
 * sentence can retroactively supply the evidence for an earlier one.
 *
 * Yielding whole sentences rather than tokens also means the citation marker
 * `(cite: ...)` is usually still travelling with the sentence it belongs to.
 */
export function createSentenceStream() {
  let pending = ''
  return {
    /** Feeds a delta; returns any sentences that are now complete. */
    push(delta) {
      pending += delta
      const out = []
      // A terminator followed by a space is a sentence boundary. Newlines count
      // too, since models often break lines between sentences.
      let match
      const re = /([^.!?]*[.!?])(?=\s|$)|\n+/g
      let last = 0
      while ((match = re.exec(pending)) !== null) {
        const piece = (match[1] || match[0]).trim()
        if (piece) out.push(piece)
        last = re.lastIndex
      }
      pending = pending.slice(last)
      return out
    },
    /** Whatever is left when generation stops, if it carries meaning. */
    flush() {
      const rest = pending.trim()
      pending = ''
      return rest ? [rest] : []
    },
    /** True when nothing is buffered, i.e. the next delta starts a new thought. */
    get empty() {
      return pending.trim().length === 0
    },
  }
}

export function validatedCitationIds(answer, memories) {
  const index = buildEvidenceIndex(memories)
  const ids = new Set()
  CITE_RE.lastIndex = 0
  let match
  while ((match = CITE_RE.exec(String(answer || ''))) !== null) {
    const id = (match[1] || match[2] || '').toLowerCase()
    if (index.has(id)) ids.add(id)
  }
  return [...ids]
}