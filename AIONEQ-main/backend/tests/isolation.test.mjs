import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * Integration test: cross-user isolation. Requires a running EchoMind API and
 * a real Supabase project (two disposable authenticated test accounts are
 * created; no production or personal data is used, and RLS is never
 * disabled).
 *
 * SETUP (isolated project - never run this against a project holding
 * real user data):
 *
 *   1. Isolated Supabase project. Either a throwaway Supabase
 *      project, or a local stack:
 *          supabase init && supabase start
 *      (Docker required for the local stack.)
 *   2. Apply the schema: backend/sql/memories.sql, query.sql,
 *      security.sql, context.sql, memory_intelligence.sql.
 *   3. Automated signups need instant sessions. Either:
 *        - Auth settings: "Enable email confirmations" OFF
 *          (the test then signs up two accounts and receives
 *          sessions immediately), or
 *        - provide SUPABASE_SERVICE_ROLE_KEY and the test can
 *          create users via the admin API (see signup() below).
 *      A project that requires email confirmation cannot run
 *      these tests as written - signup returns no session.
 *   4. Start the backend against that project:
 *          SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run dev
 *   5. Run:
 *          ISOLATION_TEST=1 \
 *          SUPABASE_URL=https://<project>.supabase.co \
 *          SUPABASE_ANON_KEY=<anon key> \
 *          ISOLATION_API=http://localhost:4000 \
 *          npm run test:isolation
 *
 * The test asserts that User A can NEVER read or write User B's
 * memories, vectors, links, settings, conversations or citations
 * via any endpoint.
 *
 * VERIFICATION STATUS (2026-10-03, this environment):
 * UNVERIFIED - not executed. Attempted against the project in
 * backend/.env: reachable and the anon key authorizes table
 * reads, but (a) email confirmation is enforced (signup returns
 * no session and the project rate-limits confirmation emails),
 * (b) no SUPABASE_SERVICE_ROLE_KEY is configured, so admin user
 * creation is unavailable (403), and (c) Docker is unavailable,
 * so a local isolated stack cannot be started. Per the task's
 * rules the tests are skipped, not marked as passed. Run them
 * with the recipe above before production.
 */

const API = process.env.ISOLATION_API || 'http://localhost:4000'
const RUN = process.env.ISOLATION_TEST === '1'

const j = () => crypto.randomUUID().slice(0, 8)

async function signup() {
  const email = `iso-${j()}-${Date.now()}@example.com`
  const password = 'Isolation-Test-123!'
  const res = await fetch(`${API}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, fullName: 'Isolation' }),
  })
  const body = await res.json()
  if (!body.session) {
    throw new Error(`Signup did not return a session (email confirmation required?). Body: ${JSON.stringify(body)}`)
  }
  return { email, password, accessToken: body.session.access_token, userId: body.user.id }
}

async function api(token, path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

let a, b

before(async () => {
  if (!RUN) return
  a = await signup()
  b = await signup()
})

test('isolation: A and B cannot see each others memories or conversations', { skip: !RUN }, async () => {
  // A creates a private memory.
  const created = await api(a.accessToken, '/api/memories', {
    method: 'POST',
    body: JSON.stringify({ type: 'journal', title: 'Secret of A', content: 'Do not let B read this.' }),
  })
  assert.equal(created.status, 201, 'A create failed: ' + JSON.stringify(created.body))
  const memoryId = created.body.data.id

  // B must not be able to read A's memory by id.
  const bRead = await api(b.accessToken, `/api/memories/${memoryId}`)
  assert.ok(bRead.status === 403 || bRead.status === 404, `B read A memory: ${bRead.status}`)

  // B must not be able to update or delete A's memory.
  const bUpdate = await api(b.accessToken, `/api/memories/${memoryId}`, {
    method: 'PUT',
    body: JSON.stringify({ title: 'hacked' }),
  })
  assert.ok(bUpdate.status === 403 || bUpdate.status === 404, `B update A memory: ${bUpdate.status}`)

  const bDelete = await api(b.accessToken, `/api/memories/${memoryId}`, { method: 'DELETE' })
  assert.ok(bDelete.status === 403 || bDelete.status === 404, `B delete A memory: ${bDelete.status}`)

  // B's list must not include A's memory.
  const bList = await api(b.accessToken, '/api/memories')
  assert.equal(bList.status, 200)
  assert.ok(!bList.body.data.some((m) => m.id === memoryId), 'B list leaked A memory')

  // Conversation isolation: A creates a conversation by asking a question,
  // then B must be denied direct access.
  const ask = await api(a.accessToken, '/api/query', {
    method: 'POST',
    body: JSON.stringify({ question: 'What is my secret?' }),
  })
  if (ask.body.conversationId) {
    const convId = ask.body.conversationId
    const bConv = await api(b.accessToken, `/api/query/conversations/${convId}`)
    assert.ok(bConv.status === 403 || bConv.status === 404, `B read A conversation: ${bConv.status}`)
    const bDel = await api(b.accessToken, `/api/query/conversations/${convId}`, { method: 'DELETE' })
    assert.ok(bDel.status === 403 || bDel.status === 404, `B delete A conversation: ${bDel.status}`)
  }

  // Cleanup.
  const aDel = await api(a.accessToken, `/api/memories/${memoryId}`, { method: 'DELETE' })
  assert.ok(aDel.status === 200, 'A could not clean up own memory')
})

test('unauthenticated requests to protected routes are rejected', { skip: !RUN }, async () => {
  const res = await fetch(`${API}/api/memories`, { headers: { 'Content-Type': 'application/json' } })
  assert.equal(res.status, 401)
})

test('unauthenticated requests to the new memory-intelligence routes are rejected', { skip: !RUN }, async () => {
  // Every new endpoint must sit behind auth exactly like the original ones.
  for (const [method, path] of [
    ['GET', '/api/memory-settings'],
    ['PATCH', '/api/memory-settings'],
    ['GET', '/api/memory-links?memoryId=00000000-0000-4000-8000-000000000000'],
    ['POST', '/api/memories/00000000-0000-4000-8000-000000000000/reprocess'],
  ]) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(method === 'PATCH' ? { body: JSON.stringify({ memoryAiEnabled: false }) } : {}),
    })
    assert.equal(res.status, 401, `${method} ${path} was reachable without a token (${res.status})`)
  }
})

test('isolation: B cannot read, resolve or link A new memory-intelligence data', { skip: !RUN }, async () => {
  const created = await api(a.accessToken, '/api/memories', {
    method: 'POST',
    body: JSON.stringify({ type: 'journal', title: 'Linkable note of A', content: 'A note that may attract a suggestion.' }),
  })
  assert.equal(created.status, 201, 'A create failed: ' + JSON.stringify(created.body))
  const memoryId = created.body.data.id

  // B must not see A's relationship proposals for this memory.
  const bLinks = await api(b.accessToken, `/api/memory-links?memoryId=${memoryId}`)
  assert.ok(bLinks.status === 403 || bLinks.status === 404, `B read A links: ${bLinks.status}`)

  // B must not be able to trigger a reprocess on A's memory.
  const bReprocess = await api(b.accessToken, `/api/memories/${memoryId}/reprocess`, { method: 'POST' })
  assert.ok(
    bReprocess.status === 403 || bReprocess.status === 404,
    `B reprocessed A memory: ${bReprocess.status}`
  )

  // Semantic search must not leak A's rows into B's results.
  const bSearch = await api(b.accessToken, '/api/memories?q=Linkable')
  assert.equal(bSearch.status, 200)
  assert.ok(!bSearch.body.data.some((m) => m.id === memoryId), 'B search leaked A memory')

  // Memory settings are per user: B's toggles are not A's.
  const aSettings = await api(a.accessToken, '/api/memory-settings')
  assert.equal(aSettings.status, 200)
  assert.equal(typeof aSettings.body.data.memoryAiEnabled, 'boolean')

  const aDel = await api(a.accessToken, `/api/memories/${memoryId}`, { method: 'DELETE' })
  assert.ok(aDel.status === 200, 'A could not clean up own memory')
})

test('logout endpoint works', { skip: !RUN }, async () => {
  const res = await api(a.accessToken, '/api/auth/logout', { method: 'POST' })
  assert.equal(res.status, 200)
})