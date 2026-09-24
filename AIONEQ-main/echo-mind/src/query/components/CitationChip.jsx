import { memoryDateLabel, memoryTypeMeta } from '../helpers'

function CitationChip({ citation, onOpen }) {
  const { Icon, title } = memoryTypeMeta(citation.type)
  return (
    <button type="button" className="citation-chip" onClick={() => onOpen(citation.memoryId)} title={`Open ${title}`}>
      <span className="citation-icon">{Icon ? <Icon /> : null}</span>
      <span className="citation-text">{title}</span>
      {citation.eventDate && <span className="citation-date">{memoryDateLabel(citation.eventDate)}</span>}
    </button>
  )
}

export default CitationChip