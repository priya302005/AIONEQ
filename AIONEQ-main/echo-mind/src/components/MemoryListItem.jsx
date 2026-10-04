import { getMemoryType } from '../memoryTypes.jsx'
import { formatDuration, formatFullDate, formatMemoryDate, formatRelativeTime } from '../formatRelativeTime.js'
import MemoryCardMenu from './MemoryCardMenu.jsx'

const TYPE_LABELS = { voice: 'Voice', journal: 'Journal', email: 'Email', document: 'Document', story: 'Story' }

/**
 * Processing status -> short label. `ready` is the quiet default and gets no
 * chip, so the list only draws attention to memories that need it. Rows whose
 * status is missing entirely (migration not applied yet) also render nothing.
 */
const STATUS_LABELS = {
  pending: 'Analysing',
  processing: 'Analysing',
  partial: 'Partial',
  failed: 'Needs attention',
}

function statusChip(memory) {
  const status = memory?.processing_status
  const label = STATUS_LABELS[status]
  if (!label) return null
  return (
    <span className={`memory-status memory-status-${status}`} title={STATUS_TITLES[status] || label}>
      {label}
    </span>
  )
}

const STATUS_TITLES = {
  pending: 'EchoMind is still reading this memory.',
  processing: 'EchoMind is still reading this memory.',
  partial: 'Saved, but part of the analysis could not finish.',
  failed: 'The analysis did not complete. Open it to retry.',
}

function filePreview(memory) {
  if (memory.type === 'voice') {
    const duration = formatDuration(memory.duration)
    return `Voice recording${duration ? ` · ${duration}` : ''}`
  }
  if (memory.type === 'document') {
    const mime = (memory.mime_type || '').split('/').pop()
    return `Document${mime ? ` · ${mime.toUpperCase()}` : ''}`
  }
  return ''
}

function MemoryListItem({ memory, onOpen, onEdit, onDelete }) {
  const config = getMemoryType(memory.type)
  const Icon = config?.Icon
  const text = memory.content?.trim()
  // The user's own words are always preferred. An AI summary is only used as a
  // fallback for file-only memories, and is never shown instead of real text.
  const fallback = memory.ai_summary?.trim() || filePreview(memory)
  const preview = text
    ? (text.length > 140 ? text.slice(0, 140) + '…' : text)
    : (fallback.length > 140 ? fallback.slice(0, 140) + '…' : fallback)
  const added = memory.created_at
  const addedLabel = added ? formatRelativeTime(added) : ''
  const fullDate = added ? formatFullDate(added) : ''
  const topics = Array.isArray(memory.topics) ? memory.topics.slice(0, 3) : []
  const status = statusChip(memory)

  return (
    <div className="memory-item" onClick={() => onOpen(memory)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(memory) }}>
      <span className="memory-item-icon">{Icon ? <Icon /> : null}</span>
      <div className="memory-item-main">
        <span className="memory-item-title">{memory.title}</span>
        {preview && <span className="memory-item-preview">{preview}</span>}
        {topics.length > 0 && (
          <span className="memory-item-topics">
            {topics.map((t) => <span key={t} className="topic-chip">{t}</span>)}
          </span>
        )}
      </div>
      <div className="memory-item-meta">
        <span className="memory-badge">{TYPE_LABELS[memory.type] || memory.type}</span>
        {status}
        <span className="memory-date" title={fullDate}>
          {addedLabel ? `Added ${addedLabel}` : formatMemoryDate(memory.event_date || added)}
        </span>
      </div>
      <MemoryCardMenu onEdit={() => onEdit(memory)} onDelete={() => onDelete(memory)} />
    </div>
  )
}

export default MemoryListItem