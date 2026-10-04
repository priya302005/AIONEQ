/*
 * Retrieval QUALITY gate.
 *
 * The existing retrieval tests assert that retrieval behaves correctly. These
 * assert that it behaves WELL, using the reproducible evaluation corpus in
 * backend/eval. Without them the Phase 2 defect below was invisible to CI:
 *
 *   blendedScore had two branches, "has vector" and "no vector", returning
 *   numbers on different scales. A memory that merely OR-matched Postgres
 *   full-text search on ONE query word scored 0.48, while a genuine cosine-0.55
 *   semantic match scored 0.33. Hybrid retrieval therefore ranked KEYWORD NOISE
 *   above SEMANTIC EVIDENCE and scored worse than either of its own components:
 *
 *       before   hit@5 69.8%   top-1 27.9%   MRR 0.426
 *       after    hit@5 81.4%   top-1 46.5%   MRR 0.612
 *
 * The thresholds below are deliberately LOOSE. They are regression tripwires
 * calibrated on a 51-memory synthetic corpus, not a quality bar to tune against
 * - tightening them to the measured values would just re-introduce overfitting.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../src/config/config.js'
import { blendedScore, calibrateSimilarity } from '../src/services/memoryRetrieval.js'
import { runEval, buildVectors, VECTOR_MODEL } from '../eval/runRetrievalEval.mjs'
import { retrieveMemories } from '../src/services/memoryRetrieval.js'
import { MEMORIES, OTHER_USER_MEMORIES, PRIMARY_USER_ID } from '../eval/dataset.memories.js'
import { QUESTIONS } from '../eval/dataset.questions.js'

// The evaluation runs the real retrieval code three times; do it once.
const evals = await Promise.all([
  runEval({ strategy: 'lexical' }),
  runEval({ strategy: 'vector' }),
  runEval({ strategy: 'hybrid' }),
])
const [lexical, vector, hybrid] = evals
const O = (e) => e.summary.overall

// ------------------------------------------------- the defect, pinned down ---

test('a strong semantic match outranks a single-word full-text OR match', () => {
  // This is the exact regression. Before the fix the first line scored 0.48 and
  // the second 0.33, i.e. keyword noise beat real evidence.
  const keywordNoise = blendedScore({ vectorSimilarity: null, lexical: 0.05, keywordMatched: true })
  const strongSemantic = blendedScore({ vectorSimilarity: 0.55, lexical: 0, keywordMatched: false })
  assert.ok(
    strongSemantic > keywordNoise,
    `semantic ${strongSemantic.toFixed(3)} must beat one-word FTS noise ${keywordNoise.toFixed(3)}`
  )
})

test('the blend is continuous: no missing-vector branch discontinuity', () => {
  // A vector score of 0 and "no vector at all" must produce the same number, or
  // ranking depends on which branch a memory fell into rather than its relevance.
  const absent = blendedScore({ vectorSimilarity: null, lexical: 0.4, keywordMatched: false })
  const zero = blendedScore({ vectorSimilarity: 0, lexical: 0.4, keywordMatched: false })
  assert.equal(absent, zero)
})

test('the blend is monotonic in every input', () => {
  let prev = -1
  for (const lex of [0, 0.25, 0.5, 0.75, 1]) {
    const s = blendedScore({ vectorSimilarity: 0.3, lexical: lex, keywordMatched: false })
    assert.ok(s >= prev, `lexical ${lex} decreased the score`)
    prev = s
  }
  prev = -1
  for (const sim of [0, 0.15, 0.3, 0.45, 0.7, 1]) {
    const s = blendedScore({ vectorSimilarity: sim, lexical: 0.3, keywordMatched: false })
    assert.ok(s >= prev, `similarity ${sim} decreased the score`)
    prev = s
  }
})

test('every blend strategy stays inside 0..1', () => {
  for (const strategy of ['hybrid', 'lexical', 'vector']) {
    for (const sim of [null, 0, 0.3, 1]) {
      for (const lex of [0, 0.5, 1]) {
        const s = blendedScore({ vectorSimilarity: sim, lexical: lex, keywordMatched: true, strategy })
        assert.ok(s >= 0 && s <= 1, `${strategy} produced ${s}`)
      }
    }
  }
})

test('a cosine below the noise floor contributes nothing at all', () => {
  assert.equal(calibrateSimilarity(config.vectorMinSimilarity - 0.05), 0)
  assert.equal(calibrateSimilarity(0), 0)
  assert.equal(calibrateSimilarity(NaN), 0)
  assert.equal(calibrateSimilarity(config.vectorSimilarityAnchor), 1)
  assert.ok(calibrateSimilarity(1) === 1, 'must clamp above the anchor')
})

// ----------------------------------------------- structural quality gates ---

test('hybrid retrieval is not worse than either of its own components', () => {
  // THE invariant. A hybrid system that cannot beat its parts is broken; this is
  // exactly what the Phase 2 defect produced.
  assert.ok(
    O(hybrid).hitRate >= O(lexical).hitRate,
    `hybrid hit@5 ${O(hybrid).hitRate} < lexical ${O(lexical).hitRate}`
  )
  assert.ok(
    O(hybrid).mrr >= O(lexical).mrr - 0.05,
    `hybrid MRR ${O(hybrid).mrr} is well below lexical ${O(lexical).mrr}`
  )
  assert.ok(
    O(hybrid).recallAtK >= O(lexical).recallAtK - 0.05,
    `hybrid recall@5 ${O(hybrid).recallAtK} is well below lexical ${O(lexical).recallAtK}`
  )
})

test('retrieval never crosses users, on any strategy', () => {
  // The corpus deliberately contains near-identical memories owned by another
  // user (same lease, same birthday, same Python course). A single one leaking
  // is a critical security failure, not a quality regression.
  for (const e of evals) {
    assert.equal(e.summary.overall.leakCount, 0, `${e.strategy} leaked another user's memory`)
  }
  assert.ok(OTHER_USER_MEMORIES.length >= 3 && PRIMARY_USER_ID !== OTHER_USER_MEMORIES[0].user_id)
})

test('a question with no vocabulary overlap retrieves nothing', () => {
  // Disjoint no-answer questions must produce an empty result set, otherwise the
  // model is handed context to invent an answer from.
  for (const e of evals) {
    assert.ok(
      e.summary.overall.noAnswerDisjointOk >= 0.99,
      `${e.strategy} retrieved memories for a fully disjoint question (${e.summary.overall.noAnswerDisjointOk})`
    )
  }
})

test('measured retrieval quality stays above the calibrated floor', () => {
  // Loose tripwires. If a future change breaks retrieval, this fails loudly
  // instead of quietly degrading answers.
  assert.ok(O(hybrid).hitRate >= 0.7, `hit@5 collapsed to ${O(hybrid).hitRate}`)
  assert.ok(O(hybrid).mrr >= 0.5, `MRR collapsed to ${O(hybrid).mrr}`)
  assert.ok(O(hybrid).top1Accuracy >= 0.35, `top-1 collapsed to ${O(hybrid).top1Accuracy}`)
  assert.ok(O(hybrid).recallAtK >= 0.65, `recall@5 collapsed to ${O(hybrid).recallAtK}`)
})

test('the vector signal contributes something a keyword search cannot', () => {
  // If pure-vector ever stops adding value over pure-lexical, the semantic
  // index is dead weight and someone should be told.
  assert.ok(
    O(vector).mrr > O(lexical).mrr,
    `vector-only MRR ${O(vector).mrr} is not better than lexical-only ${O(lexical).mrr}`
  )
})

test('known-hard categories are recognised as hard, not silently failing', () => {
  // Indirect references ("what am I paying for the place I live in") need real
  // semantic understanding. This test does not demand a pass - it records that
  // the category is measurably worse so a future improvement is visible.
  const indirect = hybrid.summary.byScenario.indirect
  assert.ok(indirect, 'the indirect scenario must exist in the dataset')
  assert.ok(
    indirect.hitRate <= 0.7,
    `indirect hit@5 is now ${indirect.hitRate}; this assertion exists to prompt re-measuring the benchmark`
  )
})

test('the evaluation corpus and question set are well formed', () => {
  assert.ok(MEMORIES.length >= 40, 'corpus too small to be meaningful')
  assert.ok(QUESTIONS.length >= 40, 'question set too small to be meaningful')
  const ids = new Set(MEMORIES.map((m) => m.id))
  assert.equal(ids.size, MEMORIES.length, 'duplicate memory ids in the corpus')
  for (const item of QUESTIONS) {
    for (const g of item.gold) {
      assert.ok(ids.has(g), `question "${item.question}" references unknown memory ${g}`)
    }
    if (item.scenario === 'no_answer') assert.equal(item.gold.length, 0)
    else assert.ok(item.gold.length > 0, `answerable question "${item.question}" has no gold memory`)
  }
  // Every required scenario must be represented, or coverage is being claimed
  // that the dataset does not actually test.
  const required = ['exact', 'paraphrase', 'indirect', 'multi', 'temporal', 'changed_goal', 'distractors', 'no_answer', 'ambiguous']
  for (const s of required) {
    assert.ok(QUESTIONS.some((q) => q.scenario === s), `scenario "${s}" is missing from the dataset`)
  }
})

test('the vectorizer identity recorded by the evaluation matches the pipeline', () => {
  // If this drifts, the evaluation is no longer measuring the vectors that the
  // product actually writes, and every number above becomes fiction.
  assert.equal(VECTOR_MODEL, 'local-hash-v1@384')
  assert.equal(config.embeddingDim, 384)
})

// ------------------------------------------- embedding-space consistency ----

test('the embedding identity is a pure function of config and names the space', async () => {
  const { embeddingIdentity, LOCAL_VECTOR_MODEL } = await import('../src/utils/embeddings.js')
  assert.equal(embeddingIdentity({ mode: 'local', embeddingDim: 384 }), `${LOCAL_VECTOR_MODEL}@384`)
  assert.equal(embeddingIdentity({ mode: 'local', embeddingDim: 768 }), `${LOCAL_VECTOR_MODEL}@768`)
  // A dimension change MUST change the identity, otherwise vectors from the two
  // spaces would be searched together.
  assert.notEqual(
    embeddingIdentity({ mode: 'local', embeddingDim: 384 }),
    embeddingIdentity({ mode: 'local', embeddingDim: 768 })
  )
  // A model change at the SAME dimension must change the identity too.
  assert.notEqual(
    embeddingIdentity({ mode: 'remote', embeddingModel: 'a', embeddingDim: 384 }),
    embeddingIdentity({ mode: 'remote', embeddingModel: 'b', embeddingDim: 384 })
  )
  // Unconfigured remote is unnameable, so there is no identity to claim.
  assert.equal(embeddingIdentity({ mode: 'remote', embeddingModel: null, embeddingDim: 384 }), null)
  assert.equal(embeddingIdentity({ mode: 'off', embeddingDim: 384 }), null)
})

test('the active identity is what the configured mode actually produces', async () => {
  const { activeEmbeddingIdentity, embed } = await import('../src/utils/llmClient.js')
  assert.equal(activeEmbeddingIdentity(), VECTOR_MODEL)
  const result = await embed({ input: 'a memory about signing a lease' })
  // Whatever embed() stores, retrieval searches for by identity. They must agree.
  assert.equal(result.model, VECTOR_MODEL)
  assert.equal(result.dim, result.vector.length)
})

test('vectors from another embedding space are invisible, not mis-scored', async () => {
  // THE Phase 3 hazard, reproduced deliberately.
  //
  // Before the identity filter, `match_memory_vectors` only checked `dim`. Change
  // the embedding model at the SAME dimension and every stored vector still
  // passes the dimension check, so it gets a cosine score computed in an unrelated
  // space. The result is confident non-zero similarity between unrelated texts -
  // a silent false-positive source that no error surfaces.
  //
  // Here the corpus is indexed under a different model identity at the same
  // dimension. Retrieval must return NOTHING from the vector index, which is the
  // safe failure: keyword search carries the answer and the drift is reported.
  const { createFakeSupabase } = await import('../eval/fakeSupabase.js')
  const staleVectors = await buildVectors(MEMORIES, { model: 'some-other-model@384' })
  const client = createFakeSupabase({
    userId: PRIMARY_USER_ID,
    memories: MEMORIES,
    vectors: staleVectors,
  })

  const fromOtherSpace = await retrieveMemories(client, PRIMARY_USER_ID, 'Why did I give up on learning to program?', {
    strategy: 'vector',
    limit: 10,
  })
  assert.equal(
    fromOtherSpace.length,
    0,
    `vectors from an unrelated space must not be searchable, got ${fromOtherSpace.length} hits`
  )

  // And the drift must be detectable, not merely harmless.
  const { getVectorCoverageWithClient } = await import('../src/models/memory.model.js')
  const { activeEmbeddingIdentity } = await import('../src/utils/llmClient.js')
  const coverage = await getVectorCoverageWithClient(client, {
    userId: PRIMARY_USER_ID,
    model: activeEmbeddingIdentity(),
  })
  assert.equal(coverage.needsReindex, true, 'stale-space vectors must be reported as needing a reindex')
  assert.equal(coverage.current, 0)
  assert.equal(coverage.stale, MEMORIES.length)
  assert.ok(coverage.models['some-other-model@384'] > 0)
})

test('a healthy corpus reports no reindex needed', async () => {
  const { createFakeSupabase } = await import('../eval/fakeSupabase.js')
  const { getVectorCoverageWithClient } = await import('../src/models/memory.model.js')
  const { activeEmbeddingIdentity } = await import('../src/utils/llmClient.js')
  const client = createFakeSupabase({
    userId: PRIMARY_USER_ID,
    memories: MEMORIES,
    vectors: await buildVectors(MEMORIES),
  })
  const coverage = await getVectorCoverageWithClient(client, {
    userId: PRIMARY_USER_ID,
    model: activeEmbeddingIdentity(),
  })
  assert.equal(coverage.needsReindex, false)
  assert.equal(coverage.current, MEMORIES.length)
  assert.equal(coverage.stale, 0)
})
