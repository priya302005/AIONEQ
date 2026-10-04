import { useState } from 'react'
import CitationChip from './CitationChip.jsx'

const TYPE_LABELS = { voice: 'Voice', journal: 'Journal', email: 'Email', document: 'Document', story: 'Story' }

function MessageBubble({ message, isLast, onOpenMemory, onPickFollowUp }) {
  const isUser = message.role === 'user'
  // Collapsed by default so the transcript stays readable; the user opens it
  // when they want to check what an answer was based on.
  // Declared before any early return so the hook count never changes.
  const [showSources, setShowSources] = useState(false)

  if (isUser) {
    return (
      <div className="msg-row user">
        <div className="msg-bubble user">
          <p className="msg-text">{message.content}</p>
          <span className="msg-time">{message.createdAt ? new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</span>
        </div>
      </div>
    )
  }

  const citations = message.citedMemories || []
  const noSource = citations.length === 0
  const suggestions = message.suggestions || []
  const used = message.usedMemories || []

  return (
    <div className="msg-row ai">
      <div className="msg-avatar">◆</div>
      <div className="msg-stack">
        <div className={`msg-bubble ai${noSource ? ' no-source' : ''}`}>
          <p className="msg-text">{message.content}</p>
          {message.createdAt ? (
            <span className="msg-time">{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          ) : null}
          {citations.length > 0 && (
            <div className="msg-citations">
              {citations.map((c) => (
                <CitationChip key={c.memoryId} citation={c} onOpen={onOpenMemory} />
              ))}
            </div>
          )}
        </div>

        {used.length > 0 && (
          <div className="msg-sources">
            <button
              type="button"
              className="msg-sources-toggle"
              onClick={() => setShowSources((v) => !v)}
              aria-expanded={showSources}
            >
              {showSources ? '▾' : '▸'} Answered from {used.length} {used.length === 1 ? 'memory' : 'memories'}
            </button>
            {showSources && (
              <ul className="msg-sources-list">
                {used.map((m) => (
                  <li key={m.memoryId}>
                    <button type="button" onClick={() => onOpenMemory(m.memoryId)}>
                      <span className="msg-source-title">{m.title}</span>
                      <span className="msg-source-type">{TYPE_LABELS[m.type] || m.type}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {isLast && suggestions.length > 0 && (
          <div className="follow-ups">
            <span className="follow-ups-label">Suggested follow-ups</span>
            <div className="follow-ups-list">
              {suggestions.map((s, i) => (
                <button
                  key={`${s}-${i}`}
                  type="button"
                  className="follow-up-chip"
                  onClick={() => onPickFollowUp(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default MessageBubble