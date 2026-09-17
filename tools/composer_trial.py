#!/usr/bin/env python3
"""Live trial harness for the model-authored response composer.

Runs the real composer against the real LLM for every reception scenario that matters,
so the dynamic reply path can be validated end to end without touching the database or
the WhatsApp channel.

Each scenario builds a fact catalog with ``response_context.build_reply_context`` (the
same function the pipeline uses), sends it through ``dialogue.compose_patient_reply``,
and validates the returned evidence contract. Nothing is written to the database.

Usage:
    python tools/composer_trial.py                       # live, uses .env credentials
    python tools/composer_trial.py --offline             # no network: proves the validator
    python tools/composer_trial.py --only availability_found
    python tools/composer_trial.py --api-key sk-... --base-url https://... --model ...

Exit code: 0 when every scenario produced a valid, non-fabricated reply.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.response_context import build_reply_context, validate_composer_output  # noqa: E402

CLINIC = {
    "clinic_name": "عيادة النور",
    "clinic_timezone": "Asia/Riyadh",
    "persona": {"name": "نور", "role": "مساعدة استقبال وحجوزات", "tone": "warm_professional", "dialect": "saudi"},
    "doctor_directory": [
        {"doctor_name": "د. أحمد سالم", "specialty": "باطنة"},
        {"doctor_name": "د. سارة يوسف", "specialty": "أطفال"},
    ],
    "branch_directory": [{"branch_name": "الفرع الرئيسي", "address": "شارع الملك فهد، الرياض"}],
}

SLOTS_FOUND = {
    "success": True,
    "verification_status": "verified_available",
    "requested_date": "2026-09-20",
    "doctor_works_that_day": True,
    "timezone": "Asia/Riyadh",
    "exact_slot": {"rank": 1, "local_date": "2026-09-20", "local_time": "10:00", "slot_status": "available"},
    "nearest_slots": [
        {"rank": 2, "local_date": "2026-09-20", "local_time": "11:30", "slot_status": "available"},
        {"rank": 3, "local_date": "2026-09-20", "local_time": "17:00", "slot_status": "available"},
    ],
}

SLOTS_NONE = {
    "success": True,
    "verification_status": "verified_unavailable",
    "requested_date": "2026-09-21",
    "doctor_works_that_day": False,
    "timezone": "Asia/Riyadh",
    "exact_slot": None,
    "nearest_slots": [],
}

BOOKING_DONE = {
    "success": True,
    "child_contract_valid": True,
    "appointment_id": "apt-1",
    "booking_number": "C4821",
    "patient_name": "محمد علي",
    "patient_phone": "0551234567",
    "doctor_name": "د. أحمد سالم",
    "date": "2026-09-20",
    "time": "10:00",
    "operation_status": "COMPLETED",
}


def _scenario(
    name: str,
    description: str,
    *,
    message: str,
    policy_code: str,
    decision: Optional[Dict[str, Any]] = None,
    tool: Optional[Dict[str, Any]] = None,
    execution: Optional[Dict[str, Any]] = None,
    draft: str = "",
    state: Optional[Dict[str, Any]] = None,
    faq: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "name": name, "description": description, "message": message,
        "policy_code": policy_code, "decision": decision or {}, "tool": tool,
        "execution": execution or {}, "draft": draft, "state": state or {}, "faq": faq or {},
    }


SCENARIOS: List[Dict[str, Any]] = [
    _scenario("greeting", "ترحيب بسيط — ممنوع اختراع أي حقيقة",
              message="السلام عليكم", policy_code="CONVERSATION_ONLY",
              draft="أهلاً بيك! كيف أقدر أساعدك؟"),
    _scenario("availability_found", "مواعيد متاحة حقيقية — لازم تظهر 10:00 و 11:30 و 17:00",
              message="عايز أعرف المواعيد المتاحة يوم 20 سبتمبر",
              policy_code="AVAILABILITY_RESULTS",
              decision={"availability_outcome": "slots_found"},
              tool={"name": "Check_Doctor_Availability", "arguments": {"requested_date": "2026-09-20"},
                    "result": SLOTS_FOUND},
              draft="لقيتلك 3 مواعيد يوم 20 سبتمبر"),
    _scenario("availability_none", "لا توجد مواعيد — ممنوع ادعاء وجود أي موعد",
              message="في مواعيد يوم 21 سبتمبر؟", policy_code="NO_AVAILABLE_SLOTS",
              decision={"availability_outcome": "no_slots"},
              tool={"name": "Check_Doctor_Availability", "arguments": {"requested_date": "2026-09-21"},
                    "result": SLOTS_NONE},
              draft="مفيش مواعيد يوم 21"),
    _scenario("booking_confirmed", "حجز تم فعلاً — لازم تأكيد مع رقم الحجز",
              message="تمام احجزلي", policy_code="APPOINTMENT_CREATED",
              execution={"create": BOOKING_DONE, "completion": {"operation_status": "COMPLETED"}},
              draft="تم الحجز"),
    _scenario("cancel_confirmed", "إلغاء تم فعلاً",
              message="عايز ألغي حجزي", policy_code="CANCEL_COMPLETED",
              execution={"cancel": {**BOOKING_DONE, "operation_status": "COMPLETED"}},
              draft="تم الإلغاء"),
    _scenario("faq_answer", "سؤال عن العنوان — الإجابة من قاعدة المعرفة فقط",
              message="العيادة فين؟", policy_code="CONVERSATION_ONLY",
              tool={"name": "Search_Clinic_FAQ", "arguments": {"query": "العنوان"},
                    "result": {"count": 1, "results": [
                        {"title": "العنوان", "content": "شارع الملك فهد، الرياض، الدور الثالث"}]}},
              draft="العيادة في شارع الملك فهد"),
    _scenario("missing_data", "بيانات ناقصة — لازم تسأل سؤال واحد طبيعي",
              message="عايز أحجز", policy_code="MISSING_REQUIRED_FIELDS",
              decision={"missing_human_fields": ["date", "time", "patient_name"]},
              state={"missing_human_fields": ["date", "time", "patient_name"],
                     "conversation_stage": "COLLECTING"},
              draft="محتاج منك: اليوم و الوقت و الاسم"),
    _scenario("tool_error", "فشل مصدر المواعيد — ممنوع تأكيد أي موعد",
              message="في مواعيد بكره؟", policy_code="AVAILABILITY_SOURCE_ERROR",
              tool={"name": "Check_Doctor_Availability", "arguments": {"requested_date": "2026-09-22"},
                    "result": {"error": "RPC_ERROR", "error_code": "RPC_ERROR"}},
              draft="مش قادرين نتأكد من المواعيد حاليًا"),
]

OFFLINE_REPLIES = {
    "greeting": "أهلاً وسهلاً 🌸 أنا نور من عيادة النور، تحت أمرك في أي وقت. تحب تحجز موعد ولا تسأل عن حاجة؟",
    "availability_found": "لقيتلك مع د. أحمد سالم يوم 20 سبتمبر 3 مواعيد: 10:00 ص، 11:30 ص، و05:00 م. تحب أحجزلك أنهي واحد؟",
    "availability_none": "للأسف مفيش مواعيد متاحة يوم 21 سبتمبر. تحب أشوفلك أقرب يوم تاني؟",
    "booking_confirmed": "تم حجزك بنجاح يا محمد ✅ رقم الحجز C4821، مع د. أحمد سالم يوم 20 سبتمبر الساعة 10:00.",
    "cancel_confirmed": "تم إلغاء حجزك يا محمد. رقم الحجز C4821 اتلغى، ونشوفك في زيارة قريبة 🌸",
    "faq_answer": "عيادة النور في شارع الملك فهد، الرياض، الدور الثالث.",
    "missing_data": "تحت أمرك! بس محتاج أعرف اليوم والوقت المناسبين ليك، وكمان اسمك الكامل.",
    "tool_error": "لحظة واحدة، مش قادرين نتأكد من المواعيد دلوقتي. تحب نجرب يوم تاني؟",
}


def build_context_for(scenario: Dict[str, Any]) -> Dict[str, Any]:
    tool_events = []
    if scenario["tool"]:
        tool_events = [{**scenario["tool"], "cache_hit": False}]
    return build_reply_context(
        normalized={"message_text": scenario["message"]},
        clinic_context=CLINIC,
        state_data=scenario["state"],
        policy={"response_code": scenario["policy_code"]},
        decision=scenario["decision"],
        normalized_agent_output={"agent_reply": scenario["draft"]},
        repaired_result={},
        tool_events=tool_events,
        execution_results=scenario["execution"],
        faq_result=scenario["faq"],
        guard={},
    )


def offline_compose(context: Dict[str, Any], scenario: Dict[str, Any]) -> Dict[str, Any]:
    reply = OFFLINE_REPLIES.get(scenario["name"], "")
    cited = [f["id"] for f in context["facts"] if f["authority"] in ("database", "deterministic")][:2]
    return {
        "reply": reply,
        "evidence_ids": cited or [context["fact_ids"][0]],
        "missing_information": [],
        "unsupported_claims": [],
        "grounding_status": "supported",
        "raw_output": "{}",
        "attempts": 1,
    }


def _slot_present(reply: str, hhmm: str) -> bool:
    """Match a slot in either 24h or 12h form, since Arabic replies use 12h ('05:00 م')."""
    hour, minute = hhmm.split(":")
    h = int(hour)
    h12 = h % 12 or 12
    return any(token in reply for token in (f"{h:02d}:{minute}", f"{h12:02d}:{minute}", f"{h12}:{minute}"))


def check_scenario(scenario: Dict[str, Any], context: Dict[str, Any],
                   result: Dict[str, Any]) -> List[str]:
    """Scenario-specific expectations, checked on structure and fact presence only."""
    problems: List[str] = []
    reply = result.get("reply") or ""
    catalog = json.dumps(context, ensure_ascii=False)
    tracked_slots = ("10:00", "11:30", "17:00")

    if scenario["name"] == "availability_found":
        for slot in tracked_slots:
            if not _slot_present(reply, slot):
                problems.append(f"reply omits the verified slot {slot}")
        if "10:00" not in catalog:
            problems.append("slot 10:00 missing from the catalog itself")
    if scenario["name"] == "availability_none":
        for slot in tracked_slots:
            if _slot_present(reply, slot):
                problems.append(f"reply invents slot {slot} that is not in the facts")
    if scenario["name"] == "tool_error":
        for slot in tracked_slots:
            if _slot_present(reply, slot):
                problems.append(f"reply asserts slot {slot} although the tool failed")
    if scenario["name"] == "booking_confirmed":
        if "C4821" not in reply:
            problems.append("confirmed booking reply omits the booking number from the facts")
    if scenario["name"] == "cancel_confirmed":
        if "C4821" not in reply:
            problems.append("cancellation reply omits the booking number from the facts")
    if scenario["name"] == "faq_answer":
        if "الملك فهد" not in reply:
            problems.append("FAQ reply does not carry the knowledge-base address")
    if scenario["name"] == "greeting":
        leaked = [tok for tok in ("C4821", "د. أحمد") if tok in reply]
        leaked += [slot for slot in tracked_slots if _slot_present(reply, slot)]
        if leaked:
            problems.append(f"greeting leaked clinic facts not requested: {leaked}")

    for internal in ("apt-1",):
        if internal in reply:
            problems.append(f"reply exposes an internal identifier: {internal}")
    return problems


async def run_live(scenarios: List[Dict[str, Any]]) -> int:
    from app.services import dialogue

    passed = failed = 0
    for scenario in scenarios:
        context = build_context_for(scenario)
        print("=" * 78)
        print(f"[{scenario['name']}] {scenario['description']}")
        print(f"  patient : {scenario['message']}")
        print(f"  facts   : {', '.join(context['fact_ids'])}")
        try:
            result = await dialogue.compose_patient_reply(context)
        except Exception as exc:
            print(f"  ERROR   : {type(exc).__name__}: {exc}")
            failed += 1
            continue
        problems = check_scenario(scenario, context, result)
        print(f"  reply   : {result['reply']}")
        print(f"  cited   : {result.get('evidence_ids')}")
        if result.get("missing_information"):
            print(f"  missing : {result['missing_information']}")
        print(f"  result  : {'PASS' if not problems else 'FAIL'}")
        for problem in problems:
            print(f"    - {problem}")
        passed += not problems
        failed += bool(problems)
    return passed, failed


def run_offline(scenarios: List[Dict[str, Any]]) -> int:
    passed = failed = 0
    for scenario in scenarios:
        context = build_context_for(scenario)
        result = offline_compose(context, scenario)
        parsed, errors = validate_composer_output(result, context)
        problems = list(errors) + check_scenario(scenario, context, parsed or result)
        print("=" * 78)
        print(f"[{scenario['name']}] {scenario['description']}")
        print(f"  reply   : {result['reply']}")
        print(f"  cited   : {result.get('evidence_ids')}")
        print(f"  result  : {'PASS' if not problems else 'FAIL'}")
        for problem in problems:
            print(f"    - {problem}")
        passed += not problems
        failed += bool(problems)
    return passed, failed


def main() -> int:
    ap = argparse.ArgumentParser(description="Trial the model-authored response composer.")
    ap.add_argument("--offline", action="store_true",
                    help="use canned replies (no network) to exercise the validator and expectations")
    ap.add_argument("--only", help="run a single scenario by name")
    ap.add_argument("--api-key", help="override LLM_PRIMARY_API_KEY")
    ap.add_argument("--base-url", help="override LLM_PRIMARY_BASE_URL")
    ap.add_argument("--model", help="override LLM_PRIMARY_MODEL")
    ap.add_argument("--list", action="store_true", help="list scenarios and exit")
    args = ap.parse_args()

    if args.list:
        for scenario in SCENARIOS:
            print(f"{scenario['name']:20} {scenario['description']}")
        return 0

    scenarios = [s for s in SCENARIOS if not args.only or s["name"] == args.only]
    if not scenarios:
        print(f"no scenario named {args.only!r}", file=sys.stderr)
        return 2

    if args.api_key or args.base_url or args.model:
        from app.core.config import settings
        if args.api_key:
            settings.LLM_PRIMARY_API_KEY = args.api_key
            settings.LLM_REPAIR_API_KEY = args.api_key
        if args.base_url:
            settings.LLM_PRIMARY_BASE_URL = args.base_url
            settings.LLM_REPAIR_BASE_URL = args.base_url
        if args.model:
            settings.LLM_PRIMARY_MODEL = args.model
            settings.LLM_REPAIR_MODEL = args.model

    if args.offline:
        passed, failed = run_offline(scenarios)
    else:
        from app.core.config import settings
        print(f"composer target: {settings.LLM_PRIMARY_BASE_URL} | {settings.LLM_PRIMARY_MODEL}")
        passed, failed = asyncio.run(run_live(scenarios))

    print("=" * 78)
    print(f"passed: {passed}   failed: {failed}")
    if not args.offline and failed:
        print("If every scenario errored with HTTP 401, the LLM credential is invalid —")
        print("pass --api-key/--base-url/--model for a working OpenAI-compatible gateway.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
