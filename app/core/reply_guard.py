"""Reply Guard (Deterministic) — faithful 1:1 port.

Source node: Reply Guard (Deterministic) (extracted/code/Reply_Guard_Deterministic.js)

The node reads the Response Policy envelope and, for a closed set of
``response_code`` / ``decision_rule`` outcomes, replaces the model-facing reply
with a deterministic Arabic template (including the APPOINTMENT_CREATED success
template with branch/location/queue facts). When no override fires the item
passes through untouched (the very same dict object, like the JS returns
``[{ json: item }]`` with the same reference).

Public API: ``apply_reply_guard(inputs: dict) -> dict`` — returns the inner json
dict the JS emits as ``[{ json: out }][0].json`` (the n8n item wrapper is dropped
per docs/port_conventions.md).

Required ``inputs`` schema
--------------------------
The JS reads exactly one upstream node via ``$(NodeName).first().json``. The
pipeline runner passes that node output on the ``inputs`` dict; the key set below
is derived from what the JS actually consumes — nothing more.

- ``response_policy``  ← ``$('Response Policy (Deterministic)').first().json`` —
  required (JS ``item``). Fields read:
  - ``system_decision`` (object): ``decision_rule``, ``response_code``,
    ``action``, ``booking_number``, ``appointment_id``, ``booking_context``
    (``patient_name``/``patient_phone``/``date``/``time``/``booking_number``),
    ``confirmation_target`` (same patient/slot fields + ``booking_number``).
  - ``response_code`` (fallback when ``system_decision.response_code`` is empty).
  - ``facts``: ``branch_name``, ``branch_location`` (``address``,
    ``maps_url``, ``location_config`` (``maps_url``, ``latitude``, ``longitude``)),
    ``clinic_location.queue_base_url``.
  - ``booking_number``, ``appointment_id``, ``queue_number``, ``queue_path``,
    ``queue_url`` (item-level overrides, first non-empty wins via ``pick``).
  - ``output`` / ``text`` / ``agent_raw_output``: when a string containing a JSON
    object with a string ``reply`` field, that ``reply`` is rewritten to the
    override (JSON round-trip like the JS).

Output keys (exactly as the JS emits): the input item keys, plus
``agent_reply`` (the override text) and the ``_reply_guard`` sub-object
``{ triggered, rule, code, override, read_from }``. When no override fires the
item is returned unchanged and no keys are added.

Pure function: no I/O, no logging, stdlib only.
"""

import json
import re
from datetime import datetime, timezone
from typing import TypedDict


class ReplyGuardInputs(TypedDict, total=False):
    """Node outputs consumed by the JS via ``$(NodeName).first().json``."""

    response_policy: dict


# ── JS-semantics shims (same semantics as the ones in app/core/orchestrator.py) ──

def _dict(value):
    """Property-access coercion: non-object values read as empty objects (JS never throws here)."""
    return value if isinstance(value, dict) else {}


def _truthy(value):
    """JS truthiness: {} and [] are truthy; NaN is falsy; 0/''/None/False are falsy."""
    if isinstance(value, float) and value != value:  # NaN
        return False
    if isinstance(value, (dict, list)):
        return True
    return bool(value)


def _js_and(a, b):
    """JS ``a && b``: returns a when a is falsy, else b."""
    return a if not _truthy(a) else b


def _js_or(*values):
    """JS ``a || b || c`` chain: first JS-truthy value, else the last value (or None)."""
    if not values:
        return None
    for v in values[:-1]:
        if _truthy(v):
            return v
    return values[-1]


def _js_string(value):
    """JS String() coercion: arrays join with ','; plain objects → '[object Object]'."""
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, float):
        if value != value:  # NaN
            return 'NaN'
        if value in (float('inf'), float('-inf')):
            return 'Infinity' if value > 0 else '-Infinity'
        if value.is_integer() and abs(value) < 1e21:
            return str(int(value))
    if isinstance(value, list):
        return ','.join(_js_string(v) for v in value)
    if isinstance(value, dict):
        return '[object Object]'
    return str(value)


def _js_cat(*parts):
    """JS ``+`` string concatenation coercion (None renders as 'null', as in JS)."""
    out = []
    for p in parts:
        if p is None:
            out.append('null')
        elif isinstance(p, bool):
            out.append('true' if p else 'false')
        else:
            out.append(_js_string(p))
    return ''.join(out)


def _js_trim(s):
    """JS String.prototype.trim() — the JS WhiteSpace + LineTerminator set (differs from Python strip())."""
    return s.strip('\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')


def _pick(*vals):
    """JS ``pick(...)``: first value that is not undefined/null and whose String(v).trim() is non-empty; else null."""
    for v in vals:
        if v is not None and _js_trim(_js_string(v)) != '':
            return v
    return None


def _json_stringify(value):
    """JS ``JSON.stringify`` — compact separators, non-ASCII kept literal."""
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


_WEEKDAYS_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']
_ISO_DATE_RE = re.compile(r'\d{4}-\d{2}-\d{2}')


# ── Public entry point: the Code-node module body ──
def apply_reply_guard(inputs: dict) -> dict:
    """Source node: Reply Guard (Deterministic) (extracted/code/Reply_Guard_Deterministic.js).

    Mirrors the JS node body and returns the inner json dict (n8n's
    ``[{ json: out }][0].json``). See the module docstring for the ``inputs`` schema.
    """
    inputs = _dict(inputs)
    item = _dict(_js_or(inputs.get('response_policy'), {}))  # JS $("Response Policy (Deterministic)").first().json || {}

    decision = item.get('system_decision') if (_truthy(item.get('system_decision')) and isinstance(item.get('system_decision'), dict)) else {}
    rule = _js_or(decision.get('decision_rule'), None)
    code = _js_or(decision.get('response_code'), item.get('response_code'), None)
    bc = _dict(_js_or(decision.get('booking_context'), {}))
    ct = _dict(_js_or(decision.get('confirmation_target'), {}))
    name = _js_or(bc.get('patient_name'), ct.get('patient_name'), 'المريض')
    phone = _js_or(bc.get('patient_phone'), ct.get('patient_phone'), '')
    date = _js_or(bc.get('date'), ct.get('date'), '')
    time = _js_or(bc.get('time'), ct.get('time'), '')
    facts = _dict(_js_or(item.get('facts'), {}))
    branch_name = _js_or(facts.get('branch_name'), 'الفرع الرئيسي')
    branch_loc = _dict(_js_or(facts.get('branch_location'), {}))
    address = _js_or(branch_loc.get('address'), '')
    loc_cfg = _dict(_js_or(branch_loc.get('location_config'), {}))
    queue_base = _js_or(_js_and(facts.get('clinic_location'), _dict(facts.get('clinic_location')).get('queue_base_url')), '')
    maps_url = _pick(
        loc_cfg.get('maps_url'),
        branch_loc.get('maps_url'),
        _js_cat('https://www.google.com/maps/search/?api=1&query=', loc_cfg.get('latitude'), ',', loc_cfg.get('longitude')) if _truthy(loc_cfg.get('latitude')) else None,
    )
    booking_number = _pick(item.get('booking_number'), decision.get('booking_number'), bc.get('booking_number'), ct.get('booking_number'))
    appointment_id = _pick(item.get('appointment_id'), decision.get('appointment_id'))
    queue_number = _pick(item.get('queue_number'))
    queue_path = _pick(item.get('queue_path'))
    queue_base_str = _js_string(queue_base)
    queue_url = _pick(
        item.get('queue_url'),
        _js_cat(re.sub(r'/$', '', queue_base_str), queue_path) if (_truthy(queue_base) and _truthy(queue_path)) else None,
        _js_cat(re.sub(r'/$', '', queue_base_str), '/', queue_number) if (_truthy(queue_base) and _truthy(queue_number)) else None,
    )

    day_name = ''
    if _ISO_DATE_RE.fullmatch(_js_string(date)):
        try:
            parsed_day = datetime.strptime(_js_string(date) + 'T12:00:00Z', '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
            # JS d.getUTCDay(): Sunday=0..Saturday=6 → Python weekday(): Monday=0..Sunday=6.
            day_name = _WEEKDAYS_AR[(parsed_day.weekday() + 1) % 7]
        except ValueError:
            pass
    date_label = _js_cat(day_name + ' ' if day_name else '', date)

    override = None
    if code == 'CONVERSATION_ONLY' and rule == 'confirm_without_target':
        override = 'مفيش حجز معلق أأكده دلوقتي. تحب نبدأ حجز جديد؟'
    elif code == 'AVAILABILITY_SOURCE_ERROR':
        override = 'لحظة، مش قادرين نتأكد من المواعيد حاليًا. تحب نجرب يوم تاني؟'
    elif code == 'APPOINTMENT_CREATED' or (code == 'IDEMPOTENT_REPLAY' and decision.get('action') == 'create_appointment'):
        override = (
            _js_cat('تم الحجز بنجاح يا ', name, ' ✅\nالموعد: ', date_label)
            + (_js_cat(' الساعة ', time) if _truthy(time) else '')
            + _js_cat('\nباسم: ', name)
            + _js_cat('\nتلفون: ', phone)
            + _js_cat('\nرقم الحجز: ', _js_or(booking_number, appointment_id, '-'))
            + _js_cat('\nالفرع: ', branch_name)
            + _js_cat('\nالعنوان: ', address)
            + (_js_cat('\nلوكيشن العيادة: ', maps_url) if _truthy(maps_url) else '')
            + (_js_cat('\nلينك الكيو: ', queue_url) if _truthy(queue_url) else '')
        )
    elif code == 'CANCEL_COMPLETED':
        override = (
            _js_cat('تم إلغاء حجزك بنجاح يا ', name)
            + (_js_cat('\nرقم الحجز: ', booking_number) if _truthy(booking_number) else '')
            + '\nنشوفك في زيارة قريبة، ونتمنى لك دوام الصحة والعافية'
        )
    elif code == 'RESCHEDULE_COMPLETED':
        override = (
            _js_cat('تم تعديل حجزك يا ', name, ' ✅\nالموعد الجديد: ', date_label)
            + (_js_cat(' الساعة ', time) if _truthy(time) else '')
            + (_js_cat('\nرقم الحجز: ', booking_number) if _truthy(booking_number) else '')
        )
    elif code == 'IDEMPOTENT_REPLAY':
        override = 'حجزك متسجل بالفعل ومتفعّل ✅' + (_js_cat('\nرقم الحجز: ', booking_number) if _truthy(booking_number) else '')
    elif code == 'CONFIRMATION_EXPIRED':
        override = 'الموعد المعلق انتهت صلاحية حجزه المؤقت. تحب نتحقق من المواعيد المتاحة ونحجز من جديد؟'

    if not override:
        return item

    def _rewrite(s):
        try:
            o = json.loads(s)
            if o and isinstance(o, dict) and isinstance(o.get('reply'), str):
                o['reply'] = override
                return _json_stringify(o)
        except Exception:
            pass
        return s

    out = dict(item)
    for k in ('output', 'text', 'agent_raw_output'):
        if isinstance(out.get(k), str):
            out[k] = _rewrite(out[k])
    out['agent_reply'] = override
    out['_reply_guard'] = {'triggered': True, 'rule': rule, 'code': code, 'override': override, 'read_from': 'Response Policy (Deterministic)'}
    return out
