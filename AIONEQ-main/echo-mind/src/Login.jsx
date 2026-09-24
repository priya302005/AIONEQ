import { useState } from 'react'
import Logo from './Logo.jsx'
import { supabase } from './supabaseClient'
import { api } from './api'

function Login({ onSwitch, onHome, notify }) {
  const [showPw, setShowPw] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { session } = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      if (session) {
        await supabase.auth.setSession(session)
      }
      notify('Logged in successfully. Welcome back!')
      onHome()
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
          <span className="auth-eyebrow">Welcome back</span>
          <h2>Log in to your archive</h2>
          <p>Continue where you left off.</p>
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
          <label className="auth-field">
            <span>Password</span>
            <div className="pw-row">
              <input
                type={showPw ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="current-password"
                required
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
          <div className="auth-row">
            <label className="auth-check">
              <input type="checkbox" /> Remember me
            </label>
            <button type="button" className="auth-link" onClick={() => onSwitch('reset-password')}>Forgot password?</button>
          </div>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" className="btn-cta auth-submit" disabled={loading}>
            {loading ? 'Logging in…' : 'Login'}
          </button>
        </form>
        <p className="auth-switch">
          Don't have an account?{' '}
          <button
            type="button"
            className="auth-link"
            onClick={() => onSwitch('signup')}
          >
            Sign Up
          </button>
        </p>
        <p className="auth-terms">Protected by end-to-end encryption.</p>
      </div>
    </main>
  )
}

export default Login