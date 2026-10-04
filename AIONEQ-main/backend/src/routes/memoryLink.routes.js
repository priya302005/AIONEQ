import { Router } from 'express'
import {
  listLinksController,
  createLinkController,
  resolveLinkController,
  deleteLinkController,
} from '../controllers/memoryLink.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import {
  validate,
  memoryLinksQuerySchema,
  createMemoryLinkSchema,
  resolveMemoryLinkSchema,
  idParamSchema,
} from '../validation/schemas.js'

const router = Router()

// Suggestions and relationships between two of the caller's own memories.
// Every route is authenticated per-route (not router.use) so the guard is
// visible on each route's handler stack - the auth-coverage audit reads
// handlers per route, and a router-level use() would be invisible to it.
// Every handler re-verifies ownership of both memories involved.
router.get('/', requireAuth, validate(memoryLinksQuerySchema, 'query'), listLinksController)
router.post('/:id/links', requireAuth, validate(idParamSchema, 'params'), validate(createMemoryLinkSchema), createLinkController)
router.patch('/:id', requireAuth, validate(idParamSchema, 'params'), validate(resolveMemoryLinkSchema), resolveLinkController)
router.delete('/:id', requireAuth, validate(idParamSchema, 'params'), deleteLinkController)

export default router