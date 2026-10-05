/*
 * Tests for the verbose-query dilution fix in utils/textRelevance.js.
 *
 * Regression context: a real Ask failed with "I couldn't find anything in your
 * saved memories". Retrieval had scored the same memory 0.68 for the terse
 * question "tell me my life" and 0.00 for the detailed version, because token
 * coverage divides by the *query* token count - so supplying more relevant
 * detail made recall worse. Scoring each clause and keeping the best fixes it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { relevanceScore, queryClauses } = await import('../src/utils/textRelevance.js')

const MEMORY = [
  'My Life Journey',
  'I am currently studying engineering and my dream is to become a software engineer.',
]

test('a detailed question retrieves at least as well as its terse fragment', () => {
  const terse = relevanceScore('tell me my life', MEMORY)
  const verbose = relevanceScore(
    'tell me my life i given journey my name and i am currently study and my dream are given',
    MEMORY
  )

  assert.ok(terse > 0, 'the terse question should match at all')
  assert.ok(
    verbose >= terse,
    `verbose query scored ${verbose.toFixed(3)} but its own fragment scored ${terse.toFixed(3)}; ` +
      'extra detail must not reduce recall'
  )
})

test('the fix does not invent matches for unrelated memories', () => {
  // A memory sharing nothing with any clause must stay at 0. This is the guard
  // against "just take the max" turning into false positives.
  const unrelated = ['Soccer Practice', 'Training schedule for the local club on Saturdays.']
  const score = relevanceScore(
    'tell me my life i given journey my name and i am currently study and my dream are given',
    unrelated
  )
  assert.equal(score, 0, `unrelated memory scored ${score}, expected 0`)
})

test('queryClauses splits on punctuation and conjunctions', () => {
  const clauses = queryClauses('what is my name, and where do i study? also my dream')
  assert.ok(clauses.length >= 3, `expected >=3 clauses, got ${clauses.length}`)
  assert.ok(clauses.some((c) => c.includes('name')))
  assert.ok(clauses.some((c) => c.includes('study')))
  assert.ok(clauses.some((c) => c.includes('dream')))
})

test('queryClauses returns the question untouched when there is nothing to split', () => {
  assert.deepEqual(queryClauses('tell me my life'), ['tell me my life'])
})

test('a single-clause question keeps its original score', () => {
  // No splitting means the change must be behaviour-preserving for short queries.
  const score = relevanceScore('my dream', MEMORY)
  assert.ok(score > 0.3, `expected a strong match for "my dream", got ${score.toFixed(3)}`)
})