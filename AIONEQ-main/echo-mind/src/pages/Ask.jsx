import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
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

    setMessages((prev) => [...prev, userMsg])
    setSending(true)
    setError('')

    try {
      const res = await api('/api/query', {
        method: 'POST',
        body: JSON.stringify({ question: text, conversationId: urlId }),
      })

      const assistantMsg = {
        id: `${res.conversationId || 'local'}-${now}-a`,
        role: 'assistant',
        content: res.answer,
        citedMemories: res.citedMemories || [],
        // Every memory that informed the answer, so the chat can show what it
        // drew on even when the model cited only some of them.
        usedMemories: res.usedMemories || [],
        suggestions: res.suggestions || [],
        createdAt: now,
      }

      setMessages((prev) => [...prev, assistantMsg])
      if (res.conversationId) {
        loadedForId.current = res.conversationId
        setSearchParams({ c: res.conversationId }, { replace: true })
      }
      refreshConversations()
    } catch (err) {
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