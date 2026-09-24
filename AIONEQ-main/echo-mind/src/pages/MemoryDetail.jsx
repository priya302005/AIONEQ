import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { getMemoryType } from '../memoryTypes.jsx'
import { useToast } from '../toast'
import { absoluteFileUrl } from '../backendUrl.js'
import { formatDuration, formatFullDate, formatMemoryDate, formatRelativeTime } from '../formatRelativeTime.js'
import MemoryCardMenu from '../components/MemoryCardMenu.jsx'
import EditableField from '../components/EditableField.jsx'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal.jsx'

const TYPE_LABELS = { voice: 'Voice', journal: 'Journal', email: 'Email', document: 'Document', story: 'Story' }

function mimeLabel(mimeType) {
  if (!mimeType) return ''
  const part = mimeType.split('/').pop()
  return part ? part.toUpperCase() : ''
}

function MemoryDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { notify } = useToast()

  const [memory, setMemory] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingContent, setEditingContent] = useState(false)
  const [contentDraft, setContentDraft] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await api(`/api/memories/${id}`)
        if (!cancelled) setMemory(res.data)
      } catch (err) {
        if (!cancelled) setLoadError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [id])

  const applyUpdate = async (patch) => {
    setSaving(true)
    try {
      const res = await api(`/api/memories/${id}`, { method: 'PUT', body: JSON.stringify(patch) })
      setMemory(res.data)
      setEditingContent(false)
      notify('Memory updated.')
    } catch (err) {
      notify(err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const saveTitle = (title) => applyUpdate({ title })
  const saveTags = (tags) => applyUpdate({ tags })

  const startContentEdit = () => {
    setContentDraft(memory.content || '')
    setEditingContent(true)
  }

  const saveContent = () => applyUpdate({ content: contentDraft })
  const cancelContentEdit = () => setEditingContent(false)

  const confirmDelete = async () => {
    setDeleting(true)
    try {
      await api(`/api/memories/${id}`, { method: 'DELETE' })
      setConfirming(false)
      notify('Memory deleted.')
      navigate('/dashboard')
    } catch (err) {
      notify(err.message, 'error')
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <main className="auth-wrap">
        <div className="auth-card md-card">
          <p className="dash-muted">Loading memory…</p>
        </div>
      </main>
    )
  }

  if (loadError || !memory) {
    return (
      <main className="auth-wrap">
        <div className="auth-card md-card">
          <div className="auth-banner error" role="alert">{loadError || 'Memory not found.'}</div>
          <p className="auth-switch">
            <Link to="/dashboard" className="auth-link">← Back to Dashboard</Link>
          </p>
        </div>
      </main>
    )
  }

  const config = getMemoryType(memory.type)
  const fileUrl = absoluteFileUrl(memory.file_url)
  const created = memory.created_at
  const updated = memory.updated_at
  const canShowEdited = updated && created && new Date(updated).getTime() > new Date(created).getTime()
  const editableText = Boolean(memory.content?.trim())

  return (
    <main className="auth-wrap memory-detail-wrap">
      <div className="auth-card md-card">
        <div className="md-eyebrow" style={{ color: 'var(--primary)' }}>
          {config?.Eyebrow || memory.type.toUpperCase()}
        </div>

        <div className="md-title-row">
          <EditableField value={memory.title} onSave={saveTitle} placeholder="Title">
            <h2 className="md-title">{memory.title}</h2>
          </EditableField>
          <MemoryCardMenu
            onEdit={() => setEditingContent(true)}
            onDelete={() => setConfirming(true)}
          />
        </div>

        <div className="md-meta">
          <span className="memory-badge">{TYPE_LABELS[memory.type] || memory.type}</span>
          {memory.event_date && (
            <span className="md-meta-item" title={formatFullDate(memory.event_date)}>
              <span className="md-meta-label">Happened:</span>
              <span className="md-meta-value">{formatMemoryDate(memory.event_date)}</span>
            </span>
          )}
          <span className="md-meta-item" title={formatFullDate(created)}>
            <span className="md-meta-label">Added:</span>
            <span className="md-meta-value">{formatRelativeTime(created)}</span>
          </span>
          {canShowEdited && (
            <span className="md-meta-item" title={formatFullDate(updated)}>
              <span className="md-meta-label">Last edited:</span>
              <span className="md-meta-value">{formatRelativeTime(updated)}</span>
            </span>
          )}
        </div>

        <div className="md-section">
          <h4 className="md-section-title">Tags</h4>
          <EditableField
            value={((memory.tags || [])).join(', ')}
            onSave={(v) => saveTags(v.split(',').map((t) => t.trim()).filter(Boolean))}
            placeholder="tag1, tag2"
            inputClassName="editable-input-tags"
          >
            {memory.tags?.length ? (
              <div className="tag-chips">
                {memory.tags.map((t) => <span key={t} className="tag-chip">{t}</span>)}
              </div>
            ) : (
              <span className="md-muted">No tags yet</span>
            )}
          </EditableField>
        </div>

        <div className="md-section">
          <h4 className="md-section-title">Content</h4>

          {memory.type === 'voice' && fileUrl ? (
            <div className="voice-player">
              <audio controls src={fileUrl} preload="metadata" />
              {formatDuration(memory.duration) && (
                <span className="voice-duration">{formatDuration(memory.duration)}</span>
              )}
            </div>
          ) : null}

          {!editableText ? (
            <div className="memory-detail-file-block">
              {memory.type === 'document' ? (
                <a className="memory-detail-file" href={fileUrl} target="_blank" rel="noreferrer">
                  Open document{mimeLabel(memory.mime_type) ? ` (${mimeLabel(memory.mime_type)})` : ''}
                </a>
              ) : (
                <span className="md-muted">No text content yet.</span>
              )}
            </div>
          ) : editingContent ? (
            <div className="content-edit">
              <textarea
                autoFocus
                className="transcript-input"
                rows={7}
                value={contentDraft}
                onChange={(e) => setContentDraft(e.target.value)}
                disabled={saving}
              />
              <div className="content-edit-actions">
                <button type="button" className="btn-cta btn-pill" onClick={saveContent} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button type="button" className="btn-ghost btn-pill" onClick={cancelContentEdit} disabled={saving}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="content-display">
              <pre className="memory-detail-content">{memory.content}</pre>
              <button type="button" className="editable-pencil content-edit-btn" aria-label="Edit content" onClick={startContentEdit}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
                Edit
              </button>
            </div>
          )}
        </div>

        <button type="button" className="md-delete" onClick={() => setConfirming(true)}>
          Delete memory
        </button>

        <p className="auth-switch">
          <Link to="/dashboard" className="auth-link">← Back to Dashboard</Link>
        </p>
      </div>

      {confirming && (
        <ConfirmDeleteModal
          title={memory.title}
          busy={deleting}
          onCancel={() => setConfirming(false)}
          onConfirm={confirmDelete}
        />
      )}
    </main>
  )
}

export default MemoryDetail