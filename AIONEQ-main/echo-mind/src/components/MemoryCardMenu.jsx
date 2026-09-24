import { useEffect, useRef, useState } from 'react'

function MemoryCardMenu({ onEdit, onDelete }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <div className="card-menu" ref={ref}>
      <button
        type="button"
        className="card-menu-kebab"
        aria-label="Memory options"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="12" cy="19" r="1.7" />
        </svg>
      </button>

      {open && (
        <div className="card-menu-popover">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
              onEdit()
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="danger"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
              onDelete()
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

export default MemoryCardMenu