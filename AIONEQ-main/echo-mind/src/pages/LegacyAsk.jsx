import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useToast } from '../toast'
import Logo from '../Logo.jsx'

/**
 * Ask about an archive shared with you (legacy / referral access).
 *
 * Additive page: it only calls two endpoints the backend already authorizes on
 * every request (GET /api/legacy/access, POST /api/legacy/archive/:ownerId/ask).
 * Nothing is saved, and the server - not this page - decides whether you may ask.
 */
function LegacyAsk() {
  const { notify } = useToast()
  const [archives, setArchives] = useState([])
  const [loading, setLoading] = useState(true)
  const [ownerId, setOwnerId] = useState('')
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => {
    let alive = true
    api('/api/legacy/access')
      .then((res) => {
        if (!alive) return
        const list = res.data || []
        setArchives(list)
        if (list.length) setOwnerId(list[0].ownerId)
      })
      .catch((err) => notify(err.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [notify])

  async function submit(e) {
    e.preventDefault()
    const q = question.trim()
    if (!q || !ownerId || asking) return
    setAsking(true)
    setError('')
    setResult(null)
    try {
      const res = await api(`/api/legacy/archive/${ownerId}/ask`, {
        method: 'POST',
        body: JSON.stringify({ question: q }),
      })
      setResult(res)
    } catch (err) {
      // 403 = access revoked or never granted; 503 = could not verify right now.
      setError(err.message)
    } finally {
      setAsking(false)
    }
  }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <Logo />
          <span className="auth-eyebrow">Shared archive</span>
          <h2>Ask about their memories</h2>
          <p>
            Answers come only from memories they chose to share. They are reflections on what is written,
            not their own words, and they never claim to know unrecorded thoughts.
          </p>
        </div>

        {loading ? (
          <p className="md-muted">Loading…</p>
        ) : archives.length === 0 ? (
          <section className="sec-settings-card">
            <p className="md-muted">
              No archive has been shared with you yet. Claim an invitation on the{' '}
              <Link to="/dashboard/legacy-access">legacy access page</Link>.
            </p>
          </section>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            {archives.length > 1 && (
              <label className="auth-field">
                <span>Archive</span>
                <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                  {archives.map((a, i) => (
                    <option key={a.grantId} value={a.ownerId}>
                      Archive {i + 1} · {a.memoryCount} memories
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="auth-field">
              <span>Your question</span>
              <textarea
                rows={3}
                maxLength={4000}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="What did they value most? What advice did they write about education?"
              />
            </label>
            {error && (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn-primary" type="submit" disabled={asking || !question.trim()}>
              {asking ? 'Reading their memories…' : 'Ask'}
            </button>
          </form>
        )}

        {result && (
          <section className="sec-settings-card" aria-label="Answer" aria-live="polite">
            <h4 className="md-section-title">Answer</h4>
            <p style={{ whiteSpace: 'pre-wrap' }}>{result.answer}</p>
            {result.citedMemories?.length > 0 && (
              <>
                <h4 className="md-section-title">From these memories</h4>
                <ul className="legacy-list">
                  {result.citedMemories.map((m) => (
                    <li key={m.memoryId} className="legacy-row">
                      <div>
                        <strong>{m.title || 'Memory'}</strong>
                        <span className="legacy-sub">
                          {m.type}
                          {m.eventDate ? ` · ${new Date(m.eventDate).toLocaleDateString()}` : ''}
                        </span>
                        {m.snippet && <p className="md-muted">{m.snippet}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        <p className="md-muted">
          <Link to="/dashboard/legacy-access">Back to legacy access</Link>
        </p>
      </div>
    </main>
  )
}

export default LegacyAsk
