function Toast({ toast }) {
  return (
    <div className={"toast toast-" + toast.type} role="status">
      <span className="toast-icon" aria-hidden="true">
        {toast.type === 'success' ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
        )}
      </span>
      <span className="toast-message">{toast.message}</span>
    </div>
  )
}

function Toaster({ toasts }) {
  return (
    <div className="toaster">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} />
      ))}
    </div>
  )
}

export default Toaster