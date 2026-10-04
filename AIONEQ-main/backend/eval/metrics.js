/*
 * Retrieval quality metrics.
 *
 * Definitions are fixed here so the numbers in the report are unambiguous and
 * reproducible. Every metric is computed per question, then averaged.
 *
 *   Answerable questions  - have at least one gold memory.
 *   No-answer questions   - expect nothing back (expectNoAnswer).
 *
 *   hit@k           at least one gold memory appears in the top k.
 *   top1Accuracy    the FIRST result is a gold memory. For a memory-grounded
 *                    assistant this is the metric that matters most, because the
 *                    top-ranked memory is what the model reaches for first and
 *                    what gets cited first.
 *   precision@k     gold memories in top k / k.               (answerable only)
 *   recall@k        gold memories in top k / total gold.      (answerable only)
 *   mrr             1 / rank of the FIRST gold memory, 0 if absent in top k.
 *   falseMatch      answerable questions where top k contains >=1 non-gold
 *                    memory - "irrelevant memory retrieval rate".
 *   falseMatchTop1  answerable questions where the TOP result is not gold.
 *                    This is the dangerous variant: the wrong memory gets read
 *                    first and is the easiest thing to cite confidently.
 *   noAnswerCorrect no-answer questions where top k is EMPTY.
 *   leakCount       any returned memory owned by a different user.
 *
 * A note on precision@k: with 1 gold memory and k=5, the ceiling is 0.2 even for
 * a perfect retriever, because a grounded-answer system deliberately hands the
 * model a little more context than strictly necessary. Precision is therefore
 * reported for completeness but must be read alongside top1Accuracy and MRR
 * rather than optimised directly. recall@k and MRR are strictly top-k bounded.
 */

export const K = 5

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function round(n, dp = 3) {
  return Number.isFinite(n) ? Number(n.toFixed(dp)) : 0
}

/** Evaluates one question against one ranked result list. */
export function scoreQuestion(item, results, { k = K, otherUserIds = [] } = {}) {
  const top = results.slice(0, k)
  const returnedIds = results.map((r) => r.memoryId)
  const topIds = top.map((r) => r.memoryId)
  const gold = item.gold || []
  const goldSet = new Set(gold)

  const hits = topIds.filter((id) => goldSet.has(id))
  const nonGold = topIds.filter((id) => !goldSet.has(id))
  const firstGoldRank = returnedIds.findIndex((id) => goldSet.has(id))

  // Cross-user leak: any returned row at all, not just in the top k. A leak
  // below the cut-off is still a leak, because it is still an answer source.
  const leaked = returnedIds.filter((id) => otherUserIds.includes(id))

  const base = {
    scenario: item.scenario,
    adjacent: Boolean(item.adjacent),
    difficulty: item.difficulty,
    question: item.question,
    nReturned: returnedIds.length,
    topIds,
    leaked,
    scores: results.map((r) => ({ id: r.memoryId, score: r.score, by: r.matchedBy })),
  }

  if (item.expectNoAnswer) {
    return {
      ...base,
      // Correct means we returned NOTHING at all, not merely nothing in top k.
      noAnswerCorrect: returnedIds.length === 0 ? 1 : 0,
      hit: 0,
      top1: 0,
      precision: 0,
      recall: 0,
      rr: 0,
      falseMatch: returnedIds.some((id) => !goldSet.has(id)) ? 1 : 0,
      falseMatchTop1: returnedIds.length ? 1 : 0,
      nNonGold: returnedIds.length,
    }
  }

  const precision = topIds.length ? hits.length / topIds.length : 0
  // Strictly top-k: recall@k asks how much of the needed set came back inside k,
  // so a gold memory ranked 6th does NOT count.
  const recall = gold.length ? new Set(hits).size / gold.length : 0
  const rr = firstGoldRank >= 0 && firstGoldRank < k ? 1 / (firstGoldRank + 1) : 0
  const top1 = topIds[0] && goldSet.has(topIds[0]) ? 1 : 0

  return {
    ...base,
    hit: hits.length ? 1 : 0,
    top1,
    precision,
    recall,
    rr,
    falseMatch: nonGold.length ? 1 : 0,
    falseMatchTop1: top1 ? 0 : 1,
    nNonGold: nonGold.length,
  }
}

/** Aggregates per-question scores into a metric table. */
export function aggregate(rows, { k = K } = {}) {
  const answerable = rows.filter((r) => r.scenario !== 'no_answer')
  const noAnswer = rows.filter((r) => r.scenario === 'no_answer')
  // No-answer questions split by whether the archive even shares vocabulary with
  // the question. "What is my blood group?" SHOULD surface a blood-test memory -
  // the model then has to say "I found a blood test but no blood group". Purely
  // disjoint questions ("mother's maiden name") should surface nothing.
  const adjacentNA = noAnswer.filter((r) => r.adjacent)
  const disjointNA = noAnswer.filter((r) => !r.adjacent)

  const overall = {
    questions: rows.length,
    answerable: answerable.length,
    noAnswer: noAnswer.length,
    k,
    hitRate: round(mean(answerable.map((r) => r.hit))),
    top1Accuracy: round(mean(answerable.map((r) => r.top1))),
    precisionAtK: round(mean(answerable.map((r) => r.precision))),
    recallAtK: round(mean(answerable.map((r) => r.recall))),
    mrr: round(mean(answerable.map((r) => r.rr))),
    falseMatchRate: round(mean(answerable.map((r) => r.falseMatch))),
    falseMatchTop1: round(mean(answerable.map((r) => r.falseMatchTop1))),
    noAnswerCorrect: round(mean(noAnswer.map((r) => r.noAnswerCorrect))),
    noAnswerAdjacentOk: round(mean(adjacentNA.map((r) => r.noAnswerCorrect))),
    noAnswerDisjointOk: round(mean(disjointNA.map((r) => r.noAnswerCorrect))),
    leakCount: rows.reduce((a, r) => a + r.leaked.length, 0),
  }

  const byScenario = {}
  for (const r of rows) {
    const s = (byScenario[r.scenario] ||= {
      n: 0, _hit: 0, _top1: 0, _p: 0, _r: 0, _rr: 0, _fm: 0, _fm1: 0,
      _na: 0, _naOk: 0, nAnswerable: 0,
    })
    s.n++
    s._hit += r.hit
    s._top1 += r.top1
    s._p += r.precision
    s._r += r.recall
    s._rr += r.rr
    s._fm += r.falseMatch
    s._fm1 += r.falseMatchTop1
    if (r.scenario === 'no_answer') {
      s._na++
      s._naOk += r.noAnswerCorrect
    } else {
      s.nAnswerable++
    }
  }
  for (const [name, s] of Object.entries(byScenario)) {
    const d = s.nAnswerable || s._na
    byScenario[name] = {
      n: s.n,
      nAnswerable: s.nAnswerable,
      hitRate: round(s._hit / d),
      top1Accuracy: round(s._top1 / d),
      precisionAtK: round(s._p / d),
      recallAtK: round(s._r / d),
      mrr: round(s._rr / d),
      falseMatchRate: round(s._fm / d),
      falseMatchTop1: round(s._fm1 / d),
      ...(s._na ? { noAnswerCorrect: round(s._naOk / s._na) } : {}),
    }
  }

  const byDifficulty = {}
  for (const r of answerable) {
    const d = (byDifficulty[r.difficulty] ||= { n: 0, _hit: 0, _top1: 0, _r: 0, _rr: 0, _fm1: 0 })
    d.n++
    d._hit += r.hit
    d._top1 += r.top1
    d._r += r.recall
    d._rr += r.rr
    d._fm1 += r.falseMatchTop1
  }
  for (const [name, d] of Object.entries(byDifficulty)) {
    byDifficulty[name] = {
      n: d.n,
      hitRate: round(d._hit / d.n),
      top1Accuracy: round(d._top1 / d.n),
      recallAtK: round(d._r / d.n),
      mrr: round(d._rr / d.n),
      falseMatchTop1: round(d._fm1 / d.n),
    }
  }

  return { overall, byScenario, byDifficulty }
}
