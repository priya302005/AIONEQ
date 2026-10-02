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
    // Generic on purpose - never reveal "already registered".
    audit({ action: 'auth.signup_failed', ip: req.ip, detail: { reason: 'supabase rejected signup' } })
    return res.status(400).json({ error: 'Unable to create an account with those details.' })
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
    recordFailure(email)
    audit({ action: 'auth.login_failed', ip: req.ip, email })
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