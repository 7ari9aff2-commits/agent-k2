

// Response Policy v3 — Facts only (DeepSeek #2 generates the reply)
// This node produces safe execution facts for DeepSeek #2.
// NO conversational reply generation here.
// NO undefined variable references.
// Deterministic result-based fallback only (for DeepSeek #2 failure).

// Read the result from the operation that actually ran.
// Claim-blocked/replay decisions must use the local decision envelope, not the stale upstream decision.
const localDecision = ($json && $json.system_decision && typeof $json.system_decision === 'object') ? $json.system_decision : {};
let upstreamDecision = {};
try { upstreamDecision = $('System Orchestrator (Policy)').first().json.system_decision || {}; } catch {}
const hasClaimOutcome = Boolean($json && ($json.operation_claim_decision || $json.operation_claim_blocked || $json.operation_replay));
const decision = hasClaimOutcome ? (Object.keys(localDecision).length ? localDecision : upstreamDecision) : (Object.keys(upstreamDecision).length ? upstreamDecision : localDecision);
const readNode = (name) => { try { const f = $(name).first(); return (f && f.json) || {}; } catch { return {}; } };
const builderContextForRecovery = readNode('Build Clinic Persona Context (Deterministic)');
const errorFollowupContext = builderContextForRecovery.error_followup_context && typeof builderContextForRecovery.error_followup_context === 'object' ? builderContextForRecovery.error_followup_context : {};
const errorFollowupActive = errorFollowupContext.active === true;
const hasData = (value) => value && typeof value === 'object' && Object.keys(value).length > 0;
const finalized = readNode('Merge Operation Completion');
const action = String(decision.action || decision.confirmation_target?.action || '').toLowerCase();
const actionNodeName = action === 'cancel_appointment'
  ? 'Execute Approved Cancel Appointment'
  : action === 'reschedule_appointment'
    ? 'Execute Approved Reschedule Appointment'
    : action === 'create_appointment'
      ? 'Execute Approved Create Appointment'
      : null;
const actionExecution = actionNodeName ? readNode(actionNodeName) : {};
let execution = hasData(finalized) ? finalized : actionExecution;
if (!hasData(execution)) execution = $json || {};

const executionError = execution.error || execution.errorResponse || execution.data?.error || null;
const errorText = JSON.stringify(executionError || execution);
const slotUnavailable = /P0001|slot unavailable|already booked|الفتحة غير متاحة|تم حجزها بالفعل|الموعد غير متاح|الموعد محجوز/i.test(errorText);
const rawSuccess = execution.success === true || execution.ok === true || execution.data?.success === true;
const rawAppointmentId = execution.appointment_id || execution.data?.appointment_id || execution.id || decision.appointment_id || null;

const modelCallFailed = $json.model_call_failed === true
  || $json._normalization?.model_call_failed === true
  || decision.model_call_failed === true
  || decision.contract?.model_call_failed === true;
let responseCode = modelCallFailed ? 'PROVIDER_UNAVAILABLE' : (decision.response_code || 'CONVERSATION_ONLY');
let operationStatus = modelCallFailed ? 'failed_retryable' : 'pending';
let retryable = modelCallFailed;

// ── Read contract from Orchestrator ──
const contract = decision.contract || $json.contract || {};
const turn = contract.turn || {};
const entities = contract.entities || {};
const nextStep = contract.next_step || {};
const query = contract.query || {};
const operationProposal = contract.operation_proposal || {};
const operationType = String(operationProposal.type || '').toLowerCase();

const turnIntent = String(turn.intent || 'other').toLowerCase();
const certainty = String(turn.certainty || 'uncertain').toLowerCase();
const relationToPrevious = String(turn.relation_to_previous_turn || 'none').toLowerCase();
const nextStepType = String(nextStep.type || 'none').toLowerCase();
const nextStepField = nextStep.field || null;
const normalizedForRecovery = (() => { try { const r = $('Validate Repaired Contract (Deterministic)').first().json; if (r && r._contract_status === 'VALID') return r; } catch (_) {} return readNode('Normalize Agent Output (Deterministic)'); })();
const recoveryRestoredContext = normalizedForRecovery.error_followup_recovered === true || normalizedForRecovery.model_call_status === 'ERROR_FOLLOWUP_RECOVERED';
const recoveryAgentReply = String(normalizedForRecovery.agent_reply || normalizedForRecovery.contract?.reply || '').trim();
const recoveryGenericReply = /^(?:حياك الله|اهلا|أهلاً|أهلًا|مرحبا|مرحباً|مرحبًا|هلا)(?:[،،.!؟? ]|$)/iu.test(recoveryAgentReply);
const recoverySchedulingEvidence = Boolean(entities.date || entities.time || entities.service_name || (!recoveryRestoredContext && entities.doctor_name) || nextStepField === 'date' || nextStepField === 'time' || ['booking_request','booking_continuation','availability_inquiry','correction'].includes(String(turn.intent || '').toLowerCase()));
const errorFollowupNeedsFallback = errorFollowupActive && !modelCallFailed && !recoverySchedulingEvidence && (!recoveryAgentReply || recoveryGenericReply || ['unclear','other','small_talk'].includes(String(turn.intent || '').toLowerCase()));
const currentPatientMessage = String(readNode('Normalize & Validate').message_text || '').trim();
const isStandaloneGreeting = /^(?:السلام عليكم(?: ورحمة الله وبركاته)?|وعليكم السلام(?: ورحمة الله وبركاته)?|هلا(?: ومرحبا)?|مرحبا|مرحباً|مرحبًا|اهلا|أهلا|أهلًا|صباح الخير|مساء الخير)[\s.!؟،,]*$/iu.test(currentPatientMessage);

// ── Query info ──
const queryType = String(query?.type || '').toLowerCase();
const queryIsAvailability = queryType === 'availability'
  || operationType === 'check_availability'
  || nextStepType === 'show_availability'
  || decision.availability_inquiry === true
  || $json.availability_inquiry === true;
const queryScope = query?.scope || null;

// ── Booking context (needed before safeEntities) ──
const bookingContext = decision.booking_context || $json.booking_context || {};
const bookingNumber = String(execution.booking_number || execution.data?.booking_number || execution.operation_finalize_response?.booking_number || decision.booking_number || decision.booking_context?.booking_number || $json.booking_number || '').trim() || null;
if (bookingNumber && !bookingContext.booking_number) bookingContext.booking_number = bookingNumber;
const policyPriorReference = entities.references_prior_conversation === true
  || String(entities.references_prior_conversation || '').trim().toLowerCase() === 'true'
  || entities.references_prior_conversation === 1;
const policyOperationName = String($json.active_operation || $json.operation_action || decision.active_operation || execution.active_operation || '').trim().toLowerCase();
const policyOperationState = String($json.operation_state || $json.operation_status || decision.operation_state || execution.operation_state || '').trim().toUpperCase();
const policyHasLiveOperation = ['create_appointment','cancel_appointment','reschedule_appointment'].includes(policyOperationName)
  && !['COMPLETED','CANCELLED','FAILED_FINAL','IDLE',''].includes(policyOperationState);
const suppressHistoricalBookingContext = turnIntent === 'small_talk'
  && !policyPriorReference
  && !policyHasLiveOperation
  && !decision.confirmation_target;
if (suppressHistoricalBookingContext) {
  for (const field of ['doctor_id','doctor_name','service_id','service_name','slot_id','date','time']) bookingContext[field] = null;
}
// ── FIX v12 (2026-08-19, root of the repeated-questions loop): the raw booking_context carried
// stale names ('احمد', old service IDs) from previous turns, while the clinic catalog's fully
// resolved canonical names (e.g. 'د. أحمد الحنكشلاوي') sit in deterministic_identity_resolution
// (doctor_matches/service_matches). Promote the canonical names into booking_context so every
// downstream node (BRP, Build Persistent Conversation State, retry merge) stores the REAL name.
// Works for ALL clinics and ALL doctors — catalog-driven, nothing hardcoded.
(function () {
  try {
    const idr = execution.deterministic_identity_resolution || $json.deterministic_identity_resolution;
    if (idr && typeof idr === 'object') {
      const dm = Array.isArray(idr.doctor_matches) ? idr.doctor_matches : [];
      if (dm.length && dm[0]) {
        if (dm[0].id && !bookingContext.doctor_id) bookingContext.doctor_id = dm[0].id;
        const dn = String(dm[0].doctor_name || dm[0].name || '').trim();
        if (dn && !bookingContext.doctor_name) bookingContext.doctor_name = dn;
      } else if (idr.doctor_resolved === true) {
        const requested = String(idr.requested_doctor_name || '').trim();
        if (requested && !bookingContext.doctor_name) bookingContext.doctor_name = requested;
      }
      const sm = Array.isArray(idr.service_matches) ? idr.service_matches : [];
      if (sm.length && sm[0]) {
        if (sm[0].id && !bookingContext.service_id) bookingContext.service_id = sm[0].id;
        const sn = String(sm[0].service_name || sm[0].name || '').trim();
        if (sn && !bookingContext.service_name) bookingContext.service_name = sn;
      }
    }
  } catch (e) {}
})();

// ── Entities (safe facts) — from contract entities OR bookingContext ──
const safeEntities = {
  doctor_name: entities.doctor_name || bookingContext.doctor_name || null,
  service_name: entities.service_name || bookingContext.service_name || null,
  date: entities.date || bookingContext.date || null,
  time: entities.time || bookingContext.time || null,
  branch_id: entities.branch_id || bookingContext.branch_id || null,
  branch_name: entities.branch_name || bookingContext.branch_name || null
};

// ── Missing fields (for DeepSeek #2 to know what to ask) ──
// FIX: Never rewrite Orchestrator's missing_fields with an invented field (booking_type does not exist
// in the render label dictionary and causes DeepSeek #2 to ask about the WRONG field, e.g. "time" instead of doctor).
// Read missing fields from the Orchestrator only — single source of truth.
const missingHuman = Array.isArray(decision.missing_human_fields) ? decision.missing_human_fields : (Array.isArray(decision.missing_fields) ? decision.missing_fields : []);
const nextBestMissing = decision.next_best_missing_human_field || missingHuman[0] || null;

// ── FIX: Transparent expired-booking handling ──
// When the Orchestrator detected a greeting during/after an abandoned booking, it attaches
// prior_expired_booking (doctor/service/date/time of the old abandoned booking). Pass it through
// verbatim so DeepSeek #2 can produce the transparent "old booking expired, let's start fresh" reply.
const priorExpiredBooking = decision.prior_expired_booking && typeof decision.prior_expired_booking === 'object' ? decision.prior_expired_booking : null;
const greetingRestart = !isStandaloneGreeting && (decision.greeting_restart === true || (decision.new_booking_restart === true && decision.response_code === 'NEW_BOOKING_STARTED' && priorExpiredBooking));
const referencesPriorConversation = entities.references_prior_conversation === true
  || String(entities.references_prior_conversation || '').trim().toLowerCase() === 'true';
const suppressPriorDraftOnFreshBooking = decision.new_booking_restart === true && !referencesPriorConversation;
const humanLabels = { doctor_or_service: 'اسم الطبيب أو نوع الكشف', doctor: 'اسم الطبيب', service: 'نوع الكشف', date: 'اليوم المناسب', time: 'الوقت المناسب', patient_name: 'اسم المريض', patient_phone: 'رقم التواصل', patient_age: 'العمر', patient_address: 'العنوان' };

// ── Confirmation target ──
const confirmationTarget = decision.confirmation_target && typeof decision.confirmation_target === 'object' ? decision.confirmation_target : null;
const confirmationAction = String(confirmationTarget?.action || decision.action || '').toLowerCase();
const confirmationState = decision.confirmation_state || null;
const destructiveTargetPresent = Boolean(confirmationTarget && ['create_appointment','cancel_appointment','reschedule_appointment'].includes(confirmationAction));

// Tenant-scoped location facts. Prefer the branch attached to the current booking
// and never guess a branch when multiple active branches exist.
const clinicContext = readNode('Get Clinic Context');
const clinicLocation = clinicContext.clinic_location_config && typeof clinicContext.clinic_location_config === 'object'
  ? clinicContext.clinic_location_config
  : {};
const branchDirectory = Array.isArray(clinicContext.branch_directory) ? clinicContext.branch_directory : [];
const branchIdCandidate = entities.branch_id || bookingContext.branch_id || confirmationTarget?.branch_id
  || execution.branch_id || execution.data?.branch_id || null;
const selectedBranch = branchDirectory.find((branch) => String(branch?.branch_id || '') === String(branchIdCandidate || ''))
  || (branchDirectory.length === 1 ? branchDirectory[0] : null);
const branchLocation = selectedBranch && typeof selectedBranch === 'object'
  ? {
      branch_id: selectedBranch.branch_id || null,
      branch_name: selectedBranch.branch_name || selectedBranch.name || null,
      address: selectedBranch.address || null,
      phone: selectedBranch.phone || null,
      location_config: selectedBranch.location_config && typeof selectedBranch.location_config === 'object' ? selectedBranch.location_config : {}
    }
  : null;

// Queue link fields are returned by create_appointment_with_queue_link. Build the
// public URL only from the tenant-scoped clinic configuration and the opaque path.
const queuePath = String(execution.queue_path || execution.data?.queue_path || execution.operation_finalize_response?.queue_path || '').trim() || null;
const queueExpiresAt = execution.queue_expires_at || execution.data?.queue_expires_at || execution.operation_finalize_response?.queue_expires_at || null;
const queueNumber = execution.queue_number ?? execution.data?.queue_number ?? execution.operation_finalize_response?.queue_number ?? null;
const queueBaseUrl = String(clinicLocation.queue_base_url || '').trim().replace(/\/+$/, '');
const buildQueueUrl = (base, path) => {
  if (!base || !path) return null;
  const tokenMatch = String(path).match(/\/queue\/([^/?#]+)$/i);
  if (/\/queue$/i.test(base) && tokenMatch) return `${base}/${tokenMatch[1]}`;
  return `${base}${String(path).startsWith('/') ? '' : '/'}${path}`;
};
const queueUrl = buildQueueUrl(queueBaseUrl, queuePath);


// (bookingContext already declared above)

// ── Deterministic slot lookup ──
const deterministicLookup = (execution.deterministic_slot_lookup && typeof execution.deterministic_slot_lookup === 'object')
  ? execution.deterministic_slot_lookup
  : (($json.deterministic_slot_lookup && typeof $json.deterministic_slot_lookup === 'object') ? $json.deterministic_slot_lookup : (decision.deterministic_slot_lookup && typeof decision.deterministic_slot_lookup === 'object' ? decision.deterministic_slot_lookup : {}));
const deterministicAvailabilityOutcome = String(deterministicLookup.availability_outcome || '').toLowerCase();
const deterministicCode = String(deterministicLookup.result_code || '').toUpperCase();
const deterministicUnavailable = deterministicAvailabilityOutcome === 'verified_unavailable' || ['NO_AVAILABLE_SLOTS','FULLY_BOOKED','DOCTOR_NOT_WORKING_THAT_DAY','SLOT_UNAVAILABLE','REQUESTED_TIME_NOT_AVAILABLE','NO_AVAILABLE_SLOTS_IN_WINDOW'].includes(deterministicCode);
const deterministicAuthorityError = deterministicAvailabilityOutcome === 'authority_error' || deterministicCode === 'AUTHORITY_ERROR' || deterministicCode === 'AVAILABILITY_SOURCE_ERROR';

const availabilityAlternatives = Array.isArray(deterministicLookup.alternatives)
  ? deterministicLookup.alternatives.slice(0, 4)
  : (Array.isArray(deterministicLookup.nearest_slots) ? deterministicLookup.nearest_slots.slice(0, 4) : []);
const alternativeLabels = availabilityAlternatives.map((slot) => {
  if (slot && typeof slot.label === 'string' && slot.label.trim()) return slot.label.trim();
  return [slot?.local_date || '', slot?.local_time || ''].filter(Boolean).join(' ');
}).filter(Boolean);

// ── Child execution results ──
const childExecutionRequired = decision.allowed === true && new Set(['create_appointment','cancel_appointment','reschedule_appointment']).has(confirmationAction);
const executionHasNoError = !executionError;
const finalizeEnvelope = execution.operation_finalize_response && typeof execution.operation_finalize_response === 'object'
  ? execution.operation_finalize_response
  : (($json.operation_finalize_response && typeof $json.operation_finalize_response === 'object') ? $json.operation_finalize_response : null);
// A child contract is valid only when the validator explicitly says so. The
// absence of a SQL error is not proof that the child returned the required schema.
const childContractChecked = childExecutionRequired
  ? (execution.child_contract_checked === true || finalizeEnvelope?.child_contract_checked === true)
  : true;
const childContractValid = childExecutionRequired
  ? ((execution.child_contract_valid === true || finalizeEnvelope?.child_contract_valid === true)
      && finalizeEnvelope?.child_contract_valid !== false)
  : true;
const success = childExecutionRequired ? (childContractChecked && childContractValid && executionHasNoError) : rawSuccess;
const appointmentId = childExecutionRequired && (!childContractChecked || !childContractValid) ? null : rawAppointmentId;

// ── Business time ──
const businessTimeBlocked = execution.business_time_checked === true && execution.business_time_allowed === false;
const businessTimeCode = String(execution.business_time_code || execution.business_time_error_code || '').toUpperCase();

// ── Time context ──
const canonicalTimeContext = execution.canonical_time_context || execution.time_context || {};
const canonicalTimezone = String(canonicalTimeContext.timezone || '');

// ── Escalation ──
const escalationRequested = decision.response_code === 'HANDOFF_REQUIRED' && decision.escalation_requested === true;
const handoffReason = decision.handoff_reason || upstreamDecision.handoff_reason || null;

// ── Non-scheduling turn detection ──
const __hasBookingEntity = Boolean(
  entities.doctor_name || entities.doctor_id || entities.service_name || entities.service_id
  || entities.appointment_type || entities.date || entities.time || entities.branch_name
  || entities.branch_id || entities.slot_id || entities.appointment_id
  || entities.expected_old_slot_id || entities.new_slot_id
);
const __hasPatientEntity = Boolean(
  entities.patient_name || entities.patient_phone || entities.patient_age || entities.patient_address
);
const __allBookingEntitiesEmpty = !__hasBookingEntity && !__hasPatientEntity;
// A scheduling turn that contains appointment type or patient data is still part
// of the booking contract even if no doctor/service/date entity is present.
// Do not let the generic non-scheduling classifier override missing-field policy.
const isNonSchedulingTurn = decision.non_scheduling_turn === true
  && !__hasBookingEntity && !__hasPatientEntity && !missingHuman.length;
// DLG-12: empty booking_request / cancellation_request / reschedule_request keep the Orchestrator's
// MISSING_REQUIRED_FIELDS decision; only small_talk and other/unclear are conversation-only here.
const inferredNonSchedulingTurn = turnIntent === 'small_talk'
  || (['other','unclear',''].includes(turnIntent) && !confirmationTarget);

// ── Decision logic ──
// No reply generation — only facts + response_code for DeepSeek #2

// Escalation
if (modelCallFailed) {
  responseCode = 'PROVIDER_UNAVAILABLE';
  operationStatus = 'failed_retryable';
  retryable = true;
}
// Escalation
else if (escalationRequested) {
  responseCode = 'HANDOFF_REQUIRED';
  operationStatus = 'pending';
}
// New booking restart is only a status when the deterministic decision itself
// selected NEW_BOOKING_STARTED. Never let this metadata overwrite a fresh
// availability result, confirmation target, or approved execution decision.
else if (decision.new_booking_restart === true && responseCode === 'NEW_BOOKING_STARTED') {
  responseCode = 'NEW_BOOKING_STARTED';
  operationStatus = 'collecting_details';
  retryable = false;
}
// Availability inquiry
else if (queryIsAvailability && !destructiveTargetPresent) {
  if (deterministicAuthorityError) {
    responseCode = 'AVAILABILITY_SOURCE_ERROR';
    operationStatus = 'failed_retryable';
    retryable = true;
  } else if (deterministicUnavailable) {
    const availabilityCode = ['NO_AVAILABLE_SLOTS','FULLY_BOOKED','DOCTOR_NOT_WORKING_THAT_DAY','SLOT_UNAVAILABLE','REQUESTED_TIME_NOT_AVAILABLE','NO_AVAILABLE_SLOTS_IN_WINDOW'].includes(deterministicCode)
      ? deterministicCode
      : 'SLOT_UNAVAILABLE';
    responseCode = availabilityCode;
    operationStatus = 'collecting_details';
    retryable = false;
  } else if (decision.allowed === true || decision.response_code === 'AVAILABILITY_RESULTS') {
    responseCode = 'AVAILABILITY_RESULTS';
    operationStatus = 'collecting_details';
  } else if (decision.response_code === 'MISSING_REQUIRED_FIELDS') {
    responseCode = 'MISSING_REQUIRED_FIELDS';
    operationStatus = 'collecting_details';
  } else {
    responseCode = 'AVAILABILITY_LOOKUP_REQUIRED';
    operationStatus = 'collecting_details';
  }
}
// Patient data review has priority over the generic non-scheduling classifier.
// A model may call the turn booking_continuation while the deterministic layer still
// needs name/phone/age/address. Never downgrade this state to CONVERSATION_ONLY.
else if (responseCode === 'PATIENT_DATA_CONFIRMATION_REQUIRED'
  || (decision.action === 'create_appointment' && decision.patient_data_complete === false && !childExecutionRequired)) {
  responseCode = 'PATIENT_DATA_CONFIRMATION_REQUIRED';
  operationStatus = 'collecting_details';
  retryable = false;
}
// A deterministic booking confirmation target has priority over the generic
// small-talk classifier. The target is only a pending confirmation request here;
// execution remains blocked until the patient sends the affirmative turn.
else if (confirmationTarget
  && confirmationTarget.confirmation_id
  && ['create_appointment','cancel_appointment','reschedule_appointment'].includes(confirmationAction)
  && !childExecutionRequired) {
  responseCode = 'CONFIRMATION_REQUIRED';
  operationStatus = 'awaiting_confirmation';
  retryable = false;
}
// Narrow technical recovery: only override an empty, generic, or unrelated Agent 1 result.
else if (errorFollowupNeedsFallback) {
  responseCode = 'BOOKING_RECOVERY_EXPLANATION';
  operationStatus = 'collecting_details';
  retryable = false;
}
// FAQ / Doctor Service / Price / Small talk — conversation only (DeepSeek #2 generates reply)
else if (isNonSchedulingTurn || inferredNonSchedulingTurn) {
  responseCode = 'CONVERSATION_ONLY';
  operationStatus = 'idle';
}
// Child execution invalid
else if (childExecutionRequired && (!childContractChecked || !childContractValid)) {
  // If there are missing human fields, try to collect them instead of giving up
  if (missingHuman && missingHuman.length > 0) {
    responseCode = 'MISSING_REQUIRED_FIELDS';
    operationStatus = 'collecting_details';
    retryable = true;
  } else {
    responseCode = 'CHILD_CONTRACT_INVALID';
    operationStatus = 'failed_final';
    retryable = false;
  }
}
// Business time blocked
else if (businessTimeBlocked) {
  responseCode = ['BUSINESS_HOURS_VIOLATION','BUSINESS_HOURS_UNAVAILABLE'].includes(businessTimeCode) ? businessTimeCode : 'BUSINESS_HOURS_VIOLATION';
  operationStatus = businessTimeCode === 'BUSINESS_HOURS_UNAVAILABLE' ? 'failed_final' : 'collecting_details';
  retryable = false;
}
// Execution success/failure
else if (decision.allowed && decision.action === 'create_appointment') {
  if (success) {
    responseCode = 'APPOINTMENT_CREATED';
    operationStatus = 'success';
  } else {
    responseCode = slotUnavailable ? 'SLOT_UNAVAILABLE' : (execution.error_code || execution.data?.error_code || 'APPOINTMENT_CREATION_FAILED');
    retryable = responseCode !== 'SLOT_UNAVAILABLE';
    operationStatus = 'failed';
  }
}
else if (decision.allowed && decision.action === 'reschedule_appointment') {
  const code = execution.response_code || execution.data?.response_code || execution.error_code || execution.data?.error_code || null;
  const replayOrSuccess = success && ['RESCHEDULE_COMPLETED','IDEMPOTENT_REPLAY'].includes(code || 'RESCHEDULE_COMPLETED');
  if (replayOrSuccess) {
    responseCode = code === 'IDEMPOTENT_REPLAY' ? 'IDEMPOTENT_REPLAY' : 'RESCHEDULE_COMPLETED';
    operationStatus = 'success';
  } else {
    responseCode = code || 'RESCHEDULE_RETRYABLE';
    retryable = execution.retryable === true || responseCode === 'RESCHEDULE_RETRYABLE';
    operationStatus = retryable ? 'failed_retryable' : 'failed';
  }
}
else if (decision.allowed && decision.action === 'cancel_appointment') {
  const cancelResponseCode = execution.response_code || execution.data?.response_code || null;
  const cancelSuccess = success && ['CANCEL_COMPLETED','IDEMPOTENT_REPLAY'].includes(cancelResponseCode || 'CANCEL_COMPLETED');
  if (cancelSuccess) {
    responseCode = cancelResponseCode === 'IDEMPOTENT_REPLAY' ? 'IDEMPOTENT_REPLAY' : 'CANCEL_COMPLETED';
    operationStatus = 'success';
  } else {
    responseCode = cancelResponseCode || (execution.error_code || execution.data?.error_code) || 'CANCEL_RETRYABLE';
    retryable = execution.retryable === true || responseCode === 'CANCEL_RETRYABLE';
    operationStatus = retryable ? 'failed_retryable' : 'failed';
  }
}
// Patient data review is a collecting-details state, not a generic conversation.
else if (responseCode === 'PATIENT_DATA_CONFIRMATION_REQUIRED') {
  operationStatus = 'collecting_details';
}
// Confirmation required
else if (responseCode === 'CONFIRMATION_REQUIRED') {
  if (confirmationTarget) {
    operationStatus = 'awaiting_confirmation';
    // Stamp delivery metadata
    const nowIso = new Date().toISOString();
    const ttl = Number.isFinite(Number(confirmationTarget.confirmation_ttl_seconds || 600)) ? Math.max(60, Number(confirmationTarget.confirmation_ttl_seconds || 600)) : 600;
    const expires = new Date(Date.now() + ttl * 1000).toISOString();
    confirmationTarget.confirmation_delivery_status = 'sent';
    confirmationTarget.confirmation_delivery_recorded_at = confirmationTarget.confirmation_delivery_recorded_at || nowIso;
    confirmationTarget.expires_at = expires;
  } else {
    responseCode = 'MISSING_REQUIRED_FIELDS';
    operationStatus = 'collecting_details';
  }
}
// Confirmation approved (will execute)
else if (['EXECUTE_APPROVED','CANCEL_APPROVED','RESCHEDULE_APPROVED'].includes(responseCode)) {
  operationStatus = 'executing';
}
// Missing fields / confidence review
else if (responseCode === 'MISSING_REQUIRED_FIELDS' || responseCode === 'CONFIDENCE_REVIEW_REQUIRED' || responseCode === 'CONFIRMATION_INCOMPLETE') {
  operationStatus = 'collecting_details';
}
// Handoff
else if (responseCode === 'HANDOFF_REQUIRED') {
  operationStatus = 'pending';
}
// Default — conversation only
else {
  responseCode = 'CONVERSATION_ONLY';
  operationStatus = 'idle';
}

// Defensive current-message guard: the renderer receives conversation-only facts for a standalone greeting.
if (isStandaloneGreeting && !modelCallFailed) {
  responseCode = 'CONVERSATION_ONLY';
  operationStatus = 'idle';
  retryable = false;
}

// ── Build safe facts for DeepSeek #2 ──
const safeFacts = {
  turn_intent: turnIntent,
  certainty,
  relation_to_previous_turn: relationToPrevious,
  response_code: responseCode,
  operation_status: operationStatus,
  conversation_stage: decision.conversation_stage || null,
  required_next_step: decision.required_next_step || null,
  next_step_type: nextStepType,
  next_step_field: nextStepField,
  missing_human_fields: missingHuman,
  next_best_missing_human_field: nextBestMissing,
  entities: safeEntities,
  branch_id: branchLocation?.branch_id || safeEntities.branch_id || null,
  branch_name: branchLocation?.branch_name || safeEntities.branch_name || null,
  branch_location: branchLocation,
  clinic_location: clinicLocation,
  booking_context: bookingContext,
  confirmation_target: confirmationTarget,
  confirmation_state: confirmationState,
  confirmation_action: confirmationAction,
  // Internal appointment UUID is withheld from the Composer facts envelope.
  appointment_id: null,
  booking_number: bookingNumber,
  queue_number: queueNumber,
  queue_path: queuePath,
  queue_url: queueUrl,
  queue_expires_at: queueExpiresAt,
  success,
  retryable,
  escalation_requested: escalationRequested,
  handoff_reason: handoffReason,
  query_type: queryType,
  query_scope: queryScope,
  availability_outcome: deterministicUnavailable ? 'unavailable' : (deterministicAuthorityError ? 'error' : (deterministicLookup.availability_outcome || ($json.availability_outcome || (deterministicLookup.matched ? 'matched' : null)))),
  availability_alternatives: alternativeLabels,
  timezone: canonicalTimezone,
  clinic_name: String(execution.clinic_name || execution.clinic?.name || '').trim() || (function(){ try { var ws = $('Get Conversation State').first(); if (ws && ws.json && ws.json.state_data) { var sd = typeof ws.json.state_data === 'string' ? JSON.parse(ws.json.state_data) : ws.json.state_data; return String(sd.facts?.clinic?.name || sd.clinic_name || '').trim() || null; } } catch(e) {} return null; })() || null,
  patient_name: String(execution.patient_name || '').trim() || null,
  patient_phone: String(execution.patient_phone || '').trim() || null,
  patient_age: execution.patient_age ?? null,
  patient_address: String(execution.patient_address || '').trim() || null,
  patient_data_review: execution.patient_data_review || $json.patient_data_review || null,
  non_scheduling_turn: isNonSchedulingTurn,
  patient_message: String(readNode('Normalize & Validate').message_text || '').trim() || null,
  // FIX: transparent expired-booking facts for DeepSeek #2
  prior_expired_booking: priorExpiredBooking,
  greeting_restart: greetingRestart,
  // FIX v7: deterministic doctor resolution info (needed by Extract Single Agent Reply post-check)
  deterministic_identity_resolution: (function () {
    try {
      const r = (execution.deterministic_identity_resolution || $json.deterministic_identity_resolution);
      if (!r || typeof r !== 'object') return {};
      const matches = Array.isArray(r.doctor_matches) ? r.doctor_matches : [];
      return {
        doctor_resolved: r.doctor_resolved === true,
        requested_doctor_name: String(r.requested_doctor_name || '').trim() || String((matches[0] && matches[0].doctor_name) || '').trim(),
        doctor_matches: matches.slice(0, 5),
        _asked: String(r.requested_doctor_name || '').trim()
      };
    } catch (e) { return {}; }
  })()
};

// ── Deterministic fallback reply (only if DeepSeek #2 fails) ──
// This is NOT sent directly — it's passed to DeepSeek #2 as a safety net
const fallbackByCode = {
  'APPOINTMENT_CREATED': (function () {
    const lines = [];
    const name = String(execution.patient_name || '').trim();
    const phone = String(execution.patient_phone || '').trim();
    const booking = String(bookingNumber || '').trim();
    const location = branchLocation?.location_config || clinicLocation || {};
    const address = String(location.address || location.label || '').trim();
    const maps = String(location.maps_url || '').trim();
    if (name) lines.push(`الاسم ${name}`);
    if (phone) lines.push(`رقم الهاتف ${phone}`);
    if (booking) lines.push(`رقم الحجز ${booking}`);
    if (address || maps) lines.push(`لوكيشن العيادة ${[address, maps].filter(Boolean).join(' ')}`);
    if (queueUrl) lines.push(`لينك الكيو ${queueUrl}`);
    return lines.join('\n') || 'تم تأكيد حجزك بنجاح';
  })(),
  'CANCEL_COMPLETED': 'تم إلغاء الحجز بنجاح.',
  'CANCELLATION_NOT_ALLOWED': 'لا يمكن إلغاء هذا الحجز في حالته الحالية.',
  'APPOINTMENT_NOT_FOUND_OR_NOT_OWNED': 'الحجز غير موجود أو لا ينتمي لهذا المريض.',
  'IDEMPOTENT_REPLAY': 'تمت معالجة هذا الطلب من قبل ولم أكرر العملية.',
  'CANCEL_RETRYABLE': 'تعذر إلغاء الحجز حاليًا. أقدر أعيد المحاولة.',
  'RESCHEDULE_NOT_ALLOWED': 'لا يمكن تعديل هذا الحجز في حالته الحالية.',
  'RESCHEDULE_RETRYABLE': 'تعذر تعديل الحجز حاليًا. أقدر أعيد المحاولة.',
  'CHILD_CONTRACT_INVALID': 'تعذر التحقق من نتيجة العملية ويحتاج الأمر إلى مراجعة موظف الاستقبال.',
  'PROVIDER_UNAVAILABLE': 'تعذر معالجة الرسالة حاليًا بسبب مشكلة مؤقتة. حاول مرة ثانية.',
  'OPERATION_INCONCLUSIVE': 'تعذر التحقق بأمان من نتيجة محاولة سابقة، لذلك لم أعد تنفيذ العملية تلقائياً. يحتاج الأمر إلى مراجعة موظف الاستقبال.',
  'RESCHEDULE_COMPLETED': 'تم تعديل موعدك بنجاح.',
  'SLOT_UNAVAILABLE': availabilityAlternatives.length ? `الوقت المطلوب غير متاح. المواعيد البديلة: ${alternativeLabels.join('، ')}` : 'الوقت المطلوب غير متاح حالياً.',
  'REQUESTED_TIME_NOT_AVAILABLE': availabilityAlternatives.length ? `الوقت المطلوب غير متاح. هذه أقرب المواعيد المتحققة: ${alternativeLabels.join('، ')}` : 'الوقت المطلوب غير متاح حالياً.',
  'NO_AVAILABLE_SLOTS': availabilityAlternatives.length ? `ما لقيت موعداً في اليوم المطلوب. هذه أقرب المواعيد المتحققة: ${alternativeLabels.join('، ')}` : 'ما لقيت موعداً متاحاً في اليوم المطلوب حالياً.',
  'DOCTOR_NOT_WORKING_THAT_DAY': availabilityAlternatives.length ? `الدكتور غير متاح في اليوم المطلوب. هذه أقرب المواعيد المتحققة: ${alternativeLabels.join('، ')}` : 'الدكتور غير متاح في اليوم المطلوب وما لقيت موعداً قريباً متحققاً.',
  'FULLY_BOOKED': availabilityAlternatives.length ? `المواعيد في اليوم المطلوب محجوزة. هذه أقرب المواعيد المتحققة: ${alternativeLabels.join('، ')}` : 'المواعيد في اليوم المطلوب محجوزة حالياً.',
  'NO_AVAILABLE_SLOTS_IN_WINDOW': 'ما لقيت موعداً متاحاً متحققاً في الأيام القريبة التي تم البحث فيها. تبغى أبحث في فترة أبعد؟',
  'AVAILABILITY_SOURCE_ERROR': 'تعذر التحقق من المواعيد الآن بسبب مشكلة تقنية. يرجى المحاولة لاحقاً.',
  'MISSING_REQUIRED_FIELDS': nextBestMissing && humanLabels[nextBestMissing] ? `محتاج أعرف ${humanLabels[nextBestMissing]} عشان أكمل.` : 'محتاج تفاصيل أكتر عشان أقدر أساعدك.',
  'PATIENT_DATA_CONFIRMATION_REQUIRED': null,
  'NEW_BOOKING_STARTED': (function () {
    // ── FIX v8b (contradiction #3): the generic fallback asked for the doctor name even when the
    // doctor was already deterministically resolved — now it mentions the resolved doctor. ──
    const resolvedDoctorName = String(((safeFacts && safeFacts.deterministic_identity_resolution && safeFacts.deterministic_identity_resolution.doctor_matches && safeFacts.deterministic_identity_resolution.doctor_matches[0] && safeFacts.deterministic_identity_resolution.doctor_matches[0].doctor_name) || '')).trim();
    const doctorResolved = !!(safeFacts && safeFacts.deterministic_identity_resolution && safeFacts.deterministic_identity_resolution.doctor_resolved);
    const missingPart = safeEntities.service_name
      ? 'اسم الدكتور الذي ترغب بالحجز معه حتى أكمل لك'
      : 'نوع الكشف أو الخدمة التي تحتاجها حتى أكمل الحجز';
    // contradiction #7: also surface a suspended prior draft from the conversation state itself
    // (doctor/date/service from the old booking_context) so the patient is told what exists.
    const priorDraft = suppressPriorDraftOnFreshBooking ? null : (() => { try { const ws = $('Get Conversation State').first().json.state_data || {}; const bc = ws.booking_context || ws.slot_state || {}; return (bc && bc.doctor_name) ? { doctor_name: String(bc.doctor_name).trim(), date: bc.date || null, time: bc.time || null, service_name: bc.service_name || null } : null; } catch(e) { return null; } })();
    const priorPart = (priorExpiredBooking && priorExpiredBooking.doctor_name) ? `الحجز القديم اللي مع ${priorExpiredBooking.doctor_name} انقضى وقته، يلا نبدأ حجز جديد. ` : (priorDraft && priorDraft.doctor_name ? `عندنا طلب سابق معلق مع الدكتور ${priorDraft.doctor_name}${priorDraft.date ? ` ليوم ${priorDraft.date}` : ''}${priorDraft.service_name ? ` (${priorDraft.service_name})` : ''} — لو تبغى تلغيه أو تكمل عليه قول لي، وها نبدأ حجز جديد. ` : '');
    if (doctorResolved && resolvedDoctorName) return `حسنًا سأكمل حجزك مع الدكتور ${resolvedDoctorName} ${priorPart}${missingPart}`;
    if (doctorResolved) return `تمام، نبدأ حجز جديد. ${priorPart}${missingPart}`;
    return `${priorPart}حسنًا نبدأ حجزًا جديدًا اذكري اسم الدكتور أو نوع الكشف وسأكمل معك`;
  })(),
  'CONFIRMATION_REQUIRED': confirmationTarget ? `هل تؤكد ${confirmationAction === 'create_appointment' ? 'حجز' : (confirmationAction === 'cancel_appointment' ? 'إلغاء' : 'تعديل')}${confirmationTarget.doctor_name ? ' مع ' + confirmationTarget.doctor_name : ''}${confirmationTarget.date ? ' يوم ' + confirmationTarget.date : ''}${confirmationTarget.time ? ' الساعة ' + String(confirmationTarget.time).slice(0, 5) : ''}؟` : 'محتاج تأكيد منك عشان أكمل.',
  'CONFIRMATION_EXPIRED': 'انتهت مدة تأكيد الموعد لذلك أحتاج أتحقق من توفره مرة ثانية قبل تثبيت الحجز.',
  'HANDOFF_REQUIRED': 'بحولك لموظف الاستقبال عشان يساعدك',
  'BUSINESS_HOURS_VIOLATION': 'الموعد المطلوب خارج ساعات عمل العيادة. اختر وقتاً داخل ساعات الدوام.',
  'APPOINTMENT_CREATION_FAILED': 'ما قدرت أتمم الحجز حالياً. أقدر أعيد المحاولة.',
  'REQUESTED_TIME_NOT_AVAILABLE': 'الوقت المطلوب غير متاح حاليًا. أقدر أعرض لك أوقاتًا بديلة.',
  'DOCTOR_NOT_WORKING_THAT_DAY': 'الدكتور ما يشتغل في هذا اليوم. أقدر أبحث لك عن يوم بديل.',
  'FULLY_BOOKED': 'الدكتور يعمل في هذا اليوم لكن الأوقات محجوزة. أقدر أبحث لك عن يوم بديل.',
  'NO_AVAILABLE_SLOTS': 'الدكتور يعمل في هذا اليوم، لكن لا توجد مواعيد متاحة مؤكدة حاليًا. أقدر أبحث لك عن يوم بديل.',
  'BOOKING_RECOVERY_EXPLANATION': (function () {
    try {
      const ctx = $('Build Clinic Persona Context (Deterministic)').first().json.error_followup_context || {};
      return ctx.next_field === 'doctor' ? 'صار خلل بسيط في الرد السابق ونكمل الحجز من حيث وقفنا. ارسل لي اسم الطبيب عشان أكمل.' : 'صار خلل بسيط في الرد السابق ونكمل الحجز من حيث وقفنا. ارسل لي اليوم المناسب عشان أكمل.';
    } catch (_) { return 'صار خلل بسيط في الرد السابق ونكمل الحجز من حيث وقفنا. ارسل لي التفاصيل الناقصة عشان أكمل.'; }
  })(),
  'CONVERSATION_ONLY': null // DeepSeek #2 MUST generate this
};

const deterministicFallbackReply = fallbackByCode[responseCode] || null;

// ── Return facts (no reply — DeepSeek #2 generates it) ──
const currentAgentReply = (() => {
  try {
    const normalized = (() => { try { const r = $('Validate Repaired Contract (Deterministic)').first().json; if (r && r._contract_status === 'VALID') return r; } catch (_) {} return $('Normalize Agent Output (Deterministic)').first().json || {}; })();
    const reply = String(normalized.agent_reply || normalized.contract?.reply || '').trim();
    return errorFollowupNeedsFallback && recoveryGenericReply ? null : (reply || null);
  } catch (_) { return null; }
})();
return [{ json: {
  ...$json,
  system_decision: { ...decision, response_code: responseCode, escalation_requested: escalationRequested },
  escalation_requested: escalationRequested,
  agent_reply: errorFollowupNeedsFallback ? null : (currentAgentReply || String($json.agent_reply || '').trim() || null),
  facts: safeFacts,
  response_code: responseCode,
  operation_status: operationStatus,
  success,
  retryable,
  appointment_id: appointmentId || null,
  booking_number: bookingNumber,
  queue_number: queueNumber,
  queue_path: queuePath,
  queue_url: queueUrl,
  queue_expires_at: queueExpiresAt,
  patient_name: String(execution.patient_name || '').trim() || null,
  patient_phone: String(execution.patient_phone || '').trim() || null,
  missing_human_fields: missingHuman,
  next_best_missing_human_field: nextBestMissing,
  deterministic_fallback_reply: deterministicFallbackReply,
  confirmation_target: confirmationTarget,
  contract
} }];