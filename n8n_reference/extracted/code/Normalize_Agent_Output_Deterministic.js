// NAO v3 — k2.dialogue.v3 parser/validator + deterministic legacy bridge.
// Rules: the deterministic layer validates FORMAT only (enums, ISO dates, E.164
// phones, ages, UUIDs). It NEVER reads message_text for semantic decisions and
// never infers meaning from text. Semantic regexes are forbidden here.
const safeNode = (name) => { try { const f = $(name).first(); return (f && f.json) || {}; } catch (_) { return {}; } };

const ctx = safeNode('Normalize & Validate');
const state = safeNode('Get Conversation State').state_data || {};
const clinicRow = safeNode('Get Clinic Context');
const ownership = safeNode('Validate Patient Ownership');
const personaCtx = safeNode('Build Clinic Persona Context (Deterministic)');

const rawOutput = String($json.text ?? $json.raw_output ?? $json.output ?? $json.response ?? '').trim();

// ── JSON extraction (robust parser; no semantics) ──
const extract = (text) => {
  if (text && typeof text === 'object' && !Array.isArray(text)) return text;
  if (text === null || text === undefined) return null;
  let t = String(text).trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) t = fenced[1].trim();
  const candidates = [];
  const parseAt = (start) => {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const value = JSON.parse(t.slice(start, i + 1));
            if (value && typeof value === 'object' && !Array.isArray(value)) return { value, end: i };
          } catch (_) {}
          return null;
        }
      }
    }
    return null;
  };
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '{') continue;
    const parsedCandidate = parseAt(i);
    if (parsedCandidate) { candidates.push(parsedCandidate.value); i = parsedCandidate.end; }
  }
  if (!candidates.length) return null;
  return candidates[candidates.length - 1];
};

// ── Model-call failure detection (transport errors only) ──
const agentCallFailed = Boolean($json && ($json.error || $json.errorMessage || Number($json.statusCode) >= 400));

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
function validateContract(raw, ctx) {
  ctx = ctx || {};
  const errors = [];
  const warnings = [];
  let c = raw;
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch (e) { c = null; }
    if (!c || typeof c !== 'object') errors.push('contract_unparseable');
  }
  if (!c || typeof c !== 'object') {
    return { valid: false, errors: errors.length ? errors : ['contract_missing'], warnings, contract: null };
  }
  const out = { schema_version: SCHEMA_VERSION, phase: 'understand', reply: cleanStr(c.reply) };
  // P41 CLAIM-GUARD: an understand-phase reply may never claim a completed
  // booking/confirmation — execution truth belongs to the deterministic layers.
  // Observed live: contract intent=unclear with reply "نثبت لك الموعد" reached the patient.
  const CLAIM_RE = /(نثبت|ثبت)\s*(?:لك)?\s*(?:الموعد|الحجز)|تم\s+(?:الحجز|التثبيت|تأكيد\s*الحجز)|اتأكد\s*(?:الحجز)?|اتسجل\s*(?:الحجز|لك)/;
  const claimSanitize = (text) => String(text || '').replace(/^\s*هل/, (h) => h).replace(CLAIM_RE, (m, ...rest) => {
    const str = rest[rest.length - 1];
    const off = rest[rest.length - 2];
    const before = str.slice(Math.max(0, off - 10), off);
    return /(?:مش|ما\s|مفيش|لن|لما|غير)(?:[\sه]{1,2})?$/.test(before) ? m : 'تمام';
  }).replace(/\s{2,}/g, ' ').trim();
  if (typeof out.reply === 'string' && !/^\s*هل/.test(out.reply) && CLAIM_RE.test(out.reply)) {
    const sanitized = claimSanitize(out.reply);
    if (sanitized !== out.reply) {
      out.reply = sanitized;
      warnings.push('reply_claim_sanitized');
    }
  }
  const inEnum = (value, list, fallback) => {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    if (!v) return fallback;
    if (list.indexOf(v) !== -1) return v;
    warnings.push('enum_repaired:' + v);
    return fallback;
  };

  const turn = c.turn && typeof c.turn === 'object' ? c.turn : {};
  const intent = inEnum(turn.intent, TURN_INTENTS, 'unclear');
  if (intent === 'unclear' && String(turn.intent || '').trim() !== '' && TURN_INTENTS.indexOf(String(turn.intent || '').trim().toLowerCase()) === -1) {
    warnings.push('turn_intent_repaired');
  }
  const confidence = Number.isFinite(Number(turn.confidence)) ? Math.max(0, Math.min(1, Number(turn.confidence))) : null;
  out.turn = {
    intent,
    relation_to_previous_turn: inEnum(turn.relation_to_previous_turn, RELATIONS, 'none'),
    certainty: inEnum(turn.certainty, CERTAINTIES, 'uncertain'),
    confidence
  };

  const conf = c.confirmation && typeof c.confirmation === 'object' ? c.confirmation : {};
  out.confirmation = { intent: inEnum(conf.intent, CONFIRMATION_INTENTS, 'none') };

  const sel = c.selection && typeof c.selection === 'object' ? c.selection : {};
  const selKind = inEnum(sel.kind, SELECTION_KINDS, 'none');
  let selRank = Number(sel.rank);
  selRank = Number.isInteger(selRank) && selRank >= 1 && selRank <= 4 ? selRank : null;
  const selDate = isoDateValid(sel.date) ? String(sel.date) : (sel.date ? (warnings.push('selection_date_invalid'), null) : null);
  const selTime = normalizeTime(sel.time) || (sel.time ? (warnings.push('selection_time_invalid'), null) : null);
  out.selection = { kind: selKind, rank: selRank, date: selDate, time: selTime };
  if (selKind !== 'none' && selKind !== 'any' && !selRank && !selDate && !selTime && !sel.time && !sel.date) {
    warnings.push('selection_without_anchor');
  }

  const ent = c.entities && typeof c.entities === 'object' ? c.entities : {};
  let entDate = cleanStr(ent.date);
  if (entDate && !dateWithinHorizon(entDate, ctx.now_local_date, ctx.date_horizon_days || 60)) {
    warnings.push('entities_date_out_of_horizon:' + entDate);
    entDate = null;
  }
  let entTime = normalizeTime(ent.time);
  if (!entTime && ent.time) warnings.push('entities_time_invalid');
  let age = ent.patient_age;
  if (age !== null && age !== undefined && age !== '') {
    const n = parseInt(toEnglishDigits(String(age)).replace(/[^\d]/g, ''), 10);
    age = Number.isFinite(n) && n >= 0 && n <= 130 ? n : (warnings.push('patient_age_out_of_range'), null);
  } else age = null;
  let phone = cleanStr(ent.patient_phone);
  if (phone) {
    const normalized = normalizePhone(phone, ctx.clinic_country_code || 'SA');
    if (normalized) phone = normalized; else { warnings.push('patient_phone_invalid'); phone = null; }
  }
  const visitType = (() => {
    const v = String(ent.visit_type || ent.appointment_type || '').trim().toUpperCase().replace(/\s+/g, '_');
    if (!v) return null;
    if (VISIT_TYPES.indexOf(v) !== -1) return v;
    warnings.push('visit_type_repaired:' + v);
    return null;
  })();
  const appointmentId = cleanStr(ent.appointment_id);
  out.entities = {
    doctor_name: cleanStr(ent.doctor_name),
    service_name: cleanStr(ent.service_name),
    date: entDate,
    time: entTime,
    visit_type: visitType,
    patient_name: cleanStr(ent.patient_name),
    patient_phone: phone,
    patient_age: age,
    patient_address: cleanStr(ent.patient_address),
    appointment_id: appointmentId && UUID_RE.test(appointmentId) ? appointmentId : (appointmentId ? (warnings.push('appointment_id_not_uuid'), null) : null),
    booking_number: cleanStr(ent.booking_number)
  };

  const op = c.operation_proposal && typeof c.operation_proposal === 'object' ? c.operation_proposal : {};
  out.operation_proposal = {
    type: inEnum(op.type, OPERATION_TYPES, ''),
    requested: op.requested === true
  };

  out.references_prior_conversation = c.references_prior_conversation === true;
  out.escalate = c.escalate === true;
  out.handoff_reason = cleanStr(c.handoff_reason);
  return { valid: errors.length === 0, errors, warnings, contract: out };
}

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

// ── Validator context: clinic-local calendar + country for format checks ──
const timeCtx = ownership.canonical_time_context && typeof ownership.canonical_time_context === 'object'
  ? ownership.canonical_time_context : (ctx.time_context && typeof ctx.time_context === 'object' ? ctx.time_context : {});
const nowLocalDate = /^\d{4}-\d{2}-\d{2}$/.test(String(timeCtx.now_local_date || ''))
  ? String(timeCtx.now_local_date) : new Date().toISOString().slice(0, 10);
const validatorCtx = {
  now_local_date: nowLocalDate,
  clinic_country_code: String(clinicRow.country_code || clinicRow.clinic_country_code || 'SA'),
  date_horizon_days: 60
};

// ── Context + lineage ──
const stableHash = (value) => {
  let hash = 2166136261;
  for (const ch of String(value ?? '')) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
const currentTurnId = String(ctx.message_id || ctx.source_event_id || ctx.idempotency_key || '').trim();
const currentTurnKey = [ctx.clinic_id, ctx.channel_key || `${ctx.channel_type}:${ctx.channel_id}`, ctx.conversation_id, currentTurnId].map((value) => String(value ?? '').trim()).join('|');
const currentMessageFingerprint = stableHash([ctx.message_text, ctx.message_id, ctx.source_event_id, ctx.received_at].map((value) => String(value ?? '')).join('|'));
const currentTurnLineage = {
  schema_version: 3,
  turn_id: currentTurnId || null,
  turn_key: currentTurnKey,
  message_id: ctx.message_id || null,
  source_event_id: ctx.source_event_id || null,
  conversation_id: ctx.conversation_id || null,
  message_fingerprint: currentMessageFingerprint,
  created_at: ctx.received_at || new Date().toISOString()
};

// ── Observability-only Arabic hygiene view (never used for decisions) ──
const normalizeArabicUserText = (value) => String(value ?? '')
  .normalize('NFKC')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ؤ/g, 'و')
  .replace(/ئ/g, 'ي')
  .replace(/ة/g, 'ه')
  .replace(/[ًٌٍَُِّْـ]/g, '')
  .replace(/[٠-٩]/g, (digit) => '٠١٢٣٤٥٦٧٨٩'.indexOf(digit))
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();
const normalizedMessage = normalizeArabicUserText(String(ctx.message_text || '').trim());

// ── Parse + validate (single validator, one repair attempt upstream) ──
const parsedDoc = extract(rawOutput);
// Deterministic day-word absorption (closed vocabulary → ISO). Absorbs model
// slips in the most fragile field before the validator, keeping format
// validation as the only gate. Never reads message_text.
const DAY_WORD_OFFSETS = [
  ['بعد بكرة', 2], ['بعد بكره', 2], ['بعد غد', 2],
  ['بكرة', 1], ['بكره', 1], ['غدا', 1], ['غدًا', 1],
  ['اليوم', 0]
];
const WEEKDAY_TARGETS = [['السبت', 6], ['الأحد', 0], ['الاحد', 0], ['الاثنين', 1], ['الثلاثاء', 2], ['الأربعاء', 3], ['الاربعاء', 3], ['الخميس', 4], ['الجمعة', 5]];
function absorbDayWordToIso(raw, nowIsoDate) {
  const s = String(raw || '').trim();
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(String(nowIsoDate || ''))) return null;
  const base = Date.parse(nowIsoDate + 'T00:00:00Z');
  if (!Number.isFinite(base)) return null;
  let delta = null;
  for (const pair of DAY_WORD_OFFSETS) { if (s.indexOf(pair[0]) >= 0) { delta = pair[1]; break; } }
  if (delta === null) {
    const baseWd = new Date(base).getUTCDay();
    for (const pair of WEEKDAY_TARGETS) { if (s.indexOf(pair[0]) >= 0) { delta = (pair[1] - baseWd + 7) % 7; break; } }
  }
  if (delta === null) return null;
  return new Date(base + delta * 86400000).toISOString().slice(0, 10);
}
if (parsedDoc && parsedDoc.entities && typeof parsedDoc.entities === 'object'
    && parsedDoc.entities.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(parsedDoc.entities.date))) {
  const absorbedDate = absorbDayWordToIso(parsedDoc.entities.date, validatorCtx.now_local_date);
  if (absorbedDate) parsedDoc.entities.date = absorbedDate;
}
// P42b DETERMINISTIC OFFERED-SLOT RESCUE (hotfixed per regression team):
// - null-safe on parsedDoc (RG-1: unparseable output must not crash the node)
// - intent + negation/question gates (RG-2: 'لا مش الساعه 9' / 'هل يوجد...' never bind)
// - day-aware matching (RG-7: prefer alternatives matching entities.date)
// Fires ONLY on an exact time/rank match against the closed offered set.
const rescueOffer = (state.presented_offer && typeof state.presented_offer === 'object' && Array.isArray(state.presented_offer.alternatives)) ? state.presented_offer : null;
const rescueExpiry = rescueOffer ? Date.parse(String(rescueOffer.expires_at || '')) : NaN;
const rescueLive = Boolean(rescueOffer && Number.isFinite(rescueExpiry) && rescueExpiry > Date.now());
const rescueDocOk = parsedDoc && typeof parsedDoc === 'object';
const rescueIntent = rescueDocOk && parsedDoc.turn && typeof parsedDoc.turn === 'object' ? String(parsedDoc.turn.intent || 'unclear') : 'unclear';
const rescueConf = rescueDocOk && parsedDoc.confirmation && typeof parsedDoc.confirmation === 'object' ? String(parsedDoc.confirmation.intent || 'none') : 'none';
const rescueSel = rescueDocOk && parsedDoc.selection && typeof parsedDoc.selection === 'object' ? parsedDoc.selection : null;
const rescueNegated = /^(?:ل[آا]?|مش|مفيش|لن|لما|ما\s|هل|فيه|يوجد)/.test(String(normalizedMessage || '').trim());
const rescueNeeded = rescueLive && rescueDocOk
  && ['unclear', 'booking_continuation'].includes(rescueIntent)
  && !['negative', 'question'].includes(rescueConf)
  && !rescueNegated
  && (!rescueSel || String(rescueSel.kind || 'none') === 'none');
if (rescueNeeded && normalizedMessage) {
  const altsAll = rescueOffer.alternatives;
  const wantDate = (parsedDoc.entities && typeof parsedDoc.entities === 'object' && parsedDoc.entities.date) ? String(parsedDoc.entities.date).slice(0, 10) : null;
  const dateFiltered = wantDate ? altsAll.filter((a) => String(a.local_date || a.date || '').slice(0, 10) === wantDate) : [];
  // P42b (RG-7): if the patient named a day that none of the offered slots match,
  // do NOT fall back to binding a different day — no rescue.
  const alts = dateFiltered.length ? dateFiltered : (wantDate ? [] : altsAll);
  const mTime = normalizedMessage.match(/(?:الساعه|ساعه|الساعة)\s*(\d{1,2})(?::(\d{2}))?\s*((?:صباحا|صباح|مساء|ص|م)(?=\s|$|[.,!؟]))?/);
  const mRank = normalizedMessage.match(/(?:الاختيار|الخيار)\s*(?:رقم)?\s*(\d)/);
  let rescueAlt = null;
  if (mTime) {
    const negBefore = /(?:مش|غير|بدون|لا)\s*$/.test(normalizedMessage.slice(Math.max(0, mTime.index - 10), mTime.index));
    if (!negBefore) {
      let rHh = parseInt(mTime[1], 10);
      const rMm = mTime[2] ? String(mTime[2]) : '00';
      const isPm = /^(م|مساء)/.test(String(mTime[3] || ''));
      const isAm = /^(ص|صباح)/.test(String(mTime[3] || ''));
      if (isPm && rHh < 12) rHh += 12;
      if (isAm && rHh === 12) rHh = 0;
      if (rHh >= 0 && rHh <= 23) {
        const rHhmm = String(rHh).padStart(2, '0') + ':' + rMm;
        rescueAlt = alts.find((a) => String(a.local_time || a.time || '').slice(0, 5) === rHhmm) || null;
      }
    }
  }
  if (!rescueAlt && mRank) {
    const rRank = parseInt(mRank[1], 10);
    if (rRank >= 1 && rRank <= alts.length) rescueAlt = alts[rRank - 1] || null;
  }
  if (rescueAlt && (rescueAlt.slot_id || rescueAlt.local_date || rescueAlt.date)) {
    parsedDoc.selection = { kind: 'presented_match', rank: null, date: String(rescueAlt.local_date || rescueAlt.date || '').slice(0, 10) || null, time: String(rescueAlt.local_time || rescueAlt.time || '').slice(0, 5) || null };
    if (parsedDoc.turn && typeof parsedDoc.turn === 'object' && String(parsedDoc.turn.intent || 'unclear') === 'unclear') {
      parsedDoc.turn.intent = 'booking_continuation';
    }
  }
}
const validation = agentCallFailed
  ? { valid: false, errors: ['MODEL_CALL_FAILED'], warnings: [], contract: null }
  : validateContract(parsedDoc, validatorCtx);
const repairRan = (() => { try { return Boolean($('Build Repair Prompt (Deterministic)').first().json); } catch (_) { return false; } })();
const structuralFailure = !agentCallFailed && !validation.valid;
const repairNeeded = structuralFailure && !repairRan;
const contractV3 = validation.contract;
const modelCallStatus = agentCallFailed ? 'MODEL_CALL_FAILED'
  : (validation.valid ? 'VALID' : (repairRan ? 'INVALID_AFTER_REPAIR' : 'INVALID_OR_INCOMPLETE_CONTRACT'));

// ── Contract-derived facts (never from message text) ──
const turnV3 = contractV3 ? contractV3.turn : null;
const turnIntentV3 = turnV3 ? String(turnV3.intent || 'unclear') : 'unclear';
const relationV3 = turnV3 ? String(turnV3.relation_to_previous_turn || 'none') : 'none';
const confirmationIntentV3 = contractV3 ? String(contractV3.confirmation.intent || 'none') : 'none';
const operationTypeV3 = contractV3 ? String(contractV3.operation_proposal.type || '') : '';
const operationRequested = contractV3 ? contractV3.operation_proposal.requested === true : false;
const referencesPriorConversation = contractV3 ? contractV3.references_prior_conversation === true : false;
const escalationRequested = contractV3 ? contractV3.escalate === true : false;
const handoffReason = contractV3 ? (String(contractV3.handoff_reason || '').trim() || null) : null;
const cls = contractV3 ? messageClass(contractV3, state) : 'unclear';
const availabilityInquiry = cls === 'availability_inquiry';

// ── Temporal-claim guard (patient-safety, stage-driven, not text-driven) ──
const currentPreAgentStage = (() => {
  try { return $('Build Clinic Persona Context (Deterministic)').first().json.pre_agent_stage_contract || null; } catch (_) { return null; }
})();
const temporalClaimGuardActive = currentPreAgentStage?.type === 'confirm_patient_data' && currentPreAgentStage.date_allowed === false;
const sanitizeUnsupportedTemporalClaims = (value) => {
  const raw = String(value ?? '');
  if (!temporalClaimGuardActive) return raw.trim();
  return raw
    .replace(/\b(?:اليوم|بكره|بكرة|غدا|غدًا|بعد بكره|بعد بكرة|بعد غد|باچر|السبت|الاحد|الأحد|الاثنين|الثلاثاء|الاربعاء|الأربعاء|الخميس|الجمعة)\b/giu, '')
    .replace(/الساعة\s+\d{1,2}(?::\d{2})?\s*(?:صباحا|صباحًا|مساء|مساءً|ص|م)?/giu, '')
    .replace(/\b\d{1,2}:\d{2}\b/gu, '')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
};
const extractedReply = contractV3 && contractV3.reply
  ? (sanitizeUnsupportedTemporalClaims(String(contractV3.reply)) || null)
  : null;

// ── Entities for plumbing (IDs resolve later via Resolve Booking IDs) ──
const entV3 = contractV3 ? contractV3.entities : {};
const cleanEntities = {
  doctor_name: entV3.doctor_name ?? null,
  doctor_id: null,
  service_name: entV3.service_name ?? null,
  service_id: null,
  appointment_type: entV3.visit_type ?? null,
  date: entV3.date ?? null,
  time: entV3.time ?? null,
  slot_id: null,
  branch_id: null,
  branch_name: null,
  appointment_id: entV3.appointment_id ?? null,
  booking_number: entV3.booking_number ?? null,
  patient_name: entV3.patient_name ?? null,
  patient_phone: entV3.patient_phone ?? null,
  patient_age: entV3.patient_age ?? null,
  patient_address: entV3.patient_address ?? null,
  references_prior_conversation: referencesPriorConversation
};
const invalidDateInput = validation.warnings.some((w) => String(w).indexOf('entities_date_out_of_horizon') === 0);
const invalidTimeInput = validation.warnings.some((w) => String(w) === 'entities_time_invalid');

// ── Booking context management (deterministic merge, kept for the legacy bridge) ──
const priorActivityMs0 = Date.parse(state.last_updated || state.updated_at || state.last_message_at || '');
const currentActivityMs0 = Date.parse(String(ctx.received_at || '') || new Date().toISOString());
const sessionContextStale = Number.isFinite(priorActivityMs0) && Number.isFinite(currentActivityMs0)
  && currentActivityMs0 - priorActivityMs0 >= 2 * 60 * 60 * 1000;
const sessionContextUsable = !sessionContextStale || referencesPriorConversation === true;
const priorSlot = sessionContextUsable ? (state.slot_state && typeof state.slot_state === 'object' ? state.slot_state : {}) : {};
const priorContext = sessionContextUsable ? (state.booking_context && typeof state.booking_context === 'object' ? state.booking_context : {}) : {};
const statePatientFacts = (state.facts && typeof state.facts === 'object' && state.facts.patient && typeof state.facts.patient === 'object') ? state.facts.patient : {};
const keep = (v, old) => v !== undefined && v !== null && String(v) !== '' ? v : (old ?? null);

const priorOperationAction = String(state.active_operation || state.operation_action || '').trim().toLowerCase();
const priorOperationState = String(state.operation_state || state.operation_status || '').trim().toUpperCase();
const priorDraftExpiryMs = Date.parse(state.draft_expires_at || '');
const priorDraftExpired = Number.isFinite(priorDraftExpiryMs) && priorDraftExpiryMs <= currentActivityMs0;
const priorCreateIsLive = priorOperationAction === 'create_appointment'
  && !['COMPLETED','CANCELLED','FAILED_FINAL','IDLE'].includes(priorOperationState)
  && !(priorDraftExpired && ['DRAFT','COLLECTING_DETAILS','COLLECTING_APPOINTMENT_DETAILS',''].includes(priorOperationState));

const freshDoctorNameGiven = String(cleanEntities.doctor_name || '').trim() !== '';
const freshServiceNameGiven = String(cleanEntities.service_name || '').trim() !== '';
const slotState = {
  branch_id: keep(cleanEntities.branch_id, priorSlot.branch_id),
  branch_name: keep(cleanEntities.branch_name, priorSlot.branch_name),
  doctor_id: cleanEntities.doctor_id !== null && cleanEntities.doctor_id !== undefined ? cleanEntities.doctor_id : (freshDoctorNameGiven ? null : priorSlot.doctor_id),
  doctor_name: keep(cleanEntities.doctor_name, priorSlot.doctor_name),
  service_id: cleanEntities.service_id !== null && cleanEntities.service_id !== undefined ? cleanEntities.service_id : (freshServiceNameGiven ? null : priorSlot.service_id),
  service_name: keep(cleanEntities.service_name, priorSlot.service_name),
  appointment_type: cleanEntities.appointment_type !== null && cleanEntities.appointment_type !== undefined ? cleanEntities.appointment_type : priorSlot.appointment_type,
  date: keep(cleanEntities.date, priorSlot.date),
  time: keep(cleanEntities.time, priorSlot.time),
  slot_id: keep(cleanEntities.slot_id, priorSlot.slot_id)
};
const bookingContext = {
  branch_id: keep(cleanEntities.branch_id, priorContext.branch_id),
  branch_name: keep(cleanEntities.branch_name, priorContext.branch_name),
  doctor_id: cleanEntities.doctor_id !== null && cleanEntities.doctor_id !== undefined ? cleanEntities.doctor_id : (freshDoctorNameGiven ? null : priorContext.doctor_id),
  doctor_name: keep(cleanEntities.doctor_name, priorContext.doctor_name),
  service_id: cleanEntities.service_id !== null && cleanEntities.service_id !== undefined ? cleanEntities.service_id : (freshServiceNameGiven ? null : priorContext.service_id),
  service_name: keep(cleanEntities.service_name, priorContext.service_name),
  appointment_type: cleanEntities.appointment_type !== null && cleanEntities.appointment_type !== undefined ? cleanEntities.appointment_type : priorContext.appointment_type,
  slot_id: keep(cleanEntities.slot_id, priorContext.slot_id),
  date: keep(cleanEntities.date, priorContext.date),
  time: keep(cleanEntities.time, priorContext.time),
  patient_name: keep(cleanEntities.patient_name, priorContext.patient_name || statePatientFacts.name),
  patient_phone: keep(cleanEntities.patient_phone, priorContext.patient_phone || statePatientFacts.phone || statePatientFacts.mobile),
  patient_age: keep(cleanEntities.patient_age !== undefined ? cleanEntities.patient_age : null, priorContext.patient_age !== undefined ? priorContext.patient_age : (statePatientFacts.age !== undefined ? statePatientFacts.age : null)),
  patient_address: keep(cleanEntities.patient_address, priorContext.patient_address || statePatientFacts.address),
  references_prior_conversation: referencesPriorConversation
};

if (invalidDateInput || invalidTimeInput) {
  slotState.slot_id = null;
  bookingContext.slot_id = null;
}

// ── Error-followup recovery (state-driven; preserves doctor identity after a failed reply) ──
let errorFollowupRecovered = false;
const builderRecoveryForNormalize = personaCtx.error_followup_context && typeof personaCtx.error_followup_context === 'object' ? personaCtx.error_followup_context : {};
const normalizeClinicDoctors = Array.isArray(clinicRow.doctor_directory) ? clinicRow.doctor_directory : [];
const normalizeRecoveredDoctor = normalizeClinicDoctors.find((doctor) => String(doctor?.doctor_id || doctor?.id || '') === String(builderRecoveryForNormalize.doctor_id || '')) || null;
if (builderRecoveryForNormalize.active === true && builderRecoveryForNormalize.doctor_name && !freshDoctorNameGiven) {
  errorFollowupRecovered = true;
  cleanEntities.doctor_name = String(builderRecoveryForNormalize.doctor_name).trim();
  cleanEntities.doctor_id = builderRecoveryForNormalize.doctor_id || normalizeRecoveredDoctor?.doctor_id || normalizeRecoveredDoctor?.id || null;
  slotState.doctor_name = cleanEntities.doctor_name;
  slotState.doctor_id = cleanEntities.doctor_id || slotState.doctor_id || null;
  bookingContext.doctor_name = cleanEntities.doctor_name;
  bookingContext.doctor_id = cleanEntities.doctor_id || bookingContext.doctor_id || null;
  if (builderRecoveryForNormalize.appointment_type && !bookingContext.appointment_type) {
    cleanEntities.appointment_type = builderRecoveryForNormalize.appointment_type;
    slotState.appointment_type = builderRecoveryForNormalize.appointment_type;
    bookingContext.appointment_type = builderRecoveryForNormalize.appointment_type;
  }
}

// ── Fresh booking restart (contract-driven R1: intent + relation + live artifacts only) ──
const priorOfferRaw = state.presented_offer && typeof state.presented_offer === 'object'
  ? state.presented_offer : (state.pending_offer && typeof state.pending_offer === 'object' ? state.pending_offer : null);
const priorOfferLive = (() => {
  if (!priorOfferRaw) return false;
  const exp = Date.parse(String(priorOfferRaw.expires_at || ''));
  return Number.isFinite(exp) ? exp > currentActivityMs0 : false;
})();
const priorTargetRaw = state.confirmation_target && typeof state.confirmation_target === 'object' ? state.confirmation_target : null;
const priorTargetLive = (() => {
  if (!priorTargetRaw || priorTargetRaw.invalidated === true) return false;
  const status = String(priorTargetRaw.confirmation_delivery_status || priorTargetRaw.delivery || 'pending').toLowerCase();
  if (!['pending', 'sent', 'proposed'].includes(status)) return false;
  const exp = Date.parse(String(priorTargetRaw.expires_at || ''));
  return !Number.isFinite(exp) || exp > currentActivityMs0;
})();
const newBookingRestart = turnIntentV3 === 'booking_request'
  && relationV3 === 'new_request'
  && !referencesPriorConversation
  && !priorOfferLive
  && !priorTargetLive;

if (newBookingRestart) {
  for (const field of ['date', 'time', 'slot_id']) {
    slotState[field] = cleanEntities[field] || null;
    bookingContext[field] = cleanEntities[field] || null;
  }
  for (const field of ['doctor_id', 'doctor_name', 'service_id', 'service_name', 'appointment_type', 'date', 'time', 'slot_id']) {
    const currentValue = cleanEntities[field] || null;
    slotState[field] = currentValue;
    bookingContext[field] = currentValue;
  }
}

// ── Single-doctor lock (runs AFTER the restart wipe) ──
const clinicDoctorCount = Number(clinicRow.doctor_count || 0);
const singleDoctorId = String(clinicRow.single_doctor_id || '').trim() || null;
const singleDoctorName = String(clinicRow.single_doctor_name || '').trim() || null;
const doctorSelectionTurn = ['booking_request', 'booking_continuation', 'availability_inquiry'].includes(turnIntentV3);
const explicitDoctorInTurn = Boolean(cleanEntities.doctor_id || cleanEntities.doctor_name);
const doctorContextAlreadySet = Boolean(bookingContext.doctor_id || bookingContext.doctor_name);
const canAutoSelectSingleDoctor = clinicDoctorCount === 1
  && Boolean(singleDoctorId && singleDoctorName)
  && doctorSelectionTurn
  && !explicitDoctorInTurn
  && !doctorContextAlreadySet;
if (canAutoSelectSingleDoctor) {
  cleanEntities.doctor_id = singleDoctorId;
  cleanEntities.doctor_name = singleDoctorName;
  slotState.doctor_id = singleDoctorId;
  slotState.doctor_name = singleDoctorName;
  bookingContext.doctor_id = singleDoctorId;
  bookingContext.doctor_name = singleDoctorName;
}

// ── Canonical carry for continuation turns (state-driven) ──
const canonicalEntities = { ...cleanEntities };
const stateActivityMs = Date.parse(state.last_updated || state.updated_at || state.last_message_at || '');
const currentActivityMs = Date.parse(ctx.received_at || '') || Date.now();
const stateConversationFresh = Number.isFinite(stateActivityMs)
  ? currentActivityMs - stateActivityMs < 2 * 60 * 60 * 1000
  : Boolean(priorCreateIsLive);
const contextCarryAllowed = !newBookingRestart
  && stateConversationFresh
  && (confirmationIntentV3 === 'affirmative'
    || ['small_talk', 'greeting', 'booking_continuation', 'confirmation', 'correction', 'availability_inquiry'].includes(turnIntentV3)
    || operationRequested === false
    || ['answer', 'confirmation', 'follow_up'].includes(relationV3));
if (contextCarryAllowed) {
  for (const field of ['doctor_id', 'doctor_name', 'service_id', 'service_name', 'appointment_type', 'date', 'time', 'slot_id', 'branch_id', 'branch_name']) {
    if ((canonicalEntities[field] === null || canonicalEntities[field] === undefined || canonicalEntities[field] === '') && bookingContext[field]) {
      canonicalEntities[field] = bookingContext[field];
    }
  }
}

// ── Legacy v2 bridge projection (deterministic; consumed until Phase 3 replaces it) ──
const INTENT_TO_V2 = { booking_request: 'booking_request', booking_continuation: 'booking_continuation', availability_inquiry: 'availability_inquiry', cancellation_request: 'cancellation_request', reschedule_request: 'reschedule_request', confirmation: 'confirmation', correction: 'correction', small_talk: 'small_talk', greeting: 'small_talk', clinic_query: 'faq_inquiry', unclear: 'unclear', other: 'other' };
const RELATION_TO_V2 = { new_request: 'new_request', answer: 'answer', confirmation: 'confirmation', correction: 'correction', change_details: 'correction', follow_up: 'continuation', none: 'none', unclear: 'none' };
const CERTAINTY_TO_V2 = { certain: 'clear', probable: 'ambiguous', uncertain: 'uncertain' };
const ROUTING_BY_CLASS = { cancel_request: 'cancel', reschedule_request: 'reschedule', selection_presented: 'booking', confirmation_affirm: 'confirmation', confirmation_negative: 'confirmation', confirmation_question: 'confirmation', booking: 'booking', availability_inquiry: 'booking', correction: 'booking', small_talk: 'small_talk', clinic_query: 'faq', unclear: 'none' };
const v2Intent = INTENT_TO_V2[turnIntentV3] || 'unclear';
const v2Relation = RELATION_TO_V2[relationV3] || 'none';
const v2Certainty = CERTAINTY_TO_V2[turnV3 ? String(turnV3.certainty || '') : ''] || 'uncertain';
const v2Routing = escalationRequested ? 'escalation' : (ROUTING_BY_CLASS[cls] || 'none');
const confidenceRaw = Number(turnV3 ? turnV3.confidence : NaN);
const normalizedConfidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : null;

const personaClinicQueryType = String(personaCtx.clinic_query_type || '');
const projectedQuery = cls === 'clinic_query'
  ? { type: personaClinicQueryType === 'service_price' ? 'service_price' : (['doctor_catalog', 'doctor_fact'].includes(personaClinicQueryType) ? 'doctor_service' : 'faq') }
  : (cls === 'availability_inquiry' ? { type: 'availability', date: canonicalEntities.date || null, time: canonicalEntities.time || null } : null);
const queryScope = {
  type: projectedQuery?.type || null,
  date: projectedQuery?.date || null,
  time: projectedQuery?.time || null,
  resolution_status: (cls === 'availability_inquiry' && canonicalEntities.date) ? 'resolved' : 'unresolved',
  requires_resolution: false
};

const projectedNextStep = (() => {
  if (!contractV3) return { type: 'none', field: null };
  if (cls === 'confirmation_affirm') return { type: 'confirm_action', field: null };
  if (cls === 'availability_inquiry') return { type: 'show_availability', field: canonicalEntities.date ? null : 'date' };
  if (cls === 'clinic_query' || cls === 'small_talk') return { type: cls === 'clinic_query' ? 'provide_answer' : 'none', field: null };
  if (cls === 'cancel_request' || cls === 'reschedule_request') return { type: canonicalEntities.appointment_id || canonicalEntities.booking_number ? 'confirm_action' : 'ask_for_missing_information', field: canonicalEntities.appointment_id || canonicalEntities.booking_number ? null : 'booking_number' };
  if (cls === 'booking' || cls === 'selection_presented') {
    if (!bookingContext.appointment_type) return { type: 'ask_for_missing_information', field: 'appointment_type' };
    for (const field of ['patient_name', 'patient_age', 'patient_phone', 'patient_address']) {
      const value = bookingContext[field];
      if (value === null || value === undefined || String(value).trim() === '') return { type: 'ask_for_missing_information', field };
    }
    if (!bookingContext.date) return { type: 'ask_for_missing_information', field: 'date' };
    return { type: 'show_availability', field: null };
  }
  return { type: 'none', field: null };
})();

const fallbackV3 = {
  schema_version: 'k2.dialogue.v3',
  phase: 'understand',
  reply: null,
  turn: { intent: 'unclear', relation_to_previous_turn: 'none', certainty: 'uncertain', confidence: null },
  confirmation: { intent: 'none' },
  selection: { kind: 'none', rank: null, date: null, time: null },
  entities: { doctor_name: null, service_name: null, date: null, time: null, visit_type: null, patient_name: null, patient_phone: null, patient_age: null, patient_address: null, appointment_id: null, booking_number: null },
  operation_proposal: { type: '', requested: false },
  references_prior_conversation: false,
  escalate: false,
  handoff_reason: null
};

const outputContract = {
  schema_version: 'k2.dialogue.v2',
  turn: { intent: v2Intent, relation_to_previous_turn: v2Relation, certainty: v2Certainty, confidence: normalizedConfidence, answer_to: null },
  operation_proposal: { type: operationTypeV3, requested: operationRequested },
  routing: { target: v2Routing },
  entities: canonicalEntities,
  query: projectedQuery,
  confirmation: { intent: confirmationIntentV3, target_operation: operationTypeV3 || null },
  next_step: projectedNextStep
};

const effectiveModelCallStatus = errorFollowupRecovered ? 'ERROR_FOLLOWUP_RECOVERED' : modelCallStatus;

return [{
  json: {
    temporal_claim_guard_active: temporalClaimGuardActive,
    ...$json,
    agent_reply: extractedReply,
    agent_raw_output: rawOutput,
    contract: outputContract,
    contract_v3: contractV3 || fallbackV3,
    slot_state: slotState,
    booking_context: bookingContext,
    new_booking_restart: newBookingRestart,
    availability_inquiry: availabilityInquiry,
    model_call_failed: agentCallFailed,
    model_call_status: effectiveModelCallStatus,
    error_followup_recovered: errorFollowupRecovered,
    escalation_requested: escalationRequested,
    handoff_reason: handoffReason,
    _contract_status: agentCallFailed ? 'MODEL_CALL_FAILED' : (validation.valid ? 'VALID' : (repairRan ? 'INVALID_AFTER_REPAIR' : 'REPAIR_NEEDED')),
    _contract_errors: validation.errors,
    _contract_warnings: validation.warnings,
    _contract_repair_needed: repairNeeded,
    _repair_source: repairRan ? 'self_repair' : 'primary',
    _normalization: {
      schema_version: 'k2.dialogue.v3',
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      certainty: v2Certainty,
      confidence: normalizedConfidence,
      turn_intent: v2Intent,
      relation_to_previous_turn: v2Relation,
      confirmation_intent: confirmationIntentV3,
      operation_type: operationTypeV3,
      operation_requested: operationRequested,
      routing_target: v2Routing,
      next_step_type: projectedNextStep.type,
      next_step_field: projectedNextStep.field,
      message_class: cls,
      model_turn_intent: turnIntentV3,
      model_relation: relationV3,
      invalid_temporal_input: invalidDateInput || invalidTimeInput,
      invalid_temporal_fields: [invalidDateInput ? 'date' : null, invalidTimeInput ? 'time' : null].filter(Boolean),
      new_booking_restart: newBookingRestart,
      escalation: escalationRequested,
      booking_signal: ['booking_request', 'booking_continuation'].includes(turnIntentV3),
      query_is_faq: projectedQuery?.type === 'faq',
      query_is_price: projectedQuery?.type === 'service_price',
      query_is_availability: availabilityInquiry,
      query_is_doctor_service: projectedQuery?.type === 'doctor_service',
      query_scope: queryScope,
      turn_lineage: currentTurnLineage,
      normalized_language_views: { arabic: normalizedMessage },
      model_call_failed: agentCallFailed,
      model_call_status: effectiveModelCallStatus,
      repair_attempted: repairRan,
      repair_needed: repairNeeded
    }
  }
}];
