/*
 * Regression test: a page reload must not sign the user out.
 *
 * Why this exists as a script instead of a unit test: the defect lived in the
 * SHAPE of the object the storage adapter returns, and the only thing that
 * judges that shape is @supabase/auth-js itself. So this drives the real
 * client against a fake GoTrue server and asserts the end-to-end outcome:
 * the refresh token survives the reload and getUser() returns the user.
 *
 * It failed loudly before the fix (0 refresh attempts, "Auth session missing!",
 * both cookies deleted). If a future auth-js upgrade tightens its storage
 * contract again, this is what catches it.
 *
 * Run: npm run test:session
 */
import { createClient } from '@supabase/supabase-js'
import assert from 'node:assert/strict'
import http from 'node:http'

const STORAGE_KEY = 'echomind-session'
const COOKIE_RT = 'echomind_rt'
const COOKIE_RT_EXP = 'echomind_rt_exp'

// --------------------------------------------------------------- fake cookie
const jar = new Map()
globalThis.document = {
  get cookie() {
    return [...jar.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
  },
  set cookie(str) {
    const [pair, ...attrs] = str.split(';')
    const i = pair.indexOf('=')
    const name = pair.slice(0, i).trim()
    const value = pair.slice(i + 1)
    const maxAge = attrs.find((a) => /max-age/i.test(a))
    if (maxAge && Number(maxAge.split('=')[1]) === 0) jar.delete(name)
    else jar.set(name, value)
  },
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
}
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { href: 'http://localhost/' } }
globalThis.location = { origin: 'http://localhost', protocol: 'http:', href: 'http://localhost/' }

// ------------------------------------------------------------- fake GoTrue --
let refreshCalls = 0
const server = http.createServer((req, res) => {
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.url.includes('/token')) {
    refreshCalls++
    return json({
      access_token: 'fresh-access-token',
      token_type: 'bearer',
      expires_in: 3600,
      // Supabase rotates the refresh token; the cookie must follow it.
      refresh_token: 'rotated-refresh-token',
      user: { id: 'user-1', email: 'tester@example.com', user_metadata: { full_name: 'Tester' } },
    })
  }
  if (req.url.includes('/user')) {
    return json({ id: 'user-1', email: 'tester@example.com', user_metadata: { full_name: 'Tester' } })
  }
  res.writeHead(404)
  res.end('{}')
})
await new Promise((r) => server.listen(0, r))
const GOTRUE = `http://127.0.0.1:${server.address().port}/auth/v1`

// ------------------------------------------------------ the storage adapter --
/**
 * Mirrors src/supabaseClient.js. `sessionFromCookies` is the only thing that
 * varies between the buggy and fixed versions, so the rest stays identical.
 */
function makeAdapter(sessionFromCookies) {
  let memorySession = null
  return {
    async getItem(key) {
      if (key !== STORAGE_KEY) return null
      if (memorySession) return memorySession
      const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_RT}=([^;]*)`))
      if (!match) return null
      return sessionFromCookies(decodeURIComponent(match[1]))
    },
    async setItem(key, value) {
      if (key !== STORAGE_KEY) return
      memorySession = value
      try {
        const s = JSON.parse(value)
        if (s?.refresh_token) {
          document.cookie = `${COOKIE_RT}=${encodeURIComponent(s.refresh_token)};path=/;SameSite=Strict;Max-Age=604800`
        }
        if (s?.expires_at) {
          document.cookie = `${COOKIE_RT_EXP}=${s.expires_at};path=/;SameSite=Strict;Max-Age=604800`
        }
      } catch {
        /* invalid payload - leave cookies untouched */
      }
    },
    async removeItem(key) {
      if (key !== STORAGE_KEY) return
      memorySession = null
      document.cookie = `${COOKIE_RT}=;path=/;SameSite=Strict;Max-Age=0`
      document.cookie = `${COOKIE_RT_EXP}=;path=/;SameSite=Strict;Max-Age=0`
    },
  }
}

/** The shape this app shipped, which auth-js rejects. Kept to prove the fix. */
const BUGGY = (rt) =>
  JSON.stringify({ refresh_token: rt, token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600 })

/** The fixed shape: valid keys, and expired on purpose to force a refresh. */
const FIXED = (rt) => JSON.stringify({ access_token: '', refresh_token: rt, token_type: 'bearer', expires_at: 0 })

// ------------------------------------------------------------------- test ---
async function reload(sessionFromCookies) {
  jar.clear()
  refreshCalls = 0
  // Cookies as setItem() would have left them after a successful sign-in.
  jar.set(COOKIE_RT, 'user-refresh-token')
  jar.set(COOKIE_RT_EXP, String(Math.floor(Date.now() / 1000) + 3600))

  const client = createClient(GOTRUE, 'anon-key', {
    auth: {
      storage: makeAdapter(sessionFromCookies),
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  })

  const events = []
  client.auth.onAuthStateChange((e, s) => events.push(`${e}:${s?.user ? 'user' : 'null'}`))

  // Exactly what AuthProvider does on mount, i.e. what a page reload does.
  const { data, error } = await client.auth.getUser()
  return {
    email: data?.user?.email ?? null,
    error: error?.message ?? null,
    refreshCalls,
    refreshTokenKept: jar.has(COOKIE_RT),
    events,
  }
}

const before = await reload(BUGGY)
const after = await reload(FIXED)

console.log('buggy adapter :', JSON.stringify(before))
console.log('fixed adapter :', JSON.stringify(after))
console.log('')

assert.equal(before.email, null, 'precondition: the buggy shape must fail')
assert.equal(before.refreshCalls, 0, 'precondition: the buggy shape never attempted a refresh')
assert.equal(before.refreshTokenKept, false, 'precondition: the buggy shape destroyed the refresh token')

assert.equal(after.error, null, `reload must not error, got: ${after.error}`)
assert.equal(after.email, 'tester@example.com', 'reload must restore the user')
assert.equal(after.refreshCalls, 1, 'reload must exchange the refresh token exactly once')
assert.ok(after.refreshTokenKept, 'reload must keep the refresh token')
assert.ok(
  after.events.includes('INITIAL_SESSION:user'),
  `INITIAL_SESSION must carry the user, got: ${after.events.join(', ')}`
)

console.log('PASS - a reload restores the session instead of destroying it')
server.close()
// auth-js keeps a 30s auto-refresh timer alive, so exit once the assertions
// are done rather than letting the process hang.
process.exit(0)