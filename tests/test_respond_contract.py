"""Parity tests for the Respond To Patient port (final HTTP response contract)."""
from app.pipeline.respond import build_final_response

NORMALIZED = {"conversation_id": "c-1", "clinic_id": "k-1"}
POLICY_OUT = {"response_code": "APPOINTMENT_CREATED",
              "output": {"intent": "booking_request", "operation_status": "completed",
                          "appointment_id": "a-9", "escalate": None, "proposed_action": "create_appointment"}}


def test_save_transport_failure_message_wins():
    out = build_final_response(NORMALIZED, "m-1", {"error": "boom"}, None, None, "رد", POLICY_OUT, "t")
    assert out["reply_text"] == "تعذر حفظ حالة المحادثة حاول مرة أخرى"


def test_save_http_status_counts_as_transport_error():
    out = build_final_response(NORMALIZED, "m-1", {"statusCode": 500}, None, None, "رد", POLICY_OUT, "t")
    assert out["reply_text"].startswith("تعذر حفظ")


def test_stale_save_rejected_is_not_failure_when_retry_did_not_run():
    initial = {"saved": False, "rejected_reason": "CONCURRENT_STATE_STALE"}
    out = build_final_response(NORMALIZED, "m-1", initial, None, None, "الرد المرسل", POLICY_OUT, "t")
    assert out["reply_text"] == "الرد المرسل"


def test_saved_false_without_retry_is_failure():
    out = build_final_response(NORMALIZED, "m-1", {"saved": False}, None, None, "الرد المرسل", POLICY_OUT, "t")
    assert out["reply_text"].startswith("تعذر حفظ")


def test_guard_override_precedence():
    guard = {"_reply_guard": {"override": "تم الحجز بنجاح يا فلان ✅"}}
    out = build_final_response(NORMALIZED, "m-1", {"saved": True}, {"saved": True}, guard, "الرد المرسل", POLICY_OUT, "t")
    assert out["reply_text"] == "تم الحجز بنجاح يا فلان ✅"
    assert out["_debug"]["deterministic_override"] is True


def test_rendered_reply_fallback_and_metadata():
    out = build_final_response(NORMALIZED, "m-1", {"saved": True}, {"saved": True}, None, "الرد المرسل", POLICY_OUT, "2026-09-16T18:00:00Z")
    assert out["reply_text"] == "الرد المرسل"
    assert out["conversation_id"] == "c-1" and out["clinic_id"] == "k-1"
    assert out["outgoing_message_id"] == "m-1"
    assert out["response_code"] == "APPOINTMENT_CREATED"
    assert out["metadata"]["appointment_id"] == "a-9"
    assert out["metadata"]["processed_at"] == "2026-09-16T18:00:00Z"
    assert out["_debug"]["deterministic_override"] is False
