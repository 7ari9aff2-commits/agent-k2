const input = $input.item.json || {};
const body = (input.body && typeof input.body === 'object') ? input.body : input;
const missing = [];
for (const key of ['clinic_id','channel_type','channel_id','patient_id','conversation_id','message_text','source_event_id']) {
  const aliases = { clinic_id:['clinic_id','clinicId'], channel_type:['channel_type','channel','platform','source'], channel_id:['channel_id','channelId','chat_id','thread_id','sender_id','user_id','from_id'], patient_id:['patient_id','patientId'], conversation_id:['conversation_id','conversationId','thread_id','chat_id'], message_text:['message_text','messageText','text','content'], source_event_id:['source_event_id','wamid','message_id','messageId','event_id','eventId','update_id','updateId','id'] }[key];
  if (!aliases.some(k => body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '')) missing.push(key);
}
const errorLike = Boolean(input.error || input.errorResponse || input.normalization_error);
const invalid = errorLike || missing.length > 0 || !input.idempotency_key || !input.message_id;
const existingCode = String(input.normalization_error_code || '').trim();
const errorCode = existingCode === 'MESSAGE_TOO_LONG' ? existingCode : (invalid ? 'INVALID_INBOUND_PAYLOAD' : null);
const errorMessage = existingCode === 'MESSAGE_TOO_LONG' ? (input.normalization_error_message || 'الرسالة أطول من الحد المسموح لمعالجتها') : (invalid ? 'تعذر معالجة الطلب بسبب نقص بيانات الرسالة الأساسية' : null);
return [{ json: { ...input, normalization_error: invalid, normalization_error_code: errorCode, normalization_missing_fields: missing, normalization_error_message: errorMessage } }];