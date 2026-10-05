/*
 * Unified inference + claim grounding evaluation - Phase 10.
 *
 *   node --experimental-test-module-mocks eval/aiModelEval.mjs          # report
 *   node --experimental-test-module-mocks eval/aiModelEval.mjs --json   # machine
 *
 * WHAT THIS MEASURES, and what it does not.
 *
 *   1. GROUNDING A/B. The same synthetic corpus and questions are asked twice
 *      through the REAL ask controller, once with AI_CLAIM_GROUNDING on and
 *      once with it off. The difference is the value of the layer: how many
 *      unsupported statements and how many citations to ids that were never
 *      retrieved reach the user in each mode.
 *
 *   2. PROVIDER FAULT BEHAVIOUR, measured rather than asserted. A scripted
 *      local server returns 429 / 500 / 400 / a non-completion / nothing at
 *      all, and a deliberately slow one, so retry counts, the bounded
 *      Retry-After, the timeout deadline and the error taxonomy are reported
 *      as numbers.
 *
 *   3. PROMPT BUDGET. The distribution of prompt characters and retrieved
 *      memories against AI_CONTEXT_MAX_CHARS and QUERY_MAX_MEMORIES.
 *
 *   4. LIVE MODEL QUALITY. Attempted, and reported as NOT MEASURED when no
 *      provider answers. There is no stubbed stand-in for a language model's
 *      prose: the model is either reachable and measured, or this section says
 *      so. Nothing here is inferred from the stub.
 *
 * The stub model used for 1 and 3 is deterministic and quotes the excerpts it
 * was shown, exactly like eval/groundingEval.mjs. That makes the pipeline's
 * contract measurable. It says nothing about how a real model's prose behaves,
 * which is what 4 exists for.
 */

import http from 'node:http'
import { MEMORIES, OTHER_USER_MEMORIES, PRIMARY_USER_ID } from './dataset.memories.js'
import { QUESTIONS } from './dataset.questions.js'
import {
  bootstrap,
  store,
  registerUser,
  runAsk,
  setStubBehavior,
  stopStubLLM,
} from '../tests/groundingHarness.mjs'

// The modules under test are imported AFTER bootstrap(), not at the top of this
// file. The harness starts its stub provider and points process.env at it, so
// anything that captures configuration at import time has to be loaded after
// that - otherwise this evaluation would measure requests to a port nobody is
// listening on.
let config
let generate
let AI_TASK
let resolveGenerationParams
let providerDescriptor
let pingProvider

// ------------------------------------------------------------------ stub ---

function stubId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/**
 * Clips to a whole word. Cutting mid-word ("the old o") invents a fragment no
 * model would emit, and grading it says more about the clipper than about the
 * grounding layer.
 */
function clip(text, max) {
  const s = String(text || '')
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trim()}...`
}

/**
 * Quotes a fragment of every supplied excerpt and cites it, then emits one
 * uncited invented detail and one citation to an id that was never supplied -
 * the two failure modes claim grounding exists to stop.
 */
function adversarialStub({ user }) {
  const text = String(user || '')
  const lines = []
  for (const block of text.split(/\n\n/).filter((b) => /\bid: [0-9a-fA-F-]{36}/.test(b))) {
    const idMatch = block.match(/\bid: ([0-9a-fA-F-]{36})/)
    if (!idMatch) continue
    const id = idMatch[1].toLowerCase()
    const blockLines = block.split('\n')
    const headerEnd = blockLines.findIndex(
      (l) => !l.startsWith('[') && !l.startsWith('topics:') && !l.startsWith('(')
    )
    const excerpt = blockLines
      .slice(Math.max(0, headerEnd))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    lines.push(`from my notes: "${clip(excerpt, 72)}" (cite: ${id})`)
  }
  // Invented, uncited, and specific: exactly what must not survive.
  lines.push('You also spent the summer in Lisbon teaching at a language school.')
  lines.push(`a detail I seem to recall (cite: ${stubId()})`)
  return [
    lines.join(' '),
    '---FOLLOW-UPS---',
    '1) What else should I know?',
    '2) Can you tell me more?',
    '3) Any other details?',
  ].join('\n')
}

// --------------------------------------------------- independent detector ---

const STOP = new Set(
  ('the a an and or of to in on at for with was is are were be been being it its i you your my me we they them ' +
    'that this these those have has had do does did will would can could should not no but if so as by from about')
    .split(' ')
)

function contentTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 3 && !STOP.has(t))
}

// Same unit boundaries the claim layer uses, so this measures the layer on the
// units it actually decides about. Grading on coarser boundaries would let an
// uncited fragment pass on vocabulary that only a cited neighbour supplied.
const UNIT_BREAK_RE =
  /(?<=[.!?])\s+|\n+|((?:\(\s*cite:\s*[0-9a-fA-F-]{36}\s*\)[ \t]*\.?[ \t]*)+)/

function sentences(text) {
  return String(text || '')
    .split(UNIT_BREAK_RE)
    .map((s) => (s || '').trim())
    .filter(Boolean)
}

const CITE_MARKER_RE = /\(\s*cite:\s*([0-9a-fA-F-]{36})\s*\)/

/**
 * Proves the independent grader still bites, on data it has never seen: an
 * uncited sentence about an unrelated subject must be flagged; a cited one, and
 * one quoting its own supplied source, must not be.
 */
function detectorSelfTest() {
  const id = '11111111-0000-4000-8000-000000000001'
  const excerpts = ['I adopted a dog named Biscuit.']
  const unrelated = unsupportedIn('The ferry to Kalymnos was cancelled twice last winter.', excerpts, [id])
  const cited = unsupportedIn(`I adopted a dog named Biscuit (cite: ${id}).`, excerpts, [id])
  const quoting = unsupportedIn(`I adopted a dog named Biscuit.`, excerpts, [id])
  const fabricated = unsupportedIn(
    'I adopted a dog named Biscuit (cite: 99999999-9999-4999-8999-999999999999).',
    excerpts,
    [id]
  )
  return {
    ok:
      unrelated.length === 1 &&
      cited.length === 0 &&
      quoting.length === 0 &&
      fabricated.length === 1,
    uncitedUnrelatedFlagged: unrelated.length,
    citedFlagged: cited.length,
    supportedUncitedFlagged: quoting.length,
    fabricatedIdFlagged: fabricated.length,
  }
}

/**
 * Answer units with no lexical support in the excerpts actually shown.
 *
 * A unit carrying a citation to a memory that was actually supplied passes by
 * construction - the citation is its support, and the layer reports a poor
 * match as weak attribution rather than silently deleting a paraphrase. This
 * metric therefore measures uncited assertions, which is what the layer is for.
 *
 * Deliberately NOT the layer's own code: grading the layer with the layer would
 * make it unfalsifiable.
 */
function unsupportedIn(answer, excerpts, suppliedIds = []) {
  const haystack = new Set()
  for (const e of excerpts) for (const t of contentTokens(e)) haystack.add(t)
  const supplied = new Set(suppliedIds.map((id) => String(id).toLowerCase()))
  const bad = []
  for (const s of sentences(answer)) {
    const words = contentTokens(s)
    if (!words.length) continue
    const cite = s.match(CITE_MARKER_RE)
    if (cite && supplied.has(cite[1].toLowerCase())) continue
    if (!words.some((w) => haystack.has(w))) bad.push(s)
  }
  return bad
}

function excerptsFromPrompt(promptUser) {
  const out = []
  if (!promptUser) return out
  for (const block of String(promptUser).split(/\n\n/)) {
    const idMatch = block.match(/\bid: ([0-9a-fA-F-]{36})/)
    if (!idMatch) continue
    const blockLines = block.split('\n')
    const headerEnd = blockLines.findIndex(
      (l) => !l.startsWith('[') && !l.startsWith('topics:') && !l.startsWith('(')
    )
    out.push({
      id: idMatch[1].toLowerCase(),
      text: blockLines
        .slice(Math.max(0, headerEnd))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    })
  }
  return out
}

// ------------------------------------------------------- the A/B over the corpus --

/** One full pass of the corpus with the claim-grounding flag as given. */
async function pass(groundingEnabled) {
  const original = config.aiClaimGroundingEnabled
  config.aiClaimGroundingEnabled = groundingEnabled
  const records = []
  try {
    for (const item of QUESTIONS) {
      store.conversations = []
      const result = await runAsk({ userId: PRIMARY_USER_ID, question: item.question })
      const excerpts = excerptsFromPrompt(result.prompt.user)
      records.push({
        scenario: item.scenario,
        status: result.status,
        llmCalls: result.llmCalls,
        // The ids actually handed to the model, read back out of the prompt.
        // NOT body.usedMemories: that is a UI-sized preview slice, so using it
        // here would report a supplied citation as fabricated.
        suppliedIds: excerpts.map((e) => e.id),
        // The preview list the client receives, for the budget report only.
        previewIds: (result.body?.usedMemories || []).map((m) => m.memoryId),
        citedIds: (result.body?.citedMemories || []).map((m) => m.memoryId),
        excerpts,
        promptChars: String(result.prompt.system || '').length + String(result.prompt.user || '').length,
        answer: result.body?.answer || '',
      })
    }
  } finally {
    config.aiClaimGroundingEnabled = original
  }

  // Graded by the independent detector, not by the layer under test.
  for (const r of records) {
    r.unsupportedClaims = r.excerpts.length
      ? unsupportedIn(r.answer, r.excerpts.map((e) => e.text), r.suppliedIds)
      : []
    r.citationsNotSupplied = r.citedIds.filter((id) => !r.suppliedIds.includes(id))
  }
  return records
}

function score(records) {
  return {
    questions: records.length,
    modelCalls: records.reduce((n, r) => n + r.llmCalls, 0),
    questionsWithUnsupportedClaims: records.filter((r) => r.unsupportedClaims.length).length,
    unsupportedClaimSentences: records.reduce((n, r) => n + r.unsupportedClaims.length, 0),
    questionsWithFabricatedCitation: records.filter((r) => r.citationsNotSupplied.length).length,
    fabricatedCitationsSurvived: records.reduce((n, r) => n + r.citationsNotSupplied.length, 0),
    emptyAnswers: records.filter((r) => !r.answer.trim()).length,
    errorResponses: records.filter((r) => r.status !== 200).length,
  }
}

// ------------------------------------------------------ provider fault probes ---

const fault = { requests: [], respond: null }

async function withFaultServer(respond, fn) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      fault.requests.push(req.url)
      const scripted = respond(fault.requests.length)
      const send = (status, payload, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
        res.on('error', () => {})
      }
      if (scripted.delayMs) {
        setTimeout(() => {
          try {
            send(200, { choices: [{ message: { content: 'too late' } }] })
          } catch {
            /* the client already aborted */
          }
        }, scripted.delayMs)
        return
      }
      send(scripted.status, scripted.body ?? {}, scripted.headers ?? {})
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const saved = config.localAiBaseUrl
  config.localAiBaseUrl = `http://127.0.0.1:${server.address().port}`
  fault.requests = []
  try {
    return await fn()
  } finally {
    config.localAiBaseUrl = saved
    await new Promise((r) => server.close(r))
  }
}

async function probe(name, respond, opts = {}) {
  return withFaultServer(respond, async () => {
    const started = Date.now()
    let outcome
    try {
      const res = await generate({
        task: AI_TASK.ANSWER,
        system: 'rules',
        user: 'question',
        timeoutMs: opts.timeoutMs ?? 20_000,
        retries: opts.retries ?? 1,
      })
      outcome = { ok: true, elapsedMs: Date.now() - started, code: null, requests: fault.requests.length }
    } catch (err) {
      outcome = {
        ok: false,
        elapsedMs: Date.now() - started,
        code: err.code || 'unknown',
        status: err.status ?? null,
        message: err.message,
        requests: fault.requests.length,
      }
    }
    return { name, ...outcome }
  })
}

async function measureFaults() {
  const probes = []
  probes.push(
    await probe('healthy', () => ({
      status: 200,
      body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    }))
  )
  probes.push(await probe('rate_limited_429', () => ({ status: 429, body: {}, headers: { 'Retry-After': '30' } })))
  probes.push(await probe('server_error_500', () => ({ status: 500, body: { error: 'boom' } })))
  probes.push(await probe('client_error_400', () => ({ status: 400, body: { error: 'bad request' } }), { retries: 3 }))
  probes.push(await probe('not_a_completion_200', () => ({ status: 200, body: { detail: 'login page' } })))
  probes.push(
    await probe('slow_model', () => ({ delayMs: 4000, status: 200 }), { timeoutMs: 150, retries: 0 })
  )

  // Unreachable: nothing is listening on this port.
  const saved = config.localAiBaseUrl
  config.localAiBaseUrl = 'http://127.0.0.1:1'
  const started = Date.now()
  let unreachable
  try {
    await generate({ task: AI_TASK.ANSWER, system: 'r', user: 'q', retries: 0, timeoutMs: 800 })
    unreachable = { name: 'unreachable', ok: true, code: null, elapsedMs: Date.now() - started, requests: 0 }
  } catch (err) {
    unreachable = {
      name: 'unreachable',
      ok: false,
      code: err.code || 'unknown',
      status: err.status ?? null,
      elapsedMs: Date.now() - started,
      requests: 0,
    }
  } finally {
    config.localAiBaseUrl = saved
  }
  probes.push(unreachable)
  return probes
}

// ----------------------------------------------------------------- report ---

function quantiles(values) {
  if (!values.length) return { min: 0, p50: 0, p95: 0, max: 0 }
  const s = [...values].sort((a, b) => a - b)
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { min: s[0], p50: at(0.5), p95: at(0.95), max: s[s.length - 1] }
}

async function measureLiveProvider() {
  const reachable = await pingProvider({ timeoutMs: 1500 }).catch(() => false)
  if (!reachable) {
    return {
      measured: false,
      reason: `no provider answered at ${config.localAiBaseUrl}`,
      model: config.localAiModel,
    }
  }
  // A provider is listening: measure the real thing, and report its own numbers.
  const started = Date.now()
  const res = await generate({ task: AI_TASK.ANSWER, system: 'Reply with one short word.', user: 'ready?' })
  return {
    measured: true,
    model: config.localAiModel,
    descriptor: providerDescriptor(),
    latencyMs: Date.now() - started,
    usage: res.usage,
    finishReason: res.finishReason,
    chars: res.text.length,
  }
}

async function main() {
  registerUser(PRIMARY_USER_ID)
  await bootstrap()

  ;({ config } = await import('../src/config/config.js'))
  ;({ generate, AI_TASK, resolveGenerationParams, providerDescriptor } = await import(
    '../src/services/inferenceService.js'
  ))
  ;({ pingProvider } = await import('../src/utils/llmClient.js'))

  setStubBehavior(adversarialStub)

  store.reset()
  for (const row of [...MEMORIES, ...OTHER_USER_MEMORIES]) store.memories.push({ ...row })

  const withGrounding = await pass(true)
  const withoutGrounding = await pass(false)
  await stopStubLLM()

  const scoring = score(withGrounding)
  const unfiltered = score(withoutGrounding)

  const promptChars = withGrounding.map((r) => r.promptChars).filter((n) => n > 0)
  const retrieved = withGrounding.map((r) => r.suppliedIds.length)
  const faults = await measureFaults()
  const live = await measureLiveProvider()

  const summary = {
    provider: providerDescriptor(),
    profiles: Object.fromEntries(
      Object.keys(AI_TASK).map((k) => [AI_TASK[k], resolveGenerationParams(AI_TASK[k])])
    ),
    groundingOn: scoring,
    groundingOff: unfiltered,
    preventedByLayer: {
      questions: unfiltered.questionsWithUnsupportedClaims - scoring.questionsWithUnsupportedClaims,
      sentences: unfiltered.unsupportedClaimSentences - scoring.unsupportedClaimSentences,
      fabricatedCitations: unfiltered.fabricatedCitationsSurvived - scoring.fabricatedCitationsSurvived,
    },
    // "0 unsupported with the layer on" is only meaningful if the grader would
    // have said otherwise. This proves the grader bites, on a pair it has never
    // seen, so a silently broken detector cannot report a clean run.
    detectorSelfTest: detectorSelfTest(),
    promptBudget: {
      chars: quantiles(promptChars),
      limit: config.aiContextMaxChars,
      overLimit: promptChars.filter((n) => n > config.aiContextMaxChars).length,
      memoriesPerQuestion: quantiles(retrieved),
      // Retrieval cap actually in force on the normal (non-compact) ask path.
      maxMemories: config.retrievalMaxMemories,
    },
    providerFaults: faults,
    liveModel: live,
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ summary, withGrounding, withoutGrounding }, null, 2))
    return
  }

  const bar = '='.repeat(96)
  console.log(bar)
  console.log('ECHO AI inference + grounding evaluation   questions=' + scoring.questions)
  console.log(bar)

  console.log('')
  console.log('PROVIDER (what would actually be called)')
  for (const [k, v] of Object.entries(summary.provider)) console.log(`  ${k.padEnd(18)} : ${v}`)

  console.log('')
  console.log('GENERATION PROFILES (per task)')
  for (const [task, p] of Object.entries(summary.profiles)) {
    console.log(
      `  ${task.padEnd(18)} : maxTokens=${p.maxTokens} temperature=${p.temperature} timeout=${p.timeoutMs}ms retries=${p.retries}`
    )
  }

  console.log('')
  console.log('GROUNDING A/B  (same corpus, same stub, claim layer on vs off)')
  const row = (label, s) =>
    console.log(
      `  ${label.padEnd(28)} : unsupported ${String(s.questionsWithUnsupportedClaims).padStart(2)}/${s.questions} questions, ` +
        `${String(s.unsupportedClaimSentences).padStart(3)} sentences | fabricated citations ${s.fabricatedCitationsSurvived} | empty answers ${s.emptyAnswers}`
    )
  row('claim grounding ON', scoring)
  row('claim grounding OFF', unfiltered)
  console.log(
    `  ${'prevented by the layer'.padEnd(28)} : ${summary.preventedByLayer.sentences} unsupported sentences, ` +
      `${summary.preventedByLayer.questions} questions, ${summary.preventedByLayer.fabricatedCitations} fabricated citations`
  )
  console.log(
    `  ${'grader self-test'.padEnd(28)} : ${summary.detectorSelfTest.ok ? 'PASS' : 'FAIL'}  (unrelated uncited flagged ${summary.detectorSelfTest.uncitedUnrelatedFlagged}, cited ${summary.detectorSelfTest.citedFlagged}, supported-uncited ${summary.detectorSelfTest.supportedUncitedFlagged}, fabricated id ${summary.detectorSelfTest.fabricatedIdFlagged})`
  )

  console.log('')
  console.log('PROMPT BUDGET')
  const b = summary.promptBudget
  console.log(
    `  prompt chars            : min=${b.chars.min} p50=${b.chars.p50} p95=${b.chars.p95} max=${b.chars.max} (limit ${b.limit}, over limit ${b.overLimit})`
  )
  console.log(
    `  memories per question   : min=${b.memoriesPerQuestion.min} p50=${b.memoriesPerQuestion.p50} max=${b.memoriesPerQuestion.max} (cap ${b.maxMemories})`
  )

  console.log('')
  console.log('PROVIDER FAULT BEHAVIOUR (measured)')
  for (const p of faults) {
    console.log(
      `  ${p.name.padEnd(22)} : ${(p.ok ? 'ok' : p.code).padEnd(22)} status=${p.status ?? '-'} attempts=${p.requests} ${p.elapsedMs}ms`
    )
  }

  console.log('')
  console.log('LIVE MODEL QUALITY')
  if (live.measured) {
    console.log(`  model      : ${live.model}`)
    console.log(`  latency    : ${live.latencyMs}ms, ${live.chars} chars, finish=${live.finishReason}`)
    console.log(`  usage      : ${JSON.stringify(live.usage)}`)
    console.log('  NOTE: one probe call measures the wire, not answer quality. Prose quality')
    console.log('        needs the full corpus against this model.')
  } else {
    console.log('  NOT MEASURED - ' + live.reason)
    console.log('  Answer-quality figures for a live model are therefore absent from this report.')
    console.log('  The numbers above measure the pipeline contract under a deterministic stub.')
  }
  console.log('')
}

await main()