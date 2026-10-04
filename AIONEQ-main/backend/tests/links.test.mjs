/*
 * Memory evolution ("links").
 *
 * The single most important property here is negative: automatic detection may
 * only ever CREATE A PROPOSAL. It must never merge, rewrite, supersede or
 * delete a memory on its own. Only an explicit user approval, through
 * PATCH /api/memory-links/:id, may change what an answer treats as current.
 *
 * Offline: no database, no LLM (the model refinement degrades to null and the
 * deterministic classifier still decides the relation).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LINK_RELATIONS, LINK_STATUSES, detectLinks, resolvedLinks } from '../src/services/memoryLinks.js'

// The relation vocabulary is exactly the four relations that can be stored.
// 'none' is deliberately NOT one of them: a pair with no real relationship is
// simply not proposed at all.
test('link relations are limited to the documented vocabulary', () => {
  assert.deepEqual([...LINK_RELATIONS].sort(), ['duplicate', 'follow_up', 'related', 'supersedes'])
})

test('a detected finding starts as a proposal and only the user can resolve it', () => {
  assert.deepEqual([...LINK_STATUSES].sort(), ['approved', 'proposed', 'rejected'])
})

// ------------------------------------------------------------- detectLinks --

const baseMemory = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: 'user-a',
  type: 'journal',
  title: 'Moving house',
  content: 'We signed the lease for the flat on Elm Road and the move happens in June.',
  tags: [],
  topics: [],
  keywords: [],
  entities: [],
  event_date: '2026-06-01T00:00:00Z',
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
}

test('detection refuses to run without a memory or owner', async () => {
  assert.deepEqual(await detectLinks('token', null), [])
  assert.deepEqual(await detectLinks('token', { id: null, user_id: 'user-a' }), [])
})

test('detection returns nothing rather than throwing when the database is unreachable', async () => {
  // No Supabase configured in the test environment, so the candidate query
  // fails. Detection must degrade to "no suggestions", never crash the save.
  const out = await detectLinks('not-a-real-token', baseMemory)
  assert.ok(Array.isArray(out))
  assert.equal(out.length, 0)
})

test('detection never mutates the memory it was given', async () => {
  const snapshot = JSON.stringify(baseMemory)
  await detectLinks('not-a-real-token', baseMemory)
  assert.equal(JSON.stringify(baseMemory), snapshot, 'the caller row must be untouched')
})

// ----------------------------------------------------------- resolvedLinks --

test('resolved links degrade to an empty list when the database is unreachable', async () => {
  assert.deepEqual(await resolvedLinks('not-a-real-token', 'user-a', ['a', 'b']), [])
})

test('an empty id list short-circuits without touching the database', async () => {
  assert.deepEqual(await resolvedLinks('token', 'user-a', []), [])
  assert.deepEqual(await resolvedLinks('token', 'user-a', null), [])
  assert.deepEqual(await resolvedLinks('token', 'user-a', 'not-an-array'), [])
})

// ------------------------------------------------- the never-auto-merge rule --

test('the proposal wording tells the user nothing has changed', async () => {
  // The detail string is what the user sees next to a suggestion, so it has to
  // be unambiguous that a suggestion is inert until approved.
  const { default: fs } = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/services/memoryLinks.js', import.meta.url), 'utf8')
  assert.match(src, /Nothing has been changed - approve only if this is right\./)
})

test('no production code path auto-approves a detected link', async () => {
  const fs = await import('node:fs')
  const dir = new URL('../src/', import.meta.url)
  const files = []
  const walk = (url) => {
    for (const entry of fs.readdirSync(url, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, url)
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.js')) files.push(child)
    }
  }
  walk(dir)

  // `resolveMemoryLink(...)` is the ONLY writer of an approved/rejected status,
  // and it lives in the model layer. No service may call it: only the controller
  // that serves PATCH /api/memory-links/:id, i.e. an explicit user action.
  const callers = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    // Match a real call, not the `resolveMemoryLinkSchema` zod validator.
    if (/resolveMemoryLink\s*\(/.test(src) && !/models\/memoryLink\.model\.js/.test(f.pathname)) {
      callers.push(f.pathname.split('/').slice(-2).join('/'))
    }
  }
  assert.deepEqual(callers, ['controllers/memoryLink.controller.js'])
})

test('detection never deletes or merges content', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/services/memoryLinks.js', import.meta.url), 'utf8')
  // A merge would have to delete or overwrite a memory row. Neither is allowed.
  assert.equal(/\.delete\(\)/.test(src), false, 'link detection must not delete anything')
  assert.equal(/\.update\(/.test(src), false, 'link detection must not update any memory row')
})