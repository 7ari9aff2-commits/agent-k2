const raw = $input.item.json.body ?? $input.item.json;
const body = (raw && typeof raw === 'object') ? raw : {};
const pick = (...values) => values.find(v => v !== undefined && v !== null && String(v).trim() !== '');
const clean = (t) => String(t ?? '').trim().replace(/\s+/g, ' ').normalize('NFC');
const clinicId = clean(pick(body.clinic_id, body.clinicId));
const channelType = clean(pick(body.channel_type, body.channel, body.platform, body.source)).toLowerCase().replace(/\s+/g, '_');
const channelId = clean(pick(body.channel_id, body.channelId, body.chat_id, body.thread_id, body.sender_id, body.user_id, body.from_id));
const patientId = clean(pick(body.patient_id, body.patientId));
const conversationId = clean(pick(body.conversation_id, body.conversationId, body.thread_id, body.chat_id));
const chatIdRaw = pick(body.metadata?.telegram_chat_id, body.metadata?.whatsapp_chat_id, body.metadata?.chat_id, body.chat_id);
const chatId = chatIdRaw === undefined || chatIdRaw === null ? '' : clean(chatIdRaw);
const rawMessageText = clean(pick(body.message_text, body.messageText, body.text, body.message?.text, body.message?.body, body.content));
// P1.7: Increased MAX_MESSAGE_CHARS to 8000 to handle long patient descriptions / complaints.
// Smart truncation at sentence/word boundary preserves readability when over limit.
const MAX_MESSAGE_CHARS = 8000;
const messageTooLong = rawMessageText.length > MAX_MESSAGE_CHARS;
let text = rawMessageText;
if (messageTooLong) {
  const slice = rawMessageText.slice(0, MAX_MESSAGE_CHARS);
  // Try sentence boundary (Arabic + English + Urdu) to keep meaning intact.
  const boundaryMarkers = ['.\n', '.\r\n', '؟\n', '۔ ', '. ', '! ', '? ', '؟ ', '\n\n'];
  let bestBoundary = -1;
  for (const marker of boundaryMarkers) {
    const idx = slice.lastIndexOf(marker);
    if (idx > MAX_MESSAGE_CHARS * 0.7) {
      bestBoundary = Math.max(bestBoundary, idx + marker.length - 1);
    }
  }
  if (bestBoundary > 0) {
    text = slice.slice(0, bestBoundary + 1).trim();
  } else {
    // Fall back to word/line boundary.
    const lastSpace = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
    if (lastSpace > MAX_MESSAGE_CHARS * 0.85) {
      text = slice.slice(0, lastSpace).trim();
    } else {
      text = slice;
    }
  }
}
const sourceEventId = clean(pick(body.source_event_id, body.sourceEventId, body.wamid, body.message_id, body.messageId, body.event_id, body.eventId, body.update_id, body.updateId, body.id));
const sourceTimestamp = pick(body.received_at, body.receivedAt, body.timestamp, body.created_at, body.createdAt, body.sent_at);
const runId = clean(pick(body.run_id, body.runId));
const testId = clean(pick(body.test_id, body.testId));
const operationId = clean(pick(body.operation_id, body.operationId, body.metadata?.operation_id));
const deferredReplay = body.metadata?.k2_deferred_replay === true || body.metadata?.k2_deferred_replay === 'true' || body.k2_deferred_replay === true;

// P1.2/P0.3: deterministic reference time. Prefer the inbound event timestamp;
// fall back to runtime time only when the source timestamp is absent/invalid.
// The clinic timezone is intentionally unresolved here: Get Clinic Context is authoritative.
function parseSourceTimestamp(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const numeric = Number(text);
  const ms = Number.isFinite(numeric)
    ? (text.length === 10 ? numeric * 1000 : numeric)
    : Date.parse(text);
  return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime()) ? ms : null;
}
const sourceTimestampMs = parseSourceTimestamp(sourceTimestamp);
const referenceNowMs = sourceTimestampMs ?? Date.now();
const referenceNowIso = new Date(referenceNowMs).toISOString();
const timeContext = {
  schema_version: 2,
  timezone: null,
  utc_offset: null,
  timezone_source: 'pending_clinic_configuration',
  source: sourceTimestampMs === null ? 'runtime_now' : 'received_at',
  source_timestamp: sourceTimestampMs === null ? null : referenceNowIso,
  now_iso: referenceNowIso,
  now_local_date: null,
  now_local_time: null,
  now_local_weekday: null,
};
const idempotencyDegraded = !sourceEventId;
// A source event id is mandatory. Never manufacture a random id because retries
// without a stable provider id must be rejected instead of processed twice.
const messageId = sourceEventId || null;
const missing = [];
for (const [key, value] of Object.entries({ clinic_id: clinicId, channel_type: channelType, channel_id: channelId, patient_id: patientId, conversation_id: conversationId, message_text: text })) {
  if (!value) missing.push(key);
}
const normalizationMissing = [...missing, ...(!sourceEventId ? ['source_event_id'] : [])];
if (normalizationMissing.length) {
  return [{ json: {
    clinic_id: clinicId || null,
    channel_type: channelType || null,
    channel_id: channelId || null,
    patient_id: patientId || null,
    conversation_id: conversationId || null,
    message_text: text || null,
    message_id: messageId,
    source_event_id: sourceEventId || null,
    idempotency_degraded: idempotencyDegraded,
    deferred_replay: deferredReplay,
    normalization_error: true,
    normalization_error_code: 'INVALID_INBOUND_PAYLOAD',
    normalization_missing_fields: normalizationMissing,
    normalization_error_message: 'تعذر معالجة الطلب بسبب نقص معرف الرسالة الثابت أو بيانات الرسالة الأساسية'
  } }];
}
const channelKey = `${channelType}:${channelId}`;
const idempotencyKey = `${channelKey}:${messageId}`;
const correlationId = clean(pick(body.correlation_id, body.correlationId, body.metadata?.correlation_id, idempotencyKey));
const hasArabic = /[\u0600-\u06FF]/.test(text);
const hasEnglish = /[a-zA-Z]/.test(text);
const language = hasArabic && hasEnglish ? 'mixed' : hasArabic ? 'arabic' : hasEnglish ? 'english' : 'unknown';
return [{ json: {
  clinic_id: clinicId,
  channel_type: channelType,
  channel_id: channelId,
  channel_key: channelKey,
  patient_id: patientId,
  conversation_id: conversationId,
  chat_id: chatId || null,
  message_text: text,
  message_truncated: messageTooLong === true,
  message_id: messageId,
  source_event_id: sourceEventId || null,
  idempotency_degraded: idempotencyDegraded,
  deferred_replay: deferredReplay,
  wamid: body.wamid || null,
  received_at: referenceNowIso,
  idempotency_key: idempotencyKey,
  operation_id: operationId || null,
  correlation_id: correlationId || null,
  run_id: runId || null,
  test_id: testId || null,
  time_context: timeContext,
  metadata: { chat_id: chatId || null, content_length: text.length, original_content_length: rawMessageText.length, message_length_limit: MAX_MESSAGE_CHARS, language, source_event_id: sourceEventId || null, idempotency_degraded: idempotencyDegraded, wamid: body.wamid || null, channel_type: channelType, channel_id: channelId, message_id: messageId, idempotency_key: idempotencyKey, operation_id: operationId || null, correlation_id: correlationId || null, deferred_replay: deferredReplay, k2_deferred_replay: deferredReplay, time_context: timeContext }
} }];