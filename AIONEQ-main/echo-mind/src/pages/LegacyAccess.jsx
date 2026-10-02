import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useToast } from '../toast'
import { useReauth } from '../components/ReauthModal'
import ReauthModal from '../components/ReauthModal'
import TypedConfirmModal from '../components/TypedConfirmModal'
import Logo from '../Logo.jsx'

/**
 * Legacy access management.
 *  - Owner: create/revoke grants to designated recipients (visible, one-click
 *    revoke - not buried in settings).
 *  - Recipient: claim pending grants issued to this account's email, and view
 *    archives they are allowed to read.
 */
function LegacyAccess() {
  const { notify } = useToast()
  const reauth = useReauth()

  const [grants, setGrants] = useState([])
  const [pending, setPending] = useState([])
  const [archives, setArchives] = useState([])
  const [loading, setLoading] = useState(true)

  // Create form
  const [email, setEmail] = useState('')
  const [accessCode, setAccessCode] = useState('')
  const [grantType, setGrantType] = useState('full')
  const [claimToken, setClaimToken] = useState(null)
  const [formError, setFormError] = useState('')
  const [creating, setCreating] = useState(false)

  // Claim form
  const [claimDetails, setClaimDetails] = useState(null) // pending grant being claimed
  const [claimTokenInput, setClaimTokenInput] = useState('')
  const [claimCodeInput, setClaimCodeInput] = useState('')
  const [claimError, setClaimError] = useState('')
  const [claiming, setClaiming] = useState(false)

  // Expanded archive view
  const [openArchive, setOpenArchive] = useState(null)
  const [archiveMemories, setArchiveMemories] = useState([])
  const [archiveLoading, setArchiveLoading] = useState(false)

  // Revoke confirmation
  const [revokeTarget, setRevokeTarget] = useState(null)
  const [revoking, setRevoking] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [grantsRes, pendingRes, accessRes] = await Promise.all([
        api('/api/legacy/grants'),
        api('/api/legacy/pending'),
        api('/api/legacy/access'),
      ])
      setGrants(grantsRes.data || [])
      setPending(pendingRes.data || [])
      setArchives(accessRes.data || [])
    } catch (err) {
      notify(err.message)
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => { refresh() }, [refresh])

  async function createGrant() {
    setCreating(true)
    setFormError('')
    try {
      const res = await api('/api/legacy/grants', {
        method: 'POST',
        body: JSON.stringify({
          recipientEmail: email,
          accessCode: accessCode.trim() || undefined,
          grantType,
        }),
      })
      // claim token is shown exactly once - it is not recoverable afterwards.
      setClaimToken({ token: res.claimToken, email: res.data.recipientEmail })
      setEmail('')
      setAccessCode('')
      notify(`Grant created for ${res.data.recipientEmail}. Share the claim token with them.`)
      await refresh()
    } catch (err) {
      setFormError(err.message)
    } finally {
      setCreating(false)
    }
  }

  function submitCreate(e) {
    // Sensitive action: re-authenticate before issuing a legacy grant.
    e.preventDefault()
    setClaimToken(null)
    setFormError('')
    if (!email.trim()) {
      setFormError('Recipient email is required.')
      return
    }
    reauth.requireReauth(createGrant)
  }

  function copyClaimToken() {
    if (!claimToken?.token) return
    navigator.clipboard?.writeText(claimToken.token)
    notify('Claim token copied. Share it only with the recipient.')
  }

  async function claimGrant(e) {
    e.preventDefault()
    if (!claimDetails) return
    setClaiming(true)
    setClaimError('')
    try {
      await api(`/api/legacy/grants/${claimDetails.id}/claim`, {
        method: 'POST',
        body: JSON.stringify({
          claimToken: claimTokenInput.trim(),
          accessCode: claimCodeInput.trim() || undefined,
        }),
      })
      notify('Legacy access activated. The owner’s archive is now readable by you.')
      setClaimDetails(null)
      setClaimTokenInput('')
      setClaimCodeInput('')
      await refresh()
    } catch (err) {
      setClaimError(err.message)
    } finally {
      setClaiming(false)
    }
  }

  async function loadArchive(ownerId) {
    setOpenArchive(ownerId)
    setArchiveLoading(true)
    try {
      const res = await api(`/api/legacy/archive/${ownerId}`)
      setArchiveMemories(res.data || [])
    } catch (err) {
      notify(err.message)
      setArchiveMemories([])
    } finally {
      setArchiveLoading(false)
    }
  }

  async function confirmRevoke() {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      await api(`/api/legacy/grants/${revokeTarget.id}`, { method: 'DELETE' })
      notify(`Access revoked for ${revokeTarget.recipientEmail}.`)
      setRevokeTarget(null)
      await refresh()
    } catch (err) {
      notify(err.message)
    } finally {
      setRevoking(false)
    }
  }

  const STATUS_LABEL = { pending: 'Awaiting claim', active: 'Active', revoked: 'Revoked' }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <Logo size={44} wordmark={false} />
          <span className="auth-eyebrow">Digital legacy</span>
          <h2>Legacy access</h2>
          <p>Who can read your archive, what they see, and how to revoke it.</p>
        </div>

        {/* ---------------- Create grant ---------------- */}
        <section className="sec-settings-card" aria-label="Give legacy access">
          <h4 className="md-section-title">Grant read-only access</h4>
          <form className="auth-form" onSubmit={submitCreate}>
            <label className="auth-field">
              <span>Recipient email</span>
              <input
                type="email"
                placeholder="family@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label className="auth-field">
              <span>Shared access code <em className="auth-hint">(recommended)</em></span>
              <input
                type="text"
                placeholder="A word only you and they know"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
              />
            </label>
            <div className="auth-field">
              <span>What they may see</span>
              <div className="seg-toggle" role="tablist">
                <button type="button" role="tab" aria-selected={grantType === 'full'} className={`seg-btn ${grantType === 'full' ? 'active' : ''}`} onClick={() => setGrantType('full')}>
                  Full archive
                </button>
                <button type="button" role="tab" aria-selected={grantType === 'text'} className={`seg-btn ${grantType === 'text' ? 'active' : ''}`} onClick={() => setGrantType('text')}>
                  Text only
                </button>
              </div>
            </div>
            {formError && <p className="auth-error" role="alert">{formError}</p>}
            <button type="submit" className="btn-cta btn-pill" disabled={creating || !email.trim()}>
              {creating ? 'Creating…' : 'Generate claim token'}
            </button>
          </form>

          {claimToken && (
            <div className="claim-token-box" role="status">
              <p className="modal-sub">
                Share this one-time claim token with <strong>{claimToken.email || 'the recipient'}</strong>. They redeem it from their own account. Anyone with this token can activate the grant, so share it privately.
              </p>
              <div className="claim-token-row">
                <code className="mfa-secret">{claimToken.token}</code>
                <button type="button" className="btn-ghost btn-pill" onClick={copyClaimToken}>Copy</button>
              </div>
            </div>
          )}
        </section>

        {/* ---------------- Owner's grants ---------------- */}
        <section className="sec-settings-card" aria-label="Your grants">
          <h4 className="md-section-title">Recipients you have granted</h4>
          {loading ? (
            <p className="md-muted">Loading…</p>
          ) : grants.length === 0 ? (
            <p className="md-muted">No grants yet. Create one above.</p>
          ) : (
            <ul className="legacy-list">
              {grants.map((g) => (
                <li key={g.id} className="legacy-row">
                  <span>
                    <strong>{g.recipientEmail}</strong>
                    <span className="legacy-sub">
                      {STATUS_LABEL[g.status] || g.status} · {g.grantType === 'full' ? 'Full archive' : 'Text only'}
                      {g.activatedAt ? ` · active since ${new Date(g.activatedAt).toLocaleDateString()}` : ''}
                    </span>
                  </span>
                  {g.status !== 'revoked' && (
                    <button
                      type="button"
                      className="btn-ghost btn-pill"
                      onClick={() => setRevokeTarget(g)}
                      disabled={revoking}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---------------- Pending claims for me ---------------- */}
        {pending.length > 0 && (
          <section className="sec-settings-card" aria-label="Grants for you">
            <h4 className="md-section-title">Grants awaiting your claim</h4>
            <ul className="legacy-list">
              {pending.map((g) => (
                <li key={g.id} className="legacy-row">
                  <span>
                    <strong>You have been granted access</strong>
                    <span className="legacy-sub">
                      {g.grantType === 'full' ? 'Full archive' : 'Text only'} · created {new Date(g.createdAt).toLocaleDateString()}
                    </span>
                  </span>
                  <button type="button" className="btn-cta btn-pill" onClick={() => setClaimDetails(g)}>
                    Claim
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ---------------- Archives I can read ---------------- */}
        <section className="sec-settings-card" aria-label="Archives you can read">
          <h4 className="md-section-title">Archives you can read</h4>
          {archives.length === 0 ? (
            <p className="md-muted">You have no active legacy access yet.</p>
          ) : (
            <ul className="legacy-list">
              {archives.map((a) => (
                <li key={a.grantId} className="legacy-row">
                  <span>
                    <strong>Archives ({a.memoryCount} memories)</strong>
                    <span className="legacy-sub">
                      {a.grantType === 'full' ? 'Full archive' : 'Text only'} · since {new Date(a.activatedAt).toLocaleDateString()}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn-ghost btn-pill"
                    onClick={() => loadArchive(a.ownerId)}
                    disabled={archiveLoading}
                  >
                    {openArchive === a.ownerId ? (archiveLoading ? 'Loading…' : 'Viewing') : 'View'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {openArchive && Array.isArray(archiveMemories) && (
            <div className="archive-view">
              <p className="md-section-title">Memories</p>
              <ul className="legacy-list">
                {archiveMemories.map((m) => (
                  <li key={m.id} className="legacy-row">
                    <Link to={`/dashboard/memories/${m.id}`} className="archive-memory-link">
                      <span className="memory-badge">{m.type}</span> {m.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <p className="auth-switch">
          <Link to="/security" className="auth-link">← Security settings</Link> ·{' '}
          <Link to="/dashboard" className="auth-link">Dashboard</Link>
        </p>
      </div>

      {/* ---------------- Re-auth modal ---------------- */}
      <ReauthModal
        show={reauth.reauthRequired}
        onConfirm={reauth.confirmReauth}
        onCancel={reauth.cancelReauth}
        busy={reauth.reauthBusy}
        error={reauth.reauthError}
      />

      {/* ---------------- Claim modal ---------------- */}
      {claimDetails && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card" role="dialog" aria-modal="true" aria-label="Claim legacy access">
            <h3 className="modal-title">Claim your legacy access</h3>
            <p className="modal-sub">Enter the claim token (and access code if one was set) given to you by the owner.</p>
            {claimError && <p className="auth-error" role="alert">{claimError}</p>}
            <form className="auth-form" onSubmit={claimGrant}>
              <label className="auth-field">
                <span>Claim token</span>
                <input
                  type="text"
                  value={claimTokenInput}
                  onChange={(e) => setClaimTokenInput(e.target.value)}
                  required
                />
              </label>
              <label className="auth-field">
                <span>Access code <em className="auth-hint">(if the owner set one)</em></span>
                <input
                  type="text"
                  value={claimCodeInput}
                  onChange={(e) => setClaimCodeInput(e.target.value)}
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="btn-ghost btn-pill" onClick={() => setClaimDetails(null)} disabled={claiming}>Cancel</button>
                <button type="submit" className="btn-cta btn-pill" disabled={claiming || !claimTokenInput.trim()}>
                  {claiming ? 'Claiming…' : 'Activate access'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ---------------- Revoke confirm ---------------- */}
      {revokeTarget && (
        <TypedConfirmModal
          title="Revoke legacy access?"
          description={`${revokeTarget.recipientEmail} will immediately lose the ability to read this archive. Revocation cannot be undone without creating a new grant.`}
          confirmPhrase="REVOKE"
          busy={revoking}
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => { setRevokeTarget(null); confirmRevoke() }}
        />
      )}
    </main>
  )
}

export default LegacyAccess