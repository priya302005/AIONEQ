import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useToast } from '../toast'
import { useAuth } from '../auth'
import Logo from '../Logo.jsx'

/**
 * Profile management: the small set of facts about the signed-in person that
 * EchoMind can actually change.
 *
 * Scope is deliberately narrow. The display name is editable because it is
 * cosmetic metadata we own. The email is shown read-only, because changing it
 * is an identity operation that needs confirmation at the new address - offering
 * a text box that silently fails to take effect would be worse than not offering
 * one. Everything about the account that is not cosmetic (password, MFA, export,
 * deletion) lives under Security.
 */
function Profile() {
  const { notify } = useToast()
  const { user, refreshUser } = useAuth()

  const [fullName, setFullName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const displayName = (user?.user_metadata?.full_name || '').trim()
  const email = user?.email || ''
  const initials = (displayName || email || '?')
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('')

  const dirty = fullName.trim() !== displayName

  // Seed the field from the signed-in user without an effect: adjusting state
  // during render is React's supported way to follow a changed input, and it
  // avoids a wasted paint before the field shows the right value. An edit in
  // flight is not clobbered, because the seed only moves when the server-side
  // name actually changes.
  const [seededFrom, setSeededFrom] = useState(displayName)
  if (seededFrom !== displayName) {
    setSeededFrom(displayName)
    setFullName(displayName)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!dirty || saving) return
    setSaving(true)
    setError('')
    try {
      await api('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ fullName: fullName.trim() }) })
      // Pull the new metadata back so the navbar chip updates without a reload.
      await refreshUser()
      notify('Profile updated.')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <Logo size={44} wordmark={false} />
          <span className="auth-eyebrow">Your profile</span>
          <h2>{displayName || 'Your account'}</h2>
          <p>The name EchoMind shows you. Your archive belongs to you either way.</p>
        </div>

        <section className="sec-settings-card" aria-label="Profile summary">
          <div className="profile-id">
            <span className="profile-avatar" aria-hidden="true">{initials || '?'}</span>
            <div className="profile-id-text">
              <strong>{displayName || 'No name set'}</strong>
              <span className="legacy-sub">{email}</span>
              {user?.created_at && (
                <span className="legacy-sub">
                  Member since {new Date(user.created_at).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
        </section>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>Display name</span>
            <input
              type="text"
              placeholder="Jane Doe"
              autoComplete="name"
              maxLength={80}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              disabled={saving}
            />
          </label>

          <label className="auth-field">
            <span>Email</span>
            <input type="email" value={email} readOnly disabled />
            <span className="legacy-sub">
              Your sign-in address. To change it, use Security &rarr; change password flow or contact support, so the
              new address can be confirmed.
            </span>
          </label>

          {error && <p className="auth-error" role="alert">{error}</p>}

          <div className="form-actions">
            <button type="submit" className="btn-cta btn-pill" disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {dirty && !saving && (
              <button type="button" className="btn-ghost btn-pill" onClick={() => setFullName(displayName)}>
                Reset
              </button>
            )}
            <Link to="/security" className="auth-link">
              Security &amp; privacy →
            </Link>
          </div>
        </form>

        <p className="auth-switch">
          <Link to="/dashboard" className="auth-link">← Back to Dashboard</Link>
        </p>
      </div>
    </main>
  )
}

export default Profile