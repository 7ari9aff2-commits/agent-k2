"""Faithful port of the n8n `Respond To Patient` node response body.

Source: n8n_reference/extracted/respond_to_patient_body.js — the final HTTP response contract
sent to the WhatsApp sender. Keys and precedence are identical.
"""
from __future__ import annotations

from typing import Any, Dict, Optional


def _has_transport_error(value: Optional[Dict[str, Any]]) -> bool:
    """JS hasTransportError: error | errorMessage | errorDetails | statusCode>=400 | status>=400."""
    if not value:
        return False
    try:
        status_code = int(value.get("statusCode") or 0)
    except (TypeError, ValueError):
        status_code = 0
    try:
        status = int(value.get("status") or 0)
    except (TypeError, ValueError):
        status = 0
    return bool(value.get("error") or value.get("errorMessage") or value.get("errorDetails")
                or status_code >= 400 or status >= 400)


def build_final_response(
    normalized: Dict[str, Any],
    outgoing_message_id: Optional[str],
    save_initial: Dict[str, Any],
    save_retry: Optional[Dict[str, Any]],
    reply_guard_result: Optional[Dict[str, Any]],
    rendered_reply: Optional[str],
    response_policy_output: Dict[str, Any],
    processed_at_iso: str,
) -> Dict[str, Any]:
    """Source node: Respond To Patient (responseBody expression).

    reply_text precedence:
      1. state-save transport/stale failure -> 'تعذر حفظ حالة المحادثة حاول مرة أخرى'
      2. reply guard override (_reply_guard.override)
      3. rendered_reply from Extract Single Agent Reply
    """
    initial = save_initial or {}
    retry = save_retry or {}
    retry_ran = len(retry) > 0
    failed = (
        _has_transport_error(initial)
        or _has_transport_error(retry)
        or (retry_ran and retry.get("saved") is not True)
        or (not retry_ran and initial.get("saved") is False
            and initial.get("rejected_reason") != "CONCURRENT_STATE_STALE")
    )
    if failed:
        reply_text = "تعذر حفظ حالة المحادثة حاول مرة أخرى"
    else:
        guard = reply_guard_result or {}
        override = ((guard.get("_reply_guard") or {}).get("override")) if isinstance(guard.get("_reply_guard"), dict) else None
        reply_text = override if override else rendered_reply

    out = response_policy_output or {}
    guard = reply_guard_result or {}
    deterministic_override = bool(isinstance(guard.get("_reply_guard"), dict) and guard["_reply_guard"].get("override"))
    return {
        "reply_text": reply_text,
        "conversation_id": (normalized or {}).get("conversation_id"),
        "clinic_id": (normalized or {}).get("clinic_id"),
        "outgoing_message_id": outgoing_message_id or None,
        "response_code": out.get("response_code"),
        "metadata": {
            "intent": (out.get("output") or {}).get("intent"),
            "operation_status": (out.get("output") or {}).get("operation_status"),
            "appointment_id": (out.get("output") or {}).get("appointment_id"),
            "escalate": (out.get("output") or {}).get("escalate"),
            "proposed_action": (out.get("output") or {}).get("proposed_action"),
            "processed_at": processed_at_iso,
        },
        "_debug": {"deterministic_override": deterministic_override},
    }
