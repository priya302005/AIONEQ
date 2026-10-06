import test from 'node:test'
import assert from 'node:assert/strict'
import { relevanceScore, contentTokens } from '../src/utils/textRelevance.js'

// The real failure: the user typed "kodaikalanal" and the memory says
// "Kodaikanal". The place name scored zero, so the only surviving signal was
// the generic word "journey", which dragged in an unrelated college memory.
const TRIP = [
  'My Kodaikanal Journey',
  'Visited Kodaikanal with friends, went to Ooty too. Great trip.',
]
const COLLEGE = [
  'My college life',
  'I am currently pursuing BE CSE at NEC. My dream is to become a software developer at ZOHO.',
]

test('a misspelled place name still retrieves its own memory', () => {
  const trip = relevanceScore('tell me my kodaikalanal journey', TRIP)
  const college = relevanceScore('tell me my kodaikalanal journey', COLLEGE)
  assert.ok(trip > 0, 'the trip memory must match at all')
  assert.ok(
    trip > college,
    `trip (${trip.toFixed(3)}) must beat college (${college.toFixed(3)})`
  )
})

test('generic narrative words do not qualify an unrelated memory', () => {
  // Without the stopword fix, "journey" alone scored high enough on COLLEGE.
  const college = relevanceScore('tell me my kodaikalanal journey', COLLEGE)
  assert.ok(
    college < 0.3,
    `unrelated memory scored ${college.toFixed(3)}, expected < 0.3`
  )
})

test('typo tolerance is bounded and length-aware', () => {
  // One edit in a 6-letter word is accepted.
  assert.ok(relevanceScore('kodaikanl', TRIP) > 0)
  // Two edits in a longer word.
  assert.ok(relevanceScore('kodaikanaal', TRIP) > 0)
  // 4-letter words allow a single edit: "trqp" ~ "trip" is a real typo.
  assert.ok(relevanceScore('trqp', TRIP) > 0, 'one edit in a 4-letter word')
  // Two edits in a 4-letter word is not a typo, it is a different word.
  assert.equal(relevanceScore('trxq', TRIP), 0, 'two edits rejected')
  // 3-letter words get no edit budget at all, or almost everything would match.
  assert.equal(relevanceScore('trp', TRIP), 0, 'short word rejected')
  // A completely different word still fails.
  assert.equal(relevanceScore('bicycle submarine', TRIP), 0)
})

test('a real match still outranks a typo-only near miss', () => {
  const exact = relevanceScore('tell me my kodaikanal journey', TRIP)
  const typo = relevanceScore('tell me my kodaikalanal journey', TRIP)
  assert.ok(
    exact >= typo,
    `exact (${exact.toFixed(3)}) should not score below typo (${typo.toFixed(3)})`
  )
})

test('typos in personal names are tolerated', () => {
  const mem = ['My name is Janani and I study at NEC']
  assert.ok(relevanceScore('what is my nam', mem) > 0, 'name typo')
  assert.ok(relevanceScore('jananni name', mem) > 0, 'inserted-letter typo')
})

test('stopword list still leaves real content words intact', () => {
  const tokens = contentTokens('tell me about my journey to the shopping mall')
  assert.ok(tokens.includes('shopping'))
  assert.ok(tokens.includes('mall'))
  // Vague words are weighted down, not deleted: deleting them made a memory
  // that is genuinely only about a journey unreachable.
  assert.ok(tokens.includes('journey'), 'journey still counts, just weakly')
  assert.ok(tokens.includes('tell'), 'tell still counts, just weakly')
})
