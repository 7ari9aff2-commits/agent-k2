const normalized = (() => { try { const r = $('Validate Repaired Contract (Deterministic)').first().json; if (r && r._contract_status === 'VALID') return r; } catch (_) {} return $('Normalize Agent Output (Deterministic)').first().json || {}; })();
const resolved = $json && typeof $json === 'object' ? $json : {};
const contract = normalized.contract && typeof normalized.contract === 'object' ? normalized.contract : {};
const entities = contract.entities && typeof contract.entities === 'object' ? contract.entities : {};
const operationType = String(contract.operation_proposal?.type || normalized._normalization?.turn_intent || '').toLowerCase();
const shouldApply = ['create_appointment','cancel_appointment','reschedule_appointment','check_availability'].includes(operationType) || ['cancellation_request','reschedule_request','availability_inquiry'].includes(String(normalized._normalization?.turn_intent || '').toLowerCase());
const normalizedScope = normalized._normalization && typeof normalized._normalization === 'object' ? normalized._normalization : {};
const currentTurnDate = normalizedScope.query_scope?.date || normalizedScope.raw_temporal_input?.date || entities.date || null;
const currentTurnTime = normalizedScope.query_scope?.time || normalizedScope.raw_temporal_input?.time || entities.time || null;
const currentTurnHasWindowEvidence = Boolean(normalizedScope.current_message_temporal === true || normalizedScope.query_scope?.date || normalizedScope.query_scope?.time || entities.date || entities.time);
const freshBookingTurn = operationType === 'create_appointment' && currentTurnHasWindowEvidence;
const freshSchedulingTurn = ['create_appointment','check_availability','reschedule_appointment'].includes(operationType) && currentTurnHasWindowEvidence;
// A slot returned by a read-only availability lookup is only a candidate.
// It must never become the user's selected slot or requested time.
const availabilityOnly = Boolean(
  normalized._normalization?.query_is_availability === true
  || normalized._normalization?.query_scope?.type === 'availability'
  || contract.query?.type === 'availability'
  || contract.next_step?.type === 'show_availability'
  || normalized._normalization?.next_step_type === 'show_availability'
);
// P-SLOT-GUARD v40: a slot carried in prior state may only survive into the
// booking context when THIS conversation still has an open offer or a pending
// confirmation. Otherwise a fresh create request silently inherits the previous
// session's slot (observed: stale 2026-09-11 slot bound onto a brand-new request).
const stateRowGuard = (() => { try { const f = $('Get Conversation State').first(); return (f && f.json) || {}; } catch (_) { return {}; } })();
const guardState = (stateRowGuard.state_data && typeof stateRowGuard.state_data === 'object') ? stateRowGuard.state_data : {};
const guardOffer = guardState.presented_offer || guardState.pending_offer || null;
const liveOffer = Boolean(guardOffer && typeof guardOffer === 'object' && Number.isFinite(Date.parse(String(guardOffer.expires_at || ''))) && Date.parse(String(guardOffer.expires_at || '')) > Date.now());
const guardTarget = guardState.confirmation_target || null;
const guardTargetExp = guardTarget && typeof guardTarget === 'object' ? Date.parse(String(guardTarget.expires_at || '')) : NaN;
const liveTarget = Boolean(guardTarget && typeof guardTarget === 'object' && (!Number.isFinite(guardTargetExp) || guardTargetExp > Date.now()));
const mayCarrySlot = liveOffer || liveTarget;
if (!shouldApply) return [{ json: normalized }];
const resolvedDoctorId = resolved.doctor_id || null;
const resolvedDoctorName = resolved.doctor_name || null;
const resolvedServiceId = resolved.service_id || null;
const resolvedServiceName = resolved.service_name || null;
const mergedEntities = {
  ...entities,
  doctor_id: resolvedDoctorId || entities.doctor_id || null,
  doctor_name: resolvedDoctorName || entities.doctor_name || null,
  service_id: resolvedServiceId || entities.service_id || null,
  service_name: resolvedServiceName || entities.service_name || null,
  appointment_type: entities.appointment_type || null,
  appointment_id: entities.appointment_id || resolved.appointment_id || null,
  booking_number: entities.booking_number || resolved.booking_number || null,
  expected_old_slot_id: entities.expected_old_slot_id || resolved.expected_old_slot_id || null,
  new_slot_id: entities.new_slot_id || resolved.new_slot_id || null,
  slot_id: availabilityOnly ? null : (entities.slot_id || resolved.slot_id || resolved.new_slot_id || null),
  branch_id: entities.branch_id || resolved.branch_id || null,
};
const priorBooking = normalized.booking_context && typeof normalized.booking_context === 'object' ? normalized.booking_context : {};
const slotState = normalized.slot_state && typeof normalized.slot_state === 'object' ? normalized.slot_state : {};
// Resolver output is the tenant-scoped database authority for IDs and labels.
// When it returns a service/doctor pair, keep the pair together so an old state
// label cannot survive with a different database ID.
const bookingContext = {
  ...priorBooking,
  doctor_id: resolvedDoctorId || priorBooking.doctor_id || null,
  doctor_name: resolvedDoctorName || priorBooking.doctor_name || null,
  service_id: resolvedServiceId || priorBooking.service_id || null,
  service_name: resolvedServiceName || priorBooking.service_name || null,
  appointment_type: priorBooking.appointment_type || entities.appointment_type || null,
  appointment_id: priorBooking.appointment_id || resolved.appointment_id || null,
  booking_number: priorBooking.booking_number || resolved.booking_number || null,
  expected_old_slot_id: priorBooking.expected_old_slot_id || resolved.expected_old_slot_id || null,
  new_slot_id: availabilityOnly ? null : (freshBookingTurn ? (resolved.new_slot_id || null) : (mayCarrySlot ? (priorBooking.new_slot_id || resolved.new_slot_id || null) : null)),
  slot_id: availabilityOnly ? null : (freshBookingTurn ? (resolved.slot_id || resolved.new_slot_id || null) : (mayCarrySlot ? (priorBooking.slot_id || resolved.slot_id || resolved.new_slot_id || null) : null)),
  branch_id: priorBooking.branch_id || resolved.branch_id || null,
  date: availabilityOnly ? (currentTurnDate || null) : (freshSchedulingTurn ? (currentTurnDate || (resolved.resolved_slot_start_time ? String(resolved.resolved_slot_start_time).slice(0,10) : null)) : (mayCarrySlot ? (priorBooking.date || (resolved.resolved_slot_start_time ? String(resolved.resolved_slot_start_time).slice(0,10) : null)) : (currentTurnDate || null))),
  time: availabilityOnly ? (currentTurnTime || null) : (freshSchedulingTurn ? (currentTurnTime || (resolved.resolved_slot_start_time ? String(resolved.resolved_slot_start_time).slice(11,19) : null)) : (mayCarrySlot ? (priorBooking.time || (resolved.resolved_slot_start_time ? String(resolved.resolved_slot_start_time).slice(11,19) : null)) : (currentTurnTime || null))),
};
return [{ json: {
  ...normalized,
  contract: { ...contract, entities: mergedEntities },
  // BUGFIX (2026-09-09): the orchestrator reads contract_v3.entities, which previously
  // kept the pre-resolver values (appointment_id=null when the patient gave a textual
  // booking number). Mirror the resolver results into contract_v3.entities as well.
  contract_v3: (normalized.contract_v3 && typeof normalized.contract_v3 === 'object')
    ? { ...normalized.contract_v3, entities: { ...(normalized.contract_v3.entities || {}),
        appointment_id: mergedEntities.appointment_id ?? (normalized.contract_v3.entities || {}).appointment_id ?? null,
        booking_number: mergedEntities.booking_number ?? (normalized.contract_v3.entities || {}).booking_number ?? null,
        expected_old_slot_id: mergedEntities.expected_old_slot_id ?? (normalized.contract_v3.entities || {}).expected_old_slot_id ?? null,
        new_slot_id: availabilityOnly ? null : (mergedEntities.new_slot_id ?? (normalized.contract_v3.entities || {}).new_slot_id ?? null),
        slot_id: availabilityOnly ? null : (mergedEntities.slot_id ?? (normalized.contract_v3.entities || {}).slot_id ?? null),
        doctor_id: mergedEntities.doctor_id ?? (normalized.contract_v3.entities || {}).doctor_id ?? null,
        doctor_name: mergedEntities.doctor_name ?? (normalized.contract_v3.entities || {}).doctor_name ?? null,
        service_id: mergedEntities.service_id ?? (normalized.contract_v3.entities || {}).service_id ?? null,
        service_name: mergedEntities.service_name ?? (normalized.contract_v3.entities || {}).service_name ?? null,
        branch_id: mergedEntities.branch_id ?? (normalized.contract_v3.entities || {}).branch_id ?? null } }
    : normalized.contract_v3,
  booking_context: bookingContext,
  // Preserve the canonical window and patient fields for downstream readiness and state persistence.
  slot_state: {
    ...slotState,
    ...mergedEntities,
    doctor_id: bookingContext.doctor_id || slotState.doctor_id || null,
    doctor_name: bookingContext.doctor_name || slotState.doctor_name || null,
    service_id: bookingContext.service_id || slotState.service_id || null,
    service_name: bookingContext.service_name || slotState.service_name || null,
    appointment_type: bookingContext.appointment_type || slotState.appointment_type || null,
    // Availability candidates must not leak into the persistent slot selection state.
    date: availabilityOnly ? (currentTurnDate || null) : (bookingContext.date || slotState.date || null),
    time: availabilityOnly ? (currentTurnTime || null) : (bookingContext.time || slotState.time || null),
    slot_id: availabilityOnly ? null : (bookingContext.slot_id || slotState.slot_id || null),
    patient_name: bookingContext.patient_name || slotState.patient_name || null,
    patient_phone: bookingContext.patient_phone || slotState.patient_phone || null,
    patient_age: bookingContext.patient_age ?? slotState.patient_age ?? null,
    patient_address: bookingContext.patient_address || slotState.patient_address || null,
  },
  appointment_id: resolved.appointment_id || normalized.appointment_id || null,
  booking_number: resolved.booking_number || normalized.booking_number || normalized.booking_context?.booking_number || null,
  expected_old_slot_id: resolved.expected_old_slot_id || normalized.expected_old_slot_id || null,
  new_slot_id: availabilityOnly ? null : (resolved.new_slot_id || normalized.new_slot_id || null),
  branch_id: resolved.branch_id || normalized.branch_id || null,
  resolver_result: resolved,
  resolver_contract_version: 2,
} }];
