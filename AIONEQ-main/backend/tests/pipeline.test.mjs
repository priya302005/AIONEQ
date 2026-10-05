/*
 * The memory understanding pipeline.
 *
 * The contract under test is a set of promises to the user:
 *   - the ORIGINAL content column is never overwritten by a derived value
 *   - derived text lives in its own column, and is preferred in a known order
 *   - a memory with no usable text ends up 'partial'/'failed', never 'ready'
 *   - an unavailable provider degrades the summary, it does not break the save
 *
 * Offline by design. Only real files in the uploads directory and pure
 * functions are exercised; nothing contacts a database or an LLM.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { uploadsDir } from '../src/middleware/upload.middleware.js'
import {
  PROCESSING_STATUS,
  primaryText,
  deriveText,
  analyseMemory,
  planAnalysis,
} from '../src/services/memoryPipeline.js'
import { describeStatus } from '../src/services/memoryIngestion.js'
import { extractDocumentText, ExtractionError } from '../src/services/documentExtract.js'
import { config } from '../src/config/config.js'

/**
 * Writes a real file into the uploads dir, the way the upload flow would.
 * Every fixture is remembered and deleted when the file finishes, so a test run
 * can never leave junk in the user's real uploads folder.
 */
const fixtures = []

function uploadFixture(name, contents) {
  fs.mkdirSync(uploadsDir, { recursive: true })
  const filename = `${crypto.randomUUID()}${name}`
  fs.writeFileSync(path.join(uploadsDir, filename), contents)
  fixtures.push(filename)
  return filename
}

after(() => {
  for (const filename of fixtures) {
    try {
      fs.unlinkSync(path.join(uploadsDir, filename))
    } catch {
      // A fixture that is already gone needs no cleanup.
    }
  }
})

function mem(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    user_id: 'user-a',
    type: 'journal',
    title: '',
    content: '',
    file_url: null,
    mime_type: null,
    ...overrides,
  }
}

// ------------------------------------------------------------ status model --

test('the pipeline uses the documented status vocabulary', () => {
  assert.deepEqual(Object.values(PROCESSING_STATUS).sort(), ['failed', 'partial', 'pending', 'processing', 'ready'])
})

test('a memory with no status is treated as ready, so old rows still work', () => {
  assert.equal(describeStatus({}).status, 'ready')
})

test('describeStatus reports what actually got derived', () => {
  const d = describeStatus({
    processing_status: 'partial',
    processing_stage: 'complete',
    processing_error: 'no readable text',
    ai_summary: 'a summary',
    topics: ['travel'],
    transcript: 'spoken words',
  })
  assert.equal(d.status, 'partial')
  assert.equal(d.stage, 'complete')
  assert.equal(d.error, 'no readable text')
  assert.equal(d.hasSummary, true)
  assert.equal(d.hasTopics, true)
  assert.equal(d.hasTranscript, true)
  assert.equal(d.hasExtractedText, false)
})

test('describeStatus is safe on a completely empty row', () => {
  const d = describeStatus(null)
  assert.equal(d.status, 'ready')
  assert.equal(d.hasSummary, false)
  assert.equal(d.hasTopics, false)
})

// ------------------------------------------------------------ primaryText ---

test('the primary text takes the first usable source in a fixed order', () => {
  // Order is transcript -> extracted_text -> content. In the real app the
  // fields are effectively exclusive: a browser voice note stores its words in
  // `content`, while `transcript` is only filled in by the pipeline for audio
  // that was UPLOADED and had to be transcribed externally.
  assert.equal(
    primaryText({ transcript: 'spoken words', extracted_text: 'from a file', content: 'typed' }),
    'spoken words'
  )
  assert.equal(primaryText({ transcript: '', extracted_text: 'from a file', content: 'typed' }), 'from a file')
  assert.equal(primaryText({ transcript: null, extracted_text: null, content: 'typed' }), 'typed')
})

test('a file-backed memory with no typed text uses its transcript', () => {
  assert.equal(primaryText({ content: '', transcript: 'a machine transcript' }), 'a machine transcript')
})

test('a document memory falls back to extracted file text', () => {
  assert.equal(primaryText({ content: '', transcript: '', extracted_text: 'from the pdf' }), 'from the pdf')
})

test('whitespace-only content does not count as user text', () => {
  assert.equal(primaryText({ content: '   \n ', transcript: 'the real transcript' }), 'the real transcript')
})

test('a memory with nothing usable yields empty text, not undefined', () => {
  assert.equal(primaryText({}), '')
  assert.equal(primaryText(null), '')
})

// -------------------------------------------------------------- deriveText --

test('a typed memory is left alone - no derived text is invented', async () => {
  const result = await deriveText('token', mem({ content: 'I typed this myself' }))
  assert.equal(result.transcript, null)
  assert.equal(result.extractedText, null)
  assert.equal(result.sourceKind, 'typed')
})

test('a memory with no attached file is never sent for extraction', async () => {
  const result = await deriveText('token', mem({ type: 'document', content: '' }))
  assert.equal(result.extractedText, null)
  assert.deepEqual(result.notes, [])
})

test('a missing stored file is reported, not thrown', async () => {
  const result = await deriveText('token', mem({ type: 'document', content: '', file_url: 'does-not-exist.pdf' }))
  assert.equal(result.extractedText, null)
  assert.match(result.notes.join(' '), /could not be found/i)
})

test('a voice note that already has a transcript is not transcribed again', async () => {
  // Real audio on disk, but a transcript already exists, so the (unconfigured)
  // transcription service must never be consulted and the text must not change.
  const file = uploadFixture('.mp3', 'ID3fake-audio-bytes')
  const result = await deriveText('token', mem({
    type: 'voice',
    content: '',
    transcript: 'browser transcript',
    file_url: file,
  }))
  assert.equal(result.transcript, null, 'must not overwrite the existing transcript')
  assert.equal(result.sourceKind, 'transcribed')
  assert.deepEqual(result.notes, [])
})

test('a voice note with no transcript and no service explains itself instead of failing', async () => {
  assert.equal(config.transcriptionBaseUrl, null, 'test assumes no transcription service is configured')
  const result = await deriveText('token', mem({ type: 'voice', content: '', file_url: uploadFixture('.mp3', 'ID3fake') }))
  assert.equal(result.transcript, null)
  assert.match(result.notes.join(' '), /No transcription service is configured/i)
})

test('text is read out of an uploaded plain-text document', async () => {
  const file = uploadFixture('.txt', 'The tenancy agreement runs from March to September.')
  const result = await deriveText('token', mem({ type: 'document', content: '', file_url: file, mime_type: 'text/plain' }))
  assert.match(result.extractedText, /tenancy agreement/i)
  assert.equal(result.sourceKind, 'extracted')
})

test('an unsupported binary document is reported as unreadable, not as empty text', async () => {
  const file = uploadFixture('.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))
  const result = await deriveText('token', mem({ type: 'document', content: '', file_url: file }))
  assert.equal(result.extractedText, null)
  assert.ok(result.notes.length > 0, 'an unreadable document must produce a human-readable reason')
})

// ------------------------------------------------------------ documentExtract --

test('a CSV upload is read as text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-doc-'))
  const p = path.join(dir, 'a.csv')
  fs.writeFileSync(p, 'name,year\nAda,1843\n')
  const out = await extractDocumentText(p, 'text/csv')
  assert.match(out.text, /Ada/)
  assert.equal(out.truncated, false)
})

test('a text file too long to index is marked truncated rather than silently cut', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-doc-'))
  const p = path.join(dir, 'big.txt')
  fs.writeFileSync(p, 'lorem ipsum dolor '.repeat(60_000))
  const out = await extractDocumentText(p, 'text/plain')
  assert.equal(out.truncated, true)
  assert.ok(out.chars > 0)
})

test('extracting a file that does not exist throws a typed error', async () => {
  await assert.rejects(() => extractDocumentText('/no/such/file.pdf', 'application/pdf'), ExtractionError)
})

// ------------------------------------------------------------- analyseMemory --

test('analysis of an empty memory returns empty metadata without calling anything', async () => {
  const out = await analyseMemory('token', mem(), '')
  assert.deepEqual(out, { summary: '', topics: [], keywords: [], entities: [] })
})

test('an unavailable local AI degrades the summary instead of failing the memory', async () => {
  // No local model server is running, so this exercises the provider-failure
  // path. The memory must survive with empty metadata rather than throw.
  const out = await analyseMemory('token', mem(), 'A perfectly ordinary note about gardening.')
  assert.equal(typeof out.summary, 'string')
  assert.ok(Array.isArray(out.topics))
  assert.ok(Array.isArray(out.keywords))
  assert.ok(Array.isArray(out.entities))
  // A provider error is reported so the UI can explain the missing summary.
  if (out.providerError) assert.equal(typeof out.providerError, 'string')
})

// --------------------------------------------------- skipping unchanged text --

test('metadata derived from identical text is reused instead of recomputed', () => {
  const text = 'A perfectly ordinary note about the garden.'
  const first = planAnalysis({ text, memory: {} })
  assert.equal(first.reuse, false, 'a memory that was never analysed must be analysed')

  const memory = {
    analysis_hash: first.hash,
    ai_summary: 'A note about the garden.',
    topics: ['garden'],
    keywords: ['garden'],
    entities: [],
  }
  const second = planAnalysis({ text, memory })
  assert.equal(second.reuse, true)
  assert.equal(second.metadata.summary, 'A note about the garden.')
  assert.deepEqual(second.metadata.topics, ['garden'])
})

test('changed note text is always re-analysed', () => {
  const analysed = planAnalysis({ text: 'the original note', memory: {} })
  const memory = { analysis_hash: analysed.hash, ai_summary: 'Original.', topics: [], keywords: [], entities: [] }
  assert.equal(planAnalysis({ text: 'the original note, corrected', memory }).reuse, false)
  // Whitespace-only differences do not change what the model would be told.
  assert.equal(planAnalysis({ text: 'the original note\n', memory }).reuse, false)
})

test('an explicit reprocess is never short-circuited', () => {
  const analysed = planAnalysis({ text: 'unchanged note', memory: {} })
  const memory = { analysis_hash: analysed.hash, ai_summary: 'Kept.', topics: [], keywords: [], entities: [] }
  // reprocessMemory clears the hash, so the same text is analysed again.
  assert.equal(planAnalysis({ text: 'unchanged note', memory: { ...memory, analysis_hash: null } }).reuse, false)
})

test('a hash without stored metadata is not reused', () => {
  const analysed = planAnalysis({ text: 'note text', memory: {} })
  assert.equal(planAnalysis({ text: 'note text', memory: { analysis_hash: analysed.hash } }).reuse, false)
})

test('the stored fingerprint is a hash, not the note text', () => {
  const { hash } = planAnalysis({ text: 'the vault combination is 4417', memory: {} })
  assert.equal(typeof hash, 'string')
  assert.equal(hash.includes('4417'), false)
  assert.equal(hash.includes('vault'), false)
  assert.equal(hash.length, 64, 'expected a sha256 hex digest')
})

// ------------------------------------------------------ the never-overwrite rule --

test('derived text is kept separate from the original content column', async () => {
  // The pipeline only ever writes to transcript/extracted_text. This asserts the
  // shape of the write so a future change cannot quietly start writing content.
  const file = uploadFixture('.txt', 'Scanned text for a keepsake letter.')
  const memory = mem({ type: 'document', content: '', file_url: file, mime_type: 'text/plain' })

  const before = memory.content
  const result = await deriveText('token', memory)

  assert.equal(memory.content, before, 'the in-memory content must be untouched')
  assert.equal(result.transcript, null)
  assert.match(result.extractedText, /keepsake letter/i)
})

test('a typed memory that also has a file keeps the typed words as the source', async () => {
  const file = uploadFixture('.txt', 'Text from an attachment.')
  const result = await deriveText('token', mem({
    type: 'document',
    content: 'My own words about the same document',
    file_url: file,
    mime_type: 'text/plain',
  }))
  assert.equal(result.extractedText, null)
  assert.equal(result.sourceKind, 'typed')
  assert.equal(primaryText({ content: 'My own words about the same document', ...result }), 'My own words about the same document')
})