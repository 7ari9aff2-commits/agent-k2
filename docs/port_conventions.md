# Port Conventions — n8n agent k2 → FastAPI (faithful 1:1)

الهدف: ترجمة حرفية من جافاسكريبت نودس n8n إلى بايثون. **السلوك القديم هو المواصفة.**

## Hard rules

1. **Faithful 1:1.** Every branch, response_code, decision_rule, constant, default, and ordering
   in the source JS must exist in the Python port. Do NOT redesign, do NOT "improve", do NOT drop
   edge cases. If the JS has a quirk, keep the quirk.
2. Source of truth is the JS file in `n8n_reference/extracted/…`. Read ALL of it before porting.
3. n8n helper mapping:
   - `$(NodeName).first().json` → a plain `dict` parameter passed in by the pipeline runner.
   - `$json` → the current item dict.
   - `$input.all()` / `.items()` → list of item dicts.
   - n8n item = `{json: {...}}` → in Python we carry the inner `json` dict directly.
   - `new Date()` → use `datetime.now(timezone.utc)`; timestamps stay ISO-8601 UTC strings.
   - `JSON.stringify/parse` → `json.dumps/loads`.
4. Defensive style preserved: JS `x || {}` → `x or {}`; JS `try {…} catch (_) { return {}; }`
   → `try: … except Exception: return {}`. Keep the same fallback values.
5. If something depends on n8n runtime you cannot resolve (e.g. `.item` pairing, pairedItem),
   port the closest deterministic equivalent and mark it with `# PORT-TODO(n8n): <why>`.
6. Output: pure functions, type hints everywhere, stdlib only (no new dependencies).
   No `print()`. No I/O in these modules (except json where the JS did it).
7. Each ported function gets a one-line docstring: `Source node: <node name> (extracted/code/<file>.js)`.
8. Verify your file: `python -m py_compile <file>` must pass, and `python -c "import app.<module>"`
   from the project root `D:\agent k2` must pass.

## Module map (where each ported node lives)

| Source JS (n8n_reference/extracted/code/) | Target Python |
|---|---|
| System_Orchestrator_Policy.js | app/core/orchestrator.py → `decide(...)` |
| Response_Policy_Deterministic.js | app/core/response_policy.py → `build_response(...)` |
| Reply_Guard_Deterministic.js | app/core/reply_guard.py → `apply_reply_guard(...)` |
| Normalize_Validate.js | app/pipeline/normalize.py |
| K2_Contract_Adapter_v4_to_v3.js | app/core/contract_adapter.py |
| Normalize_Agent_Output_Deterministic.js | app/core/agent_output.py |
| Derive_Actions_Deterministic.js | app/core/contract_adapter.py |
| P1_7_Patient_Field_Normalization.js | app/pipeline/patient_fields.py |
| Handle_Normalize_Error_Deterministic.js | app/pipeline/normalize.py |
| all extracted/sql/*.json | app/db/queries.py (SQL verbatim) + app/db/repository.py (async functions) |
| R1/R2/R3, Build_Repair_Prompt, Validate_Repaired_Contract | app/core/llm_safety.py |
| Business_Time_Gate, Execution_Transition_Guard | app/core/gates.py |
| Prepare_*/Apply_*/Merge_*/Evaluate_*/Validate_Child_Envelope/Restore_Handoff_Context | app/pipeline/stages_post.py |
| Build_Clinic_Persona_Context, Build_Persistent_Conversation_State, Build_Audit_Entry, Compute_AI_Request_Usage, Build_Outgoing_Message_SQL_Parameters, Extract_K2_Signature_Context, Validate_Patient_Ownership, Evaluate_Completed_Create_Replay, Route_Single_Agent_Phase, Build_Save_State_RPC_Body, Build_Retry_RPC_Body_v18 | app/pipeline/stages_pre.py |
| handoff child workflow (n8n_reference/handoff_child_v1.json) | app/services/handoff.py |
| FAQ workflow (n8n_reference/k2_search_clinic_faq.json) | app/services/faq.py |

## Function contracts

- `app/core/orchestrator.py::decide(contract_v3: dict, state_data: dict, clinic_context: dict, now_ts: float | None = None) -> dict`
  (mirrors `decide()` in the JS; keep the emitted envelope exactly: `system_decision` +
  top-level `booking_context`/`slot_state`/`target`/`state_patches` etc.)
- `app/core/response_policy.py::build_response(ctx: dict) -> dict` — mirrors the JS main body;
  keep every response_code branch and the exact Arabic template text byte-for-byte.
- `app/core/reply_guard.py::apply_reply_guard(inputs: dict) -> dict` — keep output keys
  (`reply_text`/`_reply_guard`/…) exactly as the JS emits.
- `app/db/repository.py` — one async function per SQL node, named after the node
  (e.g. `get_clinic_context(conn, ...) -> dict`), SQL text copied **verbatim** from the extracted
  JSON `query` field, parameters passed positionally in the order given by `queryReplacement`.
- `app/db/pool.py` provides `get_pool() -> asyncpg.Pool` (already written by the integrator).

## Integration notes

- Pipeline runner: app/api/v1/message.py executes stages in the n8n main-path order.
- Old simplified files (app/core/state_machine.py, app/services/reply_guard.py, …) are legacy;
  do not import them. New code imports only the modules above.
