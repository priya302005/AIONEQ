/*
 * AI chat (Ask) controller.
 *
 * Flow, in order:
 *   authenticate -> verify conversation ownership -> read the user's privacy
 *   settings -> classify intent -> decide whether memory retrieval is useful ->
 *   retrieve THIS user's relevant memories (hybrid) -> build a compact grounded
 *   context -> call the existing local AI provider -> validate citations against
 *   what was actually retrieved -> persist the conversation -> return answer +
 *   the memories used.
 *
 * Notes on what was deliberately preserved:
 *   - One chat system only. Same endpoints, same conversation model, same
 *     provider (llama.cpp local), same streaming-free request/response shape.
 *   - The small-context path for the project's trained 256-token tiny GPT is
 *     kept intact, including the raw-completions endpoint it requires.
 *   - Conversation history stays a retrieval source, but only when the user has
 *     left conversation memory enabled.
 *
 * Citation safety: the model may emit any id it likes; only ids that were
 * actually handed to it from the caller's RLS-scoped retrieval are accepted.
 * The model is never treated as an authorisation source.
 */

import crypto from 'node:crypto'
import { config } from '../config/config.js'
import { retrieveContextForToken, classifyIntent } from '../utils/contextEngine.js'
import { retrieveScoredMemoriesFrom } from '../utils/retrieveMemories.js'
import { retrieveMemories, recordRetrievalTrace } from '../services/memoryRetrieval.js'
import {
  buildContext,
  buildSystemPrompt,
  splitFollowUps,
  extractCitedIds,
  noContextAnswer,
  noContextAnswerShort,
  relayRetrievedMemories,
  formatLinks,
} from '../services/memoryContext.js'
import { listMemoryLinks } from '../models/memoryLink.model.js'
import { getMemorySettings } from '../models/settings.model.js'
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversationRow,
  removeConversationRow,
  renameConversationRow,
} from '../models/conversation.model.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { audit } from '../utils/audit.js'
import { generateAnswer } from '../services/inferenceService.js'
import { ProviderError } from '../utils/llmClient.js'
import { groundAnswer, createSentenceStream } from '../services/claimGrounding.js'
import { chatCompletionStream } from '../utils/llmClient.js'
import { schemaHint as missingTableHint } from '../utils/schemaHint.js'

const CITATION_MAX = 6

/** Shape returned when the grounding layer is switched off for measurement. */
const UNCHANGED_GROUNDING = Object.freeze({
  changed: false,
  supportedClaimCount: 0,
  citedClaimCount: 0,
  removedClaims: [],
  removedCitations: [],
  invalidCitations: [],
  citedMemoryIds: [],
  weakAttributions: 0,
})

/** Memory ceiling for the compact (256-token) ask path. */
const MAX_RETRIEVED = config.queryMaxMemories

// ---------------------------------------------------------------- helpers ---

function isMissingConversationsTable(msg) {
  return /relation .*conversations.* does not exist|could not find the table ['"]?public\.conversations['"]?/i.test(msg || '')
}

/**
 * Maps a provider failure onto a response the user can act on. The model is a
 * local server that can legitimately be stopped, so the message says so instead
 * of surfacing a stack trace.
 */
function providerFailure(err) {
  if (err instanceof ProviderError) {
    if (err.code === 'provider_unreachable') {
      return { status: 503, message: err.message }
    }
    return { status: 502, message: err.message }
  }
  return { status: 502, message: 'The assistant could not generate a reply just now. Please try again.' }
}

/**
 * Compact prompt for the project's trained 256-token-window GPT. Its context
 * must fit the whole window, so the excerpt budget shrinks as the question grows.
 */
const COMPACT_USER_CHAR_BUDGET = 160

const COMPACT_SYSTEM =
  'Answer from memory only. If the memory does not cover the question, say exactly: "Your memories don\u2019t mention this."'

function compactUserContent(q, rawContext) {
  const budget = Math.max(60, COMPACT_USER_CHAR_BUDGET - q.length)
  const trimmed = rawContext.length > budget ? `${rawContext.slice(0, budget).trimEnd()}…` : rawContext
  return `# User's question\n${q}\n\n# Memories\n${trimmed}`
}

// ------------------------------------------------------------------ ask -----

export const askQuestion = asyncHandler(async (req, res) => {
  const { question, conversationId, memoryTypes } = req.body // zod-validated
  const q = String(question).trim()

  // ---- 1. conversation ownership -------------------------------------
  let existingConv = null
  if (conversationId) {
    const existing = await getConversation(req.accessToken, conversationId)
    if (existing.error) {
      return res.status(400).json({ success: false, message: existing.error.message })
    }
    if (!existing.data) {
      return res.status(404).json({ success: false, message: 'Conversation not found.' })
    }
    // Defense in depth: RLS already scopes this, but verify ownership here too.
    if (existing.data.user_id !== req.user.id) {
      audit({ action: 'query.access_denied', userId: req.user.id, ip: req.ip, detail: { conversationId } })
      return res.status(403).json({ success: false, message: 'You do not have access to this conversation.' })
    }
    existingConv = existing.data
  }

  // ---- 2. the user's own privacy switches ----------------------------
  const settings = await getMemorySettings(req.accessToken, req.user.id)
  const memoryAllowed = settings.memoryAiEnabled

  const compact = config.localAiCompactPrompt
  let answer
  let suggestions = []
  let cited = []
  let usedMemories = []

  if (!memoryAllowed) {
    // The user has turned memory use off. Do not retrieve anything from their
    // archive, and say so plainly rather than silently answering as if we had.
    const system = compact
      ? COMPACT_SYSTEM
      : [
          'You are EchoMind, a general-purpose assistant.',
          'The user has turned off access to their personal memories for this conversation, so you have no memory of their personal context and must not pretend otherwise.',
          'Answer using general knowledge only. If the question depends on their personal history, say plainly that you cannot see their memories right now and ask them to enable memory in Settings.',
        ].join(' ')

    let raw
    try {
      // No memories were supplied, so there is nothing to ground against: the
      // system prompt explicitly tells the model to answer from general
      // knowledge. Claim grounding is deliberately NOT applied on this path.
      raw = (
        await generateAnswer({
          system,
          user: q,
          maxTokens: compact ? 32 : 500,
          compact,
          userId: req.user.id,
          ip: req.ip,
        })
      ).text
    } catch (err) {
      const failure = providerFailure(err)
      return res.status(failure.status).json({ success: false, message: failure.message })
    }
    const parsed = splitFollowUps(raw)
    answer = parsed.answer
    suggestions = parsed.suggestions
    if (!answer) answer = compact ? noContextAnswerShort() : noContextAnswer()
  } else if (compact) {
    // ---- small-model path: memories only, prompt must fit 256 tokens ----
    const memories = await retrieveMemoriesForAsk(req, q, { limit: MAX_RETRIEVED, memoryTypes })

    if (!memories.length) {
      answer = "I don't have any memories about that yet."
    } else {
      const context = memories
        .map((m, i) => {
          const date = m.eventDate ? new Date(m.eventDate).toISOString().slice(0, 10) : 'unknown date'
          return `[${i + 1}] id: ${m.memoryId} | ${m.type} | ${date}\n${m.snippet}`
        })
        .join('\n\n')

      let raw
      try {
        // Compact path uses raw completions: safest for this template-less tiny
        // GPT-2 (ChatML specials are out-of-vocabulary bytes for it).
        raw = (
          await generateAnswer({
            system: COMPACT_SYSTEM,
            user: compactUserContent(q, context),
            maxTokens: 32,
            compact: true,
            userId: req.user.id,
            ip: req.ip,
          })
        ).text
      } catch (err) {
        const failure = providerFailure(err)
        return res.status(failure.status).json({ success: false, message: failure.message })
      }

      const parsed = splitFollowUps(raw)
      // Gated identically to the full path. Compact is the recommended
      // production route, so a flag that only applied there would measure a
      // configuration nobody deploys.
      const grounded = config.aiClaimGroundingEnabled
        ? groundAnswer({
            answer: parsed.answer,
            memories,
            honestFallback: noContextAnswerShort(),
          })
        : { ...UNCHANGED_GROUNDING, answer: parsed.answer }
      answer = grounded.answer
      suggestions = parsed.suggestions
      if (grounded.changed) {
        // Content-free: counts only. No answer text, no memory text.
        audit({
          action: 'query.grounding_adjusted',
          userId: req.user.id,
          ip: req.ip,
          detail: {
            invalidCitations: grounded.invalidCitations.length,
            removedClaims: grounded.removedClaims.length,
            citedClaims: grounded.citedClaimCount,
            weakAttributions: grounded.weakAttributions,
          },
        })
      }
      cited = extractCitedIds(answer, memories).slice(0, CITATION_MAX)
      usedMemories = memories
    }
  } else {
    // ---- full path: hybrid memory retrieval + conversation context -----
    let memories = []
    let contextPkg = { currentConversation: null, histories: [] }

    // Memories first. This is the primary source of personal context.
    memories = await retrieveMemoriesForAsk(req, q, { limit: config.retrievalMaxMemories, memoryTypes })

    // Conversation sources are second, and only when enabled.
    if (settings.conversationMemoryEnabled) {
      contextPkg = await retrieveContextForToken(req.accessToken, req.user.id, q, {
        currentConversation: existingConv ? { id: existingConv.id, messages: existingConv.messages || [] } : null,
        // Reuse the memories already retrieved above instead of letting the
        // context engine re-score them with a different (lexical-only) scorer,
        // which used to drop vector-only matches and trigger a false
        // "nothing in your memories" refusal.
        memories,
      }).catch(() => ({ currentConversation: null, histories: [], memories: [] }))
    }

    // Approved relationship links between the selected memories, so an answer can
    // present an evolution as a timeline instead of a contradiction.
    const links = memories.length ? await loadEvolutionLinks(req, memories) : []
    const linkLines = formatLinks(links, new Map(memories.map((m) => [m.memoryId, m])))

    // Broad recall: a personal question can share no vocabulary with the memory
    // that answers it ("tell me my name" vs "i am janani"), which leaves the
    // prompt empty and produces a false "nothing saved" refusal. When the user
    // is clearly asking about their own stored life and retrieval came back
    // empty, hand over the most recent memories and let the model make the link
    // that bag-of-words scoring cannot. Grounding and citations still apply, so
    // a question the memories truly cannot answer is still refused honestly.
    let usedBroadRecall = false
    if (config.aiBroadRecallEnabled && !memories.length && classifyIntent(q).recall) {
      const fallbackMemories = await broadRecallForQuestion(req, q)
      if (fallbackMemories.length) {
        memories = fallbackMemories
        usedBroadRecall = true
        audit({
          action: 'query.broad_recall',
          userId: req.user.id,
          ip: req.ip,
          detail: { candidates: fallbackMemories.length },
        })
      }
    }

    const hasAnyContext = memories.length || contextPkg.histories.length || contextPkg.currentConversation

    if (!hasAnyContext) {
      // Nothing to ground an answer in. Say so honestly instead of asking the
      // model to invent a personal connection.
      answer = noContextAnswer()
    } else {
      const ambiguity = detectAmbiguity(memories)
      const lowConfidence =
        !usedBroadRecall && memories.length === 1 && memories[0].score < 0.28 && contextPkg.intent?.recall

      const system = buildSystemPrompt({
        hasMemories: memories.length > 0,
        hasHistory: contextPkg.histories.length > 0 || Boolean(contextPkg.currentConversation),
        ambiguity,
        lowConfidence,
        broadRecall: usedBroadRecall,
      })

      const userContent = buildContext(q, {
        memories,
        currentConversation: contextPkg.currentConversation,
        histories: contextPkg.histories,
        links: linkLines,
      })

      let raw
      try {
        raw = (
          await generateAnswer({ system, user: userContent, maxTokens: 700, userId: req.user.id, ip: req.ip })
        ).text
      } catch (err) {
        const failure = providerFailure(err)
        return res.status(failure.status).json({ success: false, message: failure.message })
      }

      const parsed = splitFollowUps(raw)

      // Sentence-level grounding: a valid citation is kept, a fabricated id is
      // deleted from the text, and an uncited assertion with no support in the
      // retrieved excerpts is removed. The model is never the only authority on
      // whether its own answer is supported.
      //
      // AI_CLAIM_GROUNDING exists so the evaluation can measure the grounding
      // rate with the layer disabled. startup.js refuses that combination in
      // production, so a deployed server can never serve an ungrounded answer.
      const grounded = config.aiClaimGroundingEnabled
        ? groundAnswer({
            answer: parsed.answer,
            memories,
            honestFallback: memories.length
              ? relayRetrievedMemories(memories) || noContextAnswer()
              : noContextAnswer(),
          })
        : { ...UNCHANGED_GROUNDING, answer: parsed.answer }

      answer = grounded.answer
      suggestions = parsed.suggestions

      // Broad recall asked the model to judge relevance from unranked memories.
      // If it did not actually cite one, it answered from nothing, so the honest
      // refusal is restored instead of being shown.
      if (usedBroadRecall && !grounded.citedMemoryIds?.length) {
        answer = noContextAnswer()
        suggestions = []
      }

      if (grounded.changed) {
        // Content-free: counts only. No answer text, no memory text.
        audit({
          action: 'query.grounding_adjusted',
          userId: req.user.id,
          ip: req.ip,
          detail: {
            invalidCitations: grounded.invalidCitations.length,
            removedClaims: grounded.removedClaims.length,
            citedClaims: grounded.citedClaimCount,
            weakAttributions: grounded.weakAttributions,
          },
        })
      }

      cited = extractCitedIds(answer, memories).slice(0, CITATION_MAX)
      usedMemories = memories
    }
  }

  // ---- 3. persist -------------------------------------------------------
  const now = new Date().toISOString()
  const userMsg = { id: crypto.randomUUID(), role: 'user', content: q, citedMemories: [], createdAt: now }
  const assistantMsg = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: answer,
    citedMemories: cited.map((c) => ({
      memoryId: c.memoryId,
      title: c.title,
      type: c.type,
      eventDate: c.eventDate,
      snippet: c.snippet,
      topics: c.topics || [],
    })),
    // Every memory that informed the answer, so the UI can show "answered from"
    // even when the model cited only some of them. Ids only - no text, no scores.
    usedMemoryIds: usedMemories.map((m) => m.memoryId),
    suggestions,
    createdAt: now,
  }

  let convId = conversationId
  if (convId) {
    const messages = [...(existingConv.messages || []), userMsg, assistantMsg]
    const updated = await updateConversationRow(req.accessToken, convId, { messages, updated_at: now })
    if (updated.error) {
      return res.status(400).json({ success: false, message: updated.error.message })
    }
  } else {
    const title = q.length > 60 ? `${q.slice(0, 60)}…` : q
    const created = await createConversation(req.accessToken, {
      user_id: req.user.id,
      title,
      messages: [userMsg, assistantMsg],
    })
    if (created.error) {
      if (isMissingConversationsTable(created.error.message)) {
        return res.json({ success: true, conversationId: null, answer, citedMemories: cited, suggestions })
      }
      return res.status(400).json({ success: false, message: missingTableHint(created.error.message) })
    }
    convId = created.data.id
  }

  audit({
    action: 'query.ask',
    userId: req.user.id,
    ip: req.ip,
    detail: {
      conversationId: convId,
      citedCount: cited.length,
      retrievedCount: usedMemories.length,
      memoryAiEnabled: memoryAllowed,
      conversationMemoryEnabled: settings.conversationMemoryEnabled,
    },
  })

  res.json({
    success: true,
    conversationId: convId,
    answer,
    citedMemories: cited,
    // Short, safe descriptions of what informed the answer, so the chat can
    // offer "see the memories I used" without a second round trip.
    usedMemories: usedMemories.slice(0, CITATION_MAX).map((m) => ({
      memoryId: m.memoryId,
      title: m.title,
      type: m.type,
      eventDate: m.eventDate,
      topics: m.topics || [],
    })),
    suggestions,
  })
})

/**
 * Single entry point for memory retrieval in the ask flow.
 * Wraps the RLS-scoped client, applies the caller's type filter, and records a
 * score-only trace for relevance monitoring.
 */
/**
 * Streaming Ask.
 *
 * Same retrieval, same prompt, same grounding rules as askQuestion - the only
 * difference is that the answer is released as it is produced instead of all at
 * once. Every sentence is graded by the same groundAnswer used by the
 * non-streaming path, and a sentence that fails is never emitted; it is dropped
 * and, if nothing survives, the honest fallback is sent instead. So streaming
 * does not weaken the guarantee that an ungrounded answer is never served.
 *
 * A `done` event always carries the authoritative final answer, citations and
 * suggestions, so the client can reconcile whatever it rendered live.
 */
export const askQuestionStream = asyncHandler(async (req, res) => {
  const q = String(req.body?.question || '').trim()
  if (!q) return res.status(400).json({ success: false, message: 'Ask a question first.' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  // A client that closes the tab must not leave the generator running.
  let aborted = false
  req.on('close', () => {
    aborted = true
  })
  const alive = () => !aborted && !res.writableEnded

  try {
    send('status', { phase: 'retrieving' })

    const memoryTypes = req.body?.memoryTypes
    let memories = await retrieveMemoriesForAsk(req, q, {
      limit: config.retrievalMaxMemories,
      memoryTypes,
    })

    // Same broad-recall rule as askQuestion: a personal question with no
    // keyword hit still gets the model a chance to read recent memories.
    let usedBroadRecall = false
    if (!memories.length && config.aiBroadRecallEnabled && classifyIntent(q).recall) {
      memories = await broadRecallForQuestion(req, q)
      usedBroadRecall = memories.length > 0
    }

    if (!memories.length) {
      send('status', { phase: 'answering' })
      const refusal = noContextAnswer()
      // Still a real exchange: persist it, or the user's question disappears
      // from the sidebar the moment they navigate away.
      const convId = await persistExchange(req, q, refusal, [], [])
      send('done', {
        answer: refusal,
        citedMemories: [],
        usedMemories: [],
        suggestions: [],
        conversationId: convId,
      })
      return res.end()
    }

    const ambiguous = detectAmbiguity(memories)
    const lowConfidence =
      !usedBroadRecall &&
      memories.length === 1 &&
      memories[0].score < 0.28 &&
      classifyIntent(q).recall

    const system = buildSystemPrompt({
      hasMemories: true,
      hasHistory: false,
      ambiguity: ambiguous,
      lowConfidence,
      broadRecall: usedBroadRecall,
    })
    const user = buildContext(q, {
      memories,
      currentConversation: null,
      histories: [],
      links: '',
    })

    send('status', { phase: 'answering' })

    const sentences = createSentenceStream()
    const released = []
    for await (const delta of chatCompletionStream({ system, user })) {
      if (!alive()) break
      for (const sentence of sentences.push(delta)) {
        const graded = groundAnswer({
          answer: sentence,
          memories,
          honestFallback: '',
        })
        // Dropped rather than shown: this is the whole safety property.
        // The test is whether the sentence was REMOVED, not whether the result
        // is empty - groundAnswer substitutes its default fallback text when a
        // sentence is filtered, so an emptiness check would happily release
        // "I could not find that in your memories." as if it were the answer.
        if (graded.removedClaims.length || !graded.answer.trim()) continue
        released.push(graded.answer)
        send('delta', { text: graded.answer })
      }
    }
    if (alive()) {
      for (const sentence of sentences.flush()) {
        const graded = groundAnswer({ answer: sentence, memories, honestFallback: '' })
        if (graded.removedClaims.length || !graded.answer.trim()) continue
        released.push(graded.answer)
        send('delta', { text: graded.answer })
      }
    }

    const streamed = released.join(' ').trim()
    // Authoritative pass over exactly what was shown, so the client ends up
    // with the same answer, citations and suggestions the non-streaming route
    // would have produced.
    const final = streamed
      ? groundAnswer({
          answer: streamed,
          memories,
          honestFallback: relayRetrievedMemories(memories) || noContextAnswer(),
        })
      : { answer: noContextAnswer(), citedMemoryIds: [] }

    // Broad recall must not produce an answer that cites nothing.
    const answer =
      usedBroadRecall && !(final.citedMemoryIds || []).length
        ? noContextAnswer()
        : final.answer

    const parsed = splitFollowUps(answer)
    const citedList = extractCitedIds(parsed.answer, memories).slice(0, CITATION_MAX)
    const citedPayload = citedList.map((id) => {
      const m = memories.find((x) => x.memoryId === id)
      return {
        memoryId: id,
        title: m?.title || 'Memory',
        type: m?.type || 'journal',
        eventDate: m?.eventDate || null,
        snippet: m?.snippet || '',
        topics: m?.topics || [],
      }
    })

    // Persist exactly as the non-streaming route does, so the conversation still
    // lands in the sidebar and the thread can be reopened later.
    const convId = await persistExchange(
      req,
      q,
      parsed.answer,
      citedPayload,
      parsed.suggestions,
      memories.map((m) => m.memoryId)
    )

    send('done', {
      answer: parsed.answer,
      suggestions: parsed.suggestions,
      citedMemories: citedPayload,
      usedMemories: memories.slice(0, CITATION_MAX).map((m) => ({
        memoryId: m.memoryId,
        title: m.title,
        type: m.type,
        eventDate: m.eventDate,
        snippet: m.snippet,
        topics: m.topics || [],
      })),
      conversationId: convId,
    })
  } catch (err) {
    // Headers are already sent, so the error has to travel as an event.
    send('error', { message: 'Could not complete the answer.' })
  } finally {
    if (!res.writableEnded) res.end()
  }
})

/**
 * Writes one question/answer exchange to the conversation history.
 *
 * Shared by the streaming and non-streaming Ask routes so they cannot drift:
 * the streamed route originally returned `conversationId: null` and never wrote
 * anything, which made every reply vanish from the sidebar on reload.
 *
 * Returns the conversation id, or null when storage failed. A storage problem
 * must never destroy an answer the user is already reading, so the failure is
 * swallowed and reported as "unsaved" rather than thrown.
 */
async function persistExchange(req, question, answer, citedMemories = [], suggestions = [], usedMemoryIds = []) {
  const now = new Date().toISOString()
  const userMsg = { id: crypto.randomUUID(), role: 'user', content: question, citedMemories: [], createdAt: now }
  const assistantMsg = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: answer,
    citedMemories,
    usedMemoryIds,
    suggestions,
    createdAt: now,
  }

  try {
    const conversationId = req.body?.conversationId || null
    if (conversationId) {
      const existing = await getConversation(req.accessToken, conversationId)
      const messages = [...(existing?.messages || []), userMsg, assistantMsg]
      const updated = await updateConversationRow(req.accessToken, conversationId, {
        messages,
        updated_at: now,
      })
      return updated.error ? null : conversationId
    }
    const title = question.length > 60 ? `${question.slice(0, 60)}…` : question
    const created = await createConversation(req.accessToken, {
      user_id: req.user.id,
      title,
      messages: [userMsg, assistantMsg],
    })
    return created.error ? null : created.data.id
  } catch {
    return null
  }
}

async function retrieveMemoriesForAsk(req, question, { limit, memoryTypes }) {
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${req.accessToken}` } },
  })

  const results = await retrieveMemories(client, req.user.id, question, {
    limit,
    types: Array.isArray(memoryTypes) && memoryTypes.length ? memoryTypes : null,
  }).catch((err) => {
    // A retrieval failure degrades to "no memories", never to a 500 with the
    // user left staring at an error.
    audit({ action: 'query.retrieval_failed', userId: req.user.id, ip: req.ip, detail: { reason: err?.message } })
    return []
  })

  await recordRetrievalTrace(req.accessToken, req.user.id, question, results).catch(() => {})
  return results
}

/**
 * Broad recall for personal questions that share no vocabulary with the memory.
 *
 * Measured failure: the stored memory read "hii i am janani, i am currently
 * pursing BE CSE at NEC..." and the user asked "tell me my name". The word
 * "name" appears nowhere in that text, so lexical overlap is 0, and the hashed
 * 384-d vector cannot connect "name" to "janani" either. memoryRetrieval.js:388
 * then dropped the row from the candidate pool entirely, leaving the prompt with
 * nothing and the user with "I couldn't find anything in your saved memories" -
 * while the answer sat in their own archive.
 *
 * Bag-of-words retrieval cannot bridge that gap; a language model can. So when a
 * question is clearly about the user's own stored life and nothing matched, the
 * most recent memories are handed over anyway and the model decides. It is still
 * fully grounded: same snippets, same citation validation, same claim grounding,
 * and a question the memories genuinely cannot answer still gets the honest
 * refusal.
 */
async function broadRecallForQuestion(req, question, limit = 6) {
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${req.accessToken}` } },
  })

  const scored = await retrieveScoredMemoriesFrom(client, req.user.id, question).catch(() => [])
  // Already truncated and run through sanitizeExcerpt by the retriever, so the
  // injection flag and excerpt safety carry over untouched.
  return scored.slice(0, limit).map((m) => ({
    ...m,
    broadRecall: true,
    matchedBy: m.score > 0 ? 'scored' : 'recent',
  }))
}

/** Two memories scoring almost equally means the answer must acknowledge both. */
function detectAmbiguity(memories) {
  if (memories.length < 2) return false
  return Math.abs(memories[0].score - memories[1].score) <= config.contextAmbiguityTolerance
}

/** Approved links that connect the retrieved memories to each other. */
async function loadEvolutionLinks(req, memories) {
  const ids = memories.map((m) => m.memoryId)
  if (ids.length < 2) return []
  try {
    const links = await listMemoryLinks(req.accessToken, req.user.id, ids)
    // Only links between memories that are both in this answer's context can be
    // described; anything else would reference a memory the model never saw.
    const present = new Set(ids)
    return links.filter((l) => present.has(l.source_memory_id) && present.has(l.related_memory_id))
  } catch {
    return []
  }
}

// ------------------------------------------------- conversation CRUD -------

export const getConversationsController = asyncHandler(async (req, res) => {
  const { data, error } = await listConversations(req.accessToken)
  if (error) {
    if (isMissingConversationsTable(error.message)) {
      return res.json({ success: true, data: [] })
    }
    return res.status(400).json({ success: false, message: error.message })
  }
  res.json({
    success: true,
    data: (data || [])
      .filter((c) => c.user_id === req.user.id) // defense in depth
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updated_at })),
  })
})

export const getConversationController = asyncHandler(async (req, res) => {
  const { data, error } = await getConversation(req.accessToken, req.params.id)
  if (error) {
    return res.status(400).json({ success: false, message: error.message })
  }
  if (!data) {
    return res.status(404).json({ success: false, message: 'Conversation not found.' })
  }
  if (data.user_id !== req.user.id) {
    audit({ action: 'query.access_denied', userId: req.user.id, ip: req.ip, detail: { conversationId: req.params.id } })
    return res.status(403).json({ success: false, message: 'You do not have access to this conversation.' })
  }
  res.json({
    success: true,
    data: { id: data.id, title: data.title, updatedAt: data.updated_at, messages: data.messages || [] },
  })
})

export const deleteConversationController = asyncHandler(async (req, res) => {
  const existing = await getConversation(req.accessToken, req.params.id)
  if (existing.error) return res.status(400).json({ success: false, message: existing.error.message })
  if (!existing.data) return res.status(404).json({ success: false, message: 'Conversation not found.' })
  if (existing.data.user_id !== req.user.id) {
    audit({ action: 'query.access_denied', userId: req.user.id, ip: req.ip, detail: { conversationId: req.params.id } })
    return res.status(403).json({ success: false, message: 'You do not have access to this conversation.' })
  }

  const { data, error } = await removeConversationRow(req.accessToken, req.params.id)
  if (error) {
    return res.status(400).json({ success: false, message: error.message })
  }
  if (!data) {
    return res.status(404).json({ success: false, message: 'Conversation not found.' })
  }
  audit({ action: 'query.conversation_delete', userId: req.user.id, ip: req.ip, detail: { conversationId: req.params.id } })
  res.json({ success: true, message: 'Conversation deleted.' })
})

export const renameConversationController = asyncHandler(async (req, res) => {
  const { title } = req.body // zod-validated
  const cleanTitle = String(title).trim().slice(0, 80)

  const existing = await getConversation(req.accessToken, req.params.id)
  if (existing.error) return res.status(400).json({ success: false, message: existing.error.message })
  if (!existing.data) return res.status(404).json({ success: false, message: 'Conversation not found.' })
  if (existing.data.user_id !== req.user.id) {
    audit({ action: 'query.access_denied', userId: req.user.id, ip: req.ip, detail: { conversationId: req.params.id } })
    return res.status(403).json({ success: false, message: 'You do not have access to this conversation.' })
  }

  const { data, error } = await renameConversationRow(req.accessToken, req.params.id, cleanTitle)
  if (error) {
    return res.status(400).json({ success: false, message: error.message })
  }
  if (!data) {
    return res.status(404).json({ success: false, message: 'Conversation not found.' })
  }
  res.json({ success: true, data: { id: data.id, title: data.title, updatedAt: data.updated_at } })
})