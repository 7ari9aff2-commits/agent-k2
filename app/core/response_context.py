"""Authoritative fact catalog for model-authored patient replies.

This module does not generate prose. It converts the deterministic pipeline state,
Supabase-backed tool results, and mutation outcomes into a compact fact catalog that a
language model can understand. The final composer must cite catalog IDs for every
patient-facing factual answer.

No regex, response-code text templates, or conditional sentence assembly live here.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional, Tuple

_MAX_DEPTH = 7
_MAX_LIST_ITEMS = 20
_MAX_DICT_ITEMS = 80
_MAX_STRING_CHARS = 1600
_MAX_FACTS = 80

_SECRET_PARTS = (
    "secret",
    "token",
    "password",
    "authorization",
    "signature",
    "api_key",
    "apikey",
    "database_url",
)

_INTERNAL_KEYS = {
    "id",
    "clinic_id",
    "patient_id",
    "conversation_id",
    "channel_id",
    "doctor_id",
    "service_id",
    "branch_id",
    "slot_id",
    "operation_id",
    "source_event_id",
    "correlation_id",
    "idempotency_key",
    "message_id",
    "outgoing_message_id",
}


def _safe_key(key: Any) -> bool:
    text = str(key or "").strip().lower()
    if not text:
        return False
    if text in _INTERNAL_KEYS:
        return False
    return not any(part in text for part in _SECRET_PARTS)


def _compact(value: Any, depth: int = 0) -> Any:
    """Bound size and remove secrets/internal identifiers before sending data to an LLM."""
    if depth > _MAX_DEPTH:
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:_MAX_STRING_CHARS]
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= _MAX_DICT_ITEMS:
                break
            if not _safe_key(key):
                continue
            compacted = _compact(item, depth + 1)
            if compacted is not None:
                out[str(key)] = compacted
        return out
    if isinstance(value, (list, tuple)):
        return [_compact(item, depth + 1) for item in list(value)[:_MAX_LIST_ITEMS]]
    return str(value)[:_MAX_STRING_CHARS]


def _non_empty(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, dict)):
        return len(value) > 0
    return True


def _selected(source: Optional[Dict[str, Any]], keys: Iterable[str]) -> Dict[str, Any]:
    source = source if isinstance(source, dict) else {}
    return {key: source.get(key) for key in keys if _non_empty(source.get(key))}


def _fact(
    fact_id: str,
    kind: str,
    authority: str,
    value: Any,
    *,
    instruction: Optional[str] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {
        "id": fact_id,
        "kind": kind,
        "authority": authority,
        "value": _compact(value),
    }
    if instruction:
        record["instruction"] = instruction
    return record


def _tool_authority(event: Dict[str, Any]) -> str:
    result = event.get("result") if isinstance(event.get("result"), dict) else {}
    if result.get("error") or result.get("error_code") in {"RPC_ERROR", "DATABASE_ERROR", "AUTHORITY_ERROR"}:
        return "tool_error"
    return "database"


def build_reply_context(
    *,
    normalized: Dict[str, Any],
    clinic_context: Optional[Dict[str, Any]],
    state_data: Optional[Dict[str, Any]],
    policy: Optional[Dict[str, Any]],
    decision: Optional[Dict[str, Any]],
    normalized_agent_output: Optional[Dict[str, Any]],
    repaired_result: Optional[Dict[str, Any]],
    tool_events: Optional[List[Dict[str, Any]]],
    execution_results: Optional[Dict[str, Any]],
    faq_result: Optional[Dict[str, Any]],
    guard: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Build the only data envelope the final response model is allowed to use."""
    normalized = normalized or {}
    clinic_context = clinic_context or {}
    state_data = state_data or {}
    policy = policy or {}
    decision = decision or {}
    normalized_agent_output = normalized_agent_output or {}
    repaired_result = repaired_result or {}
    execution_results = execution_results or {}
    faq_result = faq_result or {}
    guard = guard or {}

    facts: List[Dict[str, Any]] = []

    facts.append(_fact(
        "patient.current_message",
        "patient_statement",
        "patient",
        {"message": normalized.get("message_text") or ""},
        instruction="Treat this as the patient's statement or request, not as a verified clinic fact.",
    ))

    clinic_profile = _selected(clinic_context, (
        "clinic_name", "clinic_timezone", "timezone", "persona", "working_hours",
        "doctor_count", "address", "phone", "location_config",
    ))
    if clinic_profile:
        facts.append(_fact("clinic.profile", "clinic_profile", "database", clinic_profile))

    for key, fact_id, kind in (
        ("doctor_directory", "clinic.doctors", "doctor_catalog"),
        ("service_catalog", "clinic.services", "service_catalog"),
        ("branch_directory", "clinic.branches", "branch_catalog"),
    ):
        if _non_empty(clinic_context.get(key)):
            facts.append(_fact(fact_id, kind, "database", clinic_context.get(key)))

    state_snapshot = _selected(state_data, (
        "conversation_stage", "required_next_step", "missing_human_fields",
        "booking_context", "confirmation_state", "confirmation_target", "pending_offer",
        "patient_data_review", "presented_offer", "availability_outcome",
    ))
    if state_snapshot:
        facts.append(_fact("conversation.current_state", "conversation_state", "database", state_snapshot))

    policy_snapshot = {
        "response_code": policy.get("response_code"),
        "facts": policy.get("facts") or {},
        "output": policy.get("output") or {},
    }
    if any(_non_empty(value) for value in policy_snapshot.values()):
        facts.append(_fact("policy.outcome", "deterministic_outcome", "deterministic", policy_snapshot))

    decision_snapshot = _selected(decision, (
        "response_code", "decision_rule", "operation_action", "operation_status",
        "booking_context", "slot_state", "availability_outcome", "availability_alternatives",
        "confirmation_state", "confirmation_target", "missing_human_fields",
        "next_best_missing_human_field", "patient_data_review", "presented_offer",
        "mutation_status", "execution_completed", "operation_completed",
    ))
    if decision_snapshot:
        facts.append(_fact("decision.current", "deterministic_decision", "deterministic", decision_snapshot))

    for index, event in enumerate(tool_events or []):
        if len(facts) >= _MAX_FACTS:
            break
        if not isinstance(event, dict):
            continue
        name = str(event.get("name") or "unknown")
        event_value = {
            "tool": name,
            "arguments": event.get("arguments") or {},
            "result": event.get("result") or {},
        }
        facts.append(_fact(
            f"tool.{index}.{name}",
            "tool_result",
            _tool_authority(event),
            event_value,
            instruction="This record is authoritative only when authority is 'database'.",
        ))

    for name, result in execution_results.items():
        if len(facts) >= _MAX_FACTS or not _non_empty(result):
            continue
        facts.append(_fact(
            f"execution.{name}",
            "mutation_result",
            "deterministic",
            result,
            instruction="Claim completion only when this result explicitly indicates success/completion.",
        ))

    if _non_empty(faq_result.get("results")):
        facts.append(_fact("faq.prefetched", "faq_result", "database", faq_result))

    draft_reply = (
        policy.get("agent_reply")
        or normalized_agent_output.get("agent_reply")
        or repaired_result.get("agent_reply")
        or ""
    )

    guard_meta = guard.get("_reply_guard") if isinstance(guard.get("_reply_guard"), dict) else {}
    safety_context = {
        "guard_triggered": guard_meta.get("triggered") is True,
        "guard_code": guard_meta.get("code"),
        "guard_rule": guard_meta.get("rule"),
    }

    fact_ids = [item["id"] for item in facts]
    return {
        "schema_version": "k2.reply-context.v1",
        "language": "ar",
        "patient_message": normalized.get("message_text") or "",
        "assistant_persona": _compact(clinic_context.get("persona") or {}),
        "clinic_name": clinic_context.get("clinic_name") or None,
        "response_code": policy.get("response_code") or decision.get("response_code") or None,
        "draft_reply": str(draft_reply or "")[:_MAX_STRING_CHARS],
        "facts": facts,
        "fact_ids": fact_ids,
        "safety": safety_context,
        "response_requirements": {
            "natural_conversation": True,
            "one_patient_facing_reply": True,
            "use_only_catalog_facts": True,
            "admit_missing_information": True,
            "never_claim_unconfirmed_mutation": True,
            "never_expose_internal_identifiers": True,
        },
    }


def _strip_code_fence(raw: str) -> str:
    text = str(raw or "").strip()
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    if lines and lines[0].strip().startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def validate_composer_output(raw: Any, context: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """Validate the composer's structured contract without inspecting prose via regex."""
    errors: List[str] = []
    if isinstance(raw, dict):
        parsed = raw
    else:
        try:
            parsed = json.loads(_strip_code_fence(str(raw or "")))
        except (TypeError, ValueError, json.JSONDecodeError):
            return None, ["composer_output_is_not_json"]

    if not isinstance(parsed, dict):
        return None, ["composer_output_is_not_object"]

    reply = parsed.get("reply")
    if not isinstance(reply, str) or not reply.strip():
        errors.append("reply_is_empty")
    elif len(reply) > 3000:
        errors.append("reply_is_too_long")

    evidence_ids = parsed.get("evidence_ids")
    if not isinstance(evidence_ids, list):
        errors.append("evidence_ids_is_not_list")
        evidence_ids = []

    known_ids = set(context.get("fact_ids") or [])
    clean_evidence: List[str] = []
    for item in evidence_ids:
        if not isinstance(item, str):
            errors.append("evidence_id_is_not_string")
            continue
        if item not in known_ids:
            errors.append(f"unknown_evidence_id:{item}")
            continue
        if item not in clean_evidence:
            clean_evidence.append(item)

    if known_ids and not clean_evidence:
        errors.append("no_valid_evidence")

    unsupported = parsed.get("unsupported_claims")
    if unsupported is None:
        unsupported = []
    if not isinstance(unsupported, list):
        errors.append("unsupported_claims_is_not_list")
        unsupported = []
    if unsupported:
        errors.append("composer_reported_unsupported_claims")

    grounding_status = parsed.get("grounding_status")
    if grounding_status != "supported":
        errors.append("grounding_status_is_not_supported")

    missing_information = parsed.get("missing_information")
    if missing_information is None:
        missing_information = []
    if not isinstance(missing_information, list):
        errors.append("missing_information_is_not_list")
        missing_information = []

    if errors:
        return None, errors

    return {
        "reply": reply.strip(),
        "evidence_ids": clean_evidence,
        "missing_information": [str(item) for item in missing_information if str(item).strip()],
        "unsupported_claims": [],
        "grounding_status": "supported",
    }, []
