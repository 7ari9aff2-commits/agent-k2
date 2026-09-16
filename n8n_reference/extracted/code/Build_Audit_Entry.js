const readNode = (name) => { try { return $(name).first().json || {}; } catch (_) { return {}; } };
const agentItem = (() => { try { const r = $('Validate Repaired Contract (Deterministic)').first().json; if (r && r._contract_status === 'VALID') return r; } catch (_) {} return readNode('Normalize Agent Output (Deterministic)'); })();
const responseItem = readNode('Response Policy (Deterministic)');
const finalItem = $json || {};
const agentOutput = responseItem.output && typeof responseItem.output === 'object' ? responseItem.output : (agentItem.output && typeof agentItem.output === 'object' ? agentItem.output : {});
const decision = responseItem.system_decision || agentOutput.system_decision || {};
const intermediateSteps = Array.isArray(agentItem.intermediateSteps) ? agentItem.intermediateSteps : [];
const ctx = readNode('Normalize & Validate');
const toolCalls = intermediateSteps.map(step => ({ tool: step.action?.tool || null, input: step.action?.toolInput || null, output: typeof step.observation === 'string' ? step.observation.slice(0, 500) : step.observation }));
const receivedAt = ctx.received_at;
const replayed = responseItem.replay_gate?.matched === true;
const responseCode = finalItem.response_code || responseItem.response_code || finalItem.facts?.response_code || decision.response_code || null;
const operationStatus = finalItem.operation_status || responseItem.operation_status || finalItem.facts?.operation_status || agentOutput.operation_status || null;
const appointmentId = finalItem.appointment_id || responseItem.appointment_id || finalItem.facts?.appointment_id || decision.appointment_id || agentOutput.appointment_id || null;
const bookingNumber = finalItem.booking_number || responseItem.booking_number || finalItem.facts?.booking_number || decision.booking_number || decision.booking_context?.booking_number || agentOutput.booking_number || null;
const appointmentType = finalItem.appointment_type || responseItem.appointment_type || finalItem.facts?.appointment_type || decision.appointment_type || decision.booking_context?.appointment_type || agentOutput.appointment_type || null;
const intent = finalItem.agent_contract?.turn?.intent || finalItem.turn?.intent || responseItem.facts?.turn_intent || agentItem.contract?.turn?.intent || (replayed ? 'booking' : null);
const invalidTransition = responseCode === 'INVALID_STATE_TRANSITION' || responseItem.audit_event === 'invalid_transition';
const resultPhase = String(finalItem.single_agent_phase || finalItem.agent_phase || responseItem.single_agent_phase || '') === 'result';
// v19: the deployed models (main, result, repair) are deepseek/deepseek-v3.2.
// The old fallback referenced a stale flash alias that never matched reality.
const knownModel = 'deepseek/deepseek-v3.2';
const runtimeModelRaw = String(finalItem.model || finalItem.model_name || finalItem.model_id || responseItem.model || agentOutput.model || agentOutput.model_name || '').trim();
const runtimeModel = runtimeModelRaw || knownModel;

// understanding-failure telemetry (zero-token flywheel): deterministic detection only
const stState = readNode('Get Conversation State').state_data || {};
const draftLive = ['DRAFT', 'AWAITING_CONFIRMATION', 'EXECUTING', 'COLLECTING_APPOINTMENT_DETAILS', 'COLLECTING_PATIENT_DATA'].includes(String(stState.operation_state || '').toUpperCase());
const modelIntentLabel = String((agentItem._normalization && agentItem._normalization.model_turn_intent) || '').toLowerCase();
const understandingConfidence = (agentItem._normalization && agentItem._normalization.confidence !== undefined && agentItem._normalization.confidence !== null) ? agentItem._normalization.confidence : null;
const confNum = Number(understandingConfidence);
const weakLabels = ['unclear', 'other', 'small_talk', 'clarification'];
// v19: pure social/info turns legitimately carry low model confidence. They are
// not understanding failures and must not pollute the failure analytics.
const benignLowConfidenceLabels = ['small_talk', 'greeting', 'other', 'clinic_query'];
const failureTypes = [];
if (weakLabels.includes(modelIntentLabel) && draftLive) failureTypes.push('model_unclear_live_draft');
if (weakLabels.includes(modelIntentLabel) && /حجز|موعد|دكتور|book/i.test(String(ctx.message_text || ''))) failureTypes.push('booking_vocab_non_booking');
if (Number.isFinite(confNum) && confNum < 0.5 && !benignLowConfidenceLabels.includes(modelIntentLabel)) failureTypes.push('low_confidence_label');
const replyForTelemetry = String(finalItem.canonical_reply || finalItem.final_reply || finalItem.rendered_reply || responseItem.canonical_reply || '').trim();
if (!replyForTelemetry) failureTypes.push('empty_reply');
else if (/تعذر صياغة الرد/.test(replyForTelemetry)) failureTypes.push('generic_error_reply');
const orchItem = readNode('System Orchestrator (Policy)');
const orchDecision = orchItem.system_decision && typeof orchItem.system_decision === 'object' ? orchItem.system_decision : {};
const orchState = orchDecision.state_machine && typeof orchDecision.state_machine === 'object' ? orchDecision.state_machine : {};
// v19: real end-to-end duration from the inbound event to this audit point.
const receivedAtMs = Date.parse(String(receivedAt || ''));
const totalTimeMs = Number.isFinite(receivedAtMs) ? Math.max(0, Date.now() - receivedAtMs) : null;
return [{ json: {
  conversation_id: ctx.conversation_id,
  clinic_id: ctx.clinic_id,
  patient_id: ctx.patient_id,
  message_text: ctx.message_text,
  intent,
  operation_status: invalidTransition ? 'invalid_transition' : operationStatus,
  escalate: finalItem.escalate === true || responseItem.escalate === true || agentOutput.escalate === true,
  appointment_id: appointmentId,
  booking_number: bookingNumber,
  appointment_type: appointmentType,
  reply_text: String(finalItem.canonical_reply || finalItem.final_reply || finalItem.rendered_reply || responseItem.canonical_reply || '').trim() || null,
  response_code: responseCode,
  decision_engine: orchItem.decision_engine || null,
  engine_version: orchItem.engine_version || null,
  decision_engine_source: orchItem.decision_engine_source || null,
  decision_rule: orchDecision.decision_rule || null,
  state_from: orchState.previous_state || null,
  state_to: orchState.current_state || null,
  model: replayed ? 'deterministic-replay-gate' : runtimeModel,
  model_source: replayed ? 'deterministic' : (runtimeModelRaw ? 'runtime' : 'known-config'),
  tool_calls: toolCalls,
  tool_call_count: toolCalls.length,
  total_time_ms: totalTimeMs,
  received_at: receivedAt,
  normalization_valid: replayed ? true : (agentItem._normalization?.valid ?? null),
  normalization_error: replayed ? null : (agentItem._normalization?.errors?.join('|') ?? null),
  audit_event: invalidTransition ? 'invalid_transition' : null,
  understanding_failure_types: failureTypes,
  understanding_draft_live: draftLive,
  understanding_model_intent: modelIntentLabel,
  understanding_confidence: understandingConfidence
} }];