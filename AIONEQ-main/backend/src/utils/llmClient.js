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

function endpointUrl(path) {
  return `${config.localAiBaseUrl.replace(/\/+$/, '')}${path}`
}

function truncate(text, max = 200) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

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
      lastError = new ProviderError(
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
    // 5xx and 429 are worth one more try; a 4xx is a client bug, do not hammer.
    const retryable = res.status >= 500 || res.status === 429
    lastError = new ProviderError(`Local AI error (${res.status}): ${truncate(raw)}`, {
      code: 'provider_http_error',
      status: res.status,
      retryable,
    })
    if (!retryable || attempt === retries) throw lastError
  }

  throw lastError || new ProviderError('The local AI request failed.')
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
 * Returns the assistant message text ('' when the model returned nothing).
 */
export async function chatCompletion({ system, user, maxTokens = 700, temperature = 0.5, timeoutMs, retries }) {
  const data = await postJson(
    '/v1/chat/completions',
    {
      model: config.localAiModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
      top_p: 0.9,
      repeat_penalty: 1.2,
      frequency_penalty: 0.3,
      presence_penalty: 0.3,
      max_tokens: maxTokens,
      stream: false,
    },
    { timeoutMs, retries }
  )
  return String(data.choices?.[0]?.message?.content || '').trim()
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
export async function textCompletion({ system, user, maxTokens = 700, temperature = 0.5, timeoutMs, retries }) {
  const prompt = system && user ? `${system}\n\n${user}` : system || user
  const data = await postJson(
    '/v1/completions',
    {
      model: config.localAiModel,
      prompt,
      temperature,
      top_p: 0.9,
      repeat_penalty: 1.2,
      frequency_penalty: 0.3,
      presence_penalty: 0.3,
      max_tokens: maxTokens,
      stream: false,
    },
    { timeoutMs, retries }
  )
  return String(data.choices?.[0]?.text || '').trim()
}

/** Dispatch to chat or raw completion based on the configured prompt mode. */
export async function complete({ system, user, maxTokens, temperature, compact = config.localAiCompactPrompt, timeoutMs, retries }) {
  if (compact) return textCompletion({ system, user, maxTokens, temperature, timeoutMs, retries })
  return chatCompletion({ system, user, maxTokens, temperature, timeoutMs, retries })
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