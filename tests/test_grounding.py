"""Unit tests for the grounding verifier (app.core.grounding).

Verifies:
1. Template renders are skipped (fact-safe by construction).
2. Doctor names, times, and dates outside context are caught and replaced in enforce mode.
3. Doctor names, times, and dates in context pass without violation.
4. Arabic numerals are folded before extraction.
5. Mode 'audit' reports violations without replacing.
6. Mode 'off' bypasses checks entirely.
"""
import pytest
from app.core import grounding


def test_grounding_skips_template_renders():
    reply = "تم الحجز مع د. مجهول الساعة 09:00 في 2026-12-31"
    res, rep = grounding.ground_reply(reply, extracted={"render_used": True}, sources={})
    assert res == reply
    assert rep["skipped"] == "template_render"


def test_grounding_detects_unverified_doctor():
    reply = "أهلاً بك، يمكنك الحجز مع د. سامح غداً."
    sources = {"clinic": {"clinic_name": "عيادة الرازي", "doctor_directory": [{"doctor_name": "أحمد"}]}}
    res, rep = grounding.ground_reply(reply, extracted={"render_used": False}, sources=sources, mode="enforce")
    assert rep["replaced"] is True
    assert res == grounding.SAFE_FALLBACK_REPLY
    assert any(v["kind"] == "doctor_name" and "سامح" in v["value"] for v in rep["violations"])


def test_grounding_allows_verified_doctor():
    reply = "أهلاً بك، يسعدنا حجز موعد لك مع د. أحمد."
    sources = {"clinic": {"clinic_name": "عيادة الرازي", "doctor_directory": [{"doctor_name": "أحمد"}]}}
    res, rep = grounding.ground_reply(reply, extracted={"render_used": False}, sources=sources, mode="enforce")
    assert rep["replaced"] is False
    assert res == reply
    assert rep["violations"] == []


def test_grounding_detects_unverified_time():
    reply = "الموعد متاح الساعة 17:30 اليوم."
    sources = {"normalized": {"message_text": "عايز موعد اليوم"}, "state": {}}
    res, rep = grounding.ground_reply(reply, extracted={"render_used": False}, sources=sources, mode="enforce")
    assert rep["replaced"] is True
    assert res == grounding.SAFE_FALLBACK_REPLY


def test_grounding_allows_verified_time_and_arabic_digits():
    # Context mentions 17:30
    sources = {"state": {"pending_offer": {"alternatives": [{"time": "17:30", "date": "2026-09-20"}]}}}
    # Reply mentions 17:30 with arabic digits ١٧:٣٠
    reply = "الموعد متاح الساعة ١٧:٣٠ يوم 2026-09-20."
    res, rep = grounding.ground_reply(reply, extracted={"render_used": False}, sources=sources, mode="enforce")
    assert rep["replaced"] is False
    assert res == reply
    assert rep["violations"] == []


def test_grounding_audit_mode_reports_without_replacing():
    reply = "الموعد متاح مع د. مجهول الساعة 22:00."
    res, rep = grounding.ground_reply(reply, extracted={"render_used": False}, sources={}, mode="audit")
    assert rep["replaced"] is False
    assert res == reply
    assert len(rep["violations"]) > 0


def test_grounding_off_mode_bypasses():
    reply = "الموعد متاح مع د. مجهول الساعة 22:00."
    res, rep = grounding.ground_reply(reply, extracted={"render_used": False}, sources={}, mode="off")
    assert res == reply
    assert rep["checked"] is False
