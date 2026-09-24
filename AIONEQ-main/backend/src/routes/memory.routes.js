import { Router } from 'express'
import {
  createMemoryController,
  getMemoriesController,
  getMemoryByIdController,
  updateMemoryController,
  deleteMemoryController,
} from '../controllers/memory.controller.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { upload } from '../middleware/upload.middleware.js'

const router = Router()

router.route('/')
  .get(requireAuth, getMemoriesController)
  .post(requireAuth, upload.single('file'), createMemoryController)

router.route('/:id')
  .get(requireAuth, getMemoryByIdController)
  .put(requireAuth, upload.single('file'), updateMemoryController)
  .delete(requireAuth, deleteMemoryController)

export default router