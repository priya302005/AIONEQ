import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from '../config/config.js'
import { audit } from '../utils/audit.js'

const execFileAsync = promisify(execFile)

/**
 * Upload-time malware scan integration point.
 *
 * EchoMind principle #3 (fail closed):
 *
 *   - When SCAN_COMMAND is configured we run it against the
 *     freshly-uploaded file and REJECT the upload on any
 *     non-zero exit code (found threat OR scanner failure).
 *   - When no scanner is configured the behaviour depends on
 *     `cfg.uploadScanRequired` (REQUIRE_UPLOAD_SCAN, defaulting
 *     to true in production):
 *        required  -> the upload is NOT clean (rejected), so
 *                     production can never treat an unscanned
 *                     upload as clean;
 *        not required (development/test) -> the scan is skipped
 *                     so the upload flow stays usable, and the
 *                     gap is still audited per upload.
 *
 * `cfg` is injectable so the three paths can be unit-tested
 * without touching the real environment.
 */
export async function scanFile(filePath, { userId, ip }, cfg = config) {
  if (!cfg.scanCommand) {
    audit({ action: 'upload.scan_not_configured', userId, ip, detail: { filePath: basenameOf(filePath) } })
    // Fail closed when a scanner is required; otherwise a
    // documented, audited no-op.
    return { enabled: false, clean: cfg.uploadScanRequired ? false : true, scanned: false }
  }
  const [cmd, ...args] = cfg.scanCommand.split(' ')
  try {
    const { stdout } = await execFileAsync(cmd, [...args, filePath], { timeout: 30_000 })
    const clean = /^0$/m.test(String(stdout).trim()) || !/: FOUND/m.test(String(stdout))
    if (!clean) {
      audit({ action: 'upload.scan_threat', userId, ip, detail: { filePath: basenameOf(filePath) } })
    }
    return { enabled: true, clean, scanned: true }
  } catch {
    // Scanner error => fail closed.
    return { enabled: true, clean: false, scanned: true }
  }
}

function basenameOf(p) {
  return String(p).split(/[\\/]/).pop()
}
