import multer from 'multer'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { AUDIO_MIMES, DOCUMENT_MIMES } from '../utils/memory.constants.js'
import { config } from '../config/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const uploadsDir = path.join(__dirname, '..', '..', 'uploads')

const ALLOWED_MIMES = new Set([...AUDIO_MIMES, ...DOCUMENT_MIMES])

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10)
    cb(null, `${crypto.randomUUID()}${ext}`)
  },
})

export const upload = multer({
  storage,
  limits: {
    fileSize: config.maxFileBytes,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      const err = new Error('Unsupported file type. Please upload an audio or document file.')
      err.status = 400
      return cb(err)
    }
    cb(null, true)
  },
})