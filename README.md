# Agent K2 Core Engine — FastAPI port of the n8n `agent k2` workflow

Faithful 1:1 port of the n8n workflow `agent k2` (99 nodes) and its related sub-workflows
(`Handoff Child v1`, `k2 - search_clinic_faq`, `k2 - get_available_slots (deterministic)`)
to a FastAPI + asyncpg service. **n8n remains untouched and active as the fallback.**

## What this is (and is not)

- Every deterministic layer is a line-by-line port of the original n8n code-node JavaScript
  (`n8n_reference/extracted/…`), including Arabic reply templates (byte-identical), decision-rule
  order, and known production quirks (e.g. the mojibake persona fallbacks).
- Parity was verified programmatically: System Orchestrator 56/56 decision rules, 13/13 response
  codes, 10/10 states; Response Policy 43/43 codes; 26/26 SQL queries verbatim; the agent system
  message and user-message template are the exact production strings.
- **Not yet done:** shadow-mode comparison against live n8n traffic and golden-master fixtures
  (n8n's MCP returns trimmed executions; fixtures need an n8n public API key). Do not cut traffic
  over before that. See `MIGRATION_STATUS.md`.

## Architecture

```
app/
├── api/v1/message.py        Pipeline runner — POST /core-engine/message (same n8n contract)
├── core/
│   ├── orchestrator.py      System Orchestrator (Policy) — Decision Core v3, 56 rules
│   ├── response_policy.py   Response Policy (Deterministic) — 43 response codes
│   ├── reply_guard.py       Reply Guard — anti-hallucination overrides
│   ├── agent_output.py      Normalize Agent Output (Deterministic) — contract repairs
│   ├── contract_adapter.py  K2 Contract Adapter v4→v3 + Derive Actions
│   ├── llm_safety.py        R3/R2/R1 layers + repair prompt + repaired-contract validation
│   ├── gates.py             Business Time Gate + Execution Transition Guard
│   ├── config.py, security.py
├── pipeline/
│   ├── normalize.py         Normalize & Validate (owns the 400 path, like n8n)
│   ├── patient_fields.py    P1.7 phone/age/address normalization (21 countries)
│   ├── stages_pre.py        signature context, ownership, persona context, audit, state builders
│   ├── stages_post.py       claim/execute/finalize contexts, reply extraction, handoff prep
│   ├── conditions_pre.py / conditions_post.py   n8n IF-node predicates
│   └── respond.py           Respond To Patient contract (reply precedence + _debug)
├── db/  pool.py (asyncpg) + queries.py (verbatim SQL) + repository.py (one fn per n8n Postgres node)
├── services/
│   ├── dialogue.py          Booking Assistant Agent LLM: full production prompt, tool loop,
│   │                        DeepSeek Model options (0.3/4000/json_object/reasoning-off), repair model
│   ├── availability.py      k2 - get_available_slots sub-workflow (12 nodes, P-OFFER persist)
│   ├── handoff.py           Handoff Child v1 (rpc_handoff_create_or_reuse)
│   └── faq.py               k2 - search_clinic_faq (knowledge_base, clinic-isolated)
└── utils/                   phone/datetime/helpers (kept from the validated scaffold)
```

## Running

```bash
pip install -r requirements.txt
cp .env.example .env   # fill DATABASE_URL (Supabase), K2_INTERNAL_TOKEN, LLM keys
uvicorn app.main:app --host 0.0.0.0 --port 8000
pytest tests/ -q       # 32+ tests
```

## Cutover contract (drop-in)

- `POST /core-engine/message` with header `X-K2-Internal-Token` (same value as the n8n webhook
  headerAuth credential). Body is the same JSON the WhatsApp router sends today.
- Response JSON is the exact n8n `Respond To Patient` shape (incl. `_debug.deterministic_override`)
  and the early-exit shapes: 400 invalid payload, 403/404 unauthorized, 200 duplicate/handoff/burst.
- The only change needed at cutover: point the router's HTTP Request node (or its webhook URL
  configuration) at this service. Rollback = point it back at n8n.

## Verification status

- `pytest tests/ -q` — green (availability parity 14, dialogue template 9, respond contract 6, phone 3).
- `PYTHONPATH=. python tools/check_orchestrator_parity.py` — token parity + default-decision smoke.
- Stage ports were smoke-tested against their source JS during the port (123 + 219 + scripted-SQL checks).

## Source of truth

- `n8n_reference/agent_k2_workflow.json` — live workflow export (verified identical to n8n on
  2026-09-16: versionId `8740610c…`).
- `n8n_reference/extracted/` — 39 code-node JS files, 25 SQL nodes, node params, connections.
- `n8n_reference/sql_queries_reference.json` — canonical production SQL.
- `MIGRATION_STATUS.md` — migration log, decisions, open items.
