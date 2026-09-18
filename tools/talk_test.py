# Offline natural-conversation test against the REAL model + REAL prompt (read-only)
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import asyncio, json, sys
from app.pipeline import normalize as normalize_mod
from app.pipeline import stages_pre
from app.db import repository
from app.services import dialogue

CLINIC = "42c7312f-6418-4d67-a88e-4464721e6129"
CONV = "8efd458a-f165-4ccc-9033-33522db75f20"
PATIENT = "c53c77e9-d41e-41ec-85f8-70cb9634a934"

MESSAGES = [
    "السلام عليكم",
    "وانت كمان! بقالى يومين ضرسى بوجعنى وعايز احجز بأسرع وقت",
    "طيب كام الكشف عندكم؟ وهل عندكم تقويم؟",
    "طب تمام انا هبدأ بالكشف بس مش عارف اسم دكتور الضروس عندكم",
    "يلا احجزلى معاه بكرة لو فيه",
]

state = {
    "state_version": 3,
    "recent_turns": [],
    "last_updated": "2026-09-18T12:00:00Z",
    "booking_context": {"patient_name": "حسام"},
    "facts": {"patient": {"name": "حسام", "phone": "+966500000000"}},
    "conversation_stage": "GREETING",
}

async def main():
    inbound_base = {
        "clinic_id": CLINIC, "conversation_id": CONV, "patient_id": PATIENT,
        "channel_type": "telegram", "channel_id": "+966500000000",
        "source_event_id": "talk-test", "time_context": {
            "source": "runtime_now", "now_iso": "2026-09-18T12:00:00Z",
            "now_local_date": "2026-09-18", "schema_version": 2}}

    for i, text in enumerate(MESSAGES, 1):
        inbound = dict(inbound_base, message_text=text, source_event_id=f"talk-{i}")
        normalized = normalize_mod.normalize_and_validate(inbound, {})
        clinic_context = await repository.get_clinic_context(normalized)
        ownership = stages_pre.validate_patient_ownership(clinic_context, {"normalize_validate": normalized})
        tctx = (ownership or {}).get("canonical_time_context") or {}
        doctor_fact = await repository.resolve_doctor_inquiry(
            {"normalized": normalized, "clinic_context": clinic_context, "state_data": state})
        service_fact = await repository.resolve_service_fact(
            {"normalized": normalized, "clinic_context": clinic_context, "state_data": state})
        persona_context = stages_pre.build_clinic_persona_context_deterministic(service_fact, {
            "get_clinic_context": clinic_context, "get_conversation_state": {"state_data": state},
            "normalize_validate": normalized, "get_recent_window_2h": {},
            "resolve_doctor_inquiry_deterministic": doctor_fact,
            "resolve_branch_inquiry_deterministic": {}})
        user_message = dialogue.build_user_message(clinic_context, tctx, normalized,
                                                   persona_context, state, None)
        turn = await dialogue.call_primary_model_with_tool(user_message, context={
            "clinic_id": CLINIC, "conversation_id": CONV, "patient_id": PATIENT,
            "state_data": state, "clinic_context": clinic_context,
            "persona_context": persona_context})
        tools = [(e["name"], json.dumps(e.get("arguments"), ensure_ascii=False)[:80])
                 for e in turn.tool_events]
        raw = str(turn)
        try:
            doc = json.loads(raw.strip().removeprefix("```json").removesuffix("```").strip())
            reply = doc.get("reply")
            intent = (doc.get("turn") or {}).get("intent")
        except Exception:
            reply, intent = raw[:200], "??"
        state.setdefault("recent_turns", []).extend([
            {"role": "user", "content": text},
            {"role": "assistant", "content": reply},
        ])
        print(f"\n─── T{i} patient: {text}")
        print(f"    intent={intent} tools={tools} llm_calls={turn.llm_calls}")
        print(f"    REPLY: {reply}")

asyncio.run(main())
