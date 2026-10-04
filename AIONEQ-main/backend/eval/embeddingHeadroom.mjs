/*
 * Embedding headroom analysis.
 *
 *   node eval/embeddingHeadroom.mjs
 *
 * THE QUESTION: the evaluation shows the local hashed vectorizer is weakest on
 * questions with little or no word overlap (low-difficulty: hit@5 68.8%,
 * top-1 37.5%). Would swapping in a real semantic embedding model actually help,
 * or is the ceiling set by something else?
 *
 * THE HONEST ANSWER: this script cannot tell you how well any specific remote
 * model would do. Measuring that requires running that model, which needs a live
 * embedding endpoint. What it CAN do, without inventing anything, is measure the
 * ORACLE: what retrieval would score if the semantic signal were perfect.
 *
 *   - the "oracle-vector" arm replaces cosine with 1.0 for the gold memories and
 *     ~0 for everything else. It is not a model. It is the best case any
 *     embedding model could possibly deliver, and it bounds the benefit.
 *   - the "oracle-no-vector" arm removes the semantic signal entirely, showing
 *     what is achievable on word overlap alone.
 *
 * The gap between the real local vectorizer and the oracle is the maximum that a
 * better embedding model could possibly recover. If that gap is small, paying for
 * or hosting a real embedding model is not worth the operational cost. If it is
 * large on the low-overlap bucket specifically, it is.
 *
 * A real comparison, once an endpoint exists:
 *   EMBEDDING_MODE=remote EMBEDDING_MODEL=<name> EMBEDDING_DIM=<n> \
 *     node eval/runRetrievalEval.mjs
 */

import { config } from '../src/config/config.js'
import { retrieveMemories } from '../src/services/memoryRetrieval.js'
import { createFakeSupabase } from './fakeSupabase.js'
import { MEMORIES, PRIMARY_USER_ID } from './dataset.memories.js'
import { QUESTIONS } from './dataset.questions.js'
import { buildVectors } from './runRetrievalEval.mjs'
import { scoreQuestion, aggregate } from './metrics.js'

const vectors = await buildVectors(MEMORIES)
const client = createFakeSupabase({ userId: PRIMARY_USER_ID, memories: MEMORIES, vectors })

const pct = (n) => `${(n * 100).toFixed(1)}%`

async function measure(label, run) {
  const rows = []
  for (const item of QUESTIONS) {
    const results = await run(item)
    rows.push(scoreQuestion(item, results, { k: 5, otherUserIds: [] }))
  }
  const s = aggregate(rows, { k: 5 })
  return { label, overall: s.overall, byScenario: s.byScenario, byDifficulty: s.byDifficulty }
}

/** Replaces the stored vectors with an oracle that scores gold at 1.0. */
/**
 * An oracle vector index: similarity 1.0 for the gold memories, a low constant
 * for everything else.
 *
 * This intercepts the `match_memory_vectors` RESULT rather than rewriting stored
 * vectors. Rewriting the vectors does not work, and the first version of this
 * script proved why: retrieval embeds the QUESTION with the real vectorizer, so
 * swapping only the stored vectors leaves the query vector unmatched and the
 * "oracle" scores are just cosine against an arbitrary fixed direction - which
 * measured WORSE than the real vectorizer. The RPC result is the only layer
 * where "perfect semantics" can be injected without touching production code.
 */
function oracleClient(gold) {
  const goldSet = new Set(gold)
  const base = createFakeSupabase({ userId: PRIMARY_USER_ID, memories: MEMORIES, vectors })
  return {
    ...base,
    rpc(fn, args) {
      if (fn !== 'match_memory_vectors') return base.rpc(fn, args)
      const rows = MEMORIES.filter((m) => m.user_id === PRIMARY_USER_ID).map((m) => ({
        memory_id: m.id,
        similarity: goldSet.has(m.id) ? 1 : 0.02,
      }))
      const min = args.p_min_similarity ?? 0
      return Promise.resolve({
        data: rows
          .filter((r) => r.similarity >= min)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, Math.min(Math.max(args.p_limit ?? 12, 1), 100)),
        error: null,
      })
    },
  }
}

const arms = []
arms.push(await measure('hybrid (shipped, local vectorizer)', (item) =>
  retrieveMemories(client, PRIMARY_USER_ID, item.question, { strategy: 'hybrid' })
))
arms.push(
  await measure('hybrid, vector signal REMOVED', (item) =>
    retrieveMemories(client, PRIMARY_USER_ID, item.question, { strategy: 'lexical' })
  )
)
arms.push(
  await measure('hybrid, ORACLE semantic signal (upper bound)', (item) =>
    retrieveMemories(oracleClient(item.gold), PRIMARY_USER_ID, item.question, { strategy: 'hybrid' })
  )
)
console.log('='.repeat(96))
console.log('EMBEDDING HEADROOM')
console.log(`corpus=${MEMORIES.length} memories  questions=${QUESTIONS.length}  k=5  space=${config.embeddingDim}d`)
console.log('='.repeat(96))
console.log('')
console.log('The oracle row is NOT a model and NOT a prediction. It is the mathematical')
console.log('ceiling: what retrieval would score if the semantic signal were perfect.')
console.log('')

const rows = arms.map((a) => [
  a.label,
  a.overall.questions,
  pct(a.overall.hitRate),
  pct(a.overall.top1Accuracy),
  a.overall.recallAtK.toFixed(3),
  a.overall.mrr.toFixed(3),
])
console.log(rows[0][1] ? '' : '')
const w = [40, 4, 8, 8, 9, 7]
const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join(' ')
console.log(line(['arm', 'n', 'hit@5', 'top1', 'recall@5', 'MRR']))
console.log(w.map((x) => '-'.repeat(x)).join(' '))
for (const r of rows) console.log(line(r))

const local = arms[0].overall
const none = arms[1].overall
const oracle = arms[2].overall
console.log('')
console.log('RECOVERABLE HEADROOM (oracle minus shipped)')
console.log(`  hit@5    ${pct(local.hitRate)} -> ${pct(oracle.hitRate)}   max gain ${pct(oracle.hitRate - local.hitRate)}`)
console.log(`  top1     ${pct(local.top1Accuracy)} -> ${pct(oracle.top1Accuracy)}   max gain ${pct(oracle.top1Accuracy - local.top1Accuracy)}`)
console.log(`  MRR      ${local.mrr.toFixed(3)} -> ${oracle.mrr.toFixed(3)}   max gain ${(oracle.mrr - local.mrr).toFixed(3)}`)
console.log('')
console.log('Where the headroom is, by lexical overlap (the bucket a memory system exists for):')
console.log('  difficulty   n    shipped hit/top1    oracle hit/top1    headroom hit/top1')
for (const d of ['high', 'mixed', 'low']) {
  const s = arms[0].byDifficulty[d]
  const o = arms[2].byDifficulty[d]
  if (!s || !o) continue
  console.log(
    `  ${d.padEnd(12)} ${String(s.n).padEnd(4)} ${`${pct(s.hitRate)} / ${pct(s.top1Accuracy)}`.padEnd(21)}` +
      `${`${pct(o.hitRate)} / ${pct(o.top1Accuracy)}`.padEnd(22)}` +
      `${pct(o.hitRate - s.hitRate)} / ${pct(o.top1Accuracy - s.top1Accuracy)}`
  )
}
console.log('')
console.log('What the semantic signal is already contributing (shipped minus vector-removed):')
console.log(`  hit@5    ${pct(none.hitRate)} -> ${pct(local.hitRate)}   ${pct(local.hitRate - none.hitRate)}`)
console.log(`  MRR      ${none.mrr.toFixed(3)} -> ${local.mrr.toFixed(3)}   ${(local.mrr - none.mrr).toFixed(3)}`)
console.log('')
process.exit(0)
