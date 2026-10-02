import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import API_URL from '../backendUrl.js'
import { supabase } from '../supabaseClient'
import { useReauth } from '../components/ReauthModal'
import ReauthModal from '../components/ReauthModal'
import TypedConfirmModal from '../components/TypedConfirmModal'
import { useToast } from '../toast'
import { useAuth } from '../auth'
import Logo from '../Logo.jsx'

/**
 * Security & privacy settings:
 *  - MFA (TOTP) enrollment status + manage
 *  - Full data export (re-auth required)
 *  - Hard account deletion (re-auth + typed confirmation)
 *  - Pointer to legacy-access management
 */
function SecuritySettings() {
  const { notify } = useToast()
  const { user } = useAuth()
  const reauth = useReauth()

  // MFA
  const [factors, setFactors] = useState([])
  const [mfaLoading, setMfaLoading] = useState(true)
  const [enrollStep, setEnrollStep] = useState(null) // { id, secret, uri }
  const [enrollCode, setEnrollCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [mfaError, setMfaError] = useState('')

  // Export
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  // Delete account
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const loadFactors = useCallback(async () => {
    setMfaLoading(true)
    try {
      const res = await api('/api/auth/mfa/factors')
      setFactors(res.data?.factors || [])
    } catch {
      setFactors([])
    } finally {
      setMfaLoading(false)
    }
  }, [])

  useEffect(() => { loadFactors() }, [loadFactors])

  async function startEnroll() {
    setBusy(true)
    setMfaError('')
    try {
      const res = await api('/api/auth/mfa/enroll', { method: 'POST' })
      const d = res.data
      setEnrollStep({ id: d.id, secret: d.totp?.secret, uri: d.totp?.uri })
    } catch (err) {
      setMfaError(err.message || 'MFA could not be started. Ensure MFA is enabled in your Supabase project (Auth → Multi-factor Auth).')
    } finally {
      setBusy(false)
    }
  }

  async function verifyEnroll() {
    if (!enrollStep || enrollCode.length !== 6) return
    setBusy(true)
    setMfaError('')
    try {
      await api('/api/auth/mfa/verify', {
        method: 'POST',
        body: JSON.stringify({ factorId: enrollStep.id, code: enrollCode }),
      })
      notify('Two-factor authentication is now active.')
      setEnrollStep(null)
      setEnrollCode('')
      await loadFactors()
    } catch (err) {
      setMfaError(err.message || 'The code was not accepted. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function unenroll(factorId) {
    setBusy(true)
    try {
      await api('/api/auth/mfa/unenroll', { method: 'POST', body: JSON.stringify({ factorId }) })
      notify('Two-factor authentication removed.')
      await loadFactors()
    } catch (err) {
      setMfaError(err.message || 'Could not remove the factor.')
    } finally {
      setBusy(false)
    }
  }

  const verifiedFactors = factors.filter((f) => f.status === 'verified')

  async function downloadExport() {
    setExporting(true)
    setExportError('')
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      const res = await fetch(`${API_URL}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ scope: 'all' }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message || 'Export failed.')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'echomind-export.zip'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      notify('Your archive export is downloading.')
    } catch (err) {
      setExportError(err.message)
    } finally {
      setExporting(false)
    }
  }

  async function handleDeleteAccount() {
    setDeleting(true)
    setDeleteError('')
    try {
      await api('/api/account', { method: 'DELETE' })
      await supabase.auth.signOut()
      notify('Account permanently deleted.')
      window.location.assign('/')
    } catch (err) {
      setDeleteError(err.message)
      setDeleting(false)
    }
  }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <Logo size={44} wordmark={false} />
          <span className="auth-eyebrow">Security & privacy</span>
          <h2>Protect your legacy</h2>
          <p>MFA, data portability, and permanent deletion.</p>
        </div>

        {/* ---------------- MFA ---------------- */}
        <section className="sec-settings-card" aria-label="Two-factor authentication">
          <h4 className="md-section-title">Two-factor authentication (MFA)</h4>
          {mfaLoading ? (
            <p className="md-muted">Loading…</p>
          ) : verifiedFactors.length > 0 ? (
            <div>
              <p className="modal-sub">Protection is on. {verifiedFactors.length} verified authenticator factor(s).</p>
              <ul className="legacy-list">
                {verifiedFactors.map((f) => (
                  <li key={f.id} className="legacy-row">
                    <span>
                      <strong>Authenticator app (TOTP)</strong>
                      <span className="legacy-sub">Added {new Date(f.created_at).toLocaleDateString()}</span>
                    </span>
                    <button type="button" className="btn-ghost btn-pill" onClick={() => unenroll(f.id)} disabled={busy}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              {mfaError && <p className="auth-error" role="alert">{mfaError}</p>}
            </div>
          ) : enrollStep ? (
            <div>
              <p className="modal-sub">
                Scan this with your authenticator app, or add it manually, then enter the 6-digit code to confirm.
              </p>
              <div className="mfa-enroll-box">
                <div className="auth-field">
                  <span>Manual entry secret</span>
                  <code className="mfa-secret">{enrollStep.secret}</code>
                </div>
                <div className="auth-field">
                  <span>otpauth URI (contains your secret)</span>
                  <textarea rows={3} readOnly value={enrollStep.uri} className="mfa-uri" onFocus={(e) => e.target.select()} />
                </div>
              </div>
              {mfaError && <p className="auth-error" role="alert">{mfaError}</p>}
              <div className="auth-row" style={{ alignItems: 'flex-end', gap: 8 }}>
                <div className="auth-field" style={{ flex: 1 }}>
                  <span>6-digit code</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="000000"
                    value={enrollCode}
                    onChange={(e) => setEnrollCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    disabled={busy}
                  />
                </div>
                <button type="button" className="btn-cta btn-pill" onClick={verifyEnroll} disabled={busy || enrollCode.length !== 6}>
                  Verify
                </button>
                <button type="button" className="btn-ghost btn-pill" onClick={() => setEnrollStep(null)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="modal-sub">
                Add an authenticator app as a second factor. Your Supabase project must have Multi-factor Auth enabled.
              </p>
              <button type="button" className="btn-cta btn-pill" onClick={startEnroll} disabled={busy}>
                {busy ? 'Starting…' : 'Add a recovery factor'}
              </button>
              {mfaError && <p className="auth-error" role="alert">{mfaError}</p>}
            </div>
          )}
        </section>

        {/* ---------------- Export ---------------- */}
        <section className="sec-settings-card" aria-label="Export your data">
          <h4 className="md-section-title">Export your archive</h4>
          <p className="modal-sub">
            Download every memory (including uploaded files) and conversation as a ZIP archive.
          </p>
          {exportError && <p className="auth-error" role="alert">{exportError}</p>}
          <button
            type="button"
            className="btn-cta btn-pill"
            disabled={exporting}
            onClick={() => reauth.requireReauth(downloadExport)}
          >
            {exporting ? 'Preparing…' : 'Export everything'}
          </button>
        </section>

        {/* ---------------- Legacy access ---------------- */}
        <section className="sec-settings-card" aria-label="Legacy access">
          <h4 className="md-section-title">Legacy access</h4>
          <p className="modal-sub">
            Designate people who may read your archive after you are gone, and revoke access at any time.
          </p>
          <Link className="btn-ghost btn-pill" to="/dashboard/legacy-access">Manage legacy recipients</Link>
        </section>

        {/* ---------------- Active sessions note ---------------- */}
        <section className="sec-settings-card" aria-label="Sessions">
          <h4 className="md-section-title">Sessions</h4>
          <p className="modal-sub">
            You are signed in as <strong>{user?.email || 'you'}</strong>. Changing your password signs you out everywhere.
          </p>
        </section>

        {/* ---------------- Delete account ---------------- */}
        <section className="sec-settings-card danger" aria-label="Delete account">
          <h4 className="md-section-title">Delete your account</h4>
          <p className="modal-sub">
            Permanently deletes every memory, file, conversation, and grant. This cannot be undone.
          </p>
          {deleteError && <p className="auth-error" role="alert">{deleteError}</p>}
          <button
            type="button"
            className="btn-danger-muted"
            disabled={deleting}
            onClick={() => reauth.requireReauth(() => setDeleteConfirmOpen(true))}
          >
            {deleting ? 'Deleting…' : 'Delete my account'}
          </button>
        </section>

        <p className="auth-switch">
          <Link to="/dashboard" className="auth-link">← Back to Dashboard</Link>
        </p>
      </div>

      <ReauthModal
        show={reauth.reauthRequired}
        onConfirm={reauth.confirmReauth}
        onCancel={reauth.cancelReauth}
        busy={reauth.reauthBusy}
        error={reauth.reauthError}
      />

      <DeleteDialog
        open={deleteConfirmOpen}
        busy={deleting}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => { setDeleteConfirmOpen(false); handleDeleteAccount() }}
      />
    </main>
  )
}

function DeleteDialog({ open, busy, onCancel, onConfirm }) {
  if (!open) return null
  return (
    <TypedConfirmModal
      title="Delete the entire archive?"
      description="All memories, uploaded files, conversations, and legacy grants will be permanently deleted. There is no restore."
      confirmPhrase="DELETE"
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}

export default SecuritySettings