"""Faithful port of the post-execution n8n code nodes (pure Python, no I/O).

Source nodes (extracted/code/) and their ports:
  Prepare_Single_Agent_Result_Context.js -> prepare_single_agent_result_context
  Extract_Single_Agent_Reply.js          -> extract_single_agent_reply
  Prepare_Operation_Claim_Input.js       -> prepare_operation_claim_input
  Apply_Operation_Claim_Deterministic.js -> apply_operation_claim_deterministic
  Prepare_Execute_Input.js               -> prepare_execute_input
  Prepare_Execute_Context.js             -> prepare_execute_context
  Prepare_Operation_Finalize_Input.js    -> prepare_operation_finalize_input
  Merge_Operation_Completion.js          -> merge_operation_completion
  Apply_Resolved_Booking_IDs_Deterministic.js -> apply_resolved_booking_ids_deterministic
  Prepare_Handoff_Input.js               -> prepare_handoff_input
  Validate_Child_Envelope.js             -> validate_child_envelope
  Restore_Handoff_Context.js             -> restore_handoff_context

Every $(NodeName).first().json read in the JS is an explicitly documented input
key (see each docstring). Arabic strings are byte-identical to the JS, including
the mojibake quirk in Prepare_Single_Agent_Result_Context (U+FFFD U+0085 where
the source lost the م byte).
"""
from __future__ import annotations

import base64
import json
import math
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# JS-semantics shims (private to this module; same contracts as app/core/llm_safety)
# ---------------------------------------------------------------------------

_UNDEFINED = object()
_NAN = float("nan")


def _js_truthy(value: Any) -> bool:
    if value is None or value is _UNDEFINED:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return not (value == 0 or (isinstance(value, float) and value != value))
    if isinstance(value, str):
        return value != ""
    return True  # dict/list are always truthy in JS


def _js_string(value: Any) -> str:
    if value is _UNDEFINED:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value:
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        if value.is_integer() and abs(value) < 1e21:
            return str(int(value))
        return repr(value)
    if isinstance(value, list):
        parts = []
        for item in value:
            if item is None or item is _UNDEFINED:
                parts.append("")
            elif isinstance(item, str):
                parts.append(item)
            else:
                parts.append(_js_string(item))
        return ",".join(parts)
    return "[object Object]"


_NUM_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def _js_number(value: Any) -> float:
    if value is _UNDEFINED:
        return _NAN
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if s == "":
            return 0.0
        low = s.lower()
        if low.startswith(("0x", "-0x", "+0x")):
            try:
                return float(int(s, 16))
            except ValueError:
                return _NAN
        if s in ("Infinity", "+Infinity"):
            return math.inf
        if s == "-Infinity":
            return -math.inf
        if _NUM_RE.match(s):
            try:
                return float(s)
            except ValueError:
                return _NAN
        return _NAN
    if isinstance(value, list):
        if len(value) == 0:
            return 0.0
        if len(value) == 1:
            return _js_number(value[0])
        return _NAN
    return _NAN


def _js_parse_int(value: Any, radix: int = 10) -> float:
    """JS parseInt: leading integer parse; NaN when no digits."""
    s = _js_string(value).strip()
    sign = 1.0
    if s[:1] in ("+", "-"):
        if s[0] == "-":
            sign = -1.0
        s = s[1:]
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"[:radix]
    out = ""
    for ch in s:
        if ch.lower() in digits:
            out += ch
        else:
            break
    if not out:
        return _NAN
    return sign * float(int(out, radix))


def _coalesce(*values: Any) -> Any:
    """JS `a ?? b` — first non-nullish value."""
    for v in values:
        if v is not None and v is not _UNDEFINED:
            return v
    return values[-1] if values else None


def _first_truthy(*values: Any) -> Any:
    """JS `a || b` — first JS-truthy value, else the last value."""
    for v in values[:-1]:
        if _js_truthy(v):
            return v
    return values[-1] if values else None


def _obj_or_empty(value: Any) -> Any:
    """JS `x && typeof x === 'object' ? x : {}` (dict/list pass, including [])."""
    if isinstance(value, (dict, list)):
        return value
    return {}


def _prop(obj: Any, key: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, _UNDEFINED)
    return _UNDEFINED


def _dig(obj: Any, *keys: str) -> Any:
    """JS optional chaining a?.b?.c."""
    cur = obj
    for k in keys:
        if cur is None or cur is _UNDEFINED:
            return _UNDEFINED
        cur = _prop(cur, k)
    return cur


def _has_key(obj: Any, key: str) -> bool:
    """JS `key !== undefined` / `'key' in obj` on a dict item."""
    return isinstance(obj, dict) and obj.get(key, _UNDEFINED) is not _UNDEFINED


def _imul(a: int, b: int) -> int:
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def _now_ms() -> float:
    return datetime.now(timezone.utc).timestamp() * 1000.0


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _date_parse(value: Any) -> float:
    s = value if isinstance(value, str) else _js_string(value)
    t = s.strip()
    if not t:
        return _NAN
    try:
        if re.match(r"^\d{4}-\d{2}-\d{2}$", t):
            dt = datetime.strptime(t, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            return dt.timestamp() * 1000.0
        iso = t[:-1] + "+00:00" if t.endswith(("Z", "z")) else t
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.astimezone()
        return dt.timestamp() * 1000.0
    except (ValueError, OSError, OverflowError):
        return _NAN


def _ws_collapse(value: Any) -> str:
    """JS .replace(/\\s+/g, ' ').trim()."""
    return re.sub(r"\s+", " ", _js_string(value)).strip()


# ---------------------------------------------------------------------------
# Prepare Single Agent Result Context
# ---------------------------------------------------------------------------

# Source mojibake kept byte-identical: in the extracted JS every م byte pair
# became U+FFFD U+0085 (e.g. 'مارس' -> '\ufffd\u0085ارس').
_AR_MONTHS_063 = [
    "يناير", "فبراير", "\ufffd\u0085ارس", "أبريل", "\ufffd\u0085ايو", "يونيو",
    "يوليو", "أغسطس", "سبت\ufffd\u0085بر", "أكتوبر", "نوف\ufffd\u0085بر", "ديس\ufffd\u0085بر",
]
_AR_WEEKDAYS_063 = [
    "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخ\ufffd\u0085يس", "الج\ufffd\u0085عة", "السبت",
]


def _natural_date_text_063(value: Any) -> Optional[str]:
    p = _js_string(_first_truthy(value, "")).strip().split("-")
    if len(p) != 3 or len(p[0]) != 4:
        return None
    y = _js_parse_int(p[0])
    m = _js_parse_int(p[1])
    d = _js_parse_int(p[2])
    if (
        not _is_finite_num(y) or not _is_finite_num(m) or not _is_finite_num(d)
        or m < 1 or m > 12 or d < 1 or d > 31
    ):
        return None
    # JS new Date(Date.UTC(y, m-1, d)).getUTCDay(): month/day rollover is normalised.
    day = datetime(int(y), int(m), 1, tzinfo=timezone.utc) + timedelta(days=int(d) - 1)
    weekday_index = (day.weekday() + 1) % 7  # JS getUTCDay: Sun=0..Sat=6
    return (
        "يو\ufffd\u0085 " + _AR_WEEKDAYS_063[weekday_index] + " "
        + _js_string(d) + " " + _AR_MONTHS_063[int(m) - 1]
    )


def _natural_time_text_063(value: Any) -> Optional[str]:
    s = _js_string(_first_truthy(value, "")).strip()
    i = s.find(":")
    if i < 1:
        return None
    h = _js_parse_int(s[:i])
    mi = s[i + 1:i + 3]
    if not _is_finite_num(h) or len(mi) != 2 or _js_number(mi) != _js_number(mi):
        return None
    hh = h % 12
    if hh == 0:
        hh = 12
    return _js_string(hh) + ":" + mi + " " + ("\ufffd\u0085ساءً" if h >= 12 else "صباحًا")


def _is_finite_num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_business_envelope(value: Any) -> bool:
    if not _js_truthy(value) or not isinstance(value, dict):
        return False
    facts = _prop(value, "facts")
    facts = facts if isinstance(facts, (dict, list)) else {}
    decision = _prop(value, "system_decision")
    decision = decision if isinstance(decision, (dict, list)) else {}
    return bool(
        _js_truthy(_prop(value, "response_code"))
        or _js_truthy(_prop(facts, "response_code"))
        or _js_truthy(_prop(decision, "response_code"))
        or _js_truthy(_prop(value, "operation_status"))
        or _js_truthy(_prop(facts, "operation_status"))
        or _js_truthy(_prop(value, "availability_outcome"))
        or _js_truthy(_prop(facts, "availability_outcome"))
        or _dig(value, "deterministic_slot_lookup", "executed") is True
        or _dig(decision, "deterministic_slot_lookup", "executed") is True
        or _prop(value, "operation_finalized") is True
        or _prop(value, "child_contract_checked") is True
        or _js_truthy(_prop(value, "mutation_status"))
    )


def _normalize_location(value: Any) -> Optional[Dict[str, Any]]:
    if not _js_truthy(value) or not isinstance(value, dict):
        return None
    cfg = _prop(value, "location_config")
    cfg = cfg if isinstance(cfg, dict) else {}
    return {
        **cfg,
        "address": _first_truthy(_prop(cfg, "address"), _prop(value, "address"), None),
        "maps_url": _first_truthy(_prop(cfg, "maps_url"), _prop(value, "maps_url"), _prop(value, "google_maps_url"), None),
        "is_placeholder": _prop(cfg, "is_placeholder") is True or _prop(value, "is_placeholder") is True,
    }


def prepare_single_agent_result_context(item: Dict[str, Any], inputs: Dict[str, Any]) -> Dict[str, Any]:
    """Source node: Prepare Single Agent Result Context (extracted/code/Prepare_Single_Agent_Result_Context.js).

    Args:
        item: current pipeline item ($json).
        inputs keys:
          response_policy          <- 'Response Policy (Deterministic)'
          merge_operation_completion <- 'Merge Operation Completion'
          clinic_persona_context   <- 'Build Clinic Persona Context (Deterministic)'
    Returns the merged source item plus single_agent_phase, execution_result
    (schema_version 2) and reply_brief (schema_version 1).
    """
    item = item or {}
    inputs = inputs or {}
    policy = _first_truthy(inputs.get("response_policy", _UNDEFINED), {})
    completion = _first_truthy(inputs.get("merge_operation_completion", _UNDEFINED), {})

    source: Dict[str, Any] = {
        **item,
        **(completion if _is_business_envelope(completion) else {}),
        **(policy if _is_business_envelope(policy) else {}),
    }
    policy_decision = _prop(policy, "system_decision")
    source_decision = _prop(source, "system_decision")
    decision = (
        source_decision
        if isinstance(source_decision, (dict, list))
        else (policy_decision if isinstance(policy_decision, (dict, list)) else {})
    )
    source_facts = _prop(source, "facts")
    facts = (
        source_facts
        if isinstance(source_facts, (dict, list))
        else (_prop(policy, "facts") if isinstance(_prop(policy, "facts"), (dict, list)) else {})
    )
    action_candidate = _js_string(
        _first_truthy(
            _prop(decision, "action"),
            _dig(decision, "confirmation_target", "action"),
            _prop(source, "operation"),
            _dig(decision, "contract", "operation_proposal", "type"),
            _prop(facts, "confirmation_action"),
            "",
        )
    ).lower()
    action = "" if action_candidate == "none" else action_candidate
    code = _js_string(
        _first_truthy(_prop(source, "response_code"), _prop(facts, "response_code"), _prop(decision, "response_code"), "")
    ).upper()
    status = _js_string(
        _first_truthy(_prop(source, "operation_status"), _prop(facts, "operation_status"), _prop(decision, "operation_status"), "")
    ).lower()
    terminal_codes = {
        "APPOINTMENT_CREATED", "CREATE_COMPLETED", "CANCEL_COMPLETED", "RESCHEDULE_COMPLETED",
        "IDEMPOTENT_REPLAY", "REPLAY_FINAL", "OPERATION_IN_PROGRESS", "OPERATION_INCONCLUSIVE",
        "OPERATION_ID_CONFLICT", "CLAIM_NOT_GRANTED", "CHILD_CONTRACT_INVALID", "RPC_ERROR",
        "APPOINTMENT_CREATION_FAILED", "CANCEL_RETRYABLE", "RESCHEDULE_RETRYABLE",
        "CANCELLATION_NOT_ALLOWED", "RESCHEDULE_NOT_ALLOWED", "RESCHEDULE_CONFLICT",
        "APPOINTMENT_NOT_FOUND_OR_NOT_OWNED", "SLOT_UNAVAILABLE", "BUSINESS_HOURS_VIOLATION",
        "BUSINESS_HOURS_UNAVAILABLE",
    }
    source_lookup = _prop(source, "deterministic_slot_lookup")
    facts_lookup = _prop(facts, "deterministic_slot_lookup")
    decision_lookup = _prop(decision, "deterministic_slot_lookup")
    lookup = (
        source_lookup if isinstance(source_lookup, (dict, list))
        else (facts_lookup if isinstance(facts_lookup, (dict, list))
              else (decision_lookup if isinstance(decision_lookup, (dict, list)) else {}))
    )
    availability_lookup = _prop(lookup, "executed") is True
    availability_outcome = _js_string(
        _first_truthy(_prop(source, "availability_outcome"), _prop(facts, "availability_outcome"), _prop(lookup, "availability_outcome"), "")
    ).strip().upper()

    def _alternatives_of(*values: Any) -> List[Any]:
        for v in values:
            if isinstance(v, list):
                return v
        return []

    raw_alternatives = _alternatives_of(
        _prop(source, "availability_alternatives"),
        _prop(facts, "availability_alternatives"),
        _prop(lookup, "alternatives"),
    )
    # Defined in the source but never read afterwards (dead since v2026-09-03); kept.
    _availability_has_result = bool(
        availability_lookup
        and (
            _js_truthy(availability_outcome)
            or len(raw_alternatives) > 0
            or _js_truthy(_prop(lookup, "result_code"))
            or _prop(lookup, "slot_found") is True
            or _prop(lookup, "matched") is True
        )
    )
    explicit_execution_evidence = bool(
        _prop(source, "execution_completed") is True
        or _prop(source, "operation_completed") is True
        or _prop(source, "operation_finalized") is True
        or _dig(source, "execution_result", "execution_completed") is True
        or _dig(source, "execution_result", "operation_completed") is True
    )
    operation_identity_evidence = bool(
        _js_truthy(_prop(source, "operation_id"))
        or _js_truthy(_prop(decision, "operation_id"))
        or _js_truthy(_prop(facts, "operation_id"))
    )
    mutation_evidence = bool(
        _js_truthy(_prop(source, "mutation_status"))
        or _js_truthy(_prop(source, "operation_mutation_status"))
        or _js_truthy(_prop(facts, "mutation_status"))
    )
    child_evidence = _prop(source, "child_contract_checked") is True or _prop(facts, "child_contract_checked") is True
    execution_status = status in ("success", "failed", "failed_retryable", "failed_final", "completed", "in_progress", "conflict")
    mutation_execution_evidence = operation_identity_evidence and (
        mutation_evidence or child_evidence or execution_status or code in terminal_codes
    )
    # v2026-09-03 STRICT: the Composer only runs for genuine execution results or
    # availability results with real alternatives; everything else stays with Agent 1.
    result_phase = bool(
        explicit_execution_evidence
        or mutation_execution_evidence
        or (availability_lookup and len(raw_alternatives) > 0)
    )
    source_booking_context = _prop(source, "booking_context")
    facts_booking_context = _prop(facts, "booking_context")
    confirmed_booking_context = (
        source_booking_context if isinstance(source_booking_context, (dict, list))
        else (facts_booking_context if isinstance(facts_booking_context, (dict, list)) else {})
    )
    entities = _prop(facts, "entities")
    entities = entities if isinstance(entities, (dict, list)) else {}
    human_alternatives = []
    for slot in raw_alternatives[:16]:
        s = slot if isinstance(slot, (dict, list)) else {}
        human_alternatives.append({
            "rank": _coalesce(_prop(s, "rank"), None),
            "label": _first_truthy(_prop(s, "label"), None),
            "date": _first_truthy(_prop(s, "date"), _prop(s, "local_date"), None),
            "time": _first_truthy(_prop(s, "time"), _prop(s, "local_time"), None),
            "start_time": _first_truthy(_prop(s, "start_time"), None),
            "end_time": _first_truthy(_prop(s, "end_time"), None),
            "doctor_name": _first_truthy(_prop(s, "doctor_name"), None),
            "service_name": _first_truthy(_prop(s, "service_name"), None),
            "slot_status": _first_truthy(_prop(s, "slot_status"), None),
        })
    finalized_result = _prop(source, "operation_finalize_response")
    finalized_result = finalized_result if isinstance(finalized_result, (dict, list)) else {}
    location_config = None
    branch_loc = _dig(source, "branch_location", "location_config")
    if isinstance(branch_loc, (dict, list)):
        location_config = branch_loc
    elif isinstance(_prop(source, "clinic_location"), (dict, list)):
        location_config = _prop(source, "clinic_location")
    else:
        facts_branch_loc = _dig(source_facts, "branch_location", "location_config") if _js_truthy(source_facts) else _UNDEFINED
        if isinstance(facts_branch_loc, (dict, list)):
            location_config = facts_branch_loc
        elif isinstance(_prop(source_facts, "clinic_location"), (dict, list)):
            location_config = _prop(source_facts, "clinic_location")
        else:
            location_config = {}
    queue_path_candidate = _first_truthy(
        _prop(source, "queue_path"),
        _prop(source_facts, "queue_path") if _js_truthy(source_facts) else _UNDEFINED,
        _prop(finalized_result, "queue_path"),
        None,
    )
    queue_base_url = re.sub(r"/+$", "", _js_string(_first_truthy(_prop(location_config, "queue_base_url"), "")).strip())
    if _js_truthy(queue_path_candidate):
        queue_str = _js_string(queue_path_candidate)
        if re.match(r"^https?://", queue_str, re.IGNORECASE):
            tenant_queue_url: Optional[str] = queue_str
        elif _js_truthy(queue_base_url):
            tenant_queue_url = queue_base_url + "/" + re.sub(r"^/+", "", queue_str)
        else:
            tenant_queue_url = None
    else:
        tenant_queue_url = None
    normalized_branch_location = _normalize_location(_first_truthy(_prop(source, "branch_location"), _prop(source_facts, "branch_location") if _js_truthy(source_facts) else _UNDEFINED))
    normalized_clinic_location = _normalize_location(_first_truthy(_prop(source, "clinic_location"), _prop(source_facts, "clinic_location") if _js_truthy(source_facts) else _UNDEFINED))
    operation = action or ("check_availability" if availability_lookup else None)
    execution_result: Dict[str, Any] = {
        "schema_version": 2,
        "operation": operation,
        "response_code": code or None,
        "operation_status": _first_truthy(_prop(source, "operation_status"), _prop(facts, "operation_status"), None),
        "success": _prop(source, "success") is True or _prop(facts, "success") is True,
        "retryable": _prop(source, "retryable") is True or _prop(facts, "retryable") is True,
        "mutation_status": _first_truthy(_prop(source, "mutation_status"), _prop(source, "operation_mutation_status"), _prop(facts, "mutation_status"), None),
        "booking_number": _first_truthy(
            _prop(source, "booking_number"),
            _prop(facts, "booking_number"),
            _prop(finalized_result, "booking_number"),
            _prop(confirmed_booking_context, "booking_number"),
            None,
        ),
        "booking_id": _first_truthy(
            _prop(source, "booking_id"),
            _prop(facts, "booking_id"),
            _prop(finalized_result, "booking_id"),
            None,
        ),
        "branch_id": _first_truthy(
            _prop(source, "branch_id"),
            _prop(facts, "branch_id"),
            _prop(finalized_result, "branch_id"),
            _prop(confirmed_booking_context, "branch_id"),
            None,
        ),
        "queue_number": _coalesce(_prop(source, "queue_number"), _prop(facts, "queue_number"), _prop(finalized_result, "queue_number"), None),
        "queue_path": queue_path_candidate,
        "queue_url": _first_truthy(
            _prop(source, "queue_url"),
            _prop(facts, "queue_url"),
            _prop(finalized_result, "queue_url"),
            tenant_queue_url,
        ),
        "queue_expires_at": _first_truthy(
            _prop(source, "queue_expires_at"),
            _prop(facts, "queue_expires_at"),
            _prop(finalized_result, "queue_expires_at"),
            None,
        ),
        "child_contract_checked": _prop(source, "child_contract_checked") is True or _prop(facts, "child_contract_checked") is True,
        "child_contract_valid": _prop(source, "child_contract_valid") is True or _prop(facts, "child_contract_valid") is True,
        "availability_outcome": _first_truthy(
            _prop(source, "availability_outcome"),
            _prop(facts, "availability_outcome"),
            _prop(lookup, "availability_outcome"),
            None,
        ),
        "availability_result_code": _first_truthy(
            _prop(lookup, "result_code"),
            _prop(source, "error_code"),
            _prop(facts, "error_code"),
            None,
        ),
        "availability_verification_status": _first_truthy(_prop(lookup, "verification_status"), None),
        "availability_search_mode": _first_truthy(
            _prop(source, "search_mode"),
            _prop(facts, "search_mode"),
            _prop(lookup, "search_mode"),
            None,
        ),
        "availability_nearby_search": (
            _prop(source, "nearby_search") is True
            or _prop(facts, "nearby_search") is True
            or _prop(lookup, "nearby_search") is True
        ),
        "availability_window_start": _first_truthy(
            _prop(source, "search_window_start"),
            _prop(facts, "search_window_start"),
            _prop(lookup, "search_window_start"),
            None,
        ),
        "availability_window_end": _first_truthy(
            _prop(source, "search_window_end"),
            _prop(facts, "search_window_end"),
            _prop(lookup, "search_window_end"),
            None,
        ),
        "availability_alternatives": human_alternatives,
        "proposed_reply": _first_truthy(
            _prop(source, "proposed_reply"),
            _prop(facts, "proposed_reply"),
            _prop(source, "deterministic_fallback_reply"),
            None,
        ),
        "doctor_name": _first_truthy(_prop(confirmed_booking_context, "doctor_name"), _prop(entities, "doctor_name"), None),
        "service_name": _first_truthy(_prop(confirmed_booking_context, "service_name"), _prop(entities, "service_name"), None),
        "date": _first_truthy(_prop(confirmed_booking_context, "date"), _prop(lookup, "requested_date"), None),
        "date_natural": _first_truthy(
            _natural_date_text_063(_first_truthy(_prop(confirmed_booking_context, "date"), _prop(lookup, "requested_date"))),
            None,
        ),
        "time": _first_truthy(_prop(confirmed_booking_context, "time"), _prop(lookup, "requested_time"), None),
        "time_natural": _first_truthy(
            _natural_time_text_063(_first_truthy(_prop(confirmed_booking_context, "time"), _prop(lookup, "requested_time"))),
            None,
        ),
        "patient_name": _first_truthy(_prop(confirmed_booking_context, "patient_name"), _prop(facts, "patient_name"), None),
        "patient_phone": _first_truthy(_prop(confirmed_booking_context, "patient_phone"), _prop(facts, "patient_phone"), None),
        "patient_age": _coalesce(_prop(confirmed_booking_context, "patient_age"), _prop(facts, "patient_age"), None),
        "patient_address": _first_truthy(_prop(confirmed_booking_context, "patient_address"), _prop(facts, "patient_address"), None),
        "clinic_name": _first_truthy(_prop(facts, "clinic_name"), _prop(source, "clinic_name"), None),
        "branch_location": normalized_branch_location,
        "clinic_location": normalized_clinic_location,
        "error": _first_truthy(_prop(source, "error"), _prop(source, "error_code"), _prop(lookup, "result_code"), None),
    }
    # Phase 5: directive-driven reply brief — the only conversational guidance Model 2 gets.
    persona_context = _first_truthy(inputs.get("clinic_persona_context", _UNDEFINED), {})
    persona = _prop(persona_context, "clinic_persona")
    persona = persona if isinstance(persona, (dict, list)) else {}
    decision_directive = _prop(decision, "turn_directive")
    source_directive = _prop(source, "turn_directive")
    turn_directive = (
        decision_directive if isinstance(decision_directive, (dict, list))
        else (source_directive if isinstance(source_directive, (dict, list)) else None)
    )
    live_offer = (
        _prop(source, "presented_offer") if isinstance(_prop(source, "presented_offer"), (dict, list))
        else (_prop(source, "pending_offer") if isinstance(_prop(source, "pending_offer"), (dict, list)) else None)
    )
    offer_alternatives = _prop(live_offer, "alternatives") if _js_truthy(live_offer) else _UNDEFINED
    offer_alternatives = offer_alternatives if isinstance(offer_alternatives, list) else []
    brief_source = offer_alternatives if len(offer_alternatives) > 0 else raw_alternatives
    brief_alternatives = []
    for slot in brief_source[:4]:
        s = slot if isinstance(slot, (dict, list)) else {}
        brief_alternatives.append({
            "rank": _coalesce(_prop(s, "rank"), None),
            "label": _first_truthy(_prop(s, "label"), None),
            "date": _first_truthy(_prop(s, "local_date"), _prop(s, "date"), None),
            "time": _first_truthy(_prop(s, "local_time"), _prop(s, "time"), None),
        })
    decision_target = _prop(decision, "confirmation_target")
    source_target = _prop(source, "confirmation_target")
    confirm_target = (
        decision_target if isinstance(decision_target, (dict, list))
        else (source_target if isinstance(source_target, (dict, list)) else None)
    )
    decision_review = _prop(decision, "patient_data_review")
    source_review = _prop(source, "patient_data_review")
    patient_review = (
        decision_review if isinstance(decision_review, (dict, list))
        else (source_review if isinstance(source_review, (dict, list)) else None)
    )
    source_missing = _prop(source, "missing_human_fields")
    decision_missing = _prop(decision, "missing_human_fields")
    missing_human_fields = (
        source_missing if isinstance(source_missing, list)
        else (decision_missing if isinstance(decision_missing, list) else [])
    )
    locked_fields = (
        _prop(turn_directive, "locked_fields")
        if (_js_truthy(turn_directive) and isinstance(_prop(turn_directive, "locked_fields"), list))
        else []
    )
    reply_brief: Dict[str, Any] = {
        "schema_version": 1,
        "response_code": code or None,
        "dialect": _first_truthy(_prop(persona, "dialect"), "ar"),
        "directive": turn_directive,
        "alternatives": brief_alternatives if len(brief_alternatives) > 0 else None,
        "confirmation_request": (
            {
                "action": _first_truthy(_prop(confirm_target, "action"), action, None),
                "doctor_name": _first_truthy(_prop(confirm_target, "doctor_name"), _prop(execution_result, "doctor_name"), None),
                "service_name": _first_truthy(_prop(confirm_target, "service_name"), _prop(execution_result, "service_name"), None),
                "date": _first_truthy(_prop(confirm_target, "date"), None),
                "date_natural": _first_truthy(_natural_date_text_063(_prop(confirm_target, "date")), None),
                "time": _first_truthy(_prop(confirm_target, "time"), None),
                "time_natural": _first_truthy(_natural_time_text_063(_prop(confirm_target, "time")), None),
                "appointment_type": _first_truthy(_prop(confirm_target, "appointment_type"), None),
                "booking_number": _first_truthy(_prop(confirm_target, "booking_number"), _prop(execution_result, "booking_number"), None),
                "appointment_id": _first_truthy(_prop(confirm_target, "appointment_id"), None),
            }
            if _js_truthy(confirm_target)
            else None
        ),
        "patient_review": (
            {"fields": _prop(patient_review, "fields"), "status": _first_truthy(_prop(patient_review, "status"), None)}
            if (_js_truthy(patient_review) and _js_truthy(_prop(patient_review, "fields")))
            else None
        ),
        "missing_human_fields": missing_human_fields,
        "locked_fields": locked_fields,
    }
    return {
        **source,
        "single_agent_phase": "result" if result_phase else "understand",
        "execution_result": execution_result,
        "reply_brief": reply_brief,
    }


# ---------------------------------------------------------------------------
# Extract Single Agent Reply
# ---------------------------------------------------------------------------

_UNVERIFIED_SUCCESS_CLAIM_RE = re.compile(
    "(?:حجزك\\s+تم|تم\\s+(?:تأكيد|تأكيده|تأكيد الحجز|حجز|تثبيت)|سيصلك\\s+تأكيد|أكدنا\\s+لك|تم اعتماد الحجز|أصبح\\s+حجزك|ثبتنا\\s+الحجز|ثبتنا\\s+موعدك|(?:حجز|تأكيد)[^\\n]{0,24}مؤكد|مؤكد[^\\n]{0,24}(?:حجز|تأكيد))",
    re.IGNORECASE,
)
_CLAIM_RE = re.compile(
    r"(نثبت|ثبت)\s*(?:لك)?\s*(?:الموعد|الحجز)|تم\s+(?:الحجز|التثبيت|تأكيد\s*الحجز)|اتأكد\s*(?:الحجز)?|اتسجل\s*(?:الحجز|لك)"
)
_NEGATION_BEFORE_RE = re.compile(r"(?:مش|ما\s|مفيش|لن|لما|غير)(?:[\sه]{1,2})?\Z")
# Same byte-for-byte char class as the JS regex literal (\\ -> backslash, \- -> hyphen).
_PUNCT_CLASS = "[،,؛;:.!?؟!؟\"“”'‘’()\\[\\]{}<>…ـ\\-_/\\\\|@#$%^&*+=~`]"
_PUNCT_RE = re.compile(_PUNCT_CLASS)
_SEMANTIC_TOKEN_RE = re.compile(
    r"(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
    r"|https?://[^\s]+"
    r"|[0-9٠-٩]{1,2}:[0-9٠-٩]{2}(?:\s*(?:صباح(?:ا|ًا)?|مساء(?:ا|ًا)?|صباحًا|مساءً))?"
    r"|[0-9٠-٩]{1,4}[/-][0-9٠-٩]{1,2}(?:[/-][0-9٠-٩]{1,4})?"
    r"|[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}"
    r"|[A-Za-z0-9_]{2,}-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{2,})"
)
# JS literal /\/|end_of_thinking\|/ replacement — Python: escaped pipes.
_END_OF_THINKING_RE = re.compile(r"<\|end_of_thinking\|>", re.IGNORECASE)
# JS \b is ASCII-\w based; explicit lookarounds reproduce it exactly.
_NEW_VISIT_RE = re.compile(r"(?<![0-9A-Za-z_])NEW(?:[_ -]?VISIT)(?![0-9A-Za-z_])", re.IGNORECASE)
_FOLLOW_UP_RE = re.compile(r"(?<![0-9A-Za-z_])FOLLOW(?:[_ -]?UP)(?![0-9A-Za-z_])", re.IGNORECASE)
_ARABIC_FIRST_VISIT_RE = re.compile(r"(?:زيارتك|الزيارة|الزياره|زيارة|زياره)\s+(?:الأولى|الاولي|أولى|اولى)", re.IGNORECASE)
_HELLO_QUESTION_RE = re.compile(r"^\s*هل")


def _parse_reply_candidate(value: Any, depth: int = 0) -> str:
    if depth > 4 or value is None or value is _UNDEFINED:
        return ""
    if isinstance(value, (dict, list)):
        inner = _js_string(_first_truthy(_prop(value, "reply"), _prop(value, "final_reply"), _prop(value, "result_reply_text"), _prop(value, "output"), "")).strip()
        if _js_truthy(inner):
            return inner
        return _parse_reply_candidate(_prop(value, "message"), depth + 1) or _parse_reply_candidate(_prop(value, "content"), depth + 1)
    text = _js_string(value).strip()
    if not _js_truthy(text):
        return ""
    unfenced = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    unfenced = re.sub(r"\s*```\Z", "", unfenced, flags=re.IGNORECASE).strip()
    try:
        parsed = json.loads(unfenced)
        return _parse_reply_candidate(parsed, depth + 1)
    except ValueError:
        pass
    # Some n8n/LangChain outputs contain two adjacent JSON objects; extract
    # balanced objects one by one instead of first-to-last braces.
    # Source quirk kept: the escaped flag can never latch (the JS compares a
    # single char against the two-char string '\\\\'), so backslash escaping
    # inside quoted sections is NOT honoured here.
    for start in range(len(unfenced)):
        if unfenced[start] != "{" and unfenced[start] != "[":
            continue
        open_c = unfenced[start]
        close_c = "}" if open_c == "{" else "]"
        depth_count = 0
        quoted = False
        end = start
        while end < len(unfenced):
            ch = unfenced[end]
            if quoted:
                if ch == '"':
                    quoted = False
                end += 1
                continue
            if ch == '"':
                quoted = True
                end += 1
                continue
            if ch == open_c:
                depth_count += 1
            elif ch == close_c:
                depth_count -= 1
            if depth_count == 0:
                try:
                    parsed = json.loads(unfenced[start:end + 1])
                    found = _parse_reply_candidate(parsed, depth + 1)
                    if _js_truthy(found):
                        return found
                except ValueError:
                    pass
                break
            end += 1
    return ""


def _plain_reply_candidate(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not _js_truthy(text) or text.startswith("{") or text.startswith("["):
        return ""
    return text


# Byte-identical port of the JS escape regex (which, as written, matches one
# special char followed by two literal backslashes and a ']' — effectively inert
# for normal field names; the quirk is preserved).
_FIELD_ESCAPE_RE = re.compile(r"[.*+?^${}()|[\\]\\\\]")
_BS2 = "\\\\"


def _extract_completed_json_string_field(value: Any, field_name: Any) -> str:
    text = _js_string(_first_truthy(value, ""))
    field_pattern = re.compile(
        '"' + _FIELD_ESCAPE_RE.sub(lambda m: _BS2 + m.group(0), _js_string(field_name)) + r'"\s*:\s*"',
        re.IGNORECASE,
    )
    m = field_pattern.search(text)
    if not m:
        return ""
    opening_quote = m.start() + m.group(0).rfind('"')
    end = opening_quote + 1
    while end < len(text):
        if text[end] != '"':
            end += 1
            continue
        # Source quirk kept: slashCount can never increment (single char compared
        # against the two-char string '\\\\'), so escaped quotes always terminate.
        try:
            parsed = json.loads(text[opening_quote:end + 1])
            return parsed.strip() if isinstance(parsed, str) else ""
        except ValueError:
            return ""
    return ""


def _strip_unsupported_doctor_specializations(value: Any, reply_source: Dict[str, Any], inputs: Dict[str, Any]) -> str:
    text = _ws_collapse(_first_truthy(value, ""))
    booking_turn = False
    service_evidence = False
    specialties: List[str] = []
    try:
        contract = _first_truthy(_prop(reply_source, "contract"), {})
        intent = _js_string(_first_truthy(_dig(contract, "turn", "intent"), _dig(reply_source, "turn", "intent"), "")).lower()
        booking_turn = intent in ("booking_request", "booking_continuation") or _js_string(
            _first_truthy(_dig(reply_source, "routing", "target"), "")
        ).lower() == "booking"
        service_evidence = bool(
            _js_truthy(_dig(contract, "entities", "service_name")) or _js_truthy(_prop(reply_source, "service_name"))
        )
    except Exception:
        pass
    try:
        nv = _first_truthy(inputs.get("normalize_validate", _UNDEFINED), {})
        current_text = unicodedata.normalize("NFKC", _js_string(_first_truthy(_prop(nv, "message_text"), ""))).lower()
        resolver = _first_truthy(inputs.get("service_fact_resolver", _UNDEFINED), {})
        service_evidence = service_evidence or bool(
            _js_truthy(_prop(resolver, "service_name"))
            or _js_truthy(_prop(resolver, "is_service_fact_inquiry"))
            or _js_truthy(_prop(resolver, "is_price_inquiry"))
            or _js_truthy(_prop(resolver, "is_service_catalog_inquiry"))
        )
        catalog = _prop(resolver, "catalog")
        catalog = catalog if isinstance(catalog, list) else []
        service_evidence = service_evidence or any(
            _js_truthy(_dig(entry, "service_name"))
            and _js_string(_dig(entry, "service_name")).lower() in current_text
            for entry in catalog
        )
        clinic = _first_truthy(inputs.get("clinic_context", _UNDEFINED), {})
        directory = _prop(clinic, "doctor_directory")
        directory = directory if isinstance(directory, list) else []
        specialties = [
            _js_string(_first_truthy(_dig(entry, "specialization"), "")).strip() for entry in directory
        ]
        specialties = sorted([s for s in specialties if _js_truthy(s)], key=len, reverse=True)
        service_evidence = service_evidence or any(term.lower() in current_text for term in specialties)
    except Exception:
        pass
    if not booking_turn or service_evidence or not specialties:
        return text
    for term in specialties:
        text = text.replace(term, "")
    return re.sub(r"\s{2,}", " ", text).strip()


def _strip_reply_punctuation(value: Any, preserve_confirmation_layout: bool) -> str:
    protected_tokens: List[str] = []
    source_text = _js_string(_first_truthy(value, ""))

    def _protect(match: "re.Match[str]") -> str:
        token = match.group(0)
        protected_tokens.append(token)
        return "K2SEMANTICTOKEN" + str(len(protected_tokens) - 1) + "K"

    protected_text = _SEMANTIC_TOKEN_RE.sub(_protect, source_text)
    if preserve_confirmation_layout:
        cleaned_lines = []
        for line in re.split(r"\r?\n", protected_text):
            cleaned = _PUNCT_RE.sub("", line)
            cleaned = re.sub(r"[ \t]+", " ", cleaned).strip()
            if _js_truthy(cleaned):
                cleaned_lines.append(cleaned)
        cleaned = "\n".join(cleaned_lines)
    else:
        cleaned = _PUNCT_RE.sub("", protected_text)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
    for index, token in enumerate(protected_tokens):
        cleaned = cleaned.replace("K2SEMANTICTOKEN" + str(index) + "K", token, 1)
    return cleaned


def _claim_safe(text: Any) -> str:
    s = _js_string(_first_truthy(text, ""))

    def _repl(match: "re.Match[str]") -> str:
        before = s[max(0, match.start() - 10):match.start()]
        return match.group(0) if _NEGATION_BEFORE_RE.search(before) else "تمام"

    return re.sub(r"\s{2,}", " ", _CLAIM_RE.sub(_repl, s)).strip()


def extract_single_agent_reply(item: Dict[str, Any], inputs: Dict[str, Any]) -> Dict[str, Any]:
    """Source node: Extract Single Agent Reply (extracted/code/Extract_Single_Agent_Reply.js).

    Args:
        item: current pipeline item ($json) delivered by the gate (single explicit
            final-reply selector; no cross-branch .first() resurrection).
        inputs keys:
          response_policy      <- 'Response Policy (Deterministic)' (authoritative envelope)
          clinic_persona_context <- 'Build Clinic Persona Context (Deterministic)'
                                    (is_conversation_start; computed but unused, as in the JS)
          normalize_validate   <- 'Normalize & Validate' (message_text for specialization strip)
          service_fact_resolver <- 'Resolve Service Fact (Deterministic)'
          clinic_context       <- 'Get Clinic Context' (doctor_directory specializations)
    Returns the source envelope plus rendered_reply / final_reply / canonical_reply,
    render_error, render_used, single_model, single_agent_phase. Raises nothing;
    empty replies fall back to the deterministic stage plan / fallback text.
    """
    input_item = item or {}
    inputs = inputs or {}
    # Source aliases kept: `normalized` is computed but never read; `composed`
    # and `source` all start as the current input.
    normalized_unused = input_item
    composed = input_item
    source: Dict[str, Any] = input_item

    policy_snapshot = _first_truthy(inputs.get("response_policy", _UNDEFINED), {})
    reply_source: Dict[str, Any] = {**policy_snapshot, **input_item}

    composer_phase = bool(
        _prop(input_item, "single_agent_phase") == "result"
        or _prop(input_item, "agent_phase") == "result"
        or _prop(composed, "single_agent_phase") == "result"
        or _prop(reply_source, "single_agent_phase") == "result"
    )
    composer_raw = _first_truthy(
        _prop(input_item, "result_reply_text"),
        _prop(input_item, "composer_reply"),
        _prop(reply_source, "result_reply_text"),
        _prop(composed, "result_reply_text"),
        _prop(composed, "output"),
        _prop(input_item, "output"),
        "",
    )
    if composer_phase:
        plain_fallback = ""
        if isinstance(composer_raw, str) and not composer_raw.strip().startswith("{"):
            plain_fallback = composer_raw.strip()
        composed_reply_candidate = _parse_reply_candidate(composer_raw) or plain_fallback
    else:
        composed_reply_candidate = ""

    first_agent_reply_candidate = (
        _plain_reply_candidate(_prop(reply_source, "agent_reply"))
        or _parse_reply_candidate(_prop(reply_source, "agent_reply"))
        or _plain_reply_candidate(_dig(reply_source, "contract", "reply"))
        or _parse_reply_candidate(_dig(reply_source, "contract", "reply"))
        or _plain_reply_candidate(_prop(reply_source, "final_reply"))
        or _parse_reply_candidate(_prop(reply_source, "final_reply"))
        or _plain_reply_candidate(_prop(reply_source, "canonical_reply"))
        or _parse_reply_candidate(_prop(reply_source, "canonical_reply"))
        or _parse_reply_candidate(_prop(reply_source, "output"))
        or _extract_completed_json_string_field(_prop(reply_source, "agent_raw_output"), "reply")
        or _extract_completed_json_string_field(_prop(reply_source, "output"), "reply")
    )
    first_agent_reply = first_agent_reply_candidate

    terminal_success_code = {"APPOINTMENT_CREATED", "CREATE_COMPLETED", "IDEMPOTENT_REPLAY"}
    policy_code = _js_string(
        _first_truthy(
            _prop(reply_source, "response_code"),
            _dig(reply_source, "facts", "response_code"),
            _dig(reply_source, "system_decision", "response_code"),
            "",
        )
    ).strip().upper()
    verified_success = bool(
        policy_code in terminal_success_code
        and (
            _prop(reply_source, "success") is True
            or _dig(reply_source, "facts", "success") is True
            or _dig(reply_source, "execution_result", "success") is True
        )
        and (
            _prop(reply_source, "child_contract_valid") is True
            or _dig(reply_source, "facts", "child_contract_valid") is True
            or _dig(reply_source, "execution_result", "child_contract_valid") is True
            or policy_code == "IDEMPOTENT_REPLAY"
        )
    )

    def safe_reply_candidate(candidate: Any) -> str:
        text = _js_string(_first_truthy(candidate, "")).strip()
        if not _js_truthy(text):
            return ""
        if not verified_success and _UNVERIFIED_SUCCESS_CLAIM_RE.search(text):
            return ""
        return text

    composed_reply = safe_reply_candidate(composed_reply_candidate)
    safe_first_agent_reply = safe_reply_candidate(first_agent_reply)
    reply = composed_reply or safe_first_agent_reply
    # A trusted agent_reply may already be plain patient-facing text.
    if not _js_truthy(reply) and isinstance(_prop(reply_source, "agent_reply"), str) and _js_truthy(_js_string(_prop(reply_source, "agent_reply")).strip()):
        reply = safe_reply_candidate(_prop(reply_source, "agent_reply"))
    if not _js_truthy(reply) and isinstance(_prop(input_item, "output"), str) and not _js_string(_prop(input_item, "output")).strip().startswith("{"):
        reply = _js_string(_prop(input_item, "output")).strip()

    layout_code = _js_string(_first_truthy(_prop(reply_source, "response_code"), _prop(source, "response_code"), "")).upper()
    preserve_confirmation_layout = layout_code in ("APPOINTMENT_CREATED", "IDEMPOTENT_REPLAY")
    if preserve_confirmation_layout:
        cleaned_lines = []
        for line in re.split(r"\r?\n", _js_string(_first_truthy(reply, ""))):
            cleaned = re.sub(r"[ \t]+", " ", line).strip()
            if _js_truthy(cleaned):
                cleaned_lines.append(cleaned)
        reply = "\n".join(cleaned_lines)
    else:
        reply = re.sub(r"\s+", " ", _js_string(_first_truthy(reply, ""))).strip()

    # Response Policy is authoritative for the current deterministic envelope.
    source = reply_source

    # Dead variable in the source (computed, never read); ported for fidelity.
    is_conversation_start = False
    try:
        is_conversation_start = _prop(
            _first_truthy(inputs.get("clinic_persona_context", _UNDEFINED), {}), "is_conversation_start"
        ) is True
    except Exception:
        pass

    # Current message text used by the specialization stripper below.
    current_response_code = ""
    try:
        current_response_code = _js_string(
            _first_truthy(_prop(_first_truthy(inputs.get("response_policy", _UNDEFINED), {}), "response_code"), "")
        ).upper()
    except Exception:
        current_response_code = ""

    # Dead variable in the source (computed, never read); ported for fidelity.
    terminal_success = current_response_code in ("APPOINTMENT_CREATED", "CANCEL_COMPLETED", "RESCHEDULE_COMPLETED", "IDEMPOTENT_REPLAY")

    # ORCH-NATURAL: stage asks are a SAFETY NET, never a replacement.
    def _stage_plan() -> Optional[Dict[str, Any]]:
        code_plan = current_response_code
        sd = _first_truthy(_prop(reply_source, "system_decision"), {})
        bc = _first_truthy(_prop(reply_source, "booking_context"), _prop(sd, "booking_context"), {})

        def fmt_time(t: Any) -> str:
            s = _js_string(_first_truthy(t, ""))
            i = s.find(":")
            if i < 1:
                return s
            h = _js_parse_int(s[:i])
            mi = s[i + 1:i + 3]
            if not _is_finite_num(h) or len(mi) != 2 or _js_number(mi) != _js_number(mi):
                return s
            hh = h % 12
            if hh == 0:
                hh = 12
            return _js_string(hh) + ":" + mi + (" مساءً" if h >= 12 else " صباحًا")

        stage_months = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]

        def fmt_date(d: Any) -> str:
            p = _js_string(_first_truthy(d, "")).split("-")
            if len(p) != 3 or len(p[0]) != 4:
                return _js_string(_first_truthy(d, ""))
            day = _js_parse_int(p[2])
            month_index = _js_parse_int(p[1]) - 1
            month = stage_months[int(month_index)] if _is_finite_num(month_index) and 0 <= int(month_index) < 12 else None
            return _js_string(day) + " " + _js_string(month)

        # BOOKING CARD: terminal success renders a deterministic formatted card.
        if code_plan == "APPOINTMENT_CREATED" or code_plan == "IDEMPOTENT_REPLAY":
            er = _first_truthy(_prop(input_item, "execution_result"), _prop(reply_source, "execution_result"), {})
            t2 = _first_truthy(_prop(reply_source, "confirmation_target"), _prop(sd, "confirmation_target"), {})
            bc2 = _first_truthy(_prop(reply_source, "booking_context"), _prop(sd, "booking_context"), {})
            card_name = _first_truthy(_prop(er, "patient_name"), _prop(t2, "patient_name"), _prop(bc2, "patient_name"), None)
            card_phone = _first_truthy(_prop(er, "patient_phone"), _prop(t2, "patient_phone"), _prop(bc2, "patient_phone"), None)
            card_doctor = _first_truthy(_prop(er, "doctor_name"), _prop(t2, "doctor_name"), _prop(bc2, "doctor_name"), None)
            card_date = _first_truthy(_prop(er, "date"), _prop(t2, "date"), _prop(bc2, "date"), None)
            card_time = _first_truthy(_prop(er, "time"), _prop(t2, "time"), _prop(bc2, "time"), None)
            card_bn = _first_truthy(_prop(er, "booking_number"), _prop(reply_source, "booking_number"), None)
            card_queue = _first_truthy(_prop(er, "queue_url"), _prop(er, "queue_path"), None)
            card_addr = None
            try:
                cc = _first_truthy(inputs.get("clinic_context", _UNDEFINED), {})
                branch_directory = _prop(cc, "branch_directory")
                branch_dir = branch_directory if isinstance(branch_directory, list) else []
                want_branch = _first_truthy(_prop(er, "branch_id"), _prop(t2, "branch_id"), _prop(bc2, "branch_id"), None)
                found_branch = None
                if _js_truthy(want_branch):
                    for b in branch_dir:
                        if _js_string(_first_truthy(_prop(b, "branch_id"), "")) == _js_string(want_branch):
                            found_branch = b
                            break
                bb = found_branch if _js_truthy(found_branch) else (branch_dir[0] if len(branch_dir) == 1 else None)
                lc = _first_truthy(_prop(bb, "location_config"), {})
                card_addr = _first_truthy(_prop(lc, "address"), _prop(lc, "label"), _prop(bb, "address"), None)
            except Exception:
                card_addr = None
            card_lines = ["تم تأكيد الحجز بنجاح"]
            if _js_truthy(card_name):
                card_lines.append("الاسم " + _js_string(card_name))
            if _js_truthy(card_phone):
                card_lines.append("رقم الجوال " + _js_string(card_phone))
            if _js_truthy(card_doctor):
                card_lines.append("الطبيب " + _js_string(card_doctor))
            if _js_truthy(card_date) and _js_truthy(card_time):
                card_lines.append("الموعد يوم " + fmt_date(card_date) + " الساعة " + fmt_time(card_time))
            elif _js_truthy(card_date):
                card_lines.append("الموعد يوم " + fmt_date(card_date))
            if _js_truthy(card_bn):
                card_lines.append("رقم الحجز " + _js_string(card_bn))
            if _js_truthy(card_addr):
                card_lines.append("العنوان " + _js_string(card_addr))
            if _js_truthy(card_queue) and re.match(r"^https?://", _js_string(card_queue)):
                card_lines.append("رابط الدور " + _js_string(card_queue))
            if len(card_lines) >= 4:
                return {"kind": "card", "keywords": ["تم"], "text": "\n".join(card_lines)}
            return None
        if code_plan == "MISSING_REQUIRED_FIELDS":
            rs_missing = _prop(reply_source, "missing_human_fields")
            sd_missing = _prop(sd, "missing_human_fields")
            fields_list = (
                rs_missing
                if (isinstance(rs_missing, list) and len(rs_missing) > 0)
                else (sd_missing if isinstance(sd_missing, list) else [])
            )
            labels = {
                "patient_name": "الاسم", "patient_age": "العمر", "patient_phone": "رقم الجوال",
                "patient_address": "العنوان", "doctor_or_service": "الدكتور أو الخدمة",
                "doctor": "الدكتور", "service": "الخدمة", "date": "اليوم", "time": "الوقت",
            }
            parts = []
            for f in fields_list:
                label = labels.get(_js_string(f).strip().lower())
                if _js_truthy(label) and label not in parts:
                    parts.append(label)
            if not parts:
                return None
            text = ("محتاج منك بياناتك كاملة عشان نكمل الحجز: " if len(parts) >= 3 else "محتاج منك: ") + " و".join(parts)
            return {"kind": "collect", "keywords": parts, "text": text}
        if code_plan == "PATIENT_DATA_CONFIRMATION_REQUIRED":
            fields = _first_truthy(_dig(reply_source, "patient_data_review", "fields"), {})
            bits = []
            if _js_truthy(_prop(fields, "name")):
                bits.append("الاسم " + _js_string(_prop(fields, "name")))
            if _js_truthy(_prop(fields, "age")):
                bits.append("العمر " + _js_string(_prop(fields, "age")))
            if _js_truthy(_prop(fields, "phone")):
                bits.append("الجوال " + _js_string(_prop(fields, "phone")))
            if _js_truthy(_prop(fields, "address")):
                bits.append("العنوان " + _js_string(_prop(fields, "address")))
            if not bits:
                return None
            first_bit_second_word = bits[0].split(" ")[1] if len(bits[0].split(" ")) > 1 else ""
            return {
                "kind": "review",
                "keywords": ["بياناتك", "صح", first_bit_second_word or ""],
                "text": "بياناتك: " + " ".join(bits) + " لو كل حاجة صح قول نعم ولو في تعديل قوله",
            }
        if code_plan == "SLOT_LOOKUP_REQUIRED":
            return {"kind": "collect", "keywords": ["اليوم", "موعد", "متاح", "تاريخ"], "text": "تحب الموعد يكون أي يوم"}
        if code_plan == "CONFIRMATION_REQUIRED" or code_plan == "CONFIDENCE_REVIEW_REQUIRED":
            t = _first_truthy(_prop(reply_source, "confirmation_target"), _prop(sd, "confirmation_target"), None)
            if not _js_truthy(t):
                return None
            type_word = (
                "متابعة" if _prop(bc, "appointment_type") == "FOLLOW_UP"
                else ("كشف جديد" if _prop(bc, "appointment_type") == "NEW_VISIT" else "")
            )
            if _prop(t, "action") == "create_appointment":
                bits = []
                if _js_truthy(type_word):
                    bits.append(type_word)
                if _js_truthy(_prop(t, "doctor_name")):
                    bits.append("مع " + _js_string(_prop(t, "doctor_name")))
                if _js_truthy(_prop(t, "date")):
                    bits.append("يوم " + fmt_date(_prop(t, "date")))
                if _js_truthy(_prop(t, "time")):
                    bits.append("الساعة " + fmt_time(_prop(t, "time")))
                if not bits:
                    return None
                return {"kind": "confirm", "keywords": ["أأكد", "تأكيد", "الموعد", "أحجز"], "text": "الموعد المقترح " + " ".join(bits) + " أأكد الحجز"}
            if _prop(t, "action") == "cancel_appointment":
                return {"kind": "confirm", "keywords": ["أأكد", "تأكيد", "إلغاء"], "text": "تأكيد إلغاء الموعد أأكد"}
            if _prop(t, "action") == "reschedule_appointment":
                return {"kind": "confirm", "keywords": ["أأكد", "تأكيد", "تعديل"], "text": "تأكيد تعديل الموعد أأكد"}
            return None
        return None

    stage_plan = _stage_plan()

    # The model-authored reply is preserved. No response-code template may replace it.
    agent_reply_value = _prop(reply_source, "agent_reply")
    preserved_agent_reply = safe_reply_candidate(_js_string(agent_reply_value).strip()) if _js_truthy(agent_reply_value) else ""
    fallback_response_code = _js_string(_first_truthy(_prop(reply_source, "response_code"), _prop(source, "response_code"), "")).upper()
    fallback_missing_field = _js_string(
        _first_truthy(_prop(reply_source, "next_best_missing_human_field"), _prop(source, "next_best_missing_human_field"), "")
    ).strip().lower()
    fallback_review_name_missing = bool(
        fallback_response_code == "PATIENT_DATA_CONFIRMATION_REQUIRED"
        and not (
            _js_truthy(_dig(reply_source, "patient_data_review", "fields", "name"))
            or _js_truthy(_dig(reply_source, "booking_context", "patient_name"))
        )
    )
    deterministic_empty_reply = _js_string(_first_truthy(_prop(source, "deterministic_fallback_reply"), "")).strip() or (
        "ممكن اسمك الكامل لو تكرمت"
        if (fallback_missing_field == "patient_name" or fallback_review_name_missing)
        else "تعذر صياغة الرد من نتيجة العملية الحالية"
    )
    # MODEL-FIRST 2026-09-03: the model reply IS the reply. Deterministic stage
    # text is an empty-reply safety net only — it never replaces or appends.
    final_reply = (
        _js_string(_first_truthy(reply, preserved_agent_reply, "")).strip()
        or (_js_string(_prop(stage_plan, "text")) if _js_truthy(stage_plan) else "")
        or deterministic_empty_reply
    )
    if preserve_confirmation_layout:
        layout_lines = []
        for line in re.split(r"\r?\n", _js_string(_first_truthy(final_reply, ""))):
            if _js_truthy(line.strip()):
                layout_lines.append(line.strip())
        final_reply = "\n".join(layout_lines)
    # Defense in depth: never expose provider markers, internal booking enums, or
    # first-visit wording even if a raw reply bypasses the upstream sanitizer.
    final_reply = _END_OF_THINKING_RE.sub("", _js_string(_first_truthy(final_reply, "")))
    final_reply = _NEW_VISIT_RE.sub("كشف جديد", final_reply)
    final_reply = _FOLLOW_UP_RE.sub("متابعة", final_reply)
    final_reply = _ARABIC_FIRST_VISIT_RE.sub("كشف جديد", final_reply)
    final_reply = re.sub(r"\s+", " ", final_reply).strip()
    # P42b CLAIM-GUARD + CONTRACT-DISTRUST (final line of defense at render time),
    # negation/question aware (RG-6); applies to understand-phase replies only.
    eff_phase = _js_string(_first_truthy(_prop(input_item, "agent_phase"), _prop(input_item, "single_agent_phase"), "understand"))
    contract_invalid_understand = bool(
        eff_phase != "result"
        and _js_truthy(_prop(source, "_contract_status"))
        and _js_string(_prop(source, "_contract_status")) in ("REPAIR_NEEDED", "INVALID_AFTER_REPAIR", "MODEL_CALL_FAILED")
    )
    if contract_invalid_understand:
        final_reply = "معلش، مفهمتش رسالتك كويس. ممكن توضحها تاني؟"
    elif (
        eff_phase != "result"
        and isinstance(final_reply, str)
        and not _HELLO_QUESTION_RE.match(final_reply)
        and _CLAIM_RE.search(final_reply)
    ):
        final_reply = _claim_safe(final_reply)
    return {
        **source,
        "rendered_reply": final_reply,
        "final_reply": final_reply,
        "canonical_reply": final_reply,
        "render_error": None if _js_truthy(reply) else "EMPTY_SINGLE_AGENT_REPLY",
        "render_used": bool(_js_truthy(reply)),
        "single_model": True,
        "single_agent_phase": eff_phase,
    }


# ---------------------------------------------------------------------------
# Prepare Operation Claim Input
# ---------------------------------------------------------------------------

_LOOSE_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def prepare_operation_claim_input(item: Dict[str, Any], inputs: Dict[str, Any]) -> Dict[str, Any]:
    """Source node: Prepare Operation Claim Input (extracted/code/Prepare_Operation_Claim_Input.js).

    Args:
        item: current pipeline item ($input.item.json).
        inputs keys:
          normalize_validate <- 'Normalize & Validate' (clinic_id/patient_id/conversation_id)
    Returns the item plus claim_* keys (claim_required, claim_action,
    claim_clinic_id, claim_patient_id, claim_conversation_id,
    claim_confirmation_id, claim_target_fingerprint, claim_schema_version).
    """
    source = item or {}
    normalize = _first_truthy(inputs.get("normalize_validate", _UNDEFINED), {})
    decision = _prop(source, "system_decision")
    decision = decision if isinstance(decision, (dict, list)) else {}
    target = _prop(decision, "confirmation_target")
    target = target if isinstance(target, (dict, list)) else {}
    action = _js_string(_first_truthy(_prop(decision, "action"), _prop(target, "action"), "")).lower()
    # flow_up_operation_ledger.confirmation_id references the persisted
    # flow_up_confirmations.confirmation_id. Pass the deterministic target id only;
    # never substitute a prompt-message id or invent an id.
    raw_confirmation_id = _js_string(_first_truthy(_prop(target, "confirmation_id"), "")).strip()
    claim_confirmation_id = raw_confirmation_id if _LOOSE_UUID_RE.match(raw_confirmation_id) else None
    side_effect_action = action in ("create_appointment", "cancel_appointment", "reschedule_appointment")
    # Claim only approved side effects; non-execution turns bypass the ledger.
    claim_required = _prop(decision, "allowed") is True and side_effect_action
    target_fingerprint = _js_string(
        _first_truthy(_prop(target, "context_fingerprint"), _prop(source, "business_time_target_fingerprint"), "")
    ).strip()
    return {
        **source,
        "claim_required": claim_required,
        "claim_action": action,
        "claim_clinic_id": _first_truthy(_prop(normalize, "clinic_id"), None),
        "claim_patient_id": _first_truthy(_prop(normalize, "patient_id"), None),
        "claim_conversation_id": _first_truthy(_prop(normalize, "conversation_id"), None),
        "claim_confirmation_id": claim_confirmation_id,
        "claim_target_fingerprint": target_fingerprint or None,
        "claim_schema_version": 1,
    }


# ---------------------------------------------------------------------------
# Apply Operation Claim (Deterministic)
# ---------------------------------------------------------------------------


def _parse_json_or_null(value: Any) -> Any:
    if _js_truthy(value) and isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(_js_string(_first_truthy(value, "")))
    except ValueError:
        return None


def apply_operation_claim_deterministic(item: Dict[str, Any], claim_input: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Source node: Apply Operation Claim (Deterministic) (extracted/code/Apply_Operation_Claim_Deterministic.js).

    Args:
        item: current pipeline item ($input.item.json — the ledger RPC row).
        claim_input: 'Prepare Operation Claim Input' first().json. Pass None only
            when that node did not run (mirrors the JS `|| $input.item.json`
            fallback onto the current item).
    Returns the merged item with operation_claim_*, operation_replay_*, the
    final system_decision and the Arabic final_reply for blocked/replayed claims.
    """
    raw = item or {}
    input_item = claim_input if claim_input is not None else raw or {}
    decision = _prop(input_item, "system_decision")
    decision = decision if isinstance(decision, (dict, list)) else {}
    claim_decision = _js_string(_first_truthy(_prop(raw, "decision"), "")).upper()
    ledger_operation_id = _js_string(_first_truthy(_prop(raw, "operation_id"), "")).strip() or None
    stored_response = _parse_json_or_null(_prop(raw, "response_json"))
    replay = claim_decision in ("IDEMPOTENT_REPLAY", "REPLAY_FINAL")
    claim_owner = claim_decision in ("OWNER", "OWNER_RETRY")
    blocked = not claim_owner
    ledger_alert = _prop(raw, "ledger_alert") is True or claim_decision == "INCONCLUSIVE"
    ledger_age_seconds_num = _js_number(_prop(raw, "ledger_age_seconds"))
    ledger_age_seconds = ledger_age_seconds_num if _is_finite_num(ledger_age_seconds_num) else None

    response_code: Optional[str] = None
    final_reply: Optional[str] = None
    allowed = _prop(decision, "allowed") is True
    retryable = False
    operation_state: Optional[str] = None

    if claim_decision == "IN_PROGRESS":
        response_code = "OPERATION_IN_PROGRESS"
        final_reply = "العملية نفسها قيد التنفيذ حالياً. لن أكرر الإجراء، وسأعيد لك النتيجة عند اكتمالها."
        allowed = False
        retryable = True
        operation_state = "in_progress"
    elif claim_decision == "INCONCLUSIVE":
        response_code = "OPERATION_INCONCLUSIVE"
        final_reply = "تعذر التحقق بأمان من نتيجة المحاولة السابقة، لذلك لن أعيد تنفيذ العملية تلقائياً."
        allowed = False
        retryable = False
        operation_state = "inconclusive"
    elif claim_decision == "OPERATION_CONFLICT":
        response_code = "OPERATION_ID_CONFLICT"
        final_reply = "تعذر مطابقة هوية العملية بأمان، لذلك لم يتم تنفيذ أي إجراء."
        allowed = False
        retryable = False
        operation_state = "conflict"
    elif claim_decision == "UNSUPPORTED_ACTION":
        response_code = "UNSUPPORTED_OPERATION"
        final_reply = "لا يمكن تنفيذ هذه العملية من خلال هذا المسار."
        allowed = False
        retryable = False
        operation_state = "failed_final"
    elif claim_decision == "REPLAY_FINAL":
        response_code = "REPLAY_FINAL"
        final_reply = _first_truthy(
            _prop(stored_response, "final_reply"),
            _prop(stored_response, "message"),
            _prop(decision, "final_reply"),
            "تمت معالجة العملية سابقاً ولا يمكن إعادة تنفيذها.",
        )
        allowed = False
        retryable = False
        operation_state = "failed_final"
    elif claim_decision == "IDEMPOTENT_REPLAY":
        response_code = "IDEMPOTENT_REPLAY"
        final_reply = _first_truthy(
            _prop(stored_response, "final_reply"),
            _prop(stored_response, "message"),
            _prop(decision, "final_reply"),
            "تم تنفيذ العملية سابقاً.",
        )
        allowed = False
        retryable = False
        operation_state = "completed"
    elif not claim_owner:
        response_code = "CLAIM_NOT_GRANTED"
        final_reply = "لم يتم الحصول على ملكية العملية بأمان، لذلك لم يتم تنفيذ أي إجراء."
        allowed = False
        retryable = False
        operation_state = "conflict"

    if replay or blocked:
        final_decision = {
            **decision,
            "allowed": False,
            "response_code": response_code,
            "final_reply": final_reply,
            "operation_id": ledger_operation_id,
            "operation_state": operation_state,
            "claim_decision": claim_decision,
            "claim_granted": False,
            "resume_eligible": False,
            "retryable": retryable,
            "ledger_alert": ledger_alert,
            "escalate": ledger_alert or _prop(decision, "escalate") is True,
        }
    else:
        final_decision = {
            **decision,
            "operation_id": ledger_operation_id,
            "claim_decision": claim_decision,
            "claim_granted": True,
        }

    return {
        **input_item,
        **raw,
        "operation_id": ledger_operation_id,
        "operation_claim_decision": claim_decision,
        "operation_claim_granted": claim_owner,
        "operation_claim_required": _prop(input_item, "claim_required") is True,
        "operation_claim_blocked": blocked,
        "operation_replay": replay,
        "operation_replay_response": stored_response,
        "operation_ledger_status": _first_truthy(_prop(raw, "operation_status"), None),
        "operation_mutation_status": _first_truthy(_prop(raw, "mutation_status"), None),
        "operation_state": operation_state,
        "retryable": retryable,
        "success": (_prop(stored_response, "success") is True) if replay else False,
        "appointment_id": (
            _first_truthy(_prop(stored_response, "appointment_id"), _dig(stored_response, "data", "appointment_id"), None)
            if replay
            else None
        ),
        "system_decision": final_decision,
        "child_execution_allowed": claim_owner,
        "response_code": _first_truthy(response_code, _prop(final_decision, "response_code"), None),
        "final_reply": _first_truthy(final_reply, _prop(final_decision, "final_reply"), None),
        "ledger_alert": ledger_alert,
        "ledger_age_seconds": ledger_age_seconds,
        "escalate": ledger_alert or _prop(final_decision, "escalate") is True,
    }


# ---------------------------------------------------------------------------
# Prepare Execute Input
# ---------------------------------------------------------------------------


def _dig_prior_state(prior_state: Any) -> Any:
    """The JSON round-trip Prepare_Execute_Input performs on state_data.

    JS: prior = parsed.state_data ? (typeof === 'string' ? JSON.parse(...) : value)
        : (parsed.data || parsed)
    """
    prior_state_data = _first_truthy(_prop(prior_state, "state_data"), _prop(prior_state, "data"), prior_state)
    prior: Any = {}
    try:
        raw = prior_state_data if isinstance(prior_state_data, str) else json.dumps(prior_state_data, ensure_ascii=False)
        parsed = json.loads(raw)
        state_val = _prop(parsed, "state_data")
        if _js_truthy(state_val):
            prior = json.loads(_js_string(state_val)) if isinstance(state_val, str) else state_val
        else:
            data_val = _prop(parsed, "data")
            prior = (_js_string(data_val) if isinstance(data_val, str) else data_val) if _js_truthy(data_val) else parsed
    except (ValueError, TypeError):
        prior = {}
    return prior


def prepare_execute_input(inputs: Dict[str, Any]) -> Dict[str, Any]:
    """Source node: Prepare Execute Input (extracted/code/Prepare_Execute_Input.js).

    Args (no $json in this node):
      conversation_state        <- 'Get Conversation State'
      resolve_booking_ids       <- 'Resolve Booking IDs (Deterministic)'
      apply_resolved_booking_ids <- 'Apply Resolved Booking IDs (Deterministic)'
      system_orchestrator       <- 'System Orchestrator (Policy)'
      normalize_validate        <- 'Normalize & Validate'
    Returns the child-workflow execute input dict (clinic/patient/conversation
    ids, resolved doctor/service/slot identity, operation_id, correlation_id,
    patient_data_complete).
    """
    inputs = inputs or {}
    prior_state = _first_truthy(inputs.get("conversation_state", _UNDEFINED), {})
    prior = _dig_prior_state(prior_state)
    resolve_node = _first_truthy(inputs.get("resolve_booking_ids", _UNDEFINED), {})
    apply_node = _first_truthy(inputs.get("apply_resolved_booking_ids", _UNDEFINED), {})
    orchestrator_node = _first_truthy(inputs.get("system_orchestrator", _UNDEFINED), {})
    sd = _first_truthy(_prop(orchestrator_node, "system_decision"), {})
    target = _prop(sd, "confirmation_target")
    target = target if isinstance(target, (dict, list)) else {}
    sd_bc = _prop(sd, "booking_context")
    sd_bc = sd_bc if isinstance(sd_bc, (dict, list)) else {}
    nv = _first_truthy(inputs.get("normalize_validate", _UNDEFINED), {})

    def ctx(value: Any, fallback: Any = None) -> Any:
        if value is not None and value is not _UNDEFINED and _js_string(value) != "":
            return value
        return fallback

    booking = {
        **(_obj_or_empty(_prop(prior, "booking_context")) if isinstance(_prop(prior, "booking_context"), dict) else {}),
        **(_obj_or_empty(_prop(apply_node, "booking_context")) if isinstance(_prop(apply_node, "booking_context"), dict) else {}),
        **(sd_bc if isinstance(sd_bc, dict) else {}),
    }
    slot_state = {
        **(_obj_or_empty(_prop(prior, "slot_state")) if isinstance(_prop(prior, "slot_state"), dict) else {}),
        **(_obj_or_empty(_prop(apply_node, "slot_state")) if isinstance(_prop(apply_node, "slot_state"), dict) else {}),
    }
    slot_id = ctx(
        _prop(target, "slot_id"),
        ctx(_prop(sd_bc, "slot_id"), ctx(_prop(slot_state, "slot_id"), ctx(_prop(resolve_node, "slot_id"), _prop(booking, "slot_id")))),
    )
    branch_id = ctx(
        _prop(target, "branch_id"),
        ctx(_prop(sd_bc, "branch_id"), ctx(_prop(slot_state, "branch_id"), ctx(_prop(resolve_node, "branch_id"), _prop(booking, "branch_id")))),
    )
    operation_id = ctx(
        _prop(target, "operation_id"),
        ctx(_prop(apply_node, "operation_id"), ctx(_prop(nv, "operation_id"), _js_string(_first_truthy(_prop(nv, "idempotency_key"), "")) + ":create_appointment")),
    )
    patient_values = [
        _prop(booking, "patient_name"),
        _prop(booking, "patient_phone"),
        _prop(booking, "patient_age"),
        _prop(booking, "patient_address"),
    ]
    return {
        "clinic_id": _first_truthy(_prop(nv, "clinic_id"), None),
        "patient_id": _first_truthy(_prop(nv, "patient_id"), None),
        "conversation_id": _first_truthy(_prop(nv, "conversation_id"), None),
        "doctor_id": ctx(_prop(sd_bc, "doctor_id"), ctx(_prop(booking, "doctor_id"), _prop(resolve_node, "doctor_id"))),
        "service_id": ctx(_prop(sd_bc, "service_id"), ctx(_prop(booking, "service_id"), _prop(resolve_node, "service_id"))),
        "service_name": ctx(_prop(sd_bc, "service_name"), ctx(_prop(booking, "service_name"), _prop(resolve_node, "service_name"))),
        "date": ctx(_prop(sd_bc, "date"), ctx(_prop(booking, "date"), _prop(resolve_node, "date"))),
        "time": ctx(_prop(sd_bc, "time"), ctx(_prop(booking, "time"), _prop(resolve_node, "time"))),
        "slot_id": slot_id,
        "branch_id": branch_id,
        "notes": ctx(_prop(target, "notes"), ctx(_prop(sd, "notes"), None)),
        "operation": _first_truthy(_prop(sd, "action"), _prop(sd, "operation"), _prop(target, "action"), "create_appointment"),
        "operation_id": operation_id,
        "correlation_id": _first_truthy(_prop(nv, "correlation_id"), _prop(nv, "message_id"), None),
        "channel_type": _first_truthy(_prop(nv, "channel_type"), "whatsapp"),
        "patient_data_complete": all(
            v is not None and v is not _UNDEFINED and _js_string(v).strip() != "" for v in patient_values
        ),
    }


# ---------------------------------------------------------------------------
# Prepare Execute Context
# ---------------------------------------------------------------------------

_ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩"
_PLACEHOLDER_NAMES = {"مريض", "patient", "unknown", "غير معروف"}


def _normalize_age(value: Any) -> Optional[int]:
    s = re.sub(
        "[٠-٩]",
        lambda d: str(_ARABIC_INDIC_DIGITS.index(d.group(0))),
        _js_string(_coalesce(value, "")),
    ).strip()
    if not _js_truthy(s):
        return None
    n = _js_number(s)
    if _is_finite_num(n) and float(n).is_integer() and 0 <= n <= 130:
        return int(n)
    return None


def _usable_text(value: Any) -> Optional[str]:
    text = _js_string(_coalesce(value, "")).strip()
    if not _js_truthy(text):
        return None
    return None if text.lower() in _PLACEHOLDER_NAMES else text


def prepare_execute_context(item: Dict[str, Any], inputs: Dict[str, Any]) -> Dict[str, Any]:
    """Source node: Prepare Execute Context (extracted/code/Prepare_Execute_Context.js).

    Args:
        item: current pipeline item ($json; patient fields may live here).
        inputs keys:
          conversation_state         <- 'Get Conversation State' (None-safe)
          resolve_booking_ids        <- 'Resolve Booking IDs (Deterministic)'
          apply_resolved_booking_ids <- 'Apply Resolved Booking IDs (Deterministic)'
          system_orchestrator        <- 'System Orchestrator (Policy)'
          normalize_validate         <- 'Normalize & Validate'
          slot_lookup_result         <- 'Apply Deterministic Slot Lookup Result'
          clinic_context             <- 'Get Clinic Context'
    Returns the execute context dict with fallback-chained ids and the patient
    identity fields (current statement/review authoritative over the clinic row).
    """
    item = item or {}
    inputs = inputs or {}
    prior_state = inputs.get("conversation_state")
    if _js_truthy(prior_state):
        inner = _first_truthy(_prop(prior_state, "state_data"), _prop(prior_state, "data"))
        prior_state_data = _first_truthy(inner, prior_state, {})
    else:
        # JS: (priorState && (priorState.state_data || priorState.data)) || priorState || {}
        prior_state_data = {}
    prior: Any = {}
    try:
        raw = prior_state_data if isinstance(prior_state_data, str) else json.dumps(prior_state_data, ensure_ascii=False)
        parsed = json.loads(raw)
        # JS: if (parsed.state_data) ... else if (parsed.data) ... else prior = parsed
        state_val = _prop(parsed, "state_data")
        if _js_truthy(state_val):
            prior = json.loads(_js_string(state_val)) if isinstance(state_val, str) else state_val
        else:
            data_val = _prop(parsed, "data")
            if _js_truthy(data_val):
                prior = json.loads(_js_string(data_val)) if isinstance(data_val, str) else data_val
            else:
                prior = parsed
    except (ValueError, TypeError):
        prior = {}
    prior = prior if isinstance(prior, dict) else {}

    bc = _prop(prior, "booking_context")
    if not _js_truthy(bc):
        facts_val = _prop(prior, "facts")
        bc = _prop(facts_val, "booking") if _js_truthy(facts_val) else None
    if not _js_truthy(bc):
        prior_sd = _prop(prior, "system_decision")
        bc = _prop(prior_sd, "booking_context") if _js_truthy(prior_sd) else None
    if not _js_truthy(bc):
        bc = prior if _js_truthy(prior) else {}
    resolve_node = _first_truthy(inputs.get("resolve_booking_ids", _UNDEFINED), {})
    apply_node = _first_truthy(inputs.get("apply_resolved_booking_ids", _UNDEFINED), {})
    orchestrator_node = _first_truthy(inputs.get("system_orchestrator", _UNDEFINED), {})

    sd = _first_truthy(_prop(orchestrator_node, "system_decision"), {})
    sd_bc = _prop(sd, "booking_context")
    sd_bc = sd_bc if isinstance(sd_bc, (dict, list)) else {}
    slot_lookup_node = _first_truthy(inputs.get("slot_lookup_result", _UNDEFINED), {})

    normalize_inbound = _first_truthy(inputs.get("normalize_validate", _UNDEFINED), {})
    clinic_id = _prop(normalize_inbound, "clinic_id")
    patient_id = _prop(normalize_inbound, "patient_id")
    conversation_id = _prop(normalize_inbound, "conversation_id")

    apply_bc = _prop(apply_node, "booking_context")
    apply_bc_ok = _js_truthy(apply_node) and _js_truthy(apply_bc)
    apply_bc_val = apply_bc if apply_bc_ok else None

    doctor_id = _first_truthy(
        _prop(sd_bc, "doctor_id"),
        _prop(bc, "doctor_id"),
        _prop(resolve_node, "doctor_id"),
        _prop(apply_bc_val, "doctor_id"),
        None,
    )
    service_id = _first_truthy(
        _prop(sd_bc, "service_id"),
        _prop(bc, "service_id"),
        _prop(resolve_node, "service_id"),
        _prop(apply_bc_val, "service_id"),
        None,
    )
    service_name = _first_truthy(
        _prop(sd_bc, "service_name"),
        _prop(bc, "service_name"),
        _prop(resolve_node, "service_name"),
        _prop(apply_bc_val, "service_name"),
        None,
    )
    appointment_type = _first_truthy(
        _prop(sd_bc, "appointment_type"),
        _prop(bc, "appointment_type"),
        _prop(apply_bc_val, "appointment_type"),
        None,
    )
    date = _first_truthy(_prop(sd_bc, "date"), _prop(bc, "date"), _prop(resolve_node, "date"), _dig(apply_node, "booking_context", "date"), None)
    time = _first_truthy(
        _prop(sd_bc, "time"), _prop(bc, "time"), _prop(resolve_node, "time"),
        _dig(apply_node, "booking_context", "time"), _dig(slot_lookup_node, "booking_context", "time"), None,
    )
    slot_id = _first_truthy(
        _prop(sd_bc, "slot_id"), _prop(bc, "slot_id"), _prop(resolve_node, "slot_id"), _prop(apply_node, "slot_id"),
        _dig(apply_node, "booking_context", "slot_id"), _prop(slot_lookup_node, "slot_id"),
        _dig(slot_lookup_node, "slot_state", "slot_id"), _dig(slot_lookup_node, "booking_context", "slot_id"), None,
    )
    branch_id = _first_truthy(
        _prop(sd_bc, "branch_id"), _prop(bc, "branch_id"), _prop(resolve_node, "branch_id"), _prop(apply_node, "branch_id"),
        _dig(apply_node, "booking_context", "branch_id"), _prop(slot_lookup_node, "branch_id"),
        _dig(slot_lookup_node, "slot_state", "branch_id"), _dig(slot_lookup_node, "booking_context", "branch_id"), None,
    )
    branch_name = _first_truthy(
        _prop(sd_bc, "branch_name"), _prop(bc, "branch_name"), _prop(resolve_node, "branch_name"), _prop(apply_node, "branch_name"),
        _dig(apply_node, "booking_context", "branch_name"), _prop(slot_lookup_node, "branch_name"),
        _dig(slot_lookup_node, "slot_state", "branch_name"), _dig(slot_lookup_node, "booking_context", "branch_name"), None,
    )
    clinic_context = _first_truthy(inputs.get("clinic_context", _UNDEFINED), {})
    current_patient = sd_bc if isinstance(sd_bc, dict) else {}
    prior_review = _prop(prior, "patient_data_review")
    review_fields = _prop(prior_review, "fields") if (_js_truthy(prior_review) and isinstance(_prop(prior_review, "fields"), (dict, list))) else {}
    prior_facts = _prop(prior, "facts")
    fact_patient = _prop(prior_facts, "patient") if (_js_truthy(prior_facts) and isinstance(_prop(prior_facts, "patient"), (dict, list))) else {}
    patient_name = (
        _first_truthy(
            _usable_text(_prop(current_patient, "patient_name")),
            _usable_text(_prop(item, "patient_name")),
            _usable_text(_prop(bc, "patient_name")),
            _usable_text(_prop(review_fields, "name")),
            _usable_text(_prop(fact_patient, "name")),
            _usable_text(_prop(prior, "patient_name")),
            None,
        )
    )
    patient_phone = _first_truthy(
        _prop(current_patient, "patient_phone"), _prop(item, "patient_phone"), _prop(bc, "patient_phone"),
        _prop(review_fields, "phone"), _prop(fact_patient, "phone"), _prop(prior, "patient_phone"),
        _prop(clinic_context, "patient_phone"), None,
    )
    patient_age = _normalize_age(
        _coalesce(
            _prop(current_patient, "patient_age"), _prop(item, "patient_age"), _prop(bc, "patient_age"),
            _prop(review_fields, "age"), _prop(fact_patient, "age"), _prop(prior, "patient_age"),
            _prop(clinic_context, "patient_age"),
        )
    )
    patient_address = _first_truthy(
        _prop(current_patient, "patient_address"), _prop(item, "patient_address"), _prop(bc, "patient_address"),
        _prop(review_fields, "address"), _prop(fact_patient, "address"), _prop(prior, "patient_address"),
        _prop(clinic_context, "patient_address"), None,
    )
    return {
        "clinic_id": clinic_id,
        "patient_id": patient_id,
        "conversation_id": conversation_id,
        "doctor_id": doctor_id,
        "service_id": service_id,
        "service_name": service_name,
        "appointment_type": appointment_type,
        "date": date,
        "time": time,
        "slot_id": slot_id,
        "branch_id": branch_id,
        "branch_name": branch_name,
        "patient_name": patient_name,
        "patient_phone": patient_phone,
        "patient_age": patient_age,
        "patient_address": patient_address,
        "operation": _first_truthy(_prop(sd, "operation"), _prop(sd_bc, "operation"), "create_appointment"),
        "channel_type": _first_truthy(_prop(normalize_inbound, "channel_type"), "whatsapp"),
    }


# ---------------------------------------------------------------------------
# Prepare Operation Finalize Input
# ---------------------------------------------------------------------------

_DEFINITELY_NOT_EXECUTED_CODES = {
    "SLOT_UNAVAILABLE",
    "CANCELLATION_NOT_ALLOWED",
    "APPOINTMENT_NOT_FOUND_OR_NOT_OWNED",
    "SAME_SLOT",
    "MISSING_REQUIRED_FIELDS",
    "CONFIDENCE_REVIEW_REQUIRED",
}
_RETRYABLE_CODES = {"CREATE_RETRYABLE", "CANCEL_RETRYABLE", "RESCHEDULE_RETRYABLE"}


def prepare_operation_finalize_input(item: Dict[str, Any], inputs: Dict[str, Any], execution_id: Optional[Any] = None) -> Dict[str, Any]:
    """Source node: Prepare Operation Finalize Input (extracted/code/Prepare_Operation_Finalize_Input.js).

    Args:
        item: current pipeline item ($input.item.json — the child execution row).
        inputs keys:
          normalize_validate <- 'Normalize & Validate' (clinic_id for finalize_clinic_id)
        execution_id: n8n $execution.id equivalent. PORT-TODO(n8n): the n8n
            runtime execution id is not available to a pure function; the runner
            may pass it, otherwise None keeps the JS null branch.
    Returns the item plus finalize_* keys (status, mutation_status,
    response_b64, child_execution_id, last_error_b64).
    """
    raw = item or {}
    code = _js_string(_first_truthy(_prop(raw, "response_code"), _prop(raw, "error_code"), "")).upper()
    contract_valid = _prop(raw, "child_contract_checked") is True and _prop(raw, "child_contract_valid") is True
    success = _prop(raw, "success") is True
    definitely_not_executed = code in _DEFINITELY_NOT_EXECUTED_CODES
    retryable_code = code in _RETRYABLE_CODES
    explicit_not_executed = _js_string(
        _first_truthy(_prop(raw, "mutation_status"), _prop(raw, "operation_mutation_status"), "")
    ).upper() == "NOT_EXECUTED"
    retryable_not_executed = retryable_code or (_prop(raw, "retryable") is True and explicit_not_executed)
    ledger_status = "INCONCLUSIVE"
    mutation_status = "UNKNOWN"
    if contract_valid and success:
        ledger_status = "COMPLETED"
        mutation_status = "EXECUTED"
    elif contract_valid and definitely_not_executed:
        ledger_status = "FAILED_FINAL"
        mutation_status = "NOT_EXECUTED"
    elif contract_valid and retryable_not_executed:
        # A retryable child code is an explicit proof that the provider mutation
        # was not executed; keep the ledger retryable and claimable.
        ledger_status = "IN_PROGRESS"
        mutation_status = "NOT_EXECUTED"
    response_json = {
        "response_code": _first_truthy(_prop(raw, "response_code"), code, "CHILD_CONTRACT_INVALID"),
        "success": success,
        "retryable": _prop(raw, "retryable") is True,
        "final_reply": _first_truthy(_prop(raw, "final_reply"), _prop(raw, "message"), None),
        "appointment_id": _first_truthy(_prop(raw, "appointment_id"), _prop(raw, "id"), None),
        "booking_id": _first_truthy(_prop(raw, "booking_id"), None),
        "booking_number": _first_truthy(_prop(raw, "booking_number"), None),
        "branch_id": _first_truthy(_prop(raw, "branch_id"), None),
        "queue_number": _coalesce(_prop(raw, "queue_number"), None),
        "queue_path": _first_truthy(_prop(raw, "queue_path"), None),
        "queue_expires_at": _first_truthy(_prop(raw, "queue_expires_at"), None),
        "operation_id": _first_truthy(_prop(raw, "operation_id"), None),
        "child_contract_checked": _prop(raw, "child_contract_checked") is True,
        "child_contract_valid": _prop(raw, "child_contract_valid") is True,
        "contract_error": _first_truthy(_prop(raw, "contract_error"), None),
    }
    response_b64 = base64.b64encode(
        json.dumps(response_json, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    execution_id_value = execution_id if _js_truthy(execution_id) else None
    normalize_item = _first_truthy(inputs.get("normalize_validate", _UNDEFINED), {})
    detail = _first_truthy(
        _prop(raw, "last_error"), _prop(raw, "error_message"), _prop(raw, "error"),
        _prop(raw, "contract_error"), _prop(raw, "error_code"), None,
    )
    if _js_truthy(detail):
        last_error_payload = {
            "error_code": _first_truthy(_prop(raw, "error_code"), _prop(raw, "response_code"), None),
            "message": _js_string(detail),
        }
        last_error_b64 = base64.b64encode(
            json.dumps(last_error_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).decode("ascii")
    else:
        last_error_b64 = ""
    return {
        **raw,
        "finalize_clinic_id": _first_truthy(_prop(normalize_item, "clinic_id"), None),
        "finalize_operation_id": _first_truthy(_prop(raw, "operation_id"), None),
        "finalize_status": ledger_status,
        "finalize_mutation_status": mutation_status,
        "finalize_response_b64": response_b64,
        "finalize_child_execution_id": _first_truthy(_prop(raw, "child_execution_id"), execution_id_value, None),
        "finalize_last_error_b64": last_error_b64,
    }


# ---------------------------------------------------------------------------
# Merge Operation Completion
# ---------------------------------------------------------------------------


def merge_operation_completion(validate_child_envelope_item: Optional[Dict[str, Any]], item: Dict[str, Any]) -> Dict[str, Any]:
    """Source node: Merge Operation Completion (extracted/code/Merge_Operation_Completion.js).

    Args:
        validate_child_envelope_item: 'Validate Child Envelope' first().json.
            Pass None only when that node did not run (mirrors the JS catch that
            falls back to $json).
        item: current pipeline item ($input.item.json — the completion row).
    Returns the merged envelope (operation ids/statuses, finalize response,
    operation_finalized, child_execution_id).
    """
    original = (
        validate_child_envelope_item
        if validate_child_envelope_item is not None
        else (item or {})
    )
    completion = item or {}
    return {
        **original,
        "operation_id": _first_truthy(_prop(completion, "operation_id"), _prop(original, "operation_id"), None),
        "operation_ledger_status": _first_truthy(_prop(completion, "operation_status"), _prop(original, "operation_ledger_status"), None),
        "operation_mutation_status": _first_truthy(_prop(completion, "mutation_status"), _prop(original, "operation_mutation_status"), None),
        "operation_finalize_response": _first_truthy(_prop(completion, "response_json"), None),
        "operation_finalized": bool(_js_truthy(_prop(completion, "operation_id"))),
        "child_execution_id": _first_truthy(_prop(completion, "child_execution_id"), _prop(original, "child_execution_id"), None),
    }


# ---------------------------------------------------------------------------
# Apply Resolved Booking IDs (Deterministic)
# ---------------------------------------------------------------------------


def apply_resolved_booking_ids_deterministic(item: Dict[str, Any], inputs: Dict[str, Any], now_ms: Optional[float] = None) -> Dict[str, Any]:
    """Source node: Apply Resolved Booking IDs (Deterministic) (extracted/code/Apply_Resolved_Booking_IDs_Deterministic.js).

    Args:
        item: current pipeline item ($json — the resolver output row).
        inputs keys:
          validate_repaired_contract <- 'Validate Repaired Contract (Deterministic)';
              used only when its _contract_status === 'VALID'
          normalize_agent_output     <- 'Normalize Agent Output (Deterministic)' (fallback base)
          conversation_state         <- 'Get Conversation State' (offer/target liveness guard)
        now_ms: JS Date.now() equivalent; defaults to the current wall clock.
    Returns the normalized item with resolver-merged contract entities,
    contract_v3 mirror, booking_context and slot_state; the unchanged normalized
    item when the operation should not apply.
    """
    inputs = inputs or {}
    vrc = inputs.get("validate_repaired_contract")
    nao = _first_truthy(inputs.get("normalize_agent_output", _UNDEFINED), {})
    normalized = (
        vrc
        if (vrc is not None and _js_truthy(vrc) and _prop(vrc, "_contract_status") == "VALID")
        else (nao or {})
    )
    resolved = item if _js_truthy(item) and isinstance(item, dict) else {}
    contract = _obj_or_empty(_prop(normalized, "contract"))
    entities = _obj_or_empty(_prop(contract, "entities"))
    operation_type = _js_string(
        _first_truthy(_dig(contract, "operation_proposal", "type"), _dig(normalized, "_normalization", "turn_intent"), "")
    ).lower()
    should_apply = operation_type in ("create_appointment", "cancel_appointment", "reschedule_appointment", "check_availability") or _js_string(
        _first_truthy(_dig(normalized, "_normalization", "turn_intent"), "")
    ).lower() in ("cancellation_request", "reschedule_request", "availability_inquiry")
    normalized_scope = _obj_or_empty(_prop(normalized, "_normalization"))
    current_turn_date = _first_truthy(
        _dig(normalized_scope, "query_scope", "date"),
        _dig(normalized_scope, "raw_temporal_input", "date"),
        _prop(entities, "date"),
        None,
    )
    current_turn_time = _first_truthy(
        _dig(normalized_scope, "query_scope", "time"),
        _dig(normalized_scope, "raw_temporal_input", "time"),
        _prop(entities, "time"),
        None,
    )
    current_turn_has_window_evidence = bool(
        _prop(normalized_scope, "current_message_temporal") is True
        or _js_truthy(_dig(normalized_scope, "query_scope", "date"))
        or _js_truthy(_dig(normalized_scope, "query_scope", "time"))
        or _js_truthy(_prop(entities, "date"))
        or _js_truthy(_prop(entities, "time"))
    )
    fresh_booking_turn = operation_type == "create_appointment" and current_turn_has_window_evidence
    fresh_scheduling_turn = operation_type in ("create_appointment", "check_availability", "reschedule_appointment") and current_turn_has_window_evidence
    # A slot returned by a read-only availability lookup is only a candidate.
    availability_only = bool(
        _dig(normalized, "_normalization", "query_is_availability") is True
        or _dig(normalized, "_normalization", "query_scope", "type") == "availability"
        or _dig(contract, "query", "type") == "availability"
        or _dig(contract, "next_step", "type") == "show_availability"
        or _dig(normalized, "_normalization", "next_step_type") == "show_availability"
    )
    # P-SLOT-GUARD v40: prior-state slots may only survive when this conversation
    # still has an open offer or a pending confirmation.
    state_row_guard = _first_truthy(inputs.get("conversation_state", _UNDEFINED), {})
    guard_state = _prop(state_row_guard, "state_data")
    guard_state = guard_state if isinstance(guard_state, (dict, list)) else {}
    guard_offer = _first_truthy(_prop(guard_state, "presented_offer"), _prop(guard_state, "pending_offer"), None)
    now = now_ms if now_ms is not None else _now_ms()
    offer_exp = _date_parse(_js_string(_first_truthy(_prop(guard_offer, "expires_at"), ""))) if _js_truthy(guard_offer) else _NAN
    live_offer = bool(
        _js_truthy(guard_offer)
        and isinstance(guard_offer, dict)
        and _is_finite_num(offer_exp)
        and offer_exp > now
    )
    guard_target = _prop(guard_state, "confirmation_target") if _js_truthy(guard_state) else None
    guard_target_exp = _date_parse(_js_string(_first_truthy(_prop(guard_target, "expires_at"), ""))) if _js_truthy(guard_target) else _NAN
    live_target = bool(
        _js_truthy(guard_target)
        and isinstance(guard_target, dict)
        and ((not _is_finite_num(guard_target_exp)) or guard_target_exp > now)
    )
    may_carry_slot = live_offer or live_target
    if not should_apply:
        return dict(normalized)
    resolved_doctor_id = _first_truthy(_prop(resolved, "doctor_id"), None)
    resolved_doctor_name = _first_truthy(_prop(resolved, "doctor_name"), None)
    resolved_service_id = _first_truthy(_prop(resolved, "service_id"), None)
    resolved_service_name = _first_truthy(_prop(resolved, "service_name"), None)
    merged_entities = {
        **entities,
        "doctor_id": _first_truthy(resolved_doctor_id, _prop(entities, "doctor_id"), None),
        "doctor_name": _first_truthy(resolved_doctor_name, _prop(entities, "doctor_name"), None),
        "service_id": _first_truthy(resolved_service_id, _prop(entities, "service_id"), None),
        "service_name": _first_truthy(resolved_service_name, _prop(entities, "service_name"), None),
        "appointment_type": _first_truthy(_prop(entities, "appointment_type"), None),
        "appointment_id": _first_truthy(_prop(entities, "appointment_id"), _prop(resolved, "appointment_id"), None),
        "booking_number": _first_truthy(_prop(entities, "booking_number"), _prop(resolved, "booking_number"), None),
        "expected_old_slot_id": _first_truthy(_prop(entities, "expected_old_slot_id"), _prop(resolved, "expected_old_slot_id"), None),
        "new_slot_id": _first_truthy(_prop(entities, "new_slot_id"), _prop(resolved, "new_slot_id"), None),
        "slot_id": (
            None
            if availability_only
            else _first_truthy(_prop(entities, "slot_id"), _prop(resolved, "slot_id"), _prop(resolved, "new_slot_id"), None)
        ),
        "branch_id": _first_truthy(_prop(entities, "branch_id"), _prop(resolved, "branch_id"), None),
    }
    prior_booking = _prop(normalized, "booking_context")
    prior_booking = prior_booking if isinstance(prior_booking, (dict, list)) else {}
    slot_state_in = _prop(normalized, "slot_state")
    slot_state_in = slot_state_in if isinstance(slot_state_in, (dict, list)) else {}
    resolved_slot_start = _prop(resolved, "resolved_slot_start_time")

    def _start_date_part() -> Optional[str]:
        return _js_string(resolved_slot_start)[:10] if _js_truthy(resolved_slot_start) else None

    def _start_time_part() -> Optional[str]:
        return _js_string(resolved_slot_start)[11:19] if _js_truthy(resolved_slot_start) else None

    # Resolver output is the tenant-scoped database authority for IDs and labels;
    # keep doctor/service pairs together so an old state label cannot survive
    # with a different database ID.
    booking_context = {
        **prior_booking,
        "doctor_id": _first_truthy(resolved_doctor_id, _prop(prior_booking, "doctor_id"), None),
        "doctor_name": _first_truthy(resolved_doctor_name, _prop(prior_booking, "doctor_name"), None),
        "service_id": _first_truthy(resolved_service_id, _prop(prior_booking, "service_id"), None),
        "service_name": _first_truthy(resolved_service_name, _prop(prior_booking, "service_name"), None),
        "appointment_type": _first_truthy(_prop(prior_booking, "appointment_type"), _prop(entities, "appointment_type"), None),
        "appointment_id": _first_truthy(_prop(prior_booking, "appointment_id"), _prop(resolved, "appointment_id"), None),
        "booking_number": _first_truthy(_prop(prior_booking, "booking_number"), _prop(resolved, "booking_number"), None),
        "expected_old_slot_id": _first_truthy(_prop(prior_booking, "expected_old_slot_id"), _prop(resolved, "expected_old_slot_id"), None),
        "new_slot_id": (
            None
            if availability_only
            else (
                _first_truthy(_prop(resolved, "new_slot_id"), None)
                if fresh_booking_turn
                else (
                    _first_truthy(_prop(prior_booking, "new_slot_id"), _prop(resolved, "new_slot_id"), None)
                    if may_carry_slot
                    else None
                )
            )
        ),
        "slot_id": (
            None
            if availability_only
            else (
                _first_truthy(_prop(resolved, "slot_id"), _prop(resolved, "new_slot_id"), None)
                if fresh_booking_turn
                else (
                    _first_truthy(_prop(prior_booking, "slot_id"), _prop(resolved, "slot_id"), _prop(resolved, "new_slot_id"), None)
                    if may_carry_slot
                    else None
                )
            )
        ),
        "branch_id": _first_truthy(_prop(prior_booking, "branch_id"), _prop(resolved, "branch_id"), None),
        "date": (
            (_first_truthy(current_turn_date, None))
            if availability_only
            else (
                _first_truthy(current_turn_date, _start_date_part())
                if fresh_scheduling_turn
                else (
                    _first_truthy(_prop(prior_booking, "date"), _start_date_part())
                    if may_carry_slot
                    else _first_truthy(current_turn_date, None)
                )
            )
        ),
        "time": (
            (_first_truthy(current_turn_time, None))
            if availability_only
            else (
                _first_truthy(current_turn_time, _start_time_part())
                if fresh_scheduling_turn
                else (
                    _first_truthy(_prop(prior_booking, "time"), _start_time_part())
                    if may_carry_slot
                    else _first_truthy(current_turn_time, None)
                )
            )
        ),
    }
    contract_v3_in = _prop(normalized, "contract_v3")
    if isinstance(contract_v3_in, dict):
        v3_entities = _obj_or_empty(_prop(contract_v3_in, "entities"))
        contract_v3_out = {
            **contract_v3_in,
            "entities": {
                **v3_entities,
                "appointment_id": _coalesce(_prop(merged_entities, "appointment_id"), _prop(v3_entities, "appointment_id"), None),
                "booking_number": _coalesce(_prop(merged_entities, "booking_number"), _prop(v3_entities, "booking_number"), None),
                "expected_old_slot_id": _coalesce(_prop(merged_entities, "expected_old_slot_id"), _prop(v3_entities, "expected_old_slot_id"), None),
                "new_slot_id": (
                    None
                    if availability_only
                    else _coalesce(_prop(merged_entities, "new_slot_id"), _prop(v3_entities, "new_slot_id"), None)
                ),
                "slot_id": (
                    None
                    if availability_only
                    else _coalesce(_prop(merged_entities, "slot_id"), _prop(v3_entities, "slot_id"), None)
                ),
                "doctor_id": _coalesce(_prop(merged_entities, "doctor_id"), _prop(v3_entities, "doctor_id"), None),
                "doctor_name": _coalesce(_prop(merged_entities, "doctor_name"), _prop(v3_entities, "doctor_name"), None),
                "service_id": _coalesce(_prop(merged_entities, "service_id"), _prop(v3_entities, "service_id"), None),
                "service_name": _coalesce(_prop(merged_entities, "service_name"), _prop(v3_entities, "service_name"), None),
                "branch_id": _coalesce(_prop(merged_entities, "branch_id"), _prop(v3_entities, "branch_id"), None),
            },
        }
    else:
        contract_v3_out = contract_v3_in
    slot_state_out = {
        **slot_state_in,
        **merged_entities,
        "doctor_id": _first_truthy(_prop(booking_context, "doctor_id"), _prop(slot_state_in, "doctor_id"), None),
        "doctor_name": _first_truthy(_prop(booking_context, "doctor_name"), _prop(slot_state_in, "doctor_name"), None),
        "service_id": _first_truthy(_prop(booking_context, "service_id"), _prop(slot_state_in, "service_id"), None),
        "service_name": _first_truthy(_prop(booking_context, "service_name"), _prop(slot_state_in, "service_name"), None),
        "appointment_type": _first_truthy(_prop(booking_context, "appointment_type"), _prop(slot_state_in, "appointment_type"), None),
        # Availability candidates must not leak into the persistent slot selection state.
        "date": (_first_truthy(current_turn_date, None) if availability_only else _first_truthy(_prop(booking_context, "date"), _prop(slot_state_in, "date"), None)),
        "time": (_first_truthy(current_turn_time, None) if availability_only else _first_truthy(_prop(booking_context, "time"), _prop(slot_state_in, "time"), None)),
        "slot_id": (None if availability_only else _first_truthy(_prop(booking_context, "slot_id"), _prop(slot_state_in, "slot_id"), None)),
        "patient_name": _first_truthy(_prop(booking_context, "patient_name"), _prop(slot_state_in, "patient_name"), None),
        "patient_phone": _first_truthy(_prop(booking_context, "patient_phone"), _prop(slot_state_in, "patient_phone"), None),
        "patient_age": _coalesce(_prop(booking_context, "patient_age"), _prop(slot_state_in, "patient_age"), None),
        "patient_address": _first_truthy(_prop(booking_context, "patient_address"), _prop(slot_state_in, "patient_address"), None),
    }
    return {
        **normalized,
        "contract": {**contract, "entities": merged_entities},
        # BUGFIX (2026-09-09): the orchestrator reads contract_v3.entities, which
        # previously kept the pre-resolver values; mirror the resolver results there too.
        "contract_v3": contract_v3_out,
        "booking_context": booking_context,
        # Preserve the canonical window and patient fields for downstream readiness and state persistence.
        "slot_state": slot_state_out,
        "appointment_id": _first_truthy(_prop(resolved, "appointment_id"), _prop(normalized, "appointment_id"), None),
        "booking_number": _first_truthy(
            _prop(resolved, "booking_number"),
            _prop(normalized, "booking_number"),
            _dig(normalized, "booking_context", "booking_number"),
            None,
        ),
        "expected_old_slot_id": _first_truthy(_prop(resolved, "expected_old_slot_id"), _prop(normalized, "expected_old_slot_id"), None),
        "new_slot_id": (
            None
            if availability_only
            else _first_truthy(_prop(resolved, "new_slot_id"), _prop(normalized, "new_slot_id"), None)
        ),
        "branch_id": _first_truthy(_prop(resolved, "branch_id"), _prop(normalized, "branch_id"), None),
        "resolver_result": resolved,
        "resolver_contract_version": 2,
    }


# ---------------------------------------------------------------------------
# Prepare Handoff Input
# ---------------------------------------------------------------------------

_RE_PATIENT_HUMAN = re.compile(r"(?:موظف|بشري|إنسان|انسان|حد من الاستقبال|كلموني|عايز اكلم حد|human|agent|reception|customer service)", re.IGNORECASE)
_RE_COMPLAINT = re.compile(r"(?:شكوى|اشتك|مش مبسوط|مش راضي|غير راض|complaint|not happy|unhappy)", re.IGNORECASE)
_RE_PAYMENT = re.compile(r"(?:دفع|فاتورة|سداد|payment|invoice)", re.IGNORECASE)
_RE_SYSTEM = re.compile(r"(?:خطأ تقني|مشكلة تقنية|النظام|تعطل|مش شغال|system|technical|error|not working)", re.IGNORECASE)
_RE_APPOINTMENT = re.compile(r"(?:موعد|حجز|تعديل|إلغاء|الغاء|appointment|booking|cancel|reschedul)", re.IGNORECASE)
_RE_URGENT = re.compile(r"(?:طارئ|عاجل|عاجل جداً|ضروري|urgent|emergency)", re.IGNORECASE)


def _js_char_code_units(s: str) -> List[int]:
    """JS charCodeAt iteration: UTF-16 code units (surrogate pairs for astral chars)."""
    codes: List[int] = []
    for ch in s:
        cp = ord(ch)
        if cp > 0xFFFF:
            cp -= 0x10000
            codes.append(0xD800 + (cp >> 10))
            codes.append(0xDC00 + (cp & 0x3FF))
        else:
            codes.append(cp)
    return codes


def _to_deterministic_uuid(value: Any) -> str:
    raw = _js_string(_first_truthy(value, "")).strip()
    if re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", raw, re.IGNORECASE):
        return raw.lower()
    source = raw or "agents-k2-handoff"

    def fnv(seed: int) -> str:
        h = seed & 0xFFFFFFFF
        for code in _js_char_code_units(source):
            h ^= code
            h = _imul(h, 16777619)
        return format(h & 0xFFFFFFFF, "08x")

    hex_str = "".join(fnv(seed) for seed in (0x811C9DC5, 0x9E3779B9, 0x85EBCA6B, 0xC2B2AE35))
    hex_str = hex_str[:12] + "5" + hex_str[13:16] + "a" + hex_str[17:]
    return hex_str[0:8] + "-" + hex_str[8:12] + "-" + hex_str[12:16] + "-" + hex_str[16:20] + "-" + hex_str[20:32]


def prepare_handoff_input(item: Dict[str, Any], inputs: Dict[str, Any]) -> Dict[str, Any]:
    """Source node: Prepare Handoff Input (extracted/code/Prepare_Handoff_Input.js).

    Args:
        item: current pipeline item ($json) — the parent payload.
        inputs keys:
          system_orchestrator <- 'System Orchestrator (Policy)' (system_decision, proposal)
          normalize_validate  <- 'Normalize & Validate'
          conversation_state  <- 'Get Conversation State' (state_data)
    Returns the parent payload plus the handoff_input envelope (reason_code /
    priority inference from the Arabic+English keyword ladders, deterministic
    correlation/channel UUIDs, context_snapshot, metadata).
    """
    parent_payload = dict(item or {})
    inputs = inputs or {}
    output = _first_truthy(_prop(parent_payload, "output"), {})
    orchestrator = _first_truthy(inputs.get("system_orchestrator", _UNDEFINED), {})
    decision = _first_truthy(_prop(orchestrator, "system_decision"), {})
    proposal = _first_truthy(_prop(orchestrator, "proposal"), {})
    ctx = _first_truthy(inputs.get("normalize_validate", _UNDEFINED), {})
    prior_node = _first_truthy(inputs.get("conversation_state", _UNDEFINED), {})
    prior = _first_truthy(_prop(prior_node, "state_data"), {})
    text = _js_string(_first_truthy(_prop(ctx, "message_text"), "")).strip()
    correlation_source = _first_truthy(
        _prop(ctx, "idempotency_key"),
        _prop(ctx, "message_id"),
        _js_string(_first_truthy(_prop(ctx, "conversation_id"), "")) + ":" + text,
    )
    correlation_id = _to_deterministic_uuid(correlation_source)
    raw_channel_id = _js_string(_first_truthy(_prop(ctx, "channel_id"), "")).strip()
    normalized_channel_id = _to_deterministic_uuid(
        _js_string(_first_truthy(_prop(ctx, "channel_type"), "unknown")) + ":" + (raw_channel_id or "unknown")
    )
    raw_reason = _js_string(
        _first_truthy(
            _prop(output, "handoff_reason"),
            _prop(output, "escalation_reason"),
            _prop(proposal, "handoff_reason"),
            _prop(proposal, "escalation_reason"),
            "",
        )
    ).strip()
    reason_text = " ".join(part for part in (raw_reason, text) if _js_truthy(part)).lower()

    def has(pattern: "re.Pattern[str]") -> bool:
        return pattern.search(reason_text) is not None

    reason_code = "AI_UNABLE_TO_HELP"
    if has(_RE_PATIENT_HUMAN):
        reason_code = "PATIENT_REQUESTED_HUMAN"
    elif has(_RE_COMPLAINT):
        reason_code = "COMPLAINT"
    elif has(_RE_PAYMENT):
        reason_code = "PAYMENT_ISSUE"
    elif has(_RE_SYSTEM):
        reason_code = "SYSTEM_EXCEPTION"
    elif has(_RE_APPOINTMENT):
        reason_code = "APPOINTMENT_EXCEPTION"
    elif _js_number(_coalesce(_prop(output, "confidence"), _prop(proposal, "confidence"), 1)) < _js_number(
        _coalesce(_prop(decision, "confidence_threshold"), 0.75)
    ):
        reason_code = "LOW_CONFIDENCE"
    priority = "NORMAL"
    if has(_RE_URGENT):
        priority = "URGENT"
    elif reason_code in ("COMPLAINT", "PAYMENT_ISSUE", "APPOINTMENT_EXCEPTION"):
        priority = "HIGH"
    booking = _first_truthy(
        _prop(output, "booking_context"), _prop(output, "slot_state"),
        _prop(prior, "booking_context"), _prop(prior, "slot_state"), {},
    )
    prior_turns = _prop(prior, "recent_turns")
    context_snapshot = {
        "message_text": text,
        "latest_reply": _first_truthy(
            _prop(output, "final_reply"), _prop(output, "reply_text"), _prop(decision, "final_reply"), ""
        ),
        "conversation_summary": _first_truthy(_prop(prior, "conversation_summary"), ""),
        "recent_turns": prior_turns[-4:] if isinstance(prior_turns, list) else [],
        "booking_context": booking,
        "appointment_id": _first_truthy(_prop(output, "appointment_id"), _prop(prior, "appointment_id"), None),
    }
    metadata = {
        "source": "agents_k2",
        "response_code": _first_truthy(_prop(output, "response_code"), _prop(decision, "response_code"), "HANDOFF_REQUIRED"),
        "intent": _first_truthy(_prop(output, "intent"), _prop(proposal, "intent"), None),
        "proposed_action": _first_truthy(_prop(output, "proposed_action"), _prop(proposal, "proposed_action"), None),
        "confidence": _coalesce(_prop(output, "confidence"), _prop(proposal, "confidence"), None),
        "reason_inferred": not _js_truthy(raw_reason),
        "source_idempotency_key": _first_truthy(_prop(ctx, "idempotency_key"), None),
        "raw_channel_id": raw_channel_id or None,
        "normalized_channel_id": normalized_channel_id,
        "workflow_version": "handoff-link-v2",
    }
    return {
        **parent_payload,
        "handoff_input": {
            "clinic_id": _first_truthy(_prop(ctx, "clinic_id"), ""),
            "conversation_id": _first_truthy(_prop(ctx, "conversation_id"), ""),
            "patient_id": _first_truthy(_prop(ctx, "patient_id"), ""),
            "channel_type": _first_truthy(_prop(ctx, "channel_type"), ""),
            "channel_id": normalized_channel_id,
            "handoff_reason": raw_reason or "agent_escalation",
            "reason_code": reason_code,
            "reason_note": raw_reason or None,
            "correlation_id": correlation_id,
            "source_message_id": _first_truthy(_prop(ctx, "message_id"), ""),
            "priority": priority,
            "context_snapshot": context_snapshot,
            "metadata": metadata,
        },
    }


# ---------------------------------------------------------------------------
# Validate Child Envelope
# ---------------------------------------------------------------------------

_ENVELOPE_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)

_ALLOWED_SUCCESS = {
    "create_appointment": {"CREATE_COMPLETED", "IDEMPOTENT_REPLAY"},
    "cancel_appointment": {"CANCEL_COMPLETED", "IDEMPOTENT_REPLAY"},
    "reschedule_appointment": {"RESCHEDULE_COMPLETED", "IDEMPOTENT_REPLAY"},
}
_ALLOWED_FAILURE = {
    "create_appointment": {
        "CONTRACT_INVALID", "PATIENT_NOT_FOUND", "PATIENT_DATA_REQUIRED", "DOCTOR_INVALID",
        "SERVICE_INVALID", "SLOT_INVALID", "MISSING_REQUIRED_FIELDS", "SLOT_UNAVAILABLE",
        "RPC_ERROR", "UNKNOWN_RESPONSE", "CREATE_APPOINTMENT_FAILED", "CREATE_RETRYABLE",
        "SLOT_ALREADY_BOOKED", "SLOT_INCOMPATIBLE", "CURRENT_SLOT_STATE_INVALID",
        "CURRENT_SLOT_MISSING", "SLOT_STALE", "OPERATION_IN_PROGRESS",
        "DAILY_BOOKING_SEQUENCE_EXHAUSTED", "CLINIC_TIMEZONE_NOT_CONFIGURED",
        "PROVIDER_SUCCESS_INVALID", "REPLAY_CONTRACT_INVALID",
    },
    "cancel_appointment": {
        "CONTRACT_INVALID", "MISSING_REQUIRED_FIELD", "PATIENT_NOT_FOUND",
        "APPOINTMENT_NOT_FOUND_OR_NOT_OWNED", "CANCELLATION_NOT_ALLOWED", "CANCEL_RETRYABLE",
        "CANCEL_NOT_ALLOWED", "CURRENT_APPOINTMENT_STATE_INVALID", "OPERATION_IN_PROGRESS",
        "RPC_ERROR", "UNKNOWN_RESPONSE", "PROVIDER_SUCCESS_INVALID", "REPLAY_CONTRACT_INVALID",
    },
    "reschedule_appointment": {
        "CONTRACT_INVALID", "MISSING_REQUIRED_FIELD", "INVALID_UUID", "INVALID_OPERATION_ID",
        "APPOINTMENT_NOT_FOUND_OR_NOT_OWNED", "RESCHEDULE_NOT_ALLOWED", "SLOT_UNAVAILABLE",
        "SAME_SLOT", "RESCHEDULE_CONFLICT", "RESCHEDULE_RETRYABLE", "CURRENT_SLOT_STATE_INVALID",
        "CURRENT_SLOT_MISSING", "SLOT_INCOMPATIBLE", "OPERATION_IN_PROGRESS", "RPC_ERROR",
        "MISSING_REQUIRED_FIELDS", "UNKNOWN_RESPONSE", "PROVIDER_SUCCESS_INVALID",
    },
}


def _text_value(value: Any) -> str:
    return "" if value is None or value is _UNDEFINED else _js_string(value).strip()


def validate_child_envelope(item: Dict[str, Any], inputs: Dict[str, Any], execution_id: Optional[Any] = None) -> Dict[str, Any]:
    """Source node: Validate Child Envelope (extracted/code/Validate_Child_Envelope.js).

    Args:
        item: current pipeline item ($input.item.json — the child response row).
        inputs keys:
          system_orchestrator  <- 'System Orchestrator (Policy)' (uses .system_decision)
          normalize_validate   <- 'Normalize & Validate'
          apply_operation_claim <- 'Apply Operation Claim (Deterministic)' (operation_id)
        execution_id: n8n $execution.id equivalent. PORT-TODO(n8n): runtime value;
            the runner may pass it, otherwise the JS empty-string branch is used.
    Returns the validated child response ({..., child_contract_checked: true,
    child_contract_valid: true}) or the CHILD_CONTRACT_INVALID envelope with the
    Arabic message 'تعذر التحقق من عقد نتيجة العملية قبل التنفيذ النهائي'.
    """
    raw = item or {}
    inputs = inputs or {}
    decision = {}
    try:
        decision = _first_truthy(_prop(inputs.get("system_orchestrator", _UNDEFINED), "system_decision"), {})
    except Exception:
        decision = {}
    context = {}
    try:
        context = _first_truthy(inputs.get("normalize_validate", _UNDEFINED), {})
    except Exception:
        context = {}

    schema_version = 1
    action = _text_value(_first_truthy(_prop(decision, "action"), _dig(decision, "confirmation_target", "action"))).lower()
    operation_by_action = {
        "create_appointment": "create_appointment",
        "cancel_appointment": "cancel_appointment",
        "reschedule_appointment": "reschedule_appointment",
    }
    expected_operation = operation_by_action.get(action, "")
    target = _prop(decision, "confirmation_target")
    target = target if isinstance(target, (dict, list)) else {}
    claimed_operation_id = ""
    try:
        claimed_node = inputs.get("apply_operation_claim")
        claimed_operation_id = _text_value(_prop(claimed_node, "operation_id")) if _js_truthy(claimed_node) else ""
    except Exception:
        claimed_operation_id = ""
    if action == "create_appointment":
        create_branch = _first_truthy(
            _prop(context, "operation_id"),
            (_js_string(_first_truthy(_prop(context, "idempotency_key"), "")) + ":create_appointment") if _js_truthy(_prop(context, "idempotency_key")) else "",
        )
    else:
        create_branch = ""
    if action == "cancel_appointment":
        cancel_branch = (_js_string(_first_truthy(_prop(context, "idempotency_key"), "")) + ":cancel_appointment") if _js_truthy(_prop(context, "idempotency_key")) else ""
    else:
        cancel_branch = ""
    expected_operation_id = _text_value(_first_truthy(claimed_operation_id, _prop(target, "operation_id"), create_branch, cancel_branch))
    expected_correlation_id = _text_value(_prop(context, "correlation_id")) or _text_value(claimed_operation_id)

    def invalid(reason: str) -> Dict[str, Any]:
        return {
            "schema_version": schema_version,
            "operation": expected_operation or None,
            "correlation_id": expected_correlation_id or None,
            "operation_id": expected_operation_id or None,
            "response_code": "CHILD_CONTRACT_INVALID",
            "success": False,
            "retryable": False,
            "appointment_id": None,
            "error_code": "CHILD_CONTRACT_INVALID",
            "operation_status": "failed_final",
            "child_contract_checked": True,
            "child_contract_valid": False,
            "contract_error": reason,
            "message": "تعذر التحقق من عقد نتيجة العملية قبل التنفيذ النهائي",
        }

    if not _js_truthy(expected_operation):
        return invalid("UNEXPECTED_OPERATION")
    response = _prop(raw, "child_response")
    response = response if isinstance(response, (dict, list)) else raw
    response_code = _text_value(_prop(response, "response_code")).upper()
    response_operation = _text_value(_prop(response, "operation")).lower()
    response_correlation = _text_value(_prop(response, "correlation_id"))
    response_operation_id = _text_value(_prop(response, "operation_id"))
    success = _prop(response, "success") is True
    retryable = _prop(response, "retryable")
    appointment_id = _text_value(_prop(response, "appointment_id"))

    # EXEC-SQL-ENVELOPE-PATCH: a direct Execute SQL output {id, public_id} maps to
    # the expected success envelope.
    sql_direct = _has_key(raw, "id") or (isinstance(raw, dict) and len(raw) <= 4 and ("id" in raw or "public_id" in raw))
    direct_create_success = bool(
        expected_operation == "create_appointment"
        and isinstance(raw, dict)
        and _prop(raw, "success") is True
        and _js_string(_first_truthy(_prop(raw, "response_code"), "")).upper() == "APPOINTMENT_CREATED"
        and _ENVELOPE_UUID_RE.match(_js_string(_first_truthy(_prop(raw, "appointment_id"), _prop(raw, "id"), "")))
        and bool(_js_truthy(_prop(raw, "booking_number")) or _js_truthy(_prop(raw, "public_id")))
    )
    if (sql_direct and isinstance(raw, dict) and len(raw) <= 4) or direct_create_success:
        direct_id = _js_string(_first_truthy(_prop(raw, "appointment_id"), _prop(raw, "id"), ""))
        if _ENVELOPE_UUID_RE.match(direct_id):
            direct_code_by_action = {
                "create_appointment": "CREATE_COMPLETED",
                "cancel_appointment": "CANCEL_COMPLETED",
                "reschedule_appointment": "RESCHEDULE_COMPLETED",
            }
            raw = {
                "schema_version": schema_version,
                "operation": expected_operation,
                "correlation_id": expected_correlation_id,
                "operation_id": expected_operation_id,
                "response_code": direct_code_by_action.get(expected_operation, "UNKNOWN_RESPONSE"),
                "success": True,
                "retryable": False,
                "appointment_id": direct_id,
                "booking_number": _first_truthy(_prop(raw, "booking_number"), _prop(raw, "public_id"), None),
                "mutation_status": _first_truthy(_prop(raw, "mutation_status"), "succeeded"),
                "child_execution_id": _js_string(execution_id) if _js_truthy(execution_id) else "",
            }
            response = raw
            response_code = _text_value(_prop(response, "response_code")).upper()
            response_operation = _text_value(_prop(response, "operation")).lower()
            response_correlation = _text_value(_prop(response, "correlation_id"))
            response_operation_id = _text_value(_prop(response, "operation_id"))
            success = _prop(response, "success") is True
            retryable = _prop(response, "retryable")
            appointment_id = _text_value(_prop(response, "appointment_id"))

    if _js_number(_prop(response, "schema_version")) != schema_version:
        return invalid("SCHEMA_VERSION_MISMATCH")
    if response_operation != expected_operation:
        return invalid("OPERATION_MISMATCH")
    if not _js_truthy(expected_correlation_id) or response_correlation != expected_correlation_id:
        return invalid("CORRELATION_ID_MISMATCH")
    if not _js_truthy(expected_operation_id) or response_operation_id != expected_operation_id:
        return invalid("OPERATION_ID_MISMATCH")
    if not isinstance(success, bool) or not isinstance(retryable, bool) or not _js_truthy(response_code):
        return invalid("MISSING_EXPLICIT_CONTRACT_FIELD")

    if success:
        if response_code not in _ALLOWED_SUCCESS.get(expected_operation, set()):
            return invalid("SUCCESS_CODE_NOT_ALLOWED")
        if not _ENVELOPE_UUID_RE.match(appointment_id):
            return invalid("SUCCESS_APPOINTMENT_ID_INVALID")
        if retryable is not False:
            return invalid("SUCCESS_RETRYABLE_INCONSISTENT")
    else:
        if response_code not in _ALLOWED_FAILURE.get(expected_operation, set()):
            return invalid("FAILURE_CODE_NOT_ALLOWED")
        if _js_truthy(appointment_id):
            return invalid("FAILURE_APPOINTMENT_ID_PRESENT")

    return {
        **response,
        "schema_version": schema_version,
        "operation": expected_operation,
        "child_contract_checked": True,
        "child_contract_valid": True,
    }


# ---------------------------------------------------------------------------
# Restore Handoff Context
# ---------------------------------------------------------------------------


def restore_handoff_context(item: Dict[str, Any], prepare_handoff_output: Dict[str, Any]) -> Dict[str, Any]:
    """Source node: Restore Handoff Context (extracted/code/Restore_Handoff_Context.js).

    Args:
        item: current pipeline item ($json — the handoff child workflow result).
        prepare_handoff_output: 'Prepare Handoff Input' first().json ({} when
            unavailable, mirroring the JS `|| {}`).
    Returns the parent payload plus handoff_result / handoff_created /
    handoff_request_id. Raises ValueError('K2_HANDOFF_CHILD_FAILED: <reason>')
    when the handoff was not created, matching the JS throw that halts the turn
    and fires the K2 Error Monitor (P-HANDOFF v40: failures must be loud).
    """
    parent_payload = prepare_handoff_output if _js_truthy(prepare_handoff_output) else {}
    handoff_result = item if _js_truthy(item) else {}
    result = _prop(handoff_result, "result")
    result = result if isinstance(result, (dict, list)) else handoff_result
    handoff_created_flag = (
        _prop(result, "success") is True or _prop(result, "created") is True or _prop(result, "reused") is True
    )
    if handoff_created_flag is not True:
        error_val = _prop(result, "error")
        error_branch = _first_truthy(_prop(error_val, "message"), error_val) if _js_truthy(error_val) else None
        inner = _first_truthy(_prop(result, "code"), error_branch) if _js_truthy(result) else None
        fail_reason = _js_string(_first_truthy(inner, "unknown_error"))
        raise ValueError("K2_HANDOFF_CHILD_FAILED: " + fail_reason)
    return {
        **parent_payload,
        "handoff_result": result,
        "handoff_created": handoff_created_flag,
        "handoff_request_id": _first_truthy(
            _prop(result, "handoff_request_id"), _prop(result, "request_id"), _prop(result, "id"), None
        ),
    }
