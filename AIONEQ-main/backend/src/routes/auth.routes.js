import { Router } from 'express'
import {
  signup,
  login,
  resetPassword,
  updatePassword,
  getProfile,
} from '../controllers/auth.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'

const router = Router()

router.post('/signup', signup)
router.post('/login', login)
router.post('/reset-password', resetPassword)
router.put('/update-password', requireAuth, updatePassword)
router.get('/me', requireAuth, getProfile)

export default router