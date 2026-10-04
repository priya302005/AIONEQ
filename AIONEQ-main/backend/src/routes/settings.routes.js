import { Router } from 'express'
import { getSettingsController, updateSettingsController } from '../controllers/settings.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { validate, updateSettingsSchema } from '../validation/schemas.js'

const router = Router()

// Per-user controls over how the assistant may use their archive.
router.get('/', requireAuth, getSettingsController)
router.patch('/', requireAuth, validate(updateSettingsSchema), updateSettingsController)

export default router