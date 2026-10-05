/*
 * EchoMind Context Engine
 * -----------------------
 * Turns one user question into a small, curated "context package" drawn from
 * THREE dynamic sources:
 *
 *   1. the current conversation
 *   2. previous conversations of the same user
 *   3. saved memories (any type)
 *
 * Everything is computed at request time against the live store for the
 * authenticated user only. There is NO hardcoded memory knowledge: no names,
 * IDs, companies, topics, keywords, or query->memory mappings. A memory saved
 * 10 seconds ago, a new conversation from yesterday, or an unknown future
 * topic all flow through the exact same code path.
 *
 * The engine:
 *   - classifies intent (vague / recall / action) with generic English
 *     patterns (no user-specific terms)
 *   - scores every candidate 0..1 with dynamic relevance (textRelevance.js)
 *   - applies a configurable relevance threshold + per-source budgets
 *   - deduplicates and flags ambiguity/conflicts
 *   - logs the whole selection when CONTEXT_DEBUG is on
 */

import { config } from '../config/config.js'
import { relevanceScore, tokenize, textKey } from './textRelevance.js'
import { sanitizeExcerpt } from './promptSafety.js'
import { retrieveScoredMemoriesFrom } from './retrieveMemories.js'
import { createClient } from '@supabase/supabase-js'

const VAGUE_RE =
  /\b(which one|which was|what was|what did i|what is|don'?t remember|do not remember|forgot|forget|remind|where did i|about that|that thing|earlier|before|previously|somewhere|mentioned|i asked|i wrote|i saved)\b/i
const RECALL_RE =
  /\b(remember|saved|save|wrote|written|wrote down|mentioned|posted|said|told|journal|notebook|note|notes|memory|memories|talked about|discussed|recorded|stored|that day)\b/i
const ACTION_RE =
  /\b(prepare|study|plan|planning|decide|suggest|help me|what next|what should i|how do i|advice|practice|focus on|start|should i)\b/i
/*
 * Personal-data recall that names no recall keyword.
 *
 * RECALL_RE only fires on explicit words ("remember", "journal", "notes"), so
 * ordinary possessive questions - "give me my friend details", "tell me my name",
 * "what is my dream" - were classified with no intent at all. `recall` gates the
 * weak-match safety net further down, so those questions got nothing: not a
 * strong memory, and not even the single best partial one. Asking about one's
 * own stored details is a recall request regardless of the wording.
 */
const PERSONAL_RE =
  /\b(my|our)\s+\w+|\b(details?|info|information|contact)\s+(about|on|of)\b|\bwho\s+is\s+(my|our)\b/i

export function classifyIntent(question) {
  const q = String(question || '')
  const tokens = tokenize(q)
  const vague = VAGUE_RE.test(q) || tokens.length <= 3
  const recall = vague || RECALL_RE.test(q) || PERSONAL_RE.test(q)
  const action = ACTION_RE.test(q)
  return {
    vague,
    recall,
    action,
    labels: [
      vague ? 'vague' : null,
      recall ? 'recall' : null,
      action ? 'action' : null,
    ].filter(Boolean),
  }
}

function clientFor(token) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

function clampText(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function safeLine(text, userId, originId, max = 400) {
  const { text: safe } = sanitizeExcerpt(clampText(text, max), originId, userId)
  return safe
}

/** Format a conversation's messages into role-labeled lines. */
function messageLines(messages, userId, originId, maxTurns) {
  if (!Array.isArray(messages)) return []
  const tail = messages.slice(-maxTurns * 2)
  return tail.map((m) => {
    const role = m.role === 'user' ? 'User' : 'Assistant'
    return `${role}: ${safeLine(m.content, userId, originId)}`
  })
}

/**
 * Score a full conversation (title + messages) against the question and pick
 * the message window that best matches, for use as the excerpt.
 */
function scoreConversation(question, conv, userId) {
  const title = String(conv.title || '')
  const msgs = Array.isArray(conv.messages) ? conv.messages : []
  const allText = `${title} ${msgs.map((m) => m.content || '').join(' ')}`
  const score = relevanceScore(question, [title, allText])

  // Find the best-matching single message and take a small window around it.
  let bestIdx = -1
  let bestScore = -1
  msgs.forEach((m, i) => {
    const s = relevanceScore(question, [String(m.content || '')])
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  })
  if (bestIdx === -1) {
    return { score, excerpt: '' }
  }
  const from = Math.max(0, bestIdx - 1)
  const lines = msgs.slice(from, bestIdx + 2).map((m) =>
    `${m.role === 'user' ? 'User' : 'Assistant'}: ${safeLine(m.content, userId, conv.id)}`
  )
  return { score, excerpt: lines.join('\n').slice(0, 700) }
}

function contextLog(entry) {
  if (!config.contextDebug) return
  console.log(`[CONTEXT RETRIEVAL] ${JSON.stringify(entry)}`)
}

/**
 * Core engine. `client` is injected so tests can use a fake store.
 *
 * opts:
 *   currentConversation: { id, messages } | null
 *   limitMemories / limitHistory / minScore / maxTurns (defaults from config)
 */
export async function retrieveContextFrom(client, userId, question, opts = {}) {
  const q = String(question || '').trim()
  const intent = classifyIntent(q)
  const minScore = opts.minScore ?? config.contextMinScore
  const limitMemories = opts.limitMemories ?? config.queryMaxMemories
  const limitHistory = opts.limitHistory ?? config.contextMaxConversations
  const maxTurns = opts.maxTurns ?? 3
  const convCandidates = opts.convCandidates ?? config.contextConvCandidates
  const currentConv = opts.currentConversation || null

  const rejected = []
  const debug = { query: q, intent: intent.labels, stages: [] }

  // ---- source 1: current conversation ------------------------------------
  let currentConversation = null
  if (currentConv && Array.isArray(currentConv.messages) && currentConv.messages.length) {
    const turnLines = messageLines(currentConv.messages, userId, currentConv.id, maxTurns)
    const convText = turnLines.join(' ')
    const score = relevanceScore(
      q,
      [String(currentConv.title || ''), ...currentConv.messages.map((m) => m.content || '')]
    )
    const include = intent.vague || score >= minScore * 0.8
    debug.stages.push({ source: 'current_conversation', candidates: 1, score: +score.toFixed(3), include })
    if (include) {
      currentConversation = { conversationId: currentConv.id, score, turns: turnLines, title: currentConv.title || 'Current conversation' }
    } else {
      rejected.push({ sourceType: 'current_conversation', id: currentConv.id, score: +score.toFixed(3) })
    }
  }

  // ---- source 2: previous conversations ----------------------------------
  let histories = []
  let convRows = []
  try {
    const { data, error } = await client
      .from('conversations')
      .select('id,user_id,title,messages,updated_at')
      .order('updated_at', { ascending: false })
      .limit(convCandidates)
    if (!error && data) convRows = data
  } catch {
    /* conversations table missing -> conversational sources simply empty */
  }

  const myConvs = convRows.filter(
    (c) => c.user_id === userId && (!currentConv || c.id !== currentConv.id)
  )
  const scoredConvs = myConvs
    .map((c) => ({ ...scoreConversation(q, c, userId), conv: c }))
    .sort((a, b) => b.score - a.score || Date.parse(b.conv.updated_at || 0) - Date.parse(a.conv.updated_at || 0))
  debug.stages.push({
    source: 'conversation_history',
    candidates: scoredConvs.length,
    top: scoredConvs.slice(0, 3).map((s) => ({ id: s.conv.id, score: +s.score.toFixed(3) })),
  })
  for (const { score, excerpt, conv } of scoredConvs) {
    if (excerpt && score >= minScore) {
      histories.push({
        conversationId: conv.id,
        title: conv.title || 'Earlier conversation',
        updatedAt: conv.updated_at,
        score,
        excerpt,
        sourceType: 'conversation_history',
      })
      if (histories.length >= limitHistory) break
    } else {
      rejected.push({ sourceType: 'conversation_history', id: conv.id, score: +score.toFixed(3) })
    }
  }

  // ---- source 3: saved memories ------------------------------------------
  let scoredMemories = []
  /*
   * If the caller already retrieved memories, reuse them verbatim.
   *
   * Re-fetching here used to re-score the same rows with a *second, lexical-only*
   * scorer, which silently disagreed with the caller's vector+lexical fusion: a
   * memory the vector search had matched at 0.68 was re-scored 0.0 and then
   * dropped by minScore, so the prompt reported "no saved memory" and the model
   * refused a question it had actually been given the answer to. One retrieval,
   * one score, no second opinion.
   */
  if (Array.isArray(opts.memories)) {
    scoredMemories = opts.memories
  } else {
    try {
      scoredMemories = await retrieveScoredMemoriesFrom(client, userId, q)
    } catch {
      /* memories table missing -> memory source empty */
    }
  }
  debug.stages.push({
    source: 'saved_memories',
    candidates: scoredMemories.length,
    top: scoredMemories.slice(0, 3).map((m) => ({ id: m.memoryId, score: +m.score.toFixed(3) })),
  })

  let memories = scoredMemories
    .filter((m) => m.score >= minScore)
    .slice(0, limitMemories)
  for (const m of scoredMemories) {
    if (m.score < minScore) rejected.push({ sourceType: 'saved_memory', id: m.memoryId, score: +m.score.toFixed(3) })
  }

  // Vague recall: even a weak match can help the user recognize what they
  // meant - surface the single best one, explicitly flagged for the model.
  // Zero-score leftovers are never forced in: an irrelevant memory helps nobody.
  let lowConfidenceMemory = null
  if (
    intent.recall &&
    !memories.length &&
    scoredMemories.length &&
    scoredMemories[0].score > 0
  ) {
    lowConfidenceMemory = { ...scoredMemories[0], lowConfidence: true }
    memories = [lowConfidenceMemory]
  }

  // ---- dedup across sources ----------------------------------------------
  // If a history excerpt is nearly the same text as a selected memory, the
  // memory wins (saved memories are the more durable representation).
  if (memories.length && histories.length) {
    const memKeys = new Set(memories.map((m) => textKey(m.snippet)))
    histories = histories.filter((h) => {
      const k = textKey(h.excerpt)
      for (const mk of memKeys) {
        if (k && mk && (k === mk || k.includes(mk) || mk.includes(k))) return false
      }
      return true
    })
  }

  // ---- conflict / ambiguity ----------------------------------------------
  let ambiguity = false
  if (memories.length >= 2) {
    const top = memories[0].score
    const second = memories[1].score
    ambiguity = top - second <= (opts.ambiguityTolerance ?? config.contextAmbiguityTolerance)
    if (ambiguity) {
      debug.stages.push({
        source: 'ambiguity',
        note: 'two memories are close in score - the model should acknowledge both',
        scores: memories.slice(0, 2).map((m) => m.memoryId),
      })
    }
  }

  // ---- final char budget -------------------------------------------------
  const budget = opts.maxContextChars ?? config.contextMaxChars
  let currentChars = currentConversation
    ? currentConversation.turns.reduce((n, t) => n + t.length, 0)
    : 0
  let historyChars = histories.reduce((n, h) => n + h.excerpt.length, 0)
  let memoryChars = memories.reduce((n, m) => n + m.snippet.length, 0)
  if (currentChars + historyChars + memoryChars > budget && budget > 0) {
    const room = Math.max(0, budget - currentChars)
    const scale = room / Math.max(1, historyChars + memoryChars)
    histories = histories.map((h) => ({ ...h, excerpt: h.excerpt.slice(0, Math.max(120, Math.floor(h.excerpt.length * scale))) }))
    memories = memories.map((m) => ({ ...m, snippet: m.snippet.slice(0, Math.max(120, Math.floor(m.snippet.length * scale))) }))
  }

  contextLog({
    query: q,
    intent: intent.labels,
    current_conversation: currentConversation ? { id: currentConversation.conversationId, score: +currentConversation.score.toFixed(3) } : null,
    selected: {
      memories: memories.map((m) => ({ id: m.memoryId, score: +m.score.toFixed(3), low: !!m.lowConfidence })),
      histories: histories.map((h) => ({ id: h.conversationId, score: +h.score.toFixed(3) })),
    },
    rejected: rejected.slice(0, 12),
    ambiguity,
  })

  const pkg = {
    intent,
    currentConversation,
    histories,
    memories,
    ambiguity,
    lowConfidenceMemory: !!lowConfidenceMemory,
  }
  if (config.contextDebug) pkg.debug = debug
  return pkg
}

export async function retrieveContextForToken(token, userId, question, opts = {}) {
  return retrieveContextFrom(clientFor(token), userId, question, opts)
}

/**
 * Builds the dynamic 4-section prompt body fed to the local model. Every
 * section is populated at runtime from the context package - nothing static.
 */
export function buildContextPrompt(q, pkg) {
  const current = pkg.currentConversation
    ? pkg.currentConversation.turns.join('\n')
    : 'None yet.'

  const histories = pkg.histories.length
    ? pkg.histories.map((h) => `- ${h.title}\n${h.excerpt}`).join('\n\n')
    : 'None.'

  const memories = pkg.memories.length
    ? pkg.memories
        .map((m, i) => {
          const date = m.eventDate ? String(m.eventDate).slice(0, 10) : 'unknown date'
          const low = m.lowConfidence ? ' (weaker match - ask if it sounds right)' : ''
          return `[${i + 1}] id: ${m.memoryId} | ${m.type} | ${date}${low}\n${m.snippet}`
        })
        .join('\n\n')
    : 'None.'

  return (
    `CURRENT USER QUERY:\n${q}\n\n` +
    `CURRENT CONVERSATION CONTEXT:\n${current}\n\n` +
    `RELEVANT PREVIOUS CONVERSATIONS:\n${histories}\n\n` +
    `RELEVANT SAVED MEMORIES:\n${memories}`
  )
}