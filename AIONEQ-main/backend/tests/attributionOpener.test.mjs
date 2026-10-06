import test from 'node:test'
import assert from 'node:assert/strict'
import { stripAttributionOpener, streamFailureMessage } from '../src/services/memoryContext.js'

test('strips the leading sourcing preamble', () => {
  const cases = [
    ['From what you shared, your name is Janani.', 'Your name is Janani.'],
    ['From what you told me, you study at NEC.', 'You study at NEC.'],
    ['Based on what you have shared with me, you want to work at ZOHO.', 'You want to work at ZOHO.'],
    ['According to your memories, you are a final year student.', 'You are a final year student.'],
    ['from what you shared your name is Janani', 'Your name is Janani'],
    ['Well, from what you shared, you like biryani.', 'You like biryani.'],
    ['So, based on what you told me, you moved to Chennai.', 'You moved to Chennai.'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(stripAttributionOpener(input), expected, input)
  }
})

test('never drops a citation or the content behind the opener', () => {
  const id = '11111111-2222-3333-4444-555555555555'
  const text = `From what you shared, your name is Janani (cite: ${id}).`
  const out = stripAttributionOpener(text)
  assert.ok(out.includes(`(cite: ${id})`), 'citation survives')
  assert.ok(out.includes('Janani'), 'claim survives')
  assert.ok(!/from what you shared/i.test(out), 'opener removed')
})

test('leaves answers alone when there is no opener', () => {
  const cases = [
    'Your name is Janani.',
    'I could not find that in your saved memories.',
    'I am still working out what that implies, from what I can tell.',
    'She said "from what you shared" would sound odd.',
    '',
  ]
  for (const input of cases) assert.equal(stripAttributionOpener(input), input)
})

test('does not strip an opener that appears mid-answer', () => {
  const text = 'You study at NEC. From what you shared earlier, you also like coding.'
  assert.equal(stripAttributionOpener(text), text)
})

test('refuses to strip when nothing usable remains', () => {
  // Stripping here would delete a refusal rather than tidy a sentence.
  assert.equal(stripAttributionOpener('From what you shared, ...'), 'From what you shared, ...')
  assert.equal(stripAttributionOpener('From what you shared,'), 'From what you shared,')
})

test('preserves capitalization of the surviving text', () => {
  assert.equal(stripAttributionOpener('From what you shared, NEC is where you study.'), 'NEC is where you study.')
})

test('stream failures name the actual cause instead of a generic error', () => {
  // The case the user hit: model server not running at all.
  const refused = Object.assign(new Error('fetch failed'), {
    cause: { code: 'ECONNREFUSED' },
  })
  const msg = streamFailureMessage(refused)
  assert.match(msg, /not running/i)
  assert.match(msg, /4891/, 'tells the user which server to start')
  assert.doesNotMatch(msg, /Could not complete/, 'not the useless generic text')

  // Other transports and states stay distinct.
  assert.match(streamFailureMessage({ code: 'ECONNRESET' }), /not running/i)
  assert.match(streamFailureMessage(Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } })), /not running/i)
  assert.match(streamFailureMessage({ message: 'The operation was aborted due to timeout' }), /too long/i)
  assert.match(streamFailureMessage({ message: 'local AI stream produced no frames', code: 'EMPTY_STREAM' }), /empty response/i)
  assert.equal(streamFailureMessage(new Error('something odd')), 'Could not complete the answer.')
})
