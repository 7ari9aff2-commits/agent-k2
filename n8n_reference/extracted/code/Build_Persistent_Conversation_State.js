

// Audit fix: null-safe helper for $('Node').first().json
const safeNode = (name) => { try { const f = $(name).first(); return (f && f.json) || {}; } catch (_) { return {}; } };
const safeNodeData = (name) => { try { const f = $(name).first(); return (f && f.json) || null; } catch (_) { return null; } };

function mintUuid(seed) {
    const s = String(seed || '').trim();
    let h1 = 0, h2 = 0;
    for (let i = 0; i < s.length; i++) {
      h1 = ((h1 << 5) - h1 + s.charCodeAt(i)) | 0;
      h2 = ((h2 << 7) - h2 + s.charCodeAt(i)) | 0;
    }
    const a = Math.abs(h1).toString(16).padStart(8, '0').slice(0, 8);
    const b = (Math.abs(h2).toString(16) + '00000000').slice(0, 8).slice(0, 4);
    const c = Math.abs((h1 ^ h2) & 0x0fff).toString(16).padStart(4, '0').slice(0, 4);
    const d = ('a' + (Math.abs(h1 + h2) % 0x4000).toString(16)).padEnd(4, '0').slice(0, 4);
    const e = (Math.abs(h1 * 31 + h2 * 17).toString(16) + '000000000000').slice(0, 12);
    return a + '-' + b + '-' + c + '-' + d + '-' + e;
  }
const ctx = safeNode('Normalize & Validate');
const clinic = $('Get Clinic Context').first().json || {};
const isTelegramChannel = String(ctx.channel_type || '').trim().toLowerCase() === 'telegram';
// Patient info from Orchestrator output (extracted by DeepSeek #1 from patient messages)
const orchOutput = (() => { try { return $('System Orchestrator (Policy)').first().json || {}; } catch(e) { return {}; } })();
// The Orchestrator publishes the authoritative resolved context under
// system_decision.booking_context. Prefer that same-turn context over stale or
// incomplete top-level fields carried by downstream nodes.
const orchDecision = (orchOutput.system_decision && typeof orchOutput.system_decision === 'object') ? orchOutput.system_decision : {};
const orchBookingContext = (orchOutput.booking_context && typeof orchOutput.booking_context === 'object')
  ? orchOutput.booking_context
  : ((orchDecision.booking_context && typeof orchDecision.booking_context === 'object') ? orchDecision.booking_context : {});
const orchPatient = orchBookingContext;
const orchPatientName = orchPatient.patient_name || null;
const orchPatientNameSource = orchPatient.patient_name_source || orchBookingContext.patient_name_source || null;
const orchPatientPhone = orchPatient.patient_phone || null;
const orchPatientAge = orchPatient.patient_age || null;
const orchPatientAddress = orchPatient.patient_address || null;
// Phase 3 (k2.state_table.v3): Decision Core publishes engine patches under
// top-level state_patches. Persist them so decide() rebuilds state next turn.
const orchStatePatches = (orchOutput.state_patches && typeof orchOutput.state_patches === 'object') ? orchOutput.state_patches : {};
const previous = (safeNode('Get Conversation State').state_data) || {};
const contextSessionReset = $json.context_session_reset === true;
// Resolve the child booking number before constructing facts.booking, which uses it.
// Keeping this declaration above all consumers prevents the live temporal-dead-zone error.
let executionBookingNumber = $json.booking_number || previous.booking_number || null;
const rawOutput = $json.output;
// FIX (2026-08-18): DeepSeek #1 sometimes wraps its JSON output in a markdown code fence
// (```json ... ```). JSON.parse then crashes the whole execution with SyntaxError,
// sending the patient a generic "error processing your request" reply. Handle both.
const output = (() => { try { if (!rawOutput) return {}; if (typeof rawOutput !== "string") return rawOutput && typeof rawOutput === "object" ? rawOutput : {}; let t = String(rawOutput).trim(); if (t.startsWith("```")) { const i = t.indexOf("\n"); t = i >= 0 ? t.slice(i + 1) : t; t = t.replace(/```\s*$/g, "").trim(); } return JSON.parse(t) || {}; } catch (e) { return {}; } })();
let upstreamDecision = {};
try { upstreamDecision = $('System Orchestrator (Policy)').first().json.system_decision || {}; } catch {}
const decision = $json.system_decision || upstreamDecision || {};
const abandonCurrentBooking = (decision.booking_draft_abandoned === true || output.booking_draft_abandoned === true || String(decision.response_code || $json.response_code || output.response_code || '').toUpperCase() === 'BOOKING_DRAFT_ABANDONED')
  && !$json.appointment_id
  && !output.appointment_id
  && !$json.booking_number
  && !output.booking_number;
const now = new Date();
const businessTimeNode = $json && typeof $json === 'object' ? $json : {};
const businessTimeChecked = decision.business_time_checked === true || businessTimeNode.business_time_checked === true;
const businessTimeStatus = decision.business_time_status || businessTimeNode.business_time_status || previous.business_time_status || 'NOT_CHECKED';
const businessTimeTimezone = decision.business_time_timezone || businessTimeNode.business_time_timezone || previous.business_time_timezone || null;
const businessTimeSource = decision.business_time_source || businessTimeNode.business_time_source || previous.business_time_source || null;
const businessTimeErrorCode = decision.business_time_error_code || businessTimeNode.business_time_error_code || previous.business_time_error_code || null;
const normalization = $json._normalization && typeof $json._normalization === 'object' ? $json._normalization : {};
const newBookingRestart = normalization.new_booking_restart === true || output.new_booking_restart === true || decision.new_booking_restart === true;
const priorDraftExpiryMs = Date.parse(previous.draft_expires_at || '');
const expiredPriorDraft = !newBookingRestart && Number.isFinite(priorDraftExpiryMs) && priorDraftExpiryMs <= now.getTime()
  && ['DRAFT','COLLECTING_DETAILS','COLLECTING_APPOINTMENT_DETAILS',''].includes(String(previous.operation_state || previous.operation_status || '').toUpperCase());
const supersededOperation = (newBookingRestart || expiredPriorDraft) && (previous.operation_id || previous.active_operation || previous.confirmation_target || previous.booking_context) ? { operation_id: previous.operation_id || previous.confirmation_target?.operation_id || null, active_operation: previous.active_operation || previous.operation_action || null, operation_state: previous.operation_state || previous.operation_status || null, confirmation_target: previous.confirmation_target || null, superseded_at: now.toISOString(), reason: expiredPriorDraft ? 'EXPIRED_DRAFT' : 'SUPERSEDED_BY_NEW_REQUEST' } : (previous.superseded_operation || null);
// Expiring a draft invalidates the pending date/time/slot operation, not the
// stable facts the patient already supplied (doctor, service, visit type).
// Preserve those stable facts so a later date message can still execute a
// deterministic availability lookup without asking for the doctor again.
// P-DATE-RETENTION-ROOTFIX: draft expiry invalidates the executable slot/confirmation,
// but preserves the patient's last explicit date/time as historical scheduling context.
// The next scheduling turn must still perform a fresh deterministic lookup; these are
// never treated as verified availability or as an executable slot.
const stablePreviousBooking = expiredPriorDraft ? {
  doctor_id: previous.booking_context?.doctor_id || null,
  doctor_name: previous.booking_context?.doctor_name || null,
  service_id: previous.booking_context?.service_id || null,
  service_name: previous.booking_context?.service_name || null,
  appointment_type: previous.booking_context?.appointment_type || null,
  date: previous.booking_context?.date || previous.slot_state?.date || previous.facts?.booking?.date || null,
  time: previous.booking_context?.time || previous.slot_state?.time || previous.facts?.booking?.time || null
} : {};
const previousSlot = (newBookingRestart || expiredPriorDraft) ? {} : (previous.slot_state || previous.booking_context || {});
const previousBookingFallback = newBookingRestart ? {} : (expiredPriorDraft ? stablePreviousBooking : (previous.booking_context || {}));
let currentSlot = output.slot_state || {};
try {
  const orchJson = $('System Orchestrator (Policy)').first().json || {};
  const orchResolved = (orchJson.system_decision && typeof orchJson.system_decision === 'object') ? orchJson.system_decision : {};
  const orchSlotContext = orchJson.slot_state || orchJson.booking_context || orchResolved.slot_state || orchResolved.booking_context || {};
  currentSlot = currentSlot.doctor_name ? currentSlot : (orchSlotContext || currentSlot);
} catch {}
let currentContext = output.booking_context || orchBookingContext || {};
try {
  const orchJson2 = safeNode('System Orchestrator (Policy)');
  const orchResolved2 = (orchJson2.system_decision && typeof orchJson2.system_decision === 'object') ? orchJson2.system_decision : {};
  const orchContext = orchJson2.booking_context || orchResolved2.booking_context || orchJson2.slot_state || orchResolved2.slot_state || {};
  // A context with a doctor is authoritative for this turn; do not replace it
  // with a downstream object that only contains patient or temporal fields.
  currentContext = currentContext.doctor_name || currentContext.doctor_id ? currentContext : (orchContext || currentContext);
} catch {}
// For a fresh booking, always take the current turn's normalized context from Orchestrator.
// Response/render nodes can carry a stale booking_context from the prior draft.
if (newBookingRestart) {
  try {
    const orchJson3 = safeNode('System Orchestrator (Policy)');
    const orchResolved3 = (orchJson3.system_decision && typeof orchJson3.system_decision === 'object') ? orchJson3.system_decision : {};
    const safeCurrent = (orchJson3.booking_context && typeof orchJson3.booking_context === 'object')
      ? orchJson3.booking_context
      : ((orchResolved3.booking_context && typeof orchResolved3.booking_context === 'object') ? orchResolved3.booking_context : {});
    currentContext = {
      doctor_id: safeCurrent.doctor_id || null,
      doctor_name: safeCurrent.doctor_name || null,
      service_id: safeCurrent.service_id || null,
      service_name: safeCurrent.service_name || null,
      appointment_type: safeCurrent.appointment_type || null,
      date: safeCurrent.date || null,
      time: safeCurrent.time || null,
      slot_id: safeCurrent.slot_id || null,
      booking_number: safeCurrent.booking_number || null
    };
  } catch {}
}
const currentTurnLineage = output.turn_lineage && typeof output.turn_lineage === 'object'
  ? output.turn_lineage
  : ($json.turn_lineage && typeof $json.turn_lineage === 'object' ? $json.turn_lineage : (normalization.turn_lineage && typeof normalization.turn_lineage === 'object' ? normalization.turn_lineage : {}));
const currentLookupLineage = output.availability_lineage && typeof output.availability_lineage === 'object'
  ? output.availability_lineage
  : (output.deterministic_slot_lookup?.lineage && typeof output.deterministic_slot_lookup.lineage === 'object'
    ? output.deterministic_slot_lookup.lineage
    : ($json.availability_lineage && typeof $json.availability_lineage === 'object' ? $json.availability_lineage : ($json.deterministic_slot_lookup?.lineage || {})));
const lookupMatchesCurrentTurn = Boolean(
  currentTurnLineage.turn_key
  && currentLookupLineage.turn_key
  && String(currentTurnLineage.turn_key) === String(currentLookupLineage.turn_key)
  && (currentLookupLineage.message_id || currentLookupLineage.turn_id)
);
// On a fresh booking, the incoming slot_state may still be the previous lookup result.
// Keep it only when deterministic lookup explicitly proves it belongs to this turn.
if (newBookingRestart && !lookupMatchesCurrentTurn) {
  currentSlot = {
    doctor_id: currentContext.doctor_id || null,
    doctor_name: currentContext.doctor_name || null,
    service_id: currentContext.service_id || null,
    service_name: currentContext.service_name || null,
    appointment_type: currentContext.appointment_type || null,
    date: currentContext.date || null,
    time: currentContext.time || null,
slot_id: currentContext.slot_id || null,
    };
}
const keep = (v, old) => v !== null && v !== undefined && v !== '' ? v : (old ?? null);
const slotState = { doctor_id: keep(currentSlot.doctor_id, previousSlot.doctor_id), doctor_name: keep(currentSlot.doctor_name, previousSlot.doctor_name), service_id: keep(currentSlot.service_id, previousSlot.service_id), service_name: keep(currentSlot.service_name, previousSlot.service_name), appointment_type: keep(currentSlot.appointment_type, previousSlot.appointment_type), date: keep(currentSlot.date, previousSlot.date), time: keep(currentSlot.time, previousSlot.time), slot_id: keep(currentSlot.slot_id, previousSlot.slot_id), booking_number: keep(currentSlot.booking_number, previousSlot.booking_number) };
const bookingContext = { doctor_id: keep(currentContext.doctor_id, previousBookingFallback.doctor_id || slotState.doctor_id), doctor_name: keep(currentContext.doctor_name, previousBookingFallback.doctor_name || slotState.doctor_name), service_id: keep(currentContext.service_id, previousBookingFallback.service_id || slotState.service_id), service_name: keep(currentContext.service_name, previousBookingFallback.service_name || slotState.service_name), appointment_type: keep(currentContext.appointment_type, previousBookingFallback.appointment_type || slotState.appointment_type), slot_id: keep(currentContext.slot_id, previousBookingFallback.slot_id || slotState.slot_id), date: keep(currentContext.date, previousBookingFallback.date || slotState.date), time: keep(currentContext.time, previousBookingFallback.time || slotState.time), booking_number: keep(currentContext.booking_number, previousBookingFallback.booking_number || slotState.booking_number) };
const persistentPriorReference = output.contract?.entities?.references_prior_conversation === true
  || output.references_prior_conversation === true
  || String(output.contract?.entities?.references_prior_conversation || '').trim().toLowerCase() === 'true';
const persistentOperationName = String(output.active_operation || decision.active_operation || output.operation_action || decision.operation_action || previous.active_operation || previous.operation_action || '').trim().toLowerCase();
const persistentOperationState = String(output.operation_status || decision.operation_status || previous.operation_status || '').trim().toUpperCase();
const persistentTurnIntent = String(decision.intent || output.contract?.turn?.intent || output.intent || previous.current_intent || previous.last_intent || '').trim().toLowerCase();
const currentTurnRequestsScheduling = Boolean(
  currentContext.date || currentContext.time
  || output.availability_inquiry === true
  || decision.availability_inquiry === true
  || output.contract?.operation_proposal?.requested === true
  || decision.contract?.operation_proposal?.requested === true
  || output.query?.type === 'availability'
  || decision.query?.type === 'availability'
);
const clearHistoricalContextOnSmallTalk = (persistentTurnIntent === 'small_talk'
  && !persistentPriorReference
  && !['create_appointment','cancel_appointment','reschedule_appointment'].includes(persistentOperationName)
  && !['DRAFT','PENDING','CONFIRMATION_REQUIRED'].includes(persistentOperationState)
  && !decision.confirmation_target)
  || (expiredPriorDraft && !persistentPriorReference && !currentTurnRequestsScheduling);
if (clearHistoricalContextOnSmallTalk) {
  // Ordinary small talk clears stale scheduling context. An expired draft is
  // different: keep the last explicit date/time as historical context so the
  // patient is not asked for it again, while invalidating only executable slot
  // state. Any later scheduling request must run fresh deterministic lookup.
  const fieldsToClear = expiredPriorDraft ? ['slot_id'] : ['slot_id','date','time'];
  for (const field of fieldsToClear) {
    bookingContext[field] = null;
    slotState[field] = null;
  }
}
const previousFacts = previous.facts || {};
// Keep one canonical patient object for state_data and the node's top-level output.
// This prevents an old input booking_context from leaking into the rendering prompt.
const dbPatientRecordPresent = Boolean(
  clinic.patient_id || clinic.patient_name || clinic.patient_phone || clinic.patient_mobile
  || clinic.patient_age !== null && clinic.patient_age !== undefined
  || clinic.patient_address
);
const unusablePatientNames = new Set(['مريض', 'patient', 'unknown', 'غير معروف', 'غير محدد']);
const usablePatientName = (value) => {
  const text = String(value || '').trim();
  return text && !unusablePatientNames.has(text.toLowerCase()) ? text : null;
};
const previousPatientName = usablePatientName(previousFacts.patient?.name)
  || usablePatientName(previous.patient_data_review?.fields?.name);
const currentTurnPatientName = usablePatientName(orchPatientName);
const clinicPatientName = usablePatientName(clinic.patient_name);
const telegramPatientNameTrusted = !isTelegramChannel
  || orchPatientNameSource === 'user_entered'
  || previousFacts.patient?.name_source === 'user_entered';
const priorPatientNameCandidate = telegramPatientNameTrusted ? (previousPatientName || null) : null;
const clinicPatientNameForState = telegramPatientNameTrusted ? clinicPatientName : null;
const patientRecordForReview = !isTelegramChannel || telegramPatientNameTrusted;
const persistedPatient = {
  patient_name: currentTurnPatientName || priorPatientNameCandidate || (dbPatientRecordPresent ? clinicPatientNameForState : null),
  patient_name_source: currentTurnPatientName
    ? (orchPatientNameSource || 'user_entered')
    : (patientRecordForReview && (priorPatientNameCandidate || clinicPatientNameForState) ? (previousFacts.patient?.name_source || 'stored') : null),
  patient_phone: orchPatientPhone || (dbPatientRecordPresent ? (clinic.patient_phone || clinic.patient_mobile) : (previousFacts.patient?.phone || previousFacts.patient?.mobile)) || null,
  patient_age: orchPatientAge ?? (dbPatientRecordPresent ? clinic.patient_age : previousFacts.patient?.age) ?? null,
  patient_address: orchPatientAddress || (dbPatientRecordPresent ? clinic.patient_address : previousFacts.patient?.address) || null
};
for (const field of ['patient_name','patient_name_source','patient_phone','patient_age','patient_address']) bookingContext[field] = persistedPatient[field];
if (abandonCurrentBooking) {
    for (const field of ['doctor_id','doctor_name','service_id','service_name','appointment_type','slot_id','date','time','booking_number','branch_id','branch_name']) bookingContext[field] = null;
}
const serviceFactContext = output.service_fact_context && typeof output.service_fact_context === 'object' ? output.service_fact_context : {};
const currentServiceCatalog = serviceFactContext.source === 'catalog' && Array.isArray(serviceFactContext.last_service_catalog) && serviceFactContext.last_service_catalog.length > 0 ? serviceFactContext.last_service_catalog : null;
const facts = {
  ...previousFacts,
  ...(currentServiceCatalog ? { last_service_catalog: currentServiceCatalog, last_service_catalog_at: now.toISOString() } : {}),
  patient: { ...(previousFacts.patient || {}), patient_id: ctx.patient_id, name: persistedPatient.patient_name, name_source: persistedPatient.patient_name_source, phone: persistedPatient.patient_phone, age: persistedPatient.patient_age, address: persistedPatient.patient_address },
  clinic: { id: ctx.clinic_id, name: clinic.clinic_name || previousFacts.clinic?.name || null },
  channel: { type: ctx.channel_type, id: ctx.channel_id, key: ctx.channel_key },
  booking: { ...((newBookingRestart || abandonCurrentBooking || clearHistoricalContextOnSmallTalk) ? {} : (previousFacts.booking || {})), ...bookingContext, booking_number: (newBookingRestart || abandonCurrentBooking) && !executionBookingNumber ? null : (executionBookingNumber || previousFacts.booking?.booking_number || previous.booking_number || bookingContext.booking_number || null), appointment_id: (newBookingRestart || abandonCurrentBooking || clearHistoricalContextOnSmallTalk) ? null : (output.appointment_id || previousFacts.booking?.appointment_id || previous.appointment_id || null) }
};
const priorTurns = Array.isArray(previous.recent_turns) ? previous.recent_turns : [];
const canonicalReply = String($json.rendered_reply || $json.final_reply || $json.reply_text || output.rendered_reply || output.final_reply || output.reply_text || '').trim();
// Derive the information requested in the assistant's actual patient-facing reply.
// This is intentionally separate from the deterministic missing-field order because
// short answers such as "19" must bind to what the patient actually saw.
const K2Q_SPLIT = /[\u061f?.;\u061b!]+/u;
const K2Q_STRONG = {
  patient_name: /(?:إيه اسمك|ايه اسمك|اسمك إيه|اسمك ايه|وش اسمك|عايزين اسمك|عاوزين اسمك|نبعتلك اسمك|نكتب اسمك|أكتب اسمك|اكتب اسمك)/iu,
  patient_phone: /(?:رقمك إيه|رقمك ايه|إيه رقمك|ايه رقمك|وش رقمك|رقم جوالك|رقم الواتس|عايزين رقمك|نرسل لك رقمك|رقم حضرتك|نبعت على رقمك)/iu,
  patient_age: /(?:كم عمرك|عمرك كام|كم سنة|عمر حضرتك|سنك كام)/iu,
  patient_address: /(?:عنوانك إيه|عنوانك ايه|إيه عنوانك|عايزين عنوانك|ساكن فين|ساكنة فين|وين ساكن|مكان السكن|عنوان حضرتك)/iu,
  doctor: /(?:أي دكتور|اي دكتور|مين الدكتور|مين الطبيب|مين الدكتورة|وش اسم الدكتور|الدكتور المطلوب|الدكتورة المطلوبة)/iu,
  service: /(?:نوع الخدمة|أي خدمة|اي خدمة|التخصص المطلوب|أي تخصص|اي تخصص|الخدمة المطلوبة)/iu,
  visit_type: /(?:نوع الكشف|كشف جديد ولا|كشف جديد والا|كشف ولا متابعة|كشف والا متابعة|زيارة ولا متابعة|ولا متابعة|متابعة ولا|كشف ولا|كشف والا)/iu,
  date: /(?:أي يوم|اي يوم|متى الموعد|متى يناسبك|أي تاريخ|اي تاريخ|حدد اليوم|تختار اليوم|يوم شنو|نفسك تختار يوم|تحب تحجز يوم|عايز تحجز يوم|يوم تاني|يوم ثاني|يوم تانى|يوم بديل|يوم بدايل|شوف لك يوم|أشوف لك يوم|شوفلك يوم|أشوفلك يوم|موعد تاني|موعد ثاني|موعد بديل|يوم آخر|يوم اخر|تغيير اليوم|نفسك يوم تاني|تحب يوم تاني|عايز يوم تاني)/iu,
  time: /(?:أي وقت|اي وقت|أي ساعة|اي ساعة|الوقت المناسب|متى يناسبك الساعة)/iu
};
const k2qAskedFromReply = (replyText) => {
  const text = String(replyText || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const out = [];
  for (const sentence of text.split(K2Q_SPLIT)) {
    const s = sentence.trim();
    if (!s) continue;
    for (const field of Object.keys(K2Q_STRONG)) {
      if (K2Q_STRONG[field].test(s) && !out.includes(field)) out.push(field);
    }
  }
  return out;
};
const requestedFieldsFromReply = (replyText) => k2qAskedFromReply(replyText);
const currentMissingHumanFieldsForQuestion = Array.isArray(decision.missing_human_fields)
  ? decision.missing_human_fields
  : (Array.isArray(output.missing_human_fields) ? output.missing_human_fields : []);
const currentNextBestMissingFieldForQuestion = String(decision.next_best_missing_human_field || output.next_best_missing_human_field || output.contract?.next_step?.field || output.next_step?.field || '').trim() || null;
const currentRequestedFieldsForQuestion = [...new Set([
  ...currentMissingHumanFieldsForQuestion.map((value) => String(value || '').trim()).filter(Boolean),
  ...(currentNextBestMissingFieldForQuestion ? [currentNextBestMissingFieldForQuestion] : [])
])];
const requestedFieldsFromActualReply = requestedFieldsFromReply(canonicalReply);
// v34: plan-first, strong-ask override. The deterministic missing-field plan is
// primary. Only a STRONG explicit ask in the sent reply overrides it, and only
// when it CONTRADICTS the plan (the burn trigger class); a consistent strong
// ask keeps the plan's curated order. No strong ask -> plan.
const replyStrongAsked = requestedFieldsFromActualReply.filter((f) => f !== 'confirmation');
const sameField = (a, b) => a === b || (a === 'visit_type' && b === 'service') || (a === 'service' && b === 'visit_type');
const openQuestionFields = replyStrongAsked.length
  ? (currentRequestedFieldsForQuestion.length && currentRequestedFieldsForQuestion.some((f) => replyStrongAsked.some((g) => sameField(f, g)))
      ? currentRequestedFieldsForQuestion
      : replyStrongAsked)
  : currentRequestedFieldsForQuestion;
const assistantRequestedFields = openQuestionFields;
// FIX: keep requested_fields on every persisted assistant turn. Downstream
// patient-evidence and recent_assistant_turn logic reads this exact property.
// requested_information is kept as a compatibility alias for older state readers.
// ── FIX v5b: never persist a reply that failed the doctor-name safety check. ──
const replyFailed = $json.reply_failed === true || output.reply_failed === true;
const recentTurns = priorTurns.concat([
  { role: 'user', text: ctx.message_text, at: ctx.received_at, channel: ctx.channel_type },
  replyFailed ? null : {
    role: 'assistant',
    text: canonicalReply,
    requested_fields: assistantRequestedFields,
    requested_information: assistantRequestedFields,
    at: now.toISOString(),
    channel: ctx.channel_type
  }
]).filter(Boolean).slice(-6);
const sessionRecentTurns = contextSessionReset ? recentTurns.slice(-2) : recentTurns;
// Dialogue-state evidence must be derived from the canonical recent turns built above.
const recentTurnsForPatientEvidence = Array.isArray(recentTurns) ? recentTurns : [];
const lastAssistantTurnForPatientEvidence = [...recentTurnsForPatientEvidence].reverse().find(turn => turn && turn.role === 'assistant') || null;
const intent = output.intent || previous.last_intent || previous.current_intent || null;
// Response Policy exposes the authoritative execution result at the top level.
// Do not rely only on the model-shaped `output`, which contains no appointment_id
// on an approved child execution and previously left state stuck in EXECUTING.
const finalizeResponse = ($json.operation_finalize_response && typeof $json.operation_finalize_response === 'object')
  ? $json.operation_finalize_response : {};
const responseCode = decision.response_code || $json.response_code || output.response_code || finalizeResponse.response_code || null;
const executionAppointmentId = $json.appointment_id || finalizeResponse.appointment_id || output.appointment_id || null;
executionBookingNumber = $json.booking_number || finalizeResponse.booking_number || output.booking_number || bookingContext.booking_number || previous.booking_number || null;
const decisionTarget = decision.confirmation_target && typeof decision.confirmation_target === 'object' ? decision.confirmation_target : null;
const configuredDraftTtlRaw = clinic.draft_ttl_seconds ?? clinic.draft_ttl ?? previous.draft_ttl_seconds ?? 1800;
const draftTtlSeconds = Number.isFinite(Number(configuredDraftTtlRaw)) ? Math.max(60, Math.min(86400, Math.trunc(Number(configuredDraftTtlRaw)))) : 1800;
const decisionAction = decision.action && decision.action !== 'none' ? decision.action : (decisionTarget?.action || null);
const suppliedOriginalResponseCode = output.original_response_code || decision.original_response_code || previous.original_response_code || null;
const replayOriginalByAction = decisionAction === 'cancel_appointment'
  ? 'CANCEL_COMPLETED'
  : decisionAction === 'reschedule_appointment'
    ? 'RESCHEDULE_COMPLETED'
    : decisionAction === 'create_appointment'
      ? 'APPOINTMENT_CREATED'
      : null;
const replayOriginalResponseCode = responseCode === 'IDEMPOTENT_REPLAY'
  ? (suppliedOriginalResponseCode || replayOriginalByAction)
  : null;
const replayOriginUnknown = responseCode === 'IDEMPOTENT_REPLAY' && !replayOriginalResponseCode;
const explicitContinuation = output.explicit_continuation === true
  || decision.event === 'USER_EXPLICIT_CONTINUATION'
  || output.event === 'USER_EXPLICIT_CONTINUATION';
const handoffRequired = responseCode === 'HANDOFF_REQUIRED'
  && decision.response_code === 'HANDOFF_REQUIRED'
  && decision.escalation_requested === true;
const isCreateOperation = decisionAction === 'create_appointment' || decisionTarget?.action === 'create_appointment';
const clearsCreateOperation = ['cancel_appointment', 'reschedule_appointment'].includes(decisionAction);
// P-E2E: A live confirmation target persists across a booking restart claim —
// user confirmations arriving after a slot selection must be honored.
const previousTarget = (newBookingRestart || expiredPriorDraft || abandonCurrentBooking) ? null : (previous.confirmation_target && typeof previous.confirmation_target === 'object' ? previous.confirmation_target : null);
const previousTargetExpires = previousTarget?.expires_at ? Date.parse(previousTarget.expires_at) : NaN;
const stateTargetUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
const statePromptUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
const previousTargetIdentityValid = Boolean(previousTarget
  && String(previousTarget.clinic_id || '') === String(ctx.clinic_id || '')
  && String(previousTarget.patient_id || '') === String(ctx.patient_id || '')
  && String(previousTarget.conversation_id || '') === String(ctx.conversation_id || '')
  && previousTarget.operation_id
  && previousTarget.last_user_message_id_at_request);
const previousTargetShapeValid = previousTarget?.action === 'create_appointment'
  ? previousTargetIdentityValid && stateTargetUuid(previousTarget.doctor_id) && stateTargetUuid(previousTarget.slot_id)
    && /^\d{4}-\d{2}-\d{2}$/.test(String(previousTarget.date || ''))
    && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(String(previousTarget.time || ''))
    && ['NEW_VISIT','FOLLOW_UP'].includes(String(previousTarget.appointment_type || '').toUpperCase())
  : previousTarget?.action === 'cancel_appointment' ? previousTargetIdentityValid && stateTargetUuid(previousTarget.appointment_id)
  : previousTarget?.action === 'reschedule_appointment' ? previousTargetIdentityValid && stateTargetUuid(previousTarget.appointment_id) && stateTargetUuid(previousTarget.expected_old_slot_id) && stateTargetUuid(previousTarget.new_slot_id)
  : false;
// P-CTFIX-E2E: The confirmation prompt may be recorded in the same turn
// lineage as the request that triggered it (prompt emitted in the request
// execution), so binding validity MUST NOT require the prompt id to differ
// from last_user_message_id_at_request. A delivered, non-expired,
// non-invalidated target within its TTL is a live confirmation contract.
const previousTargetBindingValid = ['sent', 'pending'].includes(String(previousTarget?.confirmation_delivery_status || '').toLowerCase())
  && !!previousTarget?.confirmation_delivery_recorded_at
  && statePromptUuid(previousTarget?.confirmation_prompt_message_id)
  && !!previousTarget?.last_user_message_id_at_request
  && previousTarget.invalidated !== true;
const previousTargetCreated = Date.parse(previousTarget?.created_at || '');
const previousTargetTtl = Number(previousTarget?.confirmation_ttl_seconds || previous.confirmation_ttl_seconds || 600);
const previousTargetComputedExpiry = Number.isFinite(previousTargetCreated)
  && Number.isFinite(previousTargetTtl)
  && previousTargetCreated + Math.max(60, previousTargetTtl) * 1000 > now.getTime();
const previousTargetLiveExpiry = Number.isFinite(previousTargetExpires) && previousTargetExpires > now.getTime();
const previousTargetValid = !newBookingRestart && !!previousTarget && (previousTargetLiveExpiry || previousTargetComputedExpiry) && previousTargetShapeValid && previousTargetBindingValid && previousTarget.invalidated !== true;
const previousTargetInvalid = !!previousTarget && !previousTargetValid;
const terminalResponseCodes = ['APPOINTMENT_CREATED','CANCEL_COMPLETED','CANCELLATION_NOT_ALLOWED','APPOINTMENT_NOT_FOUND_OR_NOT_OWNED','RESCHEDULE_COMPLETED','IDEMPOTENT_REPLAY','OPERATION_INCONCLUSIVE'];
const transientFailureCodes = new Set(['APPOINTMENT_CREATION_FAILED','CANCEL_FAILED','RESCHEDULE_FAILED','PROVIDER_TIMEOUT','PROVIDER_UNAVAILABLE','SLOT_UNAVAILABLE','SLOT_INVALID','NETWORK_ERROR','UPSTREAM_TIMEOUT']);
const finalFailureCodes = new Set(['CANCELLATION_NOT_ALLOWED','APPOINTMENT_NOT_FOUND_OR_NOT_OWNED','OPERATION_INCONCLUSIVE']);
const invalidStateTransition = responseCode === 'INVALID_STATE_TRANSITION';
const previousOperationAction = (newBookingRestart || expiredPriorDraft || abandonCurrentBooking || contextSessionReset) ? null : (previous.operation_action || previous.active_operation || null);
const canonicalOperationAction = (newBookingRestart || expiredPriorDraft) ? 'create_appointment' : (decisionAction || previousOperationAction || null);
const freshOperationId = output.operation_id || decision.operation_id || ctx.operation_id || `${ctx.idempotency_key}:create_appointment`;
const canonicalOperationId = abandonCurrentBooking ? null : (newBookingRestart ? freshOperationId : (output.operation_id || decisionTarget?.operation_id || decision.operation_id || previous.operation_id || previous.confirmation_target?.operation_id || null));
const originalResponseCode = responseCode === 'APPOINTMENT_CREATED'
  ? 'APPOINTMENT_CREATED'
  : responseCode === 'CANCEL_COMPLETED'
    ? 'CANCEL_COMPLETED'
    : responseCode === 'RESCHEDULE_COMPLETED'
      ? 'RESCHEDULE_COMPLETED'
      : responseCode === 'IDEMPOTENT_REPLAY'
        ? replayOriginalResponseCode
        : (isCreateOperation || clearsCreateOperation ? null : (previous.original_response_code || null));
const outputStatus = String($json.operation_status || output.operation_status || finalizeResponse.operation_status || previous.operation_status || '').toLowerCase();
let operationState = abandonCurrentBooking ? 'idle' : (outputStatus || previous.operation_status || 'idle');
if (responseCode === 'APPOINTMENT_CREATED' || responseCode === 'RESCHEDULE_COMPLETED') operationState = 'completed';
else if (responseCode === 'CANCEL_COMPLETED') operationState = 'cancelled';
else if (responseCode === 'IDEMPOTENT_REPLAY') {
  if (replayOriginalResponseCode === 'CANCEL_COMPLETED' || canonicalOperationAction === 'cancel_appointment') operationState = 'cancelled';
  else if (replayOriginalResponseCode === 'APPOINTMENT_CREATED' || replayOriginalResponseCode === 'RESCHEDULE_COMPLETED' || ['create_appointment', 'reschedule_appointment'].includes(canonicalOperationAction)) operationState = 'completed';
  else operationState = 'refresh_required';
}
else if (invalidStateTransition) operationState = 'refresh_required';
else if (handoffRequired) operationState = 'paused';
else if (transientFailureCodes.has(responseCode)) operationState = 'failed_retryable';
else if (finalFailureCodes.has(responseCode)) operationState = 'failed_final';
else if (responseCode === 'CONFIRMATION_REQUIRED') operationState = 'awaiting_confirmation';
// P-E2E: A new-booking restart claim does not reset state while a valid
// confirmation target is pending; awaiting_confirmation survives the claim.
else if ((newBookingRestart || responseCode === 'NEW_BOOKING_STARTED') && !(previousTargetValid)) operationState = 'collecting_details';
else if (responseCode === 'CONFIRMATION_EXPIRED') operationState = 'refresh_required';
else if (responseCode === 'EXECUTE_APPROVED' || responseCode === 'CANCEL_APPROVED') operationState = 'executing';
else if (previousTargetInvalid && operationState === 'awaiting_confirmation') operationState = 'refresh_required';
const faqTurn = output.intent === 'faq' || decision.intent === 'faq' || $json._normalization?.inferred_intent === 'faq';
const hasLiveOperation = !contextSessionReset && !newBookingRestart && !expiredPriorDraft && Boolean(previous.active_operation) && !['completed', 'failed', 'cancelled'].includes(String(previous.operation_status || '').toLowerCase());
const faqPausesOperation = faqTurn && hasLiveOperation;
if (faqPausesOperation) operationState = 'paused';
let activeOperation = abandonCurrentBooking ? null : (newBookingRestart ? 'create_appointment' : (transientFailureCodes.has(responseCode)
  ? (previousOperationAction || decisionAction || (intent === 'booking' ? 'create_appointment' : null))
  : terminalResponseCodes.includes(responseCode)
    ? null
    : (decisionAction || previous.active_operation || (intent === 'booking' ? 'create_appointment' : null))));
if (faqPausesOperation) activeOperation = previous.active_operation;
if (abandonCurrentBooking) activeOperation = null;
let confirmationState = abandonCurrentBooking ? null : (previousTargetInvalid && !(decisionTarget && typeof decisionTarget === 'object') ? 'expired' : (previous.confirmation_state || null));
if (responseCode === 'CONFIRMATION_REQUIRED') confirmationState = 'required';
else if (responseCode === 'CONFIRMATION_EXPIRED') confirmationState = 'expired';
else if (responseCode === 'EXECUTE_APPROVED' || responseCode === 'CANCEL_APPROVED') confirmationState = 'executing';
else if (invalidStateTransition) confirmationState = 'expired';
else if (responseCode === 'APPOINTMENT_CREATED' || responseCode === 'RESCHEDULE_COMPLETED') confirmationState = 'confirmed';
else if (responseCode === 'CANCEL_COMPLETED') confirmationState = 'cancelled';
else if (responseCode === 'IDEMPOTENT_REPLAY') confirmationState = replayOriginUnknown ? 'expired' : (replayOriginalResponseCode === 'CANCEL_COMPLETED' || canonicalOperationAction === 'cancel_appointment' ? 'cancelled' : 'confirmed');
else if (transientFailureCodes.has(responseCode) || finalFailureCodes.has(responseCode)) confirmationState = 'failed';
const clearsConfirmationForResponse = terminalResponseCodes.includes(responseCode) || invalidStateTransition;
// P-E2E: Honor an auto-built confirmation target emitted by Apply Deterministic
// Slot Lookup Result (slot selection during confirmation window) as well as the
// orchestrator decision target and a still-valid prior target.
const upstreamAppliedTarget = $json.output && typeof $json.output === 'object' && $json.output.confirmation_target && typeof $json.output.confirmation_target === 'object' ? $json.output.confirmation_target : null;
let target = clearsConfirmationForResponse ? null : (decisionTarget || upstreamAppliedTarget || (previousTargetValid ? previousTarget : null)); if (target && typeof target === 'object') { if (!target.clinic_id) target.clinic_id = ctx.clinic_id || null; if (!target.patient_id) target.patient_id = ctx.patient_id || null; if (!target.conversation_id) target.conversation_id = ctx.conversation_id || null;
  if (target && typeof target === 'object' && target.slot_id) {
    const pmid = String(target.confirmation_prompt_message_id || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pmid)) {
      target.confirmation_prompt_message_id = mintUuid(target.operation_id || (target.clinic_id + ':' + (target.last_user_message_id_at_request || '')));
    }
  } }
if (target && typeof target === 'object') {
  const targetBound = String(target.clinic_id || '') === String(ctx.clinic_id || '')
    && String(target.patient_id || '') === String(ctx.patient_id || '')
    && String(target.conversation_id || '') === String(ctx.conversation_id || '')
    && target.operation_id && target.last_user_message_id_at_request;
  if (!targetBound) target = null;
}
if (faqPausesOperation) {
  target = null;
  confirmationState = previousTarget ? 'invalidated' : (previous.confirmation_state || null);
}
const canonicalStateMap = { idle: 'IDLE', collecting_details: 'DRAFT', draft: 'DRAFT', paused: 'PAUSED', awaiting_confirmation: 'AWAITING_CONFIRMATION', refresh_required: 'REFRESH_REQUIRED', executing: 'EXECUTING', completed: canonicalOperationAction === 'cancel_appointment' ? 'CANCELLED' : 'COMPLETED', cancelled: 'CANCELLED', failed_retryable: 'FAILED_RETRYABLE', failed: 'FAILED_FINAL', failed_final: 'FAILED_FINAL' };
let canonicalOperationState = canonicalStateMap[String(operationState).toLowerCase()] || (previous.operation_state || 'IDLE');
const hasBookingDraftContext = Boolean(Object.values(bookingContext || {}).some((value) => value !== null && value !== undefined && String(value).trim() !== ''));
const terminalForStateRepair = new Set(['APPOINTMENT_CREATED','CANCEL_COMPLETED','RESCHEDULE_COMPLETED','IDEMPOTENT_REPLAY','CANCELLATION_NOT_ALLOWED','APPOINTMENT_NOT_FOUND_OR_NOT_OWNED','RESCHEDULE_NOT_ALLOWED','OPERATION_INCONCLUSIVE']);
if (canonicalOperationState === 'IDLE' && activeOperation && hasBookingDraftContext && !terminalForStateRepair.has(responseCode)) {
  operationState = 'collecting_details';
  canonicalOperationState = 'DRAFT';
}
if (!activeOperation && !hasBookingDraftContext && !target && canonicalOperationState === 'IDLE') {
  operationState = 'idle';
}
if (handoffRequired || faqPausesOperation) canonicalOperationState = 'PAUSED';
if (responseCode === 'CANCEL_COMPLETED' || (responseCode === 'IDEMPOTENT_REPLAY' && (replayOriginalResponseCode === 'CANCEL_COMPLETED' || canonicalOperationAction === 'cancel_appointment'))) canonicalOperationState = 'CANCELLED';
if (responseCode === 'APPOINTMENT_CREATED' || responseCode === 'RESCHEDULE_COMPLETED' || (responseCode === 'IDEMPOTENT_REPLAY' && !replayOriginUnknown && replayOriginalResponseCode !== 'CANCEL_COMPLETED' && canonicalOperationAction !== 'cancel_appointment')) canonicalOperationState = 'COMPLETED';
if (responseCode === 'IDEMPOTENT_REPLAY' && replayOriginUnknown) canonicalOperationState = 'REFRESH_REQUIRED';
if (invalidStateTransition) canonicalOperationState = 'REFRESH_REQUIRED';
const migrationIssues = Array.isArray(previous.migration_issues) ? [...previous.migration_issues] : [];
if (previousTargetInvalid && ['awaiting_confirmation', 'AWAITING_CONFIRMATION'].includes(String(operationState))) migrationIssues.push('confirmation_target_invalid_or_undelivered');
if (handoffRequired) migrationIssues.push('handoff_required_paused');
if (replayOriginUnknown) migrationIssues.push('replay_origin_unknown');
if (invalidStateTransition) migrationIssues.push('invalid_transition_refresh_required');
const resumeEligible = ['DRAFT','PAUSED','AWAITING_CONFIRMATION','REFRESH_REQUIRED'].includes(canonicalOperationState) && !handoffRequired;
const retryable = canonicalOperationState === 'FAILED_RETRYABLE' || transientFailureCodes.has(responseCode);
const failureCode = retryable || canonicalOperationState === 'FAILED_FINAL' ? (responseCode || previous.failure_code || null) : null;
const migrationStatus = previous.migration_status || (migrationIssues.length ? 'REVIEW_REQUIRED' : 'MIGRATED_V1');
const routingAction = handoffRequired ? 'HANDOFF_REQUIRED' : (explicitContinuation ? null : (previous.routing_action || null));
const conversationStage = decision.conversation_stage || previous.conversation_stage || null;
const requiredNextStep = decision.required_next_step || previous.required_next_step || null;
const pendingAction = conversationStage === 'WAITING_PATIENT_DATA_CONFIRMATION' ? 'confirm_patient_data'
  : conversationStage === 'COLLECTING_PATIENT_DATA' ? 'collect_patient_data'
  : canonicalOperationState === 'PAUSED' ? (routingAction === 'HANDOFF_REQUIRED' ? 'handoff_required' : 'resume_booking_operation') : canonicalOperationState === 'AWAITING_CONFIRMATION' ? (activeOperation === 'cancel_appointment' ? 'confirm_cancel_appointment' : activeOperation === 'reschedule_appointment' ? 'confirm_reschedule_appointment' : 'confirm_create_appointment') : canonicalOperationState === 'REFRESH_REQUIRED' ? 'refresh_booking_slot' : canonicalOperationState === 'DRAFT' ? 'collect_booking_details' : null;
const shouldPersistOpenQuestion = responseCode === 'MISSING_REQUIRED_FIELDS'
  || responseCode === 'PATIENT_DATA_CONFIRMATION_REQUIRED'
  || responseCode === 'CONFIRMATION_REQUIRED'
  || canonicalOperationState === 'AWAITING_CONFIRMATION';
const persistedRequestedFields = openQuestionFields.length
  ? openQuestionFields
  : (responseCode === 'PATIENT_DATA_CONFIRMATION_REQUIRED'
    ? ['name','age','address','phone']
    : (Array.isArray(lastAssistantTurnForPatientEvidence?.requested_fields) && lastAssistantTurnForPatientEvidence.requested_fields.length
      ? lastAssistantTurnForPatientEvidence.requested_fields
      : (Array.isArray(previous.last_open_question?.requested_fields) ? previous.last_open_question.requested_fields : [])));
const persistedLastOpenQuestion = {
  message: shouldPersistOpenQuestion ? (canonicalReply || previous.last_open_question?.message || null) : null,
  requested_fields: persistedRequestedFields,
  type: shouldPersistOpenQuestion ? (responseCode === 'CONFIRMATION_REQUIRED' || canonicalOperationState === 'AWAITING_CONFIRMATION' ? 'confirmation' : 'missing_field') : null,
  pending_action: pendingAction
};
const previousDraftStartedMs = Date.parse(previous.draft_started_at || '');
const previousDraftExpiresMs = Date.parse(previous.draft_expires_at || '');
const previousDraftActive = String(previous.operation_state || '').toUpperCase() === 'DRAFT';
const draftStateActive = canonicalOperationState === 'DRAFT';
const draftRestart = normalization.new_booking_restart === true || output.draft_restart === true;
const draftStartedAt = draftStateActive ? (!draftRestart && previousDraftActive && Number.isFinite(previousDraftStartedMs) ? new Date(previousDraftStartedMs).toISOString() : now.toISOString()) : null;
const draftExpiresAt = draftStateActive ? (!draftRestart && previousDraftActive && Number.isFinite(previousDraftExpiresMs) ? new Date(previousDraftExpiresMs).toISOString() : new Date(Date.parse(draftStartedAt) + draftTtlSeconds * 1000).toISOString()) : null;
const dc = bookingContext || {};
const summaryParts = [
  dc.doctor_id && dc.service_id
    ? `المريض يحجز ${dc.service_name || 'خدمة'} مع ${dc.doctor_name || 'الطبيب'}${dc.date ? ' يوم ' + dc.date : ''}${dc.time ? ' الساعة ' + dc.time : ''}`
    : intent ? `آخر طلب: ${intent === 'other' ? 'محادثة عامة أو تحية' : intent}` : null,
  activeOperation ? (activeOperation.includes('cancel') ? 'يوجد طلب إلغاء قيد التجهيز' : activeOperation.includes('reschedule') ? 'يوجد طلب تغيير موعد قيد التجهيز' : 'يوجد حجز جديد قيد التجهيز') : null,
  `مرحلة العملية: ${canonicalOperationState === 'DRAFT' ? 'في انتظار الموعد المناسب' : canonicalOperationState === 'CONFIRMED' ? 'بانتظار تأكيد المريض النهائي' : canonicalOperationState},`,
  dc.date && dc.time ? `تاريخ ووقت متفق عليه مبدئيًا: ${dc.date} ${dc.time}` : null,
  bookingContext.patient_name ? `اسم المريض: ${bookingContext.patient_name}` : null,
].filter(Boolean).join(' ') + (sessionRecentTurns && sessionRecentTurns.length ? `
آخر التبادلات: ${JSON.stringify(sessionRecentTurns.slice(-4))}` : '');
const availabilityInquiry = normalization.availability_inquiry === true || output.availability_inquiry === true || decision.availability_inquiry === true;
const nextBestMissingHumanField = decision.next_best_missing_human_field || output.next_best_missing_human_field || null;
const missingHumanFields = Array.isArray(decision.missing_human_fields) ? decision.missing_human_fields : (Array.isArray(output.missing_human_fields) ? output.missing_human_fields : []);
// P-CTFIX: resolve the target once so both state_data and the node output use
// the identical object; without this, execution.output.confirmation_target
// stayed null downstream and the confirmation binding broke on the next turn.
const resolvedCt = target && typeof target === 'object' ? target : null;
const previousPatientReview = contextSessionReset ? {} : (previous.patient_data_review && typeof previous.patient_data_review === 'object' ? previous.patient_data_review : {});
const modelPatientReview = (output.patient_data_review && typeof output.patient_data_review === 'object') ? output.patient_data_review
  : ((orchStatePatches.patient_data_review && typeof orchStatePatches.patient_data_review === 'object') ? orchStatePatches.patient_data_review
  : ((decision.patient_data_review && typeof decision.patient_data_review === 'object') ? decision.patient_data_review : {}));
const reviewFields = { ...(previousPatientReview.fields && typeof previousPatientReview.fields === 'object' ? previousPatientReview.fields : {}), ...(modelPatientReview.fields && typeof modelPatientReview.fields === 'object' ? modelPatientReview.fields : {}) };
for (const [field, value] of Object.entries({ name: persistedPatient.patient_name, phone: persistedPatient.patient_phone, age: persistedPatient.patient_age, address: persistedPatient.patient_address })) {
  if (value !== null && value !== undefined && String(value).trim() !== '') reviewFields[field] = value;
}
if (isTelegramChannel && !telegramPatientNameTrusted) delete reviewFields.name;
const patientReviewRequested = Boolean(Object.keys(modelPatientReview).length || Object.keys(previousPatientReview).length || (patientRecordForReview && dbPatientRecordPresent) || responseCode === 'PATIENT_DATA_CONFIRMATION_REQUIRED');
const mergedPatientDataReview = patientReviewRequested ? {
  ...previousPatientReview,
  ...modelPatientReview,
  status: modelPatientReview.status || previousPatientReview.status || 'pending',
  fields: reviewFields,
  source: modelPatientReview.source || previousPatientReview.source || ((patientRecordForReview && dbPatientRecordPresent) ? 'database' : 'current_turn')
} : null;
const resetAbandonedDraftState = abandonCurrentBooking;
const resetStalePausedGreetingState = !handoffRequired
  && ['small_talk', 'greeting'].includes(String(decision.contract?.turn?.intent || output.intent || decision.intent || '').toLowerCase())
  && String(responseCode || '').toUpperCase() === 'CONVERSATION_ONLY'
  && !target
  && String(previous.pending_action || '').toLowerCase() === 'handoff_required'
  && String(previous.operation_state || previous.operation_status || '').toUpperCase() === 'PAUSED'
  && String(previous.superseded_operation?.reason || '').toUpperCase() === 'SUPERSEDED_BY_NEW_REQUEST';
const resetConversationSessionState = contextSessionReset || resetStalePausedGreetingState || resetAbandonedDraftState;
const statePrevious = (resetConversationSessionState)
  ? { ...previous, active_operation: null, operation_action: null, operation_id: null, operation_state: 'IDLE', operation_status: 'idle', pending_action: null, routing_action: null, conversation_stage: 'CONVERSATION', confirmation_state: null, confirmation_target: null, booking_context: {}, slot_state: {}, superseded_operation: resetAbandonedDraftState ? { reason: 'PATIENT_CHANGED_MIND', superseded_at: now.toISOString(), previous_operation_id: previous.operation_id || null } : null, required_next_step: { type: 'answer_current_message' } }
  : previous;
const nextStateVersion = (Number((previous && previous.state_version) || 0) || 0) + 1;
// P-OFFER v40: the availability child (agent-tool path) writes presented_offer
// into conversation_state mid-turn. Read it here so the end-of-turn wholesale save
// does not overwrite it with the stale start-of-turn snapshot (previously the
// offered slots were lost and acceptance turns degraded to 'unclear').
const freshOfferRow = safeNode('Read Fresh Offer (Midturn)');
const freshOffer = (freshOfferRow.presented_offer && typeof freshOfferRow.presented_offer === 'object' && freshOfferRow.presented_offer.kind === 'presented_offer') ? freshOfferRow.presented_offer : null;
// P42b OFFER-PREFERENCE (RG-3): a patch entry only beats a this-turn fresh offer
// when it is a LIVE offer (kind + unexpired + written this turn) or the
// deterministic lookup ran this turn, or when it deliberately cleared after a
// binding. Orchestrator always seeds the patches key from the start-of-turn
// snapshot, so without the liveness checks the stale snapshot used to win.
const patchesOfferRaw = ('presented_offer' in orchStatePatches) ? (orchStatePatches.presented_offer || null) : undefined;
const turnStartMs = Date.parse(String(ctx.received_at || '')) || 0;
const patchesOfferLive = Boolean(patchesOfferRaw && typeof patchesOfferRaw === 'object' && patchesOfferRaw.kind === 'presented_offer'
  && Number.isFinite(Date.parse(String(patchesOfferRaw.expires_at || ''))) && Date.parse(String(patchesOfferRaw.expires_at || '')) > Date.now()
  && Date.parse(String(patchesOfferRaw.offered_at || '')) >= turnStartMs - 2000);
const patchesClearedAfterBinding = patchesOfferRaw === null && ['CONFIRMATION_REQUIRED', 'APPOINTMENT_CREATED', 'RESCHEDULE_COMPLETED', 'CANCEL_COMPLETED'].includes(String((decision && decision.response_code) || output.response_code || '').toUpperCase());
const freshOfferIsThisTurn = Boolean(freshOffer && turnStartMs && Date.parse(String(freshOffer.offered_at || '')) >= turnStartMs - 2000);
let unifiedOffer;
if (resetConversationSessionState) unifiedOffer = null;
else if (patchesOfferRaw !== undefined && (lookupMatchesCurrentTurn || patchesOfferLive || patchesClearedAfterBinding)) unifiedOffer = patchesOfferRaw;
else if (freshOfferIsThisTurn) unifiedOffer = freshOffer;
else unifiedOffer = patchesOfferRaw !== undefined ? patchesOfferRaw : (freshOffer || previous.presented_offer || previous.pending_offer || null);
const state_data = { ...statePrevious, patient_data_review: mergedPatientDataReview, conversation_stage: (resetConversationSessionState) ? 'CONVERSATION' : conversationStage, required_next_step: (resetConversationSessionState) ? { type: 'answer_current_message' } : requiredNextStep, state_schema_version: 1, availability_inquiry: availabilityInquiry, availability_lookup_lineage_status: lookupMatchesCurrentTurn ? 'FRESH_CURRENT_TURN' : 'CLEARED_NON_CURRENT_TURN', availability_lineage: lookupMatchesCurrentTurn ? (output.availability_lineage || currentLookupLineage) : null, availability_outcome: lookupMatchesCurrentTurn ? (output.availability_outcome || null) : null, availability_alternatives: lookupMatchesCurrentTurn && Array.isArray(output.availability_alternatives) ? output.availability_alternatives : (freshOffer && Array.isArray(freshOfferRow.availability_alternatives) ? freshOfferRow.availability_alternatives : []), pending_offer: unifiedOffer, presented_offer: unifiedOffer, state_machine: (resetConversationSessionState) ? null : (orchStatePatches.state_machine || previous.state_machine || null), unclear_count: (resetConversationSessionState) ? 0 : (typeof orchStatePatches.unclear_count === 'number' ? orchStatePatches.unclear_count : Number(previous.unclear_count || 0)), response_code_history: (resetConversationSessionState) ? [] : (Array.isArray(orchStatePatches.response_code_history) ? orchStatePatches.response_code_history : (Array.isArray(previous.response_code_history) ? previous.response_code_history : [])), turn_directive: (resetConversationSessionState) ? null : (orchOutput.turn_directive || orchStatePatches.turn_directive || null), availability_requested_time_unavailable: lookupMatchesCurrentTurn && output.availability_requested_time_unavailable === true, deterministic_slot_lookup: lookupMatchesCurrentTurn ? (output.deterministic_slot_lookup || null) : null, slot_lookup_ready: lookupMatchesCurrentTurn, next_best_missing_human_field: nextBestMissingHumanField, missing_human_fields: missingHumanFields, superseded_operation: resetStalePausedGreetingState ? null : (resetAbandonedDraftState ? { reason: 'PATIENT_CHANGED_MIND', superseded_at: now.toISOString(), previous_operation_id: previous.operation_id || null } : supersededOperation), last_intent: intent, current_intent: intent, active_operation: (resetConversationSessionState) ? null : activeOperation, operation_status: (resetConversationSessionState) ? 'idle' : operationState, operation_state: (resetConversationSessionState) ? 'IDLE' : canonicalOperationState, operation_id: (resetConversationSessionState) ? null : canonicalOperationId, operation_action: (resetConversationSessionState) ? null : canonicalOperationAction, original_response_code: originalResponseCode, routing_action: (resetConversationSessionState) ? null : routingAction, resume_eligible: resumeEligible, retryable, failure_code: failureCode, migration_status: migrationStatus, migration_issues: [...new Set(migrationIssues)], pending_action: (resetConversationSessionState) ? null : pendingAction, last_open_question: persistedLastOpenQuestion, waiting_for_reference: ['cancel_appointment','reschedule_appointment','confirm_appointment'].includes(activeOperation) && !output.appointment_id, confirmation_state: (resetConversationSessionState) ? null : confirmationState, confirmation_target: (resetConversationSessionState) ? null : target, confirmation_delivery_status: resetAbandonedDraftState ? null : (target?.confirmation_delivery_status || previous.confirmation_delivery_status || null), confirmation_delivery_recorded_at: resetAbandonedDraftState ? null : (target?.confirmation_delivery_recorded_at || previous.confirmation_delivery_recorded_at || null), confirmation_ttl_seconds: resetAbandonedDraftState ? null : (target?.confirmation_ttl_seconds || previous.confirmation_ttl_seconds || 600), confirmation_expires_at: target?.expires_at || null, confirmation_target_hash: target?.context_fingerprint || null, draft_started_at: draftStartedAt, draft_expires_at: draftExpiresAt, draft_ttl_seconds: draftTtlSeconds, business_time_checked: businessTimeChecked, business_time_status: businessTimeStatus, business_time_timezone: businessTimeTimezone, business_time_source: businessTimeSource, business_time_error_code: businessTimeErrorCode, confirmation_target_invalidated: newBookingRestart || resetAbandonedDraftState || faqPausesOperation || (previousTargetInvalid && !decisionTarget), confirmation_contract: { state: target ? 'DELIVERED' : (previousTarget ? 'INVALID_OR_UNDELIVERED' : 'NONE'), target_valid: !!target, expires_at: target?.expires_at || null }, booking_context: (resetConversationSessionState) ? {} : bookingContext, booking_number: (newBookingRestart || resetAbandonedDraftState) ? (executionBookingNumber || null) : (executionBookingNumber || previous.booking_number || bookingContext.booking_number || null), appointment_id: (newBookingRestart || resetAbandonedDraftState) ? null : (executionAppointmentId || previous.appointment_id || null), response_code: responseCode, confidence: output.confidence ?? previous.confidence ?? null, escalate: output.escalate === true, slot_state: (resetConversationSessionState) ? {} : slotState, facts, conversation_summary: summaryParts, recent_turns: sessionRecentTurns, last_message_id: ctx.message_id, last_idempotency_key: ctx.idempotency_key, last_channel: { type: ctx.channel_type, id: ctx.channel_id, key: ctx.channel_key }, last_updated: now.toISOString() };
if (contextSessionReset) {
  state_data.active_operation = null;
  state_data.operation_action = null;
  state_data.operation_id = null;
  state_data.operation_state = 'IDLE';
  state_data.operation_status = 'idle';
  state_data.pending_action = null;
  state_data.routing_action = null;
  state_data.confirmation_state = null;
  state_data.confirmation_target = null;
  state_data.confirmation_delivery_status = null;
  state_data.confirmation_delivery_recorded_at = null;
  state_data.confirmation_expires_at = null;
  state_data.confirmation_target_hash = null;
  state_data.confirmation_contract = { state: 'NONE', target_valid: false, expires_at: null };
  state_data.booking_number = null;
  state_data.appointment_id = null;
  state_data.booking_context = {};
  state_data.slot_state = {};
  state_data.superseded_operation = null;
  state_data.last_open_question = { message: null, requested_fields: [], type: null, pending_action: null };
  state_data.patient_data_review = null;
  state_data.draft_started_at = null;
  state_data.draft_expires_at = null;
  state_data.conversation_summary = summaryParts;
  state_data.recent_turns = sessionRecentTurns;
}

// Persist the optimistic version inside the JSON sent to k2_save_conversation_state.
// The RPC reads this field when validating and storing the versioned state.
state_data.state_version = nextStateVersion;
const result = { ...$json, state_data };
// Never let the incoming stale top-level booking_context override the canonical state.
result.booking_context = resetConversationSessionState ? {} : bookingContext;
result.booking_number = abandonCurrentBooking ? null : (executionBookingNumber || bookingContext.booking_number || null);
result.slot_state = resetConversationSessionState ? {} : slotState;
result.patient_data_review = state_data.patient_data_review || null;
// P-CTFIX: always expose the resolved target (and state) on the node output so
// the confirmation contract remains readable downstream, including the
// Response Policy upstreamAppliedCt path, regardless of restart/expiry paths.
result.confirmation_target = contextSessionReset ? null : resolvedCt;
result.confirmation_state = contextSessionReset ? null : confirmationState;
if (newBookingRestart) {
  result.operation_id = canonicalOperationId;
  result.operation_action = canonicalOperationAction;
  result.operation_state = canonicalOperationState;
  result.operation_status = operationState;
  result.active_operation = activeOperation;
  result.slot_id = bookingContext.slot_id || null;
  result.booking_context = resetAbandonedDraftState ? {} : bookingContext;
  result.booking_number = executionBookingNumber || null;
  result.slot_state = resetAbandonedDraftState ? {} : slotState;
  result.appointment_id = null;
}

  // Expose the exact same version already persisted inside state_data.
  result.state_version = nextStateVersion;
  return [{ json: result }];





