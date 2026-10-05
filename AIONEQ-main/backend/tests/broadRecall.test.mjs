/*
 * Broad recall (AI_BROAD_RECALL) - meaning-based answers when the question and
 * the memory share no vocabulary.
 *
 * The real failure this fixes, reported by the user:
 *
 *   stored: "hii i am janani, i am currently pursing BE CSE at NEC. I Dream is
 *           i want to become a software developer at ZOHO."
 *   asked:  "tell me my name"
 *   got:    "I couldn't find anything in your saved memories..."
 *
 * The word "name" does not occur in that memory, so lexical overlap is 0, and
 * the hashed 384-d vector has no semantics to connect "name" with "Janani".
 * memoryRetrieval.js:388 dropped the row from the candidate pool, the prompt was
 * built empty, and the model was never asked - so no amount of model quality
 * could have helped.
 *
 * Only a language model can bridge that gap. Broad recall lets the model read
 * unranked recent memories and make the connection itself.
 *
 * These tests pin BOTH sides of the trade-off:
 *   - default OFF keeps the hard guarantee (no model call on an empty recall)
 *   - when ON, an answer is only shown if it actually cites a supplied memory
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const {
  bootstrap,
  store,
  registerUser,
  runAsk,
  setStubBehavior,
  stubLLM,
  stopStubLLM,
} = await import('./groundingHarness.mjs')

/*
 * Imported lazily: the harness points LOCAL_AI_BASE_URL at the stub server during
 * bootstrap(). Reading config before that captures the placeholder
 * http://127.0.0.1:1 and every model call fails with 503.
 */
let config

const USER = crypto.randomUUID()
const JOURNEY = 'i am janani, i am currently pursing BE CSE at NEC. I Dream is to become a software developer at ZOHO.'

function mem(overrides = {}) {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    user_id: USER,
    type: 'journal',
    title: 'My Life Journey',
    content: JOURNEY,
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
    ...overrides,
  }
}

function seed() {
  store.reset()
  store.memories.push(mem())
  stubLLM.reset()
  setStubBehavior(null)
}

const originalFlag = config?.aiBroadRecallEnabled

before(async () => {
  await bootstrap()
  ;({ config } = await import('../src/config/config.js'))
  registerUser(USER)
})

after(async () => {
  if (config) config.aiBroadRecallEnabled = originalFlag
  await stopStubLLM()
})

test('default OFF: "tell me my name" gets no model call and an honest refusal', async () => {
  config.aiBroadRecallEnabled = false
  seed()

  const result = await runAsk({ userId: USER, question: 'tell me my name' })

  assert.equal(result.status, 200)
  assert.equal(result.llmCalls, 0, 'default must not spend a model call on an empty recall')
  assert.match(result.body.answer, /couldn't find anything/i)
  assert.deepEqual(result.body.citedMemories, [])
})

test('ON: the model reads the memory and answers, citing it', async () => {
  config.aiBroadRecallEnabled = true
  seed()

  const result = await runAsk({ userId: USER, question: 'tell me my name' })

  assert.equal(result.status, 200)
  assert.ok(result.llmCalls >= 1, 'broad recall must actually reach the model')
  assert.equal(result.body.citedMemories.length, 1, 'the answer must cite the memory it used')
  assert.equal(result.body.usedMemories.length, 1, 'the memory used must be reported')
  assert.ok(
    !/couldn't find anything/i.test(result.body.answer),
    `expected a real answer, got: ${result.body.answer}`
  )
})

test('ON but the model cites nothing: the honest refusal is restored', async () => {
  config.aiBroadRecallEnabled = true
  seed()

  // A model that answers without citing has answered from nothing, so the
  // answer must be discarded rather than shown.
  setStubBehavior(() => 'Your name is Janani and you want to work at Zoho.')

  const result = await runAsk({ userId: USER, question: 'tell me my name' })

  assert.equal(result.status, 200)
  assert.match(result.body.answer, /couldn't find anything/i)
  assert.deepEqual(result.body.citedMemories, [])
})

test('ON but the question is not about the user: no broad recall', async () => {
  config.aiBroadRecallEnabled = true
  seed()

  const result = await runAsk({ userId: USER, question: 'how do black holes form over time' })

  assert.equal(result.status, 200)
  assert.equal(result.llmCalls, 0, 'a general-knowledge question must not pull in personal memories')
  assert.deepEqual(result.body.usedMemories, [])
})