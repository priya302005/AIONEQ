import { createClient } from '@supabase/supabase-js'
import { config } from './config.js'

if (!config.supabaseUrl || !config.supabaseAnonKey) {
  console.warn('Supabase credentials missing. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env')
}

export const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false },
})