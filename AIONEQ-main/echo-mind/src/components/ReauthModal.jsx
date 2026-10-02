import { useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../auth'

/**
 * Re-authentication for sensitive actions (export, account deletion, granting
 * legacy access). The user must re-enter their password; the request is only
 * released to the action callback after the password verifies against
 * Supabase.
 */
export function useReauth() {
  const { user } = useAuth()
  const [required, setRequired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pendingRef = { current: null }

  function requireReauth(action) {
    pendingRef.current = action
    setError('')
    setRequired(true)
  }

  async function confirm(password) {
    if (!user?.email) {
      setError('Unable to re-authenticate: session has no email.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password,
      })
      if (signInError) {
        setError('Password is incorrect.')
        return
      }
      const action = pendingRef.current
      pendingRef.current = null
      setRequired(false)
      await action()
    } catch (err) {
      setError(err.message || 'Re-authentication failed.')
    } finally {
      setBusy(false)
    }
  }

  function cancel() {
    pendingRef.current = null
    setRequired(false)
    setError('')
  }

  return { reauthRequired: required, requireReauth, confirmReauth: confirm, cancelReauth: cancel, reauthBusy: busy, reauthError: error }
}

function ReauthModal({ onConfirm, onCancel, busy, error, show }) {
  const [pw, setPw] = useState('')
  if (!show) return null
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Confirm your password">
        <h3 className="modal-title">Confirm your password</h3>
        <p className="modal-sub">This is a sensitive action. Enter your password to continue.</p>
        {error && <p className="auth-banner error" role="alert">{error}</p>}
        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) onConfirm(pw) }}
            disabled={busy}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn-ghost btn-pill" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn-cta btn-pill" onClick={() => onConfirm(pw)} disabled={busy || !pw}>
            {busy ? 'Verifying…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ReauthModal