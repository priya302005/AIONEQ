import { useEffect } from 'react'
import { getMemoryType } from '../../memoryTypes.jsx'
import { useSignedFileUrl } from '../../hooks/useSignedFileUrl.js'

const TYPE_LABELS = { voice: 'Voice', journal: 'Journal', email: 'Email', document: 'Document', story: 'Story' }

function formatDate(value) {
  const d = value ? new Date(value) : null
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : ''
}

function MemoryDetailModal({ memory, onClose }) {
  // Hooks must be called unconditionally - useSignedFileUrl handles null memory.
  const { url: fileUrl, error: fileError } = useSignedFileUrl(memory)

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!memory) return null

  const config = getMemoryType(memory.type)
  const Icon = config?.Icon
  const body = memory.transcript || memory.content

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>

        <div className="memory-detail-head">
          <span className="memory-item-icon">{Icon ? <Icon /> : null}</span>
          <div>
            <h3 className="memory-detail-title">{memory.title}</h3>
            <span className="memory-badge">{TYPE_LABELS[memory.type] || memory.type}</span>
            {formatDate(memory.event_date || memory.created_at) && (
              <span className="memory-date">{formatDate(memory.event_date || memory.created_at)}</span>
            )}
          </div>
        </div>

        {body && <div className="memory-detail-content">{body}</div>}

        {memory.file_url && fileUrl ? (
          <a
            className="memory-detail-file"
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open attached file
          </a>
        ) : memory.file_url && fileError ? (
          <p className="modal-sub" role="alert">Unable to load file: {fileError}</p>
        ) : null}
      </div>
    </div>
  )
}

export default MemoryDetailModal