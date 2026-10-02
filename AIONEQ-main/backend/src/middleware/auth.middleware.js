import { supabase } from '../config/supabase.js'
import { asyncHandler } from '../utils/asyncHandler.js'

/**
 * Verifies the Supabase JWT server-side (signature + expiry via the Supabase
 * GoTrue API) on every protected route - it does NOT trust the client-provided
 * claims. Fails closed on any ambiguity: no token, invalid token, expired,
 * malformed => 401.
 */
export const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null

  if (!token || token.split('.').length !== 3) {
    return res.status(401).json({ error: 'Missing or malformed access token.' })
  }

  const { data, error } = await supabase.auth.getUser(token)

  if (error || !data.user) {
    return res.status(401).json({ error: 'Invalid or expired token.' })
  }

  req.user = data.user
  req.accessToken = token
  next()
})