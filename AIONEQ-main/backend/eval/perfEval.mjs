/*
 * Performance & reliability measurement - Phase 8.
 *
 *   node eval/perfEval.mjs           # human report
 *   node eval/perfEval.mjs --json     # machine-readable
 *
 * Everything here is MEASURED, not estimated. Each measurement
 * names what it includes and what it excludes.
 *
 *   retrievalLatency   retrieveMemories() over the eval corpus,
 *                      per strategy. Excludes the LLM.
 *   askLatency         the full ask controller with a stub
 *                      model that answers instantly, so it
 *                      measures everything EXCEPT model
 *                      inference (retrieval + context build +
 *                      citation extraction + store round trips).
 *   contextBuild       buildContext() alone, on the largest
 *                      prompt the corpus produces.
 *   largeMemory        a memory at the 20k-character pipeline
 *                      ceiling, to measure excerpt truncation
 *                      and candidate scoring under large text.
 *   concurrency        24 parallel asks, to expose contention
 *                      or serialisation in the controller path.
 *
 * The local vectorizer is pure in-process JS, so these numbers
 * describe the retrieval pipeline itself. A live model's
 * inference time dominates real ask latency and is listed as a
 * production prerequisite, not measured here.
 */

// Config-free modules only, imported statically. The services that
// read src/config/config.js (memoryRetrieval, memoryContext) are
// imported DYNAMICALLY inside main(), after bootstrap(): config.js
// captures LOCAL_AI_BASE_URL at import time, and the stub server's
// port is only known once it listens. A static import here would
// capture the machine's .env URL and every ask-path measurement
// would measure connection failures instead of the pipeline.
import { MEMORIES, PRIMARY_USER_ID } from './dataset.memories.js'
import { QUESTIONS } from './dataset.questions.js'
import { memoryEmbeddingText, embedLocal, toJsonVector } from '../src/utils/embeddings.js'
import { createFakeSupabase } from './fakeSupabase.js'
import {
  bootstrap,
  store,
  registerUser,
  runAsk,
  setStubBehavior,
  stopStubLLM,
} from '../tests/groundingHarness.mjs'

// ---------------------------------------------------------------- helpers --
function percentiles(values, ps = [0.5, 0.95, 0.99]) {
  const sorted = [...values].sort((a, b) => a - b)
  const out = {}
  for (const p of ps) {
    const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
    out[`p${Math.round(p * 100)}`] = Math.round(sorted[idx] * 100) / 100
  }
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  out.mean = Math.round(mean * 100) / 100
  out.max = Math.round(sorted[sorted.length - 1] * 100) / 100
  return out
}

function hrTimeNs() {
  const [s, ns] = process.hrtime()
  return s * 1e9 + ns
}

// ------------------------------------------------------------------- main --
async function main() {
  registerUser(PRIMARY_USER_ID)
  await bootstrap()
  setStubBehavior(() => 'Stub answer.\n---FOLLOW-UPS---\n1) What else?\n2) More?\n3) Details?')

  // Loaded after bootstrap() so config.js sees the stub server's
  // port as LOCAL_AI_BASE_URL (see the import note above).
  const { retrieveMemories } = await import('../src/services/memoryRetrieval.js')
  const { buildContext, extractCitedIds } = await import('../src/services/memoryContext.js')

  // Build the vector index exactly as the pipeline would.
  const vectors = []
  for (const m of MEMORIES) {
    const text = memoryEmbeddingText(m)
    const vector = embedLocal(text, 384)
    vectors.push({
      memory_id: m.id,
      user_id: m.user_id,
      embedding: toJsonVector(vector),
      dim: vector.length,
      model: 'local-hash-v1@384',
      updated_at: m.updated_at,
    })
  }
  const client = createFakeSupabase({ userId: PRIMARY_USER_ID, memories: MEMORIES, vectors })

  const report = {}

  // ------------------------------------------------ 1. retrieval latency --
  // Warm-up (JIT), then measure. Each question is run REPEAT times
  // against a fresh client view of the same corpus.
  const REPEAT = 5
  for (const strategy of ['lexical', 'vector', 'hybrid']) {
    for (let i = 0; i < 3; i++) {
      await retrieveMemories(client, PRIMARY_USER_ID, QUESTIONS[0].question, { strategy })
    }
    const samples = []
    for (const item of QUESTIONS) {
      for (let r = 0; r < REPEAT; r++) {
        const t0 = hrTimeNs()
        await retrieveMemories(client, PRIMARY_USER_ID, item.question, { strategy })
        samples.push((hrTimeNs() - t0) / 1e6) // ms
      }
    }
    report[`retrieval_${strategy}_ms`] = percentiles(samples)
  }

  // ------------------------------------------------ 2. embedding latency --
  // What it costs to vectorize a question and a memory (the per-save
  // and per-ask vector cost).
  const question = QUESTIONS[1].question
  const longestMemory = [...MEMORIES].sort(
    (a, b) => memoryEmbeddingText(b).length - memoryEmbeddingText(a).length
  )[0]
  const embedSamples = []
  for (let i = 0; i < 200; i++) {
    const t0 = hrTimeNs()
    embedLocal(memoryEmbeddingText(longestMemory), 384)
    embedSamples.push((hrTimeNs() - t0) / 1e6)
  }
  report.embed_longest_memory_ms = percentiles(embedSamples, [0.5, 0.95])
  report.longest_memory_chars = memoryEmbeddingText(longestMemory).length

  // ------------------------------------------------ 3. full ask latency --
  store.reset()
  for (const row of MEMORIES) store.memories.push({ ...row })

  // Warm-up
  await runAsk({ userId: PRIMARY_USER_ID, question: QUESTIONS[0].question })

  const askSamples = []
  for (const item of QUESTIONS) {
    store.conversations = [] // fresh conversation state per question
    const t0 = hrTimeNs()
    await runAsk({ userId: PRIMARY_USER_ID, question: item.question })
    askSamples.push((hrTimeNs() - t0) / 1e6)
  }
  report.ask_full_ms = percentiles(askSamples)
  report.ask_note = 'includes retrieval, context build, citation extraction and store round trips; EXCLUDES model inference (stub answers instantly)'

  // ------------------------------------------- 4. large-memory handling --
  // A memory at the pipeline's 20k-character ceiling.
  const bigMemory = {
    id: '22222222-0000-4000-8000-000000000001',
    user_id: PRIMARY_USER_ID,
    type: 'document',
    title: 'Very long document',
    content: 'The quarterly review covered many topics. '.repeat(700), // ~20k chars
    transcript: '',
    extracted_text: '',
    tags: [],
    topics: [],
    keywords: [],
    entities: [],
    ai_summary: 'A long quarterly review.',
    event_date: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    processing_status: 'ready',
  }
  store.memories.push(bigMemory)
  const bigVector = embedLocal(memoryEmbeddingText(bigMemory), 384)
  vectors.push({
    memory_id: bigMemory.id,
    user_id: bigMemory.user_id,
    embedding: toJsonVector(bigVector),
    dim: bigVector.length,
    model: 'local-hash-v1@384',
    updated_at: bigMemory.updated_at,
  })
  const bigClient = createFakeSupabase({ userId: PRIMARY_USER_ID, memories: [...MEMORIES, bigMemory], vectors })

  const bigSamples = []
  for (let i = 0; i < 20; i++) {
    const t0 = hrTimeNs()
    await retrieveMemories(bigClient, PRIMARY_USER_ID, 'quarterly review topics')
    bigSamples.push((hrTimeNs() - t0) / 1e6)
  }
  report.retrieval_with_20k_memory_ms = percentiles(bigSamples, [0.5, 0.95])

  const built = buildContext('quarterly review topics', {
    memories: [
      {
        memoryId: bigMemory.id,
        type: 'document',
        eventDate: bigMemory.event_date,
        createdAt: bigMemory.created_at,
        snippet: bigMemory.content.slice(0, 500),
        topics: [],
      },
    ],
  })
  report.context_build_chars = built.length

  // ------------------------------------------------ 5. concurrency --
  // 24 parallel asks: measures whether the controller path
  // serialises or contends under concurrent load.
  store.conversations = []
  const CONCURRENCY = 24
  const warmup = Array.from({ length: CONCURRENCY }, (_, i) =>
    runAsk({ userId: PRIMARY_USER_ID, question: QUESTIONS[i % QUESTIONS.length].question })
  )
  await Promise.all(warmup)

  store.conversations = []
  const t0 = hrTimeNs()
  const concurrent = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      runAsk({ userId: PRIMARY_USER_ID, question: QUESTIONS[i % QUESTIONS.length].question })
    )
  )
  const concurrentTotalMs = (hrTimeNs() - t0) / 1e6
  const perAsk = concurrentTotalMs / CONCURRENCY
  const statusCounts = {}
  for (const r of concurrent) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1
  const firstFailure = concurrent.find((r) => r.status !== 200)
  report.concurrent_asks = {
    parallel: CONCURRENCY,
    total_ms: Math.round(concurrentTotalMs * 100) / 100,
    per_ask_ms: Math.round(perAsk * 100) / 100,
    status_counts: statusCounts,
    first_failure_body: firstFailure ? String(JSON.stringify(firstFailure.body)).slice(0, 300) : null,
  }

  // ------------------------------------------- 6. citation extraction --
  const citeSamples = []
  const fakeMemories = concurrent[0]?.body?.usedMemories?.map((m) => ({
    memoryId: m.memoryId,
    title: m.title,
    type: m.type,
    eventDate: m.eventDate,
    snippet: 'some excerpt text',
    topics: [],
  })) || []
  const sampleAnswer = fakeMemories.map((m) => `detail (cite: ${m.memoryId})`).join(' ')
  for (let i = 0; i < 500; i++) {
    const t1 = hrTimeNs()
    extractCitedIds(sampleAnswer, fakeMemories)
    citeSamples.push((hrTimeNs() - t1) / 1e6)
  }
  report.citation_extraction_ms = percentiles(citeSamples, [0.5, 0.95])

  await stopStubLLM()

  // ------------------------------------------------------------- report --
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  const fmt = (p) => `${p.mean} ms (p50 ${p.p50}, p95 ${p.p95 ?? '-'}, p99 ${p.p99 ?? '-'}, max ${p.max})`
  console.log('='.repeat(90))
  console.log('ECHO performance evaluation (all numbers MEASURED on this machine)')
  console.log('='.repeat(90))
  console.log('')
  console.log('RETRIEVAL LATENCY (retrieveMemories only, no LLM)')
  for (const s of ['lexical', 'vector', 'hybrid']) {
    console.log(`  ${s.padEnd(8)} ${fmt(report[`retrieval_${s}_ms`])}`)
  }
  console.log('')
  console.log('EMBEDDING (local vectorizer, pure JS)')
  console.log(`  longest memory in corpus : ${report.longest_memory_chars} chars`)
  console.log(`  embed that memory        : ${fmt(report.embed_longest_memory_ms)}`)
  console.log('')
  console.log('FULL ASK (everything except model inference)')
  console.log(`  ${fmt(report.ask_full_ms)}`)
  console.log(`  note: ${report.ask_note}`)
  console.log('')
  console.log('LARGE MEMORY (20k-char document in the corpus)')
  console.log(`  retrieval with it : ${fmt(report.retrieval_with_20k_memory_ms)}`)
  console.log(`  context build size: ${report.context_build_chars} chars (excerpt is bounded to 500)`)
  console.log('')
  console.log('CONCURRENCY')
  const c = report.concurrent_asks
  console.log(
    `  ${c.parallel} parallel asks: total ${c.total_ms} ms, per-ask ${c.per_ask_ms} ms`
  )
  console.log(`  status distribution: ${JSON.stringify(c.status_counts)}`)
  if (c.first_failure_body) console.log(`  first failure body: ${c.first_failure_body}`)
  console.log('')
  console.log('CITATION EXTRACTION')
  console.log(`  ${fmt(report.citation_extraction_ms)}`)
  console.log('')
  console.log('NOT MEASURED HERE (require a live provider): model inference time,')
  console.log('remote embedding latency, Postgres FTS/cosine cost on a real database.')
}

await main()
