import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'

/**
 * Route guard. Fails CLOSED: renders nothing until the auth state is known, and
 * redirects to /login whenever there is no user.
 *
 * It deliberately does NOT call supabase.auth.getUser() itself. AuthProvider
 * already performs exactly that server-side verification on mount, so a second
 * check only doubled the round trips on every page load and, worse, turned any
 * transient network blip into a redirect carrying a misleading
 * "Session expired" message. One verified source of truth, one redirect.
 */
function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login', { replace: true })
    }
  }, [loading, user, navigate])

  if (loading || !user) return null
  return children
}

export default RequireAuth