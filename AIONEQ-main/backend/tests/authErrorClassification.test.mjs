/*
 * Tests for classifyAuthError (controllers/auth.controller.js).
 *
 * The behaviour under test is a security-relevant distinction: an unreachable
 * or misconfigured Supabase must NOT be reported to the user as bad
 * credentials, and must NOT count as a failed login attempt (which would let an
 * outage lock a real account out via the lockout backoff). Conversely a genuine
 * credential rejection must stay generic so it cannot be used to enumerate
 * accounts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AUDIT_ENABLED = 'false'

const { classifyAuthError } = await import('../src/controllers/auth.controller.js')

test('classifyAuthError: a request that never reached GoTrue is infrastructure', () => {
  // supabase-js surfaces a connection failure with no HTTP status.
  const result = classifyAuthError(new TypeError('fetch failed'))
  assert.equal(result.kind, 'infra')
  assert.equal(result.httpStatus, 503)
})

test('classifyAuthError: a rejected API key is our misconfiguration, not bad input', () => {
  for (const status of [401, 403]) {
    const result = classifyAuthError({ status, message: 'Invalid API key' })
    assert.equal(result.kind, 'infra', `status ${status} must not be treated as validation`)
    assert.equal(result.httpStatus, 502)
    assert.match(result.reason, /rejected the API key/)
  }
})

test('classifyAuthError: an upstream 5xx is infrastructure', () => {
  const result = classifyAuthError({ status: 503, message: 'Service unavailable' })
  assert.equal(result.kind, 'infra')
  assert.equal(result.httpStatus, 503)
  assert.match(result.reason, /supabase 503/)
})

test('classifyAuthError: upstream throttling is reported as throttling, not invalid', () => {
  const result = classifyAuthError({ status: 429, message: 'Too many requests' })
  assert.equal(result.kind, 'throttled')
  assert.equal(result.httpStatus, 429)
})

test('classifyAuthError: a 4xx about the credentials stays a validation error', () => {
  for (const message of ['User already registered', 'Password should be at least 6 characters']) {
    const result = classifyAuthError({ status: 400, message })
    assert.equal(result.kind, 'validation', `"${message}" must stay a validation error`)
    assert.equal(result.httpStatus, 400)
    assert.equal(result.reason, message, 'the real reason is kept for the server-side log')
  }
})

test('the unavailable message does not tell a placeholder-credential user to retry', async () => {
  // "Please try again in a moment" is right for a genuine outage and wrong for
  // sample credentials, where retrying can never succeed. The browser must be
  // able to tell the difference, or the user loops forever.
  const { authUnavailableMessage } = await import('../src/controllers/auth.controller.js')

  // Both branches are asserted explicitly rather than through config, so the
  // result does not change with whatever .env the suite happens to run against.
  const permanent = authUnavailableMessage(false)
  assert.match(permanent, /Retrying will not work/)
  assert.match(permanent, /SUPABASE_URL/)
  assert.doesNotMatch(permanent, /try again in a moment/i)

  const transient = authUnavailableMessage(true)
  assert.match(transient, /try again in a moment/i)
  assert.doesNotMatch(transient, /Retrying will not work/)
})
