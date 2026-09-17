# Agent Upgrade Design — "Smart Receptionist" (P1/P2)

الهدف: وكيل استقبال حر وطبيعي، يستخدم الأدوات عند الحاجة، مؤسس على بيانات Supabase فقط،
لا يختلق أي معلومة — بأعلى جودة وأقل تكلفة. (English below.)

## Goal

Turn agent k2 into a fully conversational receptionist: natural free dialogue, on-demand
tool use, replies grounded in live Supabase data, zero fabrication — at the lowest
possible cost without sacrificing quality.

## What we keep (the quality backbone)

The current architecture already implements the correct safety pattern:
**the LLM proposes, the deterministic core disposes.** The model extracts intent and
entities into a contract; the orchestrator, transition guard, business-time gate,
idempotency layer, and verbatim SQL do every mutation. An actual booking can therefore
never be hallucinated — that stays untouched.

## P1 — Grounding + Tools

### 1. Grounding verifier (`app/core/grounding.py`) — implemented in this pass
- Deterministic post-extraction check on **LLM-authored replies only**
  (`extracted.render_used is not True` — deterministic template renders are fact-safe by
  construction and are skipped).
- Rule: every concrete entity in the reply — doctor names (after د./دكتور), clock times
  (HH:MM / الساعة N), ISO dates — must appear in the turn's **context whitelist**:
  patient message text, conversation state, clinic context, policy output, orchestrator
  decision, normalized/repaired agent contract, FAQ facts. Arabic digits are folded
  (٠-٩ → 0-9) before matching.
- Violation → reply replaced by a non-committal safe Arabic fallback + audit flag
  `grounding_violations`. Fail-closed: suspected fabrication never reaches the patient.
- `GROUNDING_MODE` env: `enforce` (default) / `audit` (log only) / `off`.
- v1.1 (planned): thread availability-tool results into the whitelist.

### 2. FAQ as a tool, not a prefetch
- Today FAQ is searched and injected on **every** turn (SQL + prompt tokens); n8n gated
  it on the `clinic_query` prompt profile.
- Change: expose `Search_Clinic_FAQ` as a second LLM tool; keep the deterministic
  prefetch only when a cheap keyword pre-classifier detects a clinic-info question.
- Saves one SQL round-trip and prompt tokens on most turns.

### 3. New read-only tools (LLM-callable)
- `List_Doctors_Services` — clinic catalog (doctors, specialties, services) from DB.
- `Get_My_Appointments` — the patient's upcoming appointments from DB.
- Read-only = zero mutation risk; they convert LLM guesses into real data answers.

## P2 — Naturalness + Cost

### 4. Compose-with-facts replies
Deterministic layers emit a facts block (slots offered, booking outcome, details) →
the LLM phrases it naturally in the clinic persona → grounding verifier checks the
phrasing. Booking confirmations stay template-based (highest-stakes text).

### 5. Cheap-turn short-circuit (pre-LLM)
Deterministic sniff before the LLM call: pure yes/no during AWAIT_CONFIRMATION, numeric
slot picks during AWAIT_SLOT_CHOICE, repeat greetings. The orchestrator already resolves
these *after* the LLM call today; moving the decision *before* it skips the call on a
large share of turns.

### 6. Prompt caching + model policy
- The static 8890-char system prompt goes through provider prompt caching (~90%
  discount on system tokens where supported by the gateway).
- Primary/repair: `deepseek-v4-flash` via the AI gateway (cheap), temp low, fixed seed
  if the provider supports it. Remove dead `LLM_TEMPERATURE` config.

## P3 — Dynamic response composition (IMPLEMENTED 2026-09-17)

The previous design let the model draft a reply but passed the final text through a
deterministic renderer containing per-response-code Arabic templates
(`extract_single_agent_reply` → `_stage_plan`). That is now removed from the live path.

### New shape

```
patient message
   ↓
dialogue agent (tools on demand)  →  AgentTurnText  (reply + tool_events)
   ↓
deterministic core: orchestrator → gates → executors → response_policy
   ↓
response_context.build_reply_context()   ← the ONLY data the composer may use
   ↓
dialogue.compose_patient_reply()          ← the model writes the final prose
   ↓
response_context.validate_composer_output()  ← structured evidence contract
   ↓
reply_guard override (only if the composer failed)  →  Respond To Patient
```

### What changed

| Before | After |
|---|---|
| `extract_single_agent_reply` chose between model text and Arabic response-code templates | The model authors the reply from a fact catalog; no response-code text exists in the path |
| Tool results were discarded inside the chat loop (`final_content` only) | `AgentTurnText.tool_events` carries every Supabase result into the fact catalog |
| Grounding whitelist scanned pipeline blobs with regex entity matching | The composer must cite `fact_ids`; the contract is validated structurally, not by pattern matching |
| FAQ prefetched on every turn **and** available as a tool | Tool only — one SQL round-trip, and only when the user actually asks |
| Up to 5 tool-loop turns, unlimited tool calls per turn | `LLM_TOOL_MAX_TURNS=3`, `LLM_TOOL_MAX_CALLS=4`, duplicate (name+args) calls served from a per-turn cache |

### Fact catalog (`app/core/response_context.py`)

`k2.reply-context.v1` carries `patient_message`, persona, `draft_reply`, and a `facts`
array. Every fact has an `id`, `kind`, and an `authority`:

- `database` — clinic profile, doctors, services, branches, tool results, FAQ
- `deterministic` — policy outcome, orchestrator decision, mutation results
- `patient` — the patient's own words (a statement, never a verified clinic fact)
- `tool_error` — the source failed; nothing may be asserted from it

Internal identifiers and secret-shaped keys are stripped before the data reaches the
model. The composer returns `{reply, evidence_ids, missing_information, unsupported_claims,
grounding_status}`; a reply is only accepted when every cited ID exists, at least one
valid ID is cited, and the model does not self-report unsupported claims. One repair
attempt is allowed; on failure the runner falls back to the guard override or the model
draft — never to a canned sentence chosen by response code.

### Guardrails preserved

- Mutations remain deterministic-only. The composer cannot book, cancel, or reschedule.
- The reply guard still runs and still holds the terminal-override text as the last
  safety net when the composer fails.
- A composer reply only supersedes the guard override after passing the evidence
  contract, and the audit row records `reply_composer.origin` / `evidence_ids`.

### Known follow-ups

- `app/core/grounding.py` and `tests/test_grounding.py` are **orphaned** — nothing imports
  them since the composer replaced the regex whitelist. They still contain the
  `render_used` bypass described in `docs/agent_review_2026-09-17.md`. Decide: delete, or
  keep as a second structural check.
- `dialogue.call_primary_model()` (the pre-tools single-shot call) is dead code.
- `extract_single_agent_reply` still runs, but only inside the always-false
  `if_single_agent_result_phase` branch. Either wire that branch properly or delete it.
- The new path has not yet been exercised against the live LLM. Run one real turn per
  intent (greeting, availability, booking, cancel, FAQ) before deploying.

## Guardrails (non-negotiable)

- Mutations remain deterministic-only (LLM proposes, core disposes).
- The grounding verifier fails closed.
- Every change ships with parity + unit tests (see tests/test_fixes.py, tests/test_grounding.py).

## Rollout

1. **P1.1** Grounding verifier (this pass — enforce mode, audit flag always on)
2. **P1.2** FAQ tool + prefetch gate
3. **P1.3** Read-only tools
4. **P2.1** Cheap-turn short-circuit
5. **P2.2** Compose-with-facts
6. **P2.3** Prompt caching

## Cost sketch

Today: every turn costs 1× (8890 sys + 2–4k user) tokens + up to 5 tool-loop turns +
FAQ SQL. After P1/P2: cached system prompt, no FAQ prefetch on most turns, short-circuit
skips the LLM entirely on confirmation/pick turns, tool loop bounded — a substantial
per-turn reduction with no quality loss (deterministic safety stays).
