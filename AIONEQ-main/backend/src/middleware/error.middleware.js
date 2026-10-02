import { config } from '../config/config.js'
import { audit } from '../utils/audit.js'

export function notFound(req, res) {
  res.status(404).json({ message: 'Route not found.' })
}

export function errorHandler(err, req, res, next) {
  // CORS failures are common and safe to echo.
  if (err.message === 'Origin not allowed by CORS.') {
    return res.status(403).json({ message: err.message })
  }

  // Always record server-side.
  console.error(`[ERROR] ${req.id}:`, err)

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: `File is too large. Maximum size is ${(config.maxFileBytes / 1024 / 1024).toFixed(0)}MB.` })
  }

  const status = err.status || 500

  if (status >= 500) {
    audit({
      action: 'error.server',
      userId: req.user?.id || null,
      ip: req.ip,
      detail: {
        route: req.originalUrl,
        status,
        // Always record the failure detail server-side (auditability). Stack
        // traces and paths are kept out of client responses but belong in the
        // audit trail. Truncated to keep log lines bounded.
        message: String(err?.message || err?.name || 'unknown').slice(0, 500),
        stack: err?.stack ? err.stack.split('\n').slice(0, 6).join(' | ').slice(0, 800) : undefined,
      },
    })
  }

  // In production, never leak internal error details (file paths, SQL, etc.).
  const message =
    status >= 500 && config.env === 'production'
      ? 'Internal server error.'
      : err.message || 'Internal server error.'

  res.status(status).json({ message })
}