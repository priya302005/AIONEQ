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

const router = Router()

router.post('/', requireAuth, askRateLimiter, askQuestion)
router.get('/conversations', requireAuth, getConversationsController)
router.get('/conversations/:id', requireAuth, getConversationController)
router.patch('/conversations/:id', requireAuth, renameConversationController)
router.delete('/conversations/:id', requireAuth, deleteConversationController)

export default router