import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

/** The origin of the configured Supabase project, or null if unusable. */
function supabaseOrigin(url) {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * CSP adjustments that must NOT reach production. The strict upstream CSP lives
 * in index.html; dev mode needs a couple of extra allowances, so we rewrite the
 * relevant directives only when running `vite` (serve).
 *
 *  - script-src gains 'unsafe-inline'/'unsafe-eval' for the react-refresh preamble.
 *  - connect-src gains the configured Supabase origin, but ONLY when it is plain
 *    http. A hosted project is https, which the shipped `connect-src ... https:`
 *    already covers; the local stack (http://localhost:54321) is not, and the
 *    browser blocks the auth calls with an opaque CSP violation instead.
 */
function devCspPlugin(env) {
  const supabase = supabaseOrigin(env.VITE_SUPABASE_URL)
  const extraConnectSrc = supabase && !supabase.startsWith('https:') ? supabase : null

  return {
    name: 'dev-csp-allow-dev-origins',
    apply: 'serve',
    transformIndexHtml(html) {
      let out = html.replace(
        /(script-src )'self'/,
        `$1'self' 'unsafe-inline' 'unsafe-eval'`
      )
      if (extraConnectSrc) {
        out = out.replace(/(connect-src )'self'/, `$1'self' ${extraConnectSrc}`)
      }
      return out
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Read VITE_* from every .env* file, including .env.local, so the dev CSP
  // matches the Supabase project this run is actually pointed at.
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  return {
    plugins: [react(), devCspPlugin(env)],
  }
})