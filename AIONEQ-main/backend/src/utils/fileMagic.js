import fs from 'node:fs'

/**
 * Content sniffing for uploaded files. EchoMind must never trust a client's
 * declared MIME type or file extension (principle: zero trust between layers).
 * This module reads the first bytes of the file and matches them against the
 * known-good signatures for the types we accept.
 */

/** Read the first `n` bytes of a file synchronously. */
function head(filePath, n = 64) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(n)
    const bytes = fs.readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, bytes)
  } finally {
    fs.closeSync(fd)
  }
}

function startsWith(buf, hex, offset = 0) {
  return buf.length >= offset + hex.length && buf.subarray(offset, offset + hex.length).toString('hex') === hex
}

function ascii(buf, str, offset = 0) {
  return buf.length >= offset + str.length && buf.subarray(offset, offset + str.length).toString('latin1') === str
}

/**
 * Signatures per allowed MIME family.
 * Audio: id3/mp3, wav, ogg, webm (matroska), mp4/m4a, aac(adts).
 * Docs:  pdf, doc(docfile), docx/xlsx (zip), rtf, plain text (validated by
 *        absence of binary markers).
 */
const SIGNATURES = {
  'audio/mpeg': (b) => ascii(b, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  'audio/mp3': (b) => ascii(b, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  'audio/wav': (b) => ascii(b, 'RIFF') && ascii(b, 'WAVE', 8),
  'audio/x-wav': (b) => ascii(b, 'RIFF') && ascii(b, 'WAVE', 8),
  'audio/ogg': (b) => ascii(b, 'OggS'),
  'audio/webm': (b) => startsWith(b, '1a45dfa3'),
  'audio/mp4': (b) => ascii(b, 'ftyp', 4),
  'audio/x-m4a': (b) => ascii(b, 'ftyp', 4),
  'audio/aac': (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0,
  'application/pdf': (b) => ascii(b, '%PDF'),
  'application/msword': (b) => startsWith(b, 'd0cf11e0a1b11ae1'),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) =>
    startsWith(b, '504b0304') || startsWith(b, '504b0506'),
  'application/vnd.ms-excel': (b) => startsWith(b, 'd0cf11e0a1b11ae1'),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (b) =>
    startsWith(b, '504b0304') || startsWith(b, '504b0506'),
  'application/rtf': (b) => ascii(b, '{\\rtf'),
  'text/plain': (b) => !looksBinary(b),
  'text/markdown': (b) => !looksBinary(b),
  'text/csv': (b) => !looksBinary(b),
}

function looksBinary(buf) {
  // NUL byte or a high proportion of non-printable bytes => binary file.
  for (const byte of buf) if (byte === 0) return true
  let printable = 0
  for (const byte of buf) if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 160) printable++
  return printable / buf.length < 0.8
}

/**
 * Detects the real MIME type of a file from its content, choosing among the
 * allowed list. Returns the detected MIME or null.
 */
export function sniffMime(filePath, allowedMimes) {
  let bytes
  try {
    bytes = head(filePath, 64)
  } catch {
    return null
  }
  for (const mime of allowedMimes) {
    const check = SIGNATURES[mime]
    if (check) {
      try {
        if (check(bytes)) return mime
      } catch {
        /* malformed buffer - treat as no match */
      }
    }
  }
  return null
}

/**
 * Verifies that an uploaded file's real content matches its declared MIME
 * family. Returns `{ ok, detected, expected }`.
 */
export function verifyUpload(filePath, declaredMime, allowedMimes) {
  const detected = sniffMime(filePath, allowedMimes)
  if (!detected) return { ok: false, detected: null, expected: declaredMime }
  const declaredFamily = String(declaredMime || '').split('/')[0]
  const detectedFamily = detected.split('/')[0]
  const ok = detected === declaredMime || (declaredFamily === detectedFamily && detectedFamily === 'text') || detectedFamily === declaredFamily
  return { ok, detected, expected: declaredMime }
}