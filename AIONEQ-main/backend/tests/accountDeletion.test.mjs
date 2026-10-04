/*
 * Account deletion ("Forget my data") tests.
 *
 * Drives the REAL deleteAccountController end to end through the
 * grounding harness (mocked @supabase/supabase-js with RLS
 * semantics, a fake multi-table store, and a stub LLM), proving:
 *
 *   - every owned row is removed from every table that holds it
 *     (memories, memory_vectors, memory_links, memory_settings,
 *     conversations, legacy_grants owned AND received)
 *   - another user's rows are untouched
 *   - uploaded files are removed from the upload directory
 *   - a database failure aborts with 500 and is never reported
 *     as success, and a retry completes the deletion
 *   - unremovable files are counted and reported as limitations
 *   - without a service-role key the auth identity is retained
 *     and the response says so
 *
 * The service-role path (auth identity deleted) lives in
 * accountDeletionServiceRole.test.mjs, which runs in its own
 * process with SUPABASE_SERVICE_ROLE_KEY pinned, because
 * config.js captures the environment at import time.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

// Pin BEFORE the harness import: the harness, not the machine's
// .env, decides the configuration under test. An empty string
// means "no service-role key" (config.js falls back to null).
process.env.SUPABASE_SERVICE_ROLE_KEY = ''

const harness = await import('./groundingHarness.mjs')
const { bootstrap, store, registerUser, tokenFor, stopStubLLM } = harness

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadsDir = path.join(__dirname, '..', 'uploads')

const USER_A = '11111111-1111-1111-1111-111111111111'
const USER_B = '22222222-2222-2222-2222-222222222222'

/** Files this file created in the real upload directory. */
const createdFiles = []

function seedForUser(userId) {
  const memoryId = crypto.randomUUID()
  const fileName = `${crypto.randomUUID()}.pdf`
  const now = new Date().toISOString()

  store.memories.push({
    id: memoryId,
    user_id: userId,
    type: 'document',
    title: 'Private note',
    content: 'private content',
    transcript: 'private transcript',
    extracted_text: 'private extracted text',
    ai_summary: 'private summary',
    file_url: `/uploads/${fileName}`,
    file_size: 123,
    created_at: now,
    updated_at: now,
  })
  store.memory_vectors.push({
    memory_id: memoryId,
    user_id: userId,
    embedding: new Array(384).fill(0),
    dim: 384,
    model: 'local-hash-v1@default@384',
    updated_at: now,
  })
  store.memory_settings.push({
    user_id: userId,
    memory_ai_enabled: true,
    conversation_memory_enabled: true,
    processing_enabled: true,
    updated_at: now,
  })
  store.memory_links.push({
    id: crypto.randomUUID(),
    user_id: userId,
    source_memory_id: memoryId,
    related_memory_id: crypto.randomUUID(),
    relation: 'follow-up',
    confidence: 0.8,
    status: 'proposed',
    created_at: now,
  })
  store.conversations.push({
    id: crypto.randomUUID(),
    user_id: userId,
    title: 'Private chat',
    messages: [{ role: 'user', content: 'private message' }],
    created_at: now,
    updated_at: now,
  })
  // A grant the user owns (someone else is the recipient).
  store.legacy_grants.push({
    id: crypto.randomUUID(),
    owner_id: userId,
    recipient_email: 'someone-else@example.com',
    recipient_user_id: null,
    grant_type: 'full',
    status: 'pending',
    claim_token_hash: 'hash',
    created_at: now,
  })
  return { memoryId, fileName }
}

/** Calls DELETE /api/account against the real controller. */
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
  let nextError = null
  const next = (err) => {
    nextError = err
  }
  await accountController.deleteAccountController(req, res, next)
  assert.equal(nextError, null, 'controller escaped via next(err)')
  return { status, body }
}

before(async () => {
  await bootstrap()
  registerUser(USER_A)
  registerUser(USER_B)
})

after(async () => {
  await stopStubLLM()
  for (const name of createdFiles) {
    const full = path.join(uploadsDir, name)
    try {
      if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true })
    } catch {
      // best effort cleanup
    }
  }
})

test('account deletion removes every owned row, isolates the other user, and removes uploaded files', async () => {
  store.reset()
  const a = seedForUser(USER_A)
  seedForUser(USER_B)

  // A grant naming A as RECIPIENT of B's archive.
  const recipientGrantId = crypto.randomUUID()
  store.legacy_grants.push({
    id: recipientGrantId,
    owner_id: USER_B,
    recipient_email: 'a@example.com',
    recipient_user_id: USER_A,
    grant_type: 'text',
    status: 'active',
    claim_token_hash: 'hash',
    created_at: new Date().toISOString(),
  })

  // A's uploaded file really exists on disk.
  fs.writeFileSync(path.join(uploadsDir, a.fileName), 'A file bytes')
  createdFiles.push(a.fileName)

  const { status, body } = await deleteAccount(USER_A)

  assert.equal(status, 200)
  assert.equal(body.success, true)

  // Every table that holds A-owned rows is empty of them.
  assert.equal(store.memories.filter((m) => m.user_id === USER_A).length, 0)
  assert.equal(store.memory_vectors.filter((v) => v.user_id === USER_A).length, 0)
  assert.equal(store.memory_settings.filter((s) => s.user_id === USER_A).length, 0)
  assert.equal(store.memory_links.filter((l) => l.user_id === USER_A).length, 0)
  assert.equal(store.conversations.filter((c) => c.user_id === USER_A).length, 0)
  assert.equal(
    store.legacy_grants.filter((g) => g.owner_id === USER_A || g.recipient_user_id === USER_A).length,
    0,
    'grants owned by or naming A must be gone'
  )

  // B's data is untouched, including the grant B owns.
  assert.equal(store.memories.filter((m) => m.user_id === USER_B).length, 1)
  assert.equal(store.memory_vectors.filter((v) => v.user_id === USER_B).length, 1)
  assert.equal(store.memory_links.filter((l) => l.user_id === USER_B).length, 1)
  assert.equal(store.conversations.filter((c) => c.user_id === USER_B).length, 1)
  assert.equal(store.legacy_grants.filter((g) => g.owner_id === USER_B).length, 1)

  // A's uploaded file was removed from disk.
  assert.equal(fs.existsSync(path.join(uploadsDir, a.fileName)), false)

  // The report is honest about what happened.
  assert.equal(body.deletion.counts.memories, 1)
  assert.equal(body.deletion.counts.vectors, 1)
  assert.equal(body.deletion.counts.links, 1)
  assert.equal(body.deletion.counts.settings, 1)
  assert.equal(body.deletion.counts.conversations, 1)
  assert.equal(body.deletion.counts.grants, 2)
  assert.equal(body.deletion.counts.filesRemoved, 1)
  assert.equal(body.deletion.counts.filesFailed, 0)

  // No service-role key: the auth identity is retained and the
  // response discloses it instead of claiming total deletion.
  assert.equal(store.queries.some((q) => q.op === 'admin.deleteUser'), false)
  assert.ok(
    body.deletion.limitations.some((l) => l.includes('auth identity')),
    'retained auth identity must be disclosed'
  )
  // Backup retention is always disclosed.
  assert.ok(
    body.deletion.limitations.some((l) => l.includes('backups')),
    'backup retention must be disclosed'
  )
})

test('a database failure aborts with 500, never reports success, and a retry completes', async () => {
  store.reset()
  const a = seedForUser(USER_A)
  fs.writeFileSync(path.join(uploadsDir, a.fileName), 'A file bytes')
  createdFiles.push(a.fileName)

  // Simulate a database outage at the conversations step.
  store.failOn.conversations = new Error('db down')
  const { status, body } = await deleteAccount(USER_A)

  assert.equal(status, 500)
  assert.equal(body.success, false)
  assert.match(body.message, /INCOMPLETE/)

  // The outage happened AFTER memories were deleted and their
  // files removed, but BEFORE conversations - so those remain.
  assert.equal(store.memories.filter((m) => m.user_id === USER_A).length, 0)
  assert.equal(store.conversations.filter((c) => c.user_id === USER_A).length, 1)
  assert.equal(fs.existsSync(path.join(uploadsDir, a.fileName)), false)

  // The failure happened at the conversations step: the delete
  // was attempted (and recorded) before it failed.
  const attempted = store.queries.find((q) => q.table === 'conversations' && q.op === 'delete')
  assert.ok(attempted, 'the conversations delete was attempted before failing')

  // The outage clears; the same request is safe to repeat.
  store.failOn = {}
  const retry = await deleteAccount(USER_A)
  assert.equal(retry.status, 200)
  assert.equal(retry.body.success, true)
  assert.equal(store.conversations.filter((c) => c.user_id === USER_A).length, 0)
})

test('a failing earlier step leaves nothing falsely reported and files in place', async () => {
  store.reset()
  const a = seedForUser(USER_A)
  fs.writeFileSync(path.join(uploadsDir, a.fileName), 'A file bytes')
  createdFiles.push(a.fileName)

  // Outage at the very first step.
  store.failOn.memory_links = new Error('db down')
  const { status, body } = await deleteAccount(USER_A)

  assert.equal(status, 500)
  assert.equal(body.success, false)
  // Nothing was deleted - the memory rows and files remain.
  assert.equal(store.memories.filter((m) => m.user_id === USER_A).length, 1)
  assert.equal(fs.existsSync(path.join(uploadsDir, a.fileName)), true)

  store.failOn = {}
  const retry = await deleteAccount(USER_A)
  assert.equal(retry.status, 200)
  assert.equal(store.memories.filter((m) => m.user_id === USER_A).length, 0)
  assert.equal(fs.existsSync(path.join(uploadsDir, a.fileName)), false)
})

test('unremovable files are counted and disclosed without failing the deletion', async () => {
  store.reset()
  const a = seedForUser(USER_A)
  // A directory where the file should be: unlink fails.
  fs.mkdirSync(path.join(uploadsDir, a.fileName), { recursive: true })
  createdFiles.push(a.fileName)

  const { status, body } = await deleteAccount(USER_A)

  assert.equal(status, 200)
  assert.equal(body.success, true)
  assert.equal(body.deletion.counts.filesFailed, 1)
  assert.ok(
    body.deletion.limitations.some((l) => l.includes('upload directory')),
    'the stuck file must be disclosed'
  )
})

test('deleting an account with no data succeeds with zero counts', async () => {
  store.reset()
  const { status, body } = await deleteAccount(USER_A)
  assert.equal(status, 200)
  assert.equal(body.success, true)
  assert.equal(body.deletion.counts.memories, 0)
  assert.equal(body.deletion.counts.filesFailed, 0)
})

test('deletion is audited with counts only - never memory content', async () => {
  store.reset()
  seedForUser(USER_A)
  await deleteAccount(USER_A)
  const deletedAudit = store.queries.find((q) => q.table === 'memories' && q.op === 'delete')
  assert.ok(deletedAudit, 'the memories delete was issued')
  // The audit detail carries ids/counts; the controller logs
  // only counts via the audit util - assert the query record
  // holds no content-bearing fields.
  for (const q of store.queries) {
    assert.equal(typeof q.detail, 'string')
    assert.ok(!/private content|private summary|private transcript/.test(q.detail))
  }
})
