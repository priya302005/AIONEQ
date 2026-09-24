import crypto from 'node:crypto'
import { config } from '../config/config.js'
import retrieveRelevantMemories from '../utils/retrieveMemories.js'
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversationRow,
  removeConversationRow,
  renameConversationRow,
} from '../models/conversation.model.js'
import { asyncHandler } from '../utils/asyncHandler.js'

const CITATION_RE = /\(cite:\s*([0-9a-fA-F-]{36})\)|\[([0-9a-fA-F-]{36})\]/g
const MAX_RETRIEVED = 6

function truncate(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function isMissingConversationsTable(msg) {
  return /relation .*conversations.* does not exist|could not find the table ['"]?public\.conversations['"]?/i.test(msg || '')
}

function missingTableHint(msg) {
  return isMissingConversationsTable(msg)
    ? 'Conversations table is missing. Run the SQL in backend/sql/query.sql in your Supabase dashboard.'
    : msg
}

async function callLocalAi(system, userContent, maxTokens = 700) {
  const url = `${config.localAiBaseUrl}/v1/chat/completions`
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.localAiModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        temperature: 0.5,
        top_p: 0.9,
        repeat_penalty: 1.2,
        frequency_penalty: 0.3,
        presence_penalty: 0.3,
        max_tokens: maxTokens,
        stream: false,
      }),
    })
  } catch {
    throw new Error(
      `Cannot reach the local AI at ${config.localAiBaseUrl}. Make sure your local model app is running with its API server enabled (GPT4All: Settings -> Local API Server -> Enable).`
    )
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    throw new Error(`Local AI error (${res.status}): ${truncate(raw, 200)}`)
  }

  const data = await res.json()
  return (data.choices?.[0]?.message?.content || '').trim()
}

function extractCitedIds(text, available) {
  const ids = new Set()
  const availableSet = new Set(available.map((m) => m.memoryId))
  let match
  CITATION_RE.lastIndex = 0
  while ((match = CITATION_RE.exec(text)) !== null) {
    const id = (match[1] || match[2] || '').toLowerCase()
    if (availableSet.has(id)) ids.add(id)
  }
  return [...ids]
}

function splitFollowUps(raw) {
  const marker = '---FOLLOW-UPS---'
  const idx = raw.indexOf(marker)
  if (idx === -1) return { answer: raw.trim(), suggestions: [] }

  const answer = raw.slice(0, idx).trim()
  const suggestions = raw
    .slice(idx + marker.length)
    .split('\n')
    .map((line) => line.replace(/^\s*[\d\-•*]+[).\-•*]*\s*/, '').trim())
    .map((line) => line.replace(/^[—–-]\s*/, '').trim())
    .map((line) => line.replace(/["“”]/g, '').trim())
    .filter(Boolean)
    .slice(0, 3)

  return { answer, suggestions }
}

export const askQuestion = asyncHandler(async (req, res) => {
  const { question, conversationId } = req.body

  if (!question || !String(question).trim()) {
    return res.status(400).json({ success: false, message: 'Question is required.' })
  }
  const q = String(question).trim()

  const memories = await retrieveRelevantMemories(req.accessToken, q, MAX_RETRIEVED)

  let answer
  let suggestions = []
  let cited = []

  if (!memories.length) {
    answer = "I don't have any memories about that yet."
  } else {
    const context = memories
      .map((m, i) => {
        const date = m.eventDate ? new Date(m.eventDate).toISOString().slice(0, 10) : 'unknown date'
        return `[${i + 1}] id: ${m.memoryId} | ${m.type} | ${date}\n${m.snippet}`
      })
      .join('\n\n')

    const system = [
      "You are EchoMind, an assistant that answers questions ONLY from the user's own memory archive.",
      'Ground every part of your answer in the provided memory excerpts.',
      'If the memories do not cover what the user asks about, say explicitly: "Your memories don\u2019t mention this."',
      'Never answer from general knowledge instead of the given excerpts.',
      'When you use a memory, cite it immediately after the relevant sentence in the form (cite: <memory id>).',
      'Keep answers warm, concise, and in plain language.',
      'After your answer, add exactly 3 short follow-up questions that build naturally on this conversation and its excerpts.',
      'Begin that section with a line containing only: ---FOLLOW-UPS---',
      'Then list one question per line, numbered like "1) ...", "2) ...", "3) ...".',
      'Do not include the ---FOLLOW-UPS--- marker inside your main answer text.',
    ].join(' ')

    let raw
    try {
      raw = await callLocalAi(
        system,
        `# User's question\n${q}\n\n# Memory excerpts to use\n${context}`
      )
    } catch (err) {
      return res.status(502).json({ success: false, message: err.message })
    }

    const parsed = splitFollowUps(raw)
    answer = parsed.answer
    suggestions = parsed.suggestions

    const ids = extractCitedIds(answer, memories)
    cited = ids
      .map((id) => memories.find((m) => m.memoryId === id))
      .filter(Boolean)
  }

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
    })),
    suggestions,
    createdAt: now,
  }

  let convId = conversationId
  if (convId) {
    const existing = await getConversation(req.accessToken, convId)
    if (existing.error) {
      return res.status(400).json({ success: false, message: existing.error.message })
    }
    if (!existing.data) {
      return res.status(404).json({ success: false, message: 'Conversation not found.' })
    }
    const messages = [...(existing.data.messages || []), userMsg, assistantMsg]
    const updated = await updateConversationRow(req.accessToken, convId, {
      messages,
      updated_at: now,
    })
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

  res.json({ success: true, conversationId: convId, answer, citedMemories: cited, suggestions })
})

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
    data: (data || []).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updated_at })),
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
  res.json({
    success: true,
    data: { id: data.id, title: data.title, updatedAt: data.updated_at, messages: data.messages || [] },
  })
})

export const deleteConversationController = asyncHandler(async (req, res) => {
  const { data, error } = await removeConversationRow(req.accessToken, req.params.id)
  if (error) {
    return res.status(400).json({ success: false, message: error.message })
  }
  if (!data) {
    return res.status(404).json({ success: false, message: 'Conversation not found.' })
  }
  res.json({ success: true, message: 'Conversation deleted.' })
})

export const renameConversationController = asyncHandler(async (req, res) => {
  const { title } = req.body
  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, message: 'Title is required.' })
  }
  const cleanTitle = String(title).trim().slice(0, 80)
  const { data, error } = await renameConversationRow(req.accessToken, req.params.id, cleanTitle)
  if (error) {
    return res.status(400).json({ success: false, message: error.message })
  }
  if (!data) {
    return res.status(404).json({ success: false, message: 'Conversation not found.' })
  }
  res.json({ success: true, data: { id: data.id, title: data.title, updatedAt: data.updated_at } })
})