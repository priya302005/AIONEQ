import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { useToast } from '../toast'
import { supabase } from '../supabaseClient'
import { MEMORY_TYPES } from '../memoryTypes.jsx'
import MemoryTypeCard from '../components/MemoryTypeCard.jsx'
import MemoryListItem from '../components/MemoryListItem.jsx'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal.jsx'

// Statuses are derived from the content the user saved, so filtering by them is
// a way to find memories that still need attention.
const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'ready', label: 'Ready' },
  { value: 'partial', label: 'Partial' },
  { value: 'failed', label: 'Needs attention' },
]

function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { notify } = useToast()
  const [memories, setMemories] = useState(null)
  const [error, setError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)

  // Search + filters are server-side: the archive is never loaded in full.
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [status, setStatus] = useState('')
  const [total, setTotal] = useState(null)

  // Debounce so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  const load = useCallback(async () => {
    setError('')
    const params = new URLSearchParams()
    if (search) params.set('q', search)
    if (type) params.set('type', type)
    if (status) params.set('status', status)
    const qs = params.toString()
    try {
      const res = await api(`/api/memories${qs ? `?${qs}` : ''}`)
      setMemories(res.data || [])
      setTotal(typeof res.total === 'number' ? res.total : null)
    } catch (err) {
      setError(err.message)
      setMemories([])
    }
  }, [search, type, status])

  // Per-type counts drive the "Add a Memory" cards. They come from their own
  // unfiltered fetch so a search or filter never changes the totals.
  const [counts, setCounts] = useState({})

  const loadCounts = useCallback(async () => {
    try {
      const res = await api('/api/memories?limit=100')
      const next = {}
      for (const m of res.data || []) next[m.type] = (next[m.type] || 0) + 1
      setCounts(next)
    } catch {
      setCounts({})
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setMemories(null)
    load().catch(() => { if (!cancelled) setMemories([]) })
    return () => { cancelled = true }
  }, [load])

  useEffect(() => { loadCounts() }, [loadCounts])

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const snapshot = memories
    setMemories((prev) => prev.filter((m) => m.id !== deleteTarget.id))
    setDeleting(true)
    try {
      await api(`/api/memories/${deleteTarget.id}`, { method: 'DELETE' })
      setDeleteTarget(null)
      notify('Memory deleted.')
      // A filter/search may have hidden rows this delete did not cover.
      load()
      loadCounts()
    } catch (err) {
      setMemories(snapshot)
      setError(err.message)
    } finally {
      setDeleting(false)
    }
  }

  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'there'
  const filtering = Boolean(search || type || status)

  return (
    <main className="dashboard-wrap">
      <div className="section-container">
        <div className="dashboard-head reveal visible">
          <span className="section-tag">Your Archive</span>
          <h2 className="section-h2">Welcome back, <span className="gradient-text">{fullName}</span></h2>
          <p className="section-sub">Add a new memory or revisit what you've preserved.</p>
        </div>

        <div className="ask-teaser reveal visible">
          <div className="ask-teaser-main">
            <span className="section-tag">Ask Your Archive</span>
            <p className="ask-teaser-text">Ask EchoMind anything about your memories — it answers only from what you've preserved.</p>
          </div>
          <button type="button" className="btn-cta btn-pill" onClick={() => navigate('/dashboard/ask')}>
            Ask your archive
          </button>
        </div>

        {error && (
          <div className="auth-banner error" role="alert">
            {error}
          </div>
        )}

        <section className="dash-section reveal visible">
          <h3 className="dash-section-title">Add a Memory</h3>
          <div className="memory-grid">
            {MEMORY_TYPES.map((mt) => (
              <MemoryTypeCard
                key={mt.type}
                memoryType={mt}
                count={counts[mt.type] ?? 0}
                onSelect={(type) => navigate(`/dashboard/upload/${type}`)}
              />
            ))}
          </div>
        </section>

        <section className="dash-section reveal visible">
          <h3 className="dash-section-title">Recent Memories</h3>

          <div className="archive-tools">
            <div className="archive-search">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your archive by meaning, not just keywords…"
                aria-label="Search your memories"
              />
            </div>

            <div className="archive-filters">
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                aria-label="Filter by memory type"
              >
                <option value="">All types</option>
                {MEMORY_TYPES.map((mt) => (
                  <option key={mt.type} value={mt.type}>{mt.title}</option>
                ))}
              </select>

              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                aria-label="Filter by analysis status"
              >
                {STATUS_FILTERS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>

              {filtering && (
                <button
                  type="button"
                  className="btn-ghost btn-pill"
                  onClick={() => { setQuery(''); setType(''); setStatus('') }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {memories !== null && memories.length > 0 && (
            <p className="dash-muted archive-count">
              {filtering
                ? `${memories.length} matching ${memories.length === 1 ? 'memory' : 'memories'}`
                : `Showing your ${memories.length} most recent ${memories.length === 1 ? 'memory' : 'memories'}`}
            </p>
          )}

          {memories === null && <p className="dash-muted">Loading your memories…</p>}

          {memories !== null && memories.length === 0 && (
            <div className="empty-state">
              <span className="empty-emoji" role="img" aria-hidden="true">🌅</span>
              <h4>{filtering ? 'No memories match' : 'No memories yet'}</h4>
              <p>{filtering
                ? 'Try a different wording, or clear the filters to see everything.'
                : 'Your archive is waiting. Preserve your first memory to get started.'}</p>
              {filtering ? (
                <button
                  type="button"
                  className="btn-cta btn-pill"
                  onClick={() => { setQuery(''); setType(''); setStatus('') }}
                >
                  Clear filters
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-cta btn-pill"
                  onClick={() => navigate('/dashboard/upload/journal')}
                >
                  Add your first memory
                </button>
              )}
            </div>
          )}

          {memories !== null && memories.length > 0 && (
            <div className="memory-list">
              {memories.map((m) => (
                <MemoryListItem
                  key={m.id}
                  memory={m}
                  onOpen={(mem) => navigate(`/dashboard/memories/${mem.id}`)}
                  onEdit={(mem) => navigate(`/dashboard/memories/${mem.id}`)}
                  onDelete={setDeleteTarget}
                />
              ))}
            </div>
          )}
        </section>

        <button type="button" className="dash-logout" onClick={async () => {
          await supabase.auth.signOut()
          notify('Logged out.')
          navigate('/')
        }}>
          Log out
        </button>
      </div>

      {deleteTarget && (
        <ConfirmDeleteModal
          title={deleteTarget.title}
          busy={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}
    </main>
  )
}

export default Dashboard