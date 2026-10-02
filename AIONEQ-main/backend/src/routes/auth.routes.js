import { Router } from 'express'
import {
  signup,
  login,
  logout,
  resetPassword,
  updatePassword,
  getProfile,
  mfaEnroll,
  mfaChallenge,
  mfaVerify,
  mfaUnenroll,
  mfaList,
} from '../controllers/auth.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { authLimiter } from '../middleware/rateLimit.middleware.js'
import { validate, signupSchema, loginSchema, resetPasswordSchema, updatePasswordSchema } from '../validation/schemas.js'

const router = Router()

// Unauthenticated flows get a strict per-IP rate limit.
router.post('/signup', authLimiter, validate(signupSchema), signup)
router.post('/login', authLimiter, validate(loginSchema), login)
router.post('/logout', requireAuth, logout)
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), resetPassword)

// Authenticated flows.
router.put('/update-password', requireAuth, validate(updatePasswordSchema), updatePassword)
router.get('/me', requireAuth, getProfile)

// MFA management (always require an authenticated session).
router.post('/mfa/enroll', requireAuth, mfaEnroll)
router.post('/mfa/challenge', requireAuth, mfaChallenge)
router.post('/mfa/verify', requireAuth, mfaVerify)
router.post('/mfa/unenroll', requireAuth, mfaUnenroll)
router.get('/mfa/factors', requireAuth, mfaList)

export default router