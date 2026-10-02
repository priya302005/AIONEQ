import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import crypto from 'node:crypto'
import authRoutes from './routes/auth.routes.js'
import memoryRoutes from './routes/memory.routes.js'
import { filesRouter } from './routes/memory.routes.js'
import queryRoutes from './routes/query.routes.js'
import exportRoutes from './routes/export.routes.js'
import accountRoutes from './routes/account.routes.js'
import legacyRoutes from './routes/legacy.routes.js'
import { uploadsDir } from './middleware/upload.middleware.js'
import { notFound, errorHandler } from './middleware/error.middleware.js'
import { requireAuth } from './middleware/auth.middleware.js'
import { config } from './config/config.js'

const app = express()

// Trust proxy hop count only when explicitly configured (behind a TLS
// reverse-proxy that sets X-Forwarded-For). Rate limiting uses req.ip, so
// leaving this off by default prevents spoofed-forwarded-for bypasses.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1)
}

// ------------------------------------------------------------- security ----
// Helmet security headers. CSP here guards the JSON API itself (and would
// constrain any HTML this server could ever emit). The SPA's own CSP lives
// in the frontend index.html.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.env === 'production' ? { maxAge: 15552000, includeSubDomains: true, preload: true } : false,
  })
)

// CORS locked to the configured frontend origin(s). Never '*'.
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true)
      return cb(new Error('Origin not allowed by CORS.'))
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
)

app.use(express.json({ limit: config.jsonBodyLimit }))
app.use(express.urlencoded({ extended: false, limit: config.jsonBodyLimit }))

// Request id for correlating audit entries.
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID()
  res.setHeader('X-Request-Id', req.id)
  next()
})

// ---------------------------------------------------------------- routes ----
app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

app.use('/api/auth', authRoutes)
app.use('/api/memories', memoryRoutes)
app.use('/api/files', filesRouter)
app.use('/api/query', queryRoutes)
app.use('/api/export', exportRoutes)
app.use('/api/account', accountRoutes)
app.use('/api/legacy', legacyRoutes)

// NOTE: /uploads is deliberately NOT exposed as a public static path anymore.
// Uploaded files are only reachable through /api/files/:token (signed,
// ownership-checked, short-lived). The dir still exists on disk.

app.get('/uploads', (_req, res) => res.status(403).json({ message: 'Direct file access is not allowed.' }))

app.use(notFound)
app.use(errorHandler)

export default app
export { uploadsDir }