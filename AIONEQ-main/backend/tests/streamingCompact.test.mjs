/*
 * Streaming Ask in compact mode (LOCAL_AI_COMPACT_PROMPT=true).
 *
 * Regression: askQuestionStream always called chatCompletionStream
 * (/v1/chat/completions) and ignored the compact flag. The project's tiny GPT
 * has no chat template, so every streamed question failed with "Could not
 * complete the answer." Compact mode must use raw /v1/completions, like the
 * non-streaming route, and still finish with a `done` event.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const { bootstrap, store, registerUser, runAskStream, setStubBehavior, stubLLM, stopStubLLM } =
  await import('./groundingHarness.mjs')

let config
const USER = crypto.randomUUID()
const NOTE = 'i am janani, i am currently pursing BE CSE at NEC.'

function seed() {
  const now = new Date().toISOString()
  store.reset()
  store.memories.push({
    id: crypto.randomUUID(),
    user_id: USER,
    type: 'journal',
    title: 'My Life Journey',
    content: NOTE,
    tags: [],
    topics: [],
    keywords: [],
    entities: [],
    ai_summary: null,
    transcript: null,
    extracted_text: null,
    event_date: now,
    created_at: now,
    updated_at: now,
    processing_status: 'ready',
    source_kind: 'typed',
  })
  stubLLM.reset()
  setStubBehavior(null)
}

const originalCompact = undefined
let saved

before(async () => {
  await bootstrap()
  ;({ config } = await import('../src/config/config.js'))
  saved = config.localAiCompactPrompt
  registerUser(USER)
})

after(async () => {
  if (config) config.localAiCompactPrompt = saved ?? originalCompact
  await stopStubLLM()
})

test('compact streaming uses /v1/completions and finishes with done', async () => {
  config.localAiCompactPrompt = true
  seed()
  setStubBehavior(() => 'You are janani, pursuing BE CSE at NEC.')

  const result = await runAskStream({ userId: USER, question: 'who am i, janani NEC' })

  assert.equal(result.error, null, `stream errored: ${JSON.stringify(result.error)}`)
  assert.ok(result.done, 'stream must finish with a done event')
  assert.equal(result.llmCalls, 1)
  assert.ok(result.lastUrl.endsWith('/v1/completions'), `expected raw completions, got ${result.lastUrl}`)
  assert.ok(!result.lastUrl.includes('/chat/'), 'compact mode must not call chat completions')
  assert.ok(result.done.answer.trim().length > 0)
})

test('full mode streaming still uses chat completions', async () => {
  config.localAiCompactPrompt = false
  seed()
  setStubBehavior(() => 'You are janani, pursuing BE CSE at NEC.')

  const result = await runAskStream({ userId: USER, question: 'who am i, janani NEC' })

  assert.equal(result.error, null, `stream errored: ${JSON.stringify(result.error)}`)
  assert.ok(result.done, 'stream must finish with a done event')
  assert.ok(result.lastUrl.endsWith('/v1/chat/completions'), `got ${result.lastUrl}`)
})

test('compact: an unusable model reply (a lone ".") falls back to the retrieved memory', async () => {
  config.localAiCompactPrompt = true
  seed()
  setStubBehavior(() => '.')

  const result = await runAskStream({ userId: USER, question: 'who am i, janani NEC' })

  assert.equal(result.error, null)
  assert.ok(result.done, 'stream must finish with a done event')
  assert.match(result.done.answer, /janani/i, 'the memory text should be shown instead of "."')
  assert.equal(result.done.citedMemories.length, 1)
})

test('extractive: answers by quoting the matching memory lines, with no model call', async () => {
  config.localAiCompactPrompt = true
  config.localAiExtractive = true
  try {
    seed()
    store.memories[0].title = 'AIVARIZ placement'
    store.memories[0].content = [
      '## Company',
      '- Industry: IT Services / AI & Consulting',
      '## Placement Experience',
      '- Recruited from National Engineering College (2026-27 cycle)',
      '- Stipend: 7000/month / Salary: 3 LPA (listed students)',
      '- Contact: aivariz placement cell',
    ].join('\n')

    const result = await runAskStream({ userId: USER, question: 'salary of aivariz' })

    assert.equal(result.error, null)
    assert.equal(result.llmCalls, 0, 'extractive mode must not call the model')
    assert.match(result.done.answer, /Salary: 3 LPA/)
    assert.ok(!/\(cite:/i.test(result.done.answer), 'raw citation markers must not be shown')
    assert.ok(!/Industry/.test(result.done.answer), 'unrelated lines must not be shown')
    assert.equal(result.done.citedMemories.length, 1)
  } finally {
    config.localAiExtractive = false
  }
})
