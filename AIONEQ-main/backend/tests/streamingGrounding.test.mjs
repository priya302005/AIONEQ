import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groundAnswer, createSentenceStream } from '../src/services/claimGrounding.js'

const MEM = [{ memoryId: '67a1de13-a1e4-42bd-b82b-15025a42057a', snippet: 'my name is janani, pursuing BE CSE at NEC.' }]

test('createSentenceStream releases whole sentences as they complete', () => {
  const s = createSentenceStream()
  assert.deepEqual(s.push('From what you '), [])
  assert.deepEqual(s.push('shared, your name is Janani'), [])
  assert.deepEqual(s.push('.'), ['From what you shared, your name is Janani.'])
  assert.deepEqual(s.push(' It mentions NEC'), [])
  assert.deepEqual(s.flush(), ['It mentions NEC'])
})

test('createSentenceStream flushes a trailing fragment with no terminator', () => {
  const s = createSentenceStream()
  assert.deepEqual(s.push('My name is Janani'), [])
  assert.deepEqual(s.flush(), ['My name is Janani'])
  assert.deepEqual(s.flush(), [])
})

test('createSentenceStream yields nothing for whitespace-only output', () => {
  const s = createSentenceStream()
  assert.deepEqual(s.push('   \n  '), [])
  assert.deepEqual(s.flush(), [])
})

test('createSentenceStream never loops on input without a terminator', () => {
  // A non-global regex here would re-match from index 0 forever and hang the
  // process, so this is a real regression guard, not a formality.
  const s = createSentenceStream()
  assert.deepEqual(s.push('a'.repeat(5000)), [])
  assert.deepEqual(s.flush(), ['a'.repeat(5000)])
})

test('STREAMING SAFETY: an ungrounded sentence is never released', () => {
  const s = createSentenceStream()
  const released = []
  for (const delta of ['I was born in 1999. ', 'My name is Janani.']) {
    for (const sentence of s.push(delta)) {
      const graded = groundAnswer({ answer: sentence, memories: MEM, honestFallback: '' })
      // The release test is "was it removed", not "is the result empty":
      // groundAnswer substitutes its default fallback text when it filters a
      // sentence, so an emptiness check would release that fallback as if the
      // model had said it.
      if (graded.removedClaims.length || !graded.answer.trim()) continue
      released.push(graded.answer)
    }
  }
  assert.deepEqual(released, ['My name is Janani.'], 'a fabrication reached the client')
})

test('STREAMING SAFETY: the default fallback text is never released as an answer', () => {
  const s = createSentenceStream()
  const released = []
  for (const sentence of s.push('I was born in 1999.')) {
    const graded = groundAnswer({ answer: sentence, memories: MEM, honestFallback: '' })
    if (graded.removedClaims.length || !graded.answer.trim()) continue
    released.push(graded.answer)
  }
  assert.deepEqual(released, [], "groundAnswer's fallback text leaked to the client")
})

test('STREAMING SAFETY: every released sentence is independently grounded', () => {
  const s = createSentenceStream()
  const text = 'My name is Janani. I am pursuing BE CSE at NEC. I own a spaceship.'
  const released = []
  for (const delta of text.match(/.{1,7}/g) || []) {
    for (const sentence of s.push(delta)) {
      const graded = groundAnswer({ answer: sentence, memories: MEM, honestFallback: '' })
      if (graded.removedClaims.length || !graded.answer.trim()) continue
      released.push(graded.answer)
    }
  }
  assert.equal(released.length, 2)
  assert.ok(!released.join(' ').includes('spaceship'))
})

test('STREAMING SAFETY: a denial is not released as an answer', () => {
  const s = createSentenceStream()
  const released = []
  for (const sentence of s.push("From what you shared, I don't have a name.")) {
    const graded = groundAnswer({ answer: sentence, memories: MEM, honestFallback: '' })
    if (graded.removedClaims.length || !graded.answer.trim()) continue
    released.push(graded.answer)
  }
  // The text survives (an honest denial must reach the user) but it is never
  // counted as a grounded claim, which is what stops the controller treating it
  // as the answer.
  assert.equal(released.length, 1)
  assert.match(released[0], /don't have a name/i)
  assert.equal(
    groundAnswer({ answer: released[0], memories: MEM, honestFallback: '' }).supportedClaimCount,
    0,
  )
})