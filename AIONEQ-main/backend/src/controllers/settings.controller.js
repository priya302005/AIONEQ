/*
 * Memory privacy settings.
 *
 * Three switches, all owned by the user, all enforced server-side:
 *
 *   memoryAiEnabled           - may the assistant use saved memories at all?
 *   conversationMemoryEnabled  - may previous conversations be used as context?
 *   processingEnabled         - may transcription / extraction / AI analysis run?
 *
 * These are read on every ask and every save. Turning memoryAiEnabled off makes
 * the assistant answer from general knowledge and never touch the archive, which
 * is a real, enforced privacy control rather than a UI preference.
 */

import { asyncHandler } from '../utils/asyncHandler.js'
import { audit } from '../utils/audit.js'
import { getMemorySettings, updateMemorySettings } from '../models/settings.model.js'

/** GET /api/memory-settings */
export const getSettingsController = asyncHandler(async (req, res) => {
  const settings = await getMemorySettings(req.accessToken, req.user.id)
  res.json({ success: true, data: settings })
})

/** PATCH /api/memory-settings */
export const updateSettingsController = asyncHandler(async (req, res) => {
  const patch = req.body // zod-validated: at least one boolean

  const { settings, error } = await updateMemorySettings(req.accessToken, req.user.id, patch)
  if (error || !settings) {
    return res.status(400).json({
      success: false,
      message: 'Could not save your settings. Run the SQL in backend/sql/memory_intelligence.sql if it has not been applied yet.',
    })
  }

  // The audit log records WHICH control changed, never the archive content.
  audit({ action: 'memory.settings_update', userId: req.user.id, ip: req.ip, detail: { keys: Object.keys(patch) } })
  res.json({ success: true, message: 'Settings saved.', data: settings })
})