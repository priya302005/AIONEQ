import { useEffect, useRef } from 'react'

function ChatInput({ onSend, sending, disabled }) {
  const textRef = useRef(null)

  useEffect(() => {
    if (!sending && textRef.current) textRef.current.focus()
  }, [sending, disabled])

  const autoGrow = () => {
    const el = textRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }

  const submit = () => {
    if (!textRef.current) return
    const value = textRef.current.value.trim()
    if (!value || sending || disabled) return
    textRef.current.value = ''
    textRef.current.style.height = 'auto'
    onSend(value)
  }

  return (
    <div className={`chat-input${disabled ? ' chat-input-disabled' : ''}`}>
      <textarea
        ref={textRef}
        className="chat-textarea"
        rows={1}
        placeholder="Ask your archive something…"
        disabled={sending || disabled}
        onInput={autoGrow}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <button
        type="button"
        className="chat-send"
        aria-label="Send question"
        disabled={sending || disabled}
        onClick={submit}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19V5" />
          <path d="m5 12 7-7 7 7" />
        </svg>
      </button>
    </div>
  )
}

export default ChatInput