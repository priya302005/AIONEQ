function ConfirmDeleteModal({ title, onCancel, onConfirm, busy, heading = 'Delete this memory?', confirmLabel = 'Delete' }) {
  const what = title ? <strong>“{title}”</strong> : 'this item'
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card confirm-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="confirm-heading">{heading}</h3>
        <p className="confirm-text">
          This can&apos;t be undone. {what} will be permanently removed.
        </p>
        <div className="confirm-actions">
          <button type="button" className="btn-ghost btn-pill" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-danger btn-pill" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDeleteModal