const input = $('Prepare Operation Claim Input').first().json || $input.item.json || {};
const raw = $input.item.json || {};
const decision = input.system_decision && typeof input.system_decision === 'object' ? input.system_decision : {};
const claimDecision = String(raw.decision || '').toUpperCase();
const ledgerOperationId = String(raw.operation_id || '').trim() || null;
const parseJson = (value) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return null; }
};
const storedResponse = parseJson(raw.response_json);
const replay = ['IDEMPOTENT_REPLAY', 'REPLAY_FINAL'].includes(claimDecision);
const claimOwner = ['OWNER', 'OWNER_RETRY'].includes(claimDecision);
const blocked = !claimOwner;
const ledgerAlert = raw.ledger_alert === true || claimDecision === 'INCONCLUSIVE';
const ledgerAgeSeconds = Number.isFinite(Number(raw.ledger_age_seconds)) ? Number(raw.ledger_age_seconds) : null;
let responseCode = null;
let finalReply = null;
let allowed = decision.allowed === true;
let retryable = false;
let operationState = null;

if (claimDecision === 'IN_PROGRESS') {
  responseCode = 'OPERATION_IN_PROGRESS';
  finalReply = 'العملية نفسها قيد التنفيذ حالياً. لن أكرر الإجراء، وسأعيد لك النتيجة عند اكتمالها.';
  allowed = false;
  retryable = true;
  operationState = 'in_progress';
} else if (claimDecision === 'INCONCLUSIVE') {
  responseCode = 'OPERATION_INCONCLUSIVE';
  finalReply = 'تعذر التحقق بأمان من نتيجة المحاولة السابقة، لذلك لن أعيد تنفيذ العملية تلقائياً.';
  allowed = false;
  retryable = false;
  operationState = 'inconclusive';
} else if (claimDecision === 'OPERATION_CONFLICT') {
  responseCode = 'OPERATION_ID_CONFLICT';
  finalReply = 'تعذر مطابقة هوية العملية بأمان، لذلك لم يتم تنفيذ أي إجراء.';
  allowed = false;
  retryable = false;
  operationState = 'conflict';
} else if (claimDecision === 'UNSUPPORTED_ACTION') {
  responseCode = 'UNSUPPORTED_OPERATION';
  finalReply = 'لا يمكن تنفيذ هذه العملية من خلال هذا المسار.';
  allowed = false;
  retryable = false;
  operationState = 'failed_final';
} else if (claimDecision === 'REPLAY_FINAL') {
  responseCode = 'REPLAY_FINAL';
  finalReply = storedResponse?.final_reply || storedResponse?.message || decision.final_reply || 'تمت معالجة العملية سابقاً ولا يمكن إعادة تنفيذها.';
  allowed = false;
  retryable = false;
  operationState = 'failed_final';
} else if (claimDecision === 'IDEMPOTENT_REPLAY') {
  responseCode = 'IDEMPOTENT_REPLAY';
  finalReply = storedResponse?.final_reply || storedResponse?.message || decision.final_reply || 'تم تنفيذ العملية سابقاً.';
  allowed = false;
  retryable = false;
  operationState = 'completed';
} else if (!claimOwner) {
  responseCode = 'CLAIM_NOT_GRANTED';
  finalReply = 'لم يتم الحصول على ملكية العملية بأمان، لذلك لم يتم تنفيذ أي إجراء.';
  allowed = false;
  retryable = false;
  operationState = 'conflict';
}

const finalDecision = replay || blocked
  ? {
      ...decision,
      allowed: false,
      response_code: responseCode,
      final_reply: finalReply,
      operation_id: ledgerOperationId,
      operation_state: operationState,
      claim_decision: claimDecision,
      claim_granted: false,
      resume_eligible: false,
      retryable,
      ledger_alert: ledgerAlert,
      escalate: ledgerAlert || decision.escalate === true
    }
  : {
      ...decision,
      operation_id: ledgerOperationId,
      claim_decision: claimDecision,
      claim_granted: true
    };

return [{ json: {
  ...input,
  ...raw,
  operation_id: ledgerOperationId,
  operation_claim_decision: claimDecision,
  operation_claim_granted: claimOwner,
  operation_claim_required: input.claim_required === true,
  operation_claim_blocked: blocked,
  operation_replay: replay,
  operation_replay_response: storedResponse,
  operation_ledger_status: raw.operation_status || null,
  operation_mutation_status: raw.mutation_status || null,
  operation_state: operationState,
  retryable,
  success: replay ? storedResponse?.success === true : false,
  appointment_id: replay ? (storedResponse?.appointment_id || storedResponse?.data?.appointment_id || null) : null,
  system_decision: finalDecision,
  child_execution_allowed: claimOwner,
  response_code: responseCode || finalDecision.response_code || null,
  final_reply: finalReply || finalDecision.final_reply || null,
  ledger_alert: ledgerAlert,
  ledger_age_seconds: ledgerAgeSeconds,
  escalate: ledgerAlert || finalDecision.escalate === true
} }];
