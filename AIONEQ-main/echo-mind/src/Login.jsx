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

  // MFA (TOTP) second-factor state.
  const [mfaStep, setMfaStep] = useState(false)
  const [mfaFactorId, setMfaFactorId] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [mfaError, setMfaError] = useState('')

  /** Second factor: challenge the verified TOTP factor and verify the code. */
  async function finishMfa(code) {
    setMfaError('')
    setLoading(true)
    try {
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: mfaFactorId,
      })
      if (challengeError) throw new Error(challengeError.message)

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaFactorId,
        challengeId: challengeData.id,
        code,
      })
      if (verifyError) throw new Error(verifyError.message)

      notify('Logged in successfully. Welcome back!')
      onHome()
    } catch (err) {
      setMfaError(err.message || 'The code was incorrect.')
      setLoading(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { session, mfaRequired, factors } = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      if (mfaRequired) {
        // Establish the session so the MFA API can operate, then demand the
        // second factor before releasing the app.
        await supabase.auth.setSession(session)
        const factor = (factors || []).find((f) => f.status === 'verified' && f.factor_type === 'totp')
        setMfaFactorId(factor?.id || (factors || [])[0]?.id)
        setMfaStep(true)
        setNumberInput()
        return
      }
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

  function setNumberInput() {
    // Small delay so the input can render before focusing.
    setTimeout(() => document.getElementById('totp-input')?.focus(), 60)
  }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <Logo size={44} wordmark={false} />
          <span className="auth-eyebrow">{mfaStep ? 'Second factor' : 'Welcome back'}</span>
          <h2>{mfaStep ? 'Enter your verification code' : 'Log in to your archive'}</h2>
          <p>{mfaStep ? 'Enter the 6-digit code from your authenticator app to finish signing in.' : 'Continue where you left off.'}</p>
        </div>

        {mfaStep ? (
          <form
            className="auth-form"
            onSubmit={(e) => {
              e.preventDefault()
              finishMfa(totpCode)
            }}
          >
            {mfaError && <p className="auth-error" role="alert">{mfaError}</p>}
            <label className="auth-field">
              <span>Authenticator code</span>
              <input
                id="totp-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={loading}
              />
            </label>
            <button type="submit" className="btn-cta auth-submit" disabled={loading || totpCode.length !== 6}>
              {loading ? 'Verifying…' : 'Verify & Log In'}
            </button>
            <p className="auth-switch">
              Back to{' '}
              <button
                type="button"
                className="auth-link"
                onClick={() => {
                  setMfaStep(false)
                  supabase.auth.signOut().catch(() => {})
                }}
              >
                password login
              </button>
            </p>
          </form>
        ) : (
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
        )}
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