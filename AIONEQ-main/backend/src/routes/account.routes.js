import { Router } from 'express'
import { deleteAccountController } from '../controllers/account.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'

const router = Router()

router.delete('/', requireAuth, deleteAccountController)

export default router