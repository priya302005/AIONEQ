import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

const STORAGE_KEY = 'echomind-session'
const COOKIE_RT = 'echomind_rt' // refresh token only - the sensitive user
const COOKIE_RT_EXP = 'echomind_rt_exp' // profile + access token never persist

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
    const exp = Number(readCookie(COOKIE_RT_EXP)) || 0
    // Minimal session - Supabase sees an expired/missing token and refreshes.
    return JSON.stringify({ refresh_token: rt, token_type: 'bearer', expires_at: exp })
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