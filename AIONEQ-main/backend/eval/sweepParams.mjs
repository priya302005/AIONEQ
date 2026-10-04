/*
 * Parameter sensitivity sweep.
 *
 *   node eval/sweepParams.mjs
 *
 * WHY THIS EXISTS: after fixing the blended-score scale defect, the question
 * became "are the shipped defaults sitting on a cliff edge?" A default tuned to
 * the exact optimum of a 51-memory synthetic corpus is overfitted, and would be
 * the wrong thing to ship. What we want to see is a PLATEAU: a range of values
 * that all perform the same, so the default can sit in the middle of it.
 *
 * It also re-derives VECTOR_MIN_SIMILARITY and VECTOR_SIMILARITY_ANCHOR, which
 * calibrate raw cosine into 0..1. Those two constants MUST be re-derived whenever
 * the embedding model changes; see the calibration note in memoryRetrieval.js.
 */
import { config } from '../src/config/config.js'
import { retrieveMemories } from '../src/services/memoryRetrieval.js'
import { createFakeSupabase } from './fakeSupabase.js'
import { MEMORIES, OTHER_USER_MEMORIES, PRIMARY_USER_ID } from './dataset.memories.js'
import { QUESTIONS } from './dataset.questions.js'
import { buildVectors } from './runRetrievalEval.mjs'
import { embed } from '../src/utils/llmClient.js'
import { memoryEmbeddingText, cosine } from '../src/utils/embeddings.js'
import { scoreQuestion, aggregate } from './metrics.js'

const corpus = [...MEMORIES, ...OTHER_USER_MEMORIES]
const vectors = await buildVectors(corpus)
const client = createFakeSupabase({ userId: PRIMARY_USER_ID, memories: corpus, vectors })

const scoreAll = async (opts) => {
  const rows = []
  for (const item of QUESTIONS) {
    const res = await retrieveMemories(client, PRIMARY_USER_ID, item.question, { strategy: 'hybrid', ...opts })
    rows.push(scoreQuestion(item, res, { k: 5, otherUserIds: ['user-eval-secondary'] }))
  }
  return aggregate(rows, { k: 5 }).overall
}

console.log('minScore sweep (hybrid, k=5) - is the default sitting in a flat or a cliff?')
console.log('floor   hit@5   top1    recall@5  MRR     wrongTop1  prec@5')
for (const ms of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]) {
  const o = await scoreAll({ minScore: ms })
  console.log(
    `${ms.toFixed(2)}    ${(o.hitRate * 100).toFixed(1).padStart(5)}%  ${(o.top1Accuracy * 100).toFixed(1).padStart(5)}%  ` +
      `${o.recallAtK.toFixed(3)}    ${o.mrr.toFixed(3)}  ${(o.falseMatchTop1 * 100).toFixed(1).padStart(5)}%    ${o.precisionAtK.toFixed(3)}`
  )
}

console.log('\nretrievalMaxMemories sweep (how much context the model is handed)')
console.log('max     hit@5   top1    recall@5  MRR     prec@5  wrongTop1')
for (const n of [3, 4, 5, 6, 8, 10]) {
  const o = await scoreAll({ limit: n })
  console.log(
    `${String(n).padStart(3)}     ${(o.hitRate * 100).toFixed(1).padStart(5)}%  ${(o.top1Accuracy * 100).toFixed(1).padStart(5)}%  ` +
      `${o.recallAtK.toFixed(3)}    ${o.mrr.toFixed(3)}  ${o.precisionAtK.toFixed(3)}  ${(o.falseMatchTop1 * 100).toFixed(1).padStart(5)}%`
  )
}

console.log('\nRETRIEVAL_VECTOR_WEIGHT sweep (semantic vs lexical trust)')
console.log('weight  hit@5   top1    recall@5  MRR     prec@5')
const orig = config.retrievalVectorWeight
for (const w of [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
  config.retrievalVectorWeight = w
  const o = await scoreAll({})
  console.log(
    `${w.toFixed(2)}    ${(o.hitRate * 100).toFixed(1).padStart(5)}%  ${(o.top1Accuracy * 100).toFixed(1).padStart(5)}%  ` +
      `${o.recallAtK.toFixed(3)}    ${o.mrr.toFixed(3)}  ${o.precisionAtK.toFixed(3)}`
  )
}
config.retrievalVectorWeight = orig

// ---------------------------------------------------------------- calibrate --
console.log('\nCOSINE CALIBRATION for the active embedding space')
console.log('Re-derive VECTOR_MIN_SIMILARITY and VECTOR_SIMILARITY_ANCHOR whenever the')
console.log('embedding model changes. A remote model will have a completely different')
console.log('distribution, and shipping the local defaults against it silently degrades.')
const goldSims = []
const otherSims = []
for (const item of QUESTIONS) {
  if (item.scenario === 'no_answer') continue
  const qv = await embed({ input: item.question })
  if (!qv?.vector?.length) continue
  for (const m of MEMORIES) {
    const mv = await embed({ input: memoryEmbeddingText(m) })
    const c = cosine(qv.vector, mv.vector)
    if (item.gold.includes(m.id)) goldSims.push(c)
    else otherSims.push(c)
  }
}
goldSims.sort((a, b) => a - b)
otherSims.sort((a, b) => a - b)
const at = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(4) : 'n/a')
console.log(`  gold question->memory  n=${goldSims.length}  p50=${at(goldSims, 0.5)} p90=${at(goldSims, 0.9)} p95=${at(goldSims, 0.95)} p99=${at(goldSims, 0.99)}`)
console.log(`  everything else         n=${otherSims.length}  p50=${at(otherSims, 0.5)} p95=${at(otherSims, 0.95)} p99=${at(otherSims, 0.99)} p999=${at(otherSims, 0.999)}`)
console.log(`\n  suggested VECTOR_MIN_SIMILARITY  = ${at(otherSims, 0.95)}   (non-gold 95th pct)`)
console.log(`  suggested VECTOR_SIMILARITY_ANCHOR = ${at(goldSims, 0.95)}  (gold 95th pct)`)
console.log(`  currently configured              : ${config.vectorMinSimilarity} / ${config.vectorSimilarityAnchor}`)

console.log('\nVECTOR_SIMILARITY_ANCHOR sensitivity (is 0.45 a cliff or a plateau?)')
console.log('anchor  hit@5   top1    recall@5  MRR     prec@5')
const origAnchor = config.vectorSimilarityAnchor
for (const a of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7]) {
  config.vectorSimilarityAnchor = a
  const o = await scoreAll({})
  console.log(
    `${a.toFixed(2)}    ${(o.hitRate * 100).toFixed(1).padStart(5)}%  ${(o.top1Accuracy * 100).toFixed(1).padStart(5)}%  ` +
      `${o.recallAtK.toFixed(3)}    ${o.mrr.toFixed(3)}  ${o.precisionAtK.toFixed(3)}`
  )
}
config.vectorSimilarityAnchor = origAnchor

console.log('\nVECTOR_MIN_SIMILARITY sensitivity')
console.log('minSim  hit@5   top1    recall@5  MRR     prec@5')
const origMin = config.vectorMinSimilarity
for (const s of [0.05, 0.08, 0.12, 0.16, 0.2, 0.25]) {
  config.vectorMinSimilarity = s
  const o = await scoreAll({})
  console.log(
    `${s.toFixed(2)}    ${(o.hitRate * 100).toFixed(1).padStart(5)}%  ${(o.top1Accuracy * 100).toFixed(1).padStart(5)}%  ` +
      `${o.recallAtK.toFixed(3)}    ${o.mrr.toFixed(3)}  ${o.precisionAtK.toFixed(3)}`
  )
}
config.vectorMinSimilarity = origMin
process.exit(0)
