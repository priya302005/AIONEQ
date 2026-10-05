/*
 * Memory ingestion: the wrapper around post-save processing.
 *
 * The controller saves a memory, then calls queueProcessing(). Processing is
 * asynchronous on purpose:
 *
 *   - A save must never fail or hang because an AI provider is slow or down.
 *     The memory is saved, stored, and immediately usable even with no summary.
 *   - A queued job that fails leaves processing_status = 'failed' (or 'partial'),
 *     which the UI shows, and the user can retry explicitly.
 *
 * Duplicate-submission guard: an identical save in quick succession would
 * otherwise be processed twice and create a duplicate proposal. Fingerprints
 * are held in memory with a short TTL, which is enough for the realistic case
 * (double-clicked Save, retried request) without persisting anything.
 */

import crypto from 'node:crypto'
import { processMemory, PROCESSING_STATUS } from './memoryPipeline.js'
import { getMemorySettings } from '../models/settings.model.js'
import { findMemoryById } from '../models/memory.model.js'

/** In-flight and recently-finished jobs: key -> { at, status }. */
const JOBS = new Map()
const FINGERPRINTS = new Map()
const RETENTION_MS = 60_000

function prune(now) {
  for (const [key, entry] of JOBS) {
    if (now - entry.at > RETENTION_MS) JOBS.delete(key)
  }
  for (const [key, entry] of FINGERPRINTS) {
    if (now - entry.at > RETENTION_MS) FINGERPRINTS.delete(key)
  }
}

/**
 * Content fingerprint used to detect a duplicate submission: the same user
 * saving byte-identical content within the retention window. This is a
 * convenience guard against double-submits, NOT content deduplication - two
 * deliberately re-saved similar memories must both be kept.
 */
function fingerprint({ userId, type, title, content, transcript, fileUrl }) {
  return crypto
    .createHash('sha256')
    .update(
      [
        userId,
        type,
        String(title || '').trim(),
        String(content || '').trim(),
        String(transcript || '').trim(),
        fileUrl || '',
      ].join(' ')
    )
    .digest('hex')
}

/**
 * Queues the understanding pipeline for a saved memory.
 * Never throws, never blocks the HTTP response.
 *
 * @returns {Promise<{queued:boolean, reason?:string}>}
 */
export async function queueProcessing(token, memory, { reason = 'created' } = {}) {
  if (!memory?.id) return { queued: false, reason: 'no_memory' }

  const now = Date.now()
  prune(now)

  const fp = fingerprint(memory)
  if (FINGERPRINTS.has(fp)) {
    // Same content already in flight or just processed - do not redo the work
    // and do not create a second duplicate proposal.
    return { queued: false, reason: 'duplicate_submission' }
  }
  FINGERPRINTS.set(fp, { at: now })

  // Respect the user's own switch: no processing means no derived metadata, and
  // the memory stays fully usable as typed.
  const settings = await getMemorySettings(token, memory.user_id)
  if (!settings.processingEnabled) {
    return { queued: false, reason: 'disabled_by_user' }
  }

  const key = `${memory.user_id}:${memory.id}:${reason}`
  JOBS.set(key, { at: now, status: PROCESSING_STATUS.PROCESSING })

  // Fire and forget. The .catch keeps an unexpected error from becoming an
  // unhandledRejection, which would kill the process (see server.js).
  run(token, memory, key).catch(() => {
    JOBS.set(key, { at: Date.now(), status: PROCESSING_STATUS.FAILED })
  })

  return { queued: true }
}

async function run(token, memory, key) {
  const result = await processMemory(token, memory)
  JOBS.set(key, { at: Date.now(), status: result.status })
}

/**
 * Reprocesses a memory on demand (after an edit, or when the user retries a
 * failed one). Awaited so the caller can report the real outcome.
 */
export async function reprocessMemory(token, memoryId) {
  const { data, error } = await findMemoryById(token, memoryId)
  if (error || !data) return { ok: false, reason: error?.message || 'Memory not found.' }

  const settings = await getMemorySettings(token, data.user_id)
  if (!settings.processingEnabled) {
    return { ok: false, reason: 'Memory processing is turned off for your account.' }
  }

  // Clear the fingerprint so an explicit retry always does the work.
  FINGERPRINTS.delete(fingerprint(data))

  // Likewise clear the analysis fingerprint: "process again" is the user asking
  // for fresh work, so the pipeline must not short-circuit on unchanged text.
  const result = await processMemory(token, { ...data, analysis_hash: null })
  return {
    ok: result.status !== PROCESSING_STATUS.FAILED,
    status: result.status,
    summary: result.summary,
    notes: result.notes,
  }
}

/** Current pipeline status of a memory, for the UI. */
export function describeStatus(memory) {
  const status = memory?.processing_status || PROCESSING_STATUS.READY
  return {
    status,
    stage: memory?.processing_stage || null,
    error: memory?.processing_error || null,
    processedAt: memory?.processed_at || null,
    hasSummary: Boolean(memory?.ai_summary),
    hasTopics: Array.isArray(memory?.topics) && memory.topics.length > 0,
    hasTranscript: Boolean(memory?.transcript),
    hasExtractedText: Boolean(memory?.extracted_text),
  }
}

export { PROCESSING_STATUS }