/**
 * Actionable messages for "the schema is not fully applied yet".
 *
 * A fresh Supabase project has no EchoMind tables, and applying the migrations
 * one at a time leaves it half-migrated: the TABLE exists but the COLUMN a
 * query selects does not. Postgres reports both as an opaque `42P01 relation
 * ... does not exist` / `42703 column ... does not exist`, and PostgREST
 * forwards it verbatim, so the browser shows raw SQL instead of the one step
 * the operator actually has to take.
 *
 * This maps either shape to the specific file in backend/sql that closes the
 * gap. Unrecognised errors are returned unchanged - this must never invent a
 * cause for something it does not understand.
 */

// Which migration adds which column. The sets are disjoint, so order is only
// for readability; the first match wins.
const COLUMN_MIGRATIONS = [
  [/search_vector/i, 'sql/query.sql'],
  [/(ai_summary|keywords|entities)/i, 'sql/context.sql'],
  [
    /(transcript|extracted_text|topics|source_kind|processing_status|processing_stage|processing_error|processed_at)/i,
    'sql/memory_intelligence.sql',
  ],
  [/analysis_hash|duration|mime_type/i, 'sql/memories.sql'],
  [/file_size/i, 'sql/security.sql'],
]

const TABLE_MIGRATIONS = [
  [/memories/i, 'sql/memories.sql'],
  [/conversations/i, 'sql/query.sql'],
  [/(memory_vectors|memory_links|memory_settings)/i, 'sql/memory_intelligence.sql'],
  [/legacy_grants/i, 'sql/security.sql'],
]

const APPLY =
  'Apply it in the Supabase dashboard (SQL Editor -> New query -> Run). No restart needed - the next request retries.'

/**
 * @param {string} msg a raw Postgres/PostgREST error message
 * @returns {string} an actionable message, or `msg` unchanged if unrecognised
 */
export function schemaHint(msg) {
  const text = String(msg || '')

  // 'column memories.ai_summary does not exist' and the quoted PostgREST form
  // 'column "memories.ai_summary" does not exist'.
  const missingColumn = /column ["']?([\w]+)\.([\w]+)["']? does not exist|column ([\w]+) does not exist/i.exec(text)
  if (missingColumn) {
    const column = missingColumn[2] || missingColumn[3]
    const match = COLUMN_MIGRATIONS.find(([re]) => re.test(column))
    if (match) {
      return `Database is missing the "${column}" column. ${match[1]} adds it. ${APPLY}`
    }
    return `Database is missing the "${column}" column. Check backend/sql/ - the migrations may be incomplete or out of order.`
  }

  // 'relation "public.memories" does not exist' or PostgREST's
  // "Could not find the table 'public.memories' in the schema cache".
  const missingTable = /relation ["']?([\w.]+)["']? does not exist|could not find the table ['"]?([\w.]+)['"]?/i.exec(text)
  if (missingTable) {
    const table = (missingTable[1] || missingTable[2] || '').split('.').pop()
    const match = TABLE_MIGRATIONS.find(([re]) => re.test(table))
    if (match) {
      return `Database is missing the "${table}" table. ${match[1]} creates it. ${APPLY}`
    }
    return `Database is missing the "${table}" table. Check backend/sql/ - the migrations may be incomplete or out of order.`
  }

  return msg
}