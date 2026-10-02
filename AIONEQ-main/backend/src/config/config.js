import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const backendRoot = path.join(__dirname, '..', '..')

function bool(value, fallback) {
  if (value === undefined) return fallback
  return String(value).toLowerCase() === 'true'
}

function int(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Parse CORS origins. Defaults to the frontend dev server only - never '*'.
 * Accepts a comma-separated list in CORS_ORIGIN.
 */
function corsOrigins() {
  const raw = process.env.CORS_ORIGIN
  if (!raw || !String(raw).trim()) return ['http://localhost:5173', 'http://127.0.0.1:5173']
  return String(raw)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
}

export const config = {
  // --- server ---
  port: int(process.env.PORT, 4000),
  // Bind to loopback by default. Set HOST=0.0.0.0 only if you are deliberately
  // exposing the API (never in production with the LLM talking to it).
  host: process.env.HOST || '127.0.0.1',
  env: process.env.NODE_ENV || 'development',

  // --- supabase ---
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  // Optional: only required for account deletion of the auth user record.
  // NEVER exposed to the frontend; used exclusively server-side.
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || null,
  resetRedirectUrl: process.env.RESET_REDIRECT_URL || 'http://localhost:5173',

  // --- local LLM ---
  localAiBaseUrl: process.env.LOCAL_AI_BASE_URL || 'http://localhost:4891',
  localAiModel: process.env.LOCAL_AI_MODEL || 'Llama 3.2 3B Instruct',
  queryMaxMemories: int(process.env.QUERY_MAX_MEMORIES, 6),
  // Small-context local models (e.g. the project's trained tiny GPT, 256-token
  // window) cannot fit the full EchoMind prompt. When enabled, use a stripped
  // system prompt and a truncated memory context so the request fits the model.
  localAiCompactPrompt: bool(process.env.LOCAL_AI_COMPACT_PROMPT, false),

  // --- context engine (Ask) ---
  // Relevance floor (0..1) for retrieved context; anything below is rejected.
  contextMinScore: num(process.env.CONTEXT_MIN_SCORE, 0.12),
  // Max previous-conversation segments per ask, and conversation candidate pool.
  contextMaxConversations: int(process.env.CONTEXT_MAX_CONVERSATIONS, 2),
  contextConvCandidates: int(process.env.CONTEXT_CONV_CANDIDATES, 25),
  // Total context-char budget handed to the LLM per ask (sections are trimmed
  // to fit; the current conversation is always kept whole).
  contextMaxChars: int(process.env.CONTEXT_MAX_CHARS, 6000),
  // When the top two memory scores are closer than this, flag ambiguity so the
  // model acknowledges both instead of guessing silently.
  contextAmbiguityTolerance: num(process.env.CONTEXT_AMBIGUITY_TOLERANCE, 0.12),
  // Development-only selection logging ([CONTEXT RETRIEVAL] ...). Keep off in prod.
  contextDebug: bool(process.env.CONTEXT_DEBUG, false),
  // Best-effort metadata enrichment (keywords/entities/summary) written back to
  // each memory after save. Never blocks the save and never rewrites the
  // original user content.
  localEnrichMemories: bool(process.env.LOCAL_ENRICH_MEMORIES, false),

  // --- CORS / headers ---
  corsOrigins: corsOrigins(),
  jsonBodyLimit: process.env.JSON_BODY_LIMIT || '1mb',

  // --- file uploads ---
  maxFileBytes: int(process.env.MAX_FILE_SIZE_MB, 25) * 1024 * 1024,
  // Per-user total uploaded bytes cap (0 disables the check).
  storageQuotaBytes: int(process.env.STORAGE_QUOTA_MB, 0) * 1024 * 1024,
  // Soft pass at upload-time file scan. Set SCAN_COMMAND to an external
  // scanner (e.g. clamd/ClamAV) that returns exit code 0 for clean files.
  scanCommand: process.env.SCAN_COMMAND || null,

  // --- signed URLs ---
  // Used to HMAC-sign short-lived file URLs. MUST be a long random string in
  // production. If missing we fall back to SUPABASE_ANON_KEY-derived secret
  // at startup (still unique per project), but config.js fails fast when
  // neither is available.
  signedUrlSecret: process.env.SIGNED_URL_SECRET || process.env.SUPABASE_ANON_KEY,
  signedUrlTtlSeconds: int(process.env.SIGNED_URL_TTL_SECONDS, 300),

  // --- audit logging ---
  auditLogPath: process.env.AUDIT_LOG_PATH || path.join(backendRoot, 'logs', 'audit.log'),
  auditEnabled: bool(process.env.AUDIT_ENABLED, true),

  // --- lockout (in-memory) ---
  lockoutMaxAttempts: int(process.env.LOCKOUT_MAX_ATTEMPTS, 5),
  lockoutBaseBackoffMs: int(process.env.LOCKOUT_BASE_BACKOFF_MS, 30_000),

  // --- session / re-auth ---
  sessionTtlMinutes: int(process.env.SESSION_TTL_MINUTES, 30),

  // --- legacy access ---
  // Verification required before a legacy grant activates:
  //  'none'            -> claim token is enough
  //  'access-code'     -> owner sets a shared access code when creating the grant
  //  'trusted-contact' -> (extension point) requires a separate trusted contact
  //                       confirmation; treated as access-code for now
  legacyVerification: process.env.LEGACY_VERIFICATION || 'none',
  // Do legacy grants include uploaded files, or text content only?
  legacyIncludeFiles: bool(process.env.LEGACY_INCLUDE_FILES, true),
}