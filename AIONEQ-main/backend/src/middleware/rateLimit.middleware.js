import rateLimit from 'express-rate-limit'

export const askRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  message: { success: false, message: 'Too many questions. Please wait a minute and try again.' },
})