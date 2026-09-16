// R2: LLM error detection (v2 - empty outputs are never 'no_error').
// v1 classified only explicit/implicit error strings, so an EMPTY output after a
// full token-budget burn (execution 4417/4657: finish_reason 'length', text '')
// was reported as no_error and R1 then fabricated an anonymous greeting.
// v2: an empty output is itself a failure class ('empty_output') and flags
// p17_recovery_needed so the deterministic repair chain takes over.
const first = $input.first();
const data = (first && first.json) || {};
const errorFields = ['error', 'error_message', 'last_error', 'llm_error'];
let detectedError = null;
for (let i = 0; i < errorFields.length; i++) {
  const f = errorFields[i];
  if (data[f] && typeof data[f] === 'string' && data[f].length > 0) { detectedError = data[f]; break; }
}
if (!detectedError) {
  const meta = data.metadata || {};
  for (let i = 0; i < errorFields.length; i++) {
    const f = errorFields[i];
    if (meta[f] && typeof meta[f] === 'string' && meta[f].length > 0) { detectedError = meta[f]; break; }
  }
}
const raw = (typeof data.output === 'string' ? data.output : '') || (typeof data.text === 'string' ? data.text : '');
// Only treat short outputs (< 200 chars) as candidate error messages.
// A 500-char Arabic reply that mentions "503" is a normal explanation, not an error.
const looksLikeError = raw.length > 0 && raw.length < 200 && /rate limit|timeout|503|504|429|temporar|unavailable|try again|exceeded/i.test(raw);
const isEmptyOutput = raw.length === 0;
const isPersistentFailure = !!detectedError || looksLikeError || isEmptyOutput;
const classification = detectedError ? 'explicit_error' : (looksLikeError ? 'implicit_error' : (isEmptyOutput ? 'empty_output' : 'no_error'));
data.p17_llm_error = {
  detected: isPersistentFailure,
  detected_message: detectedError,
  looks_like_error: looksLikeError,
  output_length: raw.length,
  classification: classification,
  reason: isEmptyOutput ? 'empty_output_after_sanitization' : null
};
if (isPersistentFailure) data.p17_recovery_needed = true;
return { json: data };
