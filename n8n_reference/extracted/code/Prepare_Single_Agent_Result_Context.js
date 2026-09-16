const input = $json || {};
const readNode = (name) => { try { return $(name).first().json || {}; } catch (_) { return {}; } };
const policy = readNode('Response Policy (Deterministic)');
const completion = readNode('Merge Operation Completion');
// Natural Arabic date/time helpers — raw ISO dates and 24h times never reach the Composer.
const AR_MONTHS_063 = ['يناير','فبراير','�ارس','أبريل','�ايو','يونيو','يوليو','أغسطس','سبت�بر','أكتوبر','نوف�بر','ديس�بر'];
const AR_WEEKDAYS_063 = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخ�يس','الج�عة','السبت'];
const naturalDateText063 = (value) => {
  const p = String(value || '').trim().split('-');
  if (p.length !== 3 || p[0].length !== 4) return null;
  const y = parseInt(p[0], 10), m = parseInt(p[1], 10), d = parseInt(p[2], 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `يو� ${AR_WEEKDAYS_063[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${AR_MONTHS_063[m - 1]}`;
};
const naturalTimeText063 = (value) => {
  const s = String(value || '').trim();
  const i = s.indexOf(':');
  if (i < 1) return null;
  const h = parseInt(s.slice(0, i), 10);
  const mi = s.slice(i + 1, i + 3);
  if (!Number.isFinite(h) || mi.length !== 2 || Number.isNaN(Number(mi))) return null;
  let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh}:${mi} ${h >= 12 ? '�ساءً' : 'صباحًا'}`;
};
const isBusinessEnvelope = (value) => {
  if (!value || typeof value !== 'object') return false;
  const facts = value.facts && typeof value.facts === 'object' ? value.facts : {};
  const decision = value.system_decision && typeof value.system_decision === 'object' ? value.system_decision : {};
  return Boolean(
    value.response_code || facts.response_code || decision.response_code
    || value.operation_status || facts.operation_status
    || value.availability_outcome || facts.availability_outcome
    || value.deterministic_slot_lookup?.executed === true
    || decision.deterministic_slot_lookup?.executed === true
    || value.operation_finalized === true
    || value.child_contract_checked === true
    || value.mutation_status
  );
};
// Persist Pending Confirmation may return only {success:true}. Rehydrate the
// authoritative business envelope from Response Policy after the fan-in so the
// Composer sees the actual availability or mutation result.
const source = {
  ...input,
  ...(isBusinessEnvelope(completion) ? completion : {}),
  ...(isBusinessEnvelope(policy) ? policy : {})
};
const decision = source.system_decision && typeof source.system_decision === 'object'
  ? source.system_decision
  : (policy.system_decision && typeof policy.system_decision === 'object' ? policy.system_decision : {});
const facts = source.facts && typeof source.facts === 'object'
  ? source.facts
  : (policy.facts && typeof policy.facts === 'object' ? policy.facts : {});
const actionCandidate = String(
  decision.action
  || decision.confirmation_target?.action
  || source.operation
  || decision.contract?.operation_proposal?.type
  || facts.confirmation_action
  || ''
).toLowerCase();
const action = actionCandidate === 'none' ? '' : actionCandidate;
const code = String(source.response_code || facts.response_code || decision.response_code || '').toUpperCase();
const status = String(source.operation_status || facts.operation_status || decision.operation_status || '').toLowerCase();
const terminalCodes = new Set([
  'APPOINTMENT_CREATED', 'CREATE_COMPLETED', 'CANCEL_COMPLETED', 'RESCHEDULE_COMPLETED',
  'IDEMPOTENT_REPLAY', 'REPLAY_FINAL', 'OPERATION_IN_PROGRESS', 'OPERATION_INCONCLUSIVE',
  'OPERATION_ID_CONFLICT', 'CLAIM_NOT_GRANTED', 'CHILD_CONTRACT_INVALID', 'RPC_ERROR',
  'APPOINTMENT_CREATION_FAILED', 'CANCEL_RETRYABLE', 'RESCHEDULE_RETRYABLE',
  'CANCELLATION_NOT_ALLOWED', 'RESCHEDULE_NOT_ALLOWED', 'RESCHEDULE_CONFLICT',
  'APPOINTMENT_NOT_FOUND_OR_NOT_OWNED', 'SLOT_UNAVAILABLE', 'BUSINESS_HOURS_VIOLATION',
  'BUSINESS_HOURS_UNAVAILABLE'
]);
const lookup = source.deterministic_slot_lookup && typeof source.deterministic_slot_lookup === 'object'
  ? source.deterministic_slot_lookup
  : (facts.deterministic_slot_lookup && typeof facts.deterministic_slot_lookup === 'object'
      ? facts.deterministic_slot_lookup
      : (decision.deterministic_slot_lookup && typeof decision.deterministic_slot_lookup === 'object' ? decision.deterministic_slot_lookup : {}));
const availabilityLookup = lookup.executed === true;
const availabilityOutcome = String(
  source.availability_outcome || facts.availability_outcome || lookup.availability_outcome || ''
).trim().toUpperCase();
const rawAlternatives = Array.isArray(source.availability_alternatives)
  ? source.availability_alternatives
  : (Array.isArray(facts.availability_alternatives) ? facts.availability_alternatives : (Array.isArray(lookup.alternatives) ? lookup.alternatives : []));
const availabilityHasResult = availabilityLookup && Boolean(
  availabilityOutcome
  || rawAlternatives.length
  || lookup.result_code
  || lookup.slot_found === true
  || lookup.matched === true
);
const explicitExecutionEvidence = source.execution_completed === true
  || source.operation_completed === true
  || source.operation_finalized === true
  || source.execution_result?.execution_completed === true
  || source.execution_result?.operation_completed === true;
const operationIdentityEvidence = Boolean(source.operation_id || decision.operation_id || facts.operation_id);
const mutationEvidence = Boolean(source.mutation_status || source.operation_mutation_status || facts.mutation_status);
const childEvidence = source.child_contract_checked === true || facts.child_contract_checked === true;
const executionStatus = ['success', 'failed', 'failed_retryable', 'failed_final', 'completed', 'in_progress', 'conflict'].includes(status);
const mutationExecutionEvidence = operationIdentityEvidence && (mutationEvidence || childEvidence || executionStatus || terminalCodes.has(code));
// v2026-09-03 STRICT: Composer (Agent 2) only runs for genuine execution results or
// availability results with REAL alternatives to show. Conversational turns
// (greeting, missing fields, 'no slots' without alternatives) go straight to
// Agent 1's reply. Fixes the 'hallucinated date' bug where Composer invented
// days the patient never asked for.
const resultPhase = explicitExecutionEvidence
                  || mutationExecutionEvidence
                  || (availabilityLookup && rawAlternatives.length > 0);
const confirmedBookingContext = source.booking_context && typeof source.booking_context === 'object'
  ? source.booking_context
  : (facts.booking_context && typeof facts.booking_context === 'object' ? facts.booking_context : {});
const entities = facts.entities && typeof facts.entities === 'object' ? facts.entities : {};
const humanAlternatives = rawAlternatives.slice(0, 16).map((slot) => {
  const s = slot && typeof slot === 'object' ? slot : {};
  return {
    rank: s.rank ?? null,
    label: s.label || null,
    date: s.date || s.local_date || null,
    time: s.time || s.local_time || null,
    start_time: s.start_time || null,
    end_time: s.end_time || null,
    doctor_name: s.doctor_name || null,
    service_name: s.service_name || null,
    slot_status: s.slot_status || null
  };
});
const finalizedResult = source.operation_finalize_response && typeof source.operation_finalize_response === 'object'
  ? source.operation_finalize_response : {};
const sourceFacts = source.facts && typeof source.facts === 'object' ? source.facts : {};
const locationConfig = source.branch_location?.location_config && typeof source.branch_location.location_config === 'object'
  ? source.branch_location.location_config
  : (source.clinic_location && typeof source.clinic_location === 'object' ? source.clinic_location : (sourceFacts.branch_location?.location_config && typeof sourceFacts.branch_location.location_config === 'object' ? sourceFacts.branch_location.location_config : (sourceFacts.clinic_location && typeof sourceFacts.clinic_location === 'object' ? sourceFacts.clinic_location : {})));
const queuePathCandidate = source.queue_path || sourceFacts.queue_path || finalizedResult.queue_path || null;
const queueBaseUrl = String(locationConfig.queue_base_url || '').trim().replace(/\/+$/g, '');
const tenantQueueUrl = queuePathCandidate
  ? (/^https?:\/\//i.test(String(queuePathCandidate)) ? String(queuePathCandidate) : (queueBaseUrl ? `${queueBaseUrl}/${String(queuePathCandidate).replace(/^\/+/, '')}` : null))
  : null;
const normalizeLocation = (value) => {
  if (!value || typeof value !== 'object') return null;
  const cfg = value.location_config && typeof value.location_config === 'object' ? value.location_config : {};
  return {
    ...cfg,
    address: cfg.address || value.address || null,
    maps_url: cfg.maps_url || value.maps_url || value.google_maps_url || null,
    is_placeholder: cfg.is_placeholder === true || value.is_placeholder === true
  };
};
const normalizedBranchLocation = normalizeLocation(source.branch_location || sourceFacts.branch_location);
const normalizedClinicLocation = normalizeLocation(source.clinic_location || sourceFacts.clinic_location);
const operation = action || (availabilityLookup ? 'check_availability' : null);
const executionResult = {
  schema_version: 2,
  operation,
  response_code: code || null,
  operation_status: source.operation_status || facts.operation_status || null,
  success: source.success === true || facts.success === true,
  retryable: source.retryable === true || facts.retryable === true,
  mutation_status: source.mutation_status || source.operation_mutation_status || facts.mutation_status || null,
  booking_number: source.booking_number || facts.booking_number || finalizedResult.booking_number || confirmedBookingContext.booking_number || null,
  booking_id: source.booking_id || facts.booking_id || finalizedResult.booking_id || null,
  branch_id: source.branch_id || facts.branch_id || finalizedResult.branch_id || confirmedBookingContext.branch_id || null,
  queue_number: source.queue_number ?? facts.queue_number ?? finalizedResult.queue_number ?? null,
  queue_path: queuePathCandidate,
  queue_url: source.queue_url || facts.queue_url || finalizedResult.queue_url || tenantQueueUrl,
  queue_expires_at: source.queue_expires_at || facts.queue_expires_at || finalizedResult.queue_expires_at || null,
  child_contract_checked: source.child_contract_checked === true || facts.child_contract_checked === true,
  child_contract_valid: source.child_contract_valid === true || facts.child_contract_valid === true,
  availability_outcome: source.availability_outcome || facts.availability_outcome || lookup.availability_outcome || null,
  availability_result_code: lookup.result_code || source.error_code || facts.error_code || null,
  availability_verification_status: lookup.verification_status || null,
  availability_search_mode: source.search_mode || facts.search_mode || lookup.search_mode || null,
  availability_nearby_search: source.nearby_search === true || facts.nearby_search === true || lookup.nearby_search === true,
  availability_window_start: source.search_window_start || facts.search_window_start || lookup.search_window_start || null,
  availability_window_end: source.search_window_end || facts.search_window_end || lookup.search_window_end || null,
  availability_alternatives: humanAlternatives,
  proposed_reply: source.proposed_reply || facts.proposed_reply || source.deterministic_fallback_reply || null,
  doctor_name: confirmedBookingContext.doctor_name || entities.doctor_name || null,
  service_name: confirmedBookingContext.service_name || entities.service_name || null,
  date: confirmedBookingContext.date || lookup.requested_date || null,
  date_natural: naturalDateText063(confirmedBookingContext.date || lookup.requested_date) || null,
  time: confirmedBookingContext.time || lookup.requested_time || null,
  time_natural: naturalTimeText063(confirmedBookingContext.time || lookup.requested_time) || null,
  patient_name: confirmedBookingContext.patient_name || facts.patient_name || null,
  patient_phone: confirmedBookingContext.patient_phone || facts.patient_phone || null,
  patient_age: confirmedBookingContext.patient_age ?? facts.patient_age ?? null,
  patient_address: confirmedBookingContext.patient_address || facts.patient_address || null,
  clinic_name: facts.clinic_name || source.clinic_name || null,
  branch_location: normalizedBranchLocation,
  clinic_location: normalizedClinicLocation,
  error: source.error || source.error_code || lookup.result_code || null
};
// Phase 5: directive-driven reply brief — the only conversational guidance Model 2 gets.
const personaContext = readNode('Build Clinic Persona Context (Deterministic)');
const persona = personaContext.clinic_persona && typeof personaContext.clinic_persona === 'object' ? personaContext.clinic_persona : {};
const turnDirective = (decision.turn_directive && typeof decision.turn_directive === 'object' ? decision.turn_directive : null)
  || (source.turn_directive && typeof source.turn_directive === 'object' ? source.turn_directive : null);
const liveOffer = source.presented_offer && typeof source.presented_offer === 'object' ? source.presented_offer
  : (source.pending_offer && typeof source.pending_offer === 'object' ? source.pending_offer : null);
const offerAlternatives = liveOffer && Array.isArray(liveOffer.alternatives) ? liveOffer.alternatives : [];
const briefAlternatives = (offerAlternatives.length ? offerAlternatives : rawAlternatives).slice(0, 4).map((slot) => {
  const s = slot && typeof slot === 'object' ? slot : {};
  return { rank: s.rank ?? null, label: s.label || null, date: s.local_date || s.date || null, time: s.local_time || s.time || null };
});
const confirmTarget = decision.confirmation_target && typeof decision.confirmation_target === 'object' ? decision.confirmation_target
  : (source.confirmation_target && typeof source.confirmation_target === 'object' ? source.confirmation_target : null);
const patientReview = decision.patient_data_review && typeof decision.patient_data_review === 'object' ? decision.patient_data_review
  : (source.patient_data_review && typeof source.patient_data_review === 'object' ? source.patient_data_review : null);
const replyBrief = {
  schema_version: 1,
  response_code: code || null,
  dialect: persona.dialect || 'ar',
  directive: turnDirective,
  alternatives: briefAlternatives.length ? briefAlternatives : null,
  confirmation_request: confirmTarget ? {
    action: confirmTarget.action || action || null,
    doctor_name: confirmTarget.doctor_name || executionResult.doctor_name || null,
    service_name: confirmTarget.service_name || executionResult.service_name || null,
    date: confirmTarget.date || null,
    date_natural: naturalDateText063(confirmTarget.date) || null,
    time: confirmTarget.time || null,
    time_natural: naturalTimeText063(confirmTarget.time) || null,
    appointment_type: confirmTarget.appointment_type || null,
    booking_number: confirmTarget.booking_number || executionResult.booking_number || null,
    appointment_id: confirmTarget.appointment_id || null
  } : null,
  patient_review: patientReview && patientReview.fields ? { fields: patientReview.fields, status: patientReview.status || null } : null,
  missing_human_fields: Array.isArray(source.missing_human_fields) ? source.missing_human_fields : (Array.isArray(decision.missing_human_fields) ? decision.missing_human_fields : []),
  locked_fields: turnDirective && Array.isArray(turnDirective.locked_fields) ? turnDirective.locked_fields : []
};
return [{ json: { ...source, single_agent_phase: resultPhase ? 'result' : 'understand', execution_result: executionResult, reply_brief: replyBrief } }];