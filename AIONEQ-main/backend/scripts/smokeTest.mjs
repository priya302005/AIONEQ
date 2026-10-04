/*
 * EchoMind infrastructure smoke test.
 *
 *   node scripts/smokeTest.mjs                 # infra checks only
 *   API_TOKEN=... node scripts/smokeTest.mjs   # + authenticated checks
 *
 * Spawns the real server (src/server.js) against the configured
 * Supabase project and verifies the deployment's security surface
 * that does NOT require user credentials:
 *
 *   - /api/health responds 200
 *   - Helmet security headers are present
 *   - every /api route except /api/health and /api/auth refuses
 *     a missing token with 401 (auth is enforced, not optional)
 *   - a garbage token is rejected with 401
 *   - /uploads direct access is blocked (403)
 *   - CORS refuses an unconfigured origin and allows a configured
 *     one
 *
 * AUTH-DEPENDENT WORKFLOW (steps 1-12 of the production smoke
 * list) needs a real test account and a running local LLM. Pass
 * API_TOKEN to also exercise the full core memory lifecycle
 * against the live project: authenticate (list + settings),
 * create a synthetic memory, retrieve it by id, search for it,
 * ask a grounded question, verify consent behaviour (memory-AI
 * off => zero citations), cross-user authorization (pass a
 * second, distinct API_TOKEN_B), then delete the memory and
 * verify it is no longer retrievable. The synthetic memory is
 * cleaned up on success or failure. Without API_TOKEN those
 * steps are reported as "skipped (no API_TOKEN)".
 *
 * The server is killed on exit. Exit code 0 = all executed
 * checks passed; 1 = a check failed or the server would not
 * start.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4000'
const ALLOWED_ORIGIN = process.env.SMOKE_ALLOWED_ORIGIN || 'http://localhost:5173'
const EVIL_ORIGIN = 'http://evil.example'

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
}
const skip = (name, reason) => {
  results.push({ name, ok: null, detail: reason })
  console.log(`SKIP  ${name} - ${reason}`)
}

async function request(pathname, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  })
  const cors = res.headers.get('access-control-allow-origin')
  let responseBody = null
  try {
    responseBody = await res.json()
  } catch {
    responseBody = null
  }
  return { status: res.status, cors, headers: res.headers, body: responseBody }
}

async function waitForServer(child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`)
    }
    try {
      const r = await request('/api/health')
      if (r.status === 200) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

function securityHeadersPresent(res) {
  const h = res.headers
  return {
    contentTypeOptions: h.get('x-content-type-options') === 'nosniff',
    frameOptions:
      h.get('x-frame-options') === 'SAMEORIGIN' ||
      h.get('content-security-policy')?.includes("frame-ancestors 'none'"),
    referrerPolicy: (h.get('referrer-policy') || '').startsWith('no-referrer'),
    hsts: h.get('strict-transport-security') !== null, // dev may omit
  }
}

async function main() {
  console.log(`EchoMind smoke test against ${BASE}`)
  console.log('='.repeat(60))

  // 1. Boot the real server.
  const child = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  let serverLogs = ''
  child.stdout.on('data', (d) => {
    serverLogs += d
  })
  child.stderr.on('data', (d) => {
    serverLogs += d
  })

  let up = false
  try {
    up = await waitForServer(child)
  } catch (err) {
    record('server starts', false, err.message)
    console.log(serverLogs)
    child.kill('SIGKILL')
    process.exit(1)
  }
  if (!up) {
    record('server starts and answers /api/health', false, 'did not come up in 20s')
    console.log(serverLogs)
    child.kill('SIGKILL')
    process.exit(1)
  }
  record('server starts and answers /api/health', true)

  try {
    // 2. Health body.
    const health = await request('/api/health')
    record('health body is { status: ok }', health.body?.status === 'ok', JSON.stringify(health.body))

    // 3. Security headers.
    const sh = securityHeadersPresent(health)
    record(
      'Helmet security headers (nosniff, framing, referrer)',
      sh.contentTypeOptions && sh.frameOptions && sh.referrerPolicy,
      `nosniff=${sh.contentTypeOptions} framing=${sh.frameOptions} referrer=${sh.referrerPolicy}`
    )
    // HSTS is production-only by design; report it, do not fail dev.
    if (!sh.hsts) {
      console.log('NOTE  HSTS not set (expected unless NODE_ENV=production)')
    }

    // 4. Auth is enforced on every protected route (each with
    //    its real method, so the guard - not a 404 - answers).
    const protectedRoutes = [
      { route: '/api/memories', method: 'GET' },
      { route: '/api/query/conversations', method: 'GET' },
      { route: '/api/export', method: 'POST' },
      { route: '/api/account', method: 'DELETE' },
      { route: '/api/memory-links', method: 'GET' },
      { route: '/api/memory-settings', method: 'GET' },
    ]
    for (const { route, method } of protectedRoutes) {
      const noAuth = await request(route, { method })
      record(`401 without token: ${method} ${route}`, noAuth.status === 401, `got ${noAuth.status}`)

      const garbage = await request(route, {
        method,
        headers: { Authorization: 'Bearer not-a-real-token' },
      })
      record(`401 with garbage token: ${method} ${route}`, garbage.status === 401, `got ${garbage.status}`)
    }

    // 5. Direct upload access is blocked.
    const uploads = await request('/uploads')
    record('direct /uploads access blocked', uploads.status === 403, `got ${uploads.status}`)

    // 6. CORS: unconfigured origin refused, configured origin allowed.
    const evil = await request('/api/memories', {
      method: 'OPTIONS',
      headers: { Origin: EVIL_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    })
    record(
      'CORS refuses unconfigured origin',
      evil.cors !== ALLOWED_ORIGIN && !evil.cors?.includes('evil.example'),
      `status=${evil.status} acao=${evil.cors}`
    )
    const allowed = await request('/api/memories', {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    })
    record(
      'CORS allows configured origin',
      allowed.cors === ALLOWED_ORIGIN,
      `status=${allowed.status} acao=${allowed.cors}`
    )

    // 7. Authenticated workflow (needs a real, dedicated
    //    test-account token supplied via API_TOKEN). Exercises
    //    the core memory lifecycle end to end against the live
    //    project: authenticate -> create -> retrieve -> search ->
    //    grounded ask -> consent behaviour -> (cross-user
    //    authorization, if a second token is supplied) ->
    //    delete -> verify gone. The synthetic memory is always
    //    cleaned up, on success or failure.
    const token = process.env.API_TOKEN
    if (!token) {
      skip('authenticated lifecycle', 'no API_TOKEN provided')
    } else {
      const auth = { Authorization: `Bearer ${token}` }
      const json = { 'Content-Type': 'application/json' }

      // 7.1 Authenticate: a valid token must list memories and
      //     read settings (a bad token 401s, checked above).
      const list = await request('/api/memories', { headers: auth })
      record('authenticated memory list succeeds', list.status === 200, `got ${list.status}`)

      const settings = await request('/api/memory-settings', { headers: auth })
      record('authenticated settings read succeeds', settings.status === 200, `got ${settings.status}`)

      // A unique marker so every step below targets only the
      // memory this run creates - never pre-existing user data.
      const marker = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      let createdId = null
      const originalMemoryAi =
        settings.status === 200 && settings.body?.data ? settings.body.data.memoryAiEnabled : null
      let llmAvailable = null

      try {
        // 7.2 Create a synthetic typed memory (text only, no file).
        const create = await request('/api/memories', {
          method: 'POST',
          headers: { ...auth, ...json },
          body: JSON.stringify({
            type: 'journal',
            title: `Smoke test memory ${marker}`,
            content: `EchoMind authenticated smoke-test note. Marker: ${marker}. Created and deleted automatically by the smoke test; it holds no real data.`,
            tags: ['smoke-test'],
          }),
        })
        createdId = create.body?.data?.id || null
        record(
          'create synthetic memory',
          create.status === 201 && Boolean(createdId),
          `got ${create.status} id=${createdId || 'none'}`
        )

        // 7.3 Retrieve it by id.
        if (createdId) {
          const got = await request(`/api/memories/${createdId}`, { headers: auth })
          record(
            'retrieve created memory by id',
            got.status === 200 && got.body?.data?.id === createdId,
            `got ${got.status}`
          )

          // 7.4 Search for it (hybrid retrieval finds the marker).
          const search = await request(`/api/memories?q=${encodeURIComponent(marker)}`, {
            headers: auth,
          })
          const found =
            Array.isArray(search.body?.data) && search.body.data.some((m) => m.id === createdId)
          record('search finds created memory', search.status === 200 && found, `got ${search.status} found=${found}`)

          // 7.5 Ask a grounded question about it.
          const ask = await request('/api/query', {
            method: 'POST',
            headers: { ...auth, ...json },
            body: JSON.stringify({ question: `What does my note about ${marker} say?` }),
          })
          if (ask.status === 200) {
            llmAvailable = true
            const usedIds = (ask.body?.usedMemories || []).map((m) => m.memoryId)
            record(
              'grounded ask succeeds',
              true,
              `${usedIds.length} memory(ies) used; created memory used=${usedIds.includes(createdId)}`
            )
          } else if (ask.status === 503) {
            llmAvailable = false
            // No local LLM running: the server must fail closed
            // (refuse to answer) rather than answer from nothing.
            record('grounded ask fails closed when the LLM is unavailable', true, 'got 503 (LLM unreachable - not a defect)')
          } else {
            record(
              'grounded ask succeeds or fails closed',
              false,
              `unexpected status ${ask.status}: ${ask.body?.message || ''}`
            )
          }

          // 7.6 Consent behaviour: with memory-AI disabled the ask
          //      must retrieve nothing and cite nothing. The toggle
          //      must persist; the empty-citation invariant is only
          //      observable when the LLM is up (otherwise the ask
          //      fails closed before any citation can exist).
          if (originalMemoryAi !== null) {
            const off = await request('/api/memory-settings', {
              method: 'PATCH',
              headers: { ...auth, ...json },
              body: JSON.stringify({ memoryAiEnabled: false }),
            })
            record(
              'consent toggle persists (memory-AI off)',
              off.status === 200 && off.body?.data?.memoryAiEnabled === false,
              `got ${off.status} memoryAiEnabled=${off.body?.data?.memoryAiEnabled}`
            )

            if (llmAvailable === true) {
              const consentAsk = await request('/api/query', {
                method: 'POST',
                headers: { ...auth, ...json },
                body: JSON.stringify({ question: `What does my note about ${marker} say?` }),
              })
              if (consentAsk.status === 200) {
                const cited = consentAsk.body?.citedMemories || []
                const used = consentAsk.body?.usedMemories || []
                record(
                  'consent off: ask cites and uses zero memories',
                  Array.isArray(cited) && cited.length === 0 && Array.isArray(used) && used.length === 0,
                  `cited=${cited.length} used=${used.length}`
                )
              } else {
                record('consent off: ask cites and uses zero memories', false, `got ${consentAsk.status}`)
              }
            } else {
              skip('consent off: ask cites and uses zero memories', 'LLM unavailable - invariant not observable')
            }
          }

          // 7.7 Cross-user authorization (needs a second, distinct
          //      token). Another user must not read this memory.
          const tokenB = process.env.API_TOKEN_B
          if (!tokenB) {
            skip('cross-user authorization (second token)', 'no API_TOKEN_B provided')
          } else {
            const otherUser = await request(`/api/memories/${createdId}`, {
              headers: { Authorization: `Bearer ${tokenB}` },
            })
            record(
              'another user cannot read this memory (RLS)',
              otherUser.status === 404 || otherUser.status === 403,
              `got ${otherUser.status}`
            )
          }
        }

        // 7.8 Delete the synthetic memory.
        if (createdId) {
          const del = await request(`/api/memories/${createdId}`, { method: 'DELETE', headers: auth })
          record('delete synthetic memory', del.status === 200, `got ${del.status}`)

          // 7.9 Verify it is gone: direct fetch 404s and search no
          //     longer returns it.
          if (del.status === 200) {
            const gone = await request(`/api/memories/${createdId}`, { headers: auth })
            record('deleted memory is no longer retrievable (404)', gone.status === 404, `got ${gone.status}`)

            const searchAfter = await request(`/api/memories?q=${encodeURIComponent(marker)}`, {
              headers: auth,
            })
            const stillThere =
              Array.isArray(searchAfter.body?.data) &&
              searchAfter.body.data.some((m) => m.id === createdId)
            record('deleted memory no longer appears in search', !stillThere, `stillPresent=${stillThere}`)
          }
        }
      } finally {
        // Cleanup runs on success OR failure so the test account is
        // never left with stray synthetic data and the consent
        // setting is returned to its original value.
        if (createdId) {
          await request(`/api/memories/${createdId}`, { method: 'DELETE', headers: auth }).catch(() => {})
        }
        if (originalMemoryAi !== null) {
          await request('/api/memory-settings', {
            method: 'PATCH',
            headers: { ...auth, ...json },
            body: JSON.stringify({ memoryAiEnabled: originalMemoryAi }),
          }).catch(() => {})
        }
      }
    }
  } finally {
    child.kill('SIGKILL')
  }

  const failed = results.filter((r) => r.ok === false)
  const skipped = results.filter((r) => r.ok === null)
  console.log('='.repeat(60))
  console.log(`SMOKE RESULT: ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('smoke test crashed:', err)
  process.exit(1)
})
