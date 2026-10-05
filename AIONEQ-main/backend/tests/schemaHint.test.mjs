/*
 * Tests for schemaHint (utils/schemaHint.js).
 *
 * The behaviour that matters: a half-applied migration must produce the one
 * instruction that closes the gap, and an unrecognised error must pass through
 * untouched. Inventing a cause for an error we do not understand would send an
 * operator to run the wrong SQL.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { schemaHint } = await import('../src/utils/schemaHint.js')

test('schemaHint: a missing column names the migration that adds it', () => {
  // The exact PostgREST message seen on a project where memories.sql is applied
  // but context.sql / memory_intelligence.sql are not yet run.
  const hint = schemaHint('column memories.ai_summary does not exist')
  assert.match(hint, /ai_summary/)
  assert.match(hint, /sql\/context\.sql/)
  assert.doesNotMatch(hint, /does not exist/, 'raw Postgres text should be replaced')
})

test('schemaHint: each column maps to the file that actually creates it', () => {
  const cases = [
    ['column memories.keywords does not exist', 'sql/context.sql'],
    ['column memories.entities does not exist', 'sql/context.sql'],
    ['column memories.processing_status does not exist', 'sql/memory_intelligence.sql'],
    ['column memories.transcript does not exist', 'sql/memory_intelligence.sql'],
    ['column memories.topics does not exist', 'sql/memory_intelligence.sql'],
    ['column memories.file_size does not exist', 'sql/security.sql'],
    ['column memories.search_vector does not exist', 'sql/query.sql'],
    ['column memories.analysis_hash does not exist', 'sql/memories.sql'],
  ]
  for (const [raw, expected] of cases) {
    const hint = schemaHint(raw)
    assert.match(
      hint,
      new RegExp(expected.replace(/\//g, '\\/')),
      `"${raw}" should point at ${expected}`
    )
  }
})

test('schemaHint: a missing table names the migration that creates it', () => {
  const cases = [
    ['relation "public.memories" does not exist', 'sql/memories.sql'],
    ['relation "public.conversations" does not exist', 'sql/query.sql'],
    ['relation "public.memory_vectors" does not exist', 'sql/memory_intelligence.sql'],
    ["Could not find the table 'public.memory_settings' in the schema cache", 'sql/memory_intelligence.sql'],
    ['relation "public.legacy_grants" does not exist', 'sql/security.sql'],
  ]
  for (const [raw, expected] of cases) {
    const hint = schemaHint(raw)
    assert.match(
      hint,
      new RegExp(expected.replace(/\//g, '\\/')),
      `"${raw}" should point at ${expected}`
    )
  }
})

test('schemaHint: the quoted PostgREST column form is recognised too', () => {
  const hint = schemaHint('column "memories.ai_summary" does not exist')
  assert.match(hint, /sql\/context\.sql/)
})

test('schemaHint: an unknown column is flagged without guessing a file', () => {
  const hint = schemaHint('column memories.something_new does not exist')
  assert.match(hint, /something_new/)
  assert.match(hint, /incomplete or out of order/)
  assert.doesNotMatch(hint, /sql\/[a-z_]+\.sql/, 'must not invent a migration for an unknown column')
})

test('schemaHint: unrelated errors are passed through unchanged', () => {
  // Guard against the helper becoming a message mutator: anything it does not
  // recognise must survive intact, so real bugs stay diagnosable.
  for (const raw of [
    'Invalid login credentials',
    'new row violates row-level security policy for table "memories"',
    'Permission denied for function get_file_url_for_owner',
    '',
  ]) {
    assert.equal(schemaHint(raw), raw)
  }
})