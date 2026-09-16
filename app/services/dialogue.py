"""Faithful port of the n8n `Booking Assistant Agent` LLM layer (agent k2).

Covers:
  - Booking Assistant Agent user-message assembly (agent_user_message_template.js, byte-faithful
    including the production mojibake fallbacks — kept on purpose for parity).
  - DeepSeek Model node options: temperature 0.3, max_tokens 4000, response_format json_object,
    extra body {"reasoning": {"enabled": false, "max_tokens": 2048}}.
  - DeepSeek Repair Model options: temperature 0, max_tokens 800, reasoning max_tokens 512.
The R1/R2/R3 safety layers and repair-prompt/validation live in app.core.llm_safety (separate ports)
and are composed by the pipeline runner, exactly as the n8n graph wires them.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
SYSTEM_MESSAGE_PATH = _PROMPTS_DIR / "agent_system_message.txt"


def load_system_message() -> str:
    """The exact systemMessage of the n8n Booking Assistant Agent node (8890 chars)."""
    return SYSTEM_MESSAGE_PATH.read_text(encoding="utf-8")


# ── User message assembly (Booking Assistant Agent node `text` expression) ─────
def build_user_message(
    clinic_context: Dict[str, Any],
    canonical_time_context: Dict[str, Any],
    normalized: Dict[str, Any],
    persona_context: Dict[str, Any],
    state_data: Dict[str, Any],
    faq_result: Optional[Dict[str, Any]],
) -> str:
    """Source node: Booking Assistant Agent (text expression). Returns the JSON.stringify'd payload."""
    c = clinic_context or {}
    t = (canonical_time_context or {})
    x = normalized or {}
    b = persona_context or {}
    st = state_data or {}

    persona = {
        "clinic": c.get("clinic_name") or "",
        "assistant": (c.get("persona") or {}).get("name") or "┘å┘ê╪▒",  # production mojibake, kept for parity
        "role": (c.get("persona") or {}).get("role") or "┘à╪│╪º╪╣╪»╪⌐ ╪º╪│╪¬┘é╪¿╪º┘ä ┘ê╪¡╪¼┘ê╪▓╪º╪¬",  # kept for parity
        "tone": (c.get("persona") or {}).get("tone") or "warm_professional",
        "dialect": (c.get("persona") or {}).get("dialect") or "saudi",
    }
    faq = faq_result if (faq_result and len(faq_result) > 0) else None
    include_faq_facts = b.get("agent_prompt_profile") == "clinic_query" and bool(faq) and isinstance(faq.get("results"), list) and len(faq["results"]) > 0
    service = b.get("service_facts") or {}
    # Computed in the source template but never placed into the payload — kept for fidelity.
    include_service = service.get("is_service_fact_inquiry") is True or service.get("is_price_inquiry") is True or service.get("is_service_catalog_inquiry") is True  # noqa: F841
    bc = st.get("booking_context") or {}
    conf = st.get("confirmation_target") if (st.get("confirmation_target") and st.get("confirmation_state") == "required") else None
    offered_raw = st.get("pending_offer", {}).get("alternatives", []) if isinstance(st.get("pending_offer"), dict) and isinstance(st.get("pending_offer", {}).get("alternatives"), list) else []
    review = st.get("patient_data_review") or None
    collecting = not conf
    appt = bc.get("appointment_type") or None
    must_ask = st.get("turn_directive", {}).get("must_ask", []) if isinstance(st.get("turn_directive"), dict) and isinstance(st.get("turn_directive", {}).get("must_ask"), list) else []
    missing = st.get("missing_human_fields") if isinstance(st.get("missing_human_fields"), list) else []
    asked = st.get("last_open_question", {}).get("requested_fields", []) if isinstance(st.get("last_open_question"), dict) and isinstance(st.get("last_open_question", {}).get("requested_fields"), list) else []
    want_ref = (isinstance(must_ask, list) and "appointment_id" in must_ask) or (isinstance(asked, list) and "appointment_id" in asked) or (isinstance(missing, list) and "appointment_id" in missing)

    next_ask = None
    if conf:
        if review and review.get("status") == "pending":
            next_ask = "patient_data_confirm"
    elif want_ref:
        next_ask = "appointment_reference"
    elif collecting:
        if not appt:
            next_ask = "visit_type"
        elif len(asked) == 1:
            next_ask = asked[0]
        elif len(must_ask) == 1:
            next_ask = must_ask[0]
        elif missing:
            order = ["date", "time", "reference", "patient_name", "patient_phone", "patient_age", "patient_address"]
            next_ask = next((f for f in order if f in missing), missing[0])

    payload = {
        "assistant_persona": persona,
        "clinic_name": c.get("clinic_name") or None,
        "context": {
            "clinic_name": c.get("clinic_name") or None,
            "local_time": {
                "timezone": t.get("timezone") or None,
                "date": t.get("now_local_date") or None,
                "time": t.get("now_local_time") or None,
                "offset": t.get("utc_offset") or None,
            },
            "doctors": {"count": c.get("doctor_count") or 0, "directory": b.get("clinic_doctor_directory") or []},
        },
        "situation": {
            "today": t.get("now_local_date") or None,
            "current_booking": ({"doctor_name": bc.get("doctor_name") or None, "doctor_id": bc.get("doctor_id") or None,
                                 "date": bc.get("date") or None, "time": bc.get("time") or None}
                                if (bc.get("doctor_name") or bc.get("doctor_id") or bc.get("date")) else None),
            "pending_confirmation": ({"action": conf.get("action") or None, "doctor_name": conf.get("doctor_name") or None,
                                      "date": conf.get("date") or None, "time": conf.get("time") or None,
                                      "expires_at": conf.get("expires_at") or None} if conf else None),
            "offered": [{"rank": s.get("rank") or None, "date": s.get("local_date") or None, "time": s.get("local_time") or None} for s in offered_raw],
            "patient_review": ({"status": "pending", "fields": review.get("fields") or None} if review and review.get("status") == "pending" else None),
            "next_ask": next_ask,
        },
        "faq_facts": faq if include_faq_facts else None,
        "current_message": x.get("message_text") or "",
    }
    return json.dumps(payload, ensure_ascii=False, separators=(", ", ": "))


# ── Check Doctor Availability tool (n8n toolWorkflow node, verbatim description) ──
AVAILABILITY_TOOL_DESCRIPTION = (
    "Check available appointment slots for a doctor on a date in the clinic local calendar. "
    "CALL ONLY when the patient explicitly asks about available times/days or states a specific day "
    "AND the doctor is known. A plain booking request with no day and no time (e.g. \"عايز احجز عند الدكتور X\", "
    "\"ابغى موعد\") is NOT a call trigger: never check availability for it, never use today's date for it — "
    "ask which day suits the patient naturally. Never answer with 'I will check' or 'one moment' instead of "
    "calling it when a day was asked. If the patient asks for any available time without naming a day "
    "(e.g. 'أي وقت متاح', 'احجز لي أي وقت', 'أقرب موعد'), use today's clinic-local date from "
    "context.local_time.date - the system searches the nearby days and returns the nearest verified slots. "
    "doctor_id = the doctor name exactly as the patient wrote it, or a doctor id you already have. "
    "requested_date = ISO YYYY-MM-DD. The subworkflow resolves the doctor name and returns verified slots: "
    "present up to 4 (day and time) and ask which one. Never announce unavailability for a day the patient "
    "did not name; when the checked day has no slots, present the nearest verified slots the subworkflow "
    "returned. On error or zero verified slots, say honestly that nothing verified was found or the check "
    "failed - never invent dates, times, or slots, and never mention tools or IDs."
)

AVAILABILITY_TOOL = {
    "type": "function",
    "function": {
        "name": "Check_Doctor_Availability",
        "description": AVAILABILITY_TOOL_DESCRIPTION,
        "parameters": {
            "type": "object",
            "properties": {
                "doctor_id": {"type": "string",
                              "description": "Doctor name exactly as the patient wrote it, or a doctor id already known"},
                "requested_date": {"type": "string",
                                   "description": "ISO YYYY-MM-DD date in the clinic local calendar"},
            },
            "required": [],
        },
    },
}


# ── DeepSeek Model node (primary) ───────────────────────────────────────────────
async def call_primary_model(user_message: str, tools: Optional[list] = None) -> Any:
    """Source node: Booking Assistant Agent -> DeepSeek Model (lmChatOpenAi options ported verbatim).

    Returns the assistant message dict (with content and/or tool_calls)."""
    body = {
        "model": settings.LLM_PRIMARY_MODEL,
        "messages": [
            {"role": "system", "content": load_system_message()},
            {"role": "user", "content": user_message},
        ],
        "temperature": 0.3,
        "max_tokens": 4000,
        "response_format": {"type": "json_object"},
        "reasoning": {"enabled": False, "max_tokens": 2048},
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    headers = {"Authorization": f"Bearer {settings.LLM_PRIMARY_API_KEY}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=settings.LLM_TIMEOUT_SECONDS) as client:
        resp = await client.post(f"{settings.LLM_PRIMARY_BASE_URL.rstrip('/')}/chat/completions", headers=headers, json=body)
        if resp.status_code != 200:
            raise RuntimeError(f"primary LLM HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
    return data["choices"][0]["message"]


async def call_primary_model_with_tool(user_message: str, context: Dict[str, Any]) -> str:
    """Agent turn loop: the model may call the Check_Doctor_Availability tool (the ONLY
    availability path), mirroring the n8n agent + toolWorkflow wiring. Bounded loop."""
    from app.services.availability import check_available_slots

    messages: list = [
        {"role": "system", "content": load_system_message()},
        {"role": "user", "content": user_message},
    ]
    final_content: Optional[str] = None
    for _turn in range(5):
        message = await _chat_messages(messages)
        final_content = message.get("content")
        tool_calls = message.get("tool_calls") or []
        if not tool_calls:
            break
        messages.append(message)
        for tool_call in tool_calls:
            fn = (tool_call.get("function") or {})
            if fn.get("name") != "Check_Doctor_Availability":
                tool_result: Any = {"error": "UNKNOWN_TOOL"}
            else:
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                tool_input = {
                    "clinic_id": context.get("clinic_id"),
                    "conversation_id": context.get("conversation_id"),
                    "patient_id": context.get("patient_id"),
                    "doctor_id": args.get("doctor_id"),
                    "requested_date": args.get("requested_date"),
                }
                try:
                    tool_result = await check_available_slots(tool_input)
                except Exception as exc:  # the subworkflow's RPC error item
                    tool_result = {"error": str(exc)}
            messages.append({"role": "tool", "tool_call_id": tool_call.get("id"),
                             "content": json.dumps(tool_result, ensure_ascii=False)})
    return final_content or ""


async def _chat_messages(messages: list) -> Any:
    """Continuation call with accumulated messages (same model options, tools attached)."""
    body = {
        "model": settings.LLM_PRIMARY_MODEL,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 4000,
        "response_format": {"type": "json_object"},
        "reasoning": {"enabled": False, "max_tokens": 2048},
        "tools": [AVAILABILITY_TOOL],
        "tool_choice": "auto",
    }
    headers = {"Authorization": f"Bearer {settings.LLM_PRIMARY_API_KEY}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=settings.LLM_TIMEOUT_SECONDS) as client:
        resp = await client.post(f"{settings.LLM_PRIMARY_BASE_URL.rstrip('/')}/chat/completions", headers=headers, json=body)
        if resp.status_code != 200:
            raise RuntimeError(f"primary LLM HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
    return data["choices"][0]["message"]


# ── DeepSeek Repair Chain (chainLlm + DeepSeek Repair Model) ────────────────────
async def call_repair_model(prompt: str) -> str:
    """Source node: DeepSeek Repair Chain (text = $json.prompt) + DeepSeek Repair Model options."""
    body = {
        "model": settings.LLM_REPAIR_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 800,
        "reasoning": {"enabled": False, "max_tokens": 512},
    }
    headers = {"Authorization": f"Bearer {settings.LLM_REPAIR_API_KEY}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=settings.LLM_TIMEOUT_SECONDS) as client:
        resp = await client.post(f"{settings.LLM_REPAIR_BASE_URL.rstrip('/')}/chat/completions", headers=headers, json=body)
        if resp.status_code != 200:
            raise RuntimeError(f"repair LLM HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
    return data["choices"][0]["message"]["content"]


def parse_contract_json(raw_text: str) -> Dict[str, Any]:
    """Parse the model's single JSON line into the k2.dialogue.v4 contract dict. Raises ValueError."""
    raw = str(raw_text or "").strip()
    if raw.startswith("```"):
        parts = raw.split("```")
        raw = parts[1] if len(parts) > 1 else raw
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"contract is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("contract is not a JSON object")
    return parsed
