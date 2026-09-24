import { useState } from 'react'
import Logo from './Logo.jsx'
import { supabase } from './supabaseClient'
import { api } from './api'

function Signup({ onSwitch, notify }) {
  const [showPw, setShowPw] = useState(false)
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { session } = await api('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ fullName, email, password }),
      })
      if (session) {
        await supabase.auth.setSession(session)
      }
      notify('Account created successfully. Check your email to confirm.')
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
          <span className="auth-eyebrow">Create your account</span>
          <h2>Start your memory capsule</h2>
          <p>It takes less than a minute — your story is waiting.</p>
        </div>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>Full name</span>
            <input
              type="text"
              placeholder="Jane Doe"
              autoComplete="name"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </label>
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
            {loading ? 'Creating…' : 'Create Account'}
          </button>
        </form>
        <p className="auth-switch">
          Already have an account?{' '}
          <button
            type="button"
            className="auth-link"
            onClick={() => onSwitch('login')}
          >
            Log In
          </button>
        </p>
        <p className="auth-terms">
          By signing up you agree to our Terms & Privacy Policy.
        </p>
      </div>
    </main>
  )
}

export default Signup