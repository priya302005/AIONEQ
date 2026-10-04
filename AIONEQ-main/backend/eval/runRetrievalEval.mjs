/*
 * EchoMind retrieval evaluation runner.
 *
 *   node eval/runRetrievalEval.mjs            # all three strategies
 *   node eval/runRetrievalEval.mjs hybrid     # one strategy
 *   node eval/runRetrievalEval.mjs --k 10     # different cut-off
 *   node eval/runRetrievalEval.mjs --json     # machine-readable
 *
 * What it measures: the REAL production retrieval function
 * (src/services/memoryRetrieval.js retrieveMemories) driven against an in-memory
 * PostgREST/RLS stand-in. Nothing here re-implements retrieval; the only code
 * under test is the shipping code.
 *
 * It builds the corpus exactly the way the pipeline would, so the vectors being
 * searched are the vectors the pipeline writes: local-hash-v1, 384 dimensions.
 */

import { config } from '../src/config/config.js'
import { retrieveMemories } from '../src/services/memoryRetrieval.js'
import { memoryEmbeddingText, toJsonVector } from '../src/utils/embeddings.js'
import { embed, activeEmbeddingIdentity } from '../src/utils/llmClient.js'
import { createFakeSupabase } from './fakeSupabase.js'
import { MEMORIES, OTHER_USER_MEMORIES, PRIMARY_USER_ID } from './dataset.memories.js'
import { QUESTIONS, SCENARIOS } from './dataset.questions.js'
import { scoreQuestion, aggregate, K } from './metrics.js'

const OTHER_USER_IDS = [...new Set(OTHER_USER_MEMORIES.map((m) => m.user_id))]
const ALL_ROWS = [...MEMORIES, ...OTHER_USER_MEMORIES]

/**
 * The embedding-space identity the evaluation indexes under. Taken from the real
 * config rather than hardcoded, so the evaluation can never drift from what the
 * product would actually write to memory_vectors.model.
 */
export const VECTOR_MODEL = activeEmbeddingIdentity()

/**
 * Builds the vector table the way the pipeline's indexMemory() stage does.
 *
 * It goes through the REAL embed() rather than calling embedLocal directly, so
 * switching EMBEDDING_MODE to a remote provider re-indexes this evaluation too.
 * That is the only way the local-vs-remote quality difference can be measured
 * rather than assumed:
 *
 *   node eval/runRetrievalEval.mjs                              # local (default)
 *   EMBEDDING_MODE=remote EMBEDDING_MODEL=nomic-embed-text-v1.5 \
 *   EMBEDDING_DIM=768 node eval/runRetrievalEval.mjs            # remote
 *
 * The `model` written to each row is the identity returned by embed(), which is
 * exactly what the product stores, so the model filter in the harness stays in
 * step with sql/memory_intelligence.sql.
 */
export async function buildVectors(rows, { model } = {}) {
  const out = []
  for (const m of rows) {
    const text = memoryEmbeddingText(m)
    const result = await embed({ input: text })
    out.push({
      memory_id: m.id,
      user_id: m.user_id,
      embedding: toJsonVector(result?.vector ?? []),
      dim: result?.dim ?? 0,
      model: model ?? result?.model ?? null,
      updated_at: m.updated_at,
    })
  }
  return out
}

export async function runEval({
  strategy = 'hybrid',
  k = K,
  limit = config.retrievalMaxMemories,
  minScore,
  corpus = ALL_ROWS,
  questions = QUESTIONS,
} = {}) {
  const vectors = await buildVectors(corpus)
  const client = createFakeSupabase({ userId: PRIMARY_USER_ID, memories: corpus, vectors })

  const rows = []
  for (const item of questions) {
    const results = await retrieveMemories(client, PRIMARY_USER_ID, item.question, {
      strategy,
      limit,
      minScore,
    })
    rows.push(scoreQuestion(item, results, { k, otherUserIds: OTHER_USER_IDS }))
  }
  return { rows, summary: aggregate(rows, { k }), strategy, k, corpusSize: corpus.length }
}

// ------------------------------------------------------------------ report --

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)))
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n')
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`
}

export function formatReport(evals) {
  const out = []
  const overallRows = evals.map((e) => {
    const o = e.summary.overall
    return [
      e.strategy,
      pct(o.hitRate),
      pct(o.top1Accuracy),
      o.recallAtK.toFixed(3),
      o.mrr.toFixed(3),
      o.precisionAtK.toFixed(3),
      pct(o.falseMatchTop1),
      o.noAnswer === 0 ? 'n/a' : pct(o.noAnswerCorrect),
      pct(o.noAnswerDisjointOk),
      o.leakCount,
    ]
  })

  out.push('='.repeat(110))
  out.push(`ECHO retrieval evaluation   k=${evals[0].k}   corpus=${evals[0].corpusSize} memories   questions=${evals[0].rows.length}`)
  out.push(
    `embedding=${config.embeddingMode} dim=${config.embeddingDim} vectorWeight=${config.retrievalVectorWeight} ` +
      `minSim=${config.vectorMinSimilarity} maxMemories=${config.retrievalMaxMemories}`
  )
  out.push('='.repeat(110))
  out.push('')
  out.push('OVERALL  (answerable questions only, except the last three columns)')
  out.push('  hit@5        >=1 gold memory in the top 5')
  out.push('  top1         the FIRST result is gold - what gets cited first')
  out.push('  recall@5     fraction of all gold memories inside the top 5')
  out.push('  MRR          1/rank of first gold (0 if absent)')
  out.push('  prec@5       gold/top5 (ceiling is 1/|gold| by construction - read with top1)')
  out.push('  wrong-top1   the top result was NOT gold')
  out.push('  no-ans OK    no-answer questions where NOTHING was retrieved')
  out.push('  disjoint OK no-answer questions with no vocabulary overlap, retrieved nothing')
  out.push('  leaks        results owned by another user (must always be 0)')
  out.push('')
  out.push(
    table(overallRows, ['strategy', 'hit@5', 'top1', 'recall@5', 'MRR', 'prec@5', 'wrong-top1', 'no-ans OK', 'disjoint OK', 'leaks'])
  )
  out.push('')

  for (const e of evals) {
    out.push('-'.repeat(110))
    out.push(`BY SCENARIO - ${e.strategy}`)
    out.push('-'.repeat(110))
    const rows = SCENARIOS.filter((s) => e.summary.byScenario[s]).map((s) => {
      const v = e.summary.byScenario[s]
      return [
        s,
        v.n,
        pct(v.hitRate),
        pct(v.top1Accuracy),
        v.recallAtK.toFixed(3),
        v.mrr.toFixed(3),
        v.precisionAtK.toFixed(3),
        pct(v.falseMatchTop1),
        v.noAnswerCorrect == null ? 'n/a' : pct(v.noAnswerCorrect),
      ]
    })
    out.push(table(rows, ['scenario', 'n', 'hit@5', 'top1', 'recall@5', 'MRR', 'prec@5', 'wrong-top1', 'no-ans OK']))
    out.push('')
  }

  out.push('-'.repeat(110))
  out.push('BY LEXICAL-OVERLAP DIFFICULTY (answerable questions)')
  out.push('-'.repeat(110))
  const diffs = Object.keys(evals[0].summary.byDifficulty)
  const dRows = diffs.map((diff) => {
    const base = evals[0].summary.byDifficulty[diff]
    return [
      diff,
      String(base.n),
      ...evals.map((e) => {
        const x = e.summary.byDifficulty[diff]
        return x ? `${pct(x.hitRate)} / ${pct(x.top1Accuracy)} / ${x.mrr.toFixed(2)}` : ''
      }),
    ]
  })
  out.push(table(dRows, ['difficulty', 'n', ...evals.map((e) => `${e.strategy} hit/top1/MRR`)]))
  out.push('')

  return out.join('\n')
}

/** The questions each strategy got wrong, for root-cause analysis. */
export function failures(ev, { k = K } = {}) {
  return ev.rows
    .filter((r) => {
      if (r.scenario === 'no_answer') return r.noAnswerCorrect === 0
      return r.hit === 0 || r.falseMatch === 1
    })
    .map((r) => ({ ...r, k }))
}

// -------------------------------------------------------------------- main --

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())
if (isMain) {
  const argv = process.argv.slice(2)
  const kIdx = argv.indexOf('--k')
  const k = kIdx >= 0 ? Number(argv[kIdx + 1]) : K
  const wanted = argv.filter((a) => !a.startsWith('--') && a !== String(k))
  const strategies = wanted.length ? wanted : ['lexical', 'vector', 'hybrid']

  const evals = []
  for (const strategy of strategies) {
    evals.push(await runEval({ strategy, k }))
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(evals.map((e) => ({ strategy: e.strategy, ...e.summary })), null, 2))
  } else {
    console.log(formatReport(evals))
  }
  process.exit(0)
}
