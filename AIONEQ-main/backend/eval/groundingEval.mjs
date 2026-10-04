/*
 * Grounding & hallucination evaluation - Phase 5.
 *
 *   node eval/groundingEval.mjs           # human report
 *   node eval/groundingEval.mjs --json    # machine-readable
 *
 * Drives the REAL ask controller (src/controllers/query.controller.js)
 * over the same synthetic corpus and questions as the retrieval
 * evaluation (eval/dataset.*.js), through the grounding harness
 * (tests/groundingHarness.mjs): real retrieval, real context
 * building, real citation extraction, a deterministic stub model,
 * and an RLS-correct fake store.
 *
 * For every question it records the full grounding record:
 *   retrievedIds      the memories that actually entered the prompt
 *   excerpts          the exact text the model was shown
 *   answer            the model's reply
 *   citations         the citations that survived validation
 *   unsupportedClaims answer sentences backed by no retrieved excerpt,
 *                     plus any citation that was not retrieved
 *   missingContext    gold memories (dataset ground truth) that were
 *                     NOT retrieved
 *   uncertainty       how absence / weakness / ambiguity was handled
 *
 * The stub model is deliberately well-behaved: it quotes a fragment
 * of every retrieved excerpt and cites it, and emits exactly ONE
 * hallucinated citation to a random id. That makes two things
 * measurable rather than assumed:
 *
 *   1. Citation filtering - the hallucinated citation must NEVER
 *      survive. Any survivor is a regression.
 *   2. Content grounding - every answer sentence must overlap with
 *      a retrieved excerpt. The stub quotes excerpts, so a violation
 *      means the pipeline fed text the answer could not have come
 *      from (or the check itself is wrong).
 *
 * HONEST LIMITATION: the stub is not a language model. What this
 * measures is the CONTRACT the answer is produced under - what the
 * model may see, what it may cite, what it must admit it does not
 * know. Whether a real model's prose stays within those bounds needs
 * a live model and is listed as a production prerequisite.
 */

import { MEMORIES, OTHER_USER_MEMORIES, PRIMARY_USER_ID } from './dataset.memories.js'
import { QUESTIONS, SCENARIOS } from './dataset.questions.js'
import {
  bootstrap,
  store,
  registerUser,
  runAsk,
  setStubBehavior,
  stopStubLLM,
} from '../tests/groundingHarness.mjs'

// ----------------------------------------------------------------- stub ---
/**
 * A well-behaved deterministic model: for every memory block in the
 * prompt, quote a fragment of its excerpt and cite it. Then emit one
 * citation to a random id that was never supplied - the citation
 * filter must drop it.
 */
function groundedStub({ user }) {
  const text = String(user || '')
  const blocks = text.split(/\n\n/).filter((b) => /\bid: [0-9a-fA-F-]{36}/.test(b))
  const lines = []
  for (const block of blocks) {
    const idMatch = block.match(/\bid: ([0-9a-fA-F-]{36})/)
    if (!idMatch) continue
    const id = idMatch[1].toLowerCase()
    // The excerpt is everything after the header line(s).
    const lines_ = block.split('\n')
    const headerEnd = lines_.findIndex((l) => !l.startsWith('[') && !l.startsWith('topics:') && !l.startsWith('('))
    const excerpt = lines_.slice(Math.max(0, headerEnd)).join(' ').replace(/\s+/g, ' ').trim()
    const fragment = excerpt.slice(0, 72)
    lines.push(`from my notes: "${fragment}" (cite: ${id})`)
  }
  const hallucinated = randomId()
  lines.push(`a personal detail I seem to recall (cite: ${hallucinated})`)
  return [
    lines.join(' '),
    '---FOLLOW-UPS---',
    '1) What else should I know?',
    '2) Can you tell me more?',
    '3) Any other details?',
  ].join('\n')
}

function randomId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ------------------------------------------------------------ measuring ---
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'was', 'is', 'are', 'were', 'be', 'been', 'being', 'it', 'its', 'i', 'you',
  'your', 'my', 'me', 'we', 'they', 'them', 'that', 'this', 'these', 'those',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
  'should', 'not', 'no', 'but', 'if', 'so', 'as', 'by', 'from', 'about',
])

function contentTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 3 && !STOP.has(t))
}

function sentences(text) {
  return String(text || '')
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * A sentence is "supported" when at least one of its content words
 * (length > 3) appears in the retrieved excerpts. Quoted fragments
 * pass by construction; an invented name, date or number fails.
 *
 * The stub deliberately emits one probe sentence ("a personal
 * detail I seem to recall") per model call to prove detection
 * works. Those are counted separately from genuine violations.
 */
const PROBE_MARKER = 'personal detail i seem to recall'

function unsupportedSentences(answer, excerpts) {
  const haystack = new Set()
  for (const excerpt of excerpts) {
    for (const t of contentTokens(excerpt)) haystack.add(t)
  }
  const bad = []
  const probes = []
  for (const sentence of sentences(answer)) {
    const words = contentTokens(sentence)
    if (!words.length) continue
    if (sentence.toLowerCase().includes(PROBE_MARKER)) {
      probes.push(sentence)
      continue
    }
    const supported = words.some((w) => haystack.has(w))
    if (!supported) bad.push(sentence)
  }
  return { bad, probes }
}

// ------------------------------------------------------------------ run ---
async function main() {
  registerUser(PRIMARY_USER_ID)
  await bootstrap()
  setStubBehavior(groundedStub)

  store.reset()
  for (const row of [...MEMORIES, ...OTHER_USER_MEMORIES]) {
    store.memories.push({ ...row })
  }

  const records = []
  for (const item of QUESTIONS) {
    // Fresh conversation state per question: the ask flow
    // persists a conversation for every question, and prior
    // conversations are a legitimate context source - so a
    // shared store would let question N be "answered" by the
    // history of questions 1..N-1. Each question is measured
    // against the archive alone.
    store.conversations = []

    const result = await runAsk({ userId: PRIMARY_USER_ID, question: item.question })

    const retrieved = (result.body?.usedMemories || []).map((m) => m.memoryId)
    const cited = (result.body?.citedMemories || []).map((m) => m.memoryId)
    const gold = (item.gold || []).map((g) => g.id ?? g)

    // Excerpts the model was actually shown, keyed by memory id.
    const excerpts = []
    if (result.prompt.user) {
      for (const block of result.prompt.user.split(/\n\n/)) {
        const idMatch = block.match(/\bid: ([0-9a-fA-F-]{36})/)
        if (!idMatch) continue
        const id = idMatch[1].toLowerCase()
        const blockLines = block.split('\n')
        const headerEnd = blockLines.findIndex(
          (l) => !l.startsWith('[') && !l.startsWith('topics:') && !l.startsWith('(')
        )
        excerpts.push({
          id,
          text: blockLines.slice(Math.max(0, headerEnd)).join(' ').replace(/\s+/g, ' ').trim(),
        })
      }
    }
    const excerptTexts = excerpts.map((e) => e.text)

    // Citation-level grounding: every surviving citation must be a
    // retrieved id. (The stub also emits one hallucinated citation;
    // if it survived, that is a hard failure.)
    const unsupportedCitations = cited.filter((id) => !retrieved.includes(id))

    // Content-level grounding: answer sentences with no lexical
    // support in the retrieved excerpts. The stub's deliberate
    // probe sentence is counted separately - its presence proves
    // the detector works, it is not a pipeline regression.
    // When nothing was retrieved the answer is the designed
    // honest fallback, not an unsupported claim.
    const { bad, probes } =
      excerptTexts.length > 0
        ? unsupportedSentences(result.body?.answer || '', excerptTexts)
        : { bad: [], probes: [] }

    // Missing relevant context: gold memories the retriever missed.
    const missingGold = gold.filter((id) => !retrieved.includes(id))

    // Uncertainty handling.
    let uncertainty
    if (item.expectNoAnswer) {
      if (result.llmCalls === 0) {
        uncertainty = 'honest-fallback: model not asked, absence stated plainly'
      } else if (item.adjacent) {
        // Adjacent memories were retrieved on purpose (so the model
        // can say "I found a blood test but no blood group").
        // Whether the PROSE hedges depends on the model; the stub
        // cannot hedge, so this is recorded, not failed.
        uncertainty = 'adjacent-context retrieved (by design); prose hedging is model-dependent'
      } else if (/couldn't find|don't want to guess|not mention/i.test(result.body?.answer || '')) {
        uncertainty = 'hedged: absence acknowledged in the answer'
      } else {
        uncertainty = 'UNSUPPORTED: answered without grounding'
      }
    } else if (result.prompt.system && /weak match/i.test(result.prompt.system)) {
      uncertainty = 'low-confidence flag shown to the model'
    } else if (result.prompt.system && /More than one memory fits about equally/i.test(result.prompt.system)) {
      uncertainty = 'ambiguity flag shown to the model'
    } else {
      uncertainty = 'confident: sufficient grounding retrieved'
    }

    records.push({
      scenario: item.scenario,
      question: item.question,
      adjacent: Boolean(item.adjacent),
      retrievedIds: retrieved,
      excerpts,
      answer: result.body?.answer || '',
      citations: cited,
      unsupportedCitations,
      unsupportedClaims: bad,
      probeSentencesDetected: probes,
      missingContext: missingGold,
      goldCount: gold.length,
      retrievedCount: retrieved.length,
      uncertainty,
      llmCalls: result.llmCalls,
      status: result.status,
    })
  }

  await stopStubLLM()

  // ----------------------------------------------------------- summary --
  const answerable = records.filter((r) => r.scenario !== 'no_answer')
  const noAnswer = records.filter((r) => r.scenario === 'no_answer')

  const summary = {
    questions: records.length,
    answerable: answerable.length,
    noAnswer: noAnswer.length,
    // Citation integrity: the stub emits exactly one hallucinated
    // citation per model call. Every one must be dropped.
    modelCitationsEmitted: answerable.filter((r) => r.llmCalls > 0).length,
    hallucinatedCitationsSurvived: records.reduce((n, r) => n + r.unsupportedCitations.length, 0),
    // Content grounding. Probe sentences are the stub's deliberate
    // unsupported sentence - detection working as designed.
    questionsWithUnsupportedClaims: records.filter((r) => r.unsupportedClaims.length > 0).length,
    unsupportedClaimSentences: records.reduce((n, r) => n + r.unsupportedClaims.length, 0),
    probeSentencesDetected: records.reduce((n, r) => n + r.probeSentencesDetected.length, 0),
    // Coverage of the ground truth.
    questionsMissingGold: answerable.filter((r) => r.missingContext.length > 0).length,
    goldMemoriesMissed: answerable.reduce((n, r) => n + r.missingContext.length, 0),
    goldMemoriesTotal: answerable.reduce((n, r) => n + r.goldCount, 0),
    // No-answer honesty, split by design intent.
    noAnswerDisjoint: noAnswer.filter((r) => !r.adjacent).length,
    noAnswerDisjointHonest: noAnswer.filter((r) => !r.adjacent && r.llmCalls === 0).length,
    noAnswerAdjacent: noAnswer.filter((r) => r.adjacent).length,
    noAnswerAdjacentRetrieved: noAnswer.filter((r) => r.adjacent && r.retrievedCount > 0).length,
    noAnswerUnsupported: noAnswer.filter((r) => r.uncertainty.startsWith('UNSUPPORTED')).length,
    // Cross-user leakage: the other user's ids must never appear.
    foreignIdsLeaked: records.reduce(
      (n, r) => n + r.retrievedIds.filter((id) => id.startsWith('11111111-0000-4000-8000-00000009')).length,
      0
    ),
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ summary, records }, null, 2))
    return
  }

  const pct = (n, d) => `${d ? ((100 * n) / d).toFixed(1) : '0.0'}%`
  console.log('='.repeat(100))
  console.log('ECHO grounding evaluation   questions=' + summary.questions)
  console.log('='.repeat(100))
  console.log('')
  console.log('CITATION INTEGRITY')
  console.log(`  model calls with citations : ${summary.modelCitationsEmitted}`)
  console.log(`  hallucinated ids survived  : ${summary.hallucinatedCitationsSurvived}  (must be 0)`)
  console.log('')
  console.log('CONTENT GROUNDING')
  console.log(`  questions with unsupported claims : ${summary.questionsWithUnsupportedClaims} / ${summary.questions}`)
  console.log(`  unsupported claim sentences       : ${summary.unsupportedClaimSentences}`)
  console.log(`  probe sentences detected (stub)   : ${summary.probeSentencesDetected}  (detector self-test)`)
  console.log('')
  console.log('GROUND-TRUTH COVERAGE (answerable questions)')
  console.log(`  questions missing a gold memory : ${summary.questionsMissingGold} / ${summary.answerable}`)
  console.log(`  gold memories missed            : ${summary.goldMemoriesMissed} / ${summary.goldMemoriesTotal} (${pct(summary.goldMemoriesMissed, summary.goldMemoriesTotal)})`)
  console.log('')
  console.log('NO-ANSWER HONESTY')
  console.log(`  disjoint questions (no topic in archive) : ${summary.noAnswerDisjoint}, honest fallback (model not asked) : ${summary.noAnswerDisjointHonest}`)
  console.log(`  adjacent questions (topic exists, fact absent) : ${summary.noAnswerAdjacent}, adjacent context retrieved (by design) : ${summary.noAnswerAdjacentRetrieved}`)
  console.log(`  unsupported answers               : ${summary.noAnswerUnsupported} / ${summary.noAnswer}`)
  console.log('')
  console.log('CROSS-USER LEAKAGE')
  console.log(`  foreign ids in any answer context : ${summary.foreignIdsLeaked}  (must be 0)`)
  console.log('')

  // Per-scenario detail.
  console.log('-'.repeat(100))
  console.log('BY SCENARIO')
  console.log('-'.repeat(100))
  for (const s of SCENARIOS) {
    const rows = records.filter((r) => r.scenario === s)
    if (!rows.length) continue
    const missing = rows.filter((r) => r.missingContext.length)
    const unsupported = rows.filter((r) => r.unsupportedClaims.length)
    console.log(
      `${s.padEnd(14)} n=${String(rows.length).padStart(2)}  missing-gold=${String(missing.length).padStart(2)}  unsupported=${String(unsupported.length).padStart(2)}`
    )
  }
  console.log('')

  // Worst offenders, for root-cause work.
  const worst = records
    .filter((r) => r.missingContext.length || r.unsupportedClaims.length || r.unsupportedCitations.length)
    .slice(0, 10)
  if (worst.length) {
    console.log('-'.repeat(100))
    console.log('QUESTIONS NEEDING ATTENTION (up to 10)')
    console.log('-'.repeat(100))
    for (const r of worst) {
      console.log(`[${r.scenario}] ${r.question}`)
      if (r.missingContext.length) console.log(`   missing gold      : ${r.missingContext.join(', ')}`)
      if (r.unsupportedCitations.length) console.log(`   unsupported cites : ${r.unsupportedCitations.join(', ')}`)
      for (const claim of r.unsupportedClaims.slice(0, 3)) console.log(`   unsupported claim : "${claim.slice(0, 110)}"`)
      console.log(`   retrieved         : ${r.retrievedIds.length}, answer: "${r.answer.slice(0, 110)}"`)
    }
  }
}

await main()
