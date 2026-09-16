const source = $input.item.json || {};
let normalize = {};
try { normalize = $('Normalize & Validate').first().json || {}; } catch {}
const decision = source.system_decision && typeof source.system_decision === 'object'
  ? source.system_decision
  : {};
const target = decision.confirmation_target && typeof decision.confirmation_target === 'object'
  ? decision.confirmation_target
  : {};
const action = String(decision.action || target.action || '').toLowerCase();
// flow_up_operation_ledger.confirmation_id references the persisted
// flow_up_confirmations.confirmation_id. Pass the deterministic target id only;
// never substitute a prompt-message id or invent an id. The persistence node
// runs before this claim path and creates the matching FK row.
const rawConfirmationId = String(target.confirmation_id || '').trim();
const claimConfirmationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawConfirmationId)
  ? rawConfirmationId
  : null;
const sideEffectAction = ['create_appointment', 'cancel_appointment', 'reschedule_appointment'].includes(action);
const claimRequired = decision.allowed === true && sideEffectAction; // Claim only approved side effects; non-execution turns bypass the ledger
const targetFingerprint = String(
  target.context_fingerprint
  || source.business_time_target_fingerprint
  || ''
).trim();

return [{ json: {
  ...source,
  claim_required: claimRequired,
  claim_action: action,
  claim_clinic_id: normalize.clinic_id || null,
  claim_patient_id: normalize.patient_id || null,
  claim_conversation_id: normalize.conversation_id || null,
  claim_confirmation_id: claimConfirmationId,
  claim_target_fingerprint: targetFingerprint || null,
  claim_schema_version: 1
} }];
