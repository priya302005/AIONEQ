import { Router } from 'express'
import {
  createGrantController,
  listGrantsController,
  revokeGrantController,
  claimGrantController,
  legacyAccessOverviewController,
  pendingGrantsController,
  archiveController,
} from '../controllers/legacy.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { validate, createGrantSchema, claimGrantSchema, idParamSchema } from '../validation/schemas.js'
import { z } from 'zod'

const router = Router()

// Owner management.
router.post('/grants', requireAuth, validate(createGrantSchema), createGrantController)
router.get('/grants', requireAuth, listGrantsController)
router.delete('/grants/:id', requireAuth, validate(idParamSchema, 'params'), revokeGrantController)

// Recipient flows (still authenticated - the recipient must have an account
// with the same email the owner designated).
router.get('/pending', requireAuth, pendingGrantsController)
router.post('/grants/:id/claim', requireAuth, validate(idParamSchema, 'params'), validate(claimGrantSchema), claimGrantController)

// What the recipient can currently read.
router.get('/access', requireAuth, legacyAccessOverviewController)
router.get('/archive/:ownerId', requireAuth, validate(z.object({ ownerId: z.uuid() }), 'params'), archiveController)

export default router