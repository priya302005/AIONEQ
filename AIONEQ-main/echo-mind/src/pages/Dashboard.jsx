import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { useToast } from '../toast'
import { supabase } from '../supabaseClient'
import { MEMORY_TYPES } from '../memoryTypes.jsx'
import MemoryTypeCard from '../components/MemoryTypeCard.jsx'
import MemoryListItem from '../components/MemoryListItem.jsx'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal.jsx'

function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { notify } = useToast()
  const [memories, setMemories] = useState(null)
  const [error, setError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await api('/api/memories')
        if (!cancelled) setMemories(res.data || [])
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const snapshot = memories
    setMemories((prev) => prev.filter((m) => m.id !== deleteTarget.id))
    setDeleting(true)
    try {
      await api(`/api/memories/${deleteTarget.id}`, { method: 'DELETE' })
      setDeleteTarget(null)
      notify('Memory deleted.')
    } catch (err) {
      setMemories(snapshot)
      setError(err.message)
    } finally {
      setDeleting(false)
    }
  }

  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'there'

  const counts = (memories || []).reduce((acc, m) => {
    acc[m.type] = (acc[m.type] || 0) + 1
    return acc
  }, {})

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

          {memories === null && <p className="dash-muted">Loading your memories…</p>}

          {memories !== null && memories.length === 0 && (
            <div className="empty-state">
              <span className="empty-emoji" role="img" aria-hidden="true">🌅</span>
              <h4>No memories yet</h4>
              <p>Your archive is waiting. Preserve your first memory to get started.</p>
              <button
                type="button"
                className="btn-cta btn-pill"
                onClick={() => navigate('/dashboard/upload/journal')}
              >
                Add your first memory
              </button>
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