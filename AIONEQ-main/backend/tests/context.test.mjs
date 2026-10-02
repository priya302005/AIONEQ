import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  retrieveContextFrom,
  buildContextPrompt,
  classifyIntent,
} from '../src/utils/contextEngine.js'
import { retrieveScoredMemoriesFrom } from '../src/utils/retrieveMemories.js'

// ------------------------------------------------------------------ fakes --
// Stand-in for Supabase/PostgREST holding BOTH tables. Supports the exact
// query chains the context engine issues (select/textSearch/order/limit) and
// the same store semantics tests can mutate (add/edit/delete at runtime).

function ftsMatch(query, text) {
  const qTokens = String(query).toLowerCase().match(/[a-z0-9']+/g) || []
  const hay = String(text || '').toLowerCase()
  return qTokens.some((t) => hay.includes(t))
}

class FakeQuery {
  constructor(store) {
    this.store = store
    this.search = null
    this.eqCol = null
    this.eqVal = null
    this.orderBy = null
    this._limit = 25
  }
  select() { return this }
  eq(col, val) { this.eqCol = col; this.eqVal = val; return this }
  textSearch(_col, q) { this.search = q; return this }
  order(col, { ascending } = {}) { this.orderBy = { col, ascending }; return this }
  limit(n) { this._limit = n; return this }
  then(resolve, reject) {
    let rows = [...this.store]
    if (this.eqCol) rows = rows.filter((r) => r[this.eqCol] === this.eqVal)
    if (this.search) {
      rows = rows.filter((r) =>
        ftsMatch(this.search, `${r.title || ''} ${r.content || ''} ${Array.isArray(r.tags) ? r.tags.join(' ') : ''}`)
      )
    }
    if (this.orderBy) {
      rows.sort((a, b) => {
        const cmp = String(a[this.orderBy.col] ?? '').localeCompare(String(b[this.orderBy.col] ?? ''))
        return this.orderBy.ascending ? cmp : -cmp
      })
    }
    rows = rows.slice(0, this._limit)
    return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
  }
}

class FakeClient {
  constructor(memories, conversations) {
    this.tables = { memories: memories || [], conversations: conversations || [] }
  }
  from(name) { return new FakeQuery(this.tables[name] || []) }
}

function makeMemory(overrides = {}) {
  const ts = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    user_id: 'user-a',
    title: '',
    type: 'journal',
    content: '',
    tags: [],
    event_date: ts,
    created_at: ts,
    updated_at: ts,
    ...overrides,
  }
}

function makeConv(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    user_id: 'user-a',
    title: '',
    messages: [],
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

const MIN_SCORE = 0.12

// ---------------------------------------------------------------- intent --
test('classifyIntent tags recall, action, and general queries dynamically', () => {
  assert.deepEqual(
    classifyIntent("i don't remember which memory that was").labels.sort(),
    ['recall', 'vague'].sort()
  )
  assert.ok(classifyIntent('what should i prepare for the interview').action)
  assert.deepEqual(classifyIntent('how do black holes form').labels, [])
})

// ------------------------------------------------- selected sources only --
test('only the source that actually matches is selected', async () => {
  const memories = [
    makeMemory({ content: 'I prepared SQL and Java questions for the interview.' }),
    makeMemory({ content: 'Pasta night with parmesan.' }),
  ]
  const conversations = [
    makeConv({
      title: 'Movie night',
      messages: [{ role: 'user', content: 'I watched a movie yesterday with popcorn.' }],
    }),
  ]
  const client = new FakeClient(memories, conversations)
  const pkg = await retrieveContextFrom(client, 'user-a', 'what did i prepare for the interview', {
    minScore: MIN_SCORE,
    currentConversation: {
      id: 'cur-1',
      messages: [{ role: 'user', content: 'I planted tomatoes.' }],
    },
  })
  assert.equal(pkg.memories.length, 1)
  assert.equal(pkg.memories[0].memoryId, memories[0].id)
  assert.ok(pkg.memories[0].score >= MIN_SCORE)
  // Unrelated history is rejected...
  assert.equal(pkg.histories.length, 0)
  // ...but the CURRENT conversation has high priority: a vague "what did i..."
  // question keeps it in scope even when its content is unrelated.
  assert.ok(pkg.currentConversation)
  assert.equal(pkg.currentConversation.conversationId, 'cur-1')
  assert.equal(pkg.ambiguity, false)
})

// ------------------------------------------------- vague recall, weak match --
test('vague recall surfaces the single best weak match, flagged low confidence', async () => {
  const memories = [
    makeMemory({ content: 'Trip to Ooty with cousins last winter.' }),
    makeMemory({ content: 'Collected seashells at the beach.' }),
  ]
  const client = new FakeClient(memories, [])
  // Stricter threshold (CONTEXT_MIN_SCORE=0.2): the single shared content word
  // "trip" keeps the Ooty memory at 1/7 below the floor, so it arrives as an
  // explicitly flagged hint rather than a confident match.
  const pkg = await retrieveContextFrom(
    client,
    'user-a',
    "i don't remember exactly which of my saved notes mentioned the trip to the hills",
    {
      minScore: 0.2,
      currentConversation: {
        id: 'cur-1',
        messages: [{ role: 'user', content: 'I planted tomatoes.' }],
      },
    }
  )
  // No memory clears the threshold, but the best one is surfaced as a hint.
  assert.equal(pkg.memories.length, 1)
  assert.equal(pkg.lowConfidenceMemory, true)
  assert.equal(pkg.memories[0].memoryId, memories[0].id)
  assert.ok(pkg.memories[0].score > 0 && pkg.memories[0].score < 0.2)
  // Vague question keeps the current conversation in scope.
  assert.ok(pkg.currentConversation)
})

// ------------------------------------------------------ irrelevant rejected --
test('clearly irrelevant content is rejected, not forced in', async () => {
  const memories = [makeMemory({ content: 'Pasta recipe with parmesan and basil.' })]
  const conversations = [
    makeConv({ title: 'Movies', messages: [{ role: 'user', content: 'Favourites are thrillers.' }] }),
  ]
  const client = new FakeClient(memories, conversations)
  const pkg = await retrieveContextFrom(client, 'user-a', 'what did i decide about my project deadline', {
    minScore: MIN_SCORE,
  })
  assert.equal(pkg.memories.length, 0)
  assert.equal(pkg.histories.length, 0)
  assert.equal(pkg.currentConversation, null)
  assert.equal(pkg.lowConfidenceMemory, false)
})

// ---------------------------------------------- ambiguity + newest first --
test('two equally relevant memories: newest first + ambiguity flag', async () => {
  const earlier = { content: 'The project tracker shows mentor reviews weekly.' }
  const m1 = makeMemory({ ...earlier, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
  const m2 = makeMemory({ ...earlier, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' })
  const client = new FakeClient([m1, m2], [])
  const pkg = await retrieveContextFrom(client, 'user-a', 'project tracker mentor', { minScore: MIN_SCORE })
  assert.equal(pkg.memories.length, 2)
  assert.equal(pkg.ambiguity, true)
  assert.equal(pkg.memories[0].memoryId, m2.id) // newest first
  assert.equal(pkg.memories[1].memoryId, m1.id)
})

// ------------------------------------------------------------ user privacy --
test('context never crosses users across any source', async () => {
  const shared = { content: 'Secret about the bonus structure.' }
  const memories = [
    makeMemory(shared),
    makeMemory({ ...shared, user_id: 'user-b' }),
    makeMemory({ ...shared, user_id: 'user-c' }),
  ]
  const conversations = [
    makeConv({ user_id: 'user-b', messages: [{ role: 'user', content: 'Bonus structure talk.' }] }),
  ]
  const client = new FakeClient(memories, conversations)
  const pkg = await retrieveContextFrom(client, 'user-a', 'bonus structure', { minScore: MIN_SCORE })
  assert.equal(pkg.memories.length, 1)
  assert.equal(pkg.memories[0].memoryId, memories[0].id)
  assert.equal(pkg.histories.length, 0)
})

// ------------------------------------------------------- history retrieval --
test('previous conversations are retrieved when they match (memories silent)', async () => {
  const conversations = [
    makeConv({
      title: 'Vessel recommender',
      messages: [
        { role: 'user', content: 'I was building a project idea about a recommendation system for vessels with geospatial suggestions.' },
        { role: 'assistant', content: 'We discussed geospatial recommendations for vessels.' },
      ],
    }),
  ]
  const client = new FakeClient([makeMemory({ content: 'Pasta recipe.' })], conversations)
  const pkg = await retrieveContextFrom(client, 'user-a', 'what was that project idea i discussed earlier', {
    minScore: MIN_SCORE,
  })
  assert.equal(pkg.histories.length, 1)
  assert.equal(pkg.histories[0].conversationId, conversations[0].id)
  assert.equal(pkg.memories.length, 0)
  assert.ok(pkg.histories[0].excerpt.includes('recommendation'))
})

test('the current conversation is excluded from history so it is not duplicated', async () => {
  const conv = makeConv({
    title: 'Vessel recommender',
    messages: [
      { role: 'user', content: 'I was building a project idea about a recommendation system for vessels.' },
    ],
  })
  const client = new FakeClient([], [conv])
  const pkg = await retrieveContextFrom(client, 'user-a', 'what was that project idea i discussed earlier', {
    minScore: MIN_SCORE,
    currentConversation: { id: conv.id, messages: conv.messages },
  })
  // It is available as the current conversation, never twice.
  assert.ok(pkg.currentConversation)
  assert.equal(pkg.currentConversation.conversationId, conv.id)
  assert.equal(pkg.histories.length, 0)
})

// ----------------------------------------------------------- history budget --
test('history budget caps how many matching conversations are used', async () => {
  const mk = (ts) =>
    makeConv({
      updated_at: ts,
      messages: [{ role: 'user', content: 'My trip to Ooty was planned for winter with cousins.' }],
    })
  const conversations = [
    mk('2026-01-01T00:00:00Z'),
    mk('2026-06-01T00:00:00Z'),
    mk('2026-09-01T00:00:00Z'),
  ]
  const client = new FakeClient([], conversations)
  const pkg = await retrieveContextFrom(client, 'user-a', 'trip to ooty', { minScore: MIN_SCORE, limitHistory: 2 })
  assert.equal(pkg.histories.length, 2)
  assert.equal(pkg.histories[0].conversationId, conversations[2].id)
  assert.equal(pkg.histories[1].conversationId, conversations[1].id)
})

// ------------------------------------------------------- edits and deletes --
test('edits and deletions are reflected on the very next call', async () => {
  const store = [makeMemory({ content: 'I love mountain hiking near the falls.' })]
  const client = new FakeClient(store, [])

  const before = await retrieveContextFrom(client, 'user-a', 'mountain hiking', { minScore: MIN_SCORE })
  assert.equal(before.memories.length, 1)

  store[0].content = 'Bought a red motor scooter for commuting.' // edit
  const afterEdit = await retrieveContextFrom(client, 'user-a', 'red scooter', { minScore: MIN_SCORE })
  assert.equal(afterEdit.memories.length, 1)
  assert.ok(afterEdit.memories[0].snippet.includes('red motor scooter'))

  store.splice(0, 1) // delete
  const afterDelete = await retrieveContextFrom(client, 'user-a', 'mountain hiking', { minScore: MIN_SCORE })
  assert.equal(afterDelete.memories.length, 0)
  assert.equal(afterDelete.lowConfidenceMemory, false)
})

// ------------------------------------------------- enrichment terms boost --
test('enrichment keywords feed ranking (still no hardcoded logic)', async () => {
  const memories = [
    makeMemory({ content: 'The interview day was long.', keywords: ['sql', 'java', 'join'] }),
    makeMemory({ content: 'The interview day was long.', keywords: ['cooking', 'pasta'] }),
  ]
  const client = new FakeClient(memories, [])
  const pkg = await retrieveContextFrom(client, 'user-a', 'sql java join', { minScore: MIN_SCORE })
  assert.equal(pkg.memories.length, 1)
  assert.equal(pkg.memories[0].memoryId, memories[0].id)
  assert.equal(pkg.memories[0].score, 1)
})

// --------------------------------------------- scored retrieval contract --
test('retrieveScoredMemoriesFrom exposes 0..1 scores, newest tiebreak', async () => {
  const m1 = makeMemory({ content: 'Project about solar panels.', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
  const m2 = makeMemory({ content: 'My final year project, solar powered charger.', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' })
  const client = new FakeClient([m1, m2], [])
  const rows = await retrieveScoredMemoriesFrom(client, 'user-a', 'solar project')
  assert.ok(rows.length >= 1)
  assert.ok(rows.every((r) => typeof r.score === 'number' && r.score >= 0 && r.score <= 1))
  assert.equal(rows[0].memoryId, m2.id) // higher overlap + newer
})

// -------------------------------------------- prompt is fully dynamic ------
test('buildContextPrompt renders four populated sections', async () => {
  const memories = [makeMemory({ content: 'Prepared SQL joins for the interview.' })]
  const conversations = [
    makeConv({
      title: 'Interview prep',
      messages: [
        { role: 'user', content: 'Prepared SQL and Java questions for the interview.' },
        { role: 'assistant', content: 'We practiced SQL joins together.' },
      ],
    }),
  ]
  const client = new FakeClient(memories, conversations)
  const pkg = await retrieveContextFrom(client, 'user-a', 'what did i prepare for the interview', {
    minScore: MIN_SCORE,
    currentConversation: {
      id: 'cur-1',
      messages: [{ role: 'user', content: 'I planted tomatoes.' }],
    },
  })
  const prompt = buildContextPrompt('what did i prepare for the interview', pkg)

  assert.ok(prompt.includes('CURRENT USER QUERY:\nwhat did i prepare for the interview'))
  assert.ok(prompt.includes('CURRENT CONVERSATION CONTEXT:'))
  assert.ok(prompt.includes('I planted tomatoes.'))
  assert.ok(prompt.includes('RELEVANT PREVIOUS CONVERSATIONS:'))
  assert.ok(prompt.includes('Interview prep'))
  assert.ok(prompt.includes('RELEVANT SAVED MEMORIES:'))
  assert.ok(prompt.includes(`id: ${memories[0].id}`))
  assert.ok(prompt.includes('SQL joins'))
})

test('buildContextPrompt renders None sections when a source is empty', () => {
  const pkg = {
    intent: { labels: [] },
    currentConversation: null,
    histories: [],
    memories: [],
    ambiguity: false,
    lowConfidenceMemory: false,
  }
  const prompt = buildContextPrompt('anything', pkg)
  assert.ok(prompt.includes('CURRENT CONVERSATION CONTEXT:\nNone yet.'))
  assert.ok(prompt.includes('RELEVANT PREVIOUS CONVERSATIONS:\nNone.'))
  assert.ok(prompt.includes('RELEVANT SAVED MEMORIES:\nNone.'))
})