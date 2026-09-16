const parentPayload = { ...$json };
const output = parentPayload.output || {};
const readNode = (name) => { try { return $(name).first().json || {}; } catch (_) { return {}; } };
const orchestrator = readNode('System Orchestrator (Policy)');
const decision = orchestrator.system_decision || {};
const proposal = orchestrator.proposal || {};
const ctx = readNode('Normalize & Validate');
const priorNode = readNode('Get Conversation State');
const prior = priorNode.state_data || {};
const text = String(ctx.message_text || '').trim();
const toDeterministicUuid = (value) => {
  const raw = String(value || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) return raw.toLowerCase();
  const source = raw || 'agents-k2-handoff';
  const hash = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < source.length; i += 1) {
      h ^= source.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  let hex = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map(hash).join('');
  hex = `${hex.slice(0, 12)}5${hex.slice(13, 16)}a${hex.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const correlationSource = ctx.idempotency_key || ctx.message_id || `${ctx.conversation_id || ''}:${text}`;
const correlationId = toDeterministicUuid(correlationSource);
const rawChannelId = String(ctx.channel_id || '').trim();
const normalizedChannelId = toDeterministicUuid(`${ctx.channel_type || 'unknown'}:${rawChannelId || 'unknown'}`);
const rawReason = String(output.handoff_reason || output.escalation_reason || proposal.handoff_reason || proposal.escalation_reason || '').trim();
const reasonText = [rawReason, text].filter(Boolean).join(' ').toLowerCase();
const has = (pattern) => pattern.test(reasonText);
let reasonCode = 'AI_UNABLE_TO_HELP';
if (has(/(?:موظف|بشري|إنسان|انسان|حد من الاستقبال|كلموني|عايز اكلم حد|human|agent|reception|customer service)/iu)) reasonCode = 'PATIENT_REQUESTED_HUMAN';
else if (has(/(?:شكوى|اشتك|مش مبسوط|مش راضي|غير راض|complaint|not happy|unhappy)/iu)) reasonCode = 'COMPLAINT';
else if (has(/(?:دفع|فاتورة|سداد|payment|invoice)/iu)) reasonCode = 'PAYMENT_ISSUE';
else if (has(/(?:خطأ تقني|مشكلة تقنية|النظام|تعطل|مش شغال|system|technical|error|not working)/iu)) reasonCode = 'SYSTEM_EXCEPTION';
else if (has(/(?:موعد|حجز|تعديل|إلغاء|الغاء|appointment|booking|cancel|reschedul)/iu)) reasonCode = 'APPOINTMENT_EXCEPTION';
else if (Number(output.confidence ?? proposal.confidence ?? 1) < Number(decision.confidence_threshold ?? 0.75)) reasonCode = 'LOW_CONFIDENCE';
let priority = 'NORMAL';
if (has(/(?:طارئ|عاجل|عاجل جداً|ضروري|urgent|emergency)/iu)) priority = 'URGENT';
else if (reasonCode === 'COMPLAINT' || reasonCode === 'PAYMENT_ISSUE' || reasonCode === 'APPOINTMENT_EXCEPTION') priority = 'HIGH';
const booking = output.booking_context || output.slot_state || prior.booking_context || prior.slot_state || {};
const contextSnapshot = {
  message_text: text,
  latest_reply: output.final_reply || output.reply_text || decision.final_reply || '',
  conversation_summary: prior.conversation_summary || '',
  recent_turns: Array.isArray(prior.recent_turns) ? prior.recent_turns.slice(-4) : [],
  booking_context: booking,
  appointment_id: output.appointment_id || prior.appointment_id || null
};
const metadata = {
  source: 'agents_k2',
  response_code: output.response_code || decision.response_code || 'HANDOFF_REQUIRED',
  intent: output.intent || proposal.intent || null,
  proposed_action: output.proposed_action || proposal.proposed_action || null,
  confidence: output.confidence ?? proposal.confidence ?? null,
  reason_inferred: !rawReason,
  source_idempotency_key: ctx.idempotency_key || null,
  raw_channel_id: rawChannelId || null,
  normalized_channel_id: normalizedChannelId,
  workflow_version: 'handoff-link-v2'
};
return { json: {
  ...parentPayload,
  handoff_input: {
    clinic_id: ctx.clinic_id || '',
    conversation_id: ctx.conversation_id || '',
    patient_id: ctx.patient_id || '',
    channel_type: ctx.channel_type || '',
    channel_id: normalizedChannelId,
    handoff_reason: rawReason || 'agent_escalation',
    reason_code: reasonCode,
    reason_note: rawReason || null,
    correlation_id: correlationId,
    source_message_id: ctx.message_id || '',
    priority,
    context_snapshot: contextSnapshot,
    metadata
  }
} };