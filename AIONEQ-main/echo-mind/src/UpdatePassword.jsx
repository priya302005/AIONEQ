import { useState } from 'react'
import Logo from './Logo.jsx'
import { supabase } from './supabaseClient'
import { api } from './api'

function UpdatePassword({ onSwitch, notify }) {
  const [showPw, setShowPw] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) {
        throw new Error('No active session. Please request a new reset link.')
      }
      await api('/api/auth/update-password', {
        token,
        method: 'PUT',
        body: JSON.stringify({ password }),
      })
      notify('Password updated successfully. Please log in.')
      onSwitch('login')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <Logo size={44} wordmark={false} />
          <span className="auth-eyebrow">Set new password</span>
          <h2>Choose a new password</h2>
          <p>Make it strong — at least 6 characters.</p>
        </div>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>New password</span>
            <div className="pw-row">
              <input
                type={showPw ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="new-password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="pw-toggle"
                onClick={() => setShowPw((s) => !s)}
              >
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" className="btn-cta auth-submit" disabled={loading}>
            {loading ? 'Updating…' : 'Update Password'}
          </button>
        </form>
        <p className="auth-switch">
          <button
            type="button"
            className="auth-link"
            onClick={() => onSwitch('login')}
          >
            Back to Login
          </button>
        </p>
      </div>
    </main>
  )
}

export default UpdatePassword