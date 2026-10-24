import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'

/**
 * Lets a legacy recipient ask questions about ONE owner's archive.
 *
 * Talks to POST /api/legacy/archive/:ownerId/ask. The backend re-checks the
 * grant on every request, searches only the owner's memories, and saves nothing,
 * so this panel keeps the exchange in component state only: close the page and
 * it is gone, by design.
 */
export default function LegacyAskPanel({ ownerId }) {
  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState([]) // { id, question, answer, used, cited, suggestions, error }
  const [busy, setBusy] = useState(false)
  const nextId = useRef(1)

  async function ask(text) {
    const q = String(text || '').trim()
    if (!q || busy) return
    const id = nextId.current++
    setBusy(true)
    setQuestion('')
    setTurns((t) => [...t, { id, question: q, pending: true }])
    try {
      const res = await api(`/api/legacy/archive/${ownerId}/ask`, {
        method: 'POST',
        body: JSON.stringify({ question: q }),
      })
      const citedIds = new Set((res.citedMemories || []).map((c) => (typeof c === 'string' ? c : c.memoryId)))
      const used = res.usedMemories || []
      const sources = (citedIds.size ? used.filter((m) => citedIds.has(m.memoryId)) : used).slice(0, 6)
      setTurns((t) =>
        t.map((x) =>
          x.id === id
            ? { id, question: q, answer: res.answer, sources, suggestions: res.suggestions || [] }
            : x
        )
      )
    } catch (err) {
      setTurns((t) => t.map((x) => (x.id === id ? { id, question: q, error: err.message } : x)))
    } finally {
      setBusy(false)
    }
  }

  function submit(e) {
    e.preventDefault()
    ask(question)
  }

  const last = turns[turns.length - 1]

  return (
    <div className="legacy-ask">
      <p className="md-section-title">Ask about this person</p>
      <p className="md-muted">
        Answers come only from what they chose to share, and are never guesses about what they thought.
        Nothing you ask here is saved.
      </p>

      {turns.length > 0 && (
        <ul className="legacy-ask-thread" aria-live="polite">
          {turns.map((t) => (
            <li key={t.id} className="legacy-ask-turn">
              <p className="legacy-ask-q">{t.question}</p>
              {t.pending && <p className="md-muted">Searching their memories…</p>}
              {t.error && <p className="auth-error" role="alert">{t.error}</p>}
              {t.answer && <p className="legacy-ask-a">{t.answer}</p>}
              {t.sources?.length > 0 && (
                <p className="legacy-sub">
                  Based on:{' '}
                  {t.sources.map((m, i) => (
                    <span key={m.memoryId}>
                      {i > 0 && ', '}
                      <Link to={`/dashboard/memories/${m.memoryId}`} className="archive-memory-link">
                        {m.title || 'Memory'}
                      </Link>
                    </span>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {last?.suggestions?.length > 0 && !busy && (
        <div className="legacy-ask-suggestions">
          {last.suggestions.slice(0, 3).map((s) => (
            <button key={s} type="button" className="btn-ghost btn-pill" onClick={() => ask(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <form className="auth-form" onSubmit={submit}>
        <label className="auth-field">
          <span>Your question</span>
          <input
            type="text"
            value={question}
            maxLength={4000}
            placeholder="e.g. What did they value most?"
            onChange={(e) => setQuestion(e.target.value)}
            disabled={busy}
          />
        </label>
        <button type="submit" className="btn-cta btn-pill" disabled={busy || !question.trim()}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>
    </div>
  )
}
