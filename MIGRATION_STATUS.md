# Migration status — agent k2 (n8n → FastAPI)

## Ground truth
- n8n live workflow `agent k2` id `UojAzV5zbwECAC7Q` versionId `8740610c-…` (99 nodes) — verified identical
  to `n8n_reference/agent_k2_workflow.json` on 2026-09-16. **n8n stays untouched as fallback.**
- Sub-workflows (agent k2 related): `Handoff Child v1` (`SfzXYzvQ2cvNH1v9`) → n8n_reference/handoff_child_v1.json,
  `k2 - search_clinic_faq` (`U5fxNiVF36rUzIFp`) → n8n_reference/k2_search_clinic_faq.json.
- Supabase project: `iqemryazzthjgztregjx` "Meruna's clinics" (eu-west-1). DB password NOT known —
  .env DATABASE_URL has a placeholder. Never reset the DB password via Management API (would break n8n).
- Parity metrics to satisfy: Response Policy handles **43 response codes**; System Orchestrator JS is
  1115 lines; agent prompt is **12958 chars** (python prompt must be the full file, not abridged);
  26 real SQL queries in n8n_reference/sql_queries_reference.json.

## Old scaffold verdict (2026-09-16 review)
The pre-existing app/ was a ~20% simplified port with invented SQL (`rpc_create_appointment`,
`rpc_get_available_slots` — not in the real schema), UTC-as-local-time bug, in-memory burst gate,
greeting fallback on LLM failure. Being replaced by the faithful port below.

## Plan (this pass)
1. [x] Extract 39 code-node JS + 25 SQL + 35 node params into n8n_reference/extracted/
2. [x] Conventions doc: docs/port_conventions.md
3. [x] Port handoff + FAQ services (app/services/handoff.py, app/services/faq.py) — byte-exact SQL verified
4. [x] Port availability sub-workflow `k2 - get_available_slots (deterministic)` id 6467rQRBEA5fWc0l
       (DISCOVERED 2026-09-16: the Check Doctor Availability toolWorkflow calls this 4th workflow —
       12 nodes, deterministic slots engine, calls Supabase REST rpc rpc_get_available_slots which
       therefore exists in the live DB; ported to app/services/availability.py with direct Postgres RPC)
5. [x] Dialogue service (app/services/dialogue.py): user-message template ported byte-faithful
       (including production mojibake persona fallbacks — verified present in the live n8n node text),
       primary model options temperature 0.3 / max_tokens 4000 / json_object / reasoning off 2048,
       repair model temperature 0 / max_tokens 800 / reasoning off 512.
       IMPORTANT: the live system prompt is the agent node systemMessage (8890 chars) copied to
       app/services/prompts/agent_system_message.txt — NOT n8n_reference/agent_prompt.txt (12958
       chars, an older/longer draft that production does not send).
6. [x] Respond contract (app/pipeline/respond.py): reply_text precedence = save-failure message →
       reply-guard override → rendered_reply; production DOES send _debug.deterministic_override.
       Save Conversation State goes through Supabase RPC k2_save_conversation_state
       (p_conversation_id, p_state_data, p_previous_state_version) — port calls it via Postgres.
7. [x] Orchestrator landed (app/core/orchestrator.py): 56/56 decision rules, 13/13 codes, 10/10
       states, full legacy envelope, JS quirks preserved (truthy shim, shared-reference mutations,
       mint_uuid bit-exact). tools/check_orchestrator_parity.py → PARITY PASS (46/46 tokens).
8. [x] DB layer landed (app/db/queries.py + repository.py): 26 query constants (25 verbatim from
       sql_queries_reference.json + k2_save_conversation_state RPC), stale-save retry flow
       fake-pool tested. Decimal returns handled via K2JSONResponse; 8 ctx-wiring notes
       reconciled in app/api/v1/message.py.
9. [x] Response Policy landed (app/core/response_policy.py): 43/43 codes byte-exact Arabic,
       19 branch groups, 12-key ctx schema documented.
10. [x] Pipeline runner (app/api/v1/message.py) wired in semantic n8n order incl. the LLM
        tool-calling loop (Check_Doctor_Availability → availability.check_available_slots),
        raw-body intake (Normalize port owns validation → n8n's 400 path), early-exit respond
        shapes with HTTP codes (400/403/404/200).
11. [x] Contract layers landed (agent C): reply_guard (246L), contract_adapter (332L),
        agent_output (1431L), normalize (489L), patient_fields (374L) — 123 smoke assertions,
        Arabic byte-diff clean.
12. [x] Post-decision stages landed (agent E2): llm_safety (R1/R2/R3 + repair + NAO-v3 validator),
        gates (business time + transition guard), stages_post (12 fns, 2580L), conditions_post —
        219 fixture checks. Pre-LLM stages landed (agent E1): stages_pre (3173L, 9 fns),
        conditions_pre (11 predicates) — 87 Arabic literals byte-compared.
13. [x] Runner reconciled with all 7 ported contracts + build_save_state_rpc_body ported into
        stages_pre; full-app smoke green: /health 200, token auth 401s, invalid payload → the
        exact n8n 400 body; offline end-to-end flow tests (happy path, duplicate, burst, invalid).
        Suite: 36 passing.
14. [x] Legacy simplified modules removed (state_machine, ai_service, booking_service, context_service,
        rate_limiter, availability_service, old schemas/tests).

## Open items before cutover (none block the port itself)
1. [x] RESOLVED 2026-09-17 — DB access without touching the postgres password: the Supabase
       Management API accepts SQL via the Supabase access token. Live signature checks against
       pg_proc confirmed every PORT-TODO: rpc_get_available_slots(p_clinic_id uuid, p_start_date
       date, p_end_date date, p_doctor_id uuid, p_service_id uuid) matches the port's positional
       binding exactly; k2_save_conversation_state(uuid, jsonb, bigint) returns jsonb scalar
       (matches the unwrap logic); k2_verify_inbound_signature returns TABLE(accepted,
       signature_required, signature_valid, channel_binding_valid); rpc_handoff_create_or_reuse
       12-arg order matches the byte-copied SQL.
2. [x] RESOLVED — dedicated DB role `fastapi_app` created (additive only; the n8n postgres
       credential is untouched), with SELECT/INSERT/UPDATE/DELETE on public tables + EXECUTE on
       public functions + default privileges. asyncpg connectivity verified through the session
       pooler (aws-0-eu-west-1.pooler.supabase.com) with all four critical statements executed.
3. [x] RESOLVED — asyncpg strict temporal typing fixed centrally in app/db/pool.py via
       init-connection text codecs for date/timestamp/timestamptz (accepts ISO strings and
       datetimes, returns ISO strings).
4. [x] RESOLVED 2026-09-17 — credentials live:
   - DATABASE_URL: pooler + fastapi_app role, connectivity verified against production data.
   - LLM: Novita (base https://api.novita.ai/openai/v1), key verified with a live chat/completions
     call; MODEL DECISION: GLM 5.3 flash (zai-org/glm-5.3-flash) replaces deepseek-v4-flash in
     BOTH the primary dialogue model and the repair model (same key temporarily serves the repair
     chain until the real "OpenAI account 2" credential is provided).
   - K2_INTERNAL_TOKEN: regenerated (old value unknown); value stored in .env only — the WhatsApp
     sender must send this header value at cutover (or the old value recovered from the sender's
     env can be used instead — one of the two must match).
   - RLS: all 210 public tables have RLS; created policy fastapi_app_full_access (FOR ALL TO
     fastapi_app USING (true) WITH CHECK (true)) on each — additive, no existing access changed.
   - Live read verification as fastapi_app: 5 clinics, 286 conversations, 1094 messages,
     24 conversation_state rows, 21 doctors, 444 knowledge_base entries; rpc_get_available_slots
     executed successfully (0 slots for the sampled clinic's window — data-dependent, not an error).
5. Shadow mode (dry-run, no DB writes) comparing reply_text + response_code vs live n8n —
   required before flipping the webhook URL. NEXT CODE TASK: a DRY_RUN env flag in repository
   write-paths, plus claim-envelope validation in dry-run. PARITY NOTE: n8n still runs
   deepseek-v4-flash; FastAPI now runs GLM per decision — shadow diffs will include model
   variance unless n8n's model is switched too (user's call).
6. Golden masters (optional): n8n public API key enables fixture extraction from real executions.
7. idempotency_key alias check with a real production WhatsApp payload (the port resolves
   message_id via wamid/id/source_event_id chain).

## Fixture finding
MCP get_workflow_execution returns TRIMMED executions (no runData). Golden-master fixtures need
an n8n public API key (GET /api/v1/executions with !data trimming) or shadow-mode comparison.
Deferred — not blocking the port.

## Non-goals this pass
- No n8n modification (n8n stays active backup).
- Golden-master fixtures from real n8n executions (next pass).
- Shadow-mode runner (next pass).

## DEPLOYED 2026-09-17 — Railway
- Project `agent-k2` (renamed from feisty-connection), service `core-engine`, environment production.
- Source: GitHub 7ari9aff2-commits/agent-k2 @ main (92db170), builder RAILPACK, Python 3.12,
  start `uvicorn app.main:app --host 0.0.0.0 --port $PORT`, healthcheck /health.
- 9 env vars set server-side (DATABASE_URL, K2_INTERNAL_TOKEN, LLM_PRIMARY_*, LLM_REPAIR_*,
  PYTHON_VERSION).
- Public URL: https://core-engine-production-a186.up.railway.app
- First deployment SUCCESS. Live checks: /health 200; 401 without/with wrong token; invalid
  payload → the exact n8n 400 Arabic body; well-formed payload with bogus signature → 403
  fail-closed via the live DB RPC (proves Railway → Supabase pooler wiring end to end).
- NEXT: DRY_RUN flag + shadow-mode comparison against live n8n before flipping the sender URL.
