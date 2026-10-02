import { useEffect, useRef } from 'react'

const DEFAULT_TTL_MINUTES = 30

/**
 * Idle session timeout. Resets on user activity (pointer, keys, scroll,
 * touch, visibility). When the idle window elapses `onTimeout()` fires and the
 * caller is expected to sign out and redirect.
 */
export function useSessionTimeout(onTimeout, active = true) {
  const timeoutRef = useRef(null)
  const onTimeoutRef = useRef(onTimeout)
  onTimeoutRef.current = onTimeout

  useEffect(() => {
    if (!active) return undefined

    const ttlMs = (Number(import.meta.env.VITE_SESSION_TTL_MINUTES) || DEFAULT_TTL_MINUTES) * 60 * 1000

    const reset = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => onTimeoutRef.current?.(), ttlMs)
    }

    const events = ['pointerdown', 'keydown', 'scroll', 'wheel', 'touchstart']
    const listeners = events.map((ev) => {
      window.addEventListener(ev, reset, { passive: true })
      return ev
    })
    const onVisibility = () => { if (!document.hidden) reset() }
    document.addEventListener('visibilitychange', onVisibility)

    reset()

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      listeners.forEach((ev) => window.removeEventListener(ev, reset))
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active])
}

export default useSessionTimeout