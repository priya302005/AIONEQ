import CitationChip from './CitationChip.jsx'

function MessageBubble({ message, isLast, onOpenMemory, onPickFollowUp }) {
  const isUser = message.role === 'user'

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