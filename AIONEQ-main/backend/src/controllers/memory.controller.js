import fs from 'node:fs'
import path from 'node:path'
import {
  MEMORY_TYPES,
  TEXT_MEMORY_TYPES,
  AUDIO_MIMES,
  DOCUMENT_MIMES,
} from '../utils/memory.constants.js'
import {
  createMemory,
  findMemories,
  findMemoryById,
  updateMemoryRow,
  removeMemoryRow,
} from '../models/memory.model.js'
import { assertMemoryOwnership } from '../utils/assertOwnership.js'
import { uploadsDir } from '../middleware/upload.middleware.js'
import { asyncHandler } from '../utils/asyncHandler.js'

const notFound = (res) =>
  res.status(404).json({ success: false, message: 'Memory not found.' })

function parseTags(tags) {
  if (Array.isArray(tags)) return tags.map((s) => String(s).trim()).filter(Boolean)
  if (typeof tags === 'string') return tags.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

function parseDuration(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

function missingTableHint(msg) {
  return /relation .*memories.* does not exist|could not find the table ['"]?public\.memories['"]?/i.test(msg)
    ? 'Memories table is missing. Run the SQL in backend/sql/memories.sql in your Supabase dashboard.'
    : msg
}

function removeUploadedFile(fileUrl) {
  if (!fileUrl || !fileUrl.startsWith('/uploads/')) return
  fs.unlink(path.join(uploadsDir, path.basename(fileUrl)), () => {})
}

export const createMemoryController = asyncHandler(async (req, res) => {
  const { type, title, content, tags, eventDate, duration } = req.body

  if (!type || !MEMORY_TYPES.includes(type)) {
    return res.status(400).json({ success: false, message: 'Invalid or missing memory type.' })
  }
  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, message: 'Title is required.' })
  }

  const payload = {
    user_id: req.user.id,
    type,
    title: String(title).trim(),
    tags: parseTags(tags),
    event_date: eventDate || new Date().toISOString(),
    content: '',
  }

  if (TEXT_MEMORY_TYPES.includes(type)) {
    if (!content || !String(content).trim()) {
      return res.status(400).json({ success: false, message: 'Content is required for this memory type.' })
    }
    payload.content = String(content)
  } else {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please attach an audio or document file.' })
    }
    const allowed = type === 'voice' ? AUDIO_MIMES : DOCUMENT_MIMES
    if (!allowed.includes(req.file.mimetype)) {
      return res.status(400).json({ success: false, message: 'Unsupported file type for this memory.' })
    }
    payload.file_url = `/uploads/${req.file.filename}`
    payload.mime_type = req.file.mimetype
    if (type === 'voice') {
      const seconds = parseDuration(duration)
      if (seconds) payload.duration = seconds
    }
    if (content && String(content).trim()) {
      payload.content = String(content).trim()
    }
  }

  const { data, error } = await createMemory(req.accessToken, payload)

  if (error) {
    return res.status(400).json({ success: false, message: missingTableHint(error.message) })
  }

  res.status(201).json({ success: true, message: 'Memory saved.', data })
})

export const getMemoriesController = asyncHandler(async (req, res) => {
  const { type, sort } = req.query
  const { data, error } = await findMemories(req.accessToken, { type, sort })

  if (error) {
    return res.status(400).json({ success: false, message: missingTableHint(error.message) })
  }

  res.json({ success: true, message: 'Memories fetched.', data: data || [] })
})

export const getMemoryByIdController = asyncHandler(async (req, res) => {
  const { data, error } = await findMemoryById(req.accessToken, req.params.id)

  if (error) {
    return res.status(400).json({ success: false, message: error.message })
  }
  if (!data) return notFound(res)

  res.json({ success: true, message: 'Memory fetched.', data })
})

export const updateMemoryController = asyncHandler(async (req, res) => {
  const { title, content, tags, eventDate } = req.body

  const existing = await findMemoryById(req.accessToken, req.params.id)
  if (existing.error) {
    return res.status(400).json({ success: false, message: existing.error.message })
  }
  if (!existing.data) return notFound(res)
  assertMemoryOwnership(existing.data, req.user.id)

  const payload = {}
  if (title !== undefined && String(title).trim()) payload.title = String(title).trim()
  if (content !== undefined) payload.content = String(content)
  if (tags !== undefined) payload.tags = parseTags(tags)
  if (eventDate !== undefined) payload.event_date = eventDate

  if (!Object.keys(payload).length) {
    return res.status(400).json({ success: false, message: 'Nothing to update.' })
  }

  const { data, error } = await updateMemoryRow(req.accessToken, req.params.id, {
    ...payload,
    updated_at: new Date().toISOString(),
  })

  if (error) {
    return res.status(400).json({ success: false, message: error.message })
  }
  if (!data) return notFound(res)

  res.json({ success: true, message: 'Memory updated.', data })
})

export const deleteMemoryController = asyncHandler(async (req, res) => {
  const existing = await findMemoryById(req.accessToken, req.params.id)
  if (existing.error) {
    return res.status(400).json({ success: false, message: existing.error.message })
  }
  if (!existing.data) return notFound(res)
  assertMemoryOwnership(existing.data, req.user.id)

  const { data, error } = await removeMemoryRow(req.accessToken, req.params.id)
  if (error) {
    return res.status(400).json({ success: false, message: error.message })
  }
  if (!data) return notFound(res)

  removeUploadedFile(existing.data.file_url)

  res.json({ success: true, message: 'Memory deleted.' })
})