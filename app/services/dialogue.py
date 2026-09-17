"""Faithful port of the n8n `Booking Assistant Agent` LLM layer (agent k2).

Covers:
  - Booking Assistant Agent user-message assembly (agent_user_message_template.js, byte-faithful
    including the production mojibake fallbacks — kept on purpose for parity).
  - DeepSeek Model node options: temperature 0.3, max_tokens 4000, response_format json_object.
  - DeepSeek Repair Model options: temperature 0, max_tokens 800.
  - Reasoning: the n8n node also sent {"reasoning": {"enabled": false, "max_tokens": 2048}}.
    That is now OPT-IN (LLM_SEND_REASONING_PARAM) because reasoning models served by other
    gateways (e.g. Novita's zai-org/glm-5.3-flash) ignore the flag and still consume the
    completion budget on hidden reasoning — with a small max_tokens the visible content
    comes back empty. See _reasoning_options().
The R1/R2/R3 safety layers and repair-prompt/validation live in app.core.llm_safety (separate ports)
and are composed by the pipeline runner, exactly as the n8n graph wires them.
"""
from __future__ import annotations

from datetime import datetime
import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional
from zoneinfo import ZoneInfo

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
SYSTEM_MESSAGE_PATH = _PROMPTS_DIR / "agent_system_message.txt"
RESPONSE_COMPOSER_SYSTEM_MESSAGE_PATH = _PROMPTS_DIR / "response_composer_system_message.txt"


def load_system_message() -> str:
    """System message for the dialogue analyzer and tool-using agent."""
    return SYSTEM_MESSAGE_PATH.read_text(encoding="utf-8")


def load_response_composer_system_message() -> str:
    """Instructions for the model-authored final patient reply."""
    return RESPONSE_COMPOSER_SYSTEM_MESSAGE_PATH.read_text(encoding="utf-8")


def _reasoning_options() -> Dict[str, Any]:
    """Optional reasoning block — sent only when the provider actually honours it.

    Reasoning models such as zai-org/glm-5.3-flash ignore ``enabled: false`` and still
    consume the completion budget on hidden reasoning. Sending the block with a small
    ``max_tokens`` makes the visible ``content`` come back empty, so it is opt-in.
    """
    if not getattr(settings, "LLM_SEND_REASONING_PARAM", False):
        return {}
    return {"reasoning": {"enabled": False,
                          "max_tokens": int(getattr(settings, "LLM_REASONING_MAX_TOKENS", 2048))}}


def _extract_message_content(message: Dict[str, Any]) -> str:
    """Visible assistant text, tolerating reasoning-only responses.

    Some gateways return ``content`` plus a separate ``reasoning_content``. When the
    completion budget is consumed by reasoning the visible content is empty and the
    finish reason is ``length``; callers must treat that as an empty reply rather than
    leaking internal reasoning to the patient.
    """
    content = message.get("content")
    if isinstance(content, list):
        content = "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return str(content or "")


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
        "assistant": (c.get("persona") or {}).get("name") or "نور",
        "role": (c.get("persona") or {}).get("role") or "مساعدة استقبال وحجوزات",
        "tone": (c.get("persona") or {}).get("tone") or "warm_professional",
        "dialect": (c.get("persona") or {}).get("dialect") or "saudi",
    }
    faq = faq_result if (faq_result and len(faq_result) > 0) else None
    include_faq_facts = bool(faq) and isinstance(faq.get("results"), list) and len(faq["results"]) > 0
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

    local_tz_str = t.get("timezone")
    local_date = t.get("now_local_date")
    local_time = t.get("now_local_time")
    now_iso = t.get("now_iso")
    if (not local_date or not local_time) and now_iso and local_tz_str:
        try:
            dt = datetime.fromisoformat(str(now_iso).replace("Z", "+00:00"))
            local_dt = dt.astimezone(ZoneInfo(str(local_tz_str)))
            if not local_date:
                local_date = local_dt.strftime("%Y-%m-%d")
            if not local_time:
                local_time = local_dt.strftime("%H:%M:%S")
        except Exception:
            pass

    payload = {
        "assistant_persona": persona,
        "clinic_name": c.get("clinic_name") or None,
        "context": {
            "clinic_name": c.get("clinic_name") or None,
            "local_time": {
                "timezone": local_tz_str or None,
                "date": local_date or None,
                "time": local_time or None,
                "offset": t.get("utc_offset") or None,
            },
            "doctors": {"count": c.get("doctor_count") or 0, "directory": b.get("clinic_doctor_directory") or []},
        },
        "situation": {
            "today": local_date or None,
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
    "CALL whenever the patient explicitly asks about available times/days or states a specific day "
    "or wants to book/reschedule an appointment. Returns real available slots from the clinic database. "
    "Never invent dates, times, or slots."
)

AVAILABILITY_TOOL = {
    "type": "function",
    "function": {
        "name": "Check_Doctor_Availability",
        "description": AVAILABILITY_TOOL_DESCRIPTION,
        "parameters": {
            "type": "object",
            "properties": {
                "doctor_id": {
                    "type": "string",
                    "description": "Doctor name exactly as the patient wrote it, or a doctor id already known",
                },
                "requested_date": {
                    "type": "string",
                    "description": "ISO YYYY-MM-DD date in the clinic local calendar",
                },
                "service_id": {
                    "type": "string",
                    "description": "Service UUID if known, or null",
                },
            },
            "required": ["doctor_id", "requested_date"],
        },
    },
}

FAQ_TOOL = {
    "type": "function",
    "function": {
        "name": "Search_Clinic_FAQ",
        "description": (
            "Search the clinic knowledge base and FAQ for verified answers regarding "
            "clinic working hours, address, location, prices, accepted insurances, "
            "appointment policies, preparation instructions, and doctor credentials. "
            "Always use this tool when answering patient questions about the clinic."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The specific question or search query in Arabic",
                },
            },
            "required": ["query"],
        },
    },
}

SERVICES_DOCTORS_TOOL = {
    "type": "function",
    "function": {
        "name": "Get_Clinic_Services_And_Doctors",
        "description": (
            "Get the verified list of active doctors, their specialties, branches, "
            "and the clinic service catalog with official prices. Call this when the "
            "patient asks who the doctors are, what specialties exist, or what services and prices are offered."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "description": "Optional category filter, or null for all",
                },
            },
        },
    },
}

PATIENT_APPOINTMENTS_TOOL = {
    "type": "function",
    "function": {
        "name": "Get_My_Appointments",
        "description": (
            "Retrieve the patient's existing or upcoming appointments at this clinic. "
            "Call this when the patient asks to view, reschedule, or cancel their appointment."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "booking_number": {
                    "type": "string",
                    "description": "Optional booking number or appointment ID if mentioned by the patient",
                },
            },
        },
    },
}

RECEPTIONIST_TOOLS = [
    AVAILABILITY_TOOL,
    FAQ_TOOL,
    SERVICES_DOCTORS_TOOL,
    PATIENT_APPOINTMENTS_TOOL,
]


# ── DeepSeek Model node (primary) ───────────────────────────────────────────────
async def call_primary_model(user_message: str, tools: Optional[list] = None) -> Any:
    """DEPRECATED / UNUSED — the pre-tools single-shot model call.

    Superseded by ``call_primary_model_with_tool``, which is the only agent entry point
    the pipeline uses. Kept only because it is the documented port of the n8n
    "DeepSeek Model" node (docs/port_conventions.md). Do NOT wire it back in: it has no
    reception tools, so it cannot ground availability, catalog, or appointment answers
    in Supabase data.
    """
    body: Dict[str, Any] = {
        "model": settings.LLM_PRIMARY_MODEL,
        "messages": [
            {"role": "system", "content": load_system_message()},
            {"role": "user", "content": user_message},
        ],
        "temperature": 0.3,
        "max_tokens": 4000,
        **_reasoning_options(),
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    else:
        body["response_format"] = {"type": "json_object"}
    headers = {"Authorization": f"Bearer {settings.LLM_PRIMARY_API_KEY}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=settings.LLM_TIMEOUT_SECONDS) as client:
        resp = await client.post(f"{settings.LLM_PRIMARY_BASE_URL.rstrip('/')}/chat/completions", headers=headers, json=body)
        if resp.status_code != 200:
            raise RuntimeError(f"primary LLM HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
    return data["choices"][0]["message"]


class AgentTurnText(str):
    """String-compatible agent output carrying the authoritative tool trace.

    Keeping this as a ``str`` preserves the existing LLM safety/contract adapters and
    external tests while making every Supabase result available to the final composer.
    """

    tool_events: list[Dict[str, Any]]
    llm_calls: int

    def __new__(cls, content: str, *, tool_events: Optional[list[Dict[str, Any]]] = None,
                llm_calls: int = 0) -> "AgentTurnText":
        obj = str.__new__(cls, content or "")
        obj.tool_events = list(tool_events or [])
        obj.llm_calls = int(llm_calls)
        return obj


async def call_primary_model_with_tool(user_message: str, context: Dict[str, Any]) -> AgentTurnText:
    """Analyze the turn and use reception tools when the request needs real data.

    Returns a string-compatible result plus ``tool_events``. The tool trace is retained
    for the final response composer instead of disappearing inside the chat loop.
    """
    from app.services.availability import check_available_slots
    from app.services import faq as faq_service
    from app.db import repository

    messages: list = [
        {"role": "system", "content": load_system_message()},
        {"role": "user", "content": user_message},
    ]
    final_content: Optional[str] = None
    tool_events: list[Dict[str, Any]] = []
    tool_cache: Dict[str, Any] = {}
    llm_calls = 0
    total_tool_calls = 0
    max_turns = max(2, int(getattr(settings, "LLM_TOOL_MAX_TURNS", 3)))
    max_tool_calls = max(1, int(getattr(settings, "LLM_TOOL_MAX_CALLS", 4)))
    for turn in range(max_turns):
        allow_tools = (turn < max_turns - 1)
        message = await _chat_messages(messages, with_tools=allow_tools, force_json=(not allow_tools))
        llm_calls += 1
        final_content = message.get("content")
        tool_calls = message.get("tool_calls") or []
        if not tool_calls or not allow_tools:
            break
        messages.append(message)
        for tool_call in tool_calls:
            fn = (tool_call.get("function") or {})
            fn_name = fn.get("name")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            if not isinstance(args, dict):
                args = {}

            cache_key = json.dumps(
                {"name": fn_name, "arguments": args},
                ensure_ascii=False,
                sort_keys=True,
                default=str,
            )
            cached = cache_key in tool_cache
            total_tool_calls += 1
            if total_tool_calls > max_tool_calls:
                tool_result = {
                    "error": "TOOL_CALL_LIMIT_REACHED",
                    "message": "No additional tools may run in this turn",
                }
            elif cached:
                tool_result = tool_cache[cache_key]
            elif fn_name == "Check_Doctor_Availability":
                # Resolve doctor_id with fallback to context/state/clinic
                doctor_id = args.get("doctor_id") or context.get("doctor_id")
                if not doctor_id:
                    st = context.get("state_data") or {}
                    bc = st.get("booking_context") or {}
                    doctor_id = bc.get("doctor_id") or (context.get("clinic_context") or {}).get("single_doctor_id")

                requested_date = args.get("requested_date")
                service_id = args.get("service_id") or context.get("service_id")
                if not service_id:
                    st = context.get("state_data") or {}
                    bc = st.get("booking_context") or {}
                    service_id = bc.get("service_id")

                if not doctor_id or not requested_date:
                    tool_result = {
                        "error": "MISSING_REQUIRED_PARAMS",
                        "message": "doctor_id and requested_date are required for availability check",
                    }
                else:
                    tool_input = {
                        "clinic_id": context.get("clinic_id"),
                        "conversation_id": context.get("conversation_id"),
                        "patient_id": context.get("patient_id"),
                        "doctor_id": doctor_id,
                        "requested_date": requested_date,
                        "service_id": service_id,
                    }
                    try:
                        tool_result = await check_available_slots(tool_input)
                    except Exception as exc:
                        tool_result = {"error": str(exc)}

            elif fn_name == "Search_Clinic_FAQ":
                q = args.get("query") or args.get("question") or ""
                try:
                    faq_res = await faq_service.search_clinic_faq(
                        faq_service.FaqSearchInput(clinic_id=context.get("clinic_id"), question=q)
                    )
                    tool_result = faq_res or {"results": [], "count": 0}
                except Exception as exc:
                    tool_result = {"error": str(exc), "results": []}

            elif fn_name == "Get_Clinic_Services_And_Doctors":
                c = context.get("clinic_context") or {}
                b = context.get("persona_context") or {}
                tool_result = {
                    "clinic_name": c.get("clinic_name"),
                    "doctors": c.get("doctor_directory") or [],
                    "services": (b.get("service_facts") or {}).get("catalog") or [],
                    "branches": c.get("branch_directory") or [],
                }

            elif fn_name == "Get_My_Appointments":
                try:
                    appts = await repository.get_patient_appointments(
                        context.get("clinic_id"),
                        context.get("patient_id"),
                        args.get("booking_number")
                    )
                    tool_result = {"appointments": appts, "count": len(appts)}
                except Exception as exc:
                    tool_result = {"error": str(exc), "appointments": []}
            else:
                tool_result = {"error": "UNKNOWN_TOOL"}

            if not cached and total_tool_calls <= max_tool_calls:
                tool_cache[cache_key] = tool_result
            tool_events.append({
                "name": fn_name,
                "arguments": args,
                "result": tool_result,
                "cache_hit": cached,
            })
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.get("id"),
                "content": json.dumps(tool_result, ensure_ascii=False),
            })
    return AgentTurnText(final_content or "", tool_events=tool_events, llm_calls=llm_calls)


async def _chat_messages(messages: list, *, with_tools: bool = True, force_json: bool = False) -> Any:
    """Continuation call with accumulated messages (same model options).
    
    When with_tools is True: tools are attached and response_format json_object is omitted
    to avoid conflicts on OpenAI/DeepSeek endpoints during function calling turns.
    When with_tools is False: response_format is set to json_object to guarantee structured JSON output.
    """
    body: Dict[str, Any] = {
        "model": settings.LLM_PRIMARY_MODEL,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 4000,
        **_reasoning_options(),
    }
    if with_tools:
        body["tools"] = RECEPTIONIST_TOOLS
        body["tool_choice"] = "auto"
    if force_json or not with_tools:
        body["response_format"] = {"type": "json_object"}

    headers = {"Authorization": f"Bearer {settings.LLM_PRIMARY_API_KEY}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=settings.LLM_TIMEOUT_SECONDS) as client:
        resp = await client.post(f"{settings.LLM_PRIMARY_BASE_URL.rstrip('/')}/chat/completions", headers=headers, json=body)
        if resp.status_code != 200:
            raise RuntimeError(f"primary LLM HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
    return data["choices"][0]["message"]


async def compose_patient_reply(reply_context: Dict[str, Any]) -> Dict[str, Any]:
    """Ask the model to write the final patient reply from authoritative facts only.

    The model receives no reply template and no response-code phrase table. It receives
    a compact fact catalog, analyzes it, writes a natural Arabic response, and cites the
    fact IDs it used. The structured evidence contract is validated without regex.
    """
    from app.core.response_context import validate_composer_output

    messages: list[Dict[str, Any]] = [
        {"role": "system", "content": load_response_composer_system_message()},
        {
            "role": "user",
            "content": json.dumps(reply_context, ensure_ascii=False, separators=(",", ":"), default=str),
        },
    ]
    max_attempts = max(1, int(getattr(settings, "LLM_COMPOSER_MAX_ATTEMPTS", 2)))
    validation_errors: list[str] = []

    for attempt in range(1, max_attempts + 1):
        body: Dict[str, Any] = {
            "model": settings.LLM_PRIMARY_MODEL,
            "messages": messages,
            "temperature": float(getattr(settings, "LLM_COMPOSER_TEMPERATURE", 0.35)),
            "max_tokens": int(getattr(settings, "LLM_COMPOSER_MAX_TOKENS", 2000)),
            "response_format": {"type": "json_object"},
            **_reasoning_options(),
        }
        headers = {
            "Authorization": f"Bearer {settings.LLM_PRIMARY_API_KEY}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=settings.LLM_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                f"{settings.LLM_PRIMARY_BASE_URL.rstrip('/')}/chat/completions",
                headers=headers,
                json=body,
            )
        if resp.status_code != 200:
            raise RuntimeError(f"response composer HTTP {resp.status_code}: {resp.text[:300]}")

        data = resp.json()
        raw = str((((data.get("choices") or [{}])[0].get("message") or {}).get("content")) or "")
        parsed, validation_errors = validate_composer_output(raw, reply_context)
        if parsed is not None:
            parsed["raw_output"] = raw
            parsed["attempts"] = attempt
            parsed["usage"] = data.get("usage") or {}
            parsed["input_chars"] = len(messages[1]["content"])
            return parsed

        messages.extend([
            {"role": "assistant", "content": raw},
            {
                "role": "user",
                "content": json.dumps({
                    "instruction": "صحح المخرج السابق فقط. لا تضف حقائق جديدة.",
                    "validation_errors": validation_errors,
                    "valid_fact_ids": reply_context.get("fact_ids") or [],
                }, ensure_ascii=False, separators=(",", ":")),
            },
        ])

    raise ValueError("response composer contract invalid: " + ",".join(validation_errors))


# ── DeepSeek Repair Chain (chainLlm + DeepSeek Repair Model) ────────────────────
async def call_repair_model(prompt: str) -> str:
    """Source node: DeepSeek Repair Chain (text = $json.prompt) + DeepSeek Repair Model options."""
    body = {
        "model": settings.LLM_REPAIR_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 800,
        **_reasoning_options(),
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
