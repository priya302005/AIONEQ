import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { getMemoryType } from '../memoryTypes.jsx'
import { useToast } from '../toast'
import { formatDuration, formatFullDate, formatMemoryDate, formatRelativeTime } from '../formatRelativeTime.js'
import { useSignedFileUrl } from '../hooks/useSignedFileUrl.js'
import MemoryCardMenu from '../components/MemoryCardMenu.jsx'
import EditableField from '../components/EditableField.jsx'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal.jsx'

const TYPE_LABELS = { voice: 'Voice', journal: 'Journal', email: 'Email', document: 'Document', story: 'Story' }

/** Plain-language copy for each pipeline state, and whether a retry makes sense. */
const STATUS_COPY = {
  pending: { title: 'EchoMind is still reading this memory', body: 'It will finish in the background — you can leave this page.', retry: false },
  processing: { title: 'EchoMind is still reading this memory', body: 'It will finish in the background — you can leave this page.', retry: false },
  ready: { title: null, body: null, retry: false },
  partial: { title: 'Saved, but not fully analysed', body: 'Part of the analysis could not finish. Your original content is stored exactly as you wrote it.', retry: true },
  failed: { title: 'Analysis did not finish', body: 'Your memory is saved and readable. Only the automatic analysis failed, so Ask may know less about it.', retry: true },
}

/** Relationship labels, phrased as suggestions the user accepts or dismisses. */
const RELATION_COPY = {
  duplicate: 'Looks like a duplicate of',
  follow_up: 'Looks like a follow-up to',
  supersedes: 'Looks like it updates',
  related: 'Related to',
}

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

  // Pipeline state and relationship proposals, from GET /api/memories/:id
  const [processing, setProcessing] = useState(null)
  const [links, setLinks] = useState([])
  const [reprocessing, setReprocessing] = useState(false)
  const [linkBusy, setLinkBusy] = useState(null)

  // Hooks must stay above the early returns (rules of hooks). Handles null memory.
  const { url: fileUrl, error: fileError } = useSignedFileUrl(memory)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await api(`/api/memories/${id}`)
        if (!cancelled) {
          setMemory(res.data)
          setProcessing(res.processing || null)
          setLinks(res.links || [])
        }
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
      // An edit invalidates the derived data, so the status goes back to pending.
      if (res.processing) setProcessing(res.processing)
      setEditingContent(false)
      notify('Memory updated.')
    } catch (err) {
      notify(err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  /** Re-run transcription / extraction / analysis for this memory. */
  const reprocess = async () => {
    setReprocessing(true)
    try {
      const res = await api(`/api/memories/${id}/reprocess`, { method: 'POST' })
      setProcessing(res.processing || null)
      notify(res.message || 'Re-analysing this memory.')
    } catch (err) {
      notify(err.message, 'error')
    } finally {
      setReprocessing(false)
    }
  }

  /**
   * Approve or dismiss a relationship proposal. This is the ONLY thing that
   * makes a suggestion take effect, and dismissing simply hides it again.
   */
  const resolveLink = async (linkId, status) => {
    setLinkBusy(linkId)
    try {
      const res = await api(`/api/memory-links/${linkId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      setLinks((prev) => prev.map((l) => (l.id === linkId ? { ...l, ...res.data } : l)))
      notify(status === 'approved' ? 'Suggestion accepted.' : 'Suggestion dismissed.')
    } catch (err) {
      notify(err.message, 'error')
    } finally {
      setLinkBusy(null)
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
  const created = memory.created_at
  const updated = memory.updated_at
  const canShowEdited = updated && created && new Date(updated).getTime() > new Date(created).getTime()
  const editableText = Boolean(memory.content?.trim())

  const topics = Array.isArray(memory.topics) ? memory.topics : []
  const statusCopy = STATUS_COPY[processing?.status] || STATUS_COPY.ready
  const proposals = links.filter((l) => l.status === 'proposed' && l.relatedMemory)
  const accepted = links.filter((l) => l.status === 'approved' && l.relatedMemory)

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
          {processing?.status && processing.status !== 'ready' && (
            <span className={`memory-status memory-status-${processing.status}`}>{STATUS_COPY[processing.status]?.title || processing.status}</span>
          )}
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

        {statusCopy.title && (
          <div className={`md-notice memory-status-${processing?.status}`} role="status">
            <div className="md-notice-body">
              <strong>{statusCopy.title}</strong>
              <span>{statusCopy.body}</span>
              {processing?.error && <span className="md-notice-detail">{processing.error}</span>}
            </div>
            {statusCopy.retry && (
              <button type="button" className="btn-ghost btn-pill" onClick={reprocess} disabled={reprocessing}>
                {reprocessing ? 'Retrying…' : 'Try again'}
              </button>
            )}
          </div>
        )}

        {topics.length > 0 && (
          <div className="md-section">
            <h4 className="md-section-title">Topics EchoMind picked up</h4>
            <div className="tag-chips">
              {topics.map((t) => <span key={t} className="tag-chip">{t}</span>)}
            </div>
            <p className="md-muted">
              Derived from what you saved, to help Ask find this memory. Your words above are never replaced.
            </p>
          </div>
        )}

        {(proposals.length > 0 || accepted.length > 0) && (
          <div className="md-section">
            <h4 className="md-section-title">Related memories</h4>
            <p className="md-muted">
              Suggestions only. Nothing is merged, changed, or deleted unless you accept it.
            </p>

            <ul className="link-list">
              {[...proposals, ...accepted].map((l) => (
                <li key={l.id} className={`link-row link-${l.status}`}>
                  <div className="link-body">
                    <span className="link-relation">
                      {RELATION_COPY[l.relation] || 'Related to'}{' '}
                      <Link className="auth-link" to={`/dashboard/memories/${l.relatedMemory.id}`}>
                        {l.relatedMemory.title}
                      </Link>
                    </span>
                    {l.relatedMemory.preview && (
                      <span className="link-preview">{l.relatedMemory.preview}</span>
                    )}
                  </div>
                  {l.status === 'proposed' ? (
                    <span className="link-actions">
                      <button
                        type="button"
                        className="btn-cta btn-pill"
                        onClick={() => resolveLink(l.id, 'approved')}
                        disabled={linkBusy === l.id}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-pill"
                        onClick={() => resolveLink(l.id, 'rejected')}
                        disabled={linkBusy === l.id}
                      >
                        Dismiss
                      </button>
                    </span>
                  ) : (
                    <span className="memory-status memory-status-ready">Accepted</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

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
          ) : memory.type === 'voice' && fileError ? (
            <div className="auth-banner error" role="alert">Could not load the audio file: {fileError}</div>
          ) : null}

          {!editableText ? (
            <div className="memory-detail-file-block">
              {memory.type === 'document' && fileUrl ? (
                <a className="memory-detail-file" href={fileUrl} target="_blank" rel="noreferrer">
                  Open document{mimeLabel(memory.mime_type) ? ` (${mimeLabel(memory.mime_type)})` : ''}
                </a>
              ) : memory.type === 'document' && fileError ? (
                <div className="auth-banner error" role="alert">Could not load the document: {fileError}</div>
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