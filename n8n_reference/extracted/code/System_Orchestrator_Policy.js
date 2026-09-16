// Decision Core v3 — drop-in replacement for System Orchestrator (Policy).
// ONE state-table engine (decide()) produces every scheduling transition.
// No message_text reads. No regex semantics. Contract-only decisions.
// Emits the legacy-compatible envelope the downstream consumers expect
// (system_decision + top-level booking_context/slot_state/target/state_patches).

const safeNode = (name) => { try { const f = $(name).first(); return (f && f.json) || {}; } catch (_) { return {}; } };

const SCHEMA_VERSION = 'k2.dialogue.v3';

const TURN_INTENTS = ['booking_request', 'booking_continuation', 'availability_inquiry',
  'cancellation_request', 'reschedule_request', 'confirmation', 'correction',
  'small_talk', 'clinic_query', 'greeting', 'unclear', 'other'];
const RELATIONS = ['new_request', 'answer', 'confirmation', 'correction',
  'change_details', 'follow_up', 'none', 'unclear'];
const CERTAINTIES = ['certain', 'probable', 'uncertain'];
const CONFIRMATION_INTENTS = ['affirmative', 'negative', 'question', 'conditional', 'none'];
const SELECTION_KINDS = ['presented_rank', 'presented_match', 'any', 'none'];
const OPERATION_TYPES = ['create_appointment', 'cancel_appointment', 'reschedule_appointment', 'check_availability', ''];
const VISIT_TYPES = ['NEW_VISIT', 'FOLLOW_UP'];

// ── E.164 phone normalization (retained from P1.7 as a validator) ──
const PHONE_RULES = {
  SA: { code: '+966', lengths: [9], prefixes: ['5'] },
  AE: { code: '+971', lengths: [9], prefixes: ['5'] },
  KW: { code: '+965', lengths: [8], prefixes: ['5', '6', '9'] },
  QA: { code: '+974', lengths: [8], prefixes: ['3', '5', '6', '7'] },
  BH: { code: '+973', lengths: [8], prefixes: ['3'] },
  OM: { code: '+968', lengths: [8], prefixes: ['7', '9'] },
  EG: { code: '+20', lengths: [10], prefixes: ['1', '2'] },
  PH: { code: '+63', lengths: [10], prefixes: ['9'] },
  IN: { code: '+91', lengths: [10], prefixes: ['6', '7', '8', '9'] },
  PK: { code: '+92', lengths: [10], prefixes: ['3'] },
  BD: { code: '+880', lengths: [10], prefixes: ['1'] },
  ID: { code: '+62', lengths: [9, 10, 11, 12], prefixes: ['8'] },
  YE: { code: '+967', lengths: [9], prefixes: ['7'] },
  JO: { code: '+962', lengths: [9], prefixes: ['7'] },
  SD: { code: '+249', lengths: [9], prefixes: ['9'] },
  SY: { code: '+963', lengths: [9], prefixes: ['9'] },
  IQ: { code: '+964', lengths: [10], prefixes: ['7'] },
  LB: { code: '+961', lengths: [7, 8], prefixes: ['3', '7'] },
  TR: { code: '+90', lengths: [10], prefixes: ['5'] },
  US: { code: '+1', lengths: [10], prefixes: ['2', '3', '4', '5', '6', '7', '8', '9'] },
  GB: { code: '+44', lengths: [10], prefixes: ['7'] }
};
const ARABIC_INDIC = { '\u0660': '0', '\u0661': '1', '\u0662': '2', '\u0663': '3', '\u0664': '4', '\u0665': '5', '\u0666': '6', '\u0667': '7', '\u0668': '8', '\u0669': '9' };
function toEnglishDigits(s) { return String(s).replace(/[\u0660-\u0669]/g, (ch) => ARABIC_INDIC[ch]); }
function normalizePhone(rawInput, defaultCountry) {
  if (defaultCountry == null) defaultCountry = 'SA';
  if (rawInput == null || rawInput === '') return null;
  let s = toEnglishDigits(String(rawInput)).replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.charAt(0) === '+') {
    for (const cc in PHONE_RULES) {
      if (s.indexOf(PHONE_RULES[cc].code) === 0) return s;
    }
    return s;
  }
  for (const cc in PHONE_RULES) {
    const rule = PHONE_RULES[cc];
    if (rule.lengths.indexOf(s.length) !== -1 && rule.prefixes.some((p) => s.indexOf(p) === 0)) return rule.code + s;
  }
  if (s.charAt(0) === '0') s = s.slice(1);
  const def = PHONE_RULES[defaultCountry];
  if (def) return def.code + s;
  return '+' + s;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_24 = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isoDateValid(dateIso) {
  if (!ISO_DATE.test(String(dateIso || ''))) return false;
  const d = new Date(dateIso + 'T12:00:00Z');
  return Number.isFinite(d.getTime());
}
function dateWithinHorizon(dateIso, nowLocalDate, horizonDays) {
  if (!isoDateValid(dateIso) || !isoDateValid(nowLocalDate)) return false;
  const a = new Date(nowLocalDate + 'T12:00:00Z').getTime();
  const b = new Date(dateIso + 'T12:00:00Z').getTime();
  const days = Math.round((b - a) / 86400000);
  return days >= 0 && days <= (horizonDays || 60);
}
function normalizeTime(value) {
  const t = String(value || '').trim();
  if (!TIME_24.test(t)) return null;
  return t.length === 8 ? t.slice(0, 5) : (t.length === 4 ? t + ':00' : t);
}
function cleanStr(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s || null;
}

// Validate + deterministically repair a model contract.
// ctx: { now_local_date, clinic_country_code, date_horizon_days }
// Returns { valid, errors[], warnings[], contract } where errors are structural
// (trigger the one-shot model self-repair retry) and warnings are field repairs.

// Message classification comes exclusively from contract fields — never text.
function messageClass(contract, state) {
  const c = contract || {};
  const turn = c.turn || {};
  const intent = String(turn.intent || 'unclear');
  const confIntent = String((c.confirmation || {}).intent || 'none');
  const selKind = String((c.selection || {}).kind || 'none');
  const opType = String((c.operation_proposal || {}).type || '');
  if (opType === 'cancel_appointment' || intent === 'cancellation_request') return 'cancel_request';
  if (opType === 'reschedule_appointment' || intent === 'reschedule_request') return 'reschedule_request';
  if (selKind !== 'none') return 'selection_presented';
  if (confIntent === 'affirmative') return 'confirmation_affirm';
  if (confIntent === 'negative') return 'confirmation_negative';
  if (confIntent === 'question' || confIntent === 'conditional') return 'confirmation_question';
  if (intent === 'confirmation') return 'confirmation_affirm';
  if (intent === 'booking_request' || intent === 'booking_continuation' || opType === 'create_appointment') return 'booking';
  if (intent === 'availability_inquiry' || opType === 'check_availability') return 'availability_inquiry';
  if (intent === 'correction') return 'correction';
  if (intent === 'small_talk' || intent === 'greeting') return 'small_talk';
  if (intent === 'clinic_query') return 'clinic_query';
  return 'unclear';
}

const K2C = { UUID_RE, isoDateValid, normalizeTime, messageClass };
const STATES = {
  IDLE: 'IDLE', ASK_DOCTOR: 'ASK_DOCTOR', ASK_VISIT_TYPE: 'ASK_VISIT_TYPE',
  COLLECT_PATIENT_DATA: 'COLLECT_PATIENT_DATA', CONFIRM_PATIENT_DATA: 'CONFIRM_PATIENT_DATA',
  ASK_DATE: 'ASK_DATE', AWAIT_SLOT_CHOICE: 'AWAIT_SLOT_CHOICE',
  AWAIT_CONFIRMATION: 'AWAIT_CONFIRMATION', EXECUTING: 'EXECUTING', COMPLETED: 'COMPLETED'
};
const OFFER_TTL_SECONDS = 600;
const CONFIRM_TTL_SECONDS = 600;

function uuidValid(v) { return K2C.UUID_RE.test(String(v || '')); }
function nowMs(clinic) {
  const t = Date.parse(String((clinic && clinic.now_iso) || ''));
  return Number.isFinite(t) ? t : Date.now();
}
// Deterministic UUID mint (pure): FNV hash of a seed, formatted 8-4-4-4-12
// with version 4 / variant bits so it passes strict UUID validation.
function mintUuid(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed == null ? '' : seed);
  for (let i = 0; i < s.length; i += 1) { h ^= s.codePointAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const hex = (n) => { let x = ''; for (let i = 0; i < n; i += 1) { h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0; x += (h & 15).toString(16); } return x; };
  return hex(8) + '-' + hex(4) + '-4' + hex(3) + '-' + ((8 + (h % 4)).toString(16)) + hex(3) + '-' + hex(12);
}

// ── Live-artifact validity ──
function offerLive(offer, clinic, state) {
  if (!offer || typeof offer !== 'object') return false;
  if (clinic && clinic.clinic_id && offer.clinic_id && String(offer.clinic_id) !== String(clinic.clinic_id)) return false;
  if (clinic && clinic.conversation_id && offer.conversation_id && String(offer.conversation_id) !== String(clinic.conversation_id)) return false;
  const exp = Date.parse(String(offer.expires_at || ''));
  if (!Number.isFinite(exp)) return false;
  return exp > nowMs(clinic);
}
function targetLive(target, clinic) {
  if (!target || typeof target !== 'object') return false;
  const exp = Date.parse(String(target.expires_at || ''));
  if (Number.isFinite(exp) && exp <= nowMs(clinic)) return false;
  return true;
}
function targetBindingValid(target, state, clinic) {
  if (!target || typeof target !== 'object') return false;
  const action = String(target.action || '');
  if (['create_appointment'].includes(action)) {
    return uuidValid(target.doctor_id) && uuidValid(target.slot_id)
      && K2C.isoDateValid(target.date) && K2C.normalizeTime(target.time)
      && ['NEW_VISIT', 'FOLLOW_UP'].includes(String(target.appointment_type || ''))
      && (!clinic || !clinic.clinic_id || String(target.clinic_id || clinic.clinic_id) === String(clinic.clinic_id))
      && (!clinic || !clinic.patient_id || String(target.patient_id || clinic.patient_id) === String(clinic.patient_id))
      && (!clinic || !clinic.conversation_id || String(target.conversation_id || clinic.conversation_id) === String(clinic.conversation_id));
  }
  if (action === 'cancel_appointment') {
    return uuidValid(target.appointment_id);
  }
  if (action === 'reschedule_appointment') {
    return uuidValid(target.appointment_id) && uuidValid(target.new_slot_id);
  }
  return false;
}

// ── Patient data ──
function patientFieldsFrom(state, contract) {
  const bc = (state && state.booking_context) || {};
  const review = (state && state.patient_data_review && state.patient_data_review.fields) || {};
  const facts = (state && state.facts && state.facts.patient) || {};
  const ent = (contract && contract.entities) || {};
  const pick = (...vals) => { for (const v of vals) { if (v !== null && v !== undefined && String(v).trim() !== '') return v; } return null; };
  return {
    patient_name: pick(ent.patient_name, bc.patient_name, review.name, facts.name),
    patient_phone: pick(ent.patient_phone, bc.patient_phone, review.phone, facts.phone),
    patient_age: ent.patient_age ?? bc.patient_age ?? review.age ?? facts.age ?? null,
    patient_address: pick(ent.patient_address, bc.patient_address, review.address, facts.address)
  };
}
function patientDataComplete(fields, appointmentType) {
  return Boolean(fields.patient_name && fields.patient_phone
    && fields.patient_age !== null && fields.patient_age !== undefined && String(fields.patient_age).trim() !== ''
    && fields.patient_address && String(appointmentType || ''));
}

// ── Legacy shim: map pre-v3 persisted state to a v3 state ──
function shimState(state, clinic) {
  if (!state || typeof state !== 'object') return STATES.IDLE;
  const legacy = String(state.operation_state || '').toUpperCase();
  const target = state.confirmation_target || null;
  if (legacy === 'AWAITING_CONFIRMATION' || (target && targetLive(target, clinic) && ['proposed', 'sent', 'pending'].includes(String(target.confirmation_delivery_status || target.delivery || 'pending')))) {
    return STATES.AWAIT_CONFIRMATION;
  }
  if (offerLive(state.presented_offer || state.pending_offer, clinic, state)) return STATES.AWAIT_SLOT_CHOICE;
  if (['COMPLETED'].includes(legacy)) return STATES.COMPLETED;
  if (['CANCELLED', 'FAILED_FINAL'].includes(legacy)) return STATES.IDLE;
  const stage = String(state.conversation_stage || '');
  if (stage === 'WAITING_PATIENT_DATA_CONFIRMATION') return STATES.CONFIRM_PATIENT_DATA;
  const bc = state.booking_context || {};
  const hasDoctor = Boolean(bc.doctor_id || bc.doctor_name);
  if (!hasDoctor && !bc.date) return legacy ? STATES.ASK_DOCTOR : STATES.IDLE;
  if (hasDoctor && !bc.appointment_type) return STATES.ASK_VISIT_TYPE;
  const fields = patientFieldsFrom(state, null);
  if (!patientDataComplete(fields, bc.appointment_type)) return STATES.COLLECT_PATIENT_DATA;
  if (!bc.date) return STATES.ASK_DATE;
  return STATES.ASK_DATE;
}
function currentStateOf(state, clinic) {
  const sm = state && state.state_machine;
  const cs = sm && typeof sm === 'object' ? String(sm.current_state || '') : '';
  if (cs && Object.values(STATES).indexOf(cs) !== -1) return cs;
  return shimState(state, clinic);
}

// ── Selection binding against a live presented_offer ──
function matchOfferedAlternative(offer, contract) {
  const alts = Array.isArray(offer && offer.alternatives) ? offer.alternatives : [];
  if (!alts.length) return null;
  const sel = (contract && contract.selection) || {};
  if (sel.kind === 'presented_rank' && Number.isInteger(sel.rank)) {
    return alts.find((a) => Number(a.rank) === Number(sel.rank)) || null;
  }
  if (sel.kind === 'any' || (contract.confirmation && contract.confirmation.intent === 'affirmative')) {
    return alts.slice().sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99))[0] || null;
  }
  if (sel.kind === 'presented_match') {
    const stripHamza = (v) => String(v || '').replace(/[أإآ]/g, 'ا');
    return alts.find((a) => {
      let dateOk = true; let timeOk = true;
      if (sel.date) dateOk = String(a.local_date || a.date || '') === String(sel.date);
      if (sel.time) timeOk = String(a.local_time || a.time || '').slice(0, 5) === String(sel.time).slice(0, 5);
      return dateOk && timeOk;
    }) || null;
  }
  return null;
}

// ── Slot-lookup readiness (selection-driven, contract-only) ──
// Shared verbatim by the readiness node and by decide() for consistency.

// ── Confirmation target builders ──
function buildCreateTarget(input, slot, verificationStatus) {
  const state = input.state || {};
  const clinic = input.clinic || {};
  const lineage = input.lineage || {};
  const resolved = input.resolved || {};
  const contract = input.contract || {};
  const bc = state.booking_context || {};
  const offer = state.presented_offer || state.pending_offer || null;
  const fields = patientFieldsFrom(state, contract);
  // P42b (RG-5): default to NEW_VISIT at build time — a null type could never pass
  // the strict binding check, producing a deterministic confirm-stall.
  const appointmentType = bc.appointment_type || (offer && offer.appointment_type) || contract.entities.visit_type || 'NEW_VISIT';
  const operationId = lineage.operation_id
    || (lineage.idempotency_key ? lineage.idempotency_key + ':create_appointment' : mintUuid('op:' + clinic.conversation_id + ':' + (lineage.message_id || '')));
  return {
    schema_version: 3,
    action: 'create_appointment',
    clinic_id: clinic.clinic_id || null,
    patient_id: clinic.patient_id || null,
    conversation_id: clinic.conversation_id || null,
    doctor_id: slot.doctor_id || bc.doctor_id || resolved.doctor_id || null,
    doctor_name: slot.doctor_name || bc.doctor_name || resolved.doctor_name || null,
    service_id: slot.service_id || bc.service_id || offer && offer.service_id || null,
    service_name: slot.service_name || bc.service_name || null,
    slot_id: slot.slot_id || null,
    date: slot.local_date || slot.date || null,
    time: String(slot.local_time || slot.time || '').slice(0, 5) || null,
    appointment_type: ['NEW_VISIT', 'FOLLOW_UP'].includes(appointmentType) ? appointmentType : null,
    patient_name: fields.patient_name, patient_phone: fields.patient_phone,
    patient_age: fields.patient_age, patient_address: fields.patient_address,
    operation_id: operationId,
    last_user_message_id_at_request: lineage.message_id || null,
    confirmation_id: mintUuid('confirm:' + operationId),
    confirmation_ttl_seconds: CONFIRM_TTL_SECONDS,
    expires_at: new Date(nowMs(clinic) + CONFIRM_TTL_SECONDS * 1000).toISOString(),
    verification_status: verificationStatus,
    delivery: 'pending',
    source: 'state_table_v3'
  };
}

// ── Turn directive (model guidance facts, no patient-facing strings) ──
function directiveFor(rowId, ctx) {
  const d = { rule: rowId };
  switch (rowId) {
    case 'ask_doctor': d.must_ask = ['doctor']; break;
    case 'ask_visit_type': d.must_ask = ['visit_type']; break;
    case 'collect_patient_data': d.must_ask = ctx.missingPatientFields || ['patient_name', 'patient_age', 'patient_phone', 'patient_address']; break;
    case 'confirm_patient_data': d.must_show_review = ctx.reviewFields || null; break;
    case 'ask_date': d.must_ask = ['date']; break;
    case 'present_alternatives': d.present_alternatives = { max: 4 }; break;
    case 'propose_confirm': d.must_propose_confirm = true; d.confirm_facts = ctx.confirmFacts || null; break;
    default: break;
  }
  if (ctx.lockedFields && ctx.lockedFields.length) d.locked_fields = ctx.lockedFields;
  return d;
}
function lockedFieldsOf(state, contract) {
  const bc = (state && state.booking_context) || {};
  const ent = (contract && contract.entities) || {};
  const locked = [];
  if (bc.doctor_id || bc.doctor_name || ent.doctor_name) locked.push('doctor');
  if (bc.appointment_type || ent.visit_type) locked.push('visit_type');
  if (bc.patient_name || ent.patient_name) locked.push('patient_name');
  if (bc.patient_phone || ent.patient_phone) locked.push('patient_phone');
  if ((bc.patient_age ?? ent.patient_age) !== undefined && (bc.patient_age ?? ent.patient_age) !== null) locked.push('patient_age');
  if (bc.patient_address || ent.patient_address) locked.push('patient_address');
  if (bc.date) locked.push('date');
  return locked;
}

// ── The main entry point ──
function decide(input) {
  const state = input.state || {};
  const contract = input.contract || {};
  const clinic = input.clinic || {};
  const resolved = input.resolved || {};
  const lookup = input.lookup && input.lookup.executed === true ? input.lookup : null;
  const lineage = input.lineage || {};

  const cs = currentStateOf(state, clinic);
  const cls = K2C.messageClass(contract, state);
  const vetoReasons = [];
  const bc0 = state.booking_context || {};
  const offer = offerLive(state.presented_offer || state.pending_offer, clinic, state) ? (state.presented_offer || state.pending_offer) : null;
  const priorTarget = targetLive(state.confirmation_target, clinic) ? state.confirmation_target : null;
  const patches = {
    state_machine: { current_state: cs, previous_state: cs, last_decision_rule: null, updated_at: clinic.now_iso || null },
    presented_offer: state.presented_offer || state.pending_offer || null,
    confirmation_target: state.confirmation_target || null,
    turn_directive: null,
    booking_context: { ...bc0 },
    patient_data_review: state.patient_data_review || null,
    unclear_count: Number(state.unclear_count || 0),
    response_code_history: Array.isArray(state.response_code_history) ? state.response_code_history.slice(-4) : [],
    progress_this_turn: false
  };
  if (cls !== 'unclear') patches.unclear_count = 0;

  const finish = (ruleId, nextState, responseCode, extra) => {
    extra = extra || {};
    patches.state_machine = { current_state: nextState, previous_state: cs, last_decision_rule: ruleId, updated_at: clinic.now_iso || null };
    const decision = {
      allowed: extra.allowed === true,
      action: extra.action || null,
      response_code: responseCode,
      decision_rule: ruleId,
      booking_context: patches.booking_context,
      confirmation_target: patches.confirmation_target,
      confirmation_state: extra.confirmation_state || null,
      patient_data_complete: extra.patient_data_complete === true,
      patient_data_gate_satisfied: extra.patient_data_gate_satisfied === true,
      missing_fields: extra.missing_fields || [],
      missing_human_fields: extra.missing_fields || [],
      next_best_missing_human_field: extra.missing_fields && extra.missing_fields[0] || null,
      escalation_requested: extra.escalation_requested === true,
      handoff_reason: extra.handoff_reason || null,
      new_booking_restart: extra.new_booking_restart === true,
      non_scheduling_turn: extra.non_scheduling_turn === true,
      availability_inquiry: cls === 'availability_inquiry',
      deterministic_slot_lookup: lookup || null,
      contract,
      turn_directive: patches.turn_directive,
      state_machine: patches.state_machine,
      veto_reasons: vetoReasons
    };
    // MODEL-FIRST 2026-09-03: loop breaker removed. The model manages the
    // dialogue; repetition never escalates to a human. Only contract.escalate does.
    const hist = patches.response_code_history;
    patches.response_code_history = hist.concat([{ code: responseCode, state: cs, rule: ruleId, at: clinic.now_iso || null }]).slice(-4);
    return { next_state: nextState, decision_rule: ruleId, veto_reasons: vetoReasons, system_decision: decision, state_patches: patches, lookup_request: null };
  };

  // ── Global rows ──
  if (contract.escalate === true) {
    return finish('escalate_requested', cs, 'HANDOFF_REQUIRED', { escalation_requested: true, handoff_reason: contract.handoff_reason || 'model_escalation' });
  }

  // R1 — fresh booking restart: only intent+relation, never text, and never while
  // a live offer/target is being confirmed.
  const relation = String(contract.turn.relation_to_previous_turn || 'none');
  const freshBookingRestart = cls === 'booking' && String(contract.turn.intent || '') === 'booking_request'
    && relation === 'new_request' && !offer && !priorTarget;
  if (freshBookingRestart) {
    // v32: a restart replaces the doctor/service/slot under discussion, but
    // facts already collected for the SAME patient (visit type, patient
    // identity) stay valid. Only wipe them when the message introduces a
    // DIFFERENT patient identity. Without this, a mid-booking doctor switch
    // re-asked visit_type (exec 8260) while the sent reply asked for the date,
    // and the next turn (8273) got contradictory inputs and burned its whole
    // 4000-token budget on an empty reply.
    const prevBc = state.booking_context || {};
    const entC = contract.entities || {};
    const prevName = String(prevBc.patient_name || '').trim();
    const prevPhone = String(prevBc.patient_phone || '').trim();
    const entName = String(entC.patient_name || '').trim();
    const entPhone = String(entC.patient_phone || '').trim();
    const patientIdentityChanged = (entName && prevName && entName !== prevName)
      || (entPhone && prevPhone && entPhone !== prevPhone);
    patches.booking_context = {};
    patches.presented_offer = null;
    patches.confirmation_target = null;
    patches.patient_data_review = null;
    patches.progress_this_turn = true;
    if (!patientIdentityChanged) {
      const knownVisitType = prevBc.appointment_type
        || (state.slot_state && state.slot_state.appointment_type) || null;
      if (knownVisitType && ['NEW_VISIT', 'FOLLOW_UP'].includes(String(knownVisitType).trim().toUpperCase())) {
        patches.booking_context.appointment_type = String(knownVisitType).trim().toUpperCase();
      }
    }
  }

  if (cls === 'unclear') {
    // MODEL-FIRST 2026-09-03: unclear turns keep asking for clarification.
    // Auto-handoff removed; only the model may request a human via contract.escalate.
    patches.unclear_count = Number(state.unclear_count || 0) + 1;
    return finish('unclear_clarify', cs, 'CONVERSATION_ONLY', { non_scheduling_turn: true });
  }

  if (cls === 'small_talk' || cls === 'clinic_query') {
    // No reset, no state change; a live operation simply pauses.
    return finish(cls === 'small_talk' ? 'small_talk_hold' : 'clinic_query_hold', cs, 'CONVERSATION_ONLY', { non_scheduling_turn: true });
  }

  // ── Lookup result rows (a deterministic lookup ran this turn) ──
  if (lookup) {
    const alts = Array.isArray(lookup.alternatives) ? lookup.alternatives : [];
    const outcome = String(lookup.availability_outcome || '').toLowerCase();
    const code = String(lookup.result_code || '').toUpperCase();
    if (outcome === 'authority_error' || code === 'AVAILABILITY_SOURCE_ERROR') {
      return finish('lookup_authority_error', cs, 'AVAILABILITY_SOURCE_ERROR', {});
    }
    if (lookup.search_mode === 'exact_slot') {
      const slot = alts[0];
      if (lookup.slot_found === true && slot && uuidValid(slot.slot_id)) {
        const target = buildCreateTarget(input, slot, 'exact_verified');
        if (targetBindingValid(target, state, clinic)) {
          patches.confirmation_target = target;
          patches.turn_directive = directiveFor('propose_confirm', { confirmFacts: { doctor_name: target.doctor_name, date: target.date, time: target.time, appointment_type: target.appointment_type }, lockedFields: lockedFieldsOf(state, contract) });
          const complete = patientDataComplete(patientFieldsFrom(state, contract), target.appointment_type);
          return finish('selection_bound_verified', STATES.AWAIT_CONFIRMATION, 'CONFIRMATION_REQUIRED', {
            confirmation_state: 'proposed', patient_data_complete: complete, patient_data_gate_satisfied: complete
          });
        }
        vetoReasons.push('target_invariants_failed_after_exact_verification');
        return finish('selection_bind_rejected', STATES.ASK_DATE, 'MISSING_REQUIRED_FIELDS', { missing_fields: ['date'] });
      }
      if (alts.length) {
        patches.presented_offer = buildOffer(input, alts);
        patches.turn_directive = directiveFor('present_alternatives', { lockedFields: lockedFieldsOf(state, contract) });
        if (patches.booking_context && typeof patches.booking_context === 'object') { patches.booking_context.date = null; patches.booking_context.time = null; } // V37-NO-PHANTOM-DATE: verified offer/outcome supersedes the raw requested date
      return finish('exact_unavailable_nearest_offered', STATES.AWAIT_SLOT_CHOICE, 'SLOT_UNAVAILABLE', {});
      }
      patches.presented_offer = null;
      patches.turn_directive = directiveFor('ask_date', { lockedFields: lockedFieldsOf(state, contract) });
      if (patches.booking_context && typeof patches.booking_context === 'object') { patches.booking_context.date = null; patches.booking_context.time = null; } // V37-NO-PHANTOM-DATE: verified offer/outcome supersedes the raw requested date
      return finish('exact_unavailable_ask_again', STATES.ASK_DATE, code || 'SLOT_UNAVAILABLE', {});
    }
    // requested_window / nearby_alternatives
    if (alts.length) {
      patches.presented_offer = buildOffer(input, alts);
      patches.progress_this_turn = true;
      patches.turn_directive = directiveFor('present_alternatives', { lockedFields: lockedFieldsOf(state, contract) });
      if (patches.booking_context && typeof patches.booking_context === 'object') { patches.booking_context.date = null; patches.booking_context.time = null; } // V37-NO-PHANTOM-DATE: verified offer/outcome supersedes the raw requested date
      return finish('alternatives_presented', STATES.AWAIT_SLOT_CHOICE, 'AVAILABILITY_RESULTS', {});
    }
    patches.presented_offer = null;
    patches.turn_directive = directiveFor('ask_date', { lockedFields: lockedFieldsOf(state, contract) });
      if (patches.booking_context && typeof patches.booking_context === 'object') { patches.booking_context.date = null; patches.booking_context.time = null; } // V37-NO-PHANTOM-DATE: verified offer/outcome supersedes the raw requested date
    return finish('window_unavailable', STATES.ASK_DATE, code || 'NO_AVAILABLE_SLOTS', {});
  }

  // ── Cancel / reschedule rows (own targets, own confirmations) ──
  if (cls === 'cancel_request' || cls === 'reschedule_request') {
    const apptId = contract.entities.appointment_id || state.appointment_id || (state.facts && state.facts.booking && state.facts.booking.appointment_id) || null;
    if (!uuidValid(apptId)) {
      return finish(cls === 'cancel_request' ? 'cancel_need_appointment' : 'reschedule_need_appointment', cs, 'MISSING_REQUIRED_FIELDS', { missing_fields: ['appointment_id'] });
    }
    // RESCHEDULE FIX: a reschedule requires a resolved NEW slot plus the appointment's
    // real old slot (from the resolver), not the conversation's slot_state. When the new
    // slot isn't resolved yet, ask for the new date instead of proposing a confirmation.
    const isReschedule = cls === 'reschedule_request';
    const oldSlotId = isReschedule
      ? (resolved.expected_old_slot_id || (state.slot_state && state.slot_state.slot_id) || null)
      : (state.slot_state && state.slot_state.slot_id) || null;
    const newSlotId = isReschedule ? (resolved.new_slot_id || null) : null;
    if (isReschedule && !uuidValid(newSlotId)) {
      patches.turn_directive = directiveFor('ask_date', { lockedFields: lockedFieldsOf(state, contract) });
      return finish('reschedule_need_new_slot', STATES.ASK_DATE, 'MISSING_REQUIRED_FIELDS', { missing_fields: ['date'] });
    }
    const target = {
      schema_version: 3, action: cls === 'cancel_request' ? 'cancel_appointment' : 'reschedule_appointment',
      clinic_id: clinic.clinic_id || null, patient_id: clinic.patient_id || null, conversation_id: clinic.conversation_id || null,
      appointment_id: apptId,
      booking_number: contract.entities.booking_number || state.booking_number || null,
      expected_old_slot_id: oldSlotId,
      new_slot_id: newSlotId,
      operation_id: lineage.operation_id || (lineage.idempotency_key ? lineage.idempotency_key + ':' + (cls === 'cancel_request' ? 'cancel_appointment' : 'reschedule_appointment') : mintUuid('opx:' + (lineage.message_id || apptId))),
      last_user_message_id_at_request: lineage.message_id || null,
      confirmation_id: mintUuid('confirmx:' + apptId + ':' + (lineage.message_id || '')),
      confirmation_ttl_seconds: CONFIRM_TTL_SECONDS,
      expires_at: new Date(nowMs(clinic) + CONFIRM_TTL_SECONDS * 1000).toISOString(),
      delivery: 'pending', source: 'state_table_v3'
    };
    if (!targetBindingValid(target, state, clinic)) {
      return finish('op_target_invalid', cs, 'MISSING_REQUIRED_FIELDS', { missing_fields: ['appointment_id'] });
    }
    patches.confirmation_target = target;
    patches.turn_directive = directiveFor('propose_confirm', { confirmFacts: isReschedule ? { action: target.action, appointment_id: target.appointment_id, new_slot_id: target.new_slot_id } : { action: target.action, appointment_id: target.appointment_id } });
    return finish(cls === 'cancel_request' ? 'cancel_proposed' : 'reschedule_proposed', STATES.AWAIT_CONFIRMATION, 'CONFIRMATION_REQUIRED', { confirmation_state: 'proposed' });
  }

  // ── Confirmation rows (state-independent C1 gate over a live target) ──
  if ((cls === 'confirmation_affirm' || cls === 'confirmation_negative' || cls === 'confirmation_question') && cs !== STATES.CONFIRM_PATIENT_DATA) {
    if (priorTarget && targetBindingValid(priorTarget, state, clinic) && cls === 'confirmation_affirm') {
      const act = String(priorTarget.action || '');
      const approvedCode = act === 'create_appointment' ? 'EXECUTE_APPROVED' : (act === 'cancel_appointment' ? 'CANCEL_APPROVED' : 'RESCHEDULE_APPROVED');
      const fields = patientFieldsFrom(state, contract);
      const complete = act !== 'create_appointment' || patientDataComplete(fields, priorTarget.appointment_type || bc0.appointment_type);
      if (act === 'create_appointment' && !complete) {
        const missing = missingPatientFields(state, contract);
        vetoReasons.push('patient_data_gate_failed');
        return finish('confirm_blocked_missing_data', cs, 'MISSING_REQUIRED_FIELDS', { missing_fields: missing });
      }
      patches.confirmation_target = { ...priorTarget, delivery: 'confirmed' };
      return finish('c1_confirm_execute', STATES.EXECUTING, approvedCode, {
        allowed: true, action: act, confirmation_state: 'confirmed',
        patient_data_complete: complete, patient_data_gate_satisfied: complete
      });
    }
    if (priorTarget && cls === 'confirmation_negative') {
      patches.confirmation_target = null;
      patches.progress_this_turn = true;
      if (offer) {
        patches.turn_directive = directiveFor('present_alternatives', { lockedFields: lockedFieldsOf(state, contract) });
        return finish('confirm_rejected_offer_open', STATES.AWAIT_SLOT_CHOICE, 'AVAILABILITY_RESULTS', {});
      }
      patches.turn_directive = directiveFor('ask_date', { lockedFields: lockedFieldsOf(state, contract) });
      return finish('confirm_rejected_ask_date', STATES.ASK_DATE, 'CONVERSATION_ONLY', {});
    }
    if (priorTarget && cls === 'confirmation_question') {
      return finish('confirm_question_hold', cs, 'CONVERSATION_ONLY', {});
    }
    if (offer && cls === 'confirmation_affirm' && cs === STATES.AWAIT_SLOT_CHOICE) {
      // Acceptance of an offered alternative without an exact-verification lookup:
      // bind from the verified offered alternative itself.
      const alt = matchOfferedAlternative(offer, contract);
      if (alt && uuidValid(alt.slot_id)) {
        const target = buildCreateTarget(input, alt, 'offered_alternative');
        if (targetBindingValid(target, state, clinic)) {
          patches.confirmation_target = target;
          patches.turn_directive = directiveFor('propose_confirm', { confirmFacts: { doctor_name: target.doctor_name, date: target.date, time: target.time, appointment_type: target.appointment_type }, lockedFields: lockedFieldsOf(state, contract) });
          const complete = patientDataComplete(patientFieldsFrom(state, contract), target.appointment_type);
          return finish('selection_bound_from_offer', STATES.AWAIT_CONFIRMATION, 'CONFIRMATION_REQUIRED', {
            confirmation_state: 'proposed', patient_data_complete: complete, patient_data_gate_satisfied: complete
          });
        }
        vetoReasons.push('offer_bind_invariants_failed');
      }
      return finish('offer_affirm_no_match', cs, 'CONVERSATION_ONLY', {});
    }
    if ((priorTarget && !targetBindingValid(priorTarget, state, clinic)) || (!priorTarget && state.confirmation_target)) {
      patches.confirmation_target = null;
      return finish('stale_target_refresh', STATES.ASK_DATE, 'CONFIRMATION_EXPIRED', {});
    }
    return finish('confirm_without_target', cs, 'CONVERSATION_ONLY', { non_scheduling_turn: true });
  }

  // ── Booking rows (state table) ──
  const ent = contract.entities || {};
  // BUGFIX (2026-09-09): unknown-doctor guard — if the patient named a doctor THIS turn and
  // the resolver matched zero doctors, that name is not a real clinic doctor. Never treat it
  // as a given doctor; the agent replies that the doctor is unavailable and lists the directory.
  const doctorUnknown = ent.doctor_name != null && String(ent.doctor_name).trim() !== '' && resolved.doctor_match_count === 0;
  if (doctorUnknown) ent.doctor_name = null;
  const doctorGiven = Boolean(resolved.doctor_id || ent.doctor_name || patches.booking_context.doctor_id || patches.booking_context.doctor_name);
  const doctorCount = Number(clinic.doctor_count || 0);
  const visitType = patches.booking_context.appointment_type || ent.visit_type || null;

  // Merge patient/visit entities collected this turn into the booking context.
  if (cls === 'booking' || cls === 'correction') {
    let changed = false;
    const bc = patches.booking_context;
    if (resolved.doctor_id && bc.doctor_id !== resolved.doctor_id) { bc.doctor_id = resolved.doctor_id; bc.doctor_name = resolved.doctor_name || bc.doctor_name; changed = true; }
    else if (ent.doctor_name && (!bc.doctor_name || cls === 'correction')) { bc.doctor_name = ent.doctor_name; bc.doctor_id = null; changed = true; }
    if (resolved.service_id && bc.service_id !== resolved.service_id) { bc.service_id = resolved.service_id; bc.service_name = resolved.service_name || bc.service_name; changed = true; }
    if (ent.visit_type && bc.appointment_type !== ent.visit_type) { bc.appointment_type = ent.visit_type; changed = true; }
    if (ent.patient_name && bc.patient_name !== ent.patient_name) { bc.patient_name = ent.patient_name; changed = true; }
    if (ent.patient_phone && bc.patient_phone !== ent.patient_phone) { bc.patient_phone = ent.patient_phone; changed = true; }
    if (ent.patient_age !== null && ent.patient_age !== undefined && bc.patient_age !== ent.patient_age) { bc.patient_age = ent.patient_age; changed = true; }
    if (ent.patient_address && bc.patient_address !== ent.patient_address) { bc.patient_address = ent.patient_address; changed = true; }
    if (K2C.isoDateValid(ent.date) && bc.date !== String(ent.date)) { bc.date = String(ent.date); changed = true; }
    const entTime = K2C.normalizeTime(ent.time);
    if (entTime && bc.time !== entTime) { bc.time = entTime; changed = true; }
    if (changed) patches.progress_this_turn = true;
  }
  const knownDateIso = K2C.isoDateValid(ent.date) ? String(ent.date) : (K2C.isoDateValid(patches.booking_context.date) ? String(patches.booking_context.date) : null);

  if (!doctorGiven && (cls === 'booking' || cls === 'availability_inquiry')) {
    if (doctorCount === 1 && clinic.single_doctor_id && uuidValid(clinic.single_doctor_id)) {
      patches.booking_context.doctor_id = clinic.single_doctor_id;
      patches.booking_context.doctor_name = clinic.single_doctor_name || null;
      patches.progress_this_turn = true;
      patches.turn_directive = directiveFor('ask_visit_type', { lockedFields: lockedFieldsOf(patches, contract) });
      return finish(freshBookingRestart ? 'restart_single_doctor_visit_type' : 'single_doctor_visit_type', STATES.ASK_VISIT_TYPE, visitType ? 'CONVERSATION_ONLY' : 'MISSING_REQUIRED_FIELDS', { missing_fields: visitType ? [] : ['visit_type'], new_booking_restart: freshBookingRestart });
    }
    patches.turn_directive = directiveFor('ask_doctor', {});
    return finish(freshBookingRestart ? 'restart_ask_doctor' : 'ask_doctor', STATES.ASK_DOCTOR, 'MISSING_REQUIRED_FIELDS', { missing_fields: ['doctor'], new_booking_restart: freshBookingRestart });
  }

  if (cs === STATES.IDLE || cs === STATES.ASK_DOCTOR || freshBookingRestart) {
    if (cls === 'booking' && doctorGiven && !visitType) {
      patches.turn_directive = directiveFor('ask_visit_type', { lockedFields: lockedFieldsOf(patches, contract) });
      return finish('ask_visit_type', STATES.ASK_VISIT_TYPE, 'MISSING_REQUIRED_FIELDS', { missing_fields: ['visit_type'], new_booking_restart: freshBookingRestart });
    }
    if (cls === 'availability_inquiry') {
      patches.turn_directive = directiveFor('ask_date', { lockedFields: lockedFieldsOf(patches, contract) });
      return finish('availability_needs_date', doctorGiven ? STATES.ASK_DATE : STATES.ASK_DOCTOR, 'MISSING_REQUIRED_FIELDS', { missing_fields: doctorGiven ? ['date'] : ['doctor'] });
    }
  }

  if (cs === STATES.ASK_VISIT_TYPE || (cs !== STATES.ASK_DOCTOR && doctorGiven && cls === 'booking' && (!visitType     || (cs === STATES.IDLE && !patientDataComplete(patientFieldsFrom(state, contract), visitType))     || (cs === STATES.IDLE && savedRecordPendingReview(state, contract)) ))) { // v39: IDLE dead-zone fix — when the visit type is already known, IDLE turns with an incomplete or never-reviewed profile are owned here instead of falling to default_conversation
    if (visitType) {
      patches.booking_context.appointment_type = visitType;
      const saved = state.facts && state.facts.patient;
      const savedComplete = saved && saved.name && saved.phone && (saved.age ?? null) !== null && saved.address;
      if (savedComplete && !patches.patient_data_review) {
        patches.patient_data_review = { fields: { name: saved.name, age: saved.age, phone: saved.phone, address: saved.address }, status: 'pending_confirmation', source: 'saved_record' };
        patches.turn_directive = directiveFor('confirm_patient_data', { reviewFields: patches.patient_data_review.fields, lockedFields: lockedFieldsOf(patches, contract) });
        return finish('saved_record_review', STATES.CONFIRM_PATIENT_DATA, 'PATIENT_DATA_CONFIRMATION_REQUIRED', {});
      }
      const missing = missingPatientFields(state, contract);
      if (!missing.length) {
        const patientChangedNow = Boolean(ent.patient_name || ent.patient_phone || (ent.patient_age !== null && ent.patient_age !== undefined) || ent.patient_address);
        if (patches.patient_data_review && String(patches.patient_data_review.status || '').toLowerCase() === 'confirmed' && !patientChangedNow) {
          patches.turn_directive = directiveFor('ask_date', { lockedFields: lockedFieldsOf(patches, contract) });
          return finish('review_confirmed_skip_reconfirm', STATES.ASK_DATE, 'CONVERSATION_ONLY', {});
        }
        patches.patient_data_review = reviewFrom(patches, 'collected');
        patches.turn_directive = directiveFor('confirm_patient_data', { reviewFields: patches.patient_data_review.fields, lockedFields: lockedFieldsOf(patches, contract) });
        return finish('collect_complete_inline', STATES.CONFIRM_PATIENT_DATA, 'PATIENT_DATA_CONFIRMATION_REQUIRED', {});
      }
      patches.turn_directive = directiveFor('collect_patient_data', { missingPatientFields: missing, lockedFields: lockedFieldsOf(patches, contract) });
      return finish('collect_patient_data', STATES.COLLECT_PATIENT_DATA, 'MISSING_REQUIRED_FIELDS', { missing_fields: missing });
    }
    patches.turn_directive = directiveFor('ask_visit_type', { lockedFields: lockedFieldsOf(patches, contract) });
    return finish('ask_visit_type_repeat', STATES.ASK_VISIT_TYPE, 'MISSING_REQUIRED_FIELDS', { missing_fields: ['visit_type'] });
  }

  if (cs === STATES.COLLECT_PATIENT_DATA) {
    const missing = missingPatientFields(patches, contract);
    if (!missing.length) {
      patches.patient_data_review = reviewFrom(patches, 'collected');
      patches.turn_directive = directiveFor('confirm_patient_data', { reviewFields: patches.patient_data_review.fields, lockedFields: lockedFieldsOf(patches, contract) });
      return finish('collect_complete', STATES.CONFIRM_PATIENT_DATA, 'PATIENT_DATA_CONFIRMATION_REQUIRED', {});
    }
    patches.turn_directive = directiveFor('collect_patient_data', { missingPatientFields: missing, lockedFields: lockedFieldsOf(patches, contract) });
    return finish('collect_continue', STATES.COLLECT_PATIENT_DATA, 'MISSING_REQUIRED_FIELDS', { missing_fields: missing });
  }

  if (cs === STATES.CONFIRM_PATIENT_DATA) {
    if (cls === 'confirmation_question') {
      patches.turn_directive = directiveFor('confirm_patient_data', { reviewFields: (patches.patient_data_review && patches.patient_data_review.fields) || null, lockedFields: lockedFieldsOf(patches, contract) });
      return finish('review_question_hold', STATES.CONFIRM_PATIENT_DATA, 'PATIENT_DATA_CONFIRMATION_REQUIRED', {});
    }
    if (cls === 'correction' || (cls === 'booking' && (ent.patient_name || ent.patient_phone || (ent.patient_age !== null && ent.patient_age !== undefined) || ent.patient_address))) {
      patches.patient_data_review = reviewFrom(patches, 'corrected');
      patches.turn_directive = directiveFor('confirm_patient_data', { reviewFields: patches.patient_data_review.fields, lockedFields: lockedFieldsOf(patches, contract) });
      return finish('review_corrected', STATES.CONFIRM_PATIENT_DATA, 'PATIENT_DATA_CONFIRMATION_REQUIRED', {});
    }
    if (patches.patient_data_review) patches.patient_data_review.status = 'confirmed';
    // FIX (owner-reported test failure 2026-09-07): a verified appointment slot bound
    // BEFORE the patient-data review (confirmation_target from the date/time step) was
    // being discarded here and the patient re-asked for the date, because this branch
    // never consulted priorTarget — only the C1 gate above did, and that gate is
    // explicitly skipped while cs === CONFIRM_PATIENT_DATA. Execute the already-bound
    // target now, mirroring the C1 confirm-execute gate, instead of resetting to ASK_DATE.
    if (priorTarget && priorTarget.action === 'create_appointment' && targetBindingValid(priorTarget, state, clinic)) {
      const fields = patientFieldsFrom(state, contract);
      const complete = patientDataComplete(fields, priorTarget.appointment_type || bc0.appointment_type);
      if (complete) {
        patches.confirmation_target = { ...priorTarget, delivery: 'confirmed' };
        return finish('review_confirmed_execute_bound_target', STATES.EXECUTING, 'EXECUTE_APPROVED', {
          allowed: true, action: 'create_appointment', confirmation_state: 'confirmed',
          patient_data_complete: true, patient_data_gate_satisfied: true
        });
      }
      const missing = missingPatientFields(state, contract);
      vetoReasons.push('patient_data_gate_failed');
      return finish('review_confirmed_missing_data', STATES.CONFIRM_PATIENT_DATA, 'MISSING_REQUIRED_FIELDS', { missing_fields: missing });
    }
    patches.turn_directive = directiveFor('ask_date', { lockedFields: lockedFieldsOf(patches, contract) });
    return finish('review_confirmed_ask_date', STATES.ASK_DATE, 'CONVERSATION_ONLY', {});
  }

  // P47 TOOL-PATH BINDING BRIDGE (owner directive: no field may ever drop).
  // A live presented_offer (written by the availability tool) plus a selection in
  // the contract binds immediately, regardless of the current state row.
  if (offer && cls === 'selection_presented') {
    const bridgeAlt = matchOfferedAlternative(offer, contract);
    if (bridgeAlt && uuidValid(bridgeAlt.slot_id) && (!priorTarget || String(priorTarget.slot_id || '') !== String(bridgeAlt.slot_id || ''))) {
      const bridgeTarget = buildCreateTarget(input, bridgeAlt, 'offered_alternative');
      if (targetBindingValid(bridgeTarget, state, clinic)) {
        patches.confirmation_target = bridgeTarget;
        patches.turn_directive = directiveFor('propose_confirm', { confirmFacts: { doctor_name: bridgeTarget.doctor_name, date: bridgeTarget.date, time: bridgeTarget.time, appointment_type: bridgeTarget.appointment_type }, lockedFields: lockedFieldsOf(state, contract) });
        const bridgeComplete = patientDataComplete(patientFieldsFrom(state, contract), bridgeTarget.appointment_type);
        return finish('selection_bound_from_offer_bridge', STATES.AWAIT_CONFIRMATION, 'CONFIRMATION_REQUIRED', { confirmation_state: 'proposed', patient_data_complete: bridgeComplete, patient_data_gate_satisfied: bridgeComplete });
      }
    }
  }
  // P47b PATIENT-FIELD REFRESH (owner directive: changing a field must work):
  // a pending target keeps the fields captured at bind time; if the patient
  // corrects name/phone/age/address afterwards, refresh the pending target.
  if (priorTarget && priorTarget.action === 'create_appointment') {
    const refEnt = (contract.entities && typeof contract.entities === 'object') ? contract.entities : {};
    const refPatch = {};
    if (refEnt.patient_name) refPatch.patient_name = String(refEnt.patient_name).trim();
    if (refEnt.patient_phone) refPatch.patient_phone = String(refEnt.patient_phone).trim();
    if (refEnt.patient_age !== null && refEnt.patient_age !== undefined && refEnt.patient_age !== '') refPatch.patient_age = refEnt.patient_age;
    if (refEnt.patient_address) refPatch.patient_address = String(refEnt.patient_address).trim();
    if (Object.keys(refPatch).length) patches.confirmation_target = { ...priorTarget, ...refPatch };
  }
  if (cs === STATES.ASK_DATE || cs === STATES.AWAIT_SLOT_CHOICE || cs === STATES.AWAIT_CONFIRMATION) {
    if (offer && cls === 'selection_presented') { // P42: bind from any of ASK_DATE/AWAIT_SLOT_CHOICE/AWAIT_CONFIRMATION — interleaved turns legally move cs off AWAIT_SLOT_CHOICE while the offer stays open
      const alt = matchOfferedAlternative(offer, contract);
      if (alt && uuidValid(alt.slot_id)) {
        const target = buildCreateTarget(input, alt, 'offered_alternative');
        if (targetBindingValid(target, state, clinic)) {
          patches.confirmation_target = target;
          patches.turn_directive = directiveFor('propose_confirm', { confirmFacts: { doctor_name: target.doctor_name, date: target.date, time: target.time, appointment_type: target.appointment_type }, lockedFields: lockedFieldsOf(state, contract) });
          const complete = patientDataComplete(patientFieldsFrom(state, contract), target.appointment_type);
          return finish('selection_bound_from_offer', STATES.AWAIT_CONFIRMATION, 'CONFIRMATION_REQUIRED', { confirmation_state: 'proposed', patient_data_complete: complete, patient_data_gate_satisfied: complete });
        }
        vetoReasons.push('offer_bind_invariants_failed');
      }
      return finish('selection_no_match', cs, 'CONVERSATION_ONLY', {});
    }
    if (knownDateIso && cls === 'booking' && !offer) {
      // Date given but the lookup did not run this turn (preconditions failed).
      const missing = missingPatientFields(state, contract);
      if (!visitType || missing.length) {
        patches.turn_directive = directiveFor(!visitType ? 'ask_visit_type' : 'collect_patient_data', { missingPatientFields: missing, lockedFields: lockedFieldsOf(patches, contract) });
        return finish('date_given_profile_incomplete', !visitType ? STATES.ASK_VISIT_TYPE : STATES.COLLECT_PATIENT_DATA, 'MISSING_REQUIRED_FIELDS', { missing_fields: !visitType ? ['visit_type'] : missing });
      }
      patches.turn_directive = directiveFor('ask_date', { lockedFields: lockedFieldsOf(patches, contract) });
      return finish('date_given_lookup_gate_failed', STATES.ASK_DATE, 'AVAILABILITY_SOURCE_ERROR', {});
    }
    // v41 DATE-CONTRADICTION FIX (owner-approved 2026-09-07): the catch-all below
    // used to return ask_date / missing_fields:['date'] for ANY message reaching
    // these states without a match above — even when booking_context.date was
    // already collected (exec 64124 'اكد': 6795 completion tokens; exec 64143
    // 'صح': 8000 tokens, finish_reason=length, empty output). Enforced rule: never
    // request a field the booking context already holds.
    const entDateGiven = K2C.isoDateValid(ent.date) ? String(ent.date) : null;
    const offerFirstDate = (offer && Array.isArray(offer.alternatives) && offer.alternatives.length)
      ? String(offer.alternatives[0].local_date || offer.alternatives[0].date || '').slice(0, 10) : null;
    const offerContradicted = Boolean(offer && entDateGiven && offerFirstDate && offerFirstDate !== entDateGiven);
    const targetContradicted = Boolean(priorTarget
      && ((priorTarget.date && String(priorTarget.date) !== String(knownDateIso))
        || (priorTarget.time && patches.booking_context.time && K2C.normalizeTime(priorTarget.time) !== K2C.normalizeTime(patches.booking_context.time))));
    if (offerContradicted || targetContradicted) {
      // The patient steered to a different day/time this turn — the pending offer /
      // confirmation target is stale and must not be re-presented or executed.
      patches.presented_offer = null;
      patches.confirmation_target = null;
    }
    if (!knownDateIso) {
      // date genuinely missing → keep the original ask_date behavior.
      patches.turn_directive = directiveFor('ask_date', { lockedFields: lockedFieldsOf(patches, contract) });
      return finish('ask_date', STATES.ASK_DATE, 'MISSING_REQUIRED_FIELDS', { missing_fields: ['date'] });
    }
    if (offer && !offerContradicted) {
      // date collected + live offer → re-present the open alternatives.
      patches.turn_directive = directiveFor('present_alternatives', { lockedFields: lockedFieldsOf(state, contract) });
      return finish('date_known_offer_represent', STATES.AWAIT_SLOT_CHOICE, 'AVAILABILITY_RESULTS', {});
    }
    if (priorTarget && !targetContradicted) {
      // date collected + live confirmation target → re-propose the confirmation.
      patches.turn_directive = directiveFor('propose_confirm', { confirmFacts: { doctor_name: priorTarget.doctor_name || null, date: priorTarget.date || null, time: priorTarget.time || null, appointment_type: priorTarget.appointment_type || null }, lockedFields: lockedFieldsOf(state, contract) });
      return finish('date_known_repropose_confirm', STATES.AWAIT_CONFIRMATION, 'CONFIRMATION_REQUIRED', { confirmation_state: 'proposed' });
    }
    // Date already collected with no live offer/target: hold — the deterministic
    // layer never re-asks for a collected field (v35 MODEL-FIRST: the model sees
    // booking_context.date in its facts and decides what to ask next).
    return finish('date_known_hold', cs, 'CONVERSATION_ONLY', { non_scheduling_turn: true });
  }

  if (cs === STATES.COMPLETED) {
    if (cls === 'booking') {
      patches.booking_context = {};
      patches.presented_offer = null;
      patches.confirmation_target = null;
      patches.turn_directive = directiveFor('ask_doctor', {});
      return finish('completed_new_booking', STATES.ASK_DOCTOR, 'MISSING_REQUIRED_FIELDS', { missing_fields: ['doctor'], new_booking_restart: true });
    }
    return finish('completed_conversation', STATES.COMPLETED, 'CONVERSATION_ONLY', { non_scheduling_turn: true });
  }

  return finish('default_conversation', cs, 'CONVERSATION_ONLY', { non_scheduling_turn: true });
}

// v39: true only when a complete patient profile exists but NO review record
// exists yet (never reviewed). A pending review is owned by the
// CONFIRM_PATIENT_DATA row; a confirmed review must never re-fire.
function savedRecordPendingReview(state, contract) {
  if (!state || typeof state !== 'object') return false;
  const review = (state.patient_data_review && typeof state.patient_data_review === 'object') ? state.patient_data_review : null;
  const reviewStatus = review ? String(review.status || '').trim().toLowerCase() : '';
  if (reviewStatus) return false;
  return true;
}
function missingPatientFields(stateLike, contract) {
  const f = patientFieldsFrom(stateLike, contract);
  const missing = [];
  if (!f.patient_name) missing.push('patient_name');
  if (f.patient_age === null || f.patient_age === undefined) missing.push('patient_age');
  if (!f.patient_phone) missing.push('patient_phone');
  if (!f.patient_address) missing.push('patient_address');
  return missing;
}
function reviewFrom(stateLike, source) {
  const bc = stateLike.booking_context || {};
  return {
    fields: { name: bc.patient_name || null, age: bc.patient_age ?? null, phone: bc.patient_phone || null, address: bc.patient_address || null },
    status: 'pending_confirmation', source
  };
}
function buildOffer(input, alternatives) {
  const clinic = input.clinic || {};
  const state = input.state || {};
  const resolved = input.resolved || {};
  const bc = state.booking_context || {};
  const contract = input.contract || {};
  const now = nowMs(clinic);
  const first = alternatives[0] || {};
  return {
    schema_version: 2,
    kind: 'presented_offer',
    offered_at: new Date(now).toISOString(),
    expires_at: new Date(now + OFFER_TTL_SECONDS * 1000).toISOString(),
    clinic_id: clinic.clinic_id || null,
    patient_id: clinic.patient_id || null,
    conversation_id: clinic.conversation_id || null,
    doctor_id: first.doctor_id || bc.doctor_id || resolved.doctor_id || null,
    doctor_name: first.doctor_name || bc.doctor_name || resolved.doctor_name || null,
    service_id: first.service_id || bc.service_id || null,
    appointment_type: bc.appointment_type || contract.entities.visit_type || null,
    alternatives: alternatives.slice(0, 4).map((slot, i) => ({
      rank: Number(slot.rank || (i + 1)),
      slot_id: slot.slot_id || null,
      start_time: slot.start_time || null,
      local_date: slot.local_date || slot.date || null,
      local_time: String(slot.local_time || slot.time || '').slice(0, 5) || null,
      label: slot.label || null,
      doctor_id: slot.doctor_id || null,
      service_id: slot.service_id || null,
      clinic_id: slot.clinic_id || clinic.clinic_id || null,
      slot_status: slot.slot_status || 'available'
    }))
  };
}

// ── Inputs ──
// Prefer the repaired contract when the one-shot self-repair branch ran and
// produced a VALID contract; otherwise use the primary NAO output.
const repairedContractSource = (() => {
  try {
    const r = $('Validate Repaired Contract (Deterministic)').first().json;
    return (r && r._contract_status === 'VALID') ? r : null;
  } catch (_) { return null; }
})();
const contractSource = repairedContractSource || safeNode('Normalize Agent Output (Deterministic)');
// BUGFIX (2026-09-09): prefer the post-resolver contract_v3 from Apply Resolved Booking IDs.
// The resolver converts textual booking references into real UUIDs, but its results were only
// mirrored into the v2 contract and top-level fields; contractV3 (read by decide()) still had
// appointment_id=null when the patient gave a booking number, breaking cancel/reschedule.
const applyResolvedV3 = (() => {
  try {
    const ar = $('Apply Resolved Booking IDs (Deterministic)').first().json;
    return (ar && ar.contract_v3 && typeof ar.contract_v3 === 'object' && ar.contract_v3.entities && ar.contract_v3.entities.appointment_id) ? ar.contract_v3 : null;
  } catch (_) { return null; }
})();
const contractSourceFinal = (applyResolvedV3 && !repairedContractSource) ? { contract_v3: applyResolvedV3, contract: (contractSource && contractSource.contract) || {}, _normalization: (contractSource && contractSource._normalization) || {} } : contractSource;
const contractV3 = (contractSourceFinal.contract_v3 && typeof contractSourceFinal.contract_v3 === 'object') ? contractSourceFinal.contract_v3 : {};
const contractV2 = (contractSourceFinal.contract && typeof contractSourceFinal.contract === 'object') ? contractSourceFinal.contract : {};
const repairSource = repairedContractSource ? 'self_repair' : 'primary';

const ctx = safeNode('Normalize & Validate');
const clinicRow = safeNode('Get Clinic Context');
const ownership = safeNode('Validate Patient Ownership');
const canonical = (ownership.canonical_time_context && typeof ownership.canonical_time_context === 'object') ? ownership.canonical_time_context : {};
const stateRow = safeNode('Get Conversation State');
const state = (stateRow.state_data && typeof stateRow.state_data === 'object') ? stateRow.state_data : {};
const applyResolved = safeNode('Apply Resolved Booking IDs (Deterministic)');
const resolved = {
  doctor_id: applyResolved.doctor_id || null,
  doctor_name: applyResolved.doctor_name || null,
  service_id: applyResolved.service_id || null,
  service_name: applyResolved.service_name || null,
  appointment_id: applyResolved.appointment_id || null,
  booking_number: applyResolved.booking_number || null,
  expected_old_slot_id: applyResolved.expected_old_slot_id || null,
  new_slot_id: applyResolved.new_slot_id || null,
  branch_id: applyResolved.branch_id || null,
  doctor_match_count: (applyResolved.resolver_result && applyResolved.resolver_result.doctor_match_count != null) ? applyResolved.resolver_result.doctor_match_count : null
};
const lookup = ($json.deterministic_slot_lookup && typeof $json.deterministic_slot_lookup === 'object' && $json.deterministic_slot_lookup.executed === true)
  ? $json.deterministic_slot_lookup : null;

const isValidTimezone = (value) => {
  const timezone = String(value ?? '').trim();
  if (!timezone) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()); return true; } catch (_) { return false; }
};
const timezoneOk = canonical.timezone_configured === true && !canonical.timezone_error_code && isValidTimezone(canonical.timezone)
  && typeof canonical.now_iso === 'string' && Number.isFinite(Date.parse(canonical.now_iso));

const normalization = (contractSourceFinal._normalization && typeof contractSourceFinal._normalization === 'object') ? contractSourceFinal._normalization : ($json._normalization || {});
const turnLineage = (normalization.turn_lineage && typeof normalization.turn_lineage === 'object') ? normalization.turn_lineage : {};

const clinic = {
  clinic_id: ctx.clinic_id || null,
  patient_id: ctx.patient_id || null,
  conversation_id: ctx.conversation_id || null,
  timezone: canonical.timezone || null,
  timezone_configured: timezoneOk,
  now_local_date: canonical.now_local_date || null,
  now_iso: canonical.now_iso || null,
  utc_offset: canonical.utc_offset || null,
  doctor_count: Number(clinicRow.doctor_count || 0),
  single_doctor_id: clinicRow.single_doctor_id || null,
  single_doctor_name: clinicRow.single_doctor_name || null
};
const lineage = {
  message_id: turnLineage.message_id || ctx.message_id || null,
  idempotency_key: ctx.idempotency_key || null,
  operation_id: ctx.operation_id || $json.operation_id || null,
  turn_key: turnLineage.turn_key || null,
  turn_id: turnLineage.turn_id || null,
  message_fingerprint: turnLineage.message_fingerprint || null
};

// ── Deterministic patient fields (P1.7 format extraction) override model entities ──
const p17 = safeNode('P1.7 Patient Field Normalization');
const p17Det = {};
if (p17.p17_extracted_phone) p17Det.patient_phone = String(p17.p17_extracted_phone);
if (p17.p17_extracted_age !== undefined && p17.p17_extracted_age !== null) p17Det.patient_age = p17.p17_extracted_age;
if (p17.p17_extracted_address) p17Det.patient_address = String(p17.p17_extracted_address);
const contractV3Eff = Object.keys(p17Det).length
  ? { ...contractV3, entities: { ...(contractV3.entities || {}), ...p17Det } }
  : contractV3;

// ── The ONE decision point ──
const decisionResult = decide({ state, contract: contractV3Eff, clinic, resolved, lookup, lineage });
const decision = decisionResult.system_decision;
const patches = decisionResult.state_patches;

// ── Legacy-compatible derivation (consumers: persistence, response policy) ──
const action = decision.action && decision.action !== 'none' ? decision.action : null;
const missing = Array.isArray(decision.missing_fields) ? decision.missing_fields : [];
const nextBestMissingHumanField = decision.next_best_missing_human_field || null;
const createFlowEvidence = action === 'create_appointment'
  || String((contractV3.operation_proposal && contractV3.operation_proposal.type) || '') === 'create_appointment'
  || String((contractV2.operation_proposal && contractV2.operation_proposal.type) || '') === 'create_appointment'
  || String(state.active_operation || state.operation_action || '') === 'create_appointment'
  || missing.some((f) => ['doctor', 'visit_type', 'patient_name', 'patient_age', 'patient_phone', 'patient_address', 'date'].includes(String(f)));
const effectiveAction = action || (createFlowEvidence ? 'create_appointment' : null);
const conversationStage = (() => {
  const code = String(decision.response_code || '').toUpperCase();
  if (code === 'HANDOFF_REQUIRED') return 'HANDOFF_REQUIRED';
  if (['PROVIDER_UNAVAILABLE', 'INVALID_JSON'].includes(code)) return 'ERROR_RETRYABLE';
  if (code === 'PATIENT_DATA_CONFIRMATION_REQUIRED') return 'WAITING_PATIENT_DATA_CONFIRMATION';
  if (code === 'CONFIRMATION_REQUIRED' || code === 'CONFIDENCE_REVIEW_REQUIRED' || decision.confirmation_state === 'required') return 'WAITING_BOOKING_CONFIRMATION';
  if (code === 'AVAILABILITY_LOOKUP_REQUIRED' || code === 'SLOT_LOOKUP_REQUIRED') return 'WAITING_AVAILABILITY';
  if (code === 'MISSING_REQUIRED_FIELDS') return effectiveAction === 'create_appointment' ? (missing.some((f) => String(f).startsWith('patient_')) ? 'COLLECTING_PATIENT_DATA' : 'COLLECTING_APPOINTMENT_DETAILS') : 'COLLECTING_REQUIRED_FIELDS';
  if (['EXECUTE_APPROVED', 'CANCEL_APPROVED', 'RESCHEDULE_APPROVED'].includes(code)) return 'EXECUTING';
  if (['APPOINTMENT_CREATED', 'CANCEL_COMPLETED', 'RESCHEDULE_COMPLETED', 'IDEMPOTENT_REPLAY'].includes(code)) return 'COMPLETED';
  if (decision.new_booking_restart === true) return 'COLLECTING_APPOINTMENT_DETAILS';
  return 'CONVERSATION';
})();
const requiredNextStep = (() => {
  if (conversationStage === 'WAITING_PATIENT_DATA_CONFIRMATION') return { type: 'confirm_patient_data', fields: ['name', 'phone', 'age', 'address'] };
  if (conversationStage === 'WAITING_BOOKING_CONFIRMATION') return { type: 'confirm_booking', action: (decision.confirmation_target && decision.confirmation_target.action) || action || 'create_appointment' };
  if (conversationStage === 'WAITING_AVAILABILITY') return { type: 'check_availability' };
  if (conversationStage === 'COLLECTING_PATIENT_DATA') return { type: 'collect_patient_data', fields: ['name', 'phone', 'age', 'address'], field: nextBestMissingHumanField };
  if (conversationStage === 'COLLECTING_APPOINTMENT_DETAILS') return { type: 'collect_appointment_details', field: nextBestMissingHumanField };
  if (conversationStage === 'HANDOFF_REQUIRED') return { type: 'escalate' };
  return { type: 'answer_current_message' };
})();
decision.conversation_stage = conversationStage;
decision.required_next_step = requiredNextStep;

const v3Intent = String((contractV3.turn && contractV3.turn.intent) || '').toLowerCase();
decision.intent = v3Intent === 'clinic_query' ? 'faq' : (v3Intent || 'other');
decision.proposed_action = action || 'none';
decision.contract = contractV2;
decision.query = contractV2.query || null;
decision.availability_inquiry = decision.availability_inquiry === true;
decision.review_pending = Boolean(patches.patient_data_review && String(patches.patient_data_review.status || '').toLowerCase() === 'pending_confirmation');
decision.target_veto_reasons = decisionResult.veto_reasons;
decision.operation = action || null;

// Operation lifecycle compatibility fields.
const priorOperationAction = String(state.active_operation || state.operation_action || '').trim().toLowerCase() || null;
const code = String(decision.response_code || '').toUpperCase();
decision.active_operation = action || (['EXECUTE_APPROVED', 'CANCEL_APPROVED', 'RESCHEDULE_APPROVED'].includes(code) ? priorOperationAction : null);
decision.operation_action = decision.active_operation;
decision.operation_status = code === 'CONFIRMATION_REQUIRED' ? 'awaiting_confirmation'
  : ['EXECUTE_APPROVED', 'CANCEL_APPROVED', 'RESCHEDULE_APPROVED'].includes(code) ? 'executing'
  : ['APPOINTMENT_CREATED', 'RESCHEDULE_COMPLETED'].includes(code) ? 'completed'
  : code === 'CANCEL_COMPLETED' ? 'cancelled'
  : (state.operation_status || null);

// ── Canonical booking context + slot state ──
const bc = patches.booking_context || {};
const ent3 = (contractV3.entities && typeof contractV3.entities === 'object') ? contractV3.entities : {};
const keep = (v, old) => v !== null && v !== undefined && String(v).trim() !== '' ? v : (old ?? null);
const target = decision.confirmation_target && typeof decision.confirmation_target === 'object' ? decision.confirmation_target : null;
const bookingContext = {
  doctor_id: bc.doctor_id || (target && target.doctor_id) || resolved.doctor_id || null,
  doctor_name: keep(bc.doctor_name, (target && target.doctor_name) || resolved.doctor_name || ent3.doctor_name),
  service_id: bc.service_id || (target && target.service_id) || resolved.service_id || null,
  service_name: keep(bc.service_name, (target && target.service_name) || resolved.service_name || ent3.service_name),
  appointment_type: bc.appointment_type || (target && target.appointment_type) || ent3.visit_type || null,
  slot_id: (target && target.slot_id) || bc.slot_id || null,
  date: (target && target.date) || bc.date || null,
  time: (target && target.time) || bc.time || null,
  booking_number: bc.booking_number || resolved.booking_number || null,
  patient_name: keep(bc.patient_name, ent3.patient_name),
  patient_phone: keep(bc.patient_phone, ent3.patient_phone),
  patient_age: (bc.patient_age ?? ent3.patient_age) ?? null,
  patient_address: keep(bc.patient_address, ent3.patient_address),
  references_prior_conversation: contractV3.references_prior_conversation === true
};
const slotState = {
  doctor_id: bookingContext.doctor_id,
  doctor_name: bookingContext.doctor_name,
  service_id: bookingContext.service_id,
  service_name: bookingContext.service_name,
  appointment_type: bookingContext.appointment_type,
  date: bookingContext.date,
  time: bookingContext.time,
  slot_id: bookingContext.slot_id,
  booking_number: bookingContext.booking_number
};

// ── Output envelope ──
const resultJson = {
  ...$json,
  contract: contractV2,
  contract_v3: contractV3,
  system_decision: decision,
  booking_context: bookingContext,
  slot_state: slotState,
  presented_offer: patches.presented_offer || null,
  pending_offer: patches.presented_offer || null,
  confirmation_target: decision.confirmation_target || null,
  confirmation_state: decision.confirmation_state || null,
  active_operation: decision.active_operation || null,
  operation_action: decision.operation_action || null,
  operation_status: decision.operation_status || null,
  operation_id: (target && target.operation_id) || lineage.operation_id || null,
  availability_outcome: $json.availability_outcome || (lookup && lookup.availability_outcome) || null,
  availability_alternatives: Array.isArray($json.availability_alternatives) ? $json.availability_alternatives : (lookup && Array.isArray(lookup.alternatives) ? lookup.alternatives : []),
  deterministic_slot_lookup: decision.deterministic_slot_lookup || null,
  patient_data_review: patches.patient_data_review || null,
  turn_directive: decision.turn_directive || null,
  state_machine: decision.state_machine || null,
  state_patches: patches,
  new_booking_restart: decision.new_booking_restart === true,
  escalation_requested: decision.escalation_requested === true,
  handoff_reason: decision.handoff_reason || null,
  response_code: decision.response_code,
  decision_engine: 'k2.state_table.v3',
  engine_version: 'k2.v3',
  decision_engine_source: repairSource,
  agent_context: {
    active_operation: decision.active_operation || null,
    operation_status: decision.operation_status || null,
    confirmation_state: decision.confirmation_state || null,
    confirmation_target: decision.confirmation_target || null,
    conversation_state: conversationStage,
    pending_action: requiredNextStep && requiredNextStep.type !== 'answer_current_message' ? requiredNextStep.type : null,
    last_open_question: {
      message: null,
      requested_fields: missing.slice(),
      type: code === 'MISSING_REQUIRED_FIELDS' ? 'missing_field' : (code === 'CONFIRMATION_REQUIRED' ? 'confirmation' : null),
      pending_action: requiredNextStep ? requiredNextStep.type : null
    },
    conversation_stage: conversationStage,
    required_next_step: requiredNextStep,
    booking_context: bookingContext
  }
};

return [{ json: resultJson }];
