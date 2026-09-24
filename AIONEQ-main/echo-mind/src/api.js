import { supabase } from './supabaseClient'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

export async function api(path, { token, ...options } = {}) {
  if (!token) {
    const { data } = await supabase.auth.getSession()
    token = data.session?.access_token
  }
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.message || data.error || 'Something went wrong. Please try again.')
  }
  return data
}