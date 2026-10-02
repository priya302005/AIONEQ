import { Router } from 'express'
import {
  createMemoryController,
  getMemoriesController,
  getMemoryByIdController,
  updateMemoryController,
  deleteMemoryController,
  getSignedFileUrlController,
  serveSignedFileController,
} from '../controllers/memory.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { upload } from '../middleware/upload.middleware.js'
import {
  validate,
  createMemorySchema,
  updateMemorySchema,
  listMemoriesQuerySchema,
  idParamSchema,
} from '../validation/schemas.js'

const router = Router()

router.route('/')
  .get(requireAuth, validate(listMemoriesQuerySchema, 'query'), getMemoriesController)
  .post(requireAuth, upload.single('file'), validate(createMemorySchema), createMemoryController)

router.route('/:id')
  .get(requireAuth, validate(idParamSchema, 'params'), getMemoryByIdController)
  .put(requireAuth, validate(idParamSchema, 'params'), validate(updateMemorySchema), updateMemoryController)
  .delete(requireAuth, validate(idParamSchema, 'params'), deleteMemoryController)

// Short-lived signed file URLs (authenticated issuer + verified consumer).
router.get('/:id/signed-url', requireAuth, validate(idParamSchema, 'params'), getSignedFileUrlController)

// Public-by-name file route kept separate so it is NOT under /api/memories
// and is only a verifier - it is mounted in app.js with requireAuth.
export default router

/** Mounted separately: GET /api/files/:token. The signed token IS the
 *  credential - no Authorization header is required so <audio>/<a> tags can
 *  load files. The controller verifies the HMAC signature + expiry, and the
 *  memory ownership via a SECURITY DEFINER helper. */
export const filesRouter = Router()
filesRouter.get('/:token', serveSignedFileController)