"""Parity tests for the Booking Assistant Agent user-message template port.

Mirrors agent_user_message_template.js branch by branch, including the
production mojibake persona fallbacks (kept intentionally).
"""
from app.services.dialogue import build_user_message, parse_contract_json


CLINIC = "123e4567-e89b-42d3-a456-426614174000"


def clinic_ctx(persona=None, doctor_count=2):
    return {"clinic_id": CLINIC, "clinic_name": "عيادة مرنة", "persona": persona or {}, "doctor_count": doctor_count}


def time_ctx():
    return {"timezone": "Asia/Riyadh", "now_local_date": "2026-09-16", "now_local_time": "18:00", "utc_offset": "+03:00"}


def test_persona_mojibake_fallbacks_kept():
    msg = build_user_message(clinic_ctx(), time_ctx(), {"message_text": "مرحبا"}, {}, {}, None)
    assert "┘å┘ê╪▒" in msg and "┘à╪│╪º╪╣╪»╪⌐ ╪º╪│╪¬┘é╪¿╪º┘ä ┘ê╪¡╪¼┘ê╪▓╪º╪¬" in msg  # production quirk preserved


def test_persona_values_used_when_present():
    persona = {"name": "سارة", "role": "موظفة استقبال", "tone": "friendly", "dialect": "egyptian"}
    msg = build_user_message(clinic_ctx(persona), time_ctx(), {"message_text": "x"}, {}, {}, None)
    assert '"assistant": "سارة"' in msg and '"dialect": "egyptian"' in msg


def test_faq_included_only_for_clinic_query_profile_with_results():
    faq = {"clinic_id": CLINIC, "results": [{"answer": "aa"}], "count": 1}
    msg = build_user_message(clinic_ctx(), time_ctx(), {"message_text": "x"}, {"agent_prompt_profile": "clinic_query"}, {}, faq)
    assert '"faq_facts"' in msg and "aa" in msg
    # wrong profile -> null faq_facts
    msg2 = build_user_message(clinic_ctx(), time_ctx(), {"message_text": "x"}, {"agent_prompt_profile": "booking"}, {}, faq)
    assert '"faq_facts": null' in msg2


def test_next_ask_visit_type_when_collecting_without_type():
    msg = build_user_message(clinic_ctx(), time_ctx(), {"message_text": "عايز أحجز"}, {}, {}, None)
    assert '"next_ask": "visit_type"' in msg


def test_next_ask_appointment_reference_when_requested():
    st = {"turn_directive": {"must_ask": ["appointment_id"]}}
    msg = build_user_message(clinic_ctx(), time_ctx(), {"message_text": "x"}, {}, st, None)
    assert '"next_ask": "appointment_reference"' in msg


def test_next_ask_follows_missing_order():
    # The order-based missing selection only runs when appointment_type is already known;
    # without it the template returns "visit_type" first (JS branch order preserved).
    st = {"missing_human_fields": ["patient_phone", "date", "patient_name"]}
    msg = build_user_message(clinic_ctx(), time_ctx(), {"message_text": "x"}, {}, st, None)
    assert '"next_ask": "visit_type"' in msg
    st2 = {"booking_context": {"appointment_type": "NEW_VISIT"},
           "missing_human_fields": ["patient_phone", "date", "patient_name"]}
    msg2 = build_user_message(clinic_ctx(), time_ctx(), {"message_text": "x"}, {}, st2, None)
    assert '"next_ask": "date"' in msg2  # order: date beats phone/name


def test_pending_confirmation_only_when_state_required():
    conf = {"action": "create_appointment", "doctor_name": "أحمد", "date": "2026-09-20", "time": "17:30", "expires_at": "x"}
    st_on = {"confirmation_target": conf, "confirmation_state": "required"}
    msg = build_user_message(clinic_ctx(), time_ctx(), {"message_text": "x"}, {}, st_on, None)
    assert '"pending_confirmation"' in msg and "أحمد" in msg and '"next_ask": null' in msg
    st_off = {"confirmation_target": conf, "confirmation_state": "none"}
    msg2 = build_user_message(clinic_ctx(), time_ctx(), {"message_text": "x"}, {}, st_off, None)
    assert '"pending_confirmation": null' in msg2 and '"next_ask": "visit_type"' in msg2


def test_offered_maps_rank_date_time_only():
    st = {"pending_offer": {"alternatives": [{"rank": 2, "slot_id": "s", "local_date": "2026-09-20", "local_time": "17:30", "extra": 1}]}}
    msg = build_user_message(clinic_ctx(), time_ctx(), {"message_text": "x"}, {}, st, None)
    assert '{"rank": 2, "date": "2026-09-20", "time": "17:30"}' in msg and "slot_id" not in msg.split('"offered":')[1].split("]")[0]


def test_parse_contract_strips_code_fences():
    raw = '```json\n{"schema_version":"k2.dialogue.v4","reply":"تمام"}\n```'
    out = parse_contract_json(raw)
    assert out["schema_version"] == "k2.dialogue.v4"
    try:
        parse_contract_json("not json")
        raised = False
    except ValueError:
        raised = True
    assert raised
