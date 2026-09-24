import { useState } from 'react'

function EditableField({ value, onSave, children, placeholder, inputClassName }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const open = () => {
    setDraft(value)
    setEditing(true)
  }

  const commit = () => {
    const next = draft.trim()
    if (editing && next && next !== value) onSave(next)
    setEditing(false)
  }

  const cancel = () => setEditing(false)

  if (editing) {
    return (
      <input
        autoFocus
        className={`editable-input ${inputClassName || ''}`}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') cancel()
        }}
      />
    )
  }

  return (
    <div className="editable-field">
      <div className="editable-display">{children}</div>
      <button type="button" className="editable-pencil" aria-label="Edit" onClick={open}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      </button>
    </div>
  )
}

export default EditableField