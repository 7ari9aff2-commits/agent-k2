"""Parity check: System_Orchestrator_Policy.js vs app/core/orchestrator.py

Verifies that every SCREAMING_CASE token (states, response codes, decision rules,
field groups) present in the source JS also appears in the Python port, and that
the port's public decide() returns the default CONVERSATION_ONLY envelope for an
unclear turn.
"""
import io
import re
import sys


def main() -> int:
    js = io.open("n8n_reference/extracted/code/System_Orchestrator_Policy.js", encoding="utf-8").read()
    try:
        py = io.open("app/core/orchestrator.py", encoding="utf-8").read()
    except FileNotFoundError:
        print("FAIL: app/core/orchestrator.py not found")
        return 1

    tokens = sorted(set(re.findall(r"['\"]([A-Z][A-Z_]{3,})['\"]", js)))
    # Filter obvious non-semantic tokens
    ignore = {"JSON", "UTC", "GET", "POST", "TRUE", "FALSE", "NULL", "ISO", "YYYY", "MM", "DD"}
    tokens = [t for t in tokens if t not in ignore]
    missing = [t for t in tokens if t not in py]
    print(f"JS semantic tokens: {len(tokens)} | missing in python: {len(missing)}")
    for t in missing:
        print("  MISSING:", t)

    from app.core import orchestrator

    contract = {
        "schema_version": "k2.dialogue.v3",
        "reply": "",
        "turn": {"intent": "unclear", "relation_to_previous_turn": "none"},
        "confidence": 0.0,
        "ambiguous": [],
        "confirmation": {"intent": "none"},
        "selection": {"kind": "none", "rank": None},
        "entities": {},
        "operation_proposal": {"type": "none", "requested": False},
        "escalate": None,
    }
    decision = orchestrator.decide(contract, {}, {})
    code = decision.get("response_code") or (decision.get("system_decision") or {}).get("response_code")
    print("smoke decide() response_code:", code)
    ok = not missing and code == "CONVERSATION_ONLY"
    print("PARITY:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
