/*
 * Regression tests for the false "I can't answer" refusal.
 *
 * Production trace: the user asked "give me my friend details". Retrieval scored
 * the memory 0.907 and the UI showed "Answered from 1 memory" - but the reply was
 *
 *   "I wasn't able to put together an answer from your memories just now."
 *
 * That string was claimGrounding's honestFallback. Qwen had answered, but every
 * sentence was uncited (a 0.5B model rarely emits `(cite: <uuid>)`) and the
 * paraphrases missed the 0.34 folded-word support threshold, so R3 removed all
 * of them and line 361 swapped in the fallback. The guard behaved correctly by
 * its own rules; the rules just cannot tell a synonym from an invention.
 *
 * The fix relays the stored excerpt instead of claiming ignorance. Excerpt text
 * comes from the database, so it cannot be a hallucination.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { groundAnswer } = await import('../src/services/claimGrounding.js')
const { relayRetrievedMemories } = await import('../src/services/memoryContext.js')

const FRIEND = {
  memoryId: '87bcf1a4-d4fe-4e0a-be06-7c554c60d7be',
  title: 'My friend Details',
  snippet: 'My friend Rahul works as a doctor in Chennai. We met during our college days in 2019.',
}

// The exact paraphrase style that stripped a true answer in production.
const SYNONYM_ANSWER = 'Your friend works as a physician in the Tamil Nadu capital.'

function run(answer, memories = [FRIEND]) {
  return groundAnswer({
    answer,
    memories,
    honestFallback: relayRetrievedMemories(memories) || 'nothing at all',
  })
}

test('a true synonym paraphrase no longer yields a refusal', () => {
  const g = run(SYNONYM_ANSWER)

  assert.ok(
    !g.answer.includes('not able to put together'),
    'the false-ignorance refusal must not come back'
  )
  assert.match(g.answer, /Rahul/, 'the stored memory text should be relayed')
  assert.match(g.answer, /doctor in Chennai/i)
})

test('the relay preserves the citation so the answer still attributes its source', () => {
  const g = run(SYNONYM_ANSWER)
  assert.ok(
    g.answer.includes(FRIEND.memoryId),
    'relayed text must carry the memory id so it stays attributable'
  )
})

test('a supported answer is still returned as the model wrote it', () => {
  // The relay is a fallback only. A normally-grounded answer must be untouched,
  // otherwise every reply degrades into a quoted excerpt.
  const good = 'Your friend Rahul works as a doctor in Chennai.'
  const g = run(good)

  assert.equal(g.answer, good)
  assert.equal(g.changed, false)
})

test('relay returns nothing usable when there are no memories', () => {
  assert.equal(relayRetrievedMemories([]), '')
  assert.equal(relayRetrievedMemories([{ memoryId: 'x', snippet: '' }]), '')
})

test('the relay only ever emits text that was actually supplied', () => {
  // The relay's guarantee is narrow and mechanical: it copies from `memories`
  // and nothing else. It is not a second hallucination filter - claim grounding
  // is that layer, and its limits are documented in
  // "known limitation: lexical support" below.
  const stored = 'My friend Rahul works as a doctor in Chennai.'
  const out = relayRetrievedMemories([{ memoryId: 'm1', snippet: stored }])

  const quoted = out
    .split('\n')
    .slice(1)
    .map((l) => l.replace(/^\d+\)\s*/, '').replace(/\s*\(cite: [^)]+\)$/, '').trim())
    .filter(Boolean)

  for (const line of quoted) {
    assert.ok(
      stored.includes(line),
      `relay emitted text absent from the stored memory: "${line}"`
    )
  }
})

/*
 * Known limitation: lexical support.
 *
 * Support is folded word overlap, so the guard is symmetric-blind in both
 * directions. It strips a true paraphrase ("physician" vs "doctor") AND it
 * passes a pure invention that reuses enough of the memory's vocabulary:
 *
 *   "Your friend Rahul secretly works for a government intelligence agency."
 *     -> friend/rahul/work = 3/7 = 0.43 >= 0.34 -> KEPT
 *
 * This is unchanged by the relay fallback and predates it. It is a real
 * limitation for a memory product, and closing it properly needs a semantic
 * check (embedding similarity or an LLM judge per claim), not a threshold tweak.
 * Pinned here so the behaviour is visible rather than assumed.
 */
test('KNOWN LIMITATION: lexical support passes a fabrication reusing memory words', () => {
  const g = run('Your friend Rahul secretly works for a government intelligence agency.')

  assert.ok(
    g.answer.includes('intelligence agency'),
    'documents the current (weak) behaviour; change this assertion when support becomes semantic'
  )
})

test('relay caps how many memories it quotes', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    memoryId: `id-${i}`,
    snippet: `memory number ${i}`,
  }))
  const out = relayRetrievedMemories(many, { max: 2 })
  assert.ok(out.includes('memory number 0'))
  assert.ok(out.includes('memory number 1'))
  assert.ok(!out.includes('memory number 2'), 'should stop at the cap')
})