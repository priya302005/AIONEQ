import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config/config.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { audit } from '../utils/audit.js'
import { uploadsDir } from '../middleware/upload.middleware.js'
import {
  removeAllMemoriesForUser,
  removeAllMemoryVectorsForUser,
} from '../models/memory.model.js'
import { removeAllConversationsForUser } from '../models/conversation.model.js'
import { removeAllMemoryLinksForUser } from '../models/memoryLink.model.js'
import { removeMemorySettingsForUser } from '../models/settings.model.js'

/**
 * Removes one uploaded file from the local upload directory.
 * The name is basenamed first so a crafted file_url can never
 * escape the uploads directory. Resolves false on failure so
 * callers can count and report unremovable files instead of
 * silently orphaning them.
 */
function removeFile(name) {
  const safe = path.basename(String(name || ''))
  if (!safe) return Promise.resolve(false)
  return new Promise((resolve) => {
    fs.unlink(path.join(uploadsDir, safe), (err) => resolve(!err))
  })
}

/**
 * Runs one deletion step. Database failures are returned, never
 * thrown past this point, and a PostgREST error body counts as a
 * failure too - a partial wipe must never be reported as success.
 */
async function runStep(fn) {
  try {
    const result = await fn()
    if (result?.error) return { ok: false, error: result.error }
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: err }
  }
}

function countOf(result) {
  if (result?.count != null) return result.count
  return Array.isArray(result?.data) ? result.data.length : 0
}

/**
 * Hard account deletion ("Forget my data").
 *
 * Deletes, in dependency order (children before parents):
 *   memory_links    - relationship records (derived metadata)
 *   memory_vectors  - embedding records
 *   memory_settings - privacy / consent row
 *   memories        - original rows (content, transcripts, extracted
 *                     text, summaries, topics) and, immediately
 *                     after, the uploaded files they reference
 *   conversations   - chat threads including their messages
 *   legacy_grants   - grants the user owns AND grants naming the
 *                     user as recipient (their access into other
 *                     people's archives)
 *
 * Children are deleted explicitly rather than via the FK cascade so
 * the wipe is deterministic even on a database where the cascade has
 * not been created yet. Every step is checked; a failure aborts with
 * 500 and says the deletion is INCOMPLETE. Retrying is safe because
 * every step is idempotent.
 *
 * Limitations that are honestly reported in the response (never
 * hidden):
 *   - without SUPABASE_SERVICE_ROLE_KEY the Supabase auth identity
 *     is retained (it holds no archive data)
 *   - upload files that could not be removed from disk are counted
 *   - managed database backups (Supabase point-in-time recovery)
 *     retain deleted rows for the backup retention window - that is
 *     outside this API's reach
 */
export const deleteAccountController = asyncHandler(async (req, res) => {
  const userId = req.user.id
  const token = req.accessToken
  const limitations = []
  const counts = {
    links: 0,
    vectors: 0,
    settings: 0,
    memories: 0,
    conversations: 0,
    grants: 0,
    filesRemoved: 0,
    filesFailed: 0,
  }

  // 1. Derived records first (children), each step checked.
  const children = [
    ['memory_links', () => removeAllMemoryLinksForUser(token), (r) => { counts.links = countOf(r) }],
    ['memory_vectors', () => removeAllMemoryVectorsForUser(token), (r) => { counts.vectors = countOf(r) }],
    ['memory_settings', () => removeMemorySettingsForUser(token, userId), (r) => { counts.settings = countOf(r) }],
  ]
  for (const [table, fn, tally] of children) {
    const outcome = await runStep(fn)
    if (!outcome.ok) {
      audit({
        action: 'account.delete_failed',
        userId,
        ip: req.ip,
        detail: { step: table, error: String(outcome.error?.message || outcome.error).slice(0, 200) },
      })
      return res.status(500).json({
        success: false,
        message:
          `Account deletion is INCOMPLETE - it failed while removing your ${table}. ` +
          'Some data may already have been removed. Retry the request; every step is safe to repeat. ' +
          'If it keeps failing, contact support.',
      })
    }
    tally(outcome.result)
  }

  // 2. The memories themselves, then their uploaded files straight
  //    away: the file list is only available from the deleted rows,
  //    and removing the files now means a later step failing cannot
  //    orphan them on disk.
  const memoriesOutcome = await runStep(() => removeAllMemoriesForUser(token))
  if (!memoriesOutcome.ok) {
    audit({
      action: 'account.delete_failed',
      userId,
      ip: req.ip,
      detail: { step: 'memories', error: String(memoriesOutcome.error?.message || memoriesOutcome.error).slice(0, 200) },
    })
    return res.status(500).json({
      success: false,
      message:
        'Account deletion is INCOMPLETE - it failed while removing your memories. ' +
        'Some data may already have been removed. Retry the request; every step is safe to repeat. ' +
        'If it keeps failing, contact support.',
    })
  }
  counts.memories = countOf(memoriesOutcome.result)
  const deletedMemories = Array.isArray(memoriesOutcome.result?.data) ? memoriesOutcome.result.data : []
  const fileResults = await Promise.all(deletedMemories.map((m) => removeFile(m.file_url)))
  counts.filesRemoved = fileResults.filter(Boolean).length
  counts.filesFailed = fileResults.filter((ok) => !ok).length
  if (counts.filesFailed > 0) {
    limitations.push(
      `${counts.filesFailed} uploaded file(s) could not be removed from the server's upload directory. ` +
        'Their database rows are gone, so they are unreachable, but the bytes remain on disk until the server is cleaned up manually.'
    )
  }

  // 3. Conversations (including their messages).
  const conversationsOutcome = await runStep(() => removeAllConversationsForUser(token))
  if (!conversationsOutcome.ok) {
    audit({
      action: 'account.delete_failed',
      userId,
      ip: req.ip,
      detail: { step: 'conversations', error: String(conversationsOutcome.error?.message || conversationsOutcome.error).slice(0, 200) },
    })
    return res.status(500).json({
      success: false,
      message:
        'Account deletion is INCOMPLETE - it failed while removing your conversations. ' +
        'Your memories and uploaded files have already been removed. Retry the request; every step is safe to repeat. ' +
        'If it keeps failing, contact support.',
    })
  }
  counts.conversations = countOf(conversationsOutcome.result)

  // 4. Legacy access grants: ones the user owns, and ones naming
  //    the user as recipient (their access into other archives).
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const grantSteps = [
    ['legacy_grants (owned)', () => client.from('legacy_grants').delete().eq('owner_id', userId)],
    ['legacy_grants (recipient)', () => client.from('legacy_grants').delete().eq('recipient_user_id', userId)],
  ]
  for (const [label, fn] of grantSteps) {
    const outcome = await runStep(fn)
    if (!outcome.ok) {
      audit({
        action: 'account.delete_failed',
        userId,
        ip: req.ip,
        detail: { step: label, error: String(outcome.error?.message || outcome.error).slice(0, 200) },
      })
      return res.status(500).json({
        success: false,
        message:
          `Account deletion is INCOMPLETE - it failed while revoking legacy access grants (${label}). ` +
          'Your memories, files and conversations have already been removed. Retry the request; every step is safe to repeat. ' +
          'If it keeps failing, contact support.',
      })
    }
    counts.grants += countOf(outcome.result)
  }

  // 5. The Supabase auth identity itself - requires the service-role
  //    key. Without it the identity is retained and the response
  //    says so; it contains no archive data.
  if (config.supabaseServiceRoleKey) {
    const admin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false },
    })
    const { error } = await admin.auth.admin.deleteUser(userId)
    if (error) {
      audit({
        action: 'account.delete_auth_failed',
        userId,
        ip: req.ip,
        detail: { error: String(error.message || error).slice(0, 200) },
      })
      limitations.push(
        'The Supabase auth identity (email / password) could not be removed automatically. Contact support to delete it.'
      )
    }
  } else {
    audit({ action: 'account.delete_auth_identity_retained', userId, ip: req.ip })
    limitations.push(
      'The Supabase auth identity (email / password) was retained because no service-role key is configured. ' +
        'It contains no archive data. Contact support to remove it.'
    )
  }

  // 6. Platform retention this API cannot reach. Reported so the
  //    deletion is never claimed to be more complete than it is.
  limitations.push(
    'Managed database backups (Supabase point-in-time recovery) retain deleted rows for the backup ' +
      'retention window. Deletion is immediate in the live database but cannot reach backups.'
  )

  audit({ action: 'account.deleted', userId, ip: req.ip, detail: { ...counts } })
  res.json({
    success: true,
    message: 'Your EchoMind data has been permanently deleted.',
    deletion: { counts, limitations },
  })
})
