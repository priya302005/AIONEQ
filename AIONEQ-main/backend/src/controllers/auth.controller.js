import { createClient } from '@supabase/supabase-js'
import { supabase } from '../config/supabase.js'
import { config } from '../config/config.js'
import { asyncHandler } from '../utils/asyncHandler.js'

export const signup = asyncHandler(async (req, res) => {
  const { fullName, email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' })
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  })

  if (error) {
    return res.status(400).json({ error: error.message })
  }

  res.status(201).json({ user: data.user, session: data.session })
})

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' })
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    const message = /email not confirmed/i.test(error.message)
      ? 'Email not confirmed. Check your inbox for the confirmation link before logging in.'
      : error.message
    return res.status(401).json({ error: message })
  }

  res.json({ user: data.user, session: data.session })
})

export const resetPassword = asyncHandler(async (req, res) => {
  const { email } = req.body

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' })
  }

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: config.resetRedirectUrl,
  })

  if (error) {
    return res.status(400).json({ error: error.message })
  }

  res.json({ message: 'Reset link sent. Check your inbox.' })
})

export const updatePassword = asyncHandler(async (req, res) => {
  const { password } = req.body

  if (!password) {
    return res.status(400).json({ error: 'Password is required.' })
  }

  const authedClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${req.accessToken}` } },
  })

  const { data, error } = await authedClient.auth.updateUser({ password })

  if (error) {
    return res.status(400).json({ error: error.message })
  }

  res.json({ message: 'Password updated successfully.', user: data.user })
})

export const getProfile = asyncHandler(async (req, res) => {
  res.json({ user: req.user })
})