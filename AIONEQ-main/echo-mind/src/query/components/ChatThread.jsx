import { useEffect, useRef } from 'react'
import MessageBubble from './MessageBubble.jsx'

function TypingIndicator() {
  return (
    <div className="msg-row ai">
      <div className="msg-avatar">◆</div>
      <div className="msg-stack">
        <div className="msg-bubble ai typing">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </div>
      </div>
    </div>
  )
}

function ChatThread({ messages, sending, onOpenMemory, onPickFollowUp }) {
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, sending])

  return (
    <div className="chat-thread">
      {messages.length === 0 && !sending ? (
        <div className="chat-hero">
          <p className="chat-squiggle">✦</p>
          <p className="section-tag">Ask Your Archive</p>
          <h1 className="chat-title">
            What do you want to <span className="gradient-text">remember?</span>
          </h1>
          <p className="chat-sub">Ask EchoMind about anything you've preserved — it answers only from your own memories.</p>
        </div>
      ) : (
        messages.map((m, i) => (
          <MessageBubble
            key={m.id}
            message={m}
            isLast={i === messages.length - 1}
            onOpenMemory={onOpenMemory}
            onPickFollowUp={onPickFollowUp}
          />
        ))
      )}
      {sending && <TypingIndicator />}
      <div ref={endRef} />
    </div>
  )
}

export default ChatThread