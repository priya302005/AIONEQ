# EchoMind Consent Model — Product-Owner Decision Brief

**Status: DECISION REQUIRED FROM PRODUCT OWNER.**
No default was changed by this audit. The current behavior below is
unchanged and fully functional; this document prepares the decision
the task requires rather than silently changing consent behavior.

## 1. Current behavior (as shipped)

Three per-user switches, stored in `memory_settings` (one row per
user, `user_id` primary key), exposed at `GET/PATCH /api/memory-settings`
and in the app's Security Settings page:

| Setting | Default | What it controls |
|---|---|---|
| `memoryAiEnabled` | `true` (opt-out) | Whether the assistant may read the user's memory archive at all (keyword + vector retrieval) when answering questions |
| `conversationMemoryEnabled` | `true` (opt-out) | Whether previous conversations (and earlier turns of the current thread) may be used as answer context |
| `processingEnabled` | `true` (opt-out) | Whether transcription / text-extraction / AI summarization may run on uploads |

All three default to **enabled** — an **opt-out** model. A user who
never opens Security Settings has full memory AI active from the first
upload.

**Enforcement is server-side, not UI-only.** The Ask controller reads
the settings on every question and branches:

- `memoryAiEnabled = false` → the memories table and the
  `match_memory_vectors` RPC are **never queried**; the model answers
  from general knowledge only; no citations are returned.
  (Verified: `tests/grounding.test.mjs` — "memory use disabled means
  the archive is never queried": 0 memory queries, 0 vector RPCs,
  0 cited memories.)
- `conversationMemoryEnabled = false` → the conversations table is
  **never read for context**, including the current thread's earlier
  turns. The chat still works and still persists each turn (that is
  the chat feature's own storage), but every turn is answered fresh —
  multi-turn continuity is deliberately lost. This is the privacy-
  conservative reading of the switch and should stay as-is.
  (Verified: "conversation memory disabled means previous
  conversations are never read": 0 conversation SELECTs.)
- `processingEnabled = false` → uploads are stored but the
  understanding pipeline does not run; no summary/topics/embedding is
  derived.

Settings rows are deleted by account deletion
(`DELETE /api/account`), so consent state does not outlive the user.

## 2. UX assessment

- The switches live in Security Settings, are worded in plain
  language, and take effect immediately on the next question.
- **Gap:** nothing in the signup or first-upload flow tells a user
  that memories are analyzed and used for AI answers by default.
  The first a user hears of it is if they find the settings page.
  Under an opt-out model that is the main UX risk.
- The three switches are independent and correctly granular: a user
  can keep notes but block conversation context, or store without
  AI processing.

## 3. The decision

**Which default consent model should new (and existing) users have?**

### Option A — Keep opt-out (status quo)
- Defaults stay `true`.
- Migration: none.
- Impact on existing users: none.
- Cost: users who never visit Security Settings are opted into AI
  memory use. Mitigation: add a first-run notice (product change,
  not a default change).

### Option B — Switch to opt-in (privacy by default)
- Defaults become `false` for **new** users.
- Migration for existing users is a separate, explicit choice:
  - B1 — grandfather existing users at `true` (their current rows
    already exist; only the no-row default changes). Existing users
    keep today's behavior; new users must opt in.
  - B2 — flip existing users to `false` via a one-off migration
    (`update memory_settings set ... where ...` / insert `false`
    rows). **This silently withdraws a feature users relied on** —
    their next question answers from general knowledge, citations
    and memory recall stop — until they re-enable. That is a
    visible, disruptive change and needs release notes plus an
    in-app prompt.
- Retention question the owner must also answer: already-processed
  data (embeddings, summaries, transcripts) may remain stored even
  when the switches are off. Opt-in should be paired with a
  "delete my derived data" action (today: delete the memory, or
  delete the account).

### Option C — Granular defaults (e.g. processing on, conversation memory off)
- Possible, but mixes two different risk classes (storage vs.
  cross-context retrieval) and is harder to explain. Not recommended
  unless the owner specifically wants that split.

## 4. Recommendation

If the owner wants minimal change: **Option A + a first-run notice**.
If the owner wants privacy-by-default: **Option B1** (new users
opt-in, existing users grandfathered) — it changes consent behavior
only for users who have not made a choice yet, and never silently
withdraws a feature from someone using it. **Option B2 should not be
done without explicit release communication.**

Whichever is chosen, the implementation is one line per default in
`backend/src/models/settings.model.js` (`DEFAULT_SETTINGS`) plus the
migration note above — no other code changes, because enforcement is
already server-side and setting-driven.

**This audit changed no default.** The choice above is the product
owner's to make; the code is ready for any of the options.
