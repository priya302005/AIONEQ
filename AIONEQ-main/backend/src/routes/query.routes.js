import { Router } from 'express'
import {
  askQuestion,
  getConversationsController,
  getConversationController,
  deleteConversationController,
  renameConversationController,
} from '../controllers/query.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { askRateLimiter } from '../middleware/rateLimit.middleware.js'
import { validate, askSchema, renameConversationSchema, idParamSchema } from '../validation/schemas.js'

const router = Router()

router.post('/', requireAuth, askRateLimiter, validate(askSchema), askQuestion)
router.get('/conversations', requireAuth, getConversationsController)
router.get('/conversations/:id', requireAuth, validate(idParamSchema, 'params'), getConversationController)
router.patch('/conversations/:id', requireAuth, validate(idParamSchema, 'params'), validate(renameConversationSchema), renameConversationController)
router.delete('/conversations/:id', requireAuth, validate(idParamSchema, 'params'), deleteConversationController)

export default router