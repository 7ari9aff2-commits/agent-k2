function nodeJson(name) {
  try { return $(name).first().json || {}; } catch (_) { return {}; }
}
function modelRows(name) {
  try { return $(name).all().map(item => item && item.json ? item.json : {}).filter(Boolean); }
  catch (_) { return []; }
}
function sumUsageTokens(rows) {
  let sum = 0;
  for (const row of rows) {
    const usage = row.tokenUsage || row.usage || row.response?.tokenUsage || row.response?.usage || {};
    const reported = Number(usage.totalTokens ?? usage.total_tokens);
    if (Number.isFinite(reported) && reported > 0) sum += reported;
    else sum += (Number(usage.promptTokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens) || 0)
      + (Number(usage.completionTokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens) || 0);
  }
  return sum;
}
const normalized = nodeJson('Normalize & Validate');
const initial = nodeJson('Save Conversation State');
const retry = nodeJson('Save Conversation State (retry) (v18)');
const retryRan = Object.keys(retry).length > 0;
const hasTransportError = (value) => Boolean(value && (
  value.error || value.errorMessage || value.errorDetails
  || Number(value.statusCode) >= 400 || Number(value.status) >= 400
));
const saveTransportFailed = hasTransportError(initial) || hasTransportError(retry);
const saveFailed = saveTransportFailed || retry.saved === false || (!retryRan && initial.saved === false && initial.rejected_reason !== 'CONCURRENT_STATE_STALE');
const extracted = nodeJson('Extract Single Agent Reply');
const extractedReply = extracted.render_used === true
  ? extracted.rendered_reply
  : (extracted.agent_reply || extracted.final_reply || extracted.canonical_reply || extracted.rendered_reply || '');
const reply = saveFailed ? 'تعذر حفظ حالة المحادثة حاول مرة أخرى' : String(extractedReply || '');
const responsePolicy = nodeJson('Response Policy (Deterministic)');

// Agent 1 (Booking Assistant Agent) and Agent 2 (Result Reply Composer) each make
// their own separate LLM call with their own systemMessage. Previously only Agent 1's
// usage (DeepSeek Model) was summed here, silently undercounting ai_tokens on any turn
// where Agent 2 (DeepSeek Result Model) also ran.
const agent1Tokens = sumUsageTokens(modelRows('DeepSeek Model'));
const agent2Tokens = sumUsageTokens(modelRows('DeepSeek Result Model'));
const totalTokens = agent1Tokens + agent2Tokens;

// v19: model name corrected to the actually deployed model (was a stale flash alias).
const OUTGOING_MODEL = 'deepseek/deepseek-v3.2';

const outgoingMetadata = JSON.stringify({
  intent: responsePolicy.facts?.turn_intent || null,
  response_code: saveFailed ? 'STATE_SAVE_FAILED' : responsePolicy.response_code || null,
  operation_status: responsePolicy.output?.operation_status || null,
  appointment_id: responsePolicy.output?.appointment_id || null,
  idempotency_key: normalized.idempotency_key || null,
  state_save_transport_failed: saveTransportFailed,
  agent1_tokens: agent1Tokens > 0 ? agent1Tokens : null,
  agent2_tokens: agent2Tokens > 0 ? agent2Tokens : null
});

return [{ json: {
  query_params: [
    normalized.idempotency_key || null,
    normalized.conversation_id || null,
    normalized.clinic_id || null,
    normalized.patient_id || null,
    reply,
    new Date().toISOString(),
    outgoingMetadata,
    normalized.message_id || null,
    OUTGOING_MODEL,
    totalTokens > 0 ? totalTokens : null
  ],
  outgoing_model: OUTGOING_MODEL,
  outgoing_ai_tokens: totalTokens > 0 ? totalTokens : null
} }];