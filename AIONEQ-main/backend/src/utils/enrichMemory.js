/*
 * Best-effort memory enrichment (keywords / entities / ai_summary).
 *
 * Runs fire-and-forget after a memory is created or its content is edited.
 * Design rules:
 *   - It NEVER blocks or fails the save: every failure path returns null.
 *   - It NEVER rewrites original user content - metadata lives in separate
 *     columns (sql/context.sql) and is derived strictly from the note.
 *   - The LLM is asked to extract only, never to invent or interpret.
 */

import { config } from '../config/config.js'

const ENRICH_PROMPT = [
  'You extract metadata from a personal note. Use ONLY the text inside <note></note>.',
  'Return a single JSON object with exactly these keys:',
  '  {"keywords": string[], "entities": string[], "summary": string}',
  '  - keywords: 3 to 8 short lowercase topic words that capture what the note is about.',
  '  - entities: up to 5 proper nouns or named things clearly present in the note, or [].',
  '  - summary: one factual sentence summarizing the note. Use only information present in it.',
  'If there is no real content, return {"keywords":[],"entities":[],"summary":""}.',
  'Do not invent, interpret, or add anything that is not in the note.',
  '',
  '<note>',
  '{note}',
  '</note>',
].join('\n')

function cleanTokens(value, max) {
  if (!Array.isArray(value)) return []
  return value
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((s) => s && s.length <= 40)
    .slice(0, max)
}

function extractJson(raw) {
  const text = String(raw || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Enrich a saved memory row with metadata. Returns the metadata or null.
 * Never throws.
 */
export async function enrichMemory(token, memory) {
  if (!config.localEnrichMemories) return null
  try {
    const content = String(memory?.content || '').trim()
    const title = String(memory?.title || '').trim()
    if (!content && !title) return null

    const note = title ? `${title}\n${content}` : content
    const res = await fetch(`${config.localAiBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        model: config.localAiModel,
        messages: [
          { role: 'system', content: 'You extract JSON metadata. Answer with valid JSON only.' },
          { role: 'user', content: ENRICH_PROMPT.replace('{note}', note) },
        ],
        temperature: 0.2,
        max_tokens: 160,
        stream: false,
      }),
    })
    if (!res.ok) return null

    const data = await res.json().catch(() => null)
    const parsed = extractJson(data?.choices?.[0]?.message?.content)
    if (!parsed) return null

    const keywords = cleanTokens(parsed.keywords, 8)
    const entities = cleanTokens(parsed.entities, 5)
    const summary = String(parsed.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!keywords.length && !entities.length && !summary) return null

    const metadata = { keywords, entities, ai_summary: summary || null }
    // Column update is idempotent; if sql/context.sql has not been applied yet
    // the update simply fails silently and the memory remains fully functional.
    await updateMemoryMetadataRow(token, memory.id, metadata)
    return metadata
  } catch {
    return null
  }
}

// Local late import avoids a circular dependency with memory.model.js.
async function updateMemoryMetadataRow(token, id, payload) {
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const { error } = await client.from('memories').update(payload).eq('id', id)
  return { error }
}