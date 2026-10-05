/*
 * Phase 10: the unified inference layer and claim grounding.
 *
 * Two modules are covered here, and neither needs a real model:
 *
 *   1. services/inferenceService.js - one entry point, per-task generation
 *      profiles, and content-free operational metrics.
 *   2. services/claimGrounding.js  - the layer that stops an invented personal
 *      detail from being shown as established fact.
 *
 * Provider faults are driven against a scripted local HTTP server, so the
 * timeout / rate-limit / 5xx / 4xx / malformed-envelope / unreachable paths are
 * all exercised deterministically instead of being asserted in prose.
 *
 * Run: node --test tests/aiInference.test.mjs
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.AUDIT_ENABLED = 'false'

const { config } = await import('../src/config/config.js')
const { resolveGenerationParams, usesCompactPrompt, AI_TASK, generate } = await import(
  '../src/services/inferenceService.js'
)
const { complete, completeResult, chatCompletion, textCompletion, ProviderError } = await import(
  '../src/utils/llmClient.js'
)
const { groundAnswer, isFactualClaim, validatedCitationIds } = await import(
  '../src/services/claimGrounding.js'
)

const JOB = '11111111-1111-4111-8111-111111111111'
const ALLERGY = '22222222-2222-4222-8222-222222222222'
const FOREIGN = '33333333-3333-4333-8333-333333333333'
const NAME = '44444444-4444-4444-8444-444444444444'

const MEMORIES = [
  { memoryId: JOB, snippet: 'I accepted the Porto engineering job offer after the second interview round.' },
  { memoryId: ALLERGY, snippet: 'I am allergic to shellfish and avoided the seafood platter at the wedding.' },
]

// ------------------------------------------------- scripted provider server --

/** request log + programmable responses for the fake llama-server. */
const wire = { requests: [], respond: null }

let server = null
let originalBaseUrl = null

function completion(text, extra = {}) {
  return {
    choices: [{ message: { content: text }, text, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    ...extra,
  }
}

before(async () => {
  originalBaseUrl = config.localAiBaseUrl
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        payload = {}
      }
      wire.requests.push({ url: req.url, payload })

      const scripted = wire.respond ? wire.respond(wire.requests.length, req) : null
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj))
        res.on('error', () => {})
      }

      if (scripted?.delayMs) {
        // Never answers in time: proves the client aborts on its own deadline.
        setTimeout(() => {
          try {
            send(200, completion('too late'))
          } catch {
            /* the client already gave up */
          }
        }, scripted.delayMs)
        return
      }
      if (scripted) {
        send(scripted.status, scripted.body ?? {}, scripted.headers ?? {})
        return
      }

      const isChat = String(req.url).includes('/chat/completions')
      send(200, completion(isChat ? 'stub answer' : 'stub answer'))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  config.localAiBaseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  config.localAiBaseUrl = originalBaseUrl
  if (server) await new Promise((resolve) => server.close(resolve))
})

function resetWire() {
  wire.requests = []
  wire.respond = null
}

// ------------------------------------------------------ generation profiles --

test('every task gets the generation profile the old call sites hardcoded', () => {
  assert.deepEqual(resolveGenerationParams(AI_TASK.ANALYSIS), {
    maxTokens: 320,
    temperature: 0.2,
    timeoutMs: 15_000,
    retries: 1,
  })
  // Relation classification must stay deterministic and tiny: one word.
  assert.deepEqual(resolveGenerationParams(AI_TASK.RELATION), {
    maxTokens: 8,
    temperature: 0,
    timeoutMs: 10_000,
    retries: 0,
  })
  assert.equal(resolveGenerationParams(AI_TASK.ANSWER).maxTokens, 700)
  assert.equal(resolveGenerationParams(AI_TASK.SUMMARY).maxTokens, 160)
})

test('an explicit parameter beats the task profile, and global settings fill the gaps', () => {
  const p = resolveGenerationParams(AI_TASK.ANALYSIS, { maxTokens: 64, temperature: 0.9 })
  assert.equal(p.maxTokens, 64)
  assert.equal(p.temperature, 0.9)
  // Not overridden -> still the profile's timeout, not the global default.
  assert.equal(p.timeoutMs, 15_000)
  assert.equal(resolveGenerationParams('unknown-task').maxTokens, 700)
})

test('an unknown task falls back to the answer profile instead of throwing', () => {
  assert.equal(resolveGenerationParams('not-a-task').maxTokens, 700)
})

test('compact mode routes to raw completions and can be forced per task', () => {
  assert.equal(usesCompactPrompt(AI_TASK.ANSWER), Boolean(config.localAiCompactPrompt))
  assert.equal(usesCompactPrompt(AI_TASK.ANSWER, true), true)
  assert.equal(usesCompactPrompt(AI_TASK.ANSWER, false), false)
})

// ------------------------------------------------------------- wire format --

test('the chat path posts to /v1/chat/completions with the configured sampling', async () => {
  resetWire()
  const res = await completeResult({ system: 'rules', user: 'question' })
  const req = wire.requests[0]
  assert.equal(req.url, '/v1/chat/completions')
  assert.equal(req.payload.model, config.localAiModel)
  assert.deepEqual(
    req.payload.messages.map((m) => m.role),
    ['system', 'user']
  )
  assert.equal(req.payload.temperature, config.aiTemperature)
  assert.equal(req.payload.top_p, config.aiTopP)
  assert.equal(req.payload.repeat_penalty, config.aiRepeatPenalty)
  assert.equal(req.payload.max_tokens, config.aiMaxTokens)
  assert.equal(res.text, 'stub answer')
})

test('the compact path posts to /v1/completions for the template-less tiny GPT', async () => {
  resetWire()
  await completeResult({ system: 'rules', user: 'question', compact: true })
  const req = wire.requests[0]
  assert.equal(req.url, '/v1/completions')
  assert.equal(req.payload.prompt, 'rules\n\nquestion')
  assert.equal(req.payload.messages, undefined, 'ChatML messages must not reach a raw completion')
})

test('provider usage and finish reason are surfaced, and the string API still works', async () => {
  resetWire()
  const detailed = await completeResult({ system: 's', user: 'u' })
  assert.deepEqual(detailed.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 })
  assert.equal(detailed.finishReason, 'stop')

  // The long-standing string-returning entry points are unchanged.
  assert.equal(await complete({ system: 's', user: 'u' }), 'stub answer')
  assert.equal(await chatCompletion({ system: 's', user: 'u' }), 'stub answer')
  assert.equal(await textCompletion({ system: 's', user: 'u' }), 'stub answer')
})

// ---------------------------------------------------------- provider faults --

test('a 429 is retried once and then reported as rate limiting', async () => {
  resetWire()
  wire.respond = () => ({ status: 429, body: { error: 'busy' } })
  await assert.rejects(
    () => generate({ task: AI_TASK.ANSWER, system: 's', user: 'u', retries: 1 }),
    (err) => {
      assert.ok(err instanceof ProviderError)
      assert.equal(err.code, 'provider_rate_limited')
      assert.equal(err.status, 503)
      return true
    }
  )
  assert.equal(wire.requests.length, 2, 'the rate-limited request should have been retried once')
})

test('a Retry-After of 30s is honoured but bounded, so a request cannot hang', async () => {
  resetWire()
  wire.respond = () => ({ status: 429, body: {}, headers: { 'Retry-After': '30' } })
  const started = Date.now()
  await assert.rejects(
    () => generate({ task: AI_TASK.ANSWER, system: 's', user: 'u', retries: 1 }),
    (err) => err.code === 'provider_rate_limited'
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 1000, `expected the server's delay to be respected, waited ${elapsed}ms`)
  assert.ok(elapsed < 5000, `Retry-After must be bounded, waited ${elapsed}ms`)
})

test('a 5xx is retried, a 4xx is not', async () => {
  resetWire()
  wire.respond = () => ({ status: 503, body: { error: 'warming up' } })
  await assert.rejects(
    () => generate({ task: AI_TASK.ANSWER, system: 's', user: 'u', retries: 1 }),
    (err) => err.code === 'provider_http_error' && err.status === 503
  )
  assert.equal(wire.requests.length, 2, 'a transient 5xx should be retried')

  resetWire()
  wire.respond = () => ({ status: 400, body: { error: 'bad request' } })
  await assert.rejects(
    () => generate({ task: AI_TASK.ANSWER, system: 's', user: 'u', retries: 3 }),
    (err) => err.code === 'provider_http_error' && err.status === 400 && err.retryable === false
  )
  assert.equal(wire.requests.length, 1, 'a client error must not be hammered')
})

test('a slow model is a timeout, reported as 504 and actionable', async () => {
  resetWire()
  wire.respond = () => ({ delayMs: 3_000, status: 200 })
  const started = Date.now()
  await assert.rejects(
    () => generate({ task: AI_TASK.ANSWER, system: 's', user: 'u', timeoutMs: 120, retries: 0 }),
    (err) => {
      assert.equal(err.code, 'provider_timeout')
      assert.equal(err.status, 504)
      assert.match(err.message, /AI_TIMEOUT_MS/)
      return true
    }
  )
  assert.ok(Date.now() - started < 2_500, 'the client must abandon a slow model on its own deadline')
})

test('a 200 that is not a completion is an error, never an empty answer', async () => {
  resetWire()
  wire.respond = () => ({ status: 200, body: { detail: 'proxy login page' } })
  await assert.rejects(
    () => generate({ task: AI_TASK.ANSWER, system: 's', user: 'u', retries: 0 }),
    (err) => err.code === 'provider_bad_response'
  )

  resetWire()
  wire.respond = () => ({ status: 200, body: 'not json at all' })
  await assert.rejects(
    () => generate({ task: AI_TASK.ANSWER, system: 's', user: 'u', retries: 0 }),
    (err) => err.code === 'provider_bad_response'
  )
})

test('a stopped model is reported as unreachable, not as a crash', async () => {
  const saved = config.localAiBaseUrl
  config.localAiBaseUrl = 'http://127.0.0.1:1' // nothing listens here
  try {
    await assert.rejects(
      () => generate({ task: AI_TASK.ANSWER, system: 's', user: 'u', retries: 0, timeoutMs: 500 }),
      (err) => {
        assert.equal(err.code, 'provider_unreachable')
        assert.match(err.message, /localhost:4891|llama-server/)
        return true
      }
    )
  } finally {
    config.localAiBaseUrl = saved
  }
})

// ------------------------------------------------------------- claim rules --

test('R1: a citation to an id that was never supplied is deleted from the text', () => {
  const r = groundAnswer({
    answer: `You moved to Lisbon in 2019 (cite: ${FOREIGN}).`,
    memories: MEMORIES,
  })
  assert.equal(r.changed, true)
  assert.deepEqual(r.invalidCitations, [FOREIGN])
  assert.deepEqual(r.citedMemoryIds, [])
  assert.ok(!r.answer.includes(FOREIGN), 'the fabricated id is still displayed')
})

test('R1: a removed citation never shifts onto a neighbouring valid one', () => {
  const r = groundAnswer({
    answer: `You accepted the Porto job (cite: ${FOREIGN}), and you avoided the platter (cite: ${ALLERGY}).`,
    memories: MEMORIES,
  })
  assert.deepEqual(r.invalidCitations, [FOREIGN])
  assert.deepEqual(r.citedMemoryIds, [ALLERGY])
  assert.equal(r.answer.includes('undefined'), false, 'a removed marker was replaced with undefined')
  assert.ok(r.answer.includes(`(cite: ${ALLERGY})`))
  assert.equal(r.answer.includes(FOREIGN), false)
})

test('an uncited fabrication cannot hide behind a citation in the same run', () => {
  // Two quoted excerpts run together, then an uncited claim rides along at the
  // end. A citation marker has to end the unit it vouches for, otherwise the
  // fabrication is smuggled through on a neighbour's authority.
  const r = groundAnswer({
    answer:
      `from my notes: "I accepted the Porto engineering job offer after the second" (cite: ${JOB}) ` +
      `from my notes: "I am allergic to shellfish and avoided the seafood platter" (cite: ${ALLERGY}) ` +
      'You also spent the summer in Lisbon teaching at a language school.',
    memories: MEMORIES,
  })
  assert.ok(r.answer.includes(`(cite: ${JOB})`), 'a genuinely cited quote was lost')
  assert.ok(r.answer.includes(`(cite: ${ALLERGY})`), 'a genuinely cited quote was lost')
  assert.equal(
    /Lisbon|teaching|language school/.test(r.answer),
    false,
    'the uncited fabrication survived on a cited neighbours authority'
  )
  assert.equal(r.changed, true)
  assert.equal(r.removedClaims.length, 1)
})

test('R2: a cited sentence is kept, including a paraphrase of its own source', () => {
  const r = groundAnswer({
    answer: `You took the Porto engineering job (cite: ${JOB}).`,
    memories: MEMORIES,
  })
  assert.equal(r.changed, false)
  assert.equal(r.citedClaimCount, 1)
  assert.deepEqual(r.citedMemoryIds, [JOB])
  assert.ok(r.answer.includes('Porto engineering job'))
})

test('R3: an uncited assertion with nothing in common with the memories is removed', () => {
  const r = groundAnswer({
    answer: 'I have been learning Portuguese for two years.',
    memories: MEMORIES,
  })
  assert.equal(r.changed, true)
  assert.equal(r.removedClaims.length, 1)
  assert.equal(r.answer.includes('Portuguese'), false)
})

test('R3: a one-word fabrication is still caught', () => {
  const r = groundAnswer({ answer: 'You own a kayak.', memories: MEMORIES })
  assert.equal(r.removedClaims.length, 1)
})

test('R3: a short or conversational sentence is never removed', () => {
  for (const answer of [
    'You did.',
    'Would you like more detail?',
    'Let me know if you want the full timeline.',
    'That sounds like a big change.',
    'That is a lovely commitment.',
  ]) {
    const r = groundAnswer({ answer, memories: MEMORIES })
    assert.deepEqual(r.removedClaims, [], `wrongly removed: ${answer}`)
    assert.equal(r.answer, answer)
  }
})

test('R3: an honest "not found" answer survives untouched', () => {
  const answer = "I couldn't find anything about that in your memories."
  const r = groundAnswer({ answer, memories: MEMORIES })
  assert.equal(r.changed, false)
  assert.equal(r.answer, answer)
})

// A denial is built from the words it denies, so lexical support is inverted for
// it. These are the exact sentences that produced a confidently WRONG answer in
// the field: "I don't have a name" scored full support against a memory reading
// "my name is Janani" because "name" is in both. Grounding must never report a
// denial as a grounded claim.
test('a denial is never counted as a supported claim, however well it overlaps', () => {
  const memories = [
    { memoryId: NAME, snippet: 'my name is janani and I am pursuing BE CSE at NEC.' },
    { memoryId: ALLERGY, snippet: 'I am allergic to shellfish and avoided the seafood platter at the wedding.' },
  ]

  for (const denial of [
    "From what you shared, I don't have a name.",
    'I do not have a name.',
    'I have no record of a name.',
    "I couldn't find your name.",
    'There is no name in your saved memories.',
  ]) {
    const r = groundAnswer({ answer: denial, memories })
    assert.equal(
      r.supportedClaimCount,
      0,
      `a denial was recorded as a grounded fact: ${denial}`,
    )
    assert.equal(r.citedClaimCount, 0, `a denial was recorded as cited: ${denial}`)
  }
})

// A denial attached to a real citation must still not be counted as an answer.
// Note the scope of the guarantee: splitSentences() lifts a trailing citation
// marker into its own sentence, so citedClaimCount legitimately still counts the
// id the model really did cite. What must never happen is the denial being
// recorded as a supported claim, which is what would let the controller treat
// "I don't have a name" as the answer to "what is my name".
test('citing a real memory does not make a denial a supported claim', () => {
  const r = groundAnswer({
    answer: `From what you shared, I don't have a name (cite: ${NAME}).`,
    memories: [{ memoryId: NAME, snippet: 'my name is janani.' }],
  })
  assert.equal(r.supportedClaimCount, 0, 'a denial must never be a supported claim')
  assert.deepEqual(r.removedClaims, [], 'the denial must not be deleted either')
  // The id was genuinely supplied and genuinely cited, so it stays cited.
  assert.ok(r.citedMemoryIds.includes(NAME))
})

// Guarding the counters must not cost the honest path: a denial is truthful and
// still has to reach the user. Only the grounding *count* changes.
test('the denial guard never deletes or rewrites the denial itself', () => {
  const answer = "I couldn't find anything about that in your memories."
  const r = groundAnswer({ answer, memories: MEMORIES })
  assert.equal(r.answer, answer)
  assert.deepEqual(r.removedClaims, [])
})

test('a fully filtered answer becomes an honest message, never an empty bubble', () => {
  const r = groundAnswer({
    answer: `You moved to Lisbon in 2019 (cite: ${FOREIGN}).`,
    memories: MEMORIES,
  })
  assert.ok(r.answer.length > 0)
  assert.match(r.answer, /could not find/i)

  const custom = groundAnswer({
    answer: `You moved to Lisbon in 2019 (cite: ${FOREIGN}).`,
    memories: MEMORIES,
    honestFallback: 'Your memories don’t mention this.',
  })
  assert.equal(custom.answer, 'Your memories don’t mention this.')
})

test('an uncited but genuinely supported sentence is kept', () => {
  const r = groundAnswer({
    answer: 'You accepted the Porto engineering offer after the second interview.',
    memories: MEMORIES,
  })
  assert.equal(r.changed, false)
  assert.ok(r.answer.includes('Porto'))
  assert.equal(r.supportedClaimCount, 1)
})

test('grounding is a no-op when there is nothing to ground against', () => {
  const answer = 'Your memories don’t mention this.'
  const r = groundAnswer({ answer, memories: [] })
  assert.equal(r.changed, false)
  assert.equal(r.answer, answer)
})

test('weak attribution is measured rather than silently filtered', () => {
  const r = groundAnswer({
    answer: `You have a sister named Mara (cite: ${ALLERGY}).`,
    memories: MEMORIES,
  })
  // The id is real, so the citation stands - but the mismatch is counted so the
  // evaluation can report it instead of hiding it.
  assert.equal(r.weakAttributions, 1)
  assert.deepEqual(r.citedMemoryIds, [ALLERGY])
})

test('a quoted passage is not treated as the model asserting a fact', () => {
  assert.equal(isFactualClaim('"I finally topped the Eiger north face."'), false)
  assert.equal(isFactualClaim('You accepted the Porto engineering job.'), true)
  assert.equal(isFactualClaim('Would you like to know more?'), false)
})

test('validatedCitationIds keeps the pre-existing contract for other callers', () => {
  const answer = `Porto (cite: ${JOB}) and Lisbon (cite: ${FOREIGN})`
  assert.deepEqual(validatedCitationIds(answer, MEMORIES), [JOB])
})

// --------------------------------------------------- metrics contain no text --

test('the inference metric records counts and codes, never prompt or answer text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echomind-ai-metric-'))
  const logFile = path.join(dir, 'audit.log')
  const savedEnabled = config.auditEnabled
  const savedPath = config.auditLogPath
  config.auditEnabled = true
  config.auditLogPath = logFile
  resetWire()

  const secretPrompt = 'excerpt about the secret porto handshake'
  try {
    await generate({ task: AI_TASK.ANSWER, system: 'rules only', user: secretPrompt, userId: 'u-1' })
    // Let the audit writer flush.
    await new Promise((r) => setTimeout(r, 50))
  } finally {
    config.auditEnabled = savedEnabled
    config.auditLogPath = savedPath
  }

  const logged = fs.readFileSync(logFile, 'utf8')
  const entry = logged
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((e) => e.action === 'ai.inference')

  assert.ok(entry, 'no ai.inference metric was recorded')
  assert.equal(entry.detail.task, AI_TASK.ANSWER)
  assert.equal(entry.detail.model, config.localAiModel)
  assert.equal(typeof entry.detail.latencyMs, 'number')
  assert.equal(typeof entry.detail.promptChars, 'number')
  assert.equal(entry.detail.promptChars > 0, true)
  assert.equal(entry.detail.ok, true)
  assert.deepEqual(entry.detail.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 })
  assert.equal(logged.includes(secretPrompt), false, 'prompt text reached the audit log')
  assert.equal(logged.includes('stub answer'), false, 'answer text reached the audit log')
  assert.equal(JSON.stringify(entry).includes(config.localAiBaseUrl), false, 'the provider URL leaked')

  fs.rmSync(dir, { recursive: true, force: true })
})