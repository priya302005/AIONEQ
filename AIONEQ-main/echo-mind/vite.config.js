import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * CSP helper: the strict upstream CSP lives in index.html. Dev mode needs a
 * couple of extra allowances the react-refresh preamble requires, so we
 * rewrite the script-src directive only when running `vite` (serve).
 */
function devCspPlugin() {
  return {
    name: 'dev-csp-allow-inline-scripts',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /(script-src )'self'/,
        `$1'self' 'unsafe-inline' 'unsafe-eval'`
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), devCspPlugin()],
})