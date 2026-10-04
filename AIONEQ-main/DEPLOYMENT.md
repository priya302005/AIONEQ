# EchoMind — Production Deployment Report

**Date:** 2026-10-04
**Scope:** Production readiness, live verification, and deployment
preparation for the EchoMind Intelligent Memory System.
**Status:** Deployment-ready for an isolated/staging environment.
Two live validations (isolation, remote embeddings) could not be
executed in this environment and are recorded as outstanding with
exact reproduction steps — they are NOT marked as passed.

---

## 1. Completed tasks

| Phase | Task | Result |
|---|---|---|
| 1 | Production readiness audit | Done — codebase, AUDIT.md, CONSENT-DECISION.md, migrations, env, deployment setup inspected |
| 2 | Database migration review | Done — both migrations reviewed: idempotent, additive, RLS-scoped (§3) |
| 3 | Live Supabase isolation | **Executed, FAILED at setup** — 5/5 tests fail at the signup hook (§4) |
| 4 | Remote embedding validation | **Not executable** — no embedding server reachable (§5) |
| 5 | Security & privacy verification | Done — opt-outs, deletion, disclosures, secrets, upload trust all verified (§6) |
| 6 | Production configuration | Done — env requirements + gaps identified (§7) |
| 7 | End-to-end smoke tests | **18/18 infra checks pass**; authenticated workflow skipped (no API_TOKEN) (§8) |
| 8 | Final regression | All green (§9) |
| 9 | Final deliverables | This report + AUDIT.md update |

---

## 2. Exact files changed (this round)

**Added:**
- `backend/scripts/smokeTest.mjs` — infrastructure smoke test (spawns the real server, verifies health/security headers/401/CORS/uploads/CORS; `npm run smoke`)
- `backend/scripts/runIsolationLive.mjs` — runs the live isolation suite against a freshly spawned server (`npm run test:isolation:live`)

**Modified:**
- `backend/package.json` — added `smoke` and `test:isolation:live` scripts

No application source code was changed in this round; the
implementation was already complete and is preserved as-is.

---

## 3. Database migrations

**Application order** (all idempotent; safe to re-run):
1. `backend/sql/memories.sql` — base `memories` table + RLS
2. `backend/sql/query.sql` — AI query module (conversations, legacy grants base)
3. `backend/sql/context.sql` — enrichment columns (keywords/entities)
4. `backend/sql/security.sql` — security hardening (legacy_grants, RLS policies, `file_size`, legacy-access policies; includes the new `legacy_grants_recipient_delete`)
5. `backend/sql/memory_intelligence.sql` — vectors, links, settings, search-vector trigger (includes the new `memory_settings_delete_own`)

**Verified properties:**
- Every object is `create ... if not exists` / `create or replace` /
  `drop policy if exists` → idempotent and order-tolerant.
- Additive: new columns/tables only; original user content is never
  rewritten.
- Every table has `select/insert/update/delete _own` RLS policies
  scoped to `auth.uid()`.
- `match_memory_vectors` RPC runs as **security invoker** (RLS applies)
  and filters on `dim` + embedding-space `model`, so changing the
  embedding model can never silently mix vector spaces.
- Backfills pre-existing rows (`processing_status`, `search_vector`).

**Pending:** the migrations have NOT been applied to any live project
in this session (no isolated project was available). They must be
applied to the target project before semantic search, memory links,
privacy toggles, or self-service account deletion work.

**Rollback limitations:**
- The migration is additive but **not safely reversible without data
  loss**: dropping `memory_vectors` / `memory_links` /
  `memory_settings` or the new `memories` columns destroys that derived
  data. Full reversal = restore from a pre-migration backup.
- **Account deletion is irreversible** (modulo the backup retention
  window). Deleted memories, vectors, links, settings, conversations,
  files and grants cannot be undeleted by the application.
- The `search_vector` trigger and GIN index are dropped cleanly; the
  backfilled `search_vector` values remain on rows unless explicitly
  nulled.

---

## 4. Live Supabase isolation — ACTUAL RESULT (not passed)

Ran via `npm run test:isolation:live` (spawns the real server against
the configured project, then `node --test tests/isolation.test.mjs`
with `ISOLATION_TEST=1`).

**Result: 5 tests, 0 passed, 5 failed.** Every test failed at the
`before()` setup hook, not in any assertion:

```
error: 'Signup did not return a session (email confirmation required?).
        Body: {"error":"Unable to create an account with those details."}'
failureType: 'hookFailed'
```

**Root cause:** the configured Supabase project enforces email
confirmation (and rate-limits confirmation emails), so the suite's
`signup()` cannot create two instantly-authenticated test accounts.
The tests are correct; the environment cannot provision test users.
No service-role key is configured (admin user creation returns 403)
and Docker is unavailable (no local isolated stack).

**This is an environment limitation, not a code defect.** The suite was
run and its failure was recorded — it was not marked as passed.

**Exact remaining manual steps** (see the `tests/isolation.test.mjs`
header for the full recipe):
1. Provision a **throwaway/isolated** Supabase project (or
   `supabase init && supabase start` — requires Docker).
2. Apply the five migrations in §3.
3. Either disable **email confirmation** (Auth settings) so signup
   returns a session, or configure `SUPABASE_SERVICE_ROLE_KEY` so the
   suite can create users via the admin API.
4. Start the backend against that project, then
   `ISOLATION_TEST=1 SUPABASE_URL=… SUPABASE_ANON_KEY=… ISOLATION_API=http://localhost:4000 npm run test:isolation`.
5. Validate the suite covers: cross-user memory access, vector
   retrieval isolation, memory-link isolation, settings isolation,
   unauthorized edit/delete, citation isolation, and account deletion.

---

## 5. Remote embedding validation — NOT EXECUTED

No embedding server is reachable in this environment:
`http://localhost:4891` returns `ECONNREFUSED`, and no remote
provider is configured. Attempting the remote path fails loudly and
correctly — it does **not** silently fall back to local vectors:

```
EMBEDDING_MODE=remote EMBEDDING_MODEL=nomic-embed-text-v1.5 EMBEDDING_DIM=768 \
  node eval/runRetrievalEval.mjs lexical
→ ProviderError: Cannot reach the local AI at http://localhost:4891 …
  code: 'provider_unreachable', status: 502
```

**Local baseline (re-confirmed this round, 51 memories / 54 questions):**

| strategy | hit@5 | top1 | recall@5 | MRR | prec@5 | leaks |
|---|---|---|---|---|---|---|
| lexical | 79.1% | 37.2% | 0.715 | 0.538 | 0.252 | 0 |
| vector | 67.4% | 53.5% | 0.674 | 0.598 | 0.440 | 0 |
| hybrid | 81.4% | 53.5% | 0.757 | 0.644 | 0.267 | 0 |

**Outstanding requirement:** to validate remote embeddings, serve an
OpenAI-compatible `/v1/embeddings` endpoint (e.g. llama.cpp
`--embedding`), then run the SAME benchmark with
`EMBEDDING_MODE=remote EMBEDDING_MODEL=<model> EMBEDDING_DIM=<dim>
LOCAL_AI_BASE_URL=<server> node eval/runRetrievalEval.mjs`. The runner
goes through the real `embed()`, so it indexes and evaluates the remote
provider directly and compares hit@5/top1/recall@5/MRR/latency against
the local baseline above. Do not switch production to remote embeddings
until quality is verified and the archive is reindexed
(`npm run reindex:vectors`).

---

## 6. Security & privacy status

**Verified (by tests + live smoke):**
- Every API route is behind per-route `requireAuth` (authCoverage
  test + smoke test: 401 on missing AND garbage token for all six
  protected routes).
- Helmet security headers present (nosniff, frame-ancestors none,
  no-referrer; HSTS in production).
- CORS locked to configured origins (unconfigured origin → 403, no
  ACAO header; never `*`).
- `/uploads` direct access blocked (403); files served only via
  short-lived signed, ownership-checked `/api/files/:token` URLs.
- **Memory-AI opt-out skips retrieval** — grounding test proves 0
  memory queries and 0 vector RPCs when `memoryAiEnabled=false`.
- **Conversation-memory opt-out prevents conversation reads** — 0
  conversation SELECTs when `conversationMemoryEnabled=false` (the
  chat still persists its own turns, but history is never used as
  context).
- **Account deletion removes all supported user-owned data** — 7 tests
  (complete wipe across 6 tables + files, cross-user isolation,
  partial-failure safety, service-role identity deletion).
- **Retained identity / backup / stuck files are disclosed** in the
  deletion response (`deletion.limitations`).
- **Service-role credentials never reach the frontend** — the frontend
  reads only `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_API_URL` (all public values). `SUPABASE_SERVICE_ROLE_KEY` is
  backend-only and commented as "NEVER put this in the frontend .env".
- **No secrets in tracked files** — JWT/key scans clean; the project
  URL appears only in gitignored `.env` files; dev logs are empty.
- **Uploaded documents are untrusted** — MIME sniffing verifies content
  matches the declared type (anti-spoofing), optional malware scan
  (`SCAN_COMMAND`), per-user quota, and prompt-safety sanitization
  before the model sees derived text.

**Consent defaults:** unchanged (opt-out). The product-owner decision
is prepared in `CONSENT-DECISION.md`; no default was silently changed.

---

## 7. Production configuration requirements

**Required env (backend):** `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SIGNED_URL_SECRET`. The server **fails fast** (exits) if any are
missing or if `LOCAL_AI_BASE_URL` is not localhost/private.

**Configuration behaviour now enforced (Phase 9):**

1. **`SIGNED_URL_SECRET`** — in production (`NODE_ENV=production`)
   the server **refuses to start** unless a dedicated secret
   (≥ 32 characters, and not the Supabase anon key) is set; it
   no longer silently falls back to the anon key in production.
   In development the fallback is still allowed (logged as a
   warning) so the flow stays usable locally. **Owner action:**
   set the actual secret value in the production `.env`.
2. **`LEGACY_VERIFICATION`** — the default is now **`access-code`**
   (two factors, matching the frontend, which labels the shared
   code "recommended"). `none` (claim token alone) is
   single-factor and is warned about at startup; it is only
   appropriate where the operator explicitly accepts that
   trade-off. Changing the setting never alters existing grants
   silently — a grant created without a code cannot activate
   under `access-code` until the owner re-creates it with one
   (fail closed, explicit 403).
3. **Upload scanning** — `SCAN_COMMAND` runs an external scanner
   (e.g. `clamdscan`) on every upload; a found threat OR a
   scanner failure rejects the upload. In production (or
   `REQUIRE_UPLOAD_SCAN=true`) an upload with **no working
   scanner is rejected** (fail closed — an unscanned upload is
   never treated as clean) and the gap is surfaced loudly at
   startup. In development/test the scan is skipped (audited) so
   the upload flow stays usable without a scanner. **Owner
   action:** install a scanner and set `SCAN_COMMAND`.
4. **`SUPABASE_SERVICE_ROLE_KEY`** — optional, backend-only.
   Without it, account deletion still wipes all personal data but
   cannot remove the Supabase auth identity (disclosed in the
   deletion response and warned at startup). Set it backend-only
   to enable full identity removal.

**Other production settings:** `NODE_ENV=production` (enables HSTS),
`CORS_ORIGIN` (exact frontend origins), `RESET_REDIRECT_URL`,
`TRUST_PROXY` (only behind a TLS reverse proxy that sets
X-Forwarded-For), `HOST=127.0.0.1` (loopback by default; the local
LLM must stay private), `AUDIT_ENABLED=true`, `SESSION_TTL_MINUTES`.

**Frontend env (echo-mind/.env, gitignored):** `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`. No secrets here — these are
public values by design.

**No localhost-only hard dependency in production** except the local
LLM (`LOCAL_AI_BASE_URL`), which is deliberately constrained to
localhost/private network because it processes private memories. If the
LLM runs as a separate service, deploy it on the same private network
and point `LOCAL_AI_BASE_URL` at its private address (the fail-fast
check enforces that it is never a public hostname).

---

## 8. End-to-end smoke tests — ACTUAL RESULT

`npm run smoke` (spawns the real server, hard 8s timeouts per request):

**18 passed, 0 failed, 1 skipped.**
- PASS server starts and answers `/api/health` (`{status: ok}`)
- PASS Helmet security headers (nosniff, framing, referrer)
- PASS 401 without token — all six protected routes (correct methods)
- PASS 401 with garbage token — all six protected routes
- PASS direct `/uploads` access blocked (403)
- PASS CORS refuses unconfigured origin (403, no ACAO)
- PASS CORS allows configured origin (204, ACAO present)
- SKIP authenticated lifecycle — **no `API_TOKEN` provided**

**Authenticated lifecycle** (Phase 9) is now a full core
memory workflow, not just list/settings: authenticate (list +
settings) → **create** a synthetic memory → **retrieve** it by
id → **search** for it → **ask a grounded question** → verify
**consent behaviour** (memory-AI off ⇒ zero citations) →
**cross-user authorization** (a second `API_TOKEN_B` cannot
read the memory) → **delete** it → verify it is **no longer
retrievable** (404 and gone from search). A unique marker
scopes every step to the memory that run creates, and cleanup
runs in a `finally` block so the test account is never left
with stray data. It also fixed a real defect: the HTTP helper
silently dropped request bodies, so every POST/PATCH (settings
toggle, create, ask) was sending nothing. Without `API_TOKEN`
(and a running local LLM for the ask steps) the authenticated
portion is honestly reported as skipped. To run it:
`API_TOKEN=<test-user-jwt> npm run smoke` (add `API_TOKEN_B`
for the cross-user check), with the LLM served on
`LOCAL_AI_BASE_URL`.

---

## 9. Final regression — ACTUAL RESULTS

| Check | Result |
|---|---|
| Backend test suite | **210 tests — 205 pass, 0 fail, 5 skipped** (live-isolation tests, correctly gated by `ISOLATION_TEST=1`). +11 config-validation tests and +11 lifecycle subtests this phase. |
| Config-validation tests (new) | **11 pass, 0 fail** — production `SIGNED_URL_SECRET` (dedicated/strong/not-anon-key), dev fallback warned-not-fatal, upload-scan fail-closed paths, `access-code` default |
| Lifecycle tests (new) | **11 pass, 0 fail** — full create→retrieve→search→ask→consent(off⇒zero citations)→cross-user(RLS 404)→delete→gone, against the RLS-correct fake store |
| Frontend lint | exit 0 (pre-existing warnings only: fast-refresh, setState-in-effect, one unused `total`) |
| Frontend production build | exit 0 — 563.38 kB / 157.38 kB gzip, 1.32 s (code-splitting advisory, pre-existing) |
| Import resolution | all changed files pass `node --check`; the server boots (all imports resolve) |
| Production fail-closed (runtime) | `NODE_ENV=production` + anon-key fallback ⇒ **exit 1** (FATAL, no secret value leaked); `NODE_ENV=production` + strong dedicated secret ⇒ reaches listening, 0 FATAL |
| Retrieval evaluation | local baseline, **0 cross-user leaks** on all three strategies (unchanged — Phase 9 did not touch retrieval) |
| Security/privacy regression | 18/18 smoke infra checks pass; 7/7 account-deletion tests pass; consent gating tests pass |
| Live isolation suite | 5/5 fail at setup (email confirmation) — see §4; **unverified** |
| Remote embedding eval | not executed (no server) — see §5; **unverified** |
| Authenticated staging smoke | **not executed** — no `API_TOKEN` (see §8) |

---

## 10. Remaining risks

1. **Live RLS/isolation is unverified** against real Postgres — the
   highest-priority open item (§4). The fake-store and smoke results
   are proxies, not proof.
2. **Remote embedding quality is unmeasured** (§5) — local vectorizer
   remains the safe default.
3. **`SIGNED_URL_SECRET` fallback to the anon key** —
   **resolved for production** (Phase 9): the server now
   refuses to start in production without a dedicated
   secret. The fallback remains only in development
   (warned), which is intentional for local usability.
   **Still an owner action:** set the actual secret value.
4. **`LEGACY_VERIFICATION`** — **improved** (Phase 9): the
   default is now `access-code` (two factors). `none` is
   single-factor and only applies if the operator explicitly
   sets it; it is warned at startup.
5. **Upload malware scanning** — **improved** (Phase 9):
   production (or `REQUIRE_UPLOAD_SCAN=true`) now **rejects**
   uploads when no working scanner is configured (fail
   closed — an unscanned upload is never treated as clean).
   **Still an owner action:** install a scanner (ClamAV) and
   set `SCAN_COMMAND`; until then production uploads are
   rejected, which is safe but blocks the upload feature.
6. **Two sample uploads are tracked in git history**
   (`backend/uploads/*.pdf`, `*.webm`) — outside the account-deletion
   path; removable only by a history rewrite (not performed; needs
   authorization).
7. **Supabase PITR backups** retain deleted rows for the backup
   retention window — disclosed by the deletion endpoint, not solvable
   at the app layer.
8. **Calibration constants** (`VECTOR_MIN_SIMILARITY`,
   `VECTOR_SIMILARITY_ANCHOR`, `RETRIEVAL_VECTOR_WEIGHT`) are derived
   from the synthetic corpus — re-derive against the real archive.
9. **Frontend bundle** is 563 kB (code-splitting advisory) and has
   lint advisories (setState-in-effect, unused var) — non-blocking.

---

## 11. Deployment & rollback instructions

**Deploy (to an isolated/staging project first):**
1. Back up the target project (Supabase PITR / `pg_dump`).
2. Apply the five migrations in §3 order (Supabase SQL editor).
3. Set the backend env per §7 — especially a dedicated
   `SIGNED_URL_SECRET`, `CORS_ORIGIN`, and (backend-only)
   `SUPABASE_SERVICE_ROLE_KEY` if full account deletion is required.
4. Confirm `LOCAL_AI_BASE_URL` points at a private/localhost LLM
   (the server refuses to start otherwise).
5. `npm install && npm start` (binds loopback by default).
6. Build and serve the frontend (`npm run build` in `echo-mind`).
7. Run `npm run smoke` and, once an isolated project with
   instant-signup is available, `npm run test:isolation:live`.

**Rollback:**
- App/config: revert env + redeploy the previous build.
- Migrations: additive, so the app keeps working if they are absent;
  to undo them, drop the new tables/policies (destroys derived data)
  or restore the pre-migration backup for a clean reversal.
- Account deletion is irreversible (modulo the backup window).

---

## 12. Final production-readiness checklist

- [ ] Provision an isolated Supabase project (or local stack via Docker)
- [ ] Apply the five migrations in order (§3)
- [x] Enforce a dedicated `SIGNED_URL_SECRET` in production (fail-fast, not the anon key) — **done**; [ ] set the actual secret value in the production `.env`
- [ ] Set `CORS_ORIGIN` / `RESET_REDIRECT_URL` to production values
- [x] Default `LEGACY_VERIFICATION` to `access-code` (two factors) — **done**; [ ] (optional) confirm the operator accepts the default
- [x] Fail closed on unscanned uploads in production (`REQUIRE_UPLOAD_SCAN`) — **done**; [ ] install a scanner (ClamAV) and set `SCAN_COMMAND`
- [ ] Set `SUPABASE_SERVICE_ROLE_KEY` backend-only (for full deletion)
- [ ] Confirm the local LLM is deployed on a private network
- [ ] Re-derive calibration constants against the real archive
- [ ] Run the live isolation suite (unblock signup per §4) — **blocking**
- [ ] Serve the LLM and re-run `npm run eval:grounding` with a real model
- [ ] (If adopting) validate remote embeddings per §5, then reindex
- [ ] Product-owner decision on consent defaults (`CONSENT-DECISION.md`)
- [ ] Rotate the Supabase anon key if this checkout left a trusted machine
- [ ] (Optional) remove the two sample uploads from git history
- [ ] Address frontend lint advisories and bundle code-splitting

**Do not deploy to production** until the live isolation suite (§4)
passes on an isolated project and `SIGNED_URL_SECRET` is set (§7).

---

## 13. Phase 9 — Final production readiness (this round)

**Objective:** resolve the remaining configuration and
verification blockers; preserve all verified functionality.
No production deployment, no consent-default change, no
credential rotation, no destructive operations.

### 13.1 Exact files changed

**Backend source:**
- `backend/src/config/config.js` — `legacyVerification`
  default `none` → **`access-code`**; added
  `uploadScanRequired` (`REQUIRE_UPLOAD_SCAN`, defaults to
  true in production); clarified the `signedUrlSecret`
  fallback comment (dev-only).
- `backend/src/config/startup.js` — extracted a pure,
  testable `checkEnv(cfg)` (no `process.exit`); production
  now **fails fast** unless `SIGNED_URL_SECRET` is a
  dedicated secret (≥ 32 chars, not the anon key); added
  startup warnings for explicit `LEGACY_VERIFICATION=none`
  and for a required-but-missing scanner.
- `backend/src/middleware/scan.middleware.js` — fail
  closed: when a scanner is required but not configured,
  `scanFile` returns `clean: false` (the upload is
  rejected); in development/test it is an audited no-op
  (`clean: true`). Accepts an injected config for testing.
- `backend/src/controllers/memory.controller.js` — the
  scan gate now distinguishes "scanner ran and
  rejected/failed" (400) from "no scanner available while
  one is required" (503), with accurate audit actions.
- `backend/scripts/smokeTest.mjs` — **fixed a real defect**
  (the HTTP helper silently dropped request `body`s, so
  every POST/PATCH sent nothing); replaced the minimal
  authenticated section with the full memory lifecycle
  (create → retrieve → search → grounded ask → consent-off
  ⇒ zero citations → cross-user RLS → delete → verify
  gone), with `finally`-block cleanup.

**Backend tests (new):**
- `backend/tests/configValidation.test.mjs` — 11 tests.
- `backend/tests/lifecycle.test.mjs` — 11 subtests (drives
  the real controllers through the RLS-correct harness).

**Config/docs:**
- `backend/.env.example` — documented `SIGNED_URL_SECRET`
  (required in production, dedicated, ≥ 32 chars), the
  `access-code` default, `REQUIRE_UPLOAD_SCAN`, and
  `SCAN_COMMAND`.
- `DEPLOYMENT.md` (§7–§10, §12, and this §13).
- `AUDIT.md` (appended Phase 9 section).

### 13.2 Configuration changes implemented

| Setting | Before | After |
|---|---|---|
| `SIGNED_URL_SECRET` (prod) | falls back to anon key (warned) | **required, dedicated, ≥ 32 chars — server exits otherwise** |
| `LEGACY_VERIFICATION` default | `none` (single factor) | **`access-code`** (two factors, matches frontend) |
| Upload scan, no scanner (prod) | rejected via `clean: null` (accidental) | **explicit fail-closed** (`clean: false`, 503, startup warning) |
| Upload scan, no scanner (dev/test) | rejected (broke the flow) | **audited no-op** (`clean: true`) — usable |
| `SUPABASE_SERVICE_ROLE_KEY` | optional | optional (unchanged); absence disclosed, not mandatory |

### 13.3 Commands executed and results

| Command | Result |
|---|---|
| `node --test tests/configValidation.test.mjs` | 11 pass, 0 fail |
| `node --experimental-test-module-mocks --test tests/lifecycle.test.mjs` | 11 pass, 0 fail |
| `npm test` (full suite) | **210 tests — 205 pass, 0 fail, 5 skipped** |
| `npm run smoke` | 18 pass, 0 fail, 1 skip (authenticated lifecycle: no `API_TOKEN`) |
| `npm run lint` (echo-mind) | exit 0 (pre-existing warnings only) |
| `npm run build` (echo-mind) | exit 0 — 563.38 kB / 157.38 kB gzip |
| `node --check` on all 7 changed files | all pass |
| Secrets scan (JWT/`sk-`/PEM patterns in source) | clean |
| `NODE_ENV=production`, no dedicated secret | **exit 1** — FATAL "must not be the Supabase anon key" (no value leaked) |
| `NODE_ENV=production`, strong dedicated secret | reaches listening, 0 FATAL, 2 honest warnings (service-role, scanner) |

### 13.4 Test totals

- **Passed:** backend 205 + config 11 + lifecycle 11 + smoke 18 + lint + build.
- **Failed:** 0.
- **Skipped (backend suite):** 5 (pre-existing, live-isolation tests gated by `ISOLATION_TEST=1`).
- **Not executed:** authenticated staging smoke (no `API_TOKEN`); live Supabase isolation (no isolated project — §4); remote embedding eval (no provider — §5). None are counted as passed.

### 13.5 Remaining owner actions / infrastructure requirements

1. **Live isolation (BLOCKING, unverified):** provision an
   isolated Supabase project (or `supabase start`), disable
   email confirmation (or supply `SUPABASE_SERVICE_ROLE_KEY`
   for the admin path), apply the five migrations in §3
   order, then `npm run test:isolation:live`. The current
   project enforces email confirmation and rate-limits
   confirmation emails, and has no service-role key, so the
   suite fails at its setup hook (5/5) — an environment
   limitation, not a code defect.
2. **Authenticated staging smoke (not executed):** serve the
   local LLM (`localhost:4891`) and run
   `API_TOKEN=<staging-test-jwt> npm run smoke` (add
   `API_TOKEN_B` for the cross-user check).
3. Set the actual `SIGNED_URL_SECRET` value in the
   production `.env` (enforcement is in place; the value
   is not).
4. Install a scanner (ClamAV) and set `SCAN_COMMAND`
   (until then, production uploads are rejected — safe but
   blocks the upload feature).
5. Re-derive calibration constants against the real archive.
6. Product-owner consent decision (`CONSENT-DECISION.md`).
7. Rotate the anon key if this checkout left a trusted
   machine; (optional) remove the two sample uploads from
   git history.

### 13.6 Staging verification

**Not completed.** Local verification (unit, lifecycle,
config, smoke infra, lint, build, production fail-closed)
is complete and green. Live isolation and the authenticated
staging workflow could not be executed here (no isolated
project, no `API_TOKEN`, no running LLM) and are reported
as **unverified / not executed** — not passed.

### 13.7 Release recommendation

**Ready for staging** — application configuration and local
verification are complete, but live environment verification
(isolated-project isolation suite + authenticated staging
smoke with a real LLM) remains and is **blocking** for
production. The two Phase 9 configuration hardenings
(production `SIGNED_URL_SECRET` enforcement; fail-closed
upload scanning; secure `access-code` default) are
implemented, tested, and verified at runtime.
