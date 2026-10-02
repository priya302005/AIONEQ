import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { audit } from '../utils/audit.js'

/**
 * Rate limiting. EchoMind fails closed: unauthenticated auth endpoints get a
 * strict per-IP limit (credential stuffing / enumeration), authenticated API
 * routes get per-user limits.
 *
 * NOTE (express-rate-limit v8): the default keyGenerator reads req.ip which
 * requires Express 5 or `app.set('trust proxy', ...)`. We set trust proxy
 * from env in app.js; when it is off, req.ip is the socket address.
 */

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    audit({ action: 'auth.rate_limited', ip: req.ip, route: req.originalUrl })
    res.status(429).json({ success: false, message: 'Too many attempts. Please wait a minute and try again.' })
  },
  message: { success: false, message: 'Too many attempts. Please wait a minute and try again.' },
})

export const askRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req),
  message: { success: false, message: 'Too many questions. Please wait a minute and try again.' },
})

export const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 4,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req),
  message: { success: false, message: 'You have reached the export limit for this hour.' },
})