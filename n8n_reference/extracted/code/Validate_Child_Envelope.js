let raw = $input.item.json || {};
let decision = {};
let context = {};
try { decision = $('System Orchestrator (Policy)').first().json.system_decision || {}; } catch (_) {}
try { context = $('Normalize & Validate').first().json || {}; } catch (_) {}

const SCHEMA_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value) => value === undefined || value === null ? '' : String(value).trim();
const action = text(decision.action || decision.confirmation_target?.action).toLowerCase();
const expectedOperation = ({
  create_appointment: 'create_appointment',
  cancel_appointment: 'cancel_appointment',
  reschedule_appointment: 'reschedule_appointment',
})[action] || '';
const target = decision.confirmation_target && typeof decision.confirmation_target === 'object' ? decision.confirmation_target : {};
let claimedOperationId = '';
try { claimedOperationId = text($('Apply Operation Claim (Deterministic)').first().json.operation_id); } catch {}
const expectedOperationId = text(
  claimedOperationId ||
  target.operation_id ||
  (action === 'create_appointment' ? (context.operation_id || (context.idempotency_key ? context.idempotency_key + ':create_appointment' : '')) : '') ||
  (action === 'cancel_appointment' ? (context.idempotency_key ? context.idempotency_key + ':cancel_appointment' : '') : '')
);
const expectedCorrelationId = text(context.correlation_id) || text(claimedOperationId);
const allowedSuccess = {
  create_appointment: new Set(['CREATE_COMPLETED', 'IDEMPOTENT_REPLAY']),
  cancel_appointment: new Set(['CANCEL_COMPLETED', 'IDEMPOTENT_REPLAY']),
  reschedule_appointment: new Set(['RESCHEDULE_COMPLETED', 'IDEMPOTENT_REPLAY']),
};
const allowedFailure = {
  create_appointment: new Set(['CONTRACT_INVALID', 'PATIENT_NOT_FOUND', 'PATIENT_DATA_REQUIRED', 'DOCTOR_INVALID', 'SERVICE_INVALID', 'SLOT_INVALID', 'MISSING_REQUIRED_FIELDS', 'SLOT_UNAVAILABLE', 'RPC_ERROR', 'UNKNOWN_RESPONSE', 'CREATE_APPOINTMENT_FAILED', 'CREATE_RETRYABLE', 'SLOT_ALREADY_BOOKED', 'SLOT_INCOMPATIBLE', 'CURRENT_SLOT_STATE_INVALID', 'CURRENT_SLOT_MISSING', 'SLOT_STALE', 'OPERATION_IN_PROGRESS', 'DAILY_BOOKING_SEQUENCE_EXHAUSTED', 'CLINIC_TIMEZONE_NOT_CONFIGURED', 'PROVIDER_SUCCESS_INVALID', 'REPLAY_CONTRACT_INVALID']),
  cancel_appointment: new Set(['CONTRACT_INVALID', 'MISSING_REQUIRED_FIELD', 'PATIENT_NOT_FOUND', 'APPOINTMENT_NOT_FOUND_OR_NOT_OWNED', 'CANCELLATION_NOT_ALLOWED', 'CANCEL_RETRYABLE', 'CANCEL_NOT_ALLOWED', 'CURRENT_APPOINTMENT_STATE_INVALID', 'OPERATION_IN_PROGRESS', 'RPC_ERROR', 'UNKNOWN_RESPONSE', 'PROVIDER_SUCCESS_INVALID', 'REPLAY_CONTRACT_INVALID']),
  reschedule_appointment: new Set(['CONTRACT_INVALID', 'MISSING_REQUIRED_FIELD', 'INVALID_UUID', 'INVALID_OPERATION_ID', 'APPOINTMENT_NOT_FOUND_OR_NOT_OWNED', 'RESCHEDULE_NOT_ALLOWED', 'SLOT_UNAVAILABLE', 'SAME_SLOT', 'RESCHEDULE_CONFLICT', 'RESCHEDULE_RETRYABLE', 'CURRENT_SLOT_STATE_INVALID', 'CURRENT_SLOT_MISSING', 'SLOT_INCOMPATIBLE', 'OPERATION_IN_PROGRESS', 'RPC_ERROR', 'MISSING_REQUIRED_FIELDS', 'UNKNOWN_RESPONSE', 'PROVIDER_SUCCESS_INVALID']),
};
const invalid = (reason) => ({
  schema_version: SCHEMA_VERSION,
  operation: expectedOperation || null,
  correlation_id: expectedCorrelationId || null,
  operation_id: expectedOperationId || null,
  response_code: 'CHILD_CONTRACT_INVALID',
  success: false,
  retryable: false,
  appointment_id: null,
  error_code: 'CHILD_CONTRACT_INVALID',
  operation_status: 'failed_final',
  child_contract_checked: true,
  child_contract_valid: false,
  contract_error: reason,
  message: 'تعذر التحقق من عقد نتيجة العملية قبل التنفيذ النهائي',
});

if (!expectedOperation) return [{ json: invalid('UNEXPECTED_OPERATION') }];
let response = raw.child_response && typeof raw.child_response === 'object' ? raw.child_response : raw;
let responseCode = text(response.response_code).toUpperCase();
let responseOperation = text(response.operation).toLowerCase();
let responseCorrelation = text(response.correlation_id);
let responseOperationId = text(response.operation_id);
let success = response.success === true;
let retryable = response.retryable;
let appointmentId = text(response.appointment_id);

// EXEC-SQL-ENVELOPE-PATCH: When an Execute SQL node runs directly (no child workflow),
// its output is {id, public_id}. Map it to the expected success envelope.
const sqlDirect = raw.id !== undefined || (raw && typeof raw === 'object' && Object.keys(raw).length <= 4 && ('id' in raw || 'public_id' in raw));
// The create child currently returns a richer direct SQL shape rather than the
// generic child envelope. Accept it only when it is an explicit successful create
// with a valid appointment UUID and a booking reference, then normalize it.
const directCreateSuccess = expectedOperation === 'create_appointment'
  && raw && typeof raw === 'object'
  && raw.success === true
  && String(raw.response_code || '').toUpperCase() === 'APPOINTMENT_CREATED'
  && UUID.test(String(raw.appointment_id || raw.id || ''))
  && Boolean(raw.booking_number || raw.public_id);
if ((sqlDirect && Object.keys(raw).length <= 4) || directCreateSuccess) {
  const directId = String(raw.appointment_id || raw.id || '');
  if (UUID.test(directId)) {
    const directCode = ({
      create_appointment: 'CREATE_COMPLETED',
      cancel_appointment: 'CANCEL_COMPLETED',
      reschedule_appointment: 'RESCHEDULE_COMPLETED',
    })[expectedOperation] || 'UNKNOWN_RESPONSE';
    raw = {
      schema_version: SCHEMA_VERSION,
      operation: expectedOperation,
      correlation_id: expectedCorrelationId,
      operation_id: expectedOperationId,
      response_code: directCode,
      success: true,
      retryable: false,
      appointment_id: directId,
      booking_number: raw.booking_number || raw.public_id || null,
      mutation_status: raw.mutation_status || 'succeeded',
      child_execution_id: String((typeof $execution !== 'undefined' && $execution && $execution.id) ? $execution.id : ''),
    };
    response = raw;
    responseCode = text(response.response_code).toUpperCase();
    responseOperation = text(response.operation).toLowerCase();
    responseCorrelation = text(response.correlation_id);
    responseOperationId = text(response.operation_id);
    success = response.success === true;
    retryable = response.retryable;
    appointmentId = text(response.appointment_id);
  }
}
if (Number(response.schema_version) !== SCHEMA_VERSION) return [{ json: invalid('SCHEMA_VERSION_MISMATCH') }];
if (responseOperation !== expectedOperation) return [{ json: invalid('OPERATION_MISMATCH') }];
if (!expectedCorrelationId || responseCorrelation !== expectedCorrelationId) return [{ json: invalid('CORRELATION_ID_MISMATCH') }];
if (!expectedOperationId || responseOperationId !== expectedOperationId) return [{ json: invalid('OPERATION_ID_MISMATCH') }];
if (typeof success !== 'boolean' || typeof retryable !== 'boolean' || !responseCode) return [{ json: invalid('MISSING_EXPLICIT_CONTRACT_FIELD') }];

if (success) {
  if (!allowedSuccess[expectedOperation].has(responseCode)) return [{ json: invalid('SUCCESS_CODE_NOT_ALLOWED') }];
  if (!UUID.test(appointmentId)) return [{ json: invalid('SUCCESS_APPOINTMENT_ID_INVALID') }];
  if (retryable !== false) return [{ json: invalid('SUCCESS_RETRYABLE_INCONSISTENT') }];
} else {
  if (!allowedFailure[expectedOperation].has(responseCode)) return [{ json: invalid('FAILURE_CODE_NOT_ALLOWED') }];
  if (appointmentId) return [{ json: invalid('FAILURE_APPOINTMENT_ID_PRESENT') }];
}

return [{ json: { ...response, schema_version: SCHEMA_VERSION, operation: expectedOperation, child_contract_checked: true, child_contract_valid: true } }];
