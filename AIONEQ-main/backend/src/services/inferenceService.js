/*
 * Unified AI inference service.
 *
 * WHY THIS FILE EXISTS. Four features used to talk to the model in three
 * different shapes - `complete()` for Ask, `chatCompletion()` for memory
 * analysis, another `chatCompletion()` for memory-relation classification -
 * with their own temperature, token limits and timeouts. That is how a memory
 * analysis ends up spending 700 tokens on a 40-word summary, and how a
 * provider outage turns into three different error messages depending on which
 * feature hit it.
 *
 * This is ONE entry point for every model call EchoMind makes:
 *
 *   generateMemoryAnalysis()  summarise / classify one memory
 *   generateSummary()         short natural-language summary of derived text
 *   generateAnswer()          personalized, memory-grounded answer to a question
 *   generatePersonalization() short conversational turns / suggestions
 *   generateRelationLabel()   one word: how two memories relate
 *
 * It does NOT contain prompts, retrieval, ownership or citation logic - those
 * stay in memoryPipeline / memoryLinks / contextEngine / memoryContext. Keeping
 * the split means the model can be swapped by changing LOCAL_AI_BASE_URL and
 * LOCAL_AI_MODEL (plus the generation settings) with no business-logic edit,
 * and it means no model call can quietly grow a private memory as a side effect.
 *
 * What it guarantees for every call:
 *   - one timeout / retry / error taxonomy (from llmClient)
 *   - configurable temperature, max tokens and timeout, with sane per-task
 *     defaults that were previously hardcoded at the call sites
 *   - the provider envelope is validated; a 200 that is not a completion is an
 *     error, never an empty answer
 *   - an operational metric is recorded WITHOUT content: latency, prompt and
 *     completion character counts, token usage when the provider reports it,
 *     and the error code on failure. No memory text, no prompt, no answer,
*     never a credential.
 *   - nothing is cached across users; there is no response cache here at all,
 *     because an answer is a function of one user's private archive.
 */

import { config } from '../config/config.js'
import { audit } from '../utils/audit.js'
import { completeResult } from '../utils/llmClient.js'

/** Every model task EchoMind performs, with its own generation profile. */
export const AI_TASK = Object.freeze({
  ANALYSIS: 'memory_analysis',
  SUMMARY: 'memory_summary',
  ANSWER: 'question_answer',
  PERSONALIZATION: 'personalization',
  RELATION: 'memory_relation',
})

/**
 * Per-task generation defaults.
 *
 * These are the values the old call sites used:
 *   - Ask passed maxTokens: 700 and inherited temperature 0.5.
 *   - Memory analysis passed maxTokens: 320, temperature 0.2.
 *   - Relation classification passed maxTokens: 8, temperature 0.
 * Personalization and summary are new profiles, sized to their output.
 *
 * A task profile is only a DEFAULT: any parameter passed to generate() wins,
 * and the global AI_* env settings apply to everything.
 */
const TASK_PROFILES = {
  [AI_TASK.ANALYSIS]: { maxTokens: 320, temperature: 0.2, timeoutMs: 15_000, retries: 1 },
  [AI_TASK.SUMMARY]: { maxTokens: 160, temperature: 0.3, timeoutMs: 10_000, retries: 1 },
  [AI_TASK.ANSWER]: { maxTokens: 700, temperature: 0.5, timeoutMs: null, retries: null },
  [AI_TASK.PERSONALIZATION]: { maxTokens: 120, temperature: 0.6, timeoutMs: 10_000, retries: 1 },
  [AI_TASK.RELATION]: { maxTokens: 8, temperature: 0, timeoutMs: 10_000, retries: 0 },
}

/** Resolves the effective parameters for a task. Pure - exported for tests. */
export function resolveGenerationParams(task, overrides = {}) {
  const profile = TASK_PROFILES[task] || TASK_PROFILES[AI_TASK.ANSWER]
  const pick = (key, fallback) => {
    const value = overrides[key]
    return value === undefined || value === null ? fallback : value
  }
  return {
    maxTokens: pick('maxTokens', profile.maxTokens ?? config.aiMaxTokens),
    temperature: pick('temperature', profile.temperature ?? config.aiTemperature),
    timeoutMs: pick('timeoutMs', profile.timeoutMs ?? config.aiTimeoutMs),
    retries: pick('retries', profile.retries ?? config.aiRetries),
  }
}

/** Resolves whether this task must use the raw-completion path. */
export function usesCompactPrompt(task, override) {
  if (override !== undefined && override !== null) return Boolean(override)
  // The 256-token tiny GPT that ships with this repository has no chat
  // template, so the operator enables compact mode to route every task through
  // raw completions instead of chat/completions.
  return Boolean(config.localAiCompactPrompt)
}

/**
 * Content-free operational metric. This is the ONLY place inference telemetry
 * is produced, and it deliberately cannot see the prompt or the completion.
 */
function buildMetric({ task, startedAt, params, system, user, result, error, compact }) {
  return {
    task,
    compact,
    latencyMs: Date.now() - startedAt,
    model: config.localAiModel,
    endpoint: compact ? 'completions' : 'chat/completions',
    promptChars: String(system || '').length + String(user || '').length,
    completionChars: result ? result.text.length : 0,
    maxTokens: params.maxTokens,
    temperature: params.temperature,
    timeoutMs: params.timeoutMs,
    retries: params.retries,
    usage: result?.usage || null,
    empty: result ? !result.text : false,
    truncated: result?.finishReason === 'length',
    ok: !error,
    // The code only - never the provider's body, which can echo the prompt back.
    errorCode: error?.code || null,
    errorStatus: error?.status || null,
  }
}

/**
 * The single model call. Throws ProviderError on any provider fault so callers
 * can decide: degrade (pipeline), or surface an honest error (ask).
 *
 * @param {object} opts
 * @param {string} opts.task one of AI_TASK
 * @param {string} opts.system rules only - never user content
 * @param {string} opts.user  the request body (may contain quoted memory text)
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries]
 * @param {boolean} [opts.compact] force the raw-completions path
 * @param {string} [opts.userId] audit correlation only (an id, never content)
 * @param {string} [opts.ip]
 * @returns {Promise<{text: string, usage: object|null, latencyMs: number, task: string}>}
 */
export async function generate({
  task = AI_TASK.ANSWER,
  system,
  user,
  maxTokens,
  temperature,
  timeoutMs,
  retries,
  compact,
  userId = null,
  ip = null,
} = {}) {
  const params = resolveGenerationParams(task, { maxTokens, temperature, timeoutMs, retries })
  const useCompact = usesCompactPrompt(task, compact)
  const startedAt = Date.now()

  let result = null
  let error = null
  try {
    result = await completeResult({ system, user, ...params, compact: useCompact })
  } catch (err) {
    error = err
  }

  const metric = buildMetric({ task, startedAt, params, system, user, result, error, compact: useCompact })
  audit({ action: 'ai.inference', userId, ip, detail: metric })

  if (error) throw error

  return {
    text: result.text,
    usage: result.usage,
    finishReason: result.finishReason,
    latencyMs: metric.latencyMs,
    task,
  }
}

// --------------------------------------------------------------- features ---
/*
 * Thin, intention-revealing wrappers. Each one fixes the task and nothing else:
 * prompts, retrieval and grounding deliberately stay in the feature services.
 * `fallback` lets a non-critical feature degrade instead of failing the user's
 * request - the pipeline relies on that, the ask path does not.
 */

/** Degrade-or-throw shared by the features that are allowed to degrade. */
async function degradeable(task, { system, user, fallback = null, ...rest }) {
  try {
    return await generate({ task, system, user, ...rest })
  } catch (err) {
    if (fallback) return { ...fallback, providerError: err.message, errorCode: err.code }
    throw err
  }
}

/** Summarise and classify one memory, from the pipeline. */
export async function generateMemoryAnalysis(args) {
  return degradeable(AI_TASK.ANALYSIS, args)
}

/** Short natural-language summary of derived text. */
export async function generateSummary(args) {
  return degradeable(AI_TASK.SUMMARY, args)
}

/** Personalized, memory-grounded answer to a question. Never degrades. */
export async function generateAnswer(args) {
  return generate({ task: AI_TASK.ANSWER, ...args })
}

/** Short conversational turn or suggestion. */
export async function generatePersonalization(args) {
  return generate({ task: AI_TASK.PERSONALIZATION, ...args })
}

/** One word: how two memories relate. */
export async function generateRelationLabel(args) {
  return generate({ task: AI_TASK.RELATION, ...args })
}

export { ProviderError, isProviderReachable, pingProvider, providerDescriptor } from '../utils/llmClient.js'