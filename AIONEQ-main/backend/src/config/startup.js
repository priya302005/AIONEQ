import { config } from './config.js'

/**
 * Fail-fast startup checks. EchoMind is a digital legacy vault: if we cannot
 * guarantee auth, we must not serve traffic at all (fail closed).
 */
export function assertEnv() {
  const missing = []
  if (!config.supabaseUrl) missing.push('SUPABASE_URL')
  if (!config.supabaseAnonKey) missing.push('SUPABASE_ANON_KEY')
  if (!config.signedUrlSecret || config.signedUrlSecret === 'change-me') {
    missing.push('SIGNED_URL_SECRET')
  }
  if (config.supabaseAnonKey && config.signedUrlSecret === config.supabaseAnonKey) {
    console.warn(
      '[SECURITY] SIGNED_URL_SECRET is not set; falling back to SUPABASE_ANON_KEY. ' +
        'Set a dedicated long random secret in .env for production.'
    )
  }
  if (missing.length) {
    console.error(
      `[FATAL] Required environment variables missing: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill them in before starting EchoMind.'
    )
    process.exit(1)
  }

  // The local LLM server must never be reachable from the public internet.
  // It answers prompts containing private memories.
  try {
    const host = new URL(config.localAiBaseUrl).hostname
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      console.error(
        `[FATAL] LOCAL_AI_BASE_URL points at "${host}" - the LLM that reads private ` +
          'memories must run on localhost / a private network only.'
      )
      process.exit(1)
    }
  } catch {
    console.error('[FATAL] LOCAL_AI_BASE_URL is not a valid URL.')
    process.exit(1)
  }

  if (process.env.NODE_ENV === 'production' && !config.supabaseServiceRoleKey) {
    console.warn(
      '[SECURITY] SUPABASE_SERVICE_ROLE_KEY is not set in production. ' +
        'Account deletion cannot remove the Supabase auth user record ' +
        '(personal data wipe is performed; the auth identity must be deleted manually).'
    )
  }
}

/**
 * Warns (does not fail) about things that reduce protection but remain usable.
 */
export function assertSafeDefaults() {
  if (config.legacyVerification === 'none') {
    console.warn(
      '[SECURITY] LEGACY_VERIFICATION=none - legacy grants activate with just the ' +
        'claim token. Consider "access-code" for a shared secret step.'
    )
  }
  if (!config.scanCommand && config.env !== 'test') {
    console.warn(
      '[SECURITY] No SCAN_COMMAND configured - uploads are NOT malware-scanned. ' +
        'Set SCAN_COMMAND (e.g. ClamAV) to enable the scan step.'
    )
  }
}