# Offline pure-function replays for the 0940959..71ea2c2 review. No DB, no network.
from __future__ import annotations

import asyncio
import json
import sys
import types

print("== A. entity recovery: stale tool args (doctor corrected mid-turn) ==")
from app.services.dialogue import recover_entities_from_tool_events

def contract(entities):
    return json.dumps({
        "schema_version": "k2.dialogue.v4", "reply": "رد", "turn": {"intent": "booking_request"},
        "confidence": 0.95, "ambiguous": [], "confirmation": {"intent": "none"},
        "selection": {"kind": "none", "rank": None}, "entities": entities,
        "operation_proposal": {"type": "none", "requested": False}, "escalate": None,
    }, ensure_ascii=False)

tool_events = [
    {"name": "Check_Doctor_Availability",
     "arguments": {"doctor_id": "د. أحمد", "requested_date": "2026-09-20"},
     "result": {"error": "INVALID_OR_MISSING_IDENTIFIER"}},
    {"name": "Check_Doctor_Availability",
     "arguments": {"doctor_id": "د. سارة", "requested_date": "2026-09-24"},
     "result": {"offered": [{"rank": 1, "date": "2026-09-24", "time": "10:30"}]}},
]
out = json.loads(recover_entities_from_tool_events(contract({"doctor_name": None, "date": None}), tool_events))
print("recovered entities:", out["entities"])
print("doctor recovered =", out["entities"]["doctor_name"], "| date recovered =", out["entities"]["date"])
print("LATEST call (the patient's correction) wins?" , out["entities"]["doctor_name"] == "د. سارة")

print()
print("== B. entity recovery: model-assumed date hardens into state ==")
events_b = [{"name": "Check_Doctor_Availability",
             "arguments": {"doctor_id": "د. أحمد", "requested_date": "2026-09-21"},
             "result": {"offered": []}}]
out_b = json.loads(recover_entities_from_tool_events(contract({"doctor_name": None, "date": None}), events_b))
print("entities.date =", out_b["entities"]["date"], "(patient never stated a day; tool args did)")

print()
print("== C. composer value grounding ==")
from app.core.response_context import validate_composer_output, build_reply_context

def reply_ctx(response_code=None, decision_extra=None):
    return build_reply_context(
        normalized={"message_text": "عايز أحجز"},
        clinic_context={"clinic_name": "عيادة النور"},
        state_data={},
        policy={"response_code": response_code or "CONVERSATION_ONLY"},
        decision=decision_extra or {},
        normalized_agent_output={}, repaired_result={},
        tool_events=[{
            "name": "Check_Doctor_Availability", "arguments": {"requested_date": "2026-09-20"},
            "result": {"success": True, "nearest_slots": [
                {"local_date": "2026-09-20", "local_time": "10:30"}]},
        }],
        execution_results={}, faq_result={}, guard={},
    )

def out(reply, evidence):
    return {"reply": reply, "evidence_ids": evidence, "missing_information": [],
            "unsupported_claims": [], "grounding_status": "supported"}

ctx = reply_ctx()
cases = [
    ("C1 legit slot", "متاح يوم 2026-09-20 الساعة 10:30.", ["tool.0.Check_Doctor_Availability"]),
    ("C2 slot no period", "متاح يوم 2026-09-20 الساعة 10:30", ["tool.0.Check_Doctor_Availability"]),
    ("C3 12h rephrase of 21:30-like fact", "متاح يوم 2026-09-20 الساعة 10:30 مساءً", ["tool.0.Check_Doctor_Availability"]),
    ("C4 count small", "يوجد 3 مواعيد متاحة يوم 2026-09-20", ["tool.0.Check_Doctor_Availability"]),
]
for label, reply, ev in cases:
    parsed, errors = validate_composer_output(out(reply, ev), ctx)
    print(f"{label}: accepted={parsed is not None} errors={errors}")

# C5: 24h fact "21:30" stated as "9:30"
ctx_c5 = build_reply_context(
    normalized={"message_text": "مواعيد"}, clinic_context={"clinic_name": "عيادة النور"},
    state_data={}, policy={"response_code": "CONVERSATION_ONLY"},
    decision={},
    normalized_agent_output={}, repaired_result={},
    tool_events=[{"name": "Check_Doctor_Availability", "arguments": {"requested_date": "2026-09-20"},
                  "result": {"success": True, "nearest_slots": [
                      {"local_date": "2026-09-20", "local_time": "21:30"}]}}],
    execution_results={}, faq_result={}, guard={})
parsed, errors = validate_composer_output(out("متاح يوم 2026-09-20 الساعة 9:30 مساءً", ["tool.0.Check_Doctor_Availability"]), ctx_c5)
print("C5 24h->12h rephrase accepted:", parsed is not None, "errors:", errors)

# C6: CANCEL_COMPLETED with the cancelled number present in state facts but omitted from reply
ctx_c6 = build_reply_context(
    normalized={"message_text": "الغي الحجز"}, clinic_context={"clinic_name": "عيادة النور"},
    state_data={"booking_context": {"booking_number": "BK-42", "doctor_name": "د. أحمد"}},
    policy={"response_code": "CANCEL_COMPLETED"},
    decision={"response_code": "CANCEL_COMPLETED"},
    normalized_agent_output={}, repaired_result={}, tool_events=[],
    execution_results={}, faq_result={}, guard={})
parsed, errors = validate_composer_output(out("تم إلغاء موعدك مع د. أحمد يا فندم", ["conversation.current_state"]), ctx_c6)
print("C6 cancel reply without number accepted:", parsed is not None, "errors:", errors)
parsed, errors = validate_composer_output(out("تم إلغاء الحجز رقم BK-42", ["conversation.current_state"]), ctx_c6)
print("C6b cancel reply with number accepted:", parsed is not None, "errors:", errors)

# C7: no booking_number fact anywhere -> check is a no-op (claim replay after crash)
ctx_c7 = build_reply_context(
    normalized={"message_text": "حجزت؟"}, clinic_context={"clinic_name": "عيادة النور"},
    state_data={}, policy={"response_code": "IDEMPOTENT_REPLAY"},
    decision={"response_code": "IDEMPOTENT_REPLAY"},
    normalized_agent_output={}, repaired_result={}, tool_events=[],
    execution_results={}, faq_result={}, guard={})
parsed, errors = validate_composer_output(out("تم تنفيذ العملية سابقاً.", ["decision.current"]), ctx_c7)
print("C7 replay without number fact accepted:", parsed is not None, "errors:", errors)

print()
print("== D. restart fallback with the runner's REAL item shape (fresh_offer row) ==")
from app.pipeline import stages_pre

fresh_offer_item = {"presented_offer": None, "availability_alternatives": []}
# orchestrator-style item the runner passes as system_orchestrator_policy
orch_new_doctor = {
    "system_decision": {"new_booking_restart": True, "allowed": True, "action": "create_appointment",
                        "response_code": "NEW_BOOKING_STARTED",
                        "booking_context": {"doctor_name": "د. سارة", "date": None}},
    "booking_context": {"doctor_name": "د. سارة", "date": None},
    "state_patches": {"state_machine": "booking", "response_code_history": []},
}
orch_no_doctor = {
    "system_decision": {"new_booking_restart": True, "allowed": True, "action": "create_appointment",
                        "response_code": "NEW_BOOKING_STARTED",
                        "booking_context": {"doctor_name": None}},
    "booking_context": {"doctor_name": None},
    "state_patches": {},
}
previous_state = {"state_data": {
    "booking_context": {"doctor_id": "dr-ahmad-uuid", "doctor_name": "د. أحمد",
                        "service_id": "svc-1", "service_name": "تنظيف أسنان",
                        "appointment_type": "FOLLOW_UP"},
    "facts": {}, "operation_status": "completed"}}

def build(orch):
    return stages_pre.build_persistent_conversation_state(fresh_offer_item, {
        "normalize_validate": {"clinic_id": "c", "patient_id": "p", "conversation_id": "v",
                               "channel_type": "whatsapp", "message_text": "عايز أحجز تاني",
                               "received_at": "2026-09-18T10:00:00Z"},
        "get_clinic_context": {"clinic_name": "عيادة", "draft_ttl_seconds": 1800},
        "system_orchestrator_policy": orch,
        "get_conversation_state": previous_state,
        "read_fresh_offer_midturn": fresh_offer_item,
    })

st1 = build(orch_new_doctor)
bc1 = st1["state_data"]["booking_context"]
print("D1 patient names a NEW doctor (سارة): saved doctor_name =", bc1.get("doctor_name"),
      "| service_name =", bc1.get("service_name"), "(old service silently kept?)")

st2 = build(orch_no_doctor)
bc2 = st2["state_data"]["booking_context"]
print("D2 no doctor named: saved doctor_name =", bc2.get("doctor_name"),
      "| service_name =", bc2.get("service_name"), "| appointment_type =", bc2.get("appointment_type"))

# D3: prove restart_names_doctor is DEAD under runner wiring: item.output is absent,
# so even a decision whose entities named a doctor cannot clear the fallback.
print("D3 item passed to the node carries 'output'? ", "output" in fresh_offer_item,
      "-> _dig(output,'contract','entities','doctor_name') is always falsy")

print()
print("== E. turn lock: serialization, timeout, exception release, missing conversation_id ==")
import app.api.v1.message as runner_mod

events = []

async def fake_run(body, raw_headers, raw_body=b""):
    key = body["conversation_id"]
    events.append(("start", key, body.get("wamid")))
    await asyncio.sleep(0.2)
    events.append(("end", key, body.get("wamid")))
    return {"reply_text": "ok", "response_code": "CONVERSATION_ONLY", "conversation_id": key}

orig_run = runner_mod._run
runner_mod._run = fake_run

def fake_request(body: dict):
    raw = json.dumps(body).encode()
    return types.SimpleNamespace(
        headers={"content-type": "application/json"},
        body=lambda: asyncio.sleep(0, result=raw),
    )

async def call(body):
    return await runner_mod.process_patient_message(fake_request(body), authorized=True)

async def lock_scenarios():
    # E1: two concurrent turns on one conversation serialize
    events.clear()
    r1, r2 = await asyncio.gather(
        call({"conversation_id": "conv-1", "wamid": "m1"}),
        call({"conversation_id": "conv-1", "wamid": "m2"}),
    )
    order = [e[1] for e in events if e[0] == "start"]
    print("E1 start order (serialized):", order, "m2 suppressed?", r2.status_code == 200 and b"QUEUED" in r2.body)
    # E2: timeout path returns QUEUED_BEHIND_TURN and never enters _run (no logging)
    runner_mod._CONVERSATION_LOCK_WAIT_SECONDS = 0.05
    events.clear()
    async with runner_mod._CONVERSATION_LOCKS.setdefault("conv-2", asyncio.Lock()):
        holder = asyncio.create_task(asyncio.sleep(0.4))
        r3 = await call({"conversation_id": "conv-2", "wamid": "m3"})
        await holder
    print("E2 timeout response code:", json.loads(r3.body).get("response_code"),
          "| _run entered for m3?", any(e[2] == "m3" for e in events))
    runner_mod._CONVERSATION_LOCK_WAIT_SECONDS = 90.0
    # E3: exception inside _run releases the lock (next turn proceeds)
    async def boom(body, raw_headers, raw_body=b""):
        raise RuntimeError("llm down")
    runner_mod._run = boom
    r4 = await call({"conversation_id": "conv-3", "wamid": "m4"})
    runner_mod._run = fake_run
    events.clear()
    r5 = await call({"conversation_id": "conv-3", "wamid": "m5"})
    print("E3 after a crashed turn the next turn runs (no deadlock):",
          r5.status_code == 200 and any(e[2] == "m5" for e in events))
    # E4: thread_id-only payload (normalize resolves conversation from chat/thread) -> lock skipped
    async def observe(body, raw_headers, raw_body=b""):
        events.append(("start", "resolved-from-thread", body.get("thread_id")))
        return {"reply_text": "ok"}
    runner_mod._run = observe
    events.clear()
    await asyncio.gather(
        call({"thread_id": "conv-9", "wamid": "m6"}),
        call({"thread_id": "conv-9", "wamid": "m7"}),
    )
    starts = [e for e in events if e[0] == "start"]
    print("E4 thread_id-only payloads: both entered _run concurrently?",
          len(starts) == 2, "(lock key uses body['conversation_id'] only)")

asyncio.run(lock_scenarios())
runner_mod._run = orig_run

print()
print("== F. day-word semantics ==")
from app.core.agent_output import _absorb_day_word_to_iso
print("F1 weekday==today -> +7:", _absorb_day_word_to_iso("الخميس", "2026-09-17"))
print("F2 'بعدغد':", _absorb_day_word_to_iso("بعدغد", "2026-09-18"))
print("F3 confirming a SAME-DAY offered slot ('الخميس الساعة 11:30' on Thu):",
      _absorb_day_word_to_iso("الخميس الساعة 11:30", "2026-09-17"))

print()
print("== G. persist_pending_confirmation envelope on the plain orchestrator path ==")
import app.db.repository as repo
from app.pipeline import stages_pre as sp

captured = {}
class _Ctx:
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False
class _Pool:
    def acquire(self): return _Ctx()
async def _pool(): return _Pool()
async def fake_fetch(conn, sql, *params):
    captured["params"] = params
    return None
orig_fetch = repo._fetchrow
repo._fetchrow = fake_fetch
orig_gp = "app.db.pool.get_pool"
sys.modules.setdefault("app.db.pool", types.ModuleType("app.db.pool"))
import app.db.pool as pool_mod
pool_mod.get_pool = _pool
# orchestrator output envelope (per orchestrator.py result_json.update: response_code top-level)
orch_item = {
    "system_decision": {"action": "create_appointment"},
    "response_code": "CONFIRMATION_REQUIRED",
    "confirmation_target": {"confirmation_id": "cf-9", "action": "create_appointment"},
    "booking_context": {},
}
asyncio.run(repo.persist_pending_confirmation({"normalized": {"clinic_id": "c"}, **orch_item}))
print("G gate param (response_code):", captured["params"][0])
repo._fetchrow = orig_fetch

print()
print("== H. has_outgoing_reply id parity with the SQL ==")
import hashlib
key = "telegram:ch:1"
print("python md5:", hashlib.md5((key + ":outgoing").encode()).hexdigest(),
      "| SQL: md5($1 || ':outgoing')::uuid -> same hex, uuid-cast equal")

print()
print("== I. lock dict growth ==")
print("locks are never removed from _CONVERSATION_LOCKS; len grows with distinct conversation ids")
