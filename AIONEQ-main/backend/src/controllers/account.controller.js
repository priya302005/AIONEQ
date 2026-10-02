import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config/config.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { audit } from '../utils/audit.js'
import { uploadsDir } from '../middleware/upload.middleware.js'
import { removeAllMemoriesForUser } from '../models/memory.model.js'
import { removeAllConversationsForUser } from '../models/conversation.model.js'

function removeFileByName(name) {
  const safe = path.basename(String(name || ''))
  if (safe) fs.unlink(path.join(uploadsDir, safe), () => {})
}

/**
 * Hard account deletion: memories (rows AND stored files), conversations, and
 * legacy grants are permanently deleted. The Supabase auth identity is removed
 * too when a service-role key is configured; otherwise the data is wiped and a
 * warning is returned (flagged limitation).
 */
export const deleteAccountController = asyncHandler(async (req, res) => {
  const userId = req.user.id

  // 1. Delete memory rows; files are removed from disk.
  const { data: deletedMemories } = await removeAllMemoriesForUser(req.accessToken)
  ;(deletedMemories || []).forEach((m) => removeFileByName(m.file_url))

  // 2. Delete conversations.
  await removeAllConversationsForUser(req.accessToken)

  // 3. Delete legacy grants owned by the user and any grants in which the
  //    user is a recipient (revoke access into their archive).
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${req.accessToken}` } },
  })
  await client.from('legacy_grants').delete().eq('owner_id', userId)
  await client.from('legacy_grants').delete().eq('recipient_user_id', userId)

  // 4. Delete the auth identity itself - requires the service-role key.
  if (config.supabaseServiceRoleKey) {
    const admin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false },
    })
    const { error } = await admin.auth.admin.deleteUser(userId)
    if (error) {
      audit({ action: 'account.delete_auth_failed', userId, ip: req.ip, detail: { error: error.message } })
      return res.status(200).json({
        success: true,
        message: 'Your data has been permanently deleted. The Supabase auth identity could not be removed automatically - please contact support.',
      })
    }
  } else {
    audit({ action: 'account.delete_auth_identity_flagged', userId, ip: req.ip })
    return res.status(200).json({
      success: true,
      message: 'Your data has been permanently deleted. The Supabase auth identity remains (service-role key not configured); it contains no personal archive data.',
    })
  }

  audit({ action: 'account.deleted', userId, ip: req.ip })
  res.json({ success: true, message: 'Account and all associated data permanently deleted.' })
})