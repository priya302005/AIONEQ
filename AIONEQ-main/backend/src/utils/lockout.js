import { config } from '../config/config.js'

/**
 * In-memory account lockout with exponential backoff, keyed by email.
 *
 * Tradeoff: state is lost on restart. For a production vault this should be
 * backinged by Redis/Postgres so backoff survives restarts and scales across
 * instances - that is a flagged extension, not implemented here.
 */

const state = new Map() // email(lowercased) -> { count, blockedUntil }

function now() {
  return Date.now()
}

export function getRemainingBackoff(email) {
  const rec = state.get(String(email || '').toLowerCase())
  if (!rec) return 0
  const remaining = rec.blockedUntil - now()
  return remaining > 0 ? remaining : 0
}

export function isBlocked(email) {
  return getRemainingBackoff(email) > 0
}

export function recordFailure(email) {
  const key = String(email || '').toLowerCase()
  const rec = state.get(key) || { count: 0, blockedUntil: 0 }
  rec.count += 1
  if (rec.count >= config.lockoutMaxAttempts) {
    // Exponential backoff, capped at 1 hour.
    const backoffMs = Math.min(
      config.lockoutBaseBackoffMs * 2 ** (rec.count - config.lockoutMaxAttempts),
      60 * 60 * 1000
    )
    rec.blockedUntil = now() + backoffMs
    rec.count = 0
  }
  state.set(key, rec)
  return rec
}

export function clearFailure(email) {
  state.delete(String(email || '').toLowerCase())
}

/** Periodically drops stale entries so the map cannot grow unbounded. */
export function pruneLockoutState() {
  const ttlMs = 60 * 60 * 1000
  for (const [key, rec] of state) {
    if (rec.blockedUntil && rec.blockedUntil < now() - ttlMs) state.delete(key)
  }
}

setInterval(() => pruneLockoutState(), 60 * 60 * 1000).unref()