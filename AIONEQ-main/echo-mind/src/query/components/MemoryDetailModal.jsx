import { getMemoryType } from '../../memoryTypes.jsx'
import { absoluteFileUrl } from '../../backendUrl.js'

const TYPE_LABELS = { voice: 'Voice', journal: 'Journal', email: 'Email', document: 'Document', story: 'Story' }

function formatDate(value) {
  const d = value ? new Date(value) : null
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : ''
}

function MemoryDetailModal({ memory, onClose }) {
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

        {memory.file_url && (
          <a
            className="memory-detail-file"
            href={absoluteFileUrl(memory.file_url)}
            target="_blank"
            rel="noreferrer"
          >
            Open attached file
          </a>
        )}
      </div>
    </div>
  )
}

export default MemoryDetailModal