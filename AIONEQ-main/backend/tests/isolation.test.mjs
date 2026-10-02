import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * Integration test: cross-user isolation. Requires a running EchoMind API and
 * real Supabase project (anonymous test users are created).
 *
 * Run:
 *   node --test tests/isolation.test.mjs
 * Requires env: ISOLATION_TEST=1, SUPABASE_URL, SUPABASE_ANON_KEY,
 *   ISOLATION_API=http://localhost:4000
 *   (a TEST_SIGNUP can be used to skip the default new-account mail flow)
 *
 * The test asserts that User A can NEVER read or write User B's memories or
 * conversations via any endpoint.
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

test('logout endpoint works', { skip: !RUN }, async () => {
  const res = await api(a.accessToken, '/api/auth/logout', { method: 'POST' })
  assert.equal(res.status, 200)
})