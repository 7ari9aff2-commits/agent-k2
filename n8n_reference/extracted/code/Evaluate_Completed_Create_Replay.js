const ctx = $('Normalize & Validate').item.json;
const previous = $json.state_data && typeof $json.state_data === 'object' ? $json.state_data : {};
const requestedOperationId = String(ctx.operation_id || '').trim();
const publicBookingNumber = String(previous.booking_number || '').trim();
const isCompletedCreateReplay = requestedOperationId !== ''
  && previous.operation_action === 'create_appointment'
  && ['success', 'completed'].includes(String(previous.operation_status || ''))
  && String(previous.operation_id || '') === requestedOperationId
  && String(previous.appointment_id || '').trim() !== '';
const replayReply = publicBookingNumber
  ? `تم تأكيد الحجز بالفعل ورقم الحجز ${publicBookingNumber}`
  : 'تم تأكيد الحجز بالفعل';

const replayDecision = isCompletedCreateReplay ? {
  intent: 'booking',
  proposed_action: 'none',
  action: 'create_appointment',
  allowed: false,
  response_code: 'IDEMPOTENT_REPLAY',
  operation_id: previous.operation_id,
  appointment_id: previous.appointment_id,
  replayed: true,
  confirmation_state: 'confirmed',
  confirmation_target: null,
  final_reply: replayReply
} : null;

const replayProposal = isCompletedCreateReplay ? {
  intent: 'booking',
  proposed_action: 'none',
  confidence: 1,
  proposed_reply: replayDecision.final_reply,
  slot_state: previous.slot_state || {},
  booking_context: previous.booking_context || {},
  confirmation_required: false,
  user_confirmation_signal: false,
  confirmation_target: null,
  appointment_id: previous.appointment_id,
  cancellation_reason: 'user_requested',
  cancelled_by: null,
  escalate: false
} : null;

return [{ json: { ...$json, replay_gate: { matched: isCompletedCreateReplay }, ...(replayDecision ? { system_decision: replayDecision, proposal: replayProposal } : {}) } }];