# EchoMind — AI Model Implementation & RAG Integration Report

**Phase 10.** Status: **the personalized AI model layer and RAG pipeline were
already implemented and are preserved.** This phase inspected the existing
architecture, verified it end to end, executed the retrieval evaluation against
the real production retrieval code, confirmed the baseline, and fixed one
error-clarity defect. No second pipeline was introduced and no verified
retrieval/security component was replaced.

---

## 1. Existing architecture discovered

The AI/RAG stack is complete and modular (model code is separate from
retrieval and business logic, so the provider can be changed through
configuration alone):

| Layer | File | Responsibility |
|---|---|---|
| Unified inference | `src/utils/llmClient.js` | The only place that knows the wire format. Chat (`/v1/chat/completions`), raw completion (`/v1/completions`), embeddings (`/v1/embeddings`), audio transcription. Typed `ProviderError` (`provider_unreachable`, `provider_http_error`, `provider_bad_response`, `embedding_dimension_mismatch`). Per-call timeout, bounded retry (5xx/429 only), never throws raw network errors into controllers. |
| Embeddings | `src/utils/embeddings.js` | Local deterministic hashed vectorizer (default, in-process, no network, no deps) and remote mode. 384 dimensions. |
| Hybrid retrieval | `src/services/memoryRetrieval.js` | Vector similarity + Postgres full-text + lexical, blended on one 0..1 scale, relevance floor, near-duplicate removal, context budget, chronology, explicit owner check on every row. |
| Context + prompts | `src/services/memoryContext.js` | `buildContext` (compact, labelled, fenced memory blocks) + `buildSystemPrompt` (rules only — no user content in the system prompt) + `extractCitedIds` (citation boundary) + `splitFollowUps` + `formatLinks` (evolution/supersession timeline). |
| Prompt safety | `src/utils/promptSafety.js` | Injection-marker detection, audit-logged by memory id (content never logged), length bounding. |
| Background pipeline | `src/services/memoryPipeline.js` | `deriveText` (transcription + document extraction), `analyseMemory` (summary/topics/keywords/entities via the LLM, sanitized, JSON-extracted, `ProviderError`-safe), `indexMemory` (embeddings). |
| Ingestion | `src/services/memoryIngestion.js` | Queueing + fingerprint dedup so unchanged memories are never re-analysed. |
| Memory links | `src/services/memoryLinks.js` | Relationship suggestions (duplicate / follow_up / supersedes / related) — **require explicit user approval**. |
| Search | `src/services/memorySearch.js` | UI search; shares ranking with the assistant retrieval path. |
| Conversation | `src/utils/contextEngine.js` | Follow-up / earlier-conversation context (consent-gated). |
| Ask flow | `src/controllers/query.controller.js` | The RAG workflow: consent gate → retrieval → context build → LLM → citation filter → response. |
| Evaluation | `eval/` | `runRetrievalEval.mjs`, `groundingEval.mjs`, `perfEval.mjs`, `embeddingHeadroom.mjs`, `sweepParams.mjs` + synthetic datasets + metrics. |

**Conclusion:** Phase 10 §2–§9 are already met by the existing implementation.
The work here was to verify, measure, and document — not to rebuild.

## 2. Model provider and model actually integrated

- **Provider:** local **llama.cpp `llama-server`** (any OpenAI-compatible
  server) on `LOCAL_AI_BASE_URL` (default `http://localhost:4891`). Inference
  is **local**; a remote OpenAI-compatible endpoint is supported through the
  same client by changing `LOCAL_AI_BASE_URL`.
- **Model:** `LOCAL_AI_MODEL` (default `Llama 3.2 3B Instruct`). Configurable
  through backend env only.
- **Embeddings:** `EMBEDDING_MODE=local` (384-dim hashed vectorizer, the
  default) or `EMBEDDING_MODE=remote` (`EMBEDDING_MODEL` + `EMBEDDING_DIM`).
  Dimension drift is refused, not absorbed, so stored vectors and query vectors
  can never land in different spaces.
- **Credentials:** `LOCAL_AI_API_KEY` and `TRANSCRIPTION_API_KEY` are
  **backend-only** (never in the frontend bundle, which reads only
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`).
- **Generation parameters:** temperature, max output tokens, and request
  timeout are configurable per call with sensible defaults (chat: temp 0.5,
  700 tokens, 20 s; analysis: temp 0.2, 320 tokens, ≤15 s; embedding: 15 s).

## 3. Exact files added and modified (this phase)

- **Modified:** `backend/src/controllers/memory.controller.js` — extended
  `missingTableHint` so a `column … does not exist` error (the exact failure
  below) returns an actionable, ordered migration instruction instead of a raw
  Postgres message. No behavior, schema, or security change.
- **Added:** `AI-MODEL.md` (this report).
- **Appended:** `AUDIT.md` §13 (Phase 10 section).
- **Unchanged (verified, not rewritten):** `llmClient.js`, `embeddings.js`,
  `memoryRetrieval.js`, `memoryContext.js`, `promptSafety.js`,
  `memoryPipeline.js`, `memoryIngestion.js`, `memoryLinks.js`,
  `memorySearch.js`, `contextEngine.js`, `query.controller.js`, `eval/*`.

## 4. AI inference and RAG workflow implemented

The question-answering workflow (Phase 10 §3) is implemented in
`query.controller.js` and matches the required sequence exactly:

1. User asks a question → 2. authenticate (Bearer token) → 3. check consent
(`memoryAiEnabled`) and personalization settings → 4. analyse the question →
5. retrieve via the existing hybrid engine → 6. apply ownership (RLS + explicit
`user_id` filter), approval (links), relevance (floor), chronology
(newer-first tiebreak) and supersession (`supersedes` links) rules →
7. construct compact structured context (`buildContext`) → 8. send to the
configured model (`complete`) → 9. generate a grounded answer →
10. validate citation ids against the retrieved context (`extractCitedIds`) →
11. return the answer with supported citations → 12. record only permitted
metadata (audit actions, counts-only retrieval traces) — never memory text.

**Personalization (§4):** the model interprets retrieved memories in context
(facts, people, events, goals, dates, changes, connections). Conflicts are
resolved by explicit corrections and `supersedes` links; unresolved conflicts
are surfaced as uncertainty, never invented. No sensitive attributes are
inferred beyond the user's own content.

**Context/prompt engineering (§5):** retrieved memory is fenced as untrusted
DATA (never instructions); the system prompt holds rules only (no user
content, so memory text can never reach the highest privilege level); the
model is told to separate stored fact from interpretation, respect chronology,
admit insufficiency, and cite only supplied ids.

**Grounded answers + citations (§6):** `extractCitedIds` accepts **only** ids
that were actually supplied to the model from the caller's RLS-scoped
retrieval — the model is never trusted as an authorization source. Unknown,
foreign, or fabricated ids are dropped. Insufficient evidence yields the honest
`noContextAnswer()` fallback.

**Background processing (§7):** summarization, topic/keyword/entity
extraction, searchable text, and relationship suggestions — all derived
(never user-confirmed truth), approval-gated, and fingerprint-deduped.

**Conversation (§8):** follow-ups use only authorized conversation context
(consent-gated) plus relevant memories; a general-knowledge question with no
retrieved memory is answered as general information, clearly labelled.

**Performance/cost (§9):** retrieval is bounded (`RETRIEVAL_MAX_MEMORIES=8`,
candidate limit, context budget), timeouts and max tokens are configured, and
fingerprint dedup avoids repeat inference. Operational records are counts-only
(audit actions, retrieval traces under `CONTEXT_DEBUG`); the local provider
does not expose reliable token usage, so token metrics are recorded only
"where available" per the requirement.

## 5. Evaluation dataset and actual measured results

**Retrieval evaluation — EXECUTED** (`node eval/runRetrievalEval.mjs`,
real `retrieveMemories`, in-memory RLS stand-in, local 384-dim vectorizer,
synthetic corpus; `embedding=local dim=384 vectorWeight=0.6 minSim=0.12
maxMemories=8`):

| Strategy | hit@5 | top1 | recall@5 | MRR | leaks |
|---|---|---|---|---|---|
| lexical | 79.1% | 37.2% | 0.715 | 0.538 | 0 |
| vector | 67.4% | 53.5% | 0.674 | 0.598 | 0 |
| **hybrid** | **81.4%** | **53.5%** | **0.757** | **0.644** | **0** |

This **exactly matches the verified baseline** (hybrid hit@5=81.4%,
top1=53.5%, recall@5=0.757, MRR=0.644, 0 leaks) — expected, since Phase 9
did not touch retrieval. `no-answer` and `disjoint` handling: 100% OK.
**Cross-user leakage: 0 on every strategy.**

**Grounding suite — EXECUTED** (stub LLM, real controllers, RLS-correct
fake store): **13/13 pass** — grounding, hallucinated-citation filtering,
consent gating (memory-AI off ⇒ archive never queried), cross-user
isolation, prompt-injection handling.

**Live model evaluation — NOT EXECUTED:** `eval/groundingEval.mjs` with a
real model requires a running LLM (`localhost:4891`), which is unreachable
in this environment. The remote path fails loudly (`provider_unreachable`,
502) rather than silently falling back. The live model's prose quality is
therefore **unmeasured**; grounding behaviour is validated by the stub-LLM
suite instead. This is not claimed as a passed evaluation.

## 6. Test counts

| Suite | Result |
|---|---|
| Backend test suite | **210 tests — 205 pass, 0 fail, 5 skipped** |
| Grounding suite (stub LLM) | **13 pass, 0 fail** |
| Retrieval evaluation | executed (numbers above) |
| Frontend lint / build | exit 0 / exit 0 (563.38 kB / 157.38 kB gzip) |
| Live model eval (real LLM) | **not executed** — no LLM server |
| Live Supabase isolation | **not executed** — no isolated project |

## 7. Performance and provider limitations

- The local vectorizer is a deterministic hash, **not** a neural embedding —
  semantic paraphrase recall is limited (vector-only hit@5 = 67.4%). Hybrid
  (keyword + lexical + vector) is the product default and carries the
  quality (81.4%).
- Calibration constants (`VECTOR_MIN_SIMILARITY`, `VECTOR_SIMILARITY_ANCHOR`,
  `RETRIEVAL_VECTOR_WEIGHT`) are derived from the **synthetic** corpus and
  must be re-derived against the real archive before production.
- The local GPT-2-class model has a small context window; `LOCAL_AI_COMPACT_PROMPT`
  strips the prompt to fit it.

## 8. Security and privacy validation

- **Ownership:** RLS on every query + explicit `user_id` filter on every
  result + invoker-security vector RPC → retrieval cannot cross users
  (measured: 0 leaks).
- **Citations:** only ids actually supplied to the model are accepted; the
  model is never an authorization source.
- **Prompt injection:** memory text is fenced as data, injection markers are
  flagged and audit-logged by id (content never logged), and the system
  prompt contains rules only.
- **Consent:** `memoryAiEnabled=false` skips retrieval entirely (verified);
  `conversationMemoryEnabled=false` skips conversation history.
- **Secrets:** model/transcription keys are backend-only; no private
  memories, prompts, or keys are logged (error bodies are truncated).

## 9. Remaining manual setup and production requirements

1. **Apply the five migrations in order** to the target project (this is the
   cause of the browser 400 below): `memories.sql` → `query.sql` →
   `context.sql` → `security.sql` → `memory_intelligence.sql` (Supabase SQL
   editor).
2. **Start the backend** (`npm start` in `backend/`) — the login
   `ERR_CONNECTION_REFUSED` means it was not running.
3. **Serve the local LLM** (`llama-server … --port 4891`) to run the live
   grounding evaluation and enable memory analysis/question answering.
4. Re-derive calibration constants against the real archive.
5. Product-owner consent decision (`CONSENT-DECISION.md`); live isolation
   suite on an isolated project (Phase 9 §4) remains blocking for production.

**Release status:** the AI model layer is implemented, verified, and preserved;
local verification is green. Live model and live-isolation verification remain
and are blocking for production.
