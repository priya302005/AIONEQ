import fs from 'node:fs'
import path from 'node:path'
import { Archiver } from 'archiver'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config/config.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { audit } from '../utils/audit.js'
import { uploadsDir } from '../middleware/upload.middleware.js'
import { findMemories } from '../models/memory.model.js'
import { listConversations } from '../models/conversation.model.js'

function clientFor(token) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

/**
 * Full data export. Every memory (including uploaded files), every
 * conversation, and a manifest file are packed into one zip downloaded by the
 * owner. This supports EchoMind's "true portability" data-minimization goal.
 */
export const exportAllController = asyncHandler(async (req, res) => {
  const { scope } = req.body || {} // 'all' | 'text', zod-validated

  const [memoriesRes, conversationsRes] = await Promise.all([
    findMemories(req.accessToken),
    listConversations(req.accessToken),
  ])

  if (memoriesRes.error || conversationsRes.error) {
    return res.status(400).json({ success: false, message: 'Unable to gather data for export.' })
  }

  const memories = memoriesRes.data || []
  const conversations = conversationsRes.data || []

  const manifest = {
    exportDate: new Date().toISOString(),
    userId: req.user.id,
    scope,
    memoryCount: memories.length,
    conversationCount: conversations.length,
    memories: memories.map(({ id, type, title, tags, event_date, created_at, updated_at, duration, mime_type, file_url }) => ({
      id, type, title, tags, event_date, created_at, updated_at, duration, mime_type,
      file: file_url ? path.basename(file_url) : null,
    })),
    conversations: conversations.map(({ id, title, messages, created_at, updated_at }) => ({
      id, title, messages, created_at, updated_at,
    })),
  }

  const zip = new Archiver('zip', { zlib: { level: 9 } })
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="echomind-export-${req.user.id.slice(0, 8)}.zip"`)
  res.setHeader('Cache-Control', 'private, no-store')
  zip.pipe(res)

  zip.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })
  if (scope !== 'text') {
    for (const m of memories) {
      if (!m.file_url) continue
      const filePath = path.join(uploadsDir, path.basename(m.file_url))
      if (fs.existsSync(filePath)) {
        zip.file(filePath, { name: `files/${path.basename(m.file_url)}` })
      }
    }
  }

  zip.on('error', () => res.destroy())
  zip.on('warning', () => {})
  zip.finalize()

  res.on('close', () => {
    audit({ action: 'export.completed', userId: req.user.id, ip: req.ip, detail: { scope, memoryCount: memories.length, conversationCount: conversations.length } })
  })
})