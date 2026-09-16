={{ { reply_text: (() => {
  const failed = (() => {
  const read = (name) => { try { return $(name).first().json || {}; } catch (_) { return {}; } };
  const initial = read('Save Conversation State');
  const retry = read('Save Conversation State (retry) (v18)');
  const retryRan = Object.keys(retry).length > 0;
  const hasTransportError = (value) => Boolean(value && (value.error || value.errorMessage || value.errorDetails || Number(value.statusCode) >= 400 || Number(value.status) >= 400));
  return hasTransportError(initial) || hasTransportError(retry) || retry.saved === false || (!retryRan && initial.saved === false && initial.rejected_reason !== 'CONCURRENT_STATE_STALE');
})();
  if (failed) return 'تعذر حفظ حالة المحادثة حاول مرة أخرى';
  const guard = (() => { try { const g = $('Reply Guard (Deterministic)').first().json || {}; return (g._reply_guard && g._reply_guard.override) || null; } catch (_) { return null; } })();
  if (guard) return guard;
  return $("Extract Single Agent Reply").first().json.rendered_reply;
})(), conversation_id: $("Normalize & Validate").first().json.conversation_id, clinic_id: $("Normalize & Validate").first().json.clinic_id, outgoing_message_id: $("Log Outgoing Message").first().json.id || null, response_code: $("Response Policy (Deterministic)").first().json.response_code, metadata: { intent: $("Response Policy (Deterministic)").first().json.output?.intent, operation_status: $("Response Policy (Deterministic)").first().json.output?.operation_status, appointment_id: $("Response Policy (Deterministic)").first().json.output?.appointment_id, escalate: $("Response Policy (Deterministic)").first().json.output?.escalate, proposed_action: $("Response Policy (Deterministic)").first().json.output?.proposed_action, processed_at: $now.toISO() }, _debug: { deterministic_override: (() => { try { const g = $('Reply Guard (Deterministic)').first().json || {}; return Boolean(g._reply_guard && g._reply_guard.override); } catch (_) { return false; } })() } } }}