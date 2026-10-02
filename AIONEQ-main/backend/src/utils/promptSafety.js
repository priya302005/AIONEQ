import { audit } from './audit.js'

/**
 * LLM context safety. Memory text is user-provided and could contain prompt
 * injection ("ignore previous instructions..."). Before inserting excerpts
 * into the LLM conversation we *flag* suspicious patterns (never silently
 * strip - EchoMind keeps behavior auditable) and bound the content.
 */

const INJECTION_PATTERNS = [
  /\bignore\b[\s\S]{0,40}\b(previous|prior|above|earlier|all)\b.{0,20}\binstructions?\b/i,
  /\bdisregard\b.{0,40}\b(previous|prior|above|earlier|system)\b/i,
  /\b(system prompt|developer message|you are now|now you are)\b/i,
  /\breset\b.{0,20}\b(instructions|conversation|context)\b/i,
  /\bdo not follow\b.{0,40}\binstructions?\b/i,
  /\brepeat\b.{0,30}\b(above|previous|system)\b/i,
]

export function findInjectionMarkers(text) {
  const hits = []
  for (const re of INJECTION_PATTERNS) {
    if (re.test(String(text || ''))) hits.push(String(re.source))
  }
  return hits
}

/**
 * Prepares a single memory excerpt for the LLM context.
 *  - flags (and audit-logs) suspected injection markers, keyed by memory id
 *    (content never reaches the audit log)
 *  - normalizes whitespace
 *  - bounds length defensively
 *
 * Returns { text, injection: boolean }.
 */
export function sanitizeExcerpt(text, memoryId, userId, ip, maxLength = 2000) {
  const safe = String(text || '').replace(/\s+/g, ' ').trim()
  const markers = findInjectionMarkers(safe)
  if (markers.length) {
    audit({
      action: 'query.prompt_injection_flagged',
      userId,
      ip,
      detail: { memoryId, markerCount: markers.length, markers },
    })
  }
  const bounded = safe.length > maxLength ? `${safe.slice(0, maxLength)}…` : safe
  return { text: bounded, injection: markers.length > 0 }
}