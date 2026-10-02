import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config/config.js'

/**
 * Structured audit logger. EchoMind security principle #5: security-relevant
 * actions are logged with who/when/what. Memory *content* is NEVER logged -
 * only ids, types, and counts.
 *
 * Writes newline-delimited JSON to logs/audit.log (config.auditLogPath).
 */

let writeQueue = Promise.resolve()

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function appendLine(filePath, line) {
  writeQueue = writeQueue
    .then(() => {
      ensureDir(filePath)
      fs.appendFileSync(filePath, line + '\n', 'utf8')
    })
    .catch((err) => console.error('[AUDIT] write failed:', err.message))
}

/**
 * @param {object} entry
 * @param {string} entry.action   e.g. 'auth.login', 'memory.delete'
 * @param {string} [entry.userId]
 * @param {string} [entry.ip]
 * @param {string} [entry.route]
 * @param {object} [entry.detail] Safe, content-free metadata.
 */
export function audit({ action, userId, ip, route, detail = {} }) {
  if (!config.auditEnabled) return
  const d = new Date().toISOString()
  const entry = { ts: d, action, userId: userId || null, ip: ip || null, route: route || null, detail }
  appendLine(config.auditLogPath, JSON.stringify(entry))
}