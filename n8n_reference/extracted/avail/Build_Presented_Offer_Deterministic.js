// P-OFFER (2026-09-05): persist the verified offer into conversation_state so the
// acceptance flow can bind the patient's choice on the next turn. The agent-tool
// path has no deterministic envelope on the main line, so without this write the
// offered slots were lost and acceptance turns degraded to 'unclear'.
const resp = $json || {};
const trigger = (() => { try { return $('Get Available Slots Input').first().json || {}; } catch (_) { return {}; } })();
const buildLocal = (iso, tz) => {
  const s = String(iso || '');
  let date = s.slice(0, 10), time = s.slice(11, 16);
  if (tz && s) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(s));
      const v = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
      date = v.year + '-' + v.month + '-' + v.day;
      time = v.hour + ':' + v.minute;
    } catch (_) { /* keep UTC slice */ }
  }
  return { date, time };
};
const tz = String(resp.timezone || '').trim() || null;
const exact = resp.exact_slot && typeof resp.exact_slot === 'object' ? resp.exact_slot : null;
const todaySlots = Array.isArray(resp.available_slots_today) ? resp.available_slots_today : [];
const nearSlots = Array.isArray(resp.nearest_slots) ? resp.nearest_slots : [];
const raw = [];
if (exact && exact.slot_id) raw.push(exact);
for (const s of todaySlots.concat(nearSlots)) {
  if (raw.length >= 4) break;
  if (s && s.slot_id && !raw.some((x) => x.slot_id === s.slot_id)) raw.push(s);
}
let offer = null;
if (resp.verification_status === 'verified_available' && raw.length) {
  const nowMs = Date.now();
  offer = {
    schema_version: 2,
    kind: 'presented_offer',
    offered_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + 600000).toISOString(),
    clinic_id: resp.clinic_id || null,
    patient_id: trigger.patient_id || null,
    conversation_id: trigger.conversation_id || null,
    doctor_id: resp.doctor_id || null,
    doctor_name: null,
    service_id: resp.service_id || null,
    appointment_type: null,
    alternatives: raw.slice(0, 4).map((s, i) => {
      const local = buildLocal(s.start_time, tz);
      return {
        rank: i + 1,
        slot_id: s.slot_id || null,
        start_time: s.start_time || null,
        local_date: local.date,
        local_time: local.time,
        label: null,
        doctor_id: s.doctor_id || resp.doctor_id || null,
        service_id: s.service_id || resp.service_id || null,
        clinic_id: s.clinic_id || resp.clinic_id || null,
        slot_status: 'available'
      };
    })
  };
}
return [{ json: { ...resp, presented_offer_write: offer } }];