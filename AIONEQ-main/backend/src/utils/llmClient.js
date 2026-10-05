/*
 * Single client for the local AI provider.
 *
 * The project talks to a llama.cpp `llama-server` (or any OpenAI-compatible
 * server) on localhost. Before this module the same three calls - chat,
 * raw completion, embedding - were hand-rolled in four different files. This
 * is the only place that knows the wire format, the timeouts and the error
 * messages, so provider failures look the same everywhere.
 *
 * Every call has a timeout, a bounded retry for transient failures, and returns
 * a typed result rather than throwing raw network errors into controllers.
 */

import { config } from '../config/config.js'
import { embeddingIdentity } from './embeddings.js'

export class ProviderError extends Error {
  constructor(message, { code = 'provider_error', status = 502, retryable = false } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

/** llama.cpp is local: a slow response means something is wrong, not "busy". */
const DEFAULT_TIMEOUT_MS = 20_000

/** Never wait longer than this for a retry after a 429, whatever the server asks for. */
const MAX_RETRY_AFTER_MS = 2_000

function endpointUrl(path) {
  return `${config.localAiBaseUrl.replace(/\/+$/, '')}${path}`
}

function truncate(text, max = 200) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * The sampling parameters shared by chat and raw completions.
 *
 * They used to be literals in the request bodies. They are configuration now so
 * a different model can be tuned (or a provider's own limits respected) without
 * editing code - the defaults are unchanged.
 */
function sampling({ temperature, topP, repeatPenalty, frequencyPenalty, presencePenalty } = {}) {
  return {
    temperature: temperature ?? config.aiTemperature,
    top_p: topP ?? config.aiTopP,
    repeat_penalty: repeatPenalty ?? config.aiRepeatPenalty,
    frequency_penalty: frequencyPenalty ?? config.aiFrequencyPenalty,
    presence_penalty: presencePenalty ?? config.aiPresencePenalty,
  }
}

/** A server that asks us to wait is honoured, but only briefly. */
function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after')
  if (!raw) return 250
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return 250
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(50, seconds * 1000))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function postJson(path, body, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1 } = {}) {
  let lastError = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res
    try {
      res = await fetch(endpointUrl(path), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.localAiApiKey ? { Authorization: `Bearer ${config.localAiApiKey}` } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(body),
      })
    } catch (err) {
      // A timeout and a refused connection are different failures and the
      // operator needs to be told which one happened: the first means the model
      // is too slow (or too big) for AI_TIMEOUT_MS, the second that it is not
      // running at all. Both are retryable, neither is a client error.
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      lastError = timedOut
        ? new ProviderError(
            `The local AI at ${config.localAiBaseUrl} did not answer within ` +
              `${timeoutMs}ms. Raise AI_TIMEOUT_MS, use a smaller/faster model, or ` +
              'reduce QUERY_MAX_MEMORIES.',
            { code: 'provider_timeout', status: 504, retryable: true }
          )
        : new ProviderError(
            `Cannot reach the local AI at ${config.localAiBaseUrl}. Make sure the server is running there with its API enabled ` +
              `(e.g. llama-server -m model.gguf --port 4891).`,
            { code: 'provider_unreachable', retryable: true }
          )
      lastError.cause = err
      if (attempt === retries) throw lastError
      continue
    }

    if (res.ok) {
      const data = await res.json().catch(() => null)
      if (!data) {
        throw new ProviderError('The local AI returned an unreadable response.', { code: 'provider_bad_response' })
      }
      return data
    }

    const raw = await res.text().catch(() => '')

    // Rate limiting is its own case: the request was valid, the server is just
    // refusing to do it now. It is reported separately so a caller can tell
    // "slow down" apart from "broken".
    if (res.status === 429) {
      lastError = new ProviderError(`The local AI is rate limiting requests (429).`, {
        code: 'provider_rate_limited',
        status: 503,
        retryable: true,
      })
      if (attempt === retries) throw lastError
      await sleep(retryAfterMs(res.headers))
      continue
    }

    // 5xx is worth one more try; a 4xx is a client bug, do not hammer.
    const retryable = res.status >= 500
    lastError = new ProviderError(`Local AI error (${res.status}): ${truncate(raw)}`, {
      code: 'provider_http_error',
      status: res.status,
      retryable,
    })
    if (!retryable || attempt === retries) throw lastError
  }

  throw lastError || new ProviderError('The local AI request failed.')
}

/**
 * Reads the completion envelope. A 200 with a body that is not a completion is
 * a provider fault (a proxy error page, an HTML login screen, a truncated
 * body), and must never be mistaken for "the model chose to say nothing" -
 * that path returns an honest fallback to the user instead of an error.
 */
function readCompletion(data, { compact }) {
  if (!data || !Array.isArray(data.choices) || !data.choices.length) {
    throw new ProviderError('The local AI returned a response that was not a completion.', {
      code: 'provider_bad_response',
    })
  }
  const choice = data.choices[0]
  const text = compact
    ? String(choice?.text ?? '')
    : String(choice?.message?.content ?? choice?.text ?? '')
  return {
    text: text.trim(),
    // Token accounting is optional: llama.cpp reports usage, some proxies do not.
    usage: normalizeUsage(data.usage),
    finishReason: String(choice?.finish_reason || data.finish_reason || ''),
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
  const prompt = n(usage.prompt_tokens ?? usage.input_tokens)
  const completion = n(usage.completion_tokens ?? usage.output_tokens)
  const total = n(usage.total_tokens) ?? (prompt != null || completion != null ? (prompt || 0) + (completion || 0) : null)
  if (prompt == null && completion == null && total == null) return null
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total }
}

/** Cheap liveness probe. Used to decide whether enrichment should even run. */
export async function pingProvider({ timeoutMs = 2000 } = {}) {
  try {
    const res = await fetch(endpointUrl('/health'), { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok || res.status === 404 // 404 still means "server is there"
  } catch {
    return false
  }
}

/** True when the provider looks reachable. Never throws. */
export async function isProviderReachable() {
  if (await pingProvider()) return true
  try {
    await postJson('/v1/completions', { model: config.localAiModel, prompt: ' ', max_tokens: 1, stream: false }, { timeoutMs: 4000, retries: 0 })
    return true
  } catch {
    return false
  }
}

/**
 * Instruct-style chat completion (OpenAI /v1/chat/completions).
 *
 * `chatCompletionResult` returns the full detail ({ text, usage, ... });
 * `chatCompletion` is the long-standing string-returning wrapper around it and
 * is kept so existing call sites keep working unchanged.
 */
export async function chatCompletionResult({ system, user, maxTokens = config.aiMaxTokens, temperature, timeoutMs, retries, ...rest }) {
  const data = await postJson(
    '/v1/chat/completions',
    {
      model: config.localAiModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...sampling({ temperature, ...rest }),
      max_tokens: maxTokens,
      stream: false,
    },
    { timeoutMs, retries }
  )
  return readCompletion(data, { compact: false })
}

/**
 * Streaming instruct-style chat completion.
 *
 * Yields raw text deltas as the model produces them. Used by the Ask endpoint so
 * the reply starts appearing immediately instead of after the whole answer is
 * generated and grounded. On CPU that is roughly 1s to first text versus 4-10s
 * of an empty bubble, for the same model and the same answer.
 *
 * Safety note: this yields UNVERIFIED model text. Callers must ground what they
 * emit - see the sentence-level pass in query.controller.js. Nothing here should
 * ever reach the user ungrounded.
 */
export async function* chatCompletionStream({
  system,
  user,
  maxTokens = config.aiMaxTokens,
  temperature,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ...rest
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(endpointUrl('/v1/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.localAiModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...sampling({ temperature, ...rest }),
        max_tokens: maxTokens,
        stream: true,
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    let detail = ''
    try {
      detail = truncate(await response.text())
    } catch {
      /* body already consumed or unreadable; the status is enough */
    }
    throw new Error(`local AI ${response.status}: ${detail || response.statusText}`)
  }
  if (!response.body) throw new Error('local AI returned no stream body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE frames are separated by a blank line; the last one may be partial.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() || ''
      for (const frame of frames) {
        for (const delta of deltasIn(frame)) yield delta
      }
    }
    if (buffer.trim()) {
      for (const delta of deltasIn(buffer)) yield delta
    }
  } finally {
    // Releasing the lock lets an aborted request tear the socket down instead
    // of leaving the generator waiting on a reader nobody will finish.
    try {
      reader.cancel()
    } catch {
      /* already closed */
    }
    clearTimeout(timer)
  }
}

/** Pulls the content deltas out of one SSE frame; ignores comments and [DONE]. */
function deltasIn(frame) {
  const out = []
  for (const line of frame.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    const delta = parsed?.choices?.[0]?.delta?.content
    if (delta) out.push(delta)
  }
  return out
}

export async function chatCompletion(args) {
  return (await chatCompletionResult(args)).text
}

/**
 * Raw text completion (/v1/completions).
 *
 * Required for the project's own trained tiny GPT: it has a 256-token window
 * and no chat template, so llama.cpp's injected ChatML specials are
 * out-of-vocabulary bytes for it and it immediately emits EOS and returns an
 * empty answer. A plain prompt avoids that (~0% empty vs ~50% measured on this
 * GGUF).
 */
export async function textCompletionResult({ system, user, maxTokens = config.aiMaxTokens, temperature, timeoutMs, retries, ...rest }) {
  const prompt = system && user ? `${system}\n\n${user}` : system || user
  const data = await postJson(
    '/v1/completions',
    {
      model: config.localAiModel,
      prompt,
      ...sampling({ temperature, ...rest }),
      max_tokens: maxTokens,
      stream: false,
    },
    { timeoutMs, retries }
  )
  return readCompletion(data, { compact: true })
}

export async function textCompletion(args) {
  return (await textCompletionResult(args)).text
}

/** Dispatch to chat or raw completion based on the configured prompt mode. */
export async function completeResult(args) {
  if (args.compact ?? config.localAiCompactPrompt) return textCompletionResult(args)
  return chatCompletionResult(args)
}

/** Dispatch to chat or raw completion based on the configured prompt mode. */
export async function complete({ system, user, maxTokens, temperature, compact = config.localAiCompactPrompt, timeoutMs, retries }) {
  if (compact) return textCompletion({ system, user, maxTokens, temperature, timeoutMs, retries })
  return chatCompletion({ system, user, maxTokens, temperature, timeoutMs, retries })
}

/**
 * Non-secret description of the configured provider, for /api/health and for
 * the evaluation reports. Contains no key and no URL beyond the host the server
 * already knows about, so it is safe to log.
 */
export function providerDescriptor() {
  let host = config.localAiBaseUrl
  try {
    host = new URL(config.localAiBaseUrl).host
  } catch {
    /* keep the raw value; the startup check reports an invalid URL */
  }
  return {
    protocol: 'openai-compatible',
    baseUrlHost: host,
    model: config.localAiModel,
    compactPrompt: config.localAiCompactPrompt,
    temperature: config.aiTemperature,
    maxTokens: config.aiMaxTokens,
    timeoutMs: config.aiTimeoutMs,
    retries: config.aiRetries,
    embeddingMode: config.embeddingMode,
    embeddingModel: config.embeddingModel,
    embeddingDim: config.embeddingDim,
  }
}

/**
 * The embedding space THIS process is configured to use, or null when there is
 * none. Every writer and every reader must agree on this value or semantic
 * search silently returns nothing (or, worse, returns nonsense from two
 * different spaces). See embeddingIdentity() for why it exists.
 */
export function activeEmbeddingIdentity() {
  return embeddingIdentity({
    mode: config.embeddingMode,
    embeddingModel: config.embeddingModel,
    embeddingDim: config.embeddingDim,
  })
}

/**
 * Embeddings. Two backends, selected by EMBEDDING_MODE:
 *   'local'  - deterministic in-process vectorizer, no network (default)
 *   'remote' - llama.cpp /embedding or OpenAI-compatible /v1/embeddings
 *
 * Returns { vector, model, dim } where `model` is the canonical embedding-space
 * identity (see embeddingIdentity), or null when embeddings are disabled.
 * Throws ProviderError on any provider failure; callers decide whether to
 * degrade (retrieval) or record a failure (the pipeline).
 */
export async function embed({ input, dim = config.embeddingDim, timeoutMs = 15_000, retries = 1 }) {
  const text = String(input || '').trim()
  if (!text || config.embeddingMode === 'off') return null

  const identity = activeEmbeddingIdentity()
  if (!identity) {
    throw new ProviderError(
      'EMBEDDING_MODE=remote requires EMBEDDING_MODEL to be set, so vectors can be ' +
        'tagged with the space they were built in. Set EMBEDDING_MODEL to the model ' +
        'name your embedding server reports, or use EMBEDDING_MODE=local.',
      { code: 'embedding_model_not_configured', status: 500, retryable: false }
    )
  }

  if (config.embeddingMode === 'remote') {
    const data = await postJson(
      '/v1/embeddings',
      { model: config.embeddingModel || config.localAiModel, input: text },
      { timeoutMs, retries }
    )
    const vector = Array.isArray(data.embedding) ? data.embedding : data.data?.[0]?.embedding
    if (!Array.isArray(vector) || !vector.length) {
      throw new ProviderError('The embedding endpoint returned no vector.', { code: 'provider_bad_response' })
    }
    // Dimension drift is refused, not absorbed. Adopting whatever the provider
    // returned would let stored vectors and query vectors land in different
    // spaces, which is precisely the failure this identity exists to prevent.
    if (vector.length !== dim) {
      throw new ProviderError(
        `The embedding endpoint returned ${vector.length}-dimensional vectors but ` +
          `EMBEDDING_DIM is ${dim}. Set EMBEDDING_DIM=${vector.length} to match the ` +
          `provider, then reindex (npm run reindex:vectors) so stored vectors are in ` +
          `the same space. Refusing to write a vector that cannot be searched for.`,
        { code: 'embedding_dimension_mismatch', status: 500, retryable: false }
      )
    }
    return { vector: normalize(vector), model: identity, dim: vector.length }
  }

  // Local mode is delegated to the pure-JS vectorizer so the pipeline and the
  // retrieval layer can share one canonical representation.
  const { embedLocal } = await import('./embeddings.js')
  return { vector: embedLocal(text, dim), model: identity, dim }
}

/**
 * Optional audio transcription endpoint (whisper.cpp server and friends).
 * Returns { text } or null when no transcription service is configured or the
 * service does not understand the request. Never throws.
 */
export async function transcribeAudio({ filePath, mimeType, timeoutMs = config.transcriptionTimeoutMs }) {
  if (!config.transcriptionBaseUrl) return null
  try {
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(filePath)
    const form = new FormData()
    const name = filePath.split(/[\\/]/).pop() || 'audio'
    form.append('file', new Blob([buf], { type: mimeType || 'application/octet-stream' }), name)
    // whisper.cpp accepts "file"; some servers want "audio". Send both.
    form.append('audio', new Blob([buf], { type: mimeType || 'application/octet-stream' }), name)
    if (config.transcriptionModel) form.append('model', config.transcriptionModel)
    if (config.transcriptionLanguage) form.append('language', config.transcriptionLanguage)

    const res = await fetch(endpointUrl(config.transcriptionPath), {
      method: 'POST',
      headers: config.transcriptionApiKey ? { Authorization: `Bearer ${config.transcriptionApiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
      body: form,
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    const text = data?.text ?? data?.transcript ?? data?.transcription ?? null
    if (typeof text !== 'string' || !text.trim()) return null
    return { text: text.trim() }
  } catch {
    return null
  }
}

function normalize(vector) {
  let sum = 0
  for (const v of vector) sum += v * v
  const norm = Math.sqrt(sum)
  if (!norm) return vector
  return vector.map((v) => v / norm)
}