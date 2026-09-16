// Prepare Execute Context — null-safe version
// Audit fix: wrap all $('NodeName').first().json references in null-safe pattern
// to prevent crashes when upstream returns 0 items. The fallback is the same as
// the original code assumed (empty object), so behavior is unchanged for normal flow.

const first = (name) => { try { const f = $(name).first(); return (f && f.json) || {}; } catch (_) { return {}; } };
const firstOrNull = (name) => { try { const f = $(name).first(); return (f && f.json) || null; } catch (_) { return null; } };

const priorState = firstOrNull('Get Conversation State');
const priorStateData = (priorState && (priorState.state_data || priorState.data)) || priorState || {};
let prior = {};
try {
  const raw = typeof priorStateData === 'string' ? priorStateData : JSON.stringify(priorStateData);
  const parsed = JSON.parse(raw);
  // Handle different structures
  if (parsed.state_data) prior = typeof parsed.state_data === 'string' ? JSON.parse(parsed.state_data) : parsed.state_data;
  else if (parsed.data) prior = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
  else prior = parsed;
} catch (e) {}

const bc = prior.booking_context || (prior.facts && prior.facts.booking) || (prior.system_decision && prior.system_decision.booking_context) || prior || {};
const resolveNode = firstOrNull('Resolve Booking IDs (Deterministic)') || {};
const applyNode = firstOrNull('Apply Resolved Booking IDs (Deterministic)') || {};
const orchestratorNode = firstOrNull('System Orchestrator (Policy)') || {};

const sd = orchestratorNode.system_decision || {};
const sdBc = sd.booking_context || {};
let slotLookupNode = {};
try { slotLookupNode = first('Apply Deterministic Slot Lookup Result'); } catch (_) {}

// Resolve IDs with fallback chain
const normalizeInbound = first('Normalize & Validate');
const clinicId = normalizeInbound.clinic_id;
const patientId = normalizeInbound.patient_id;
const conversationId = normalizeInbound.conversation_id;

// Doctor ID
const doctorId = sdBc.doctor_id || bc.doctor_id || resolveNode.doctor_id || (applyNode && applyNode.booking_context && applyNode.booking_context.doctor_id) || null;

// Service ID - try all sources
let serviceId = sdBc.service_id || bc.service_id || resolveNode.service_id || (applyNode && applyNode.booking_context && applyNode.booking_context.service_id) || null;

// Service name
const serviceName = sdBc.service_name || bc.service_name || resolveNode.service_name || (applyNode && applyNode.booking_context && applyNode.booking_context.service_name) || null;
const appointmentType = sdBc.appointment_type || bc.appointment_type || (applyNode && applyNode.booking_context && applyNode.booking_context.appointment_type) || null;

// Date and time
const date = sdBc.date || bc.date || resolveNode.date || applyNode.booking_context?.date || null;
const time = sdBc.time || bc.time || resolveNode.time || applyNode.booking_context?.time || slotLookupNode.booking_context?.time || null;
// Slot lookup is the deterministic authority for execution. Preserve its UUID explicitly.
const slotId = sdBc.slot_id || bc.slot_id || resolveNode.slot_id || applyNode.slot_id
  || applyNode.booking_context?.slot_id || slotLookupNode.slot_id || slotLookupNode.slot_state?.slot_id
  || slotLookupNode.booking_context?.slot_id || null;
const branchId = sdBc.branch_id || bc.branch_id || resolveNode.branch_id || applyNode.branch_id
  || applyNode.booking_context?.branch_id || slotLookupNode.branch_id || slotLookupNode.slot_state?.branch_id
  || slotLookupNode.booking_context?.branch_id || null;
const branchName = sdBc.branch_name || bc.branch_name || resolveNode.branch_name || applyNode.branch_name
  || applyNode.booking_context?.branch_name || slotLookupNode.branch_name || slotLookupNode.slot_state?.branch_name
  || slotLookupNode.booking_context?.branch_name || null;
const clinicContext = first('Get Clinic Context');
const currentPatient = (sdBc && typeof sdBc === 'object') ? sdBc : {};
const normalizeAge = (value) => {
  const s = String(value ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 130 ? n : null;
};
const reviewFields = prior.patient_data_review && typeof prior.patient_data_review.fields === 'object'
  ? prior.patient_data_review.fields : {};
const factPatient = prior.facts && typeof prior.facts.patient === 'object' ? prior.facts.patient : {};
const usableText = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const placeholder = new Set(['مريض', 'patient', 'unknown', 'غير معروف']);
  return placeholder.has(text.toLowerCase()) ? null : text;
};
// The patient's current statement/review is authoritative. The clinic row is only a
// last-resort source for non-identifying context and must never override a real name
// with the placeholder "مريض".
const patientName = usableText(currentPatient.patient_name)
  || usableText($json.patient_name)
  || usableText(bc.patient_name)
  || usableText(reviewFields.name)
  || usableText(factPatient.name)
  || usableText(prior.patient_name)
  || null;
const patientPhone = currentPatient.patient_phone || $json.patient_phone || bc.patient_phone || reviewFields.phone || factPatient.phone || prior.patient_phone || clinicContext.patient_phone || null;
const patientAge = normalizeAge(currentPatient.patient_age ?? $json.patient_age ?? bc.patient_age ?? reviewFields.age ?? factPatient.age ?? prior.patient_age ?? clinicContext.patient_age);
const patientAddress = currentPatient.patient_address || $json.patient_address || bc.patient_address || reviewFields.address || factPatient.address || prior.patient_address || clinicContext.patient_address || null;

return [{
  json: {
    clinic_id: clinicId,
    patient_id: patientId,
    conversation_id: conversationId,
    doctor_id: doctorId,
    service_id: serviceId,
    service_name: serviceName,
    appointment_type: appointmentType,
    date: date,
    time: time,
    slot_id: slotId,
    branch_id: branchId,
    branch_name: branchName,
    patient_name: patientName,
    patient_phone: patientPhone,
    patient_age: patientAge,
    patient_address: patientAddress,
    operation: sd.operation || sdBc.operation || 'create_appointment',
    channel_type: normalizeInbound.channel_type || 'whatsapp'
  }
}];
