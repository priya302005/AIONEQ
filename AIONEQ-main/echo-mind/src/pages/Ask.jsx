import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, apiStream } from '../api'
import { useToast } from '../toast'
import ConversationSidebar from '../query/components/ConversationSidebar.jsx'
import ChatThread from '../query/components/ChatThread.jsx'
import ChatInput from '../query/components/ChatInput.jsx'
import SuggestedQuestions from '../query/components/SuggestedQuestions.jsx'
import MemoryDetailModal from '../query/components/MemoryDetailModal.jsx'

function uuid() {
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

function Ask() {
  const { notify } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const urlId = searchParams.get('c')

  const [conversations, setConversations] = useState([])
  const [messages, setMessages] = useState([])
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [modalMemory, setModalMemory] = useState(null)

  const loadedForId = useRef(null)

  const refreshConversations = useCallback(async () => {
    try {
      const res = await api('/api/query/conversations')
      setConversations(res.data || [])
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api('/api/query/conversations')
      .then((res) => { if (!cancelled) setConversations(res.data || []) })
      .catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [])

  const selectConversation = (id) => {
    setSearchParams({ c: id }, { replace: true })
  }

  const newConversation = () => {
    setMessages([])
    setError('')
    setSearchParams({}, { replace: true })
  }

  const deleteConversation = async (convo) => {
    try {
      await api(`/api/query/conversations/${convo.id}`, { method: 'DELETE' })
    } catch (err) {
      setError(err.message)
      throw err
    }
    setConversations((prev) => prev.filter((c) => c.id !== convo.id))
    if (convo.id === urlId) {
      setMessages([])
      loadedForId.current = null
      setSearchParams({}, { replace: true })
    }
  }

  const renameConversation = async (id, title, previous) => {
    const clean = String(title || '').trim().slice(0, 80)
    if (!clean) throw new Error('Title is required.')
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: clean } : c)))
    try {
      await api(`/api/query/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title: clean }) })
    } catch (err) {
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: previous } : c)))
      setError(err.message)
      throw err
    }
  }

  useEffect(() => {
    if (!urlId || urlId === loadedForId.current) return
    let cancelled = false
    setLoading(true)
    setError('')
    async function load() {
      try {
        const res = await api(`/api/query/conversations/${urlId}`)
        if (!cancelled) {
          setMessages(res.data.messages || [])
          loadedForId.current = urlId
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [urlId])

  const send = async (question) => {
    const text = String(question).trim()
    if (!text || sending) return

    const now = new Date().toISOString()
    const userMsg = { id: uuid(), role: 'user', content: text, citedMemories: [], createdAt: now }
    const streamId = `stream-${now}`

    setMessages((prev) => [
      ...prev,
      userMsg,
      // Painted immediately and grown as grounded sentences arrive, so the reply
      // starts landing in about a second instead of after the whole answer.
      { id: streamId, role: 'assistant', content: '', citedMemories: [], suggestions: [], createdAt: now, streaming: true },
    ])
    setSending(true)
    setError('')

    const appendDelta = (chunk) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === streamId ? { ...m, content: `${m.content}${m.content ? ' ' : ''}${chunk}` } : m))
      )
    }

    try {
      let final = null
      await apiStream('/api/query/stream', {
        body: { question: text, conversationId: urlId },
        onEvent: ({ type, data }) => {
          if (type === 'delta') appendDelta(data.text)
          else if (type === 'done') final = data
          else if (type === 'error') throw new Error(data.message)
        },
      })

      if (!final) throw new Error('The stream ended before an answer arrived.')

      // The streamed text is provisional. `done` is authoritative, so it always
      // wins - that is what makes a dropped or corrected sentence safe.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamId
            ? {
                ...m,
                content: final.answer,
                citedMemories: final.citedMemories || [],
                usedMemories: final.usedMemories || [],
                suggestions: final.suggestions || [],
                streaming: false,
              }
            : m
        )
      )
      if (final.conversationId) {
        loadedForId.current = final.conversationId
        setSearchParams({ c: final.conversationId }, { replace: true })
      }
      refreshConversations()
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamId
            ? { ...m, content: err.message || 'Something went wrong.', streaming: false, failed: true }
            : m
        )
      )
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  const openMemory = async (memoryId) => {
    try {
      const res = await api(`/api/memories/${memoryId}`)
      setModalMemory(res.data)
    } catch (err) {
      notify(err.message)
    }
  }

  return (
    <main className="dashboard-wrap ask-wrap">
      <div className="ask-layout">
        <ConversationSidebar
          conversations={conversations}
          activeId={urlId}
          onSelect={selectConversation}
          onNew={newConversation}
          onRename={renameConversation}
          onDelete={deleteConversation}
        />

        <section className="chat-card">
          {error && (
            <div className="auth-banner error" role="alert">
              {error}
            </div>
          )}

          <div className="chat-scroll">
            <ChatThread messages={messages} sending={sending} onOpenMemory={openMemory} onPickFollowUp={send} />
            {messages.length === 0 && !sending && !loading && (
              <div className="chat-footer-inner">
                <SuggestedQuestions onPick={send} disabled={sending} />
                <ChatInput onSend={send} sending={sending} disabled={loading} />
              </div>
            )}
          </div>

          {messages.length > 0 || sending || loading ? (
            <div className="chat-footer">
              <ChatInput onSend={send} sending={sending} disabled={loading} />
            </div>
          ) : null}
        </section>
      </div>

      <MemoryDetailModal memory={modalMemory} onClose={() => setModalMemory(null)} />
    </main>
  )
}

export default Ask