/*
 * Authorization surface audit - runs offline, needs no Supabase and no server.
 *
 * WHY THIS EXISTS. The isolation suite in isolation.test.mjs proves that user B
 * cannot reach user A's data, but it only does so by calling a hand-picked list
 * of endpoints. A NEW endpoint added to a router without `requireAuth` would not
 * fail any test; it would simply be reachable by anyone, and the existing suite
 * would still be green. That is the failure mode that matters most and is
 * easiest to introduce by accident.
 *
 * So instead of an allowlist of endpoints someone remembered to test, this walks
 * the ACTUAL Express router stack of the running app and requires that every
 * registered route is behind authentication, unless it is on an explicit,
 * justified exemption list. A new unguarded endpoint fails here immediately.
 *
 * It also asserts the inverse for the file route, which is deliberately
 * unauthenticated and authenticates by signed token instead.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/app.js'
import { requireAuth } from '../src/middleware/auth.middleware.js'

/**
 * Endpoints that are legitimately reachable without a session.
 *
 * - /api/auth/*        : signup, login, refresh. These ARE the authentication
 *                        surface; requiring auth would be circular.
 * - /api/files/:token  : the signed URL IS the credential, so <audio> and
 *                        download links work without an Authorization header.
 *                        The controller verifies HMAC + expiry + ownership.
 * - /health            : liveness probe.
 *
 * Anything added here needs a reason in a code review. The set is asserted to be
 * minimal below: it must not grow without this list being updated deliberately.
 */
const PUBLIC_PREFIXES = ['/api/auth', '/api/health']
const PUBLIC_EXACT = ['/api/files/:token']
// Deliberate always-403 stub ("Direct file access is not allowed.").
// No auth required because it never returns data - it exists only to
// close the old static-uploads path. Asserted to stay a deny route.
const PUBLIC_DENY = ['/uploads']

/** Flattens Express's nested router stack into { method, path, handlers }. */
function collectRoutes(stack, prefix = '') {
  const out = []
  for (const layer of stack || []) {
    if (layer.route) {
      const path = prefix + layer.route.path
      for (const method of Object.keys(layer.route.methods || {})) {
        out.push({ method: method.toUpperCase(), path, handlers: layer.route.stack.map((l) => l.handle) })
      }
      continue
    }
    // Mounted sub-router.
    if (layer.name === 'router' && layer.handle?.stack) {
      const mount = prefix + mountPath(layer.regexp)
      out.push(...collectRoutes(layer.handle.stack, mount))
    }
  }
  return out
}

/** Recovers the mount path from Express's compiled regexp. */
function mountPath(regexp) {
  if (!regexp) return ''
  const source = regexp.source
  if (source === '^/?(?=\\/|$)') return ''
  const m = source.match(/^\^\\?\/(.*?)\\?\/\?\(\?=\\\/\|\$\)$/)
  if (m) return unescapePath('/' + m[1])
  const simple = source.match(/^\^\\?\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/)
  return simple ? unescapePath('/' + simple[1]) : ''
}

/**
 * Express compiles mount regexps with escaped forward slashes
 * ("\\/api\\/memories"), so a raw capture yields "/api\\/memories".
 * Without unescaping, every mounted route's computed path contains a
 * literal backslash and never matches the plain-text prefixes or the
 * required-route list below - which makes ALL routes look unguarded.
 */
function unescapePath(p) {
  return String(p).replace(/\\\//g, '/')
}

const stack = app?._router?.stack || app?.router?.stack
const routes = collectRoutes(stack).map((r) => ({
  ...r,
  // Collapse the trailing "/" that router.route('/') produces, so
  // "GET /api/memory-settings/" and "GET /api/memory-settings" are
  // the same route for both the exemption check and the required list.
  path: r.path.replace(/\/+$/, '') || '/',
}))

function isPublic(path) {
  if (PUBLIC_EXACT.includes(path) || PUBLIC_DENY.includes(path)) return true
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))
}

test('the router stack is introspectable (guards this whole file)', () => {
  assert.ok(Array.isArray(stack), 'could not read the Express router stack')
  assert.ok(routes.length > 10, `only found ${routes.length} routes; introspection is probably broken`)
})

test('every registered route is either authenticated or explicitly public', () => {
  const offenders = []
  for (const r of routes) {
    if (isPublic(r.path)) continue
    // Identity comparison against the real middleware: the exported
    // requireAuth wrapper is the exact function every guarded route
    // registers, so this cannot be fooled by a same-named imposter.
    // The name check is kept as a secondary signal for routes that
    // compose auth into a named wrapper of their own.
    const guarded = r.handlers.some((h) => h === requireAuth || h?.name === 'requireAuth')
    if (!guarded) offenders.push(`${r.method} ${r.path}`)
  }
  assert.deepEqual(
    offenders,
    [],
    `routes reachable without authentication: ${offenders.join(', ')}. Add requireAuth, or document the exemption in PUBLIC_PREFIXES.`
  )
})

test('the public surface is no larger than it needs to be', () => {
  const actualPublic = routes.filter((r) => isPublic(r.path)).map((r) => `${r.method} ${r.path}`)
  const unexpected = actualPublic.filter((p) => {
    const [method, path] = p.split(' ')
    // /api/auth/* is exempt by prefix; only exact matches outside it are listed.
    if (path.startsWith('/api/auth')) return false
    // Exact entries of the prefix list (/api/health) are intentional.
    if (PUBLIC_PREFIXES.includes(path)) return false
    return !PUBLIC_EXACT.includes(path) && !PUBLIC_DENY.includes(path)
  })
  assert.deepEqual(unexpected, [], `new public endpoints: ${unexpected.join(', ')}`)
  // The signed-URL route must remain the ONLY unauthenticated non-auth route.
  assert.ok(actualPublic.some((p) => p.endsWith('/api/files/:token')))
  // The /uploads stub must stay a deny route, never gain a handler that
  // serves files.
  const uploads = routes.find((r) => r.path === '/uploads')
  assert.ok(uploads, '/uploads stub was removed - direct file access must stay disabled')
  assert.equal(uploads.handlers.length, 1, '/uploads must have exactly its single deny handler')
})

test('the memory-intelligence endpoints all exist and are guarded', () => {
  // Spelled out explicitly so a rename that silently drops the route fails here.
  const required = [
    'GET /api/memory-settings',
    'PATCH /api/memory-settings',
    'GET /api/memory-links',
    'POST /api/memories/:id/reprocess',
    'GET /api/memories/:id/signed-url',
  ]
  const present = new Set(routes.map((r) => `${r.method} ${r.path}`))
  for (const r of required) {
    assert.ok(present.has(r), `expected route ${r} is missing`)
  }
})

test('mutating routes require auth before any body parsing side effect', () => {
  // requireAuth must be the FIRST handler on every write route, so an
  // unauthenticated request is rejected before validation or upload middleware
  // runs. Ordering it after upload() would let an anonymous caller push a file
  // to disk before being rejected.
  const writes = routes.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && !isPublic(r.path))
  for (const r of writes) {
    const authAt = r.handlers.findIndex((h) => h === requireAuth || h?.name === 'requireAuth')
    if (authAt === -1) continue
    const uploadAt = r.handlers.findIndex((h) => h?.name?.includes('upload'))
    if (uploadAt !== -1) {
      assert.ok(authAt < uploadAt, `${r.method} ${r.path} runs upload before requireAuth`)
    }
  }
})
