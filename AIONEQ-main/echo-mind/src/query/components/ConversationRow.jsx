import { timeAgo } from '../helpers'
import RenameInput from './RenameInput.jsx'

function KebabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  )
}

function ConversationRow({
  conversation,
  active,
  renaming,
  menuOpen,
  onSelect,
  onToggleMenu,
  onRenameStart,
  onRenameSave,
  onRenameCancel,
  onDeleteRequest,
}) {
  return (
    <div
      className={`convo-item${active ? ' active' : ''}`}
      onClick={renaming ? undefined : () => onSelect(conversation.id)}
    >
      {renaming ? (
        <RenameInput
          initial={conversation.title}
          onSave={(title) => onRenameSave(conversation, title)}
          onCancel={onRenameCancel}
        />
      ) : (
        <>
          <div className="convo-row">
            <span className="convo-item-title" title={conversation.title}>
              {conversation.title}
            </span>
            {onRenameStart && (
              <button
                type="button"
                className="convo-kebab"
                aria-label="Conversation options"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleMenu(conversation.id)
                }}
              >
                <KebabIcon />
              </button>
            )}
          </div>
          <span className="convo-item-time">{timeAgo(conversation.updatedAt)}</span>
          {menuOpen && (
            <div className="convo-menu" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="convo-menu-item" onClick={() => onRenameStart(conversation)}>
                Rename
              </button>
              <button
                type="button"
                className="convo-menu-item danger"
                onClick={() => onDeleteRequest(conversation)}
              >
                Delete
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default ConversationRow