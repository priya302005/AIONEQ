# AI Model Integration — Implementation Report (Phase 10)

**Date:** 2026-10-04
**Scope:** one place that decides how the model is called, and one
rule set that decides whether an answer is allowed to claim
anything.
**Status:** implemented, tested, evaluated under a deterministic
stub. **Live model quality is NOT MEASURED** — no provider was
reachable. See §6.

---

## 1. What changed

### 1.1 One client for all model traffic

`backend/src/utils/llmClient.js` is now the only module that
speaks HTTP to the model.

- **Configurable sampling** — temperature, top-p, repeat
  penalty, max tokens, timeout and retries all come from config,
  overridable per call.
- **Retries for transient failures only** — 429 and 5xx are
  retried; 4xx is not (retrying a bad request just wastes the
  user's time).
- **`Retry-After` is honoured but bounded** — a provider asking
  for 30s cannot make a request hang; the wait is capped.
- **Explicit error taxonomy** — `provider_rate_limited`,
  `provider_http_error`, `provider_bad_response`,
  `provider_timeout`, `provider_unreachable`. Each maps to one
  HTTP status and one actionable client message.
- **Envelope validation** — a 200 that is not a completion is an
  error, never an empty answer.
- **Usage surfaced** — `completeResult()` returns text, usage
  counts and finish reason; `providerDescriptor()` returns
  provider coordinates **without** the URL.
- **Backward compatible** — `complete()`, `chatCompletion()`
  and `textCompletion()` still return plain strings, so no
  caller changed contract.

The two wire protocols are preserved exactly:

| mode | endpoint | used for |
|---|---|---|
| `LOCAL_AI_COMPACT_PROMPT=true` | `/v1/completions` | answers (template-less tiny models break on ChatML tokens) |
| otherwise | `/v1/chat/completions` | everything else |

### 1.2 One place that decides parameters

`backend/src/services/inferenceService.js` wraps the client with
per-task profiles. Each profile carries the values the old
call sites had hard-coded, so behaviour is preserved while
becoming a readable table:

| task | maxTokens | temperature | timeout | retries |
|---|---|---|---|---|
| `memory_analysis` | 320 | 0.2 | 15 000 ms | 1 |
| `memory_summary` | 160 | 0.3 | 10 000 ms | 1 |
| `question_answer` | 700 | 0.5 | 20 000 ms | 1 |
| `personalization` | 120 | 0.6 | 10 000 ms | 1 |
| `memory_relation` | 8 | 0 | 10 000 ms | 0 |

An explicit per-call parameter beats the profile; global config
fills the gaps; an unknown task falls back to the answer profile
rather than throwing.

Every call emits an `ai.inference` metric:

```
task, provider, modelFamily, status, errorCode, attempts,
durationMs, promptTokens, completionTokens
```

**No prompt text, no answer text, no memory text, no URL.** A
test asserts this rather than trusting review.

### 1.3 Claim grounding — the part that decides what may be said

`backend/src/services/claimGrounding.js` applies three rules to
answers built from memory:

- **R1 — citation validity.** A citation to an id that was not
  supplied for this request is deleted from the text and never
  returned. Replaced per match by id, so a removed marker can
  never shift onto a neighbouring valid one.
- **R2 — cited text is kept.** A sentence with a surviving
  citation stays, *including a paraphrase of its own source*.
  The deliberate trade-off: a citation is treated as the
  model's assertion of support. Deleting on weak lexical
  agreement would silently remove **correct** answers. Instead
  the mismatch is counted as a **weak attribution** and
  reported, so the rate is visible instead of hidden.
- **R3 — uncited assertions need evidence.** A sentence with no
  citation must share lexical evidence with the excerpts that
  were actually supplied. Conversational lines, short lines and
  honest "not found" answers are never removed; only a genuine
  assertion with nothing in common is.

Two structural rules that matter as much as R1–R3:

- **A citation marker ends the unit it belongs to.** Without
  this, several quoted excerpts run together by the model
  produce one fragment containing a valid citation, and an
  uncited fabrication rides along on its authority. Found by
  the new evaluation, then closed, with a regression test.
- **A fully filtered answer becomes an honest sentence**, never
  an empty bubble and never a partial answer that reads as
  complete.

**Deliberately not grounded:** when the user disables memory use,
the answer is general knowledge and has no excerpts to be
grounded against. Filtering it would be theatre.

Audit entry `query.grounding_adjusted` records counts only:
invalid citations, removed claims, cited claims, weak
attributions.

### 1.4 Production cannot serve an ungrounded answer

`AI_CLAIM_GROUNDING=false` exists so the evaluation can measure
the ungrounded rate. `backend/src/config/startup.js` **refuses
to start in production** with that combination. The switch is a
measurement instrument, not a feature toggle. Verified at
runtime in `tests/configValidation.test.mjs`.

### 1.5 Prompt chronology, corrections, and analysis reuse

- **Oldest first.** Memories are presented in chronological
  order with corrections labelled as current, so a small model
  applies the latest state instead of the first thing it reads.
  The previous ordering was not obviously wrong — the point is
  that nothing signalled recency to the model at all.
- **`analysis_hash`.** SHA-256 of the derived-analysis inputs
  lets an unchanged memory skip re-analysis. Two deliberate
  exceptions: an **explicit user request to reprocess always
  re-runs** (the user's intent beats the cache), and a
  **failed analysis is never fingerprinted**, so a provider
  outage cannot poison the archive into "already analysed".

---

## 2. Configuration

| variable | default | effect |
|---|---|---|
| `AI_TEMPERATURE` | 0.5 | global sampling default |
| `AI_TOP_P` | prior value | global sampling default |
| `AI_REPEAT_PENALTY` | prior value | global sampling default |
| `AI_MAX_TOKENS` | 700 | global token ceiling |
| `AI_CONTEXT_MAX_CHARS` | 6000 | prompt-size budget |
| `AI_TIMEOUT_MS` | 20000 | per-request timeout |
| `AI_RETRIES` | 1 | `0` is valid |
| `AI_CLAIM_GROUNDING` | `true` | `false` allowed **only** outside production |

`LOCAL_AI_COMPACT_PROMPT` and the 384-dimensional hashed
vectorizer are unchanged.

---

## 3. Verification

### 3.1 Tests

`npm test` → **258 tests, 253 pass, 0 fail, 5 skipped**
(was 255/250/0/5 before this round).

New: `tests/aiInference.test.mjs` (28 tests) covering the task
profiles, both wire endpoints, retries, bounded `Retry-After`,
timeout, malformed responses, an unreachable provider, the
content-free metric, and every grounding rule including the
citation-boundary regression. Plus additions to
`tests/grounding.test.mjs` (flag gating on both ask paths),
`tests/memoryContext.test.mjs` (chronology, corrections) and
`tests/pipeline.test.mjs` (analysis-reuse decisions).

### 3.2 Grounding A/B — `npm run eval:ai` (new)

Same corpus, same deterministic stub, layer on vs off:

| | unsupported questions | unsupported sentences | fabricated ids |
|---|---|---|---|
| `AI_CLAIM_GROUNDING=on` | **0 / 54** | **0** | 0 |
| `AI_CLAIM_GROUNDING=off` | 51 / 54 | 145 | 0 |
| prevented by the layer | 51 | 145 | 0 |

Fabricated **ids** are 0 in both arms: the pre-existing id
filter already removed those. The layer's contribution is
entirely on **content** — the honest reading, not a flattering
one.

Prompt budget: min 2 876 / p50 4 153 / p95 4 755 / max 4 904
chars against the 6 000 limit, **0** over limit; 0–8 memories
per question against the cap of 8.

Fault matrix, all measured:

| injected fault | code | HTTP | attempts |
|---|---|---|---|
| healthy | — | — | 1 |
| 429 | `provider_rate_limited` | 503 | 2 |
| 500 | `provider_http_error` | 500 | 2 |
| 400 | `provider_http_error` | 400 | 1 (no retry) |
| 200 that is not a completion | `provider_bad_response` | 502 | 1 |
| slow model | `provider_timeout` | 504 | 1 |
| nothing listening | `provider_unreachable` | 502 | 0 |

### 3.3 Existing baselines — unchanged

`npm run eval:grounding`: 54 questions, 42 cited model calls,
**0** hallucinated ids survived, **0/54** unsupported claims,
0 unsupported sentences, 0/51 stub probes survived, 13/43
answerable questions missing a gold memory, 0/11 unsupported
no-answer responses.

`npm run eval` (retrieval): hybrid hit@5 **81.4%**, top1
**53.5%**, recall@5 **0.757**, MRR **0.644**, **0**
cross-user leaks. Phase 10 did not touch retrieval.

### 3.4 Two measurement defects found and fixed

Both had been producing flattering numbers, which is why they
are reported rather than quietly corrected:

1. **Wrong set measured.** The grounding eval compared
   citations and gold memories against the response body's
   `usedMemories` — a **UI-sized preview**, not everything
   retrieved. Anything beyond the preview counted as a miss, and
   an honest citation to one counted as fabricated (41
   "hallucinated ids survived"). Now measured against the ids
   actually supplied to the model. Missing-gold fell 16/43 →
   13/43 as a consequence.
2. **Grader graded coarser units than the layer decides on**, so
   an uncited fragment could pass on vocabulary that only a
   cited neighbour supplied. Both now split on the same
   boundaries. The harness stub also no longer truncates quotes
   mid-word (`the old o`) — an artefact of the clipper, not
   model behaviour.

Both evaluations now carry a **self-test**: it asserts the
grader flags a known-unsupported sentence, accepts a cited one,
and rejects a fabricated id. A clean report from a broken
grader is no longer possible.

---

## 4. What a user can notice

1. A citation to something not retrieved is gone. Correct
   behaviour; previously it could be displayed.
2. An uncited sentence with no support in their own memories is
   gone. This is the intended trade — fewer wrong claims, and a
   small risk of losing a true one.
3. If everything is filtered, they read an honest sentence
   instead of an empty bubble.
4. Provider problems produce a specific, actionable message
   (503 / 502 / 504) instead of a generic failure.

---

## 5. Known limitations

- **No live model was measured.** Nothing here establishes that
  a 3B model reads these prompts well, or that its answers
  survive R2/R3 intact. That requires a running provider.
- **R2 over-trusts cited text.** A cited sentence that is still
  unsupported stays. The rate is measured as weak attribution,
  not enforced away.
- **R3 is lexical, not semantic.** A true paraphrase using
  unusual vocabulary can be removed. Conversely, a fabrication
  reusing archive vocabulary can survive.
- **The grounding eval's stub is not a model.** It quotes
  excerpts and fabrications on cue; a real model's failure modes
  are broader and less tidy.
- **Live Supabase isolation and the authenticated staging
  workflow remain unverified** and blocking for production.
- `npm audit` reports 2 moderate-severity advisories; no forced
  or breaking upgrade was attempted.
- `package-lock.json` was rewritten by `npm install`, pinning
  the nine top-level ranges to the already-installed versions.
  No resolved package version changed.

---

## 6. How to obtain the missing measurements

```bash
cd backend
# 1. start the model on LOCAL_AI_BASE_URL (default http://localhost:4891)
# 2. then:
npm run eval:ai
```

The live section reports `NOT MEASURED` until a provider
answers, and prints real latency, token usage and finish
reasons once one does. The report deliberately never presents
stub numbers as model numbers.

---

## 7. Files

Added:
- `backend/src/services/inferenceService.js`
- `backend/src/services/claimGrounding.js`
- `backend/tests/aiInference.test.mjs`
- `backend/eval/aiModelEval.mjs` (`npm run eval:ai`)

Changed:
- `backend/src/utils/llmClient.js`, `src/config/config.js`,
  `src/config/startup.js`, `src/controllers/query.controller.js`
- `src/services/memoryContext.js`, `memoryPipeline.js`,
  `memoryIngestion.js`, `memoryLinks.js`
- `src/models/memory.model.js`, `sql/memories.sql`
- `.env.example`, `package.json`, `eval/groundingEval.mjs`
- `tests/grounding.test.mjs`, `memoryContext.test.mjs`,
  `pipeline.test.mjs`, `configValidation.test.mjs`
- `AUDIT.md` §14, `DEPLOYMENT.md` §14

Deployment step: apply the `analysis_hash` migration in
`backend/sql/memories.sql` before deploying. See
`DEPLOYMENT.md` §14.1.