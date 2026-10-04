import { config } from './config.js'

/**
 * Fail-fast startup checks. EchoMind is a digital legacy vault: if we cannot
 * guarantee auth, we must not serve traffic at all (fail closed).
 *
 * The heavy lifting lives in the pure, dependency-free `checkEnv()`
 * so it can be unit-tested without spawning a server or calling
 * process.exit. `assertEnv()` just runs it and exits on fatal errors.
 */

/** Minimum length for a dedicated signed-URL secret. */
export const MIN_SIGNED_URL_SECRET_LENGTH = 32

/**
 * Validates the environment. Pure - no process.exit, no I/O.
 *
 * @param {object} cfg the resolved config object
 * @returns {{ missing: string[], productionErrors: string[], warnings: string[] }}
 *   - missing: required vars absent in EVERY environment (fatal).
 *   - productionErrors: fatal only when NODE_ENV=production.
 *   - warnings: non-fatal advisories (printed, never secrets).
 */
export function checkEnv(cfg) {
  const missing = []
  const productionErrors = []
  const warnings = []
  const isProduction = cfg.env === 'production'

  if (!cfg.supabaseUrl) missing.push('SUPABASE_URL')
  if (!cfg.supabaseAnonKey) missing.push('SUPABASE_ANON_KEY')

  // Signed-URL secret: required everywhere it is used; in production
  // it must be a dedicated, sufficiently strong secret that is NOT
  // the anon key. In development a fallback is allowed (warned only).
  if (!cfg.signedUrlSecret) {
    missing.push('SIGNED_URL_SECRET')
  } else if (isProduction) {
    if (cfg.signedUrlSecret === cfg.supabaseAnonKey) {
      productionErrors.push(
        'SIGNED_URL_SECRET must be a dedicated secret in production - ' +
          'it must not be the Supabase anon key.'
      )
    }
    if (String(cfg.signedUrlSecret).length < MIN_SIGNED_URL_SECRET_LENGTH) {
      productionErrors.push(
        `SIGNED_URL_SECRET is too short in production (minimum ${MIN_SIGNED_URL_SECRET_LENGTH} characters).`
      )
    }
  } else if (cfg.signedUrlSecret === cfg.supabaseAnonKey) {
    warnings.push(
      'SIGNED_URL_SECRET is not set; falling back to SUPABASE_ANON_KEY. ' +
        'Set a dedicated long random secret in .env for production.'
    )
  }

  // The local LLM server must never be reachable from the public
  // internet. It answers prompts containing private memories.
  try {
    const host = new URL(cfg.localAiBaseUrl).hostname
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      productionErrors.push(
        `LOCAL_AI_BASE_URL points at "${host}" - the LLM that reads private ` +
          'memories must run on localhost / a private network only.'
      )
    }
  } catch {
    productionErrors.push('LOCAL_AI_BASE_URL is not a valid URL.')
  }

  if (isProduction && !cfg.supabaseServiceRoleKey) {
    warnings.push(
      'SUPABASE_SERVICE_ROLE_KEY is not set in production. ' +
        'Account deletion cannot remove the Supabase auth user record ' +
        '(personal data is still wiped; the auth identity must be deleted manually).'
    )
  }

  return { missing, productionErrors, warnings }
}

/**
 * Fail fast before listening: if required secrets are missing or the
 * LLM is outside localhost, do not serve traffic at all.
 */
export function assertEnv() {
  const { missing, productionErrors, warnings } = checkEnv(config)
  for (const w of warnings) console.warn(`[SECURITY] ${w}`)
  if (missing.length) {
    console.error(
      `[FATAL] Required environment variables missing: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill them in before starting EchoMind.'
    )
    process.exit(1)
  }
  if (productionErrors.length) {
    for (const e of productionErrors) console.error(`[FATAL] ${e}`)
    console.error(
      '[FATAL] Production environment validation failed. ' +
        'Fix the errors above (see .env.example); EchoMind will not start.'
    )
    process.exit(1)
  }
}

/**
 * Non-fatal advisories about settings that reduce protection but
 * remain usable. Printed so the operator can decide.
 */
export function assertSafeDefaults() {
  const isProduction = config.env === 'production'

  if (config.legacyVerification === 'none') {
    console.warn(
      '[SECURITY] LEGACY_VERIFICATION=none - legacy grants activate with just the ' +
        'claim token (single factor). The default is "access-code"; only use "none" ' +
        'where you explicitly accept single-factor legacy activation.'
    )
  }

  if (!config.scanCommand && config.env !== 'test') {
    if (config.uploadScanRequired) {
      // Fail closed at request time (uploads are rejected); surface it
      // loudly here too so the operator knows uploads will not succeed.
      console.warn(
        '[SECURITY] No SCAN_COMMAND configured and upload scanning is required ' +
          '(REQUIRE_UPLOAD_SCAN / production). Uploads will be REJECTED until a ' +
          'scanner (e.g. ClamAV: SCAN_COMMAND=clamdscan) is configured.'
      )
    } else {
      console.warn(
        '[SECURITY] No SCAN_COMMAND configured - uploads are NOT malware-scanned. ' +
          'Set SCAN_COMMAND (e.g. ClamAV) to enable the scan step. ' +
          'In production, set REQUIRE_UPLOAD_SCAN=true to reject unscanned uploads.'
      )
    }
  }
}
