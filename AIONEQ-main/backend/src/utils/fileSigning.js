import crypto from 'node:crypto'
import { config } from '../config/config.js'

/**
 * Short-lived signed file URLs. Uploaded files are never served from public
 * static paths; a client must first obtain a signed URL (authenticated), then
 * the file route validates the HMAC signature, expiry, and that the memory
 * belongs to the requester before streaming bytes.
 */

export function issueFileToken(memoryId, userId, ttlSeconds = config.signedUrlTtlSeconds) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = `${memoryId}.${userId}.${expiresAt}`
  const sig = crypto.createHmac('sha256', config.signedUrlSecret).update(payload).digest('hex')
  return { token: `${payload}.${sig}`, expiresAt }
}

export function verifyFileToken(token, { memoryId, userId }) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing token' }
  const parts = token.split('.')
  if (parts.length !== 4) return { ok: false, reason: 'malformed token' }
  const [tokMemoryId, tokUserId, exp, sig] = parts
  if (tokMemoryId !== memoryId || tokUserId !== userId) {
    return { ok: false, reason: 'token does not match requester' }
  }
  const expected = crypto.createHmac('sha256', config.signedUrlSecret).update(`${tokMemoryId}.${tokUserId}.${exp}`).digest('hex')
  // timingSafeEqual throws on unequal lengths - compare a hash of both instead.
  const a = Buffer.from(crypto.createHash('sha256').update(sig).digest('hex'))
  const b = Buffer.from(crypto.createHash('sha256').update(expected).digest('hex'))
  if (!crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad signature' }
  }
  if (Number(exp) < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'token expired' }
  }
  return { ok: true }
}