import { supabase } from './supabaseClient'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

export async function api(path, { token, ...options } = {}) {
  if (!token) {
    const { data } = await supabase.auth.getSession()
    token = data.session?.access_token
  }
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.message || data.error || 'Something went wrong. Please try again.')
  }
  return data
}

/**
 * Streaming Ask.
 *
 * Posts the same question as `api('/api/query')` but consumes the SSE response,
 * handing each event to `onEvent` as it arrives:
 *   { type: 'status', phase }  -> 'retrieving' | 'answering'
 *   { type: 'delta',  text }   -> one grounded sentence, safe to render
 *   { type: 'done',   ... }    -> authoritative answer, citations, suggestions
 *   { type: 'error',  message }
 *
 * `onDelta` receives only sentences the backend has already grounded. The final
 * `done` payload is the same shape the non-streaming route returns, so the caller
 * can reconcile whatever it painted live - including replacing the streamed text
 * if grounding ended up dropping all of it.
 *
 * Falls back to a normal POST when the server does not offer streaming, so the
 * feature degrades instead of breaking.
 */
export async function apiStream(path, { token, body, onEvent, signal } = {}) {
  if (!token) {
    const { data } = await supabase.auth.getSession()
    token = data.session?.access_token
  }
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.message || data.error || 'Something went wrong. Please try again.')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() || ''
    for (const frame of frames) {
      if (!frame.trim()) continue
      let event = 'message'
      const dataLines = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (!dataLines.length) continue
      try {
        onEvent?.({ type: event, data: JSON.parse(dataLines.join('\n')) })
      } catch {
        /* a partial frame is retried on the next read */
      }
    }
  }
}