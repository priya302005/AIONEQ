/*
 * Account deletion - service-role path.
 *
 * Runs in its OWN process (node --test spawns one per file)
 * because config.js captures SUPABASE_SERVICE_ROLE_KEY at
 * import time and the main deletion tests need it unset.
 *
 * With a service-role key configured, the Supabase auth
 * identity itself is deleted via the admin API, and the
 * response does NOT carry the "identity retained"
 * limitation.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

// Pin BEFORE the harness import so config.js (loaded when
// bootstrap() imports the controllers) captures it.
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'

const harness = await import('./groundingHarness.mjs')
const { bootstrap, store, registerUser, tokenFor, stopStubLLM } = harness

const USER_A = '11111111-1111-1111-1111-111111111111'

function seedForUser(userId) {
  const memoryId = crypto.randomUUID()
  const now = new Date().toISOString()
  store.memories.push({
    id: memoryId,
    user_id: userId,
    type: 'text',
    title: 'Note',
    content: 'content',
    created_at: now,
    updated_at: now,
  })
  store.memory_settings.push({
    user_id: userId,
    memory_ai_enabled: true,
    conversation_memory_enabled: true,
    processing_enabled: true,
    updated_at: now,
  })
}

async function deleteAccount(userId) {
  const { accountController } = await bootstrap()
  const req = { user: { id: userId }, accessToken: tokenFor(userId), ip: '127.0.0.1' }
  let status = 200
  let body = null
  const res = {
    status(code) {
      status = code
      return res
    },
    json(payload) {
      body = payload
    },
  }
  await accountController.deleteAccountController(req, res, () => {})
  return { status, body }
}

before(async () => {
  await bootstrap()
  registerUser(USER_A)
})

after(async () => {
  await stopStubLLM()
})

test('with a service-role key the auth identity is deleted and not reported as retained', async () => {
  store.reset()
  seedForUser(USER_A)

  const { status, body } = await deleteAccount(USER_A)

  assert.equal(status, 200)
  assert.equal(body.success, true)

  // The admin deletion was attempted for exactly this user.
  const adminCall = store.queries.find((q) => q.op === 'admin.deleteUser')
  assert.ok(adminCall, 'admin.deleteUser was not called')
  assert.equal(adminCall.detail, USER_A)

  // Data rows are still wiped explicitly.
  assert.equal(store.memories.filter((m) => m.user_id === USER_A).length, 0)
  assert.equal(store.memory_settings.filter((s) => s.user_id === USER_A).length, 0)

  // The "identity retained" limitation is absent (only the
  // unavoidable backup-retention disclosure remains).
  assert.equal(
    body.deletion.limitations.some((l) => l.includes('auth identity')),
    false,
    'retained-identity limitation must not appear when the identity was deleted'
  )
  assert.equal(
    body.deletion.limitations.some((l) => l.includes('removed automatically')),
    false,
    'auth-failure limitation must not appear on success'
  )
  assert.ok(
    body.deletion.limitations.some((l) => l.includes('backups')),
    'backup retention is still disclosed'
  )
})
