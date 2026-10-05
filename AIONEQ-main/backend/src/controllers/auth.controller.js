import { createClient } from '@supabase/supabase-js'
import { supabase } from '../config/supabase.js'
import { config } from '../config/config.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { audit } from '../utils/audit.js'
import { isBlocked, recordFailure, clearFailure, getRemainingBackoff } from '../utils/lockout.js'

/**
 * Counter-operator responses. EchoMind must not leak whether an email is
 * registered, so failed signup/login/reset all produce generic messages
 * (enumeration resistance).
 */
const GENERIC_INVALID = 'Invalid email or password.'
const GENERIC_RESET = 'If that email is registered, a reset link has been sent.'

/**
 * What the browser is told when Supabase itself could not be reached.
 *
 * Two genuinely different situations, and collapsing them misleads the user:
 *
 *  - Credentials are sample/placeholder values. No amount of retrying can ever
 *    succeed, so "try again in a moment" sends the user into an endless retry
 *    loop. Say what is actually wrong and who has to fix it. Startup already
 *    refuses to boot in production with placeholder credentials, so this branch
 *    is only reachable outside production - it cannot disclose anything about a
 *    live deployment.
 *  - Real credentials, Supabase unreachable or unhealthy. That IS transient,
 *    so "try again in a moment" is the correct instruction.
 */
/**
 * @param {boolean} [usable] override for tests; defaults to the real config.
 *   false -> permanent misconfiguration wording, true -> transient outage wording.
 */
export function authUnavailableMessage(usable = config.supabaseCredentialsUsable) {
  if (!usable) {
    return (
      'This server is not configured to reach Supabase: SUPABASE_URL and ' +
      'SUPABASE_ANON_KEY in backend/.env are still the .env.example sample ' +
      'values. Retrying will not work - set the real project URL and anon key, ' +
      'then restart the backend.'
    )
  }
  return 'Authentication is temporarily unavailable. Please try again in a moment.'
}

/**
 * Classify a Supabase (GoTrue) failure.
 *
 * These split into two groups that must never share a response:
 *
 *  - INFRASTRUCTURE: the host is unreachable, the API key is wrong, GoTrue is
 *    5xx, or we are being throttled. The submitted credentials were never
 *    even evaluated. Reporting these as "invalid email or password" sends the
 *    user off to re-type a password that was never the problem - and, worse,
 *    counting them as failed logins locks real accounts out (see `login`).
 *  - VALIDATION: GoTrue rejected the submitted credentials itself (weak
 *    password, malformed address, address already registered). This is the
 *    only case that may be reported as bad input, and only generically, so
 *    signup/login still cannot be used to enumerate accounts.
 *
 * @returns {{ kind: 'infra'|'throttled'|'validation', httpStatus: number, reason: string }}
 */
export function classifyAuthError(error) {
  const status = Number(error?.status) || 0
  const reason = String(error?.message || error || 'unknown error')

  // No HTTP status at all means the request never reached GoTrue (connection
  // refused, DNS failure, TLS error, offline). Always infrastructure.
  if (!status) return { kind: 'infra', httpStatus: 503, reason }

  // GoTrue rejecting the apikey is our misconfiguration, not the user's fault.
  if (status === 401 || status === 403) {
    return { kind: 'infra', httpStatus: 502, reason: `supabase rejected the API key: ${reason}` }
  }
  if (status === 429) return { kind: 'throttled', httpStatus: 429, reason }
  if (status >= 500) return { kind: 'infra', httpStatus: 503, reason: `supabase ${status}: ${reason}` }

  return { kind: 'validation', httpStatus: 400, reason }
}

/**
 * Report an upstream auth failure. The real reason goes to the server log and
 * the audit trail only - it can name the failing host or key, which must never
 * reach the browser.
 */
function reportAuthFailure(req, action, classified) {
  console.error(`[AUTH] ${action} failed (${classified.kind}): ${classified.reason}`)
  audit({ action, ip: req.ip, detail: { kind: classified.kind, reason: classified.reason } })
}

function authedClientFor(token) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

export const signup = asyncHandler(async (req, res) => {
  const { fullName, email, password } = req.body // validated by zod

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  })

  if (error) {
    const classified = classifyAuthError(error)
    reportAuthFailure(req, 'auth.signup_failed', classified)

    if (classified.kind === 'validation') {
      // Generic on purpose - never reveal "already registered".
      return res.status(400).json({ error: 'Unable to create an account with those details.' })
    }
    return res.status(classified.httpStatus).json({ success: false, message: authUnavailableMessage() })
  }

  audit({ action: 'auth.signup', userId: data.user?.id, ip: req.ip })

  // If email confirmation is required, Supabase returns a user but no session.
  if (!data.session) {
    return res.status(201).json({
      message: 'Account created. Check your email to confirm your address before logging in.',
      user: data.user,
    })
  }

  res.status(201).json({ user: data.user, session: data.session })
})

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body // validated by zod

  const blockedFor = getRemainingBackoff(email)
  if (blockedFor > 0) {
    audit({ action: 'auth.login_blocked', ip: req.ip, email })
    return res.status(429).json({
      error: `Too many failed attempts. Try again in about ${Math.ceil(blockedFor / 1000)}s.`,
      retryAfterSeconds: Math.ceil(blockedFor / 1000),
    })
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    const classified = classifyAuthError(error)
    reportAuthFailure(req, 'auth.login_failed', classified)

    if (classified.kind !== 'validation') {
      // Do NOT record a failure: the password was never checked, so counting
      // this would let a Supabase outage lock a real account out.
      return res.status(classified.httpStatus).json({ success: false, message: authUnavailableMessage() })
    }

    recordFailure(email)
    // Generic message - no account-existence leak, no password-policy leak.
    return res.status(401).json({ error: GENERIC_INVALID })
  }

  clearFailure(email)

  // MFA detection: if the user has enrolled factors they must complete a
  // challenge before the session is usable. The frontend performs the TOTP
  // step, then calls /api/auth/mfa/complete to finalize.
  let mfaRequired = false
  let factors = []
  try {
    const authed = authedClientFor(data.session.access_token)
    const { data: factorData } = await authed.auth.mfa.listFactors()
    factors = factorData?.factors || []
    mfaRequired = factors.some((f) => f.status === 'verified')
  } catch {
    /* MFA not enabled on this Supabase project - treated as no MFA */
  }

  audit({ action: 'auth.login', userId: data.user.id, ip: req.ip, detail: { mfaRequired } })

  res.json({ user: data.user, session: data.session, mfaRequired, factors })
})

export const logout = asyncHandler(async (req, res) => {
  try {
    const authed = authedClientFor(req.accessToken)
    await authed.auth.signOut()
  } catch {
    /* token may already be dead; still audit */
  }
  audit({ action: 'auth.logout', userId: req.user.id, ip: req.ip })
  res.json({ message: 'Logged out.' })
})

export const resetPassword = asyncHandler(async (req, res) => {
  const { email } = req.body // validated by zod

  // Always returns the generic message, even on error, to avoid enumeration.
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: config.resetRedirectUrl,
  }).catch(() => {})

  audit({ action: 'auth.reset_requested', ip: req.ip, email })
  res.json({ message: GENERIC_RESET })
})

export const updatePassword = asyncHandler(async (req, res) => {
  const { password } = req.body // validated by zod

  const authedClient = authedClientFor(req.accessToken)

  const { data, error } = await authedClient.auth.updateUser({ password })
  if (error) {
    audit({ action: 'auth.update_password_failed', userId: req.user.id, ip: req.ip })
    return res.status(400).json({ error: 'Unable to update the password. Please try again.' })
  }

  // Invalidate ALL of the user's sessions (refresh-token rotation) so a
  // password change kills every open session, including stolen ones.
  await authedClient.auth.signOut({ scope: 'global' }).catch(() => {})

  audit({ action: 'auth.update_password', userId: req.user.id, ip: req.ip })
  res.json({ message: 'Password updated. You have been signed out of all devices.' })
})

export const getProfile = asyncHandler(async (req, res) => {
  res.json({ user: req.user })
})

/**
 * Updates the caller's own profile. Only the display name is writable here.
 *
 * The email is intentionally not editable through this route: changing it is an
 * identity operation that needs a fresh confirmation to the new address, and a
 * silent write here would let a stale session take over an account.
 */
export const updateProfile = asyncHandler(async (req, res) => {
  const { fullName } = req.body // validated by zod
  const authedClient = authedClientFor(req.accessToken)

  const { data, error } = await authedClient.auth.updateUser({
    data: { full_name: fullName },
  })

  if (error || !data?.user) {
    audit({ action: 'auth.update_profile_failed', userId: req.user.id, ip: req.ip })
    return res.status(400).json({ error: 'Unable to update your profile. Please try again.' })
  }

  audit({ action: 'auth.update_profile', userId: req.user.id, ip: req.ip })
  res.json({ user: data.user })
})

// ------------------------------------------------------------- MFA --------
// These proxy the Supabase MFA API server-side using the caller's access
// token, so factor secrets/codes never touch the browser bundle's flow.

export const mfaEnroll = asyncHandler(async (req, res) => {
  const authed = authedClientFor(req.accessToken)
  const { data, error } = await authed.auth.mfa.enroll({ factorType: 'totp' })
  if (error) {
    return res.status(400).json({ error: error.message })
  }
  res.json({ data: { id: data.id, type: data.type, totp: data.totp } })
})

export const mfaChallenge = asyncHandler(async (req, res) => {
  const { factorId } = req.body || {}
  if (!factorId) return res.status(400).json({ error: 'factorId is required.' })
  const authed = authedClientFor(req.accessToken)
  const { data, error } = await authed.auth.mfa.challenge({ factorId })
  if (error) return res.status(400).json({ error: error.message })
  res.json({ data })
})

export const mfaVerify = asyncHandler(async (req, res) => {
  const { factorId, code, challengeId } = req.body || {}
  const authed = authedClientFor(req.accessToken)
  const challenge = challengeId || (await authed.auth.mfa.challenge({ factorId })).data?.id
  if (!challenge) return res.status(400).json({ error: 'Unable to start a challenge.' })
  const { data, error } = await authed.auth.mfa.verify({ factorId, challengeId: challenge, code })
  if (error) return res.status(400).json({ error: error.message })
  if (data?.valid) {
    audit({ action: 'auth.mfa_verified', userId: req.user.id, ip: req.ip })
  }
  res.json({ data })
})

export const mfaUnenroll = asyncHandler(async (req, res) => {
  const { factorId } = req.body || {}
  if (!factorId) return res.status(400).json({ error: 'factorId is required.' })
  const authed = authedClientFor(req.accessToken)
  const { data, error } = await authed.auth.mfa.unenroll({ factorId })
  if (error) return res.status(400).json({ error: error.message })
  res.json({ data })
})

export const mfaList = asyncHandler(async (req, res) => {
  const authed = authedClientFor(req.accessToken)
  const { data, error } = await authed.auth.mfa.listFactors()
  if (error) return res.status(400).json({ error: error.message })
  res.json({ data })
})
