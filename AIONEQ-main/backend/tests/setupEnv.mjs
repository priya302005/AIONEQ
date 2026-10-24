// Dummy environment so the suite runs on a clean checkout (no .env needed).
// Only fills variables that are unset; a real .env / CI value always wins.
const defaults = {
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  FILE_SIGNING_SECRET: 'test-file-signing-secret',
  AUDIT_LOG_PATH: new URL('../logs/audit.test.log', import.meta.url).pathname,
}
for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v
