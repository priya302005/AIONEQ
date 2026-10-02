import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
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
import { grantFor } from '../models/legacy.model.js'
import { uploadsDir } from '../middleware/upload.middleware.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { verifyUpload } from '../utils/fileMagic.js'
import { scanFile } from '../middleware/scan.middleware.js'
import { assertQuota } from '../utils/quota.js'
import { issueFileToken, verifyFileToken } from '../utils/fileSigning.js'
import { audit } from '../utils/audit.js'
import { enrichMemory } from '../utils/enrichMemory.js'

const notFound = (res) => res.status(404).json({ success: false, message: 'Memory not found.' })

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

function deleteUploadedFileByName(filename) {
  const safe = path.basename(filename || '')
  if (safe) fs.unlink(path.join(uploadsDir, safe), () => {})
}

export const createMemoryController = asyncHandler(async (req, res) => {
  const { type, title, content, tags, eventDate, duration } = req.body // zod-validated

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

    // 1. Content sniffing - do not trust the client's declared MIME type.
    const sniff = verifyUpload(req.file.path, req.file.mimetype, allowed)
    if (!sniff.ok) {
      deleteUploadedFileByName(req.file.filename)
      audit({ action: 'upload.rejected_content_mismatch', userId: req.user.id, ip: req.ip, detail: { type } })
      return res.status(400).json({ success: false, message: 'File content does not match its announced type.' })
    }

    // 2. Quota guard (per-user cumulative upload size).
    const quota = await assertQuota(req.accessToken, req.user.id, req.file.size)
    if (!quota.ok) {
      deleteUploadedFileByName(req.file.filename)
      return res.status(413).json({ success: false, message: quota.message })
    }

    // 3. Malware scan (no-op unless SCAN_COMMAND is configured).
    const scan = await scanFile(req.file.path, { userId: req.user.id, ip: req.ip })
    if (!scan.clean) {
      deleteUploadedFileByName(req.file.filename)
      audit({ action: 'upload.scan_rejected', userId: req.user.id, ip: req.ip, detail: { type } })
      return res.status(400).json({ success: false, message: 'Upload rejected by malware scan.' })
    }

    payload.file_url = `/uploads/${req.file.filename}`
    payload.mime_type = req.file.mimetype
    payload.file_size = req.file.size
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
    if (req.file) deleteUploadedFileByName(req.file.filename)
    return res.status(400).json({ success: false, message: missingTableHint(error.message) })
  }

  audit({ action: 'memory.create', userId: req.user.id, ip: req.ip, detail: { memoryId: data?.id, type } })

  // Best-effort metadata enrichment (keywords/entities/summary). Fire-and-forget:
  // the save response is never blocked or failed by a local-AI hiccup, and the
  // original user content is never modified.
  if (data && (data.content || data.title)) {
    enrichMemory(req.accessToken, data).catch(() => {})
  }

  res.status(201).json({ success: true, message: 'Memory saved.', data })
})

export const getMemoriesController = asyncHandler(async (req, res) => {
  const { type, sort } = req.query // validated by zod (query schema)
  const { data, error } = await findMemories(req.accessToken, { type, sort })

  if (error) {
    return res.status(400).json({ success: false, message: missingTableHint(error.message) })
  }

  res.json({ success: true, message: 'Memories fetched.', data: data || [] })
})

export const getMemoryByIdController = asyncHandler(async (req, res) => {
  const { id } = req.params // validated by zod
  const { data, error } = await findMemoryById(req.accessToken, id)

  if (error) {
    if (error.code === 'PGRST116') return notFound(res)
    return res.status(400).json({ success: false, message: error.message })
  }
  if (!data) return notFound(res)

  res.json({ success: true, message: 'Memory fetched.', data })
})

export const updateMemoryController = asyncHandler(async (req, res) => {
  const { id } = req.params
  const { title, content, tags, eventDate } = req.body // zod-validated

  const existing = await findMemoryById(req.accessToken, id)
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

  const { data, error } = await updateMemoryRow(req.accessToken, id, {
    ...payload,
    updated_at: new Date().toISOString(),
  })

  if (error) {
    return res.status(400).json({ success: false, message: error.message })
  }
  if (!data) return notFound(res)

  audit({ action: 'memory.update', userId: req.user.id, ip: req.ip, detail: { memoryId: id } })

  // Re-enrich when the content actually changed (never blocks the response).
  if (data && payload.content !== undefined) {
    enrichMemory(req.accessToken, data).catch(() => {})
  }

  res.json({ success: true, message: 'Memory updated.', data })
})

export const deleteMemoryController = asyncHandler(async (req, res) => {
  const { id } = req.params
  const existing = await findMemoryById(req.accessToken, id)
  if (existing.error) {
    return res.status(400).json({ success: false, message: existing.error.message })
  }
  if (!existing.data) return notFound(res)
  assertMemoryOwnership(existing.data, req.user.id)

  const { data, error } = await removeMemoryRow(req.accessToken, id)
  if (error) {
    return res.status(400).json({ success: false, message: error.message })
  }
  if (!data) return notFound(res)

  removeUploadedFile(existing.data.file_url)

  audit({ action: 'memory.delete', userId: req.user.id, ip: req.ip, detail: { memoryId: id } })
  res.json({ success: true, message: 'Memory deleted.' })
})

// -------------------------------------------------------- signed URLs ------
/**
 * Authenticated endpoint that returns a short-lived signed URL for a memory's
 * file. Callers: the memory owner, or a legacy recipient holding an ACTIVE
 * grant of type 'full'. The file route validates the signature AND ownership
 * on every request.
 */
export const getSignedFileUrlController = asyncHandler(async (req, res) => {
  const { id } = req.params
  const { data, error } = await findMemoryById(req.accessToken, id)
  if (error || !data) return notFound(res)

  const isOwner = data.user_id === req.user.id
  let isLegacyFull = false
  if (!isOwner) {
    const grant = await grantFor(req.accessToken, data.user_id, req.user.id)
    isLegacyFull = Boolean(grant && grant.grant_type === 'full')
  }
  if (!isOwner && !isLegacyFull) {
    audit({ action: 'files.signed_url_denied', userId: req.user.id, ip: req.ip, detail: { memoryId: id } })
    return res.status(403).json({ success: false, message: 'You do not have access to this memory.' })
  }
  if (!data.file_url) {
    return res.status(404).json({ success: false, message: 'This memory has no attached file.' })
  }
  const { token } = issueFileToken(id, req.user.id)
  res.json({ success: true, token, url: `/api/files/${token}`, mimeType: data.mime_type })
})

/**
 * Serves a file whose signed token was issued for this memory/user.
 * Verification order: signature -> expiry -> ownership (via SECURITY DEFINER
 * helper, inputs are HMAC-verified). Each failure is denied and audited
 * (fail closed). No Authorization header is required - the token is the
 * credential so <audio>/<a> tags work.
 */
export const serveSignedFileController = asyncHandler(async (req, res) => {
  const token = req.params.token
  const parts = token?.split('.')
  if (!parts || parts.length !== 4) return res.status(400).json({ message: 'Invalid file token.' })

  const memoryId = parts[0]
  const userId = parts[1]

  // Signature + expiry first - fail before touching the DB.
  const check = verifyFileToken(token, { memoryId, userId })
  if (!check.ok) {
    audit({ action: 'files.rejected_signed_url', ip: req.ip, detail: { reason: check.reason } })
    return res.status(403).json({ message: 'This file link is invalid or expired.' })
  }

  // Ownership check with narrow, server-side-only helper (anon client is fine
  // here: the function only returns a path when owner+memory match).
  const anonClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
  })
  const { data: fileUrl, error: rpcError } = await anonClient.rpc('get_file_url_for_owner', {
    p_user_id: userId,
    p_memory_id: memoryId,
  })
  if (rpcError || !fileUrl) {
    audit({ action: 'files.rejected_ownership', ip: req.ip, detail: { memoryId, reason: rpcError?.message || 'not found/not owner' } })
    return res.status(404).json({ message: 'File not found.' })
  }

  const filePath = path.join(uploadsDir, path.basename(fileUrl))
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: 'File not found.' })
  }

  audit({ action: 'files.served', userId, ip: req.ip, detail: { memoryId } })
  res.setHeader('Content-Type', req.query.mime || 'application/octet-stream')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, max-age=0, no-store')
  res.setHeader('Content-Disposition', 'inline')
  fs.createReadStream(filePath).on('error', () => res.status(404).end()).pipe(res)
})