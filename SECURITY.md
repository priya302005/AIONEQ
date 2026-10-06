# EchoMind Security

Security hardening applied to the EchoMind backend (Express + Supabase) and
frontend (React + Vite), guided by the project's shared security ideology:
**zero trust, least privilege, fail closed, data minimization, auditability,
and no obscurity.**

Every item below says what changed, what is intentionally *not* implemented,
and the tradeoffs — security through clarity, not secrecy.

---

## Threat model (in short)

EchoMind stores a user's private memories, voice notes, documents, and chat
history, plus "legacy" data intended to be read by designated people after the
owner is gone. The most sensitive assets are conversational content and
uploaded files. The highest-risk flows are authentication, file upload/serving,
asking the AI (prompt injection / data exfiltration), and data export.

---

## Backend

### Authentication & session hardening
**Changed**
- All auth request bodies are validated with **zod** (`email`, `password`
  shape/length). Malformed payloads are rejected before touching the DB.
- **Per-IP rate limiting** on auth routes (5 req/min). Login failures are
  additionally throttled by an **in-memory exponential backoff lockout**
  (default: 5 attempts → escalating lockout).
- **Enumeration-safe responses**: login/signup/reset return the same generic
  message regardless of whether the account exists or the password is wrong.
- **Password change invalidates all sessions** via
  `supabase.auth.signOut({ scope: 'global' })`.
- Dedicated **logout** endpoint; `signOut()` is called with the user's token.

**Flagged / not implemented**
- Lockout state lives in memory and resets on server restart (acceptable for a
  single-instance deployment; for multi-instance you need Redis or a DB table).
- No server-side **AAL (assurance level) enforcement** for MFA — Supabase is
  configured for MFA, and the frontend blocks entry until the second factor
  verifies, but the backend does not yet reject aal1 sessions on sensitive
  routes. Implement by checking `auth.uid()`, `auth.jwt()->>'aal'` in RLS and
  rejecting `aal1` where required.
- Refresh tokens are still non-`httpOnly` cookies (via `@supabase/ssr` +
  `@supabase/supabase-js`'s cookie adapter). XSS-safe React practice plus CSP
  mitigate, but a future upgrade should set `httpOnly` + `SameSite=Strict`
  refresh cookies with `@supabase/ssr`.

### File upload, storage, and serving
**Changed**
- Uploads are validated by **content sniffing (magic bytes)**, not just file
  extension — a `.png` renamed `.pdf` is rejected; allowed types are
  audio (`mp3/wav/m4a/aac/ogg/webm/oga`) and documents
  (`pdf/doc/docx/xls/xlsx/rtf/txt/md/csv`).
- **Storage quota per user** (default 500 MB) enforced at upload time.
- `MAX_FILE_SIZE_MB` (default 25 MB) enforced at upload.
- Files are saved under a non-guessable `crypto.randomUUID()` name; the
  original filename is discarded (data minimization — original names can leak
  info; the display name is the memory title).
- **The public `/uploads` static route is removed.** Files are only served
  through `GET /api/files/:token` with a **short-lived HMAC-signed URL**
  (default TTL 300 s) issued by `GET /api/memories/:id/signed-url`.
  - The token binds `(memoryId, userId, expiry)` and is verified **before** any
    DB work.
  - Ownership is re-verified per request via a narrow `SECURITY DEFINER` SQL
    function (`get_file_url_for_owner`) that returns the file path only when
    the user actually owns the memory. The token itself is the credential, so
    `<audio>`/`<a>` tags work without an Authorization header.
  - Responses set `X-Content-Type-Options: nosniff`, `Cache-Control:
    private, no-store`.
- Signed-URL issuance is denied (and audited) for non-owners, except active
  legacy recipients holding a **full** grant.

**Flagged / not implemented**
- **Malware scanning is a stub**: set `SCAN_COMMAND` to a CLI that reads the
  file path on stdin and exits non-zero on detection; if `SCAN_COMMAND` is
  configured, the server **fails closed** (uploads/re-downloads blocked) when
  the scanner errors. No scanner ships with the repo.
- **EXIF / metadata stripping** is not implemented. Files are stored as
  uploaded; an image/document can carry GPS or author metadata. Future: route
  uploads through `exiftool`/`mogrify` before storage.
- Quota counts in-flight bytes only (uploaded + existing pegged at file size;
  edits do not re-charge quota) — see `memory.controller.js`.

### Prompt injection & LLM ask route
**Changed**
- `GET /api/memories/:id` returns a **sanitized view** (no raw `content`).
- The ask route limits question length (1500 chars), trims, and **suffixes the
  context with an explicit anti-exfiltration delimiter** so the model does not
  echo back raw memory text.
- A **prompt-injection heuristic screen** flags phrases like *"ignore previous
  instructions"* in conversation content and attaches a warning to the context
  (the screening result is validated by unit tests).
- Per-user rate limit on the ask route (10 req/min).

**Flagged / not implemented**
- Heuristic screening is not a defense against adversarial injection — a
  determined attacker with write access to conversation content can still try.
  The real mitigations are: RLS (only the user sees their own memories), the
  sanitized views, and the delimiter. Consider instruction-trained models +
  output filtering for stronger guarantees.

### Data export
**Changed**
- Export is now a **POST** endpoint (server-side side effect), rate limited
  (4/hour per user).
- The ZIP is built with `archiver` and streamed straight to the response
  (no full-disk staging); includes memories (meta + text), conversations, and
  uploaded files.
- The achievement/subtask/`exists` paths no longer allow directory traversal
  (basename check against the model rows, never user-supplied paths).

### Account deletion
**Changed**
- `DELETE /api/account` deletes memories and their files from disk,
  conversations, legacy grants, and user profile rows — all through RLS-scoped
  writes.

**Flagged / not implemented**
- Without `SUPABASE_SERVICE_ROLE_KEY`, the Supabase **auth identity itself
  cannot be removed** (that requires `auth.admin.deleteUser` with the service
  role). With the key set, `deleteUser` is called after data removal. Until
  then, a deleted user's Supabase Auth row remains (blocked from RLS reads,
  but the account name may still exist in Supabase's auth schema). Documented
  here and in `backend/.env.example`.

### Server & middleware
**Changed**
- `helmet` with a strict CSP (self + Supabase + Google Fonts; no inline
  scripts, `object-src 'none'`, `frame-ancestors 'none'`).
- CORS locked to `CORS_ORIGIN` (no `*`).
- Request-scoped `X-Request-Id` header + HTTP audit logging (`AUDIT_*` envs).
- Startup fails fast when required env vars are missing (fail closed).
- Server binds `127.0.0.1` by default (`HOST`); `TRUST_PROXY` opts into
  proxy-aware IPs.
- Central error handler returns generic messages, never stack traces.
- `GET /actuator/health` deliberately unused; health is at `GET /api/health`
  (no server internals leaked).

### SQL (`backend/sql/security.sql`)
**Changed** — run in your Supabase project
- `legacy_grants` table (owner, recipient email/uuid, grant type
  `full`/`text`, status lifecycle, hashed claim token + access-code hash).
- **RLS enabled** with `owner_crud` policies on memories/conversations/grants.
- `memories_select_legacy` / `conversations_select_legacy`: a recipient with an
  **active** grant can SELECT the owner's rows (nothing else).
- `get_file_url_for_owner(uuid, uuid)` SECURITY DEFINER helper for the signed
  file route (returns a file path only for an owning pair — inputs are
  HMAC-verified server-side).
- `file_size` column enforcement; owner can update `profile` but only reads
  their own memory/conversation/lesson rows.
- `revoke all ... from public` hygiene on the helper function with explicit
  grants to `anon`, `authenticated`, `service_role`.

---

## Frontend

### Session & auth
**Changed**
- Session storage moved **out of `localStorage`** into a memory store + a
  `SameSite=Strict` (non-httpOnly) **refresh-token cookie** over HTTPS
  (`src/supabaseClient.js`). `localStorage` is visible to any same-origin XSS;
  the cookie approach shrinks that surface.
- `getSession()` (dangerously non-validating) is no longer trusted: `RequireAuth`
  and `auth.jsx` call `supabase.auth.getUser()`, which validates the JWT, and
  **fail closed** (redirect to login) on any error.
- **Idle session timeout**: `useSessionTimeout` signs the user out after
  `VITE_SESSION_TTL_MINUTES` (default 30) of inactivity.
- **Re-auth gate**: sensitive actions (export, grant creation, account
  deletion) require the password again via `ReauthModal`.
- **Typed confirmations** for destructive actions (`TypedConfirmModal`) —
  clicking "delete" is not enough; you must type `DELETE`.

### MFA
**Changed**
- Login shows a **TOTP second-factor step** when the backend reports
  `mfaRequired`; the app only proceeds after `mfa.verify` succeeds.
- `SecuritySettings` page: enroll/verify/remove a TOTP factor, with a friendly
  message when the Supabase project hasn't enabled MFA yet.

**Flagged / not implemented**
- If MFA is not configured on the Supabase project, enrollment surfaces an
  actionable error (no silent degradation). The backend additionally does not
  yet enforce AAL — see the backend notes.

### Files & uploads
**Changed**
- The frontend **never constructs storage URLs**. All file access goes through
  the signed `/api/files/:token` endpoint obtained from the authenticated
  `signed-url` route (`useSignedFileUrl` hook, cached per memory).
- `VoiceRecorder` previews revoke their `blob:` object URLs on unmount;
  `SecuritySettings`' export download revokes its `blob:` URL after saving.
- `UploadForm` does client-side size/type gating (UX only — the backend
  re-validates magic bytes + quota).

### CSP & output safety
**Changed**
- Strict **CSP meta tag** in `index.html` (self + Google Fonts + Supabase;
  `script-src 'self'`; `object-src 'none'`; base-uri/frame-src/form-action
  locked; `blob:`/`data:` only where needed for media/export).
- Deviations: `style-src 'unsafe-inline'` (React renders inline `style=`
  attributes; no way around without a CSS-in-JS extraction step). Dev mode
  re-adds `'unsafe-inline'`/`'unsafe-eval'` to `script-src` only for the Vite
  react-refresh preamble (`vite.config.js`); production keeps `script-src
  'self'`.
- No `dangerouslySetInnerHTML` anywhere — React escapes by default, so
  **DOMPurify was deliberately not added** (no HTML rendering path exists).

### Legacy access UI
**Changed**
- Full visible management page at `/dashboard/legacy-access`:
  - **Owner**: create grants (recipient email, optional shared access code,
    `full`/`text` scope), see status, **one-click revoke** (typed-confirmed),
    and copy the one-time claim token (shown exactly once).
  - **Recipient**: claim pending grants issued to their email (token +
    access code), browse archives they can read, and open owned memories
    (RLS-enforced; files only for `full` grants).

**Flagged / not implemented**
- Grants currently designate an *email*; "inactive" (time-delayed) grants and
  inbox-based claim-by-link with auto-revocation are future work.
- Grant claims are reversible only by revoke (no "permanent consume" toggle).

---

## Repository hygiene
- **Pinned exact versions** in both `package.json` files (no floating
  `^`/`~` ranges) + `package-lock.json` committed.
- **`npm audit`**: backend now reports **0 vulnerabilities** (3 moderate `qs`
  issues fixed by updating `express` → 4.22.3 / `body-parser` 1.20.8).
  Frontend reports 0 vulnerabilities.
- **Dependabot** configured (`.github/dependabot.yml`) for weekly npm updates
  on both workspaces.
- Test scripts accept a directory arg on Windows (`node --test tests/*.test.mjs`).

---

## Running the required SQL

`backend/sql/security.sql` must be applied in your Supabase project (SQL
editor) before legacy grants or RLS protection are active. The signed-file
route depends on `get_file_url_for_owner` — until it's created, file serving
returns 404 by design. Review the policies before applying; they are the
enforcement layer for "recipients read only granted data."

---

## Reporting a vulnerability

Open an issue in this repository. Please do **not** open a public issue for
exploitable details involving live user data; email the maintainer directly
(first, confirm via a test account).

---

## Verification

- Backend: `cd backend && npm test` (16 unit tests pass; 3 isolation tests
  require `ISOLATION_TEST=1` + real Supabase credentials).
- Backend boot: `npm run dev` → serves Helmet CSP + X-Request-Id on
  `GET /api/health`.
- Live auth check (found + fixed during verification): every authenticated
  request 500'd until a runtime defect in `auth.middleware.js` was removed —
  `req.ip` is a getter-only accessor in Express, so the previous
  `req.ip = req.ip || ...` assignment threw in strict-mode ESM *after* a token
  validated. `requireAuth` now only reads `req.ip` (Express always computes it
  from the socket, or `X-Forwarded-For` when `TRUST_PROXY` is set).
- Frontend: `cd echo-mind && npm run build` (production build includes the CSP
  meta tag and passes the strict `script-src 'self'` self-check).