/**
 * P1.1 Execution Transition Guard (v2).
 * This guard enforces execution safety immediately before approved child workflows.
 * It trusts the Orchestrator's explicit approval (EXECUTE_APPROVED/CANCEL_APPROVED/RESCHEDULE_APPROVED)
 * as the authoritative decision, while still performing basic data validation.
 */
const item = $json || {};
const decision = item.system_decision || {};
const previous = $('Get Conversation State').first().json.state_data || {};
const action = String(decision.action || '').toLowerCase();
const executionActions = new Set(['create_appointment', 'cancel_appointment', 'reschedule_appointment']);
const isExecutionRequest = executionActions.has(action) && String(decision.allowed).toLowerCase() === 'true';

function lower(value) { return String(value || '').trim().toLowerCase(); }
const validUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
const validTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(String(value || '').trim());

// ── Data validation (always required) ──
// This is an execution boundary, so names are not sufficient here: all
// tenant-scoped IDs and the resolved slot/time must already exist.
function dataValid(dec, action) {
  if (!dec) return false;
  const bc = dec.booking_context && typeof dec.booking_context === 'object' ? dec.booking_context : {};
  if (action === 'create_appointment') {
    return validUuid(bc.doctor_id)
      && validUuid(bc.slot_id)
      && validDate(bc.date)
      && validTime(bc.time);
  }
  if (action === 'cancel_appointment') {
    const apptId = dec.appointment_id || previous.appointment_id || previous.facts?.booking?.appointment_id;
    return validUuid(apptId);
  }
  if (action === 'reschedule_appointment') {
    const apptId = dec.appointment_id || dec.confirmation_target?.appointment_id || previous.confirmation_target?.appointment_id || previous.appointment_id || null;
    const oldSlotId = dec.expected_old_slot_id || dec.confirmation_target?.expected_old_slot_id || previous.confirmation_target?.expected_old_slot_id || previous.slot_state?.slot_id || null;
    const newSlotId = dec.new_slot_id || dec.confirmation_target?.new_slot_id || bc.new_slot_id || bc.slot_id || null;
    return validUuid(apptId) && validUuid(oldSlotId) && validUuid(newSlotId);
  }
  return false;
}

// ── Orchestrator trust ──
const responseCode = String(decision.response_code || '').toUpperCase();
const orchestratorApproved = ['EXECUTE_APPROVED', 'CANCEL_APPROVED', 'RESCHEDULE_APPROVED'].includes(responseCode) && decision.allowed === true;

if (!isExecutionRequest) {
  // Not an execution request — pass through unchanged
  return [{ json: { ...item } }];
}

// ── Orchestrator explicitly approved + data is valid → ALLOW ──
if (orchestratorApproved && dataValid(decision, action)) {
  const approvedDecision = {
    ...decision,
    allowed: true,
    response_code: responseCode,
    transition_guard: { event: action, from_state: 'ORCHESTRATOR_APPROVED', allowed: true, bypass: true }
  };
  return [{ json: { ...item, system_decision: approvedDecision, output: { ...(item.output || {}), system_decision: approvedDecision } } }];
}

// ── Otherwise: check state transition rules ──


function canonicalFromLegacy(state) {
  const canonical = String(state.operation_state || '').toUpperCase();
  if (['IDLE','DRAFT','PAUSED','AWAITING_CONFIRMATION','REFRESH_REQUIRED','EXECUTING','COMPLETED','CANCELLED','FAILED_RETRYABLE','FAILED_FINAL'].includes(canonical)) return canonical;
  const status = lower(state.operation_status);
  if (status === 'awaiting_confirmation') return 'AWAITING_CONFIRMATION';
  if (status === 'collecting_details' || status === 'draft') return 'DRAFT';
  if (status === 'completed') return 'COMPLETED';
  if (status === 'cancelled') return 'CANCELLED';
  return null;
}

const fromState = canonicalFromLegacy(previous);
const fromStateAllowed = fromState === 'AWAITING_CONFIRMATION' || fromState === 'DRAFT';

if (!fromStateAllowed || !dataValid(decision, action)) {
  const guardedDecision = {
    ...decision,
    allowed: false,
    response_code: 'INVALID_STATE_TRANSITION',
    transition_guard: { event: action || 'unknown', from_state: fromState, allowed: false },
    audit_event: 'invalid_transition',
    final_reply: 'لا أستطيع تنفيذ العملية في الحالة الحالية. سأراجع تفاصيل الحجز أولاً.'
  };
  const guardedOutput = { ...(item.output || {}), response_code: 'INVALID_STATE_TRANSITION', operation_status: 'refresh_required', retryable: false, final_reply: guardedDecision.final_reply, reply_text: guardedDecision.final_reply, system_decision: guardedDecision };
  return [{ json: { ...item, system_decision: guardedDecision, output: guardedOutput, audit_event: 'invalid_transition' } }];
}

// ── Default: allow with state transition check ──
const approvedDecision2 = {
  ...decision,
  allowed: true,
  transition_guard: { event: action, from_state: fromState, allowed: true }
};
return [{ json: { ...item, system_decision: approvedDecision2, output: { ...(item.output || {}), system_decision: approvedDecision2 } } }];
