# Debug: run journey T1-T5 via _run, capture T5 saved state, then probe T6 decide
import asyncio, json
import app.api.v1.message as runner_mod
import app.db.repository as repo
import app.core.orchestrator as orch_mod
from app.api.v1.message import _run
from app.services.dialogue import AgentTurnText
import tests.test_booking_journey as tj

STATE_STORE = {}
saved_bodies = []

async def fake_save(normalized, save_body):
    saved_bodies.append(save_body)
    STATE_STORE["state_data"] = save_body.get("state_data") or {}
    return {"initial": {"saved": True}, "retry": None}

# Minimal stub set copied from the journey test
async def _async(v): return v
CLINIC = tj.CLINIC; PATIENT = tj.PATIENT; CONVERSATION = tj.CONVERSATION

monkey_patches = [
    (repo, "verify_k2_inbound_signature", lambda ctx: _async({"accepted": True})),
    (repo, "log_incoming_message", lambda n: _async({"id": "in", "duplicate": False})),
    (repo, "get_clinic_context", lambda n: _async({
        "clinic_id": CLINIC, "clinic_name": "عيادة النور", "clinic_timezone": "Asia/Riyadh",
        "clinic_found": True, "ownership_valid": True, "conversation_patient_id": PATIENT,
        "doctor_count": 1, "clinic_phone": "+966500000000", "single_doctor_id": tj.DOCTOR,
        "doctor_directory": [{"id": tj.DOCTOR, "doctor_name": "د. أحمد"}]})),
    (repo, "k2_inbound_burst_rate_gate", lambda ctx: _async({"allowed": True})),
    (repo, "log_k2_rate_decision", lambda ctx: _async({})),
    (repo, "mark_k2_burst_message_deferred", lambda ctx: _async({})),
    (repo, "get_conversation_state", lambda n: _async({"state_data": STATE_STORE.get("state_data", {})})),
    (repo, "get_recent_window_2h", lambda ctx: _async({"conversation_history": []})),
    (repo, "get_active_handoff_request", lambda n: _async({})),
    (repo, "resolve_branch_inquiry", lambda ctx: _async({})),
    (repo, "resolve_doctor_inquiry", lambda ctx: _async({})),
    (repo, "resolve_service_fact", lambda ctx: _async({})),
    (repo, "resolve_booking_ids", lambda ctx: _async({})),
    (repo, "lookup_business_time_context", lambda ctx: _async({})),
    (repo, "persist_pending_confirmation", lambda ctx: _async({})),
    (repo, "read_fresh_offer_midturn", lambda ctx: _async({})),
    (repo, "log_agent_audit_entry", lambda e: _async({})),
    (repo, "insert_ai_request_usage", lambda u: _async("x")),
    (repo, "log_outgoing_message", lambda p: _async({"id": "out"})),
    (repo, "get_outgoing_reply", lambda n: _async(None)),
    (repo, "save_conversation_state_with_retry", fake_save),
    (repo, "claim_operation", lambda ctx: _async({"operation_id": "op-1", "decision": "OWNER", "child_execution_allowed": True})),
    (repo, "execute_approved_create_appointment", lambda ctx: _async({"id": tj.APPOINTMENT, "success": True, "response_code": "APPOINTMENT_CREATED", "appointment_id": tj.APPOINTMENT, "booking_number": "BK-X"})),
    (repo, "finalize_operation", lambda c: _async({"operation_id": "op-1"})),
]

# Journey turns T1..T5 exactly like the test
SMALL = tj._contract("أهلاً بيك 🌸", "small_talk", {})
turns = []
def set_agent(contract, events=None):
    turns.append((contract, events or []))

def payload(text, eid):
    return {"clinic_id": CLINIC, "patient_id": PATIENT, "conversation_id": CONVERSATION,
            "message_text": text, "channel_type": "whatsapp", "channel_id": "201000000000",
            "wamid": eid, "source_event_id": eid,
            "time_context": {"source": "runtime_now", "now_iso": "2026-09-18T12:00:00Z",
                             "now_local_date": "2026-09-18", "schema_version": 2}}

async def run_turn(text, eid, contract, events=None):
    turn = AgentTurnText(contract, tool_events=events, llm_calls=1)
    runner_mod.dialogue.call_primary_model_with_tool = lambda um, context: _async(turn)
    runner_mod.dialogue.compose_patient_reply = lambda ctx: _async({
        "reply": contract and json.loads(contract).get("reply") or "رد",
        "evidence_ids": ["patient.current_message"], "missing_information": [],
        "unsupported_claims": [], "grounding_status": "supported", "raw_output": "{}"})
    return await _run(payload(text, eid), {})

async def main():
    saved_patches = []
    for m, n, v in monkey_patches:
        saved_patches.append((m, n, getattr(m, n)))
        setattr(m, n, v)
    # spy on decide at T6
    decisions = []
    orig_dec = orch_mod.decide
    def spy(**kw):
        out = orig_dec(**kw)
        decisions.append({
            "rule": out.get("decision_rule"),
            "code": out.get("response_code"),
            "cs": (out.get("state_machine") or {}).get("current_state"),
            "sd_allowed": (out.get("system_decision") or {}).get("allowed"),
            "cls_in": (kw.get("contract_v3") or {}).get("turn", {}).get("intent") if isinstance(kw.get("contract_v3"), dict) else None,
            "confirm": (kw.get("contract_v3") or {}).get("confirmation") if isinstance(kw.get("contract_v3"), dict) else None,
            "cs_in": (kw.get("state_data") or {}).get("state_machine", {}).get("current_state") if isinstance(kw.get("state_data"), dict) else None,
            "prior_target_in": (kw.get("state_data") or {}).get("confirmation_target") if isinstance(kw.get("state_data"), dict) else None,
        })
        return out
    orch_mod.decide = spy
    runner_mod.orchestrator.decide = spy

    # T1
    await run_turn("أهلا", "evt-1", SMALL)
    # T2 (tool round, doctor recovery)
    await run_turn("احجز مع الدكتور احمد", "evt-2", tj._contract(
        "يسعدنا نحجز مع د. أحمد، نوع الزيارة؟", "booking_request", {"doctor_name": None}), [
        {"name": "Check_Doctor_Availability", "arguments": {"doctor_id": "د. أحمد"},
         "result": {"success": True, "matched": False, "error_code": "DOCTOR_NOT_WORKING_THAT_DAY"}}])
    # patient facts known
    STATE_STORE["state_data"].setdefault("facts", {})["patient"] = {
        "name": "حسام", "name_source": "user_entered", "phone": "+966500000000",
        "age": "30", "address": "شارع الملك فهد"}
    STATE_STORE["state_data"]["booking_context"].update(
        {"patient_age": "30", "patient_address": "شارع الملك فهد"})
    # T3 offer
    await run_turn("الخميس", "evt-3", tj._contract(
        "متاح الخميس 10:30 🌸", "availability_inquiry",
        {"doctor_name": "د. أحمد", "date": "2026-09-24", "time": "10:30"}), [
        {"name": "Check_Doctor_Availability", "arguments": {"doctor_id": "د. أحمد", "requested_date": "2026-09-24"},
         "result": {"success": True, "matched": True, "error_code": None,
                    "nearest_slots": [{"slot_id": tj.SLOT, "start_time": "2026-09-24T10:30:00Z",
                                       "local_date": "2026-09-24", "local_time": "10:30"}]}}])
    # T4 proposal
    await run_turn("أيوه حجز", "evt-4", tj._contract(
        "تمام، أأكد؟ 🌸", "booking_continuation",
        {"doctor_name": "د. أحمد", "date": "2026-09-24", "time": "10:30",
         "visit_type": "NEW_VISIT", "appointment_type": "NEW_VISIT",
         "patient_name": "حسام", "patient_phone": "+966500000000",
         "patient_age": "30", "patient_address": "شارع الملك فهد"},
        proposal={"type": "create_appointment", "requested": True},
        relation="follow_up", selection={"kind": "presented_match", "rank": 1}))
    # T5 data confirm
    await run_turn("أيوه صح", "evt-5", tj._contract(
        "أيوه صح ✅", "confirmation",
        {"patient_name": "حسام", "appointment_type": "NEW_VISIT", "date": "2026-09-24", "time": "10:30"},
        proposal={"type": "create_appointment", "requested": True},
        relation="answer", confirm="affirmative", selection={"kind": "presented_match", "rank": 1}))
    print("T5 saved cs:", (STATE_STORE["state_data"].get("state_machine") or {}).get("current_state"))
    print("T5 saved confirmation_target slot:", (STATE_STORE["state_data"].get("confirmation_target") or {}).get("slot_id"))
    print("T5 saved confirmation_state:", STATE_STORE["state_data"].get("confirmation_state"))
    # T6
    decisions.clear()
    r6 = await run_turn("أيوه أكد", "evt-6", tj._contract(
        "أكد الحجز ✅", "confirmation",
        {"patient_name": "حسام", "appointment_type": "NEW_VISIT"},
        proposal={"type": "create_appointment", "requested": True},
        relation="answer", confirm="affirmative"))
    print("EXEC happened at T5/T6? checking finalize rows...")
    for d in decisions:
        print("T6 decide:", json.dumps(d, ensure_ascii=False, default=str)[:400])
    print("r6 code:", r6.get("response_code"), "| reply:", str(r6.get("reply_text"))[:60])
    for m, n, v in reversed(saved_patches):
        setattr(m, n, v)

asyncio.run(main())
