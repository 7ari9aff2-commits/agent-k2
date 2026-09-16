const priorState = $('Get Conversation State').first().json || {};
const priorStateData = priorState.state_data || priorState.data || priorState;
let prior = {};
try {
  const raw = typeof priorStateData === 'string' ? priorStateData : JSON.stringify(priorStateData);
  const parsed = JSON.parse(raw);
  prior = parsed.state_data ? (typeof parsed.state_data === 'string' ? JSON.parse(parsed.state_data) : parsed.state_data) : (parsed.data || parsed);
} catch (_) {}
const resolveNode = $('Resolve Booking IDs (Deterministic)').first().json || {};
const applyNode = $('Apply Resolved Booking IDs (Deterministic)').first().json || {};
const orchestratorNode = $('System Orchestrator (Policy)').first().json || {};
const sd = orchestratorNode.system_decision || {};
const target = sd.confirmation_target && typeof sd.confirmation_target === 'object' ? sd.confirmation_target : {};
const sdBc = sd.booking_context && typeof sd.booking_context === 'object' ? sd.booking_context : {};
const nv = $('Normalize & Validate').first().json || {};
const ctx = (value, fallback = null) => value !== undefined && value !== null && String(value) !== '' ? value : fallback;
const booking = { ...(prior.booking_context || {}), ...(applyNode.booking_context || {}), ...sdBc };
const slotState = { ...(prior.slot_state || {}), ...(applyNode.slot_state || {}) };
const slotId = ctx(target.slot_id, ctx(sdBc.slot_id, ctx(slotState.slot_id, ctx(resolveNode.slot_id, booking.slot_id))));
const branchId = ctx(target.branch_id, ctx(sdBc.branch_id, ctx(slotState.branch_id, ctx(resolveNode.branch_id, booking.branch_id))));
const operationId = ctx(target.operation_id, ctx(applyNode.operation_id, ctx(nv.operation_id, `${nv.idempotency_key || ''}:create_appointment`)));
return [{ json: {
  clinic_id: nv.clinic_id || null,
  patient_id: nv.patient_id || null,
  conversation_id: nv.conversation_id || null,
  doctor_id: ctx(sdBc.doctor_id, ctx(booking.doctor_id, resolveNode.doctor_id)),
  service_id: ctx(sdBc.service_id, ctx(booking.service_id, resolveNode.service_id)),
  service_name: ctx(sdBc.service_name, ctx(booking.service_name, resolveNode.service_name)),
  date: ctx(sdBc.date, ctx(booking.date, resolveNode.date)),
  time: ctx(sdBc.time, ctx(booking.time, resolveNode.time)),
  slot_id: slotId,
  branch_id: branchId,
  notes: ctx(target.notes, ctx(sd.notes, null)),
  operation: sd.action || sd.operation || target.action || 'create_appointment',
  operation_id: operationId,
  correlation_id: nv.correlation_id || nv.message_id || null,
  channel_type: nv.channel_type || 'whatsapp',
  patient_data_complete: [booking.patient_name, booking.patient_phone, booking.patient_age, booking.patient_address].every(v => v !== null && v !== undefined && String(v).trim() !== '')
} }];