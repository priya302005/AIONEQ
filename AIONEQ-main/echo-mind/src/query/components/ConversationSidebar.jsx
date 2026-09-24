import { useEffect, useRef, useState } from 'react'
import ConfirmDeleteModal from '../../components/ConfirmDeleteModal.jsx'
import { groupConversations } from '../groupConversations.js'
import ConversationRow from './ConversationRow.jsx'

function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}) {
  const [search, setSearch] = useState('')
  const [menuOpenId, setMenuOpenId] = useState(null)
  const [renamingId, setRenamingId] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!menuOpenId) return undefined
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setMenuOpenId(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpenId])

  const query = search.trim().toLowerCase()
  const filtered = query
    ? (conversations || []).filter((c) => (c.title || '').toLowerCase().includes(query))
    : conversations || []
  const groups = groupConversations(filtered)

  const closeMenu = () => setMenuOpenId(null)

  const startRename = (conversation) => {
    setRenamingId(conversation.id)
    closeMenu()
  }

  const saveRename = async (conversation, title) => {
    const previous = conversation.title
    setRenamingId(null)
    try {
      await onRename(conversation.id, title, previous)
    } catch {
      setRenamingId(null)
    }
  }

  const requestDelete = (conversation) => {
    setDeleteTarget(conversation)
    closeMenu()
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await onDelete(deleteTarget)
    } finally {
      setBusy(false)
      setDeleteTarget(null)
    }
  }

  return (
    <aside className="convo-sidebar" ref={rootRef}>
      <button type="button" className="convo-new" onClick={onNew}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        New conversation
      </button>

      <input
        type="search"
        className="convo-search"
        placeholder="Search conversations"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="convo-list">
        {groups.length === 0 && (
          <p className="convo-empty">
            {query ? 'No conversations match your search.' : 'Your conversations will appear here.'}
          </p>
        )}
        {groups.map((group) => (
          <div key={group.label} className="convo-group">
            <p className="convo-group-label">{group.label}</p>
            {group.items.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                active={c.id === activeId}
                renaming={renamingId === c.id}
                menuOpen={menuOpenId === c.id}
                onSelect={onSelect}
                onToggleMenu={(id) => setMenuOpenId((prev) => (prev === id ? null : id))}
                onRenameStart={startRename}
                onRenameSave={saveRename}
                onRenameCancel={() => setRenamingId(null)}
                onDeleteRequest={requestDelete}
              />
            ))}
          </div>
        ))}
      </div>

      {deleteTarget && (
        <ConfirmDeleteModal
          title={deleteTarget.title}
          heading="Delete this conversation?"
          busy={busy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}
    </aside>
  )
}

export default ConversationSidebar