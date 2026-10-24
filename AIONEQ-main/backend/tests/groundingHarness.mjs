/*
 * Grounding test harness - shared by tests/grounding.test.mjs and
 * eval/groundingEval.mjs.
 *
 * WHY THIS EXISTS. The Ask flow (src/controllers/query.controller.js)
 * is the security and trust boundary of the product: it decides what
 * the model may see, what it may cite, and what it must admit it
 * does not know. Everything before it (retrieval, context building,
 * citation extraction) is covered by unit tests, and the pure
 * functions are covered by memoryContext.test.mjs - but nothing
 * proved the CONTROLLER wiring: that the settings the user toggled
 * are actually enforced, that another user's memory never reaches
 * the prompt, and that a citation the model invents is dropped.
 *
 * This harness drives the REAL controller end to end with two
 * stand-ins:
 *
 *   1. A stub local-AI HTTP server. It is deterministic and dumb on
 *      purpose: it cites every memory id it finds in the prompt,
 *      and emits exactly ONE hallucinated citation to a random id.
 *      That makes the citation filter observable - if the filter
 *      regresses, the hallucinated id appears in the response.
 *      It also records the last (system, user) prompt it was sent,
 *      so tests can assert on what the model was actually told.
 *
 *   2. A multi-table fake of the Supabase client with RLS
 *      semantics: a client built from a token only ever sees that
 *      token owner's rows, and every query is recorded so a test
 *      can prove a table was NEVER touched.
 *
 * HONEST LIMITATION: the stub is not a language model. What this
 * harness validates is the CONTRACT the answer is produced under -
 * grounding, citation filtering, privacy gating, prompt isolation -
 * not the fluency of a real model's prose. Measuring whether a real
 * model's prose is supported by the excerpts needs a live model and
 * is reported separately (see the grounding eval report).
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { ftsQueryTerms, ftsMatches } from '../eval/fakeSupabase.js'

// ------------------------------------------------------------- environment --
// Set BEFORE anything that imports src/config/config.js. Every value the
// controller reads at import time is fixed here so the harness, not the
// machine's .env, decides the configuration under test.
process.env.SUPABASE_URL = 'http://grounding-harness.invalid'
process.env.SUPABASE_ANON_KEY = 'grounding-harness-anon-key'
process.env.LOCAL_AI_BASE_URL = 'http://127.0.0.1:1' // replaced once the stub server listens
process.env.LOCAL_AI_MODEL = 'grounding-stub-model'
process.env.LOCAL_AI_COMPACT_PROMPT = 'false'
process.env.EMBEDDING_MODE = 'local'
process.env.EMBEDDING_DIM = '384'
process.env.MEMORY_PIPELINE_ENABLED = 'false'
process.env.LOCAL_ENRICH_MEMORIES = 'false'
process.env.AUDIT_ENABLED = 'false'
process.env.CONTEXT_DEBUG = 'false'
// Pinned OFF so a developer's local .env cannot weaken the grounding suite: the
// "no relevant memory -> never call the model" guarantee is what these tests
// exist to prove, and broad recall deliberately calls it in some cases.
// tests/broadRecall.test.mjs flips config.aiBroadRecallEnabled explicitly.
process.env.AI_BROAD_RECALL = 'false'
process.env.NODE_ENV = 'test'

// ------------------------------------------------------------- the stub LLM --
/**
 * What the stub model does with a prompt. Replaceable so a test can
 * make the model misbehave (e.g. cite an id it was never given).
 * Receives { system, user } and must return the raw answer string.
 */
export let stubBehavior = defaultStubBehavior

export function setStubBehavior(fn) {
  stubBehavior = fn || defaultStubBehavior
}

/** The last prompt the stub was sent, and how many calls happened. */
export const stubLLM = {
  calls: 0,
  lastSystem: null,
  lastUser: null,
  history: [],
  reset() {
    this.calls = 0
    this.lastSystem = null
    this.lastUser = null
    this.history = []
  },
}

/**
 * The default stub: cite every memory id present in the user turn
 * (those are the ids the controller supplied), then deliberately
 * hallucinate ONE citation to a random id. The citation filter in
 * extractCitedIds must drop that last one - that is the regression
 * this harness exists to catch.
 */
function defaultStubBehavior({ user }) {
  const supplied = [...new Set([...String(user).matchAll(/\bid: ([0-9a-fA-F-]{36})/g)].map((m) => m[1].toLowerCase()))]
  const lines = supplied.map((id) => `what your note says (cite: ${id})`)
  const hallucinated = crypto.randomUUID()
  lines.push(`an invented personal detail (cite: ${hallucinated})`)
  return [
    lines.join(' '),
    '---FOLLOW-UPS---',
    '1) What else should I know?',
    '2) Can you tell me more?',
    '3) Any other details?',
  ].join('\n')
}

let stubServer = null

async function startStubLLM() {
  if (stubServer) return stubServer
  stubServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        payload = {}
      }
      const isChat = String(req.url || '').includes('/chat/completions')
      const system = isChat
        ? String(payload.messages?.find((m) => m.role === 'system')?.content || '')
        : String(payload.prompt || '')
      const user = isChat
        ? String(payload.messages?.find((m) => m.role === 'user')?.content || '')
        : ''
      stubLLM.calls++
      stubLLM.lastSystem = system
      stubLLM.lastUser = user
      stubLLM.history.push({ system, user })

      let answer = ''
      try {
        answer = stubBehavior({ system, user })
      } catch {
        answer = ''
      }
      const completion = isChat
        ? { choices: [{ message: { content: answer } }] }
        : { choices: [{ text: answer }] }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(completion))
    })
  })
  await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  process.env.LOCAL_AI_BASE_URL = `http://127.0.0.1:${stubServer.address().port}`
  return stubServer
}

// ------------------------------------------------------------- the fake store --
/** token -> userId. Unknown tokens are "anonymous" and see nothing. */
const TOKEN_OWNERS = new Map()

export function registerUser(userId, token = `token-${userId}`) {
  TOKEN_OWNERS.set(token, userId)
  return token
}

export function tokenFor(userId) {
  return `token-${userId}`
}

/** Tables the fake store holds. Rows are plain objects. */
export const store = {
  memories: [],
  memory_vectors: [],
  memory_settings: [],
  memory_links: [],
  conversations: [],
  legacy_grants: [],
  /** Fault injection: { tableName: Error } - the next resolve() on that table fails. */
  failOn: {},
  /** Every query ever issued: { table, op, userId, detail }. */
  queries: [],
  reset() {
    this.memories = []
    this.memory_vectors = []
    this.memory_settings = []
    this.memory_links = []
    this.conversations = []
    this.legacy_grants = []
    this.failOn = {}
    this.queries = []
  },
}

function record(userId, table, op, detail = '') {
  store.queries.push({ userId, table, op, detail })
}

function ownerOf(client) {
  return client.__userId || 'anonymous'
}

/** Minimal PostgREST-like filter for .or() on the memory_links path. */
function parseOrFilter(str) {
  const parts = String(str || '').split(',')
  return parts
    .map((p) => {
      const m = p.match(/^([a-z_]+)\.in\.\((.*)\)$/)
      return m ? { col: m[1], values: m[2].split(',').map((v) => v.trim()) } : null
    })
    .filter(Boolean)
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

class FakeQuery {
  constructor(client, table) {
    this.client = client
    this.table = table
    this.columns = null
    this.filters = []
    this.orFilters = []
    this.textSearchQuery = null
    this.orderBy = null
    this.limitCount = null
    this.range = null
    this.mutating = null
  }

  select(columns) {
    this.columns = columns
    return this
  }

  eq(col, val) {
    this.filters.push((row) => row[col] === val)
    return this
  }

  or(str) {
    const parsed = parseOrFilter(str)
    if (parsed.length) {
      this.orFilters.push((row) => parsed.some((p) => p.values.includes(String(row[p.col]))))
    }
    return this
  }

  in(col, values) {
    const set = new Set(values)
    this.filters.push((row) => set.has(row[col]))
    return this
  }

  textSearch(_col, query) {
    this.textSearchQuery = query
    return this
  }

  order(col, { ascending = false } = {}) {
    this.orderBy = { col, ascending }
    return this
  }

  limit(n) {
    this.limitCount = n
    return this
  }

  range(from, to) {
    this.range = [from, to]
    return this
  }

  insert(payload) {
    this.mutating = { kind: 'insert', payload: Array.isArray(payload) ? payload : [payload] }
    return this
  }

  upsert(payload, opts = {}) {
    this.mutating = { kind: 'upsert', payload: Array.isArray(payload) ? payload : [payload], onConflict: opts.onConflict }
    return this
  }

  update(payload) {
    this.mutating = { kind: 'update', payload }
    return this
  }

  delete() {
    this.mutating = { kind: 'delete' }
    return this
  }

  maybeSingle() {
    this.singleRow = true
    this.maybe = true
    return this
  }

  single() {
    this.singleRow = true
    this.maybe = false
    return this
  }

  /**
   * RLS: only the caller's own rows are ever visible. legacy_grants
   * is keyed by owner_id / recipient_user_id rather than user_id,
   * mirroring the real policies in sql/security.sql.
   */
  visibleRows() {
    const userId = ownerOf(this.client)
    const rows = store[this.table]
    if (this.table === 'legacy_grants') {
      return rows.filter((row) => row.owner_id === userId || row.recipient_user_id === userId)
    }
    return rows.filter((row) => row.user_id === userId)
  }

  project(row) {
    if (!this.columns || this.columns === '*') return { ...row }
    const wanted = this.columns.split(',').map((c) => c.trim())
    const out = {}
    for (const c of wanted) if (c in row) out[c] = row[c]
    return out
  }

  resolve() {
    const userId = ownerOf(this.client)
    record(userId, this.table, this.mutating?.kind || 'select', this.textSearchQuery || '')

    // Fault injection: a test can make a table fail to model a
    // database outage and prove callers handle it.
    const fault = store.failOn?.[this.table]
    if (fault) throw fault

    // ---- writes ------------------------------------------------------
    if (this.mutating) {
      const { kind, payload } = this.mutating
      if (kind === 'insert') {
        const rows = payload.map((p) => {
          const row = {
            ...p,
            id: p.id || crypto.randomUUID(),
            created_at: p.created_at || new Date().toISOString(),
            updated_at: p.updated_at || new Date().toISOString(),
          }
          store[this.table].push(row)
          return row
        })
        return { data: this.singleRow ? rows[0] || null : rows, error: null, count: rows.length }
      }
      if (kind === 'upsert') {
        const conflictKey = (this.mutating.onConflict || '').split(',')[0]
        const rows = payload.map((p) => {
          const existing = store[this.table].find(
            (r) => r.user_id === userId && (!conflictKey || r[conflictKey] === p[conflictKey])
          )
          if (existing) Object.assign(existing, p, { updated_at: new Date().toISOString() })
          else {
            const row = { ...p, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
            store[this.table].push(row)
            return row
          }
          return existing
        })
        return { data: this.singleRow ? rows[0] || null : rows, error: null, count: rows.length }
      }
      if (kind === 'update') {
        const rows = this.visibleRows().filter(this.applyFilters())
        for (const row of rows) Object.assign(row, payload, { updated_at: new Date().toISOString() })
        return { data: this.singleRow ? rows[0] || null : rows, error: null, count: rows.length }
      }
      if (kind === 'delete') {
        const doomed = this.visibleRows().filter(this.applyFilters())
        store[this.table] = store[this.table].filter((r) => !doomed.includes(r))
        return { data: this.singleRow ? doomed[0] || null : doomed, error: null, count: doomed.length }
      }
    }

    // ---- reads -------------------------------------------------------
    let rows = this.visibleRows()
    for (const f of this.filters) rows = rows.filter(f)
    for (const f of this.orFilters) rows = rows.filter(f)
    if (this.textSearchQuery) {
      const terms = ftsQueryTerms(this.textSearchQuery)
      rows = rows.filter((row) => ftsMatches(row, terms))
      const rank = (row) => {
        const terms2 = terms
        const doc = new Set(
          [row.title, row.content, row.transcript, row.extracted_text, row.ai_summary]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .split(/\s+/)
        )
        let hit = 0
        for (const t of terms2) if (doc.has(t)) hit++
        return hit / Math.max(1, terms2.length)
      }
      rows = [...rows].sort((a, b) => rank(b) - rank(a))
    }
    if (this.orderBy) {
      const { col, ascending } = this.orderBy
      rows = [...rows].sort((a, b) => {
        const av = String(a[col] ?? '')
        const bv = String(b[col] ?? '')
        return ascending ? av.localeCompare(bv) : bv.localeCompare(av)
      })
    }
    if (this.range) rows = rows.slice(this.range[0], this.range[1] + 1)
    else if (this.limitCount != null) rows = rows.slice(0, this.limitCount)

    const data = rows.map((r) => this.project(r))
    if (globalThis.__GROUNDING_DEBUG__ && !this.__debugged) {
      this.__debugged = true
      console.error('[resolve]', this.table, 'singleRow=', this.singleRow, 'rows=', rows.length, 'mutating=', this.mutating?.kind)
    }
    if (this.singleRow) {
      // maybeSingle() on an empty result is a clean null (no error),
      // matching PostgREST; single() surfaces PGRST116.
      const emptyError = this.maybe ? null : { code: 'PGRST116' }
      return { data: data[0] || null, error: data.length ? null : emptyError, count: data.length }
    }
    return { data, error: null, count: data.length }
  }

  applyFilters() {
    return (row) => this.filters.every((f) => f(row)) && this.orFilters.every((f) => f(row))
  }

  then(resolve, reject) {
    let result
    try {
      result = this.resolve()
    } catch (err) {
      result = { data: null, error: err }
    }
    return Promise.resolve(result).then(resolve, reject)
  }
}

class FakeClient {
  constructor(userId) {
    this.__userId = userId
    // Stands in for the service-role admin API: records the
    // deletion attempt instead of touching a real auth backend.
    this.auth = {
      admin: {
        deleteUser: (id) => {
          record('service-role', 'auth.users', 'admin.deleteUser', id)
          return Promise.resolve({ data: { id }, error: null })
        },
      },
    }
  }
  from(table) {
    if (!(table in store)) throw new Error(`grounding harness: unknown table "${table}"`)
    return new FakeQuery(this, table)
  }
  rpc(name, args) {
    const userId = ownerOf(this)
    record(userId, 'rpc', name, '')
    if (name !== 'match_memory_vectors') {
      return Promise.resolve({ data: [], error: null })
    }
    // Mirrors sql/memory_intelligence.sql: RLS (caller's rows only),
    // same user as p_user_id, same dim, same embedding-space model.
    const qDim = Array.isArray(args.p_query) ? args.p_query.length : 0
    const scored = store.memory_vectors
      .filter(
        (v) =>
          v.user_id === userId &&
          v.user_id === args.p_user_id &&
          v.dim === qDim &&
          (args.p_model == null || v.model === args.p_model)
      )
      .map((v) => ({ memory_id: v.memory_id, similarity: Number(cosine(args.p_query, v.embedding).toFixed(6)) }))
      .filter((r) => r.similarity >= (args.p_min_similarity ?? 0))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, Math.min(Math.max(args.p_limit ?? 12, 1), 100))
    return Promise.resolve({ data: scored, error: null })
  }
}

// ------------------------------------------------------------- bootstrap ----
let bootstrapped = null

/**
 * Sets up the harness exactly once per process: starts the stub LLM,
 * installs the module mock, and loads the real controller.
 *
 * MUST be called (and awaited) before any src/ module is imported -
 * the mock has to be in place before query.controller.js pulls in the
 * real @supabase/supabase-js.
 */
export async function bootstrap() {
  if (bootstrapped) return bootstrapped

  await startStubLLM()

  const { mock } = await import('node:test')
  await mock.module('@supabase/supabase-js', {
    namedExports: {
      createClient: (_url, _key, opts) => {
        const header = opts?.global?.headers?.Authorization || ''
        const token = header.startsWith('Bearer ') ? header.slice(7) : null
        return new FakeClient(token ? TOKEN_OWNERS.get(token) || 'anonymous' : 'anonymous')
      },
    },
  })

  // Dynamic imports AFTER the mock is installed.
  const controller = await import('../src/controllers/query.controller.js')
  const memoryController = await import('../src/controllers/memory.controller.js')
  const accountController = await import('../src/controllers/account.controller.js')

  bootstrapped = { controller, memoryController, accountController }
  return bootstrapped
}

/** A minimal Express-shaped request. */
export function fakeReq({ userId, body = {}, params = {}, query = {} }) {
  return {
    user: { id: userId },
    accessToken: tokenFor(userId),
    body,
    params,
    query,
    ip: '127.0.0.1',
    headers: {},
    id: crypto.randomUUID(),
  }
}

/** A minimal Express-shaped response that captures the JSON body. */
export function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code
      return res
    },
    json(payload) {
      res.body = payload
      return res
    },
  }
  return res
}

/**
 * Runs the real askQuestion controller for one question.
 *
 * @returns {Promise<{status:number, body:object, prompt:{system:string,user:string},
 *   llmCalls:number, queries:Array}>}
 */
export async function runAsk({ userId, question, settings, conversationId, memoryTypes }) {
  const { controller } = await bootstrap()

  if (settings) {
    store.memory_settings = store.memory_settings.filter((s) => s.user_id !== userId)
    store.memory_settings.push({
      user_id: userId,
      memory_ai_enabled: settings.memoryAiEnabled ?? true,
      conversation_memory_enabled: settings.conversationMemoryEnabled ?? true,
      processing_enabled: settings.processingEnabled ?? true,
      updated_at: new Date().toISOString(),
    })
  }

  const queriesBefore = store.queries.length
  const callsBefore = stubLLM.calls
  stubLLM.lastSystem = null
  stubLLM.lastUser = null

  const req = fakeReq({
    userId,
    body: { question, ...(conversationId ? { conversationId } : {}), ...(memoryTypes ? { memoryTypes } : {}) },
  })
  const res = fakeRes()
  let nextErr = null
  await controller.askQuestion(req, res, (err) => {
    nextErr = err
  })

  return {
    status: res.statusCode,
    body: res.body,
    prompt: { system: stubLLM.lastSystem, user: stubLLM.lastUser },
    llmCalls: stubLLM.calls - callsBefore,
    queries: store.queries.slice(queriesBefore),
    nextErr,
  }
}

/** Convenience: the ids of memories used to ground an answer. */
export function usedIds(result) {
  return (result.body?.usedMemories || []).map((m) => m.memoryId)
}

/** Convenience: the ids the answer actually cited. */
export function citedIds(result) {
  return (result.body?.citedMemories || []).map((m) => m.memoryId)
}

export function stopStubLLM() {
  return stubServer ? new Promise((resolve) => stubServer.close(resolve)) : Promise.resolve()
}
