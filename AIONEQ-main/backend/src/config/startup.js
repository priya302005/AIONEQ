import { config, looksLikePlaceholderCredential } from './config.js'

// Re-exported so the validation tests (and any caller working purely on
// environment validation) have one import site. Defined in config.js, which owns
// env parsing; re-exporting here would create an import cycle.
export { looksLikePlaceholderCredential }

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
 * @returns {{ missing: string[], invalid: string[], productionErrors: string[], warnings: string[] }}
 *   - missing: required vars absent in EVERY environment (fatal).
 *   - invalid: required vars set to an obvious placeholder. Fatal in
 *     production; a loud warning in development, matching the treatment of
 *     SIGNED_URL_SECRET below - the server still starts so the rest of the app
 *     is usable while the operator sorts out credentials, but auth endpoints
 *     answer 503 instead of pretending the password was wrong.
 *   - productionErrors: fatal only when NODE_ENV=production.
 *   - warnings: non-fatal advisories (printed, never secrets).
 */
export function checkEnv(cfg) {
  const missing = []
  const invalid = []
  const productionErrors = []
  const warnings = []
  const isProduction = cfg.env === 'production'

  const placeholderVars = []
  if (cfg.supabaseUrl && looksLikePlaceholderCredential(cfg.supabaseUrl)) {
    placeholderVars.push('SUPABASE_URL')
  }
  if (cfg.supabaseAnonKey && looksLikePlaceholderCredential(cfg.supabaseAnonKey)) {
    placeholderVars.push('SUPABASE_ANON_KEY')
  }

  if (placeholderVars.length) {
    if (isProduction) {
      invalid.push(...placeholderVars)
    } else {
      warnings.push(
        `${placeholderVars.join(' and ')} ${placeholderVars.length > 1 ? 'are' : 'is'} still the ` +
          '.env.example placeholder. Signup and login will fail with ' +
          '"Authentication is temporarily unavailable" until you put the real ' +
          'project URL and anon key (dashboard -> Project Settings -> API Keys, ' +
          'or `supabase status` for the local stack) in .env.'
      )
    }
  }

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
    // .env.example is committed, so its sample secret is public knowledge: a
    // deployment that kept it would hand out valid file URLs to anyone.
    if (looksLikePlaceholderCredential(cfg.signedUrlSecret)) {
      productionErrors.push(
        'SIGNED_URL_SECRET is still the .env.example placeholder - generate a ' +
          'real one (openssl rand -hex 32).'
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

  // Claim grounding is the layer that stops the model presenting an invented
  // personal detail as established fact. The flag exists so the evaluation can
  // measure the grounding rate with it off, which is a measurement activity and
  // never a serving mode.
  if (isProduction && !cfg.aiClaimGroundingEnabled) {
    productionErrors.push(
      'AI_CLAIM_GROUNDING must stay enabled in production - an ungrounded ' +
        'answer may not be served to a user.'
    )
  }

  if (isProduction && !cfg.supabaseServiceRoleKey) {
    warnings.push(
      'SUPABASE_SERVICE_ROLE_KEY is not set in production. ' +
        'Account deletion cannot remove the Supabase auth user record ' +
        '(personal data is still wiped; the auth identity must be deleted manually).'
    )
  }

  return { missing, invalid, productionErrors, warnings }
}

/**
 * Fail fast before listening: if required secrets are missing or the
 * LLM is outside localhost, do not serve traffic at all.
 */
export function assertEnv() {
  const { missing, invalid, productionErrors, warnings } = checkEnv(config)
  for (const w of warnings) console.warn(`[SECURITY] ${w}`)
  if (missing.length) {
    console.error(
      `[FATAL] Required environment variables missing: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill them in before starting EchoMind.'
    )
    process.exit(1)
  }
  if (invalid.length) {
    console.error(
      `[FATAL] Placeholder credentials in .env: ${invalid.join(', ')}. ` +
        'These are the copy-paste sample values from .env.example and cannot ' +
        'authenticate anything - every signup/login would fail. Put the real ' +
        'project URL and anon key (dashboard -> Project Settings -> API Keys, ' +
        'or `supabase status` for the local stack) in .env, then restart.'
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
 * Development-only Supabase reachability probe. An unreachable GoTrue is not
 * fatal (the stack may be starting up), but it IS the reason every signup and
 * login fails, so it must be loud at boot rather than discovered through a 400
 * in the browser. Never runs in production and never logs credentials.
 */
export async function warnIfSupabaseUnreachable() {
  if (config.env === 'production' || config.env === 'test') return
  if (!config.supabaseUrl) return

  const healthUrl = `${config.supabaseUrl.replace(/\/+$/, '')}/auth/v1/health`
  try {
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(2_000),
      headers: config.supabaseAnonKey ? { apikey: config.supabaseAnonKey } : {},
    })
    if (!res.ok) {
      console.warn(
        `[SECURITY] Supabase auth at ${config.supabaseUrl} answered HTTP ${res.status} ` +
          'on /auth/v1/health - signup and login will fail until it is healthy.'
      )
    }
  } catch (err) {
    console.warn(
      `[SECURITY] Supabase auth at ${config.supabaseUrl} is NOT reachable ` +
        `(${err.cause?.code || err.name}) - signup and login will fail. ` +
        'Start the local stack (`supabase start`) or point SUPABASE_URL at your project.'
    )
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
