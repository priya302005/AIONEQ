import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from '../config/config.js'
import { audit } from '../utils/audit.js'

const execFileAsync = promisify(execFile)

/**
 * Upload-time malware scan integration point.
 *
 * EchoMind principle #3 (fail closed): when SCAN_COMMAND is configured we run
 * it against the freshly-uploaded file and REJECT the upload on any non-zero
 * exit code (found threat OR scanner failure).
 *
 * When no scanner is configured this is a no-op that returns { enabled: false }
 * and logs a one-time audit entry per upload so the gap is visible in the
 * audit trail. This is the flagged integration point for a real AV service
 * (ClamAV/clamd via `clamdscan`, VirusTotal API, S3 Object Lambda, etc).
 */
export async function scanFile(filePath, { userId, ip }) {
  if (!config.scanCommand) {
    audit({ action: 'upload.scan_not_configured', userId, ip, detail: { filePath: basenameOf(filePath) } })
    return { enabled: false, clean: null }
  }
  const [cmd, ...args] = config.scanCommand.split(' ')
  try {
    const { stdout } = await execFileAsync(cmd, [...args, filePath], { timeout: 30_000 })
    const clean = /^0$/m.test(String(stdout).trim()) || !/: FOUND/m.test(String(stdout))
    if (!clean) {
      audit({ action: 'upload.scan_threat', userId, ip, detail: { filePath: basenameOf(filePath) } })
    }
    return { enabled: true, clean }
  } catch {
    // Scanner error => fail closed.
    return { enabled: true, clean: false }
  }
}

function basenameOf(p) {
  return String(p).split(/[\\/]/).pop()
}