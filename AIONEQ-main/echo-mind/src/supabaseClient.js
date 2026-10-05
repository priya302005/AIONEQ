import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// createClient() throws a bare "supabaseUrl is required" from inside the
// library, which is easy to misread as an app bug. Fail with the fix instead.
if (!supabaseUrl || !supabaseAnonKey) {
  const missing = [
    !supabaseUrl && 'VITE_SUPABASE_URL',
    !supabaseAnonKey && 'VITE_SUPABASE_ANON_KEY',
  ].filter(Boolean)
  throw new Error(
    `Missing ${missing.join(' and ')} in echo-mind env. ` +
      'Create echo-mind/.env.local from echo-mind/.env.example, then restart ' +
      'the dev server (Vite only reads env files at startup).',
  )
}

const STORAGE_KEY = 'echomind-session'
const COOKIE_RT = 'echomind_rt' // refresh token only - the sensitive user
const COOKIE_RT_EXP = 'echomind_rt_exp' // diagnostics only; see getItem()

let memorySession = null

function cookieBase() {
  const secure = typeof location !== 'undefined' && location.protocol === 'https:'
  return `path=/;SameSite=Strict${secure ? ';Secure' : ''}`
}

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

function writeCookie(name, value, maxAgeSeconds) {
  document.cookie = `${name}=${encodeURIComponent(value)};${cookieBase()};Max-Age=${maxAgeSeconds}`
}

function deleteCookie(name) {
  document.cookie = `${name}=;path=/;SameSite=Strict;Max-Age=0`
}

/**
 * Session storage adapter.
 *
 * Security posture: the full Supabase session (access token + full user
 * profile) is kept in memory only - it is never written to localStorage. Only
 * the refresh token (a small value) is persisted, in a SameSite=Strict cookie
 * (Secure in production), sufficient for Supabase to rehydrate a session on
 * reload via refreshSession().
 *
 * Upgrade path (flagged): for full httpOnly cookie handling, move auth
 * entirely behind the backend using @supabase/ssr so tokens never touch
 * document.cookie as JS-readable values.
 */
const sessionStorageAdapter = {
  async getItem(key) {
    if (key !== STORAGE_KEY) return null
    if (memorySession) return memorySession
    const rt = readCookie(COOKIE_RT)
    if (!rt) return null
    // The shape must satisfy auth-js `_isValidSession()`, which requires an
    // `access_token` KEY to be present. Omit it and the client treats storage
    // as corrupt: it calls _removeSession(), which deletes the very cookies we
    // are reading from, so every reload would destroy the refresh token and
    // sign the user out. The value below is an empty placeholder and is never
    // used as a credential.
    //
    // expires_at: 0 marks it as already expired, which is deliberate. It forces
    // the client down its refresh path - exchanging the cookie's refresh token
    // for a real session - instead of it trusting a stale access token we
    // deliberately refuse to persist. COOKIE_RT_EXP is written for debugging
    // only; trusting it here would let an expired token through unrefreshed.
    return JSON.stringify({
      access_token: '',
      refresh_token: rt,
      token_type: 'bearer',
      expires_at: 0,
    })
  },
  async setItem(key, value) {
    if (key !== STORAGE_KEY) return
    memorySession = value
    try {
      const s = JSON.parse(value)
      if (s && s.refresh_token) writeCookie(COOKIE_RT, s.refresh_token, 60 * 60 * 24 * 7)
      if (s && s.expires_at) writeCookie(COOKIE_RT_EXP, String(s.expires_at), 60 * 60 * 24 * 7)
    } catch {
      /* invalid payload - leave cookies untouched */
    }
  },
  async removeItem(key) {
    if (key !== STORAGE_KEY) return
    memorySession = null
    deleteCookie(COOKIE_RT)
    deleteCookie(COOKIE_RT_EXP)
  },
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: sessionStorageAdapter,
    storageKey: STORAGE_KEY,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})