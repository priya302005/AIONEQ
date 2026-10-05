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

/**
 * Values that are obviously not real credentials. `.env.example` ships
 * `https://YOUR-PROJECT.supabase.co` / `your-anon-key`, and hand-written .env
 * files keep them. Real Supabase keys are a JWT (`eyJ...`) or an
 * `sb_publishable_...` / `sb_secret_...` token, so these patterns cannot match
 * a genuine credential.
 *
 * Left in place, a placeholder produces an opaque failure from deep inside the
 * Supabase SDK on every single signup/login - which reads like an application
 * bug rather than a missing setup step.
 */
const PLACEHOLDER_PATTERNS = [
  /your[-_ ]?project/i,
  /^your[-_ ]/i, // .env.example ships `your-anon-key` / `your-service-role-key`
  /placeholder/i,
  /not-a-real/i,
  /replace[-_ ]?me/i,
  /^change[-_ ]?me/i, // .env.example ships a `change-me-...` signed-url secret
  /^changeme$/i,
]

/** True when a credential value is absent-but-present: set, yet obviously fake. */
export function looksLikePlaceholderCredential(value) {
  if (!value) return false
  return PLACEHOLDER_PATTERNS.some((re) => re.test(String(value)))
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
  // True only when both credentials are present AND not sample values. Used to
  // tell a permanent misconfiguration ("retrying will never help") apart from a
  // genuine upstream outage ("try again in a moment") - see auth.controller.js.
  // Startup refuses to boot in production when this is false, so it can only be
  // observed outside production.
  supabaseCredentialsUsable: Boolean(
    process.env.SUPABASE_URL &&
      process.env.SUPABASE_ANON_KEY &&
      !looksLikePlaceholderCredential(process.env.SUPABASE_URL) &&
      !looksLikePlaceholderCredential(process.env.SUPABASE_ANON_KEY)
  ),
  // Optional: only required for account deletion of the auth user record.
  // NEVER exposed to the frontend; used exclusively server-side.
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || null,
  resetRedirectUrl: process.env.RESET_REDIRECT_URL || 'http://localhost:5173',

  // --- local LLM ---
  localAiBaseUrl: process.env.LOCAL_AI_BASE_URL || 'http://localhost:4891',
  localAiModel: process.env.LOCAL_AI_MODEL || 'Llama 3.2 3B Instruct',
  // Optional bearer token, for when the local server sits behind a proxy.
  localAiApiKey: process.env.LOCAL_AI_API_KEY || null,
  queryMaxMemories: int(process.env.QUERY_MAX_MEMORIES, 6),
  // Small-context local models (e.g. the project's trained tiny GPT, 256-token
  // window) cannot fit the full EchoMind prompt. When enabled, use a stripped
  // system prompt and a truncated memory context so the request fits the model.
  localAiCompactPrompt: bool(process.env.LOCAL_AI_COMPACT_PROMPT, false),

  // --- AI inference (generation parameters) ---
  // One place for every generation parameter the unified inference service
  // (src/services/inferenceService.js) applies. The defaults are EXACTLY the
  // values that were previously hardcoded in llmClient and in the ask/pipeline
  // call sites, so behaviour is unchanged until an operator overrides them.
  //
  // Provider limits: these are passed straight to an OpenAI-compatible
  // /v1/chat/completions (or /v1/completions) endpoint. Values outside a
  // provider's accepted range are its own validation error, surfaced as a
  // 4xx ProviderError - they are never silently clamped here, because a silent
  // clamp would make a misconfiguration invisible.
  aiTemperature: num(process.env.AI_TEMPERATURE, 0.5),
  aiMaxTokens: int(process.env.AI_MAX_TOKENS, 700),
  aiTimeoutMs: int(process.env.AI_TIMEOUT_MS, 20_000),
  // Retries for transient failures only (5xx, 429, connection resets). Bounded
  // so a dead provider cannot turn one user request into a long stall. Zero is a
  // legitimate setting - the relation classifier uses it - so this accepts 0.
  aiRetries: num(process.env.AI_RETRIES, 1),
  aiTopP: num(process.env.AI_TOP_P, 0.9),
  aiRepeatPenalty: num(process.env.AI_REPEAT_PENALTY, 1.2),
  aiFrequencyPenalty: num(process.env.AI_FREQUENCY_PENALTY, 0.3),
  aiPresencePenalty: num(process.env.AI_PRESENCE_PENALTY, 0.3),
  // Hard ceiling on the characters handed to the model for one ask. Sections
  // are trimmed to fit (see services/memoryContext.js buildContext). This is a
  // prompt-side budget; it is not a substitute for the model's own window.
  aiContextMaxChars: int(process.env.AI_CONTEXT_MAX_CHARS, 6000),

  // --- AI evaluation ---
  // When true (the default) the ask path applies deterministic claim grounding
  // (services/claimGrounding.js): a citation to an id that was not retrieved is
  // deleted from the answer, and an assertion with no support in the supplied
  // excerpts is removed. Turning it off is only useful for an A/B comparison of
  // the grounding rate and is refused in production by startup.js, where an
  // ungrounded answer must never be servable.
  aiClaimGroundingEnabled: bool(process.env.AI_CLAIM_GROUNDING, true),

  // When a question is about the user's own life and retrieval matched nothing,
  // hand the model the most recent memories anyway instead of replying "I found
  // nothing". Bag-of-words retrieval cannot connect "tell me my name" to a
  // memory reading "i am Janani" - the word "name" is not in it - so without this
  // a correctly stored fact is unreachable.
  //
  // Default OFF because it spends a model call on questions that may have no
  // answer, and a model asked about absent data may answer anyway. The safe
  // alternative is a real embedding model plus a reindex (EMBEDDING_MODE), which
  // ranks semantically without asking a model to judge relevance.
  //
  // When enabled, an answer is still only shown if it cites a supplied memory;
  // an uncited reply falls back to the honest refusal.
  aiBroadRecallEnabled: bool(process.env.AI_BROAD_RECALL, false),

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
  localEnrichMemories: bool(process.env.LOCAL_ENRICH_MEMORIES, true),

  // --- memory understanding pipeline ---
  // Master switch for post-save processing (transcription, document text
  // extraction, summarisation, embedding, indexing). When off, a memory is
  // still saved and fully usable - only the intelligence layer is skipped.
  memoryPipelineEnabled: bool(process.env.MEMORY_PIPELINE_ENABLED, true),
  // Hard ceilings so one huge upload can never stall a save or a retry.
  pipelineTimeoutMs: int(process.env.PIPELINE_TIMEOUT_MS, 25_000),
  pipelineMaxChars: int(process.env.PIPELINE_MAX_CHARS, 20_000),
  // Extract readable text from uploaded documents (PDF/DOCX/TXT/...).
  documentExtractionEnabled: bool(process.env.DOCUMENT_EXTRACTION_ENABLED, true),
  // Maximum bytes of an uploaded file the extractor will read.
  documentExtractionMaxBytes: int(process.env.DOCUMENT_EXTRACTION_MAX_MB, 25) * 1024 * 1024,

  // --- audio transcription (optional external service) ---
  // Voice notes recorded in the browser already carry a browser-generated
  // transcript. UPLOADED audio files do not, so transcription needs a service.
  // Leave TRANSCRIPTION_BASE_URL empty to disable: those memories are marked
  // 'partial' with a clear reason instead of failing.
  transcriptionBaseUrl: process.env.TRANSCRIPTION_BASE_URL || null,
  transcriptionPath: process.env.TRANSCRIPTION_PATH || '/inference',
  transcriptionApiKey: process.env.TRANSCRIPTION_API_KEY || null,
  transcriptionModel: process.env.TRANSCRIPTION_MODEL || null,
  transcriptionLanguage: process.env.TRANSCRIPTION_LANGUAGE || null,
  transcriptionTimeoutMs: int(process.env.TRANSCRIPTION_TIMEOUT_MS, 60_000),

  // --- embeddings & semantic retrieval ---
  // local = deterministic in-process vectorizer (default, no network)
  // remote = llama.cpp /embedding or OpenAI-compatible /v1/embeddings
  // off    = keyword/lexical retrieval only
  embeddingMode: ['local', 'remote', 'off'].includes(process.env.EMBEDDING_MODE)
    ? process.env.EMBEDDING_MODE
    : 'local',
  embeddingDim: int(process.env.EMBEDDING_DIM, 384),
  embeddingModel: process.env.EMBEDDING_MODEL || null,
  // Candidate rows pulled from each retrieval source before reranking.
  retrievalCandidateLimit: int(process.env.RETRIEVAL_CANDIDATE_LIMIT, 40),
  // Cosine floor for a vector hit to be considered at all.
  vectorMinSimilarity: num(process.env.VECTOR_MIN_SIMILARITY, 0.12),
  // Cosine that counts as "as similar as a good match gets" for the ACTIVE
  // embedding model. Raw cosine is NOT 0..1 for the local vectorizer: measured
  // gold question->memory pairs peak around 0.52, not 0.9. The blend therefore
  // rescales from VECTOR_MIN_SIMILARITY up to this anchor first, without which
  // keyword noise outranks genuine semantic matches.
  //
  // 0.45 and 0.12 are the local vectorizer's measured gold-p95 and non-gold-p95.
  // THEY MUST BE RE-DERIVED WHEN THE EMBEDDING MODEL CHANGES - run
  // `node eval/sweepParams.mjs`, read the last two lines, update these, then
  // reindex stored vectors (`npm run reindex:vectors`). A remote model has a
  // completely different similarity distribution.
  vectorSimilarityAnchor: num(process.env.VECTOR_SIMILARITY_ANCHOR, 0.52),
  // Weight of the vector score vs the lexical score in the final blend.
  retrievalVectorWeight: num(process.env.RETRIEVAL_VECTOR_WEIGHT, 0.6),
  // Cap on how many memories may enter the AI context for one question.
  retrievalMaxMemories: int(process.env.RETRIEVAL_MAX_MEMORIES, 8),
  // Above this score two memories are considered possibly-duplicated.
  duplicateSimilarity: num(process.env.DUPLICATE_SIMILARITY, 0.92),
  // Above this score two memories are considered the same subject evolving.
  relatedSimilarity: num(process.env.RELATED_SIMILARITY, 0.55),

  // --- memory listing / search ---
  // Cap on rows returned by GET /api/memories so the dashboard never loads an
  // unbounded archive into the browser.
  memoryListMaxLimit: int(process.env.MEMORY_LIST_MAX_LIMIT, 100),
  memoryListDefaultLimit: int(process.env.MEMORY_LIST_DEFAULT_LIMIT, 25),
  memorySearchMaxLimit: int(process.env.MEMORY_SEARCH_MAX_LIMIT, 50),

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
  // When true (the default in production), an upload with no working
  // scanner is REJECTED rather than treated as clean - fail closed.
  // Development and test default to false so the upload flow stays
  // usable without a scanner; the gap is still audited per upload.
  // Override explicitly with REQUIRE_UPLOAD_SCAN=true|false.
  uploadScanRequired: bool(
    process.env.REQUIRE_UPLOAD_SCAN,
    process.env.NODE_ENV === 'production'
  ),

  // --- signed URLs ---
  // Used to HMAC-sign short-lived file URLs. In production a
  // dedicated, sufficiently long random secret is REQUIRED and
  // must differ from the Supabase anon key (enforced at startup
  // - see startup.js checkEnv). In development, if SIGNED_URL_SECRET
  // is unset we fall back to SUPABASE_ANON_KEY so the flow stays
  // usable locally; startup.js only warns in that case.
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
  //  'none'            -> claim token is enough (single factor)
  //  'access-code'     -> owner sets a shared access code when creating
  //                       the grant (DEFAULT - two factors, matches the
  //                       frontend, which labels the code "recommended")
  //  'trusted-contact' -> (extension point) requires a separate trusted
  //                       contact confirmation; treated as access-code
  // The default is 'access-code'. 'none' is single-factor and is only
  // appropriate where the operator explicitly accepts that trade-off;
  // existing grants are never silently altered - a grant created
  // without a code simply cannot activate under 'access-code' until
  // the owner re-creates it with one (fail closed, explicit 403).
  legacyVerification: process.env.LEGACY_VERIFICATION || 'access-code',
  // Do legacy grants include uploaded files, or text content only?
  legacyIncludeFiles: bool(process.env.LEGACY_INCLUDE_FILES, true),
}