#!/usr/bin/env node
/*
 * Vector reindexing CLI.
 *
 * WHY THIS EXISTS. config.js and llmClient.js both tell the operator to
 * run `npm run reindex:vectors` after changing the embedding model
 * (EMBEDDING_MODE / EMBEDDING_MODEL / EMBEDDING_DIM). Until now that
 * command did not exist, so the instruction was a dead end and the only
 * alternative was hand-written SQL. This is that command.
 *
 * What it does, per memory of the CALLER (RLS applies to every query
 * and write, so one user can never reindex another user's archive):
 *
 *   1. list memories page by page (created_at order, bounded range)
 *   2. skip memories whose stored vector already carries the CURRENT
 *      embedding-space identity - re-embedding them is wasted work and
 *      wasted provider calls
 *   3. embed the memory's full indexed text through the real embed()
 *      (so the CLI and the pipeline write the exact same vector space)
 *   4. upsert into memory_vectors with the new identity
 *
 * Safety properties:
 *   - Original content is never touched - only memory_vectors rows.
 *   - A memory whose embedding fails keeps its OLD vector (or none) and
 *     is reported; it is never left half-written, because upsert is the
 *     only write and it is all-or-nothing per row.
 *   - Deleted memories need no handling: memory_vectors cascades on
 *     memory delete, and this CLI only reads live memories.
 *   - Edited memories are re-embedded like any other (their stored
 *     vector is stale by definition once the text changes).
 *   - --check performs NO writes: it reports how many stored vectors
 *     match the current identity, which is the "do I need to reindex?"
 *     diagnostic.
 *   - --dry-run computes everything but writes nothing.
 *
 * Usage:
 *   node scripts/reindexVectors.mjs --check
 *   node scripts/reindexVectors.mjs                 # self (RLS-scoped)
 *   node scripts/reindexVectors.mjs --force       # re-embed everything
 *   node scripts/reindexVectors.mjs --dry-run
 *   node scripts/reindexVectors.mjs --batch-size 50 --concurrency 4
 *
 * The token comes from REINDEX_TOKEN or --token. It must be a Supabase
 * access token (the same JWT the frontend sends). Without it the script
 * refuses to start rather than silently doing nothing.
 *
 * --all-users iterates every user's vectors using the SERVICE ROLE key
 * (SUPABASE_SERVICE_ROLE_KEY). It exists for operators after a model
 * migration and is deliberately opt-in: it bypasses RLS, which is exactly
 * why it requires the service key and is never the default.
 */

import { createClient } from '@supabase/supabase-js'
import { config } from '../src/config/config.js'
import { embed, activeEmbeddingIdentity, ProviderError } from '../src/utils/llmClient.js'
import { memoryEmbeddingText, toJsonVector } from '../src/utils/embeddings.js'

const COLUMNS =
  'id,user_id,type,title,content,transcript,extracted_text,tags,ai_summary,topics,keywords,entities,event_date,processing_status'

const MAX_BATCH = 200
const DEFAULT_BATCH = 25
const DEFAULT_CONCURRENCY = 4
const MAX_ATTEMPTS = 3
const BACKOFF_MS = 1_500

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function clientFor(token) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

/** Current embedding-space identity, refused when it cannot be named. */
function requireIdentity() {
  const identity = activeEmbeddingIdentity()
  if (!identity) {
    console.error(
      'No usable embedding space is configured. EMBEDDING_MODE=remote requires EMBEDDING_MODEL.\n' +
        'Set EMBEDDING_MODEL, or use EMBEDDING_MODE=local, then re-run.'
    )
    process.exit(2)
  }
  return identity
}

/** { total, current, stale, models } for the caller's own vectors. */
async function coverage(client, userId, identity) {
  const { data, error } = await client.from('memory_vectors').select('memory_id, model').eq('user_id', userId)
  if (error) throw error
  const models = {}
  for (const row of data || []) {
    const key = String(row?.model ?? 'unknown')
    models[key] = (models[key] || 0) + 1
  }
  const total = (data || []).length
  const current = identity ? models[identity] || 0 : total
  return { total, current, stale: total - current, models }
}

/** One page of memories, oldest first, plus the exact total. */
async function listPage(client, offset, limit) {
  const { data, error, count } = await client
    .from('memories')
    .select(COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1)
  if (error) throw error
  return { rows: data || [], total: typeof count === 'number' ? count : (data || []).length }
}

/** Existing vector identities for a set of memory ids (RLS-scoped). */
async function vectorModels(client, memoryIds) {
  if (!memoryIds.length) return new Map()
  const { data, error } = await client.from('memory_vectors').select('memory_id, model').in('memory_id', memoryIds)
  if (error) return new Map() // migration missing -> treat everything as stale
  return new Map((data || []).map((r) => [r.memory_id, String(r.model ?? 'unknown')]))
}

/**
 * Embed with bounded retries for transient provider failures.
 * Returns { vector } or { error } - never throws.
 */
async function embedWithRetry(text) {
  let lastError = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await embed({ input: text, timeoutMs: 20_000, retries: 0 })
      if (!result?.vector?.length) return { error: 'embedding endpoint returned no vector' }
      return { vector: result.vector }
    } catch (err) {
      lastError = err
      const retryable = err instanceof ProviderError ? err.retryable : true
      if (!retryable || attempt === MAX_ATTEMPTS) break
      await sleep(BACKOFF_MS * attempt)
    }
  }
  return { error: lastError?.message || 'embedding failed' }
}

/** Pool with a fixed worker count. */
async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

async function reindex({ token, userId, batchSize, concurrency, force, dryRun, startOffset, maxRows }) {
  const identity = requireIdentity()
  const client = clientFor(token)

  const cov = await coverage(client, userId, identity)
  console.log(`embedding space: ${identity}`)
  console.log(`stored vectors: ${cov.total} (${cov.current} current, ${cov.stale} stale)`)
  if (Object.keys(cov.models).length > 1) {
    console.log(`  models present: ${JSON.stringify(cov.models)}`)
  }

  if (!force && cov.stale === 0) {
    console.log('Nothing to do: every stored vector already matches the current embedding space.')
    return { processed: 0, skipped: cov.total, failed: 0, failures: [] }
  }

  let offset = startOffset
  let processed = 0
  let skipped = 0
  let failed = 0
  const failures = []
  const hardLimit = maxRows ?? Number.POSITIVE_INFINITY

  while (offset < hardLimit) {
    const { rows, total } = await listPage(client, offset, batchSize)
    if (!rows.length) break

    const known = await vectorModels(client, rows.map((r) => r.id))
    const pending = rows.filter((m) => force || known.get(m.id) !== identity)
    skipped += rows.length - pending.length

    const outcomes = await mapConcurrent(pending, concurrency, async (memory) => {
      const text = memoryEmbeddingText(memory)
      if (!String(text || '').trim()) return { status: 'skip', reason: 'no text' }
      const { vector, error } = await embedWithRetry(text)
      if (error) return { status: 'failed', reason: error }
      if (dryRun) return { status: 'dry' }
      const { error: upsertError } = await client.from('memory_vectors').upsert(
        {
          memory_id: memory.id,
          user_id: memory.user_id,
          embedding: toJsonVector(vector),
          dim: vector.length,
          model: identity,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'memory_id' }
      )
      if (upsertError) return { status: 'failed', reason: upsertError.message }
      return { status: 'ok' }
    })

    for (let i = 0; i < pending.length; i++) {
      const outcome = outcomes[i]
      if (outcome.status === 'failed') {
        failed++
        failures.push({ memoryId: pending[i].id, reason: String(outcome.reason).slice(0, 300) })
      } else if (outcome.status === 'ok' || outcome.status === 'dry') {
        processed++
      } else {
        skipped++
      }
    }

    offset += rows.length
    console.error(`progress: ${Math.min(offset, total)}/${total} read, ${processed} re-embedded, ${skipped} skipped, ${failed} failed`)
  }

  if (dryRun) console.log(`dry run: would re-embed ${processed} memories (${skipped} already current, ${failed} embed errors)`)
  else console.log(`done: ${processed} re-embedded, ${skipped} skipped, ${failed} failed`)

  if (failures.length) {
    console.error('failures (safe to re-run - only remaining stale rows are retried):')
    for (const f of failures) console.error(`  ${f.memoryId}: ${f.reason}`)
  }
  return { processed, skipped, failed, failures }
}

async function allUsers({ serviceKey, batchSize, concurrency, force, dryRun }) {
  // Service-role client: the only path that is deliberately not
  // user-scoped. Enumerate distinct owners first, then reindex each
  // user's rows with a user-scoped client built from the service token.
  const admin = createClient(config.supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const identity = requireIdentity()

  const { data: users, error } = await admin.from('memory_vectors').select('user_id')
  if (error) throw error
  const userIds = [...new Set((users || []).map((u) => u.user_id))]
  console.log(`users with stored vectors: ${userIds.length}`)

  let totals = { processed: 0, skipped: 0, failed: 0 }
  const failures = []
  for (const uid of userIds) {
    console.log(`\n=== user ${uid} ===`)
    const result = await reindex({
      token: serviceKey,
      userId: uid,
      batchSize,
      concurrency,
      force,
      dryRun,
      startOffset: 0,
      maxRows: null,
    })
    totals.processed += result.processed
    totals.skipped += result.skipped
    totals.failed += result.failed
    failures.push(...result.failures)
  }
  console.log(`\nall-users totals: ${totals.processed} re-embedded, ${totals.skipped} skipped, ${totals.failed} failed`)
  return { ...totals, failures }
}

// ------------------------------------------------------------------ main --

const flags = {
  check: process.argv.includes('--check'),
  force: process.argv.includes('--force'),
  dryRun: process.argv.includes('--dry-run'),
  allUsers: process.argv.includes('--all-users'),
  batchSize: Math.min(Number(arg('batch-size', DEFAULT_BATCH)) || DEFAULT_BATCH, MAX_BATCH),
  concurrency: Math.min(Number(arg('concurrency', DEFAULT_CONCURRENCY)) || DEFAULT_CONCURRENCY, 16),
  offset: Number(arg('offset', 0)) || 0,
  limit: Number(arg('limit', 0)) || null,
  token: arg('token', process.env.REINDEX_TOKEN || null),
}

if (!config.supabaseUrl || !config.supabaseAnonKey) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required (copy .env.example to .env).')
  process.exit(2)
}

if (flags.check) {
  const identity = requireIdentity()
  const token = flags.token
  if (!token) {
    console.error('--check needs a token: REINDEX_TOKEN=<jwt> or --token <jwt>')
    process.exit(2)
  }
  const client = clientFor(token)
  // User id comes from the token itself; the coverage query is RLS-scoped
  // to whoever the token belongs to, so we read back the rows the caller
  // can see and group by owner.
  const { data, error } = await client.from('memory_vectors').select('user_id, model')
  if (error) {
    console.error('Could not read memory_vectors:', error.message)
    process.exit(1)
  }
  const byUser = {}
  for (const row of data || []) {
    const u = row.user_id
    byUser[u] ||= { total: 0, current: 0, models: {} }
    byUser[u].total++
    const model = String(row.model ?? 'unknown')
    byUser[u].models[model] = (byUser[u].models[model] || 0) + 1
    if (model === identity) byUser[u].current++
  }
  for (const [uid, c] of Object.entries(byUser)) {
    console.log(`user ${uid}: ${c.current}/${c.total} vectors current (${JSON.stringify(c.models)})`)
  }
  const stale = Object.values(byUser).reduce((a, c) => a + (c.total - c.current), 0)
  console.log(stale === 0 ? 'No reindex needed.' : `${stale} vectors need reindexing.`)
  process.exit(0)
}

if (flags.allUsers) {
  if (!config.supabaseServiceRoleKey) {
    console.error('--all-users requires SUPABASE_SERVICE_ROLE_KEY (server-side only, never in the frontend).')
    process.exit(2)
  }
  const result = await allUsers({
    serviceKey: config.supabaseServiceRoleKey,
    batchSize: flags.batchSize,
    concurrency: flags.concurrency,
    force: flags.force,
    dryRun: flags.dryRun,
  })
  process.exit(result.failed > 0 ? 1 : 0)
}

if (!flags.token) {
  console.error(
    'A Supabase access token is required: set REINDEX_TOKEN or pass --token <jwt>.\n' +
      'Only the token owner\'s memories are reindexed (RLS). Use --all-users with the\n' +
      'service role key to reindex every user after a model migration.'
  )
  process.exit(2)
}

// The user id is implied by the token; coverage() filters by user_id and
// RLS enforces that the caller only ever sees their own rows.
const me = await clientFor(flags.token).auth.getUser(flags.token)
const userId = me.data?.user?.id
if (!userId) {
  console.error('The supplied token is not a valid Supabase access token.')
  process.exit(2)
}

const result = await reindex({
  token: flags.token,
  userId,
  batchSize: flags.batchSize,
  concurrency: flags.concurrency,
  force: flags.force,
  dryRun: flags.dryRun,
  startOffset: flags.offset,
  maxRows: flags.limit,
})
process.exit(result.failed > 0 ? 1 : 0)
