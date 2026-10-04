/*
 * Text extraction from uploaded documents.
 *
 * Purpose: an uploaded PDF or Word file is invisible to retrieval until it has
 * text. The original file is never modified or replaced - extracted text is
 * stored in a separate column (memories.extracted_text) and the bytes on disk
 * are untouched.
 *
 * Supported without any new dependency (Node built-ins only):
 *   text/plain, text/markdown, text/csv  -> decoded as UTF-8
 *   application/rtf                      -> RTF control-word stripping
 *   application/pdf                      -> content-stream text operator scan
 *   .doc / .docx / .xls / .xlsx         -> returns a clear reason: these are
 *                                          legacy binary/OXML containers and
 *                                          are not parsed without adding a
 *                                          dependency the project does not need.
 *
 * The PDF reader handles uncompressed and Flate-compressed (zlib, built into
 * Node) content streams, which covers text-based PDFs. Scanned/image-only PDFs
 * legitimately yield nothing - that is reported as 'unsupported', never as a
 * crash, and the memory remains usable via its title, tags and file.
 *
 * SECURITY: document content is untrusted input. Everything returned here is
 * plain text destined for the user's own archive; it is wrapped and flagged by
 * promptSafety.sanitizeExcerpt before it ever reaches a model, and it is never
 * executed.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { config } from '../config/config.js'

const MAX_CHARS = config.pipelineMaxChars

export class ExtractionError extends Error {
  constructor(message, { code = 'extract_failed' } = {}) {
    super(message)
    this.code = code
  }
}

/** Result shape: { text, kind, chars, truncated } */
function ok(text, kind) {
  const clean = String(text || '').replace(/\u0000/g, '').trim()
  const truncated = clean.length > MAX_CHARS
  return {
    text: truncated ? clean.slice(0, MAX_CHARS) : clean,
    kind,
    chars: clean.length,
    truncated,
  }
}

function unsupported(reason, code = 'unsupported_format') {
  const err = new ExtractionError(reason, { code })
  err.unsupported = true
  return err
}

function decodeTextBuffer(buf) {
  // Honour a UTF-8 BOM, otherwise assume UTF-8 and let Node replace any
  // invalid sequence rather than throwing.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  return buf.toString('utf8')
}

// --------------------------------------------------------------- RTF -------

const RTF_UNICODE = /\\u(-?\d+)\s?\??/g
const RTF_HEX = /\\'([0-9a-fA-F]{2})/g

function rtfToText(input) {
  let text = input

  // Unicode escapes first: \u8217 ? -> the actual code point.
  text = text.replace(RTF_UNICODE, (_m, code) => {
    const n = Number(code)
    if (!Number.isFinite(n)) return ''
    return n < 0 ? String.fromCharCode(65536 + n) : String.fromCharCode(n)
  })
  text = text.replace(RTF_HEX, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))

  // Drop the control group containing the font/color tables. Their contents
  // are hex and control words, never readable prose.
  text = text.replace(/{\\(?:fonttbl|colortbl|stylesheet|info|\*)[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/gi, ' ')
  // Paragraph and line breaks.
  text = text.replace(/\\par[d]?/gi, '\n').replace(/\\line/g, '\n').replace(/\\tab/g, '\t')
  // Any remaining control word (with its numeric or textual argument).
  text = text.replace(/\\[a-z]+-?\d* ?/gi, '')
  // Escaped literals.
  text = text.replace(/\\([{}~_])/g, '$1')
  // Braces.
  text = text.replace(/[{}]/g, ' ')
  return text
}

// ---------------------------------------------------------------- PDF -------
// Minimal text-operator reader. Text in a PDF content stream appears inside
// BT ... ET as (literal) Tj  or  [(a) -20 (b)] TJ, and is positioned with Td /
// TD / T* which we turn into line breaks.

function decodePdfString(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[++i]
    switch (next) {
      case 'n': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case '(': out += '('; break
      case ')': out += ')'; break
      case '\\': out += '\\'; break
      case '\n': case '\r': break // line continuation
      default:
        if (/[0-7]/.test(next)) {
          // Octal escape, up to 3 digits.
          let oct = next
          while (oct.length < 3 && /[0-7]/.test(raw[i + 1] || '')) oct += raw[++i]
          out += String.fromCharCode(parseInt(oct, 8))
        } else {
          out += next
        }
    }
  }
  return out
}

function unescapePdfLiteral(str) {
  let depth = 0
  let out = ''
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '\\') {
      out += ch + (str[i + 1] || '')
      i++
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') {
      depth--
      continue
    }
    out += ch
  }
  return decodePdfString(out)
}

/** Reads a balanced ( ... ) literal starting at the '(' index. */
function readPdfLiteral(src, start) {
  let depth = 0
  let out = ''
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') {
      out += ch + (src[i + 1] || '')
      i++
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return { value: unescapePdfLiteral(out), end: i + 1 }
      continue
    }
    if (depth > 0) out += ch
  }
  return { value: out, end: src.length }
}

/** Reads a <hex> string, applying the PDF's UTF-16BE-ish hex convention. */
function readPdfHex(src, start) {
  const close = src.indexOf('>', start)
  if (close === -1) return { value: '', end: src.length }
  const hex = src.slice(start + 1, close).replace(/[^0-9a-fA-F]/g, '')
  let out = ''
  for (let i = 0; i + 3 < hex.length; i += 4) {
    const code = parseInt(hex.slice(i, i + 4), 16)
    if (code >= 32 && code < 0xd800) out += String.fromCharCode(code)
  }
  return { value: out, end: close + 1 }
}

function extractPdfTextFromContent(content) {
  const out = []
  let i = 0
  while (i < content.length) {
    const ch = content[i]

    if (ch === '(') {
      const { value, end } = readPdfLiteral(content, i)
      if (value) out.push(value)
      i = end
      continue
    }
    if (ch === '<' && content[i + 1] !== '<') {
      const { value, end } = readPdfHex(content, i)
      if (value) out.push(value)
      i = end
      continue
    }
    if (ch === 'T') {
      // Line-advance operators become newlines so extracted text is readable.
      if (content.startsWith('Td', i) || content.startsWith('TD', i) || content.startsWith('T*', i)) {
        out.push('\n')
      }
      i += 2
      continue
    }
    if (ch === 'E' && content.startsWith('ET', i)) {
      out.push('\n')
      i += 2
      continue
    }
    i++
  }
  return out.join('')
}

function inflatePdfStreams(buf) {
  const chunks = []
  const marker = Buffer.from('stream')
  const endMarker = Buffer.from('endstream')
  let from = 0

  while (true) {
    const s = buf.indexOf(marker, from)
    if (s === -1) break
    // `stream` must be followed by CRLF or LF.
    let start = s + marker.length
    if (buf[start] === 0x0d) start++
    if (buf[start] === 0x0a) start++
    const e = buf.indexOf(endMarker, start)
    if (e === -1) break
    const raw = buf.subarray(start, e)

    // Try raw deflate first, then zlib-wrapped (what /FlateDecode usually is).
    for (const fn of [zlib.inflateSync, zlib.inflateRawSync, zlib.gunzipSync]) {
      try {
        chunks.push(fn(raw))
        break
      } catch {
        /* try the next codec */
      }
    }
    from = e + endMarker.length
  }
  return chunks
}

function extractPdf(buf) {
  const head = buf.subarray(0, 1024).toString('latin1')
  if (!head.includes('%PDF-')) {
    throw unsupported('This file does not look like a PDF.', 'not_a_pdf')
  }

  const streams = [buf.toString('latin1'), ...inflatePdfStreams(buf).map((c) => c.toString('latin1'))]
  const pieces = []
  let sawPageText = false

  for (const stream of streams) {
    const text = extractPdfTextFromContent(stream)
    if (text.trim()) {
      sawPageText = true
      pieces.push(text)
    }
  }

  let text = pieces.join('\n')
    // Normalise whitespace but keep paragraph structure.
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!sawPageText) {
    // Almost always a scanned/image-only PDF. Say so precisely instead of
    // pretending the document was empty.
    throw unsupported(
      'No embedded text found in this PDF (it is likely a scan or image-only document). The file is preserved and can still be opened; add a transcript or notes as text to make it searchable.',
      'pdf_no_text'
    )
  }
  return text
}

// ------------------------------------------------------------ dispatch ------

function kindFor(mimeType, filePath = '') {
  const mime = String(mimeType || '').toLowerCase()
  const ext = path.extname(filePath).toLowerCase()
  if (mime.startsWith('text/') || ['.txt', '.md', '.csv', '.log'].includes(ext)) return 'text'
  if (mime === 'application/rtf' || ext === '.rtf') return 'rtf'
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf'
  if (mime.includes('word') || mime.includes('excel') || ['.doc', '.docx', '.xls', '.xlsx'].includes(ext)) return 'office'
  return null
}

/**
 * Extract text from an uploaded document.
 *
 * @param {string} filePath absolute path on disk
 * @param {string} mimeType declared MIME type
 * @returns {Promise<{text:string,kind:string,chars:number,truncated:boolean}>}
 * @throws {ExtractionError} with `.unsupported = true` for formats we
 *         deliberately do not parse, so the caller can report a precise reason
 *         and leave the memory usable instead of failing the save.
 */
export async function extractDocumentText(filePath, mimeType) {
  if (!config.documentExtractionEnabled) {
    throw unsupported('Document text extraction is turned off for this account.', 'extraction_disabled')
  }

  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat) throw new ExtractionError('The uploaded file is no longer available.')

  const kind = kindFor(mimeType, filePath)
  if (!kind) {
    throw unsupported('This file type has no text that can be extracted.', 'unsupported_format')
  }
  if (kind === 'office') {
    throw unsupported(
      'Word and Excel files are binary containers. Open the file and paste the relevant text into this memory to make it searchable.',
      'office_binary'
    )
  }

  const buf = await fs.readFile(filePath)
  if (buf.length > config.documentExtractionMaxBytes) {
    throw new ExtractionError('The file is too large to extract text from.', { code: 'too_large' })
  }

  if (kind === 'text') return ok(decodeTextBuffer(buf), 'text')
  if (kind === 'rtf') return ok(rtfToText(decodeTextBuffer(buf)), 'rtf')
  if (kind === 'pdf') return ok(extractPdf(buf), 'pdf')

  throw unsupported('This file type has no text that can be extracted.', 'unsupported_format')
}

export default extractDocumentText