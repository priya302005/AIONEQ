/*
 * Runs the LIVE Supabase isolation suite against a freshly
 * spawned server, the way CI would:
 *
 *   node scripts/runIsolationLive.mjs
 *
 * Requires the project's real credentials in .env
 * (SUPABASE_URL / SUPABASE_ANON_KEY) and an isolated
 * Supabase project - never a project holding real user
 * data. The suite creates two synthetic test accounts.
 *
 * The server is spawned here and killed on exit, so no
 * manual server management is needed. Exit code mirrors
 * the test run (0 = all passed).
 *
 * If the project requires email confirmation, signup
 * returns no session and the suite reports that honestly
 * - it never fakes a pass. See tests/isolation.test.mjs
 * for the full isolated-project setup recipe.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.join(__dirname, '..')
const API = process.env.ISOLATION_API || 'http://127.0.0.1:4000'

async function waitForServer(child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`)
    }
    try {
      const res = await fetch(API + '/api/health', {
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

const server = spawn('node', ['src/server.js'], {
  cwd: backendDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
})
let serverLogs = ''
server.stdout.on('data', (d) => {
  serverLogs += d
})
server.stderr.on('data', (d) => {
  serverLogs += d
})

try {
  const up = await waitForServer(server)
  if (!up) {
    console.error('[FATAL] test server did not come up')
    console.error(serverLogs)
    process.exit(1)
  }
  console.log(`[isolation] server up at ${API}, running live suite...`)

  const test = spawn(
    process.execPath,
    ['--test', 'tests/isolation.test.mjs'],
    {
      cwd: backendDir,
      stdio: 'inherit',
      env: { ...process.env, ISOLATION_TEST: '1', ISOLATION_API: API },
    }
  )
  test.on('exit', (code) => {
    server.kill('SIGKILL')
    process.exit(code ?? 1)
  })
} catch (err) {
  console.error('[FATAL]', err.message)
  console.error(serverLogs)
  server.kill('SIGKILL')
  process.exit(1)
}
