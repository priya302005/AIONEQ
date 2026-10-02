import { useState } from 'react'

/**
 * Destruction confirmation that requires typing a phrase (e.g. "DELETE" or
 * the account email). A click alone is not enough for irreversible actions in
 * a digital legacy vault.
 */
function TypedConfirmModal({ title, description, confirmPhrase, busy = false, onCancel, onConfirm, danger = true }) {
  const [text, setText] = useState('')
  const matches = text.trim() === confirmPhrase
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <h3 className="modal-title">{title}</h3>
        <p className="modal-sub">{description}</p>
        <label className="auth-field">
          <span>Type <strong>{confirmPhrase}</strong> to confirm</span>
          <input
            type="text"
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && matches && !busy) onConfirm() }}
            disabled={busy}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn-ghost btn-pill" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            type="button"
            className={`btn-pill ${danger ? 'btn-danger' : 'btn-cta'}`}
            onClick={onConfirm}
            disabled={busy || !matches}
          >
            {busy ? 'Working…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default TypedConfirmModal