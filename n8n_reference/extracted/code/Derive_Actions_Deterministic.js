// Derive Actions (Deterministic) — null-safe version
// Audit fix: wrap $('Normalize & Validate').first().json in null-safe pattern.

const output = $json.output || {};
let upstreamDecision = {};
try { upstreamDecision = $('System Orchestrator (Policy)').first().json.system_decision || {}; } catch {}
const localDecision = ($json && $json.system_decision && typeof $json.system_decision === 'object') ? $json.system_decision : {};
// Claim-blocked/replay paths must use the current local Response Policy envelope,
// not the stale upstream Orchestrator decision. Keep this selection identical to
// Response Policy so escalation and action derivation see the same authoritative facts.
const hasClaimOutcome = Boolean($json && ($json.operation_claim_decision || $json.operation_claim_blocked || $json.operation_replay));
const decision = hasClaimOutcome
  ? (Object.keys(localDecision).length ? localDecision : upstreamDecision)
  : (Object.keys(upstreamDecision).length ? upstreamDecision : localDecision);
// Null-safe inbound context. Normalize & Validate always returns 1 item in normal flow,
// but a missing item is treated as an empty context to avoid throwing.
const ctx = (() => { try { const f = $('Normalize & Validate').first(); return (f && f.json) || {}; } catch (_) { return {}; } })();
const actions = [];
const responseCode = decision.response_code || $json.response_code || output.response_code || 'CONVERSATION_ONLY';
const bookingNumber = output.booking_number || decision.booking_number || decision.booking_context?.booking_number || null;
if (responseCode === 'HANDOFF_REQUIRED') actions.push({ type: 'handoff', reason: 'agent_escalation', priority: 'high' });
else if (responseCode === 'APPOINTMENT_CREATED') actions.push({ type: 'send_confirmation', appointment_id: output.appointment_id, booking_number: bookingNumber });
else if (responseCode === 'IDEMPOTENT_REPLAY') {
  if (decision.action === 'create_appointment') actions.push({ type: 'send_confirmation', appointment_id: output.appointment_id, booking_number: bookingNumber, replayed: true });
  else if (decision.action === 'reschedule_appointment') actions.push({ type: 'send_reschedule_confirmation', appointment_id: output.appointment_id, booking_number: bookingNumber, replayed: true });
  else actions.push({ type: 'send_cancellation_confirmation', appointment_id: output.appointment_id, booking_number: bookingNumber, replayed: true });
}
else if (responseCode === 'CANCEL_COMPLETED') actions.push({ type: 'send_cancellation_confirmation', appointment_id: output.appointment_id, booking_number: bookingNumber });
else if (responseCode === 'RESCHEDULE_COMPLETED') actions.push({ type: 'send_reschedule_confirmation', appointment_id: output.appointment_id, booking_number: bookingNumber, new_slot_id: decision.confirmation_target?.new_slot_id || null });
else if (responseCode === 'AVAILABILITY_RESULTS') actions.push({ type: 'send_conversation_reply', reason: 'availability_results' });
else if (responseCode === 'CONVERSATION_ONLY') actions.push({ type: 'send_conversation_reply' });
else if (responseCode === 'CONFIRMATION_REQUIRED') actions.push({ type: 'request_confirmation', target: decision.confirmation_target || null, expires_at: decision.confirmation_target?.expires_at || null });
else if (responseCode === 'CONFIRMATION_EXPIRED') actions.push({ type: 'refresh_booking_confirmation', reason: 'confirmation_target_expired_or_changed' });
else if (responseCode === 'MISSING_REQUIRED_FIELDS') actions.push({ type: 'collect_required_fields', fields: decision.missing_fields || [] });
else if (['APPOINTMENT_CREATION_FAILED','CANCEL_FAILED','CANCELLATION_NOT_ALLOWED','APPOINTMENT_NOT_FOUND_OR_NOT_OWNED','CANCEL_RETRYABLE'].includes(responseCode)) actions.push({ type: 'send_operation_failure', operation: responseCode.startsWith('CANCEL') || responseCode.includes('CANCELLATION') || responseCode.includes('APPOINTMENT_NOT_FOUND') ? 'cancel_appointment' : 'create_appointment' });
else if (['RESCHEDULE_NOT_ALLOWED','RESCHEDULE_CONFLICT','RESCHEDULE_RETRYABLE'].includes(responseCode)) actions.push({ type: 'send_operation_failure', operation: 'reschedule_appointment' });
else if (responseCode === 'SLOT_UNAVAILABLE') actions.push({
  type: 'offer_available_slots',
  operation: decision.action === 'create_appointment' ? 'create_appointment' : 'reschedule_appointment',
  requested_time_unavailable: output.availability_requested_time_unavailable === true,
  alternatives: Array.isArray(output.availability_alternatives) ? output.availability_alternatives : (Array.isArray(output.deterministic_slot_lookup?.alternatives) ? output.deterministic_slot_lookup.alternatives : [])
});
else if (responseCode === 'AVAILABILITY_SOURCE_ERROR') actions.push({ type: 'send_availability_source_error' });
else actions.push({ type: 'send_policy_reply', response_code: responseCode });
return [{ json: { ...$json, system_decision: decision, response_code: responseCode, escalation_requested: decision.response_code === 'HANDOFF_REQUIRED' && decision.escalation_requested === true, actions, audit_context: { clinic_id: ctx.clinic_id, conversation_id: ctx.conversation_id, patient_id: ctx.patient_id, response_code: decision.response_code, confirmation_expires_at: decision.confirmation_target?.expires_at || null } } }];
