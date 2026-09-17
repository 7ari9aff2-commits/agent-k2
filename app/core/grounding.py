"""Grounding verifier — deterministic entity-subset check for LLM-authored replies.

Not an n8n port: this is a NEW layer (docs/agent_upgrade_design.md, P1.1) implementing
the "never says anything that isn't in the data" guarantee for free-text replies.
Deterministic template renders are skipped (fact-safe by construction).

Rule: every concrete entity in the reply — doctor names (after د./دكتور), clock times
(HH:MM or الساعة N), ISO dates — must appear in the turn's context whitelist built from
everything the pipeline already knows (patient text, conversation state, clinic context,
policy output, orchestrator decision, normalized/repaired agent contract, FAQ facts).
Arabic-Indic digits are folded before matching; hour-only mentions accept the 12h↔24h
equivalence (H, H+12, H-12). Pure functions, stdlib only.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set, Tuple

SAFE_FALLBACK_REPLY = "عذرًا، حصل لبس من عندي. ممكن توضحلي طلبك تاني وأنا هأكدلك التفاصيل؟"

_DIGIT_FOLD = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_CHAR_FOLD = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ئ": "ي", "ؤ": "و"})
_DIACRITICS_RE = re.compile(r"[ً-ْٰـ]")
_SPACE_RE = re.compile(r"\s+")

_TIME_RE = re.compile(r"(?<!\d)(\d{1,2}):(\d{2})(?::\d{2})?(?!\d)")
_HOUR_WORD_RE = re.compile(r"الساعة\s+(\d{1,2})(?!\d)")
_DATE_RE = re.compile(r"(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)")
_NAME_TOKEN = r"[^\s,.،!؟?؛:()\"0-9]{2,}"
_DOCTOR_RE = re.compile(r"(?:دكتور(?:ه|ة)?|د\.)\s*(" + _NAME_TOKEN + r"(?:\s+" + _NAME_TOKEN + r"){0,2})")

_MAX_DEPTH = 8
_MAX_STRINGS = 4000
_MAX_CHARS = 200_000


def _normalize(text: str) -> str:
    s = text.translate(_DIGIT_FOLD).translate(_CHAR_FOLD)
    s = _DIACRITICS_RE.sub("", s)
    return _SPACE_RE.sub(" ", s).strip()


def _collect_strings(obj: Any, out: List[str], depth: int = 0) -> None:
    if depth > _MAX_DEPTH or len(out) >= _MAX_STRINGS:
        return
    if isinstance(obj, str):
        if obj:
            out.append(obj)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(k, str):
                out.append(k) if len(out) < _MAX_STRINGS else None
            _collect_strings(v, out, depth + 1)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            _collect_strings(v, out, depth + 1)
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool):
        out.append(str(obj))


def build_context(sources: Dict[str, Any]) -> Dict[str, Any]:
    """Whitelist from arbitrary pipeline context dicts. Returns normalized blob + entity sets."""
    strings: List[str] = []
    for key in sorted(sources.keys()):
        _collect_strings(sources.get(key), strings)
    blob = _normalize(" \n ".join(strings))[:_MAX_CHARS]
    times: Set[Tuple[int, int]] = set()
    hours: Set[int] = set()
    dates: Set[str] = set()
    for h, m in _TIME_RE.findall(blob):
        hh, mm = int(h), int(m)
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            times.add((hh, mm))
            hours.add(hh)
    for h in _HOUR_WORD_RE.findall(blob):
        hh = int(h)
        if 0 <= hh <= 23:
            hours.add(hh)
    for d in _DATE_RE.findall(blob):
        dates.add(d)
    return {"blob": blob, "times": times, "hours": hours, "dates": dates}


def extract_reply_entities(reply: str) -> List[Dict[str, Any]]:
    """Concrete entities mentioned in the reply (normalized)."""
    text = _normalize(reply)
    found: List[Dict[str, Any]] = []
    for h, m in _TIME_RE.findall(text):
        hh, mm = int(h), int(m)
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            found.append({"kind": "time", "value": f"{hh}:{m}", "hour": hh, "minute": mm})
    seen_hours = set()
    for h in _HOUR_WORD_RE.findall(text):
        hh = int(h)
        if 0 <= hh <= 23 and hh not in seen_hours:
            seen_hours.add(hh)
            found.append({"kind": "hour", "value": str(hh), "hour": hh})
    for d in _DATE_RE.findall(text):
        found.append({"kind": "date", "value": d})
    for name in _DOCTOR_RE.findall(text):
        name_n = _normalize(name)
        if name_n:
            found.append({"kind": "doctor_name", "value": name_n})
    return found


def verify_reply(reply: str, context: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Entities in the reply that appear nowhere in the context whitelist."""
    violations: List[Dict[str, Any]] = []
    blob: str = context.get("blob") or ""
    times: Set[Tuple[int, int]] = context.get("times") or set()
    hours: Set[int] = context.get("hours") or set()
    dates: Set[str] = context.get("dates") or set()
    for ent in extract_reply_entities(reply):
        kind = ent["kind"]
        if kind == "time":
            if (ent["hour"], ent["minute"]) not in times:
                violations.append(ent)
        elif kind == "hour":
            h = ent["hour"]
            if not ({h, (h + 12) % 24, (h - 12) % 24} & hours):
                violations.append(ent)
        elif kind == "date":
            if ent["value"] not in dates:
                violations.append(ent)
        elif kind == "doctor_name":
            if ent["value"] not in blob:
                violations.append(ent)
    return violations


def ground_reply(
    reply_text: Optional[str],
    *,
    extracted: Optional[Dict[str, Any]],
    sources: Dict[str, Any],
    mode: str = "enforce",
    safe_reply: str = SAFE_FALLBACK_REPLY,
) -> Tuple[Optional[str], Dict[str, Any]]:
    """Apply the grounding rule to an outgoing reply.

    Returns (final_reply, report). Skips deterministic template renders
    (extracted.render_used is True) — they are fact-safe by construction.
    mode: "enforce" (replace violating replies), "audit" (report only), "off".
    """
    report: Dict[str, Any] = {"checked": False, "mode": mode, "violations": [], "replaced": False}
    if not reply_text or mode == "off":
        return reply_text, report
    if (extracted or {}).get("render_used") is True:
        report["skipped"] = "template_render"
        return reply_text, report
    context = build_context(sources)
    violations = verify_reply(reply_text, context)
    report["checked"] = True
    report["violations"] = violations
    if violations and mode == "enforce":
        report["replaced"] = True
        return safe_reply, report
    return reply_text, report
