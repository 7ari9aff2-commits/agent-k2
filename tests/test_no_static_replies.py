"""No-static-replies contract tests (owner directive: the patient never receives a
canned line — when nothing model-authored exists the turn suppresses and dispatches
a HIGH-priority handoff instead)."""
from __future__ import annotations

import asyncio

import app.api.v1.message as runner_mod
import app.db.repository as repo
from app.api.v1.message import _run
from tests.test_runner_flow import stub_io, valid_payload


def test_total_model_failure_suppresses_and_dispatches_handoff(monkeypatch):
    stub_io(monkeypatch)

    handoffs = []

    async def spy_handoff(payload):
        handoffs.append(payload)
        return {"success": True}

    async def failing_agent(um, context):
        raise RuntimeError("gateway down")

    async def failing_repair(prompt):
        raise RuntimeError("gateway down")

    async def failing_compose(context):
        raise RuntimeError("gateway down")

    monkeypatch.setattr(runner_mod.dialogue, "call_primary_model_with_tool", failing_agent)
    monkeypatch.setattr(runner_mod.dialogue, "call_repair_model", failing_repair)
    monkeypatch.setattr(runner_mod.dialogue, "compose_patient_reply", failing_compose)
    monkeypatch.setattr(runner_mod.handoff_service, "create_or_reuse_handoff", spy_handoff)

    r = asyncio.run(_run(valid_payload(message_text="أهلا"), {}))
    # No canned line: the reply suppresses and a human is dispatched.
    assert r.get("reply_text") is None
    assert r.get("suppress_reply") is True
    assert len(handoffs) == 1
    assert handoffs[0].reason_code == "MODEL_UNAVAILABLE"
    assert handoffs[0].priority == "high"


def test_claim_blocked_static_notice_never_reaches_the_patient(monkeypatch):
    """The deterministic claim-status notices are ledger metadata — a composer failure
    on a claim-blocked turn must not ship them as the patient's reply."""
    stub_io(monkeypatch)

    static_texts_seen = []
    handoffs = []

    async def failing_agent(um, context):
        raise RuntimeError("gateway down")

    async def failing_repair(prompt):
        raise RuntimeError("gateway down")

    async def failing_compose(context):
        raise RuntimeError("gateway down")

    monkeypatch.setattr(runner_mod.dialogue, "call_primary_model_with_tool", failing_agent)
    monkeypatch.setattr(runner_mod.dialogue, "call_repair_model", failing_repair)
    monkeypatch.setattr(runner_mod.dialogue, "compose_patient_reply", failing_compose)

    # claim-blocked: the ledger row answers with the deterministic IN_PROGRESS notice
    async def claimed(ctx):
        return {"operation_id": "op-1", "decision": "IN_PROGRESS",
                "child_execution_allowed": False,
                "response_json": None, "mutation_status": None}

    monkeypatch.setattr(repo, "claim_operation", claimed)

    async def spy_handoff(payload):
        handoffs.append(payload)
        return {"success": True}

    monkeypatch.setattr(runner_mod.handoff_service, "create_or_reuse_handoff", spy_handoff)

    r = asyncio.run(_run(valid_payload(message_text="أيوه أكد", source_event_id="evt-claim"), {}))
    for static in ("قيد التنفيذ", "لن أكرر", "تعذر التحقق", "لم يتم تنفيذ"):
        assert static not in (r.get("reply_text") or ""), \
            "deterministic status notices are ledger metadata, not patient replies"
    assert r.get("suppress_reply") is True and r.get("reply_text") is None
    assert handoffs, "a suppressed turn must dispatch a follow-up handoff"
