# EchoMind Production-Readiness Audit

**Scope:** Phases 1–9 of the production-readiness audit of the EchoMind
Intelligent Memory System. Verification of the existing implementation,
retrieval quality measured with real metrics, AI grounding validated
end-to-end, security/privacy/lifecycle review, and fixes only where the
evidence justified them. The memory system was **not** rebuilt.

**Date:** 2026-10-03 · **Backend:** Node v22.17.1, Express 4.22 · **Frontend:** Vite/React (echo-mind)

---

## 1. Verification result

| Check | Result |
|---|---|
| Backend test suite | **181 tests, 176 pass, 0 fail, 5 skipped** (`npm test`) |
| The 5 skipped | Live-Supabase isolation tests, correctly gated behind `ISOLATION_TEST=1` — see §7 |
| Frontend lint (`npm run lint`) | exit 0 — warnings only (fast-refresh advisories, `setState`-in-effect advisories, one unused var) |
| Frontend build (`npm run build`) | exit 0 — built in 1.87s (563 kB JS / 157 kB gzip; advisory: consider code-splitting) |
| Syntax/import checks | all changed backend files pass `node --check` |

The pre-audit suite claimed 146 tests / 141 passing; the actual suite was
**168 tests with 3 failing**. Root causes were test-harness bugs, not
security holes (details in §4). After fixes the suite is 181 tests, all
green, with the 5 live-isolation tests correctly skipped without credentials.

---

## 2. Retrieval quality (Phase 2 — executed, not estimated)

`node eval/runRetrievalEval.mjs` — synthetic corpus of 51 memories, 54
labelled questions, local 384-dim hashed vectorizer. The fake store
emulates PostgREST + websearch FTS; the JS half (candidate gathering,
blended score, dedup, ordering) is measured faithfully, the SQL half is a
proxy (see limitations).

| strategy | hit@5 | top1 | recall@5 | MRR | prec@5 | wrong-top1 | no-ans OK | disjoint OK | leaks |
|---|---|---|---|---|---|---|---|---|---|
| lexical | 79.1% | 37.2% | 0.715 | 0.538 | 0.252 | 62.8% | 18.2% | 100% | 0 |
| vector | 67.4% | 53.5% | 0.674 | 0.598 | 0.440 | 46.5% | 36.4% | 100% | 0 |
| **hybrid** | **81.4%** | **53.5%** | **0.757** | **0.644** | 0.267 | 46.5% | 18.2% | 100% | 0 |

Weak scenarios (hybrid): indirect 50% hit@5 / 16.7% top1, changed_goal
20% top1, temporal 40% top1, low lexical-overlap difficulty 68.8% hit@5.
Zero cross-user leaks in every strategy.

**Interpretation.** Hybrid beats both of its components on hit@5/MRR but
still misses the gold memory first-choice on 46.5% of questions. The
local hashed vectorizer is the recall ceiling: paraphrase/indirect/
changed-goal questions are exactly where a real embedding model earns its
keep. This is the strongest argument for the remote-embedding path (§6).

---

## 3. Grounding & hallucination (Phase 5 — executed end-to-end)

`npm run eval:grounding` — drives the **real** ask controller
(`src/controllers/query.controller.js`) over the same corpus through a
harness with a deterministic stub model and an RLS-correct fake store.
The stub deliberately emits one hallucinated citation and one unsupported
sentence per call, so the filters are *measured*, not assumed.

| Measure | Result |
|---|---|
| Model calls with citations | 42 |
| Hallucinated ids that survived citation filtering | **0** (must be 0) |
| Questions with unsupported answer sentences | **0 / 54** |
| Unsupported claim sentences | **0** |
| Deliberate probe sentences detected (detector self-test) | 51 |
| Questions missing a gold memory | 16 / 43 (carries the §2 recall limit: 22/66 gold memories missed, 33.3%) |
| No-answer, disjoint (topic absent): honest fallback, model never called | **2 / 2** |
| No-answer, adjacent (topic exists, fact absent): adjacent context retrieved by design | 9 / 9 |
| No-answer questions answered without grounding | **0 / 11** |
| Foreign (other-user) ids in any answer context | **0** |

Supporting behaviours proven by the 13-test suite
(`tests/grounding.test.mjs`): user's own words appear as excerpts;
memory use disabled → memories table never queried; conversation memory
disabled → conversations never read; injection-like memory text stays in
the data turn; AI-summary-only excerpts are labelled derived; approved
supersedes links render as a timeline; failed memories excluded; provider
outage → actionable 503; malicious model citations filtered.

**What is NOT proven here:** the stub is not a language model. The harness
validates the *contract* (what the model may see, may cite, must admit it
does not know). Whether a real model's prose stays inside that contract
needs a live model — listed as a production prerequisite.

---

## 4. Fixes made this session (evidence → change)

1. **3 failing `authCoverage.test.mjs` tests** — all test-harness bugs:
   - Express 4.22 compiles mount regexps with escaped slashes
     (`\/api\/memories`); the test's `mountPath()` produced paths with
     literal backslashes that never matched auth prefixes → added
     `unescapePath()` + trailing-slash normalization.
   - `asyncHandler` wrapped middleware anonymously so `h.name ===
     'requireAuth'` never matched → `asyncHandler` now preserves the
     wrapped function's name via `Object.defineProperty`, and the test
     uses identity comparison against the imported middleware.
   - `memoryLink.routes.js` used router-level `router.use(requireAuth)`,
     invisible to the per-route audit → converted to per-route `requireAuth`
     (matching every other router). Read-side verification confirmed all
     routes genuinely guarded; the failures were detection bugs.
   - Exemption list corrected: `/health` → `/api/health`; added
     `PUBLIC_DENY = ['/uploads']` (deliberate 403 stub) with an assertion
     it stays a single deny handler.
2. **`scripts/reindexVectors.mjs` did not exist** while `config.js` and
   `llmClient.js` error messages told users to `npm run reindex:vectors`.
   Implemented: paginated, batched, concurrency pool, retry with backoff,
   `--check/--force/--dry-run/--all-users` modes, RLS-scoped by the
   caller's token, service-role only for `--all-users`. Wired as
   `reindex:vectors` / `reindex:check`.
3. **`.env.example` gap:** `VECTOR_SIMILARITY_ANCHOR` is read by
   `config.js` and referenced by the calibration warning in
   `memoryRetrieval.js` ("see the note in .env.example") but was
   undocumented → added with the calibration warning.
4. **`eval:grounding` / `eval:perf` npm scripts lacked
   `--experimental-test-module-mocks`**, which `mock.module` requires →
   added (both commands failed without it).
5. **Perf-eval import-order bug (found while measuring):** statically
   importing `memoryRetrieval.js` loads `config.js` (→ `.env` →
   `LOCAL_AI_BASE_URL=localhost:4891`) *before* the harness's stub server
   port is known, so every ask-path measurement measured connection
   failures (23/24 parallel asks returned 503 against a dead port). Fixed
   by importing config-free modules statically and loading the
   config-touching services dynamically after `bootstrap()`. After the fix:
   24/24 parallel asks return 200. **Lesson for any future eval script:
   never statically import a module that transitively loads
   `src/config/config.js` before the harness runs.**

### Test-suite delta
- `tests/groundingHarness.mjs` (new) — stub LLM server, multi-table fake
  Supabase with RLS semantics + query recording, `mock.module` bootstrap,
  `runAsk()` driving the real controller.
- `tests/grounding.test.mjs` (new) — 13 end-to-end grounding/security tests.
- `tests/authCoverage.test.mjs` — fixed (above).
- `src/utils/asyncHandler.js` — name-preserving wrapper.
- `src/routes/memoryLink.routes.js` — per-route `requireAuth`.
- `eval/groundingEval.mjs`, `eval/perfEval.mjs` (new), `package.json` scripts.

---

## 5. Performance (Phase 8 — measured on this machine)

`npm run eval:perf` (stub model answers instantly, so ask latency
*excludes* model inference; retrieval sections exclude the LLM entirely):

| Measure | Mean | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| Retrieval, lexical | 3.56 ms | 3.07 | 6.30 | 10.41 | 16.80 |
| Retrieval, vector | 3.33 ms | 3.12 | 5.42 | 13.11 | 14.07 |
| Retrieval, hybrid | 6.94 ms | 6.79 | 9.96 | 18.25 | 28.54 |
| Full ask (no inference) | 28.46 ms | 27.27 | 45.03 | 47.96 | 47.96 |
| Retrieval with a 20k-char memory | 27.79 ms | 20.25 | 49.52 | — | 83.56 |
| Embedding a 264-char memory | 0.67 ms | 0.63 | 1.00 | — | 1.56 |
| Citation extraction | 0.03 ms | 0.02 | 0.03 | — | 0.39 |

- **Large memory:** a document at the 20k-character pipeline ceiling is
  retrieved in ~28 ms and the excerpt handed to the model is bounded
  (context build 814 chars, excerpt capped at 500) — no unbounded prompt
  growth.
- **Concurrency:** 24 parallel asks complete in 854 ms total (35.6 ms
  per ask), all HTTP 200 — the controller path does not serialise or
  error under concurrent load.
- **Not measured here (require a live provider):** model inference time
  (dominates real ask latency), remote-embedding latency, Postgres FTS /
  cosine cost on a real database.

---

## 6. Embedding-space safety (Phase 3)

- Local vectorizer remains the default and fallback; it is deterministic,
  in-process, no network, no paid service.
- **Space separation is enforced:** every vector row is tagged with an
  `embeddingIdentity` (`mode@model@dim`); `match_memory_vectors` filters
  on model + dim, so stored vectors and query vectors can never mix spaces
  silently. A remote provider returning a different dimension than
  `EMBEDDING_DIM` is **refused** with an actionable error
  (`embedding_dimension_mismatch`) telling the operator to set
  `EMBEDDING_DIM` and reindex — not absorbed.
- **Remote configuration (documented, not measured — no embedding server
  was running here; `localhost:4891` refused):**
  `EMBEDDING_MODE=remote`, `EMBEDDING_MODEL=<name as reported by the
  server>`, `EMBEDDING_DIM=<n>`, then `npm run reindex:vectors` so all
  rows move to the new space together. Never change `EMBEDDING_MODEL`/
  `EMBEDDING_DIM` without reindexing.
- The calibration constants (`VECTOR_MIN_SIMILARITY=0.12`,
  `VECTOR_SIMILARITY_ANCHOR=0.52`, `RETRIEVAL_VECTOR_WEIGHT=0.6`) were
  derived from the synthetic corpus; the code comments and `.env.example`
  both warn they must be re-derived against real archives.

---

## 7. Security, privacy, lifecycle (Phases 4, 6, 7)

**Verified by reading the code and by the 13 end-to-end tests:**
- Every API route is guarded by per-route `requireAuth` (verified by the
  fixed coverage test, not assumed); `/uploads` is a deliberate 403 stub.
- Citations can only come from memories genuinely retrieved for the
  authenticated user (RLS-scoped RPC + citation-id filter measured at 0
  survivors).
- Cross-user isolation in the fake store: 0 foreign ids reached any
  prompt or answer across all 54 questions.
- RLS policies in `sql/memory_intelligence.sql` use invoker security and
  filter on model + dim — sound.

**Prepared but NOT executed (no usable credentials in this
environment):** the live-Supabase isolation suite
(`tests/isolation.test.mjs`). Attempted against the project in
`backend/.env`: the project is reachable and the anon key
authorizes table reads, but email confirmation is enforced
(signup returns no session and the project rate-limits
confirmation emails), no `SUPABASE_SERVICE_ROLE_KEY` is
configured (admin user creation 403s), and Docker is
unavailable (no local stack). Exact setup recipe is in the
test header. RLS is never disabled by these tests. **Live RLS
validation remains an open pre-production step — do not read
the fake-store results as proof against real Postgres.**

**User data deletion ("Forget my data") — IMPLEMENTED and
tested this round.** `DELETE /api/account` (guarded by
`requireAuth`; the UI gates it behind re-auth + a typed
`DELETE` confirmation) now deletes, in dependency order and
with every step checked: `memory_links`, `memory_vectors`,
`memory_settings`, `memories` (and their uploaded files),
`conversations`, and `legacy_grants` (owned **and**
recipient). A database failure aborts with 500 and an
INCOMPLETE message — a partial wipe is never reported as
success; retries are idempotent. Disclosed limitations:
retained auth identity without a service-role key, files that
could not be unlinked, and managed-backup (PITR) retention.
Two RLS policies were missing and added:
`memory_settings_delete_own` and
`legacy_grants_recipient_delete`. Verified by 7 new end-to-end
tests (`tests/accountDeletion.test.mjs`,
`tests/accountDeletionServiceRole.test.mjs`). See §11.

**Findings for the product owner (not changed — product decisions):**
1. `memoryAiEnabled` / `conversationMemoryEnabled` /
   `processingEnabled` all default **true** (opt-out model).
   Changing defaults alters consent behaviour; left as-is and
   reported. A full decision brief with migration/impact
   analysis for each option is in `CONSENT-DECISION.md`.
2. ~~No "forget my data" endpoint exists~~ — **implemented
   this round** (see §11). Remaining owner decisions: whether
   to ship the retained-identity warning as an error or info
   message, and backup-retention disclosure wording.
3. **The local `backend/.env` contains a live Supabase anon key.** It is
   gitignored (verified `git check-ignore`) and was never committed, but
   treat it as exposed to anyone with this checkout; rotate it if the
   checkout left a trusted machine. `.env.example` carries placeholders.

---

## 8. Limitations (honest boundaries of this audit)

1. **No live Supabase** — live RLS/isolation validation is prepared, not
   executed (§7). The fake store mirrors RLS semantics; real Postgres
   behaviour (FTS stemming, `ts_rank`, pgvector cosine) is a proxy.
   Attempt specifics: project reachable, anon key valid, but email
   confirmation + rate limits block automated test signups, no
   service-role key, no Docker for a local stack.
2. **No live model and no embedding server** — grounding prose quality and
   remote-embedding quality are unmeasurable here; the configuration path
   and the reindex procedure are documented (§6), the grounding eval's
   stub measures the contract, not fluency, and the remote-embedding
   comparison refuses to run rather than silently falling back
   (`provider_unreachable`, verified).
3. **Synthetic corpus** — all retrieval/grounding numbers come from an
   invented, adversarial corpus (no real user data). Absolute numbers are
   a lower bound on real-archive behaviour; the *relative* findings
   (hybrid > components; recall ceiling of the local vectorizer; citation
   filter correctness) are the transferable results.
4. **Calibration constants** are corpus-derived and must be re-derived
   against the real archive before production (§6).
5. **Deletion retention limits** (disclosed by the endpoint, not solved
   by it): managed backups (Supabase PITR) retain deleted rows for the
   backup window; upload files that fail to unlink stay on disk
   (unreachable); without `SUPABASE_SERVICE_ROLE_KEY` the auth identity
   is retained; and **two sample upload files
   (`backend/uploads/8cd4d089-….pdf`, `cb12fdb7-….webm`) are tracked
   in git history** — they predate this audit and can only be removed
   by a history rewrite; `backend/.gitignore` now blocks future commits
   to `uploads/`.

---

## 9. Pre-production checklist

1. Apply `backend/sql/memory_intelligence.sql` and
   `backend/sql/security.sql` in the Supabase SQL editor
   (both additive, safe to re-run — includes the two new
   deletion policies `memory_settings_delete_own` and
   `legacy_grants_recipient_delete`).
2. Re-derive `VECTOR_MIN_SIMILARITY` / `VECTOR_SIMILARITY_ANCHOR` /
   `RETRIEVAL_VECTOR_WEIGHT` from the real archive
   (`node eval/runRetrievalEval.mjs` against real data).
3. Decide local vs remote embeddings; if remote, set
   `EMBEDDING_MODE=remote EMBEDDING_MODEL=… EMBEDDING_DIM=…` and run
   `npm run reindex:vectors` (never mix spaces). Compare quality with
   the same eval runner — it goes through the real `embed()`, so the
   remote run uses the remote provider automatically.
4. Run the live isolation suite with real credentials (§7) — the one
   security check this audit could not execute.
5. Serve the local LLM (`llama-server -m model.gguf --port 4891`) and
   re-run `npm run eval:grounding` with a real model to validate prose
   grounding and no-answer honesty.
6. Rotate the Supabase anon key present in the local `backend/.env` if
   that checkout is not fully trusted.
7. Product decisions needed: consent defaults
   (`CONSENT-DECISION.md` — no default was changed); whether to
   configure `SUPABASE_SERVICE_ROLE_KEY` so account deletion can also
   remove the auth identity.
8. Frontend: address the lint advisories (one unused `total` in
   `Dashboard.jsx`; `setState`-in-effect patterns) and consider
   code-splitting the 563 kB bundle.
9. Decide whether the two sample files tracked under
   `backend/uploads/` should be removed from git history (they are
   outside the deletion path).

---

## 10. Modified / added files (original session)

**Modified:** `backend/src/utils/asyncHandler.js`,
`backend/src/routes/memoryLink.routes.js`,
`backend/tests/authCoverage.test.mjs`, `backend/package.json`,
`backend/.env.example`
**Added:** `backend/scripts/reindexVectors.mjs`,
`backend/tests/groundingHarness.mjs`, `backend/tests/grounding.test.mjs`,
`backend/eval/groundingEval.mjs`, `backend/eval/perfEval.mjs`

All other working-tree changes (memory links, settings, pipeline,
retrieval services, frontend pages) predate this session and were audited
as the existing implementation. Nothing is committed; all changes are
uncommitted working-tree modifications.

---

## 11. Privacy completion & real-world validation (this round)

Executed after the original audit, per the Phase 3 requirements.

### 11.1 User data deletion — implemented
`DELETE /api/account` now performs a complete, checked wipe
(§7). New model functions: `removeAllMemoryLinksForUser`,
`removeAllMemoryVectorsForUser`, `removeMemorySettingsForUser`;
`removeAllConversationsForUser` now returns the deleted rows
(`.select('id')`) so counts are real. Two RLS policies added
(`memory_intelligence.sql`, `security.sql`). The controller
deletes children before parents, removes each memory's upload
file immediately after the memory rows are deleted (so a later
step failing cannot orphan files), counts file-removal
failures, audits with counts only (never content), and returns
an honest `deletion: { counts, limitations }` report. The API
contract is unchanged (`success`, `message`); the frontend is
untouched and compatible.

**Tests (all executed):**
- `tests/accountDeletion.test.mjs` — 6 tests: complete wipe
  across all six tables with cross-user isolation; uploaded
  file removed from disk; DB failure → 500 + INCOMPLETE +
  idempotent retry (at both the first step and a later
  step); unremovable files counted and disclosed; empty
  account; audit contains counts only.
- `tests/accountDeletionServiceRole.test.mjs` — 1 test:
  with a service-role key the auth identity is deleted and
  the retention limitation is absent.

### 11.2 Privacy & consent — documented, defaults unchanged
`CONSENT-DECISION.md`: current behavior, server-side
enforcement evidence (grounding tests), UX assessment, and
opt-in/opt-out options with migration and existing-user
impact analysis. **No default was changed** — the decision
belongs to the product owner.

### 11.3 Live Supabase isolation — NOT executed (unverified)
Attempted (§7): project reachable, anon key authorizes
reads, but email confirmation is enforced (signup returns
no session; confirmation emails rate-limited), no
service-role key (admin 403), Docker unavailable. Exact
setup recipe documented in the `isolation.test.mjs` header
(isolated project, schema applied, confirmations off or
service-role key, env vars). Tests remain gated by
`ISOLATION_TEST=1` and skip otherwise.

### 11.4 Real embedding evaluation — NOT executed (unverified)
No embedding server is reachable in this environment
(`localhost:4891` refused; `ECONNREFUSED`). The comparison
mode already exists: `runRetrievalEval.mjs` goes through
the real `embed()`, so
`EMBEDDING_MODE=remote EMBEDDING_MODEL=<model> EMBEDDING_DIM=<dim> LOCAL_AI_BASE_URL=<server> node eval/runRetrievalEval.mjs`
indexes and evaluates the remote provider, and the runner
refuses to start on provider failure rather than silently
falling back (verified: `provider_unreachable`, 502). Local
baseline re-confirmed unchanged (51 memories, 54 questions,
0 leaks).

### 11.5 Final regression (all executed)
- Backend: **188 tests — 183 pass, 0 fail, 5 skipped**
  (live isolation tests, correctly gated).
- `node --check`: all 9 changed files pass.
- Frontend: lint exit 0 (pre-existing warnings only),
  build exit 0 (563.38 kB / 157.38 kB gzip, 1.59 s).
- Secrets: no JWTs or keys in tracked files; the project
  URL appears only in gitignored `.env` files; the
  service-role key appears only as an `.env.example`
  placeholder and obvious test fakes.
- Retrieval eval re-run clean (local mode, 0 cross-user
  leaks).

### 11.6 Modified / added files (this round)
**Modified:** `backend/src/controllers/account.controller.js`,
`backend/src/models/memory.model.js`,
`backend/src/models/memoryLink.model.js`,
`backend/src/models/settings.model.js`,
`backend/src/models/conversation.model.js`,
`backend/sql/memory_intelligence.sql`,
`backend/sql/security.sql`,
`backend/tests/groundingHarness.mjs`,
`backend/tests/isolation.test.mjs`,
`backend/.gitignore`,
`AUDIT.md`
**Added:** `backend/tests/accountDeletion.test.mjs`,
`backend/tests/accountDeletionServiceRole.test.mjs`,
`CONSENT-DECISION.md`

---

## 12. Production deployment & final verification (this round)

Full detail in **`DEPLOYMENT.md`**. Summary:

- **Infrastructure smoke test (new, `npm run smoke`):**
  18/18 checks pass — server boots against the live
  project, `/api/health` 200, Helmet headers present, 401
  on all six protected routes (missing and garbage token,
  correct HTTP methods), `/uploads` blocked (403), CORS
  refuses unconfigured origins (403, no ACAO) and allows
  configured ones (204). The authenticated workflow is
  skipped without `API_TOKEN`.
- **Live isolation suite (`npm run test:isolation:live`,
  new):** **executed, 5/5 fail at the setup hook** —
  `Signup did not return a session (email confirmation
  required?)`. The configured project enforces email
  confirmation and rate-limits confirmation emails, so the
  suite cannot create two instantly-authenticated test
  accounts; no service-role key (admin 403) and no Docker
  (no local stack). Recorded honestly as an environment
  limitation, NOT a pass. Exact isolated-project recipe is
  in the `tests/isolation.test.mjs` header.
- **Remote embedding eval:** not executable — no embedding
  server (`localhost:4891` refused). The remote path fails
  loudly (`provider_unreachable`, 502) rather than silently
  falling back. Local baseline re-confirmed: hybrid
  hit@5=81.4%, top1=53.5%, recall@5=0.757, MRR=0.644,
  0 leaks on all three strategies.
- **Migration review:** both `security.sql` and
  `memory_intelligence.sql` are idempotent, additive and
  order-tolerant; every table has select/insert/update/delete
  `_own` RLS policies; `match_memory_vectors` is
  invoker-security and filters on dim + embedding-space
  model. Rollback is NOT data-safe (dropping the new
  tables/columns destroys derived data); full reversal
  requires a pre-migration backup.
- **Production config gaps found (fix before production):**
  `SIGNED_URL_SECRET` unset (falls back to the anon key),
  `LEGACY_VERIFICATION=none`, no `SCAN_COMMAND` (uploads
  unscanned), no `SUPABASE_SERVICE_ROLE_KEY` (auth identity
  not deleted on account deletion). The server fails fast
  on missing required env and refuses a non-localhost LLM.
- **Final regression:** backend 188/183/0/5; frontend lint
  and build exit 0; import checks pass; retrieval eval
  0 leaks; secrets scan clean.
- **Files added this round:**
  `backend/scripts/smokeTest.mjs`,
  `backend/scripts/runIsolationLive.mjs`,
  `DEPLOYMENT.md`; **modified:** `backend/package.json`
  (new `smoke` / `test:isolation:live` scripts).

**Blocking before production:** the live isolation suite
must pass on an isolated project (§4 of DEPLOYMENT.md) and
`SIGNED_URL_SECRET` must be set to a dedicated secret.

## 13. Phase 9 — Final production readiness (this round)

**Scope:** resolve the remaining configuration and
verification blockers; preserve all verified functionality.
No production deployment, no consent-default change, no
credential rotation, no destructive operations.

**Configuration hardening (implemented + tested):**
- **`SIGNED_URL_SECRET`** — production now **fails fast**
  (exit 1) unless a dedicated secret (≥ 32 chars, not the
  anon key) is set; the anon-key fallback remains only in
  development (warned). Verified at runtime: production +
  anon-key fallback ⇒ exit 1 (FATAL, no secret value
  leaked); production + strong secret ⇒ reaches listening.
- **`LEGACY_VERIFICATION`** — default changed from `none`
  (single factor) to **`access-code`** (two factors,
  matching the frontend, which labels the code
  "recommended"). `none` is warned at startup. Existing
  grants are never silently altered: a grant created
  without a code fails closed (explicit 403) under
  `access-code` until the owner re-creates it with one.
- **Upload scanning** — production (or
  `REQUIRE_UPLOAD_SCAN=true`) now **rejects** uploads when
  no working scanner is configured (fail closed — an
  unscanned upload is never treated as clean), and the gap
  is surfaced at startup. Development/test skip the scan
  (audited) so the upload flow stays usable. A configured
  scanner that finds a threat OR fails to run also rejects
  (unchanged).
- **`SUPABASE_SERVICE_ROLE_KEY`** — kept optional and
  backend-only; its absence is disclosed (data is still
  wiped; the auth identity must be deleted manually).

**Defect fixed:** `scripts/smokeTest.mjs`'s HTTP helper
silently dropped request `body`s, so every POST/PATCH
(settings toggle, create, ask) sent nothing. Now forwards
the body. The authenticated section is now the full core
memory lifecycle (create → retrieve → search → grounded
ask → consent-off ⇒ zero citations → cross-user RLS →
delete → verify gone) with `finally`-block cleanup.

**New tests (all executed, all pass):**
- `tests/configValidation.test.mjs` — 11 tests
  (production secret validation, dev fallback, upload-scan
  fail-closed paths, `access-code` default).
- `tests/lifecycle.test.mjs` — 11 subtests driving the real
  controllers through the RLS-correct harness, validating
  the exact response shapes the smoke test parses.

**Commands executed:**
`configValidation` 11/11; `lifecycle` 11/11; `npm test`
**210 — 205 pass, 0 fail, 5 skipped** (was 188/183/0/5);
`npm run smoke` 18/0/1; frontend lint and build exit 0;
`node --check` on all 7 changed files pass; secrets scan
clean.

**Not executed (honestly reported, not passed):**
authenticated staging smoke (no `API_TOKEN`); live
Supabase isolation (no isolated project — fails at its
setup hook, 5/5, an environment limitation); remote
embedding eval (no provider). Retrieval eval is unchanged
(Phase 9 did not touch retrieval): hybrid hit@5=81.4%,
top1=53.5%, recall@5=0.757, MRR=0.644, 0 leaks.

**Release recommendation:** **Ready for staging** — local
verification is complete and green, but live isolation and
the authenticated staging workflow (isolated project +
`API_TOKEN` + running LLM) remain and are **blocking** for
production. See DEPLOYMENT.md §13 for the full report and
remaining owner actions.
