import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function verify() {
      try {
        // Verify against Supabase (server-side token check) - fail closed:
        // any error or missing session clears the user.
        const { data, error } = await supabase.auth.getUser()
        if (cancelled) return
        if (error || !data.user) {
          setUser(null)
        } else {
          setUser(data.user)
        }
      } catch {
        if (!cancelled) setUser(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    verify()

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setUser(null)
        return
      }
      // INITIAL_SESSION can land before or after verify() resolves, and while a
      // session refresh is still in flight it can carry no user at all. Letting
      // it overwrite a user we have already verified server-side would bounce a
      // signed-in user to /login on reload, so it may only ever fill a gap.
      if (event === 'INITIAL_SESSION') {
        if (session?.user) setUser(session.user)
        return
      }
      // SIGNED_IN / TOKEN_REFRESHED / USER_UPDATED / PASSWORD_RECOVERY
      setUser(session?.user ?? null)
    })

    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  /**
   * Re-reads the signed-in user from Supabase.
   *
   * The browser only holds an access token, and a profile edit changes metadata
   * on the server, so the copy in memory (and in the navbar) goes stale until we
   * ask again. Never clears the user on failure - a transient network error must
   * not sign somebody out.
   */
  const refreshUser = useCallback(async () => {
    const { data, error } = await supabase.auth.getUser()
    if (!error && data?.user) setUser(data.user)
    return data?.user ?? null
  }, [])

  return <AuthContext.Provider value={{ user, loading, refreshUser }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}