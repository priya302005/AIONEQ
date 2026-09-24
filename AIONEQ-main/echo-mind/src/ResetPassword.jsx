import { useState } from 'react'
import Logo from './Logo.jsx'
import { api } from './api'

function ResetPassword({ onSwitch, notify }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await api('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
      setSent(true)
      notify('Reset link sent. Check your inbox.')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <main className="auth-wrap">
        <div className="auth-card">
          <div className="auth-head">
            <Logo size={44} wordmark={false} />
            <span className="auth-eyebrow">Check your email</span>
            <h2>We sent you a reset link</h2>
            <p>Click the link in your email to set a new password.</p>
          </div>
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

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <Logo size={44} wordmark={false} />
          <span className="auth-eyebrow">Reset password</span>
          <h2>Forgot your password?</h2>
          <p>Enter your email and we'll send you a reset link.</p>
        </div>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>Email</span>
            <input
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" className="btn-cta auth-submit" disabled={loading}>
            {loading ? 'Sending…' : 'Send Reset Link'}
          </button>
        </form>
        <p className="auth-switch">
          Remember your password?{' '}
          <button
            type="button"
            className="auth-link"
            onClick={() => onSwitch('login')}
          >
            Log In
          </button>
        </p>
      </div>
    </main>
  )
}

export default ResetPassword