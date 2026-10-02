import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'
import { supabase } from '../supabaseClient'

/**
 * Route guard. Fails CLOSED: renders nothing and redirects to /login on any
 * error while checking auth state. It verifies the session with a server-side
 * getUser() call (not just "is there a token").
 */
function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const [verifying, setVerifying] = useState(true)
  const [ok, setOk] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function verify() {
      try {
        const { error } = await supabase.auth.getUser()
        if (cancelled) return
        if (error) {
          setOk(false)
          navigate('/login', { replace: true, state: { reason: 'Session expired. Please log in again.' } })
        } else {
          setOk(true)
        }
      } catch {
        if (cancelled) return
        setOk(false)
        navigate('/login', { replace: true, state: { reason: 'Unable to verify your session. Please log in again.' } })
      } finally {
        if (!cancelled) setVerifying(false)
      }
    }
    verify()
    return () => { cancelled = true }
  }, [navigate])

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login', { replace: true })
    }
  }, [loading, user, navigate])

  if (loading || !user || verifying || !ok) return null
  return children
}

export default RequireAuth