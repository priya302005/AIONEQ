import app from './app.js'
import { config } from './config/config.js'
import { assertEnv, assertSafeDefaults } from './config/startup.js'

// Fail fast before listening: if required secrets are missing or the LLM is
// outside localhost, do not serve traffic at all.
assertEnv()
assertSafeDefaults()

// Uncaught failures must kill the process in a vault product, not half-serve.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason)
  process.exit(1)
})
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err)
  process.exit(1)
})

app.listen(config.port, config.host, () => {
  console.log(`EchoMind API running on http://${config.host}:${config.port} (${config.env})`)
})