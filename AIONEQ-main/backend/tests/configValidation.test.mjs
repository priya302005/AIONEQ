/*
 * Focused tests for the Phase 9.1 configuration changes:
 *
 *   1. Production validation of SIGNED_URL_SECRET
 *      (dedicated, strong, never the anon key) via checkEnv.
 *   2. Upload-scan fail-closed behaviour via scanFile:
 *      required + no scanner => rejected; not required + no
 *      scanner => allowed (dev/test); scanner failure => rejected.
 *   3. The secure legacy-verification default (access-code).
 *
 * checkEnv is pure (no process.exit) and scanFile accepts an
 * injected config, so these run without touching the real
 * environment or spawning a server.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Force the LEGACY_VERIFICATION *default* path (empty string is
// falsy, so config.js falls back to its default). Set before any
// module that imports src/config/config.js - that module captures
// the environment at import time, and dotenv does not override
// variables already present in process.env. Also silence the audit
// log so scanFile tests do not write entries.
process.env.LEGACY_VERIFICATION = ''
process.env.AUDIT_ENABLED = 'false'

const { checkEnv, MIN_SIGNED_URL_SECRET_LENGTH } = await import(
  '../src/config/startup.js'
)
const { scanFile } = await import('../src/middleware/scan.middleware.js')
const { config } = await import('../src/config/config.js')

// A temporary file for the scanner-failure path (the scanner
// command is bogus, so it never reads the file, but a real path
// keeps the test realistic).
const tmpFile = path.join(os.tmpdir(), `scan-validation-${process.pid}.bin`)
fs.writeFileSync(tmpFile, 'scan-validation fixture')
after(() => {
  try {
    fs.rmSync(tmpFile, { force: true })
  } catch {
    /* best effort */
  }
})

/** A valid production config; override individual fields per test. */
function baseCfg(overrides = {}) {
  return {
    env: 'production',
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'anon-key-value',
    signedUrlSecret: 'a'.repeat(MIN_SIGNED_URL_SECRET_LENGTH),
    localAiBaseUrl: 'http://localhost:4891',
    supabaseServiceRoleKey: 'service-role-value',
    ...overrides,
  }
}

// ------------------------------------------------- SIGNED_URL_SECRET ----

test('checkEnv: valid production config has no errors', () => {
  const { missing, productionErrors, warnings } = checkEnv(baseCfg())
  assert.deepEqual(missing, [])
  assert.deepEqual(productionErrors, [])
  assert.deepEqual(warnings, [])
})

test('checkEnv: production rejects a secret that IS the anon key', () => {
  const { productionErrors } = checkEnv(
    baseCfg({ signedUrlSecret: 'anon-key-value' })
  )
  assert.ok(
    productionErrors.some((e) => e.includes('must not be the Supabase anon key')),
    `expected anon-key rejection, got: ${productionErrors}`
  )
})

test('checkEnv: production rejects a weak (too short) secret', () => {
  const { productionErrors } = checkEnv(baseCfg({ signedUrlSecret: 'short' }))
  assert.ok(
    productionErrors.some((e) => e.includes('too short')),
    `expected too-short rejection, got: ${productionErrors}`
  )
})

test('checkEnv: a missing signed-url secret is fatal everywhere', () => {
  const prod = checkEnv(baseCfg({ signedUrlSecret: '' }))
  assert.ok(prod.missing.includes('SIGNED_URL_SECRET'))
  const dev = checkEnv(baseCfg({ env: 'development', signedUrlSecret: '' }))
  assert.ok(dev.missing.includes('SIGNED_URL_SECRET'))
})

test('checkEnv: development may fall back to the anon key (warned, not fatal)', () => {
  const { productionErrors, warnings } = checkEnv(
    baseCfg({ env: 'development', signedUrlSecret: 'anon-key-value' })
  )
  assert.deepEqual(productionErrors, [], 'dev fallback must not be fatal')
  assert.ok(
    warnings.some((w) => w.includes('falling back to SUPABASE_ANON_KEY')),
    `expected a dev fallback warning, got: ${warnings}`
  )
})

test('checkEnv: a non-localhost LLM is fatal in every environment', () => {
  for (const env of ['production', 'development']) {
    const { productionErrors } = checkEnv(
      baseCfg({ env, localAiBaseUrl: 'http://example.com:4891' })
    )
    assert.ok(
      productionErrors.some((e) => e.includes('must run on localhost')),
      `${env}: expected localhost-only enforcement, got: ${productionErrors}`
    )
  }
})

test('checkEnv: an invalid LLM URL is fatal', () => {
  const { productionErrors } = checkEnv(baseCfg({ localAiBaseUrl: 'not-a-url' }))
  assert.ok(
    productionErrors.some((e) => e.includes('not a valid URL')),
    `expected invalid-URL rejection, got: ${productionErrors}`
  )
})

// ------------------------------------------------- upload scanning ----

test('scanFile: required + no scanner fails closed (not clean)', async () => {
  const result = await scanFile(tmpFile, { userId: 'u', ip: '127.0.0.1' }, {
    scanCommand: null,
    uploadScanRequired: true,
  })
  assert.equal(result.enabled, false)
  assert.equal(result.scanned, false)
  assert.equal(result.clean, false, 'an unscanned upload must NOT be clean when required')
})

test('scanFile: not required + no scanner is an allowed, audited no-op', async () => {
  const result = await scanFile(tmpFile, { userId: 'u', ip: '127.0.0.1' }, {
    scanCommand: null,
    uploadScanRequired: false,
  })
  assert.equal(result.enabled, false)
  assert.equal(result.scanned, false)
  assert.equal(result.clean, true, 'dev/test may skip an unrequired scan')
})

test('scanFile: a configured scanner that fails to run fails closed', async () => {
  const result = await scanFile(tmpFile, { userId: 'u', ip: '127.0.0.1' }, {
    scanCommand: 'this-command-does-not-exist-xyz',
    uploadScanRequired: true,
  })
  assert.equal(result.enabled, true)
  assert.equal(result.scanned, true)
  assert.equal(result.clean, false, 'a scanner failure must reject the upload')
})

// ------------------------------------------------- legacy default ----

test('legacy verification defaults to access-code (two factors)', () => {
  assert.equal(
    config.legacyVerification,
    'access-code',
    'the secure default must be access-code, not single-factor none'
  )
})
