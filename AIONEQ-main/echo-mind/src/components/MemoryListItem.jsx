import { getMemoryType } from '../memoryTypes.jsx'
import { formatDuration, formatFullDate, formatMemoryDate, formatRelativeTime } from '../formatRelativeTime.js'
import MemoryCardMenu from './MemoryCardMenu.jsx'

const TYPE_LABELS = { voice: 'Voice', journal: 'Journal', email: 'Email', document: 'Document', story: 'Story' }

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
  const preview = text
    ? (text.length > 140 ? text.slice(0, 140) + '…' : text)
    : filePreview(memory)
  const added = memory.created_at
  const addedLabel = added ? formatRelativeTime(added) : ''
  const fullDate = added ? formatFullDate(added) : ''

  return (
    <div className="memory-item" onClick={() => onOpen(memory)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(memory) }}>
      <span className="memory-item-icon">{Icon ? <Icon /> : null}</span>
      <div className="memory-item-main">
        <span className="memory-item-title">{memory.title}</span>
        {preview && <span className="memory-item-preview">{preview}</span>}
      </div>
      <div className="memory-item-meta">
        <span className="memory-badge">{TYPE_LABELS[memory.type] || memory.type}</span>
        <span className="memory-date" title={fullDate}>
          {addedLabel ? `Added ${addedLabel}` : formatMemoryDate(memory.event_date || added)}
        </span>
      </div>
      <MemoryCardMenu onEdit={() => onEdit(memory)} onDelete={() => onDelete(memory)} />
    </div>
  )
}

export default MemoryListItem