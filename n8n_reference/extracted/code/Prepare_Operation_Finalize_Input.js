// --- Prepare Operation Finalize Input ---
const raw = $input.item.json || {};
const code = String(raw.response_code || raw.error_code || '').toUpperCase();
const contractValid = raw.child_contract_checked === true && raw.child_contract_valid === true;
const success = raw.success === true;
const definitelyNotExecuted = new Set([
  'SLOT_UNAVAILABLE',
  'CANCELLATION_NOT_ALLOWED',
  'APPOINTMENT_NOT_FOUND_OR_NOT_OWNED',
  'SAME_SLOT',
  'MISSING_REQUIRED_FIELDS',
  'CONFIDENCE_REVIEW_REQUIRED'
]).has(code);
const retryableCode = new Set([
  'CREATE_RETRYABLE',
  'CANCEL_RETRYABLE',
  'RESCHEDULE_RETRYABLE'
]).has(code);
const explicitNotExecuted = String(raw.mutation_status || raw.operation_mutation_status || '').toUpperCase() === 'NOT_EXECUTED';
const retryableNotExecuted = retryableCode || (raw.retryable === true && explicitNotExecuted);
let ledgerStatus = 'INCONCLUSIVE';
let mutationStatus = 'UNKNOWN';
if (contractValid && success) {
  ledgerStatus = 'COMPLETED';
  mutationStatus = 'EXECUTED';
} else if (contractValid && definitelyNotExecuted) {
  ledgerStatus = 'FAILED_FINAL';
  mutationStatus = 'NOT_EXECUTED';
} else if (contractValid && retryableNotExecuted) {
  // A retryable child code is an explicit proof that the provider mutation
  // was not executed. Keep the ledger retryable and claimable by the same
  // canonical operation identity; do not misclassify it as unknown.
  ledgerStatus = 'IN_PROGRESS';
  mutationStatus = 'NOT_EXECUTED';
}
const responseJson = {
  response_code: raw.response_code || code || 'CHILD_CONTRACT_INVALID',
  success,
  retryable: raw.retryable === true,
  final_reply: raw.final_reply || raw.message || null,
  appointment_id: raw.appointment_id || raw.id || null,
  booking_id: raw.booking_id || null,
  booking_number: raw.booking_number || null,
  branch_id: raw.branch_id || null,
  queue_number: raw.queue_number ?? null,
  queue_path: raw.queue_path || null,
  queue_expires_at: raw.queue_expires_at || null,
  operation_id: raw.operation_id || null,
  child_contract_checked: raw.child_contract_checked === true,
  child_contract_valid: raw.child_contract_valid === true,
  contract_error: raw.contract_error || null
};
const responseB64 = Buffer.from(JSON.stringify(responseJson), 'utf8').toString('base64');
const executionId = (typeof $execution !== 'undefined' && $execution && $execution.id) ? $execution.id : null;
return [{ json: {
  ...raw,
  finalize_clinic_id: (() => { try { return $('Normalize & Validate').first().json.clinic_id || null; } catch { return null; } })(),
  finalize_operation_id: raw.operation_id || null,
  finalize_status: ledgerStatus,
  finalize_mutation_status: mutationStatus,
  finalize_response_b64: responseB64,
  finalize_child_execution_id: raw.child_execution_id || executionId,
  finalize_last_error_b64: (() => {
    const detail = raw.last_error || raw.error_message || raw.error || raw.contract_error || raw.error_code || null;
    if (!detail) return '';
    return Buffer.from(JSON.stringify({
      error_code: raw.error_code || raw.response_code || null,
      message: String(detail)
    }), 'utf8').toString('base64');
  })()
} }];

// --- Merge Operation Completion Result ---
// This section is replaced by the separate Merge node code in the patch builder.
