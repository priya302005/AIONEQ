import { useEffect, useRef } from 'react'

function RenameInput({ initial, onSave, onCancel }) {
  const ref = useRef(null)

  useEffect(() => {
    const input = ref.current
    input?.focus()
    input?.select()
  }, [])

  const commit = () => {
    const value = ref.current?.value ?? ''
    if (value.trim() && value.trim() !== initial) onSave(value.trim())
    else onCancel()
  }

  return (
    <input
      ref={ref}
      className="convo-rename-input"
      defaultValue={initial}
      maxLength={80}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  )
}

export default RenameInput