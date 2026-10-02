import { createClient } from '@supabase/supabase-js'
import { config } from '../config/config.js'

/**
 * Per-user storage quota. Total uploaded bytes per user are stored on the
 * memories rows (file_size column) and summed here. The check is a guard
 * layer on top of multer's per-file limit.
 */
export async function userUploadedBytes(token, userId) {
  if (!config.storageQuotaBytes) return 0
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const { data, error } = await client
    .from('memories')
    .select('file_size')
    .eq('user_id', userId)
  if (error || !data) return 0
  return data.reduce((sum, m) => sum + (Number(m.file_size) || 0), 0)
}

export async function assertQuota(token, userId, newFileBytes) {
  if (!config.storageQuotaBytes) return { ok: true }
  const used = await userUploadedBytes(token, userId)
  if (used + newFileBytes > config.storageQuotaBytes) {
    const mb = (v) => (v / 1024 / 1024).toFixed(1)
    return { ok: false, message: `Storage quota exceeded (${mb(used)}MB used of ${mb(config.storageQuotaBytes)}MB).` }
  }
  return { ok: true }
}