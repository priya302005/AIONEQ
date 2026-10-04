import { createClient } from '@supabase/supabase-js'
import { config } from '../config/config.js'

function clientFor(token) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

/** Defaults applied when the row does not exist yet (migration not applied). */
export const DEFAULT_SETTINGS = Object.freeze({
  memoryAiEnabled: true,
  conversationMemoryEnabled: true,
  processingEnabled: true,
})

function normalize(row) {
  if (!row) return { ...DEFAULT_SETTINGS, updatedAt: null }
  return {
    // `!== false` so a NULL from an older row reads as enabled, never silently
    // disabling a feature the user already relied on.
    memoryAiEnabled: row.memory_ai_enabled !== false,
    conversationMemoryEnabled: row.conversation_memory_enabled !== false,
    processingEnabled: row.processing_enabled !== false,
    updatedAt: row.updated_at || null,
  }
}

/** Reads the caller's settings. Falls back to defaults if the table is absent. */
export async function getMemorySettings(token, userId) {
  try {
    const { data, error } = await clientFor(token).from('memory_settings').select('*').eq('user_id', userId).maybeSingle()
    if (error || !data) return { ...DEFAULT_SETTINGS, updatedAt: null }
    return normalize(data)
  } catch {
    return { ...DEFAULT_SETTINGS, updatedAt: null }
  }
}

/**
 * Upserts the caller's settings. Only the keys present in `patch` are written,
 * so a partial update never resets the others.
 */
export async function updateMemorySettings(token, userId, patch) {
  const row = { user_id: userId, updated_at: new Date().toISOString() }
  if (patch.memoryAiEnabled !== undefined) row.memory_ai_enabled = Boolean(patch.memoryAiEnabled)
  if (patch.conversationMemoryEnabled !== undefined) row.conversation_memory_enabled = Boolean(patch.conversationMemoryEnabled)
  if (patch.processingEnabled !== undefined) row.processing_enabled = Boolean(patch.processingEnabled)

  try {
    const { data, error } = await clientFor(token)
      .from('memory_settings')
      .upsert(row, { onConflict: 'user_id' })
      .select('*')
      .maybeSingle()
    if (error) throw error
    return { settings: normalize(data), error: null }
  } catch (err) {
    return { settings: null, error: err }
  }
}

/**
 * Removes the caller's settings row entirely. Used by account deletion:
 * without it the row is only removed by the auth.users cascade, which
 * requires the service-role key, so a self-service deletion would
 * orphan it. Requires the memory_settings_delete_own RLS policy
 * (sql/memory_intelligence.sql).
 */
export async function removeMemorySettingsForUser(token, userId) {
  try {
    const { data, error } = await clientFor(token)
      .from('memory_settings')
      .delete()
      .eq('user_id', userId)
      .select('user_id')
    if (error) throw error
    return { data, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}