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
