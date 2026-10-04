/*
 * Authenticated memory lifecycle - Phase 9.3.
 *
 * Drives the REAL memory + query controllers end to end through
 * the grounding harness (RLS-correct fake store + deterministic
 * stub LLM), replaying the exact sequence the infrastructure
 * smoke test performs over HTTP in scripts/smokeTest.mjs:
 *
 *   create -> retrieve by id -> search -> grounded ask ->
 *   consent-off ask (zero citations) -> cross-user read ->
 *   delete -> verify gone.
 *
 * WHY THIS EXISTS. The smoke test's authenticated section needs
 * a real staging token (API_TOKEN) and a running local LLM, so
 * it is honestly reported as "skipped" without them. This test
 * proves the same lifecycle - and the response shapes the smoke
 * test parses (data.id, usedMemories[].memoryId, citedMemories) -
 * actually works, using only synthetic data, so the logic is
 * verified even when live credentials are not available.
 *
 * Run: node --experimental-test-module-mocks --test tests/lifecycle.test.mjs
 * (the test script in package.json already passes the flag).
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  bootstrap,
  store,
  registerUser,
  fakeReq,
  fakeRes,
  runAsk,
  usedIds,
  citedIds,
  stopStubLLM,
} from './groundingHarness.mjs'

const USER_A = crypto.randomUUID()
const USER_B = crypto.randomUUID()
// A single alphanumeric token so both full-text and lexical
// matching find the created memory deterministically.
const MARKER = `lifecycle${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`

let memoryController
let queryController

before(async () => {
  registerUser(USER_A)
  registerUser(USER_B)
  ;({ memoryController, controller: queryController } = await bootstrap())
  store.reset()
  // Seed settings so the create path never launches the
  // background processing pipeline (processing_enabled=false),
  // keeping the test deterministic. memory_ai_enabled stays
  // true (the default) so the first ask retrieves memories.
  for (const userId of [USER_A, USER_B]) {
    store.memory_settings.push({
      user_id: userId,
      memory_ai_enabled: true,
      conversation_memory_enabled: true,
      processing_enabled: false,
      updated_at: new Date().toISOString(),
    })
  }
})

after(() => stopStubLLM())

test('authenticated memory lifecycle (mirrors the smoke test)', async (t) => {
  // 1. Create a synthetic typed memory (smoke step 7.2).
  const createRes = fakeRes()
  await memoryController.createMemoryController(
    fakeReq({
      userId: USER_A,
      body: {
        type: 'journal',
        title: `Lifecycle test memory ${MARKER}`,
        content: `Lifecycle test note. Marker: ${MARKER}. No real data.`,
        tags: ['lifecycle-test'],
      },
    }),
    createRes
  )
  const createdId = createRes.body?.data?.id
  await t.test('create returns 201 with an id', () => {
    assert.equal(createRes.statusCode, 201, `body: ${JSON.stringify(createRes.body)}`)
    assert.ok(createdId, 'created memory has an id')
  })

  // 2. Retrieve it by id (smoke step 7.3).
  const gotRes = fakeRes()
  await memoryController.getMemoryByIdController(
    fakeReq({ userId: USER_A, params: { id: createdId } }),
    gotRes
  )
  await t.test('retrieve by id returns the created memory', () => {
    assert.equal(gotRes.statusCode, 200, `got ${gotRes.statusCode}`)
    assert.equal(gotRes.body?.data?.id, createdId)
  })

  // 3. Search for it by its marker (smoke step 7.4).
  const searchRes = fakeRes()
  await memoryController.getMemoriesController(
    fakeReq({ userId: USER_A, query: { q: MARKER } }),
    searchRes
  )
  const found =
    Array.isArray(searchRes.body?.data) && searchRes.body.data.some((m) => m.id === createdId)
  await t.test('search finds the created memory by its marker', () => {
    assert.equal(searchRes.statusCode, 200, `got ${searchRes.statusCode}`)
    assert.ok(found, 'created memory is in search results')
  })

  // 4. Ask a grounded question about it (smoke step 7.5).
  const ask = await runAsk({ userId: USER_A, question: `What does my note about ${MARKER} say?` })
  await t.test('grounded ask succeeds and uses the created memory', () => {
    assert.equal(ask.status, 200, `got ${ask.status}: ${ask.body?.message || ''}`)
    assert.ok(
      usedIds(ask).includes(createdId),
      `created memory should ground the answer; used=${JSON.stringify(usedIds(ask))}`
    )
  })

  // 5. Consent off: the ask must retrieve and cite nothing (smoke
  //    step 7.6).
  const consentAsk = await runAsk({
    userId: USER_A,
    question: `What does my note about ${MARKER} say?`,
    settings: { memoryAiEnabled: false },
  })
  await t.test('consent off: ask cites and uses zero memories', () => {
    assert.equal(consentAsk.status, 200, `got ${consentAsk.status}`)
    assert.deepEqual(citedIds(consentAsk), [], 'no citations when memory-AI is off')
    assert.deepEqual(usedIds(consentAsk), [], 'no memories used when memory-AI is off')
  })

  // 6. Cross-user authorization (smoke step 7.7): another user
  //    must not read this memory.
  const otherRes = fakeRes()
  await memoryController.getMemoryByIdController(
    fakeReq({ userId: USER_B, params: { id: createdId } }),
    otherRes
  )
  await t.test('another user cannot read the memory (RLS)', () => {
    assert.equal(otherRes.statusCode, 404, `got ${otherRes.statusCode}`)
  })

  // 7. Delete the synthetic memory (smoke step 7.8).
  const delRes = fakeRes()
  await memoryController.deleteMemoryController(
    fakeReq({ userId: USER_A, params: { id: createdId } }),
    delRes
  )
  await t.test('delete returns 200', () => {
    assert.equal(delRes.statusCode, 200, `got ${delRes.statusCode}`)
  })

  // 8. Verify it is gone (smoke step 7.9).
  const goneRes = fakeRes()
  await memoryController.getMemoryByIdController(
    fakeReq({ userId: USER_A, params: { id: createdId } }),
    goneRes
  )
  await t.test('deleted memory is no longer retrievable (404)', () => {
    assert.equal(goneRes.statusCode, 404, `got ${goneRes.statusCode}`)
  })

  const searchAfterRes = fakeRes()
  await memoryController.getMemoriesController(
    fakeReq({ userId: USER_A, query: { q: MARKER } }),
    searchAfterRes
  )
  const stillThere =
    Array.isArray(searchAfterRes.body?.data) &&
    searchAfterRes.body.data.some((m) => m.id === createdId)
  await t.test('deleted memory no longer appears in search', () => {
    assert.equal(searchAfterRes.statusCode, 200, `got ${searchAfterRes.statusCode}`)
    assert.ok(!stillThere, 'created memory is gone from search results')
  })

  // And the store really is empty for this user afterwards.
  await t.test('store holds no leftover memory rows for the user', () => {
    assert.equal(
      store.memories.filter((m) => m.user_id === USER_A).length,
      0,
      'no memories left for the user'
    )
  })
})
