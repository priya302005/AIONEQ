import { Router } from 'express'
import { exportAllController } from '../controllers/export.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { exportLimiter } from '../middleware/rateLimit.middleware.js'
import { validate, exportSchema } from '../validation/schemas.js'

const router = Router()

// Full account export (zip). Rate-limited.
router.post('/', requireAuth, exportLimiter, validate(exportSchema), exportAllController)

export default router