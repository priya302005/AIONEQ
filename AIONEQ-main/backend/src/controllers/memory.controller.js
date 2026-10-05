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
  listMemories,
  findMemoryById,
  updateMemoryRow,
  removeMemoryRow,
  resetDerived,
} from '../models/memory.model.js'
import { assertMemoryOwnership } from '../utils/assertOwnership.js'
import { grantFor } from '../models/legacy.model.js'
import { uploadsDir } from '../middleware/upload.middleware.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { schemaHint as missingTableHint } from '../utils/schemaHint.js'
import { verifyUpload } from '../utils/fileMagic.js'
import { scanFile } from '../middleware/scan.middleware.js'
import { assertQuota } from '../utils/quota.js'
import { issueFileToken, verifyFileToken } from '../utils/fileSigning.js'
import { audit } from '../utils/audit.js'
import { queueProcessing, reprocessMemory, describeStatus } from '../services/memoryIngestion.js'
import { purgeDerived } from '../services/memoryPipeline.js'
import { searchMemories } from '../services/memorySearch.js'
import { linksForMemory } from '../models/memoryLink.model.js'
import { config } from '../config/config.js'

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

function removeUploadedFile(fileUrl) {
  if (!fileUrl || !fileUrl.startsWith('/uploads/')) return
  fs.unlink(path.join(uploadsDir, path.basename(fileUrl)), () => {})
}

function deleteUploadedFileByName(filename) {
  const safe = path.basename(filename || '')
  if (safe) fs.unlink(path.join(uploadsDir, safe), () => {})
}

export const createMemoryController = asyncHandler(async (req, res) => {
  const { type, title, content, transcript, tags, eventDate, duration } = req.body // zod-validated

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
    processing_status: 'pending',
  }

  // A transcript the user supplies is text they wrote or confirmed, so it goes
  // in the transcript column - never over the top of their content.
  if (transcript && String(transcript).trim()) {
    payload.transcript = String(transcript).trim()
    payload.source_kind = 'transcribed'
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

    // 3. Malware scan. Fails closed: a configured scanner that
    //    finds a threat OR fails to run rejects the upload, and in
    //    production (or REQUIRE_UPLOAD_SCAN=true) an upload with no
    //    scanner at all is rejected too - an unscanned upload is
    //    never treated as clean. Development/test skip the scan
    //    (audited) so the flow stays usable.
    const scan = await scanFile(req.file.path, { userId: req.user.id, ip: req.ip })
    if (!scan.clean) {
      deleteUploadedFileByName(req.file.filename)
      if (scan.enabled) {
        audit({ action: 'upload.scan_threat_or_failure', userId: req.user.id, ip: req.ip, detail: { type } })
        return res.status(400).json({ success: false, message: 'Upload rejected by malware scan.' })
      }
      audit({ action: 'upload.scan_unavailable', userId: req.user.id, ip: req.ip, detail: { type } })
      return res.status(503).json({
        success: false,
        message:
          'Upload scanning is required but no scanner is configured. ' +
          'The upload was rejected and not stored. Contact the administrator.',
      })
    }

    payload.file_url = `/uploads/${req.file.filename}`
    payload.mime_type = req.file.mimetype
    payload.file_size = req.file.size
    if (type === 'voice') {
      const seconds = parseDuration(duration)
      if (seconds) payload.duration = seconds
      // No transcript yet: the pipeline will try the transcription service and
      // fall back to 'partial' with a clear reason if none is configured.
      if (!payload.transcript) payload.source_kind = 'audio'
    } else if (type === 'document') {
      payload.source_kind = 'document'
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

  // Queue the understanding pipeline. Fire-and-forget by design: transcription,
  // document extraction, summarisation and indexing must never delay or fail
  // the save. The memory is already stored and fully usable at this point.
  const queued = await queueProcessing(req.accessToken, data, { reason: 'created' }).catch(() => ({ queued: false }))

  res.status(201).json({
    success: true,
    message: 'Memory saved.',
    data,
    processing: { queued: Boolean(queued?.queued), reason: queued?.reason || null },
  })
})

/**
 * Lists the caller's memories, paged and filtered.
 *
 * With `q` this is hybrid search (semantic + full-text + lexical); without it
 * it is a plain paged listing. Always bounded - the dashboard can never pull an
 * unbounded archive into the browser.
 */
export const getMemoriesController = asyncHandler(async (req, res) => {
  const { type, status, q, limit, offset, sort } = req.query // zod-validated

  if (q) {
    const results = await searchMemories(req.accessToken, req.user.id, q, {
      type: type || null,
      limit: Math.min(limit || config.memorySearchMaxLimit, config.memorySearchMaxLimit),
    })
    return res.json({
      success: true,
      message: results.length ? 'Memories found.' : 'No saved memories match that.',
      data: results,
      total: results.length,
    })
  }

  const effectiveLimit = Math.min(limit || config.memoryListDefaultLimit, config.memoryListMaxLimit)
  const { data, error, count } = await listMemories(req.accessToken, {
    type,
    status,
    limit: effectiveLimit,
    offset: offset || 0,
    sort: sort || '-created_at',
  })

  if (error) {
    return res.status(400).json({ success: false, message: missingTableHint(error.message) })
  }

  res.json({
    success: true,
    message: 'Memories fetched.',
    data: data || [],
    // Exact total when PostgREST supplies it, otherwise "there may be more".
    total: typeof count === 'number' ? count : null,
    limit: effectiveLimit,
    offset: offset || 0,
  })
})

export const getMemoryByIdController = asyncHandler(async (req, res) => {
  const { id } = req.params // validated by zod
  const { data, error } = await findMemoryById(req.accessToken, id)

  if (error) {
    if (error.code === 'PGRST116') return notFound(res)
    return res.status(400).json({ success: false, message: error.message })
  }
  if (!data) return notFound(res)

  // Relationship proposals found for this memory. Read-only here; the user
  // resolves them through PATCH /api/memory-links/:id. Purely informational.
  const links = await linksForMemory(req.accessToken, id).catch(() => [])

  res.json({ success: true, message: 'Memory fetched.', data, links, processing: describeStatus(data) })
})

/**
 * Re-runs the understanding pipeline for one memory. Used after an edit and to
 * retry a memory whose processing failed.
 */
export const reprocessMemoryController = asyncHandler(async (req, res) => {
  const { id } = req.params

  const existing = await findMemoryById(req.accessToken, id)
  if (existing.error) return res.status(400).json({ success: false, message: existing.error.message })
  if (!existing.data) return notFound(res)
  assertMemoryOwnership(existing.data, req.user.id)

  // Clear derived state first so a failed retry cannot leave stale metadata
  // behind that looks current.
  await resetDerived(req.accessToken, id).catch(() => {})

  const result = await reprocessMemory(req.accessToken, id)
  if (!result.ok && result.status !== 'partial') {
    return res.status(200).json({
      success: false,
      message: result.reason || 'This memory could not be processed.',
      processing: { status: result.status || 'failed', notes: result.notes || [] },
    })
  }

  audit({ action: 'memory.reprocess', userId: req.user.id, ip: req.ip, detail: { memoryId: id, status: result.status } })

  const refreshed = await findMemoryById(req.accessToken, id)
  res.json({
    success: true,
    message: 'Memory reprocessed.',
    data: refreshed.data,
    processing: describeStatus(refreshed.data),
  })
})

export const updateMemoryController = asyncHandler(async (req, res) => {
  const { id } = req.params
  const { title, content, transcript, tags, eventDate } = req.body // zod-validated

  const existing = await findMemoryById(req.accessToken, id)
  if (existing.error) {
    return res.status(400).json({ success: false, message: existing.error.message })
  }
  if (!existing.data) return notFound(res)
  assertMemoryOwnership(existing.data, req.user.id)

  const payload = {}
  if (title !== undefined && String(title).trim()) payload.title = String(title).trim()
  if (content !== undefined) payload.content = String(content)
  if (transcript !== undefined) {
    payload.transcript = String(transcript)
    payload.source_kind = String(transcript).trim() ? 'transcribed' : existing.data.source_kind
  }
  if (tags !== undefined) payload.tags = parseTags(tags)
  if (eventDate !== undefined) payload.event_date = eventDate

  if (!Object.keys(payload).length) {
    return res.status(400).json({ success: false, message: 'Nothing to update.' })
  }

  // The searchable text changed, so the derived summary/topics/embedding are now
  // stale. Mark the memory pending and queue a fresh run; the old values are
  // cleared so nothing incorrect is ever served in the meantime.
  const textChanged = payload.content !== undefined || payload.transcript !== undefined
  if (textChanged) {
    payload.processing_status = 'pending'
    payload.processing_stage = 'queued'
    payload.processing_error = null
    payload.processed_at = null
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

  // Re-process when the text actually changed. Never blocks the response, and
  // the user's edited text is already saved either way.
  if (textChanged) {
    await queueProcessing(req.accessToken, data, { reason: 'updated' }).catch(() => {})
  }

  res.json({ success: true, message: 'Memory updated.', data, processing: describeStatus(data) })
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

  // Derived data goes with it:
  //   - the stored file is removed from disk
  //   - memory_vectors and memory_links rows cascade-delete via the foreign key
  //     in memory_intelligence.sql, so no orphan vector can ever resurface this
  //     memory in a search result
  // The explicit vector delete is a belt-and-braces step for databases where the
  // cascade has not been created yet.
  removeUploadedFile(existing.data.file_url)
  await purgeDerived(req.accessToken, id).catch(() => {})

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