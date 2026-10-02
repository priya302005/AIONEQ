import { useEffect, useState } from 'react'
import { api } from '../api'

const cache = new Map() // memoryId -> { url, fetchedAt }

/**
 * Obtains a short-lived signed URL for a memory's file from the backend.
 * The frontend never constructs storage URLs itself (security: files are only
 * reachable through the signed /api/files/:token route, ownership-checked).
 * Cached per memory for the life of the tab.
 */
export function useSignedFileUrl(memory) {
  const [state, setState] = useState({ url: null, error: '', loading: false })

  // Stable fetch key so the effect only re-runs when the relevant parts of the
  // memory change (avoids re-fetching on every memory object identity change).
  const memoryId = memory?.id
  const hasFile = Boolean(memoryId && storageHasFile(memory))

  useEffect(() => {
    let cancelled = false
    if (!hasFile) {
      setState({ url: null, error: '', loading: false })
      return undefined
    }
    const cached = cache.get(memoryId)
    if (cached) {
      setState({ url: cached.url, error: '', loading: false })
      return undefined
    }
    setState({ url: null, error: '', loading: true })
    api(`/api/memories/${memoryId}/signed-url`)
      .then((res) => {
        if (cancelled) return
        cache.set(memoryId, { url: res.url })
        setState({ url: res.url, error: '', loading: false })
      })
      .catch((err) => {
        if (cancelled) return
        setState({ url: null, error: err.message, loading: false })
      })
    return () => { cancelled = true }
  }, [memoryId, hasFile])

  return state
}

function storageHasFile(memory) {
  // Text memories store the captured text in transcript/content; only voice
  // and document rows carry a file_url.
  return Boolean(memory?.file_url || (memory?.type === 'voice' && memory?.transcript && !memory?.content))
}

/** URL helper for download links when a signed URL is already resolved. */
export function signedUrlFor(state) {
  return state.url || ''
}

/** Revokes any object URLs used in the app (defense in depth). */
export function revokeObjectUrl(url) {
  if (typeof window !== 'undefined' && url && url.startsWith('blob:') && window.URL?.revokeObjectURL) {
    window.URL.revokeObjectURL(url)
  }
}