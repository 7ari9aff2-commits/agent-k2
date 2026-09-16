// R1: Empty Agent 1 reply handling (v2 - no anonymous-greeting fabrication).
// Root cause (executions 4417/4657): when the chat model burned its full output
// budget on hidden reasoning it returned EMPTY text. R1 v1 replaced that empty
// output with a canned anonymous greeting, so a real booking request degraded
// into a persona-less first-contact greeting.
// v2 behavior: keep the output unchanged and defer to the one-shot self-repair
// chain (Build Repair Prompt -> DeepSeek Repair Chain -> Validate Repaired
// Contract), which rebuilds the contract with the full patient message and
// context. If repair also fails, the deterministic empty-reply fallback reaches
// the patient and the NEXT turn resumes through error-followup recovery - never
// an anonymous greeting.
const first = $input.first();
const data = (first && first.json) || {};
const raw = (typeof data.output === 'string' ? data.output : '') || (typeof data.text === 'string' ? data.text : '');
const trimmed = raw.trim();
const isEmpty = trimmed.length === 0;
const isTooShort = trimmed.length > 0 && trimmed.length < 5;
const startsOpen = trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[';
const endsClose = trimmed.charAt(trimmed.length - 1) === '}' || trimmed.charAt(trimmed.length - 1) === ']';
const looksLikeJsonAttempt = startsOpen && !endsClose;
if (isEmpty || isTooShort || looksLikeJsonAttempt) {
  const r2 = (data.p17_llm_error && typeof data.p17_llm_error === 'object') ? data.p17_llm_error : {};
  const reason = isEmpty ? 'empty_output' : (isTooShort ? 'too_short' : 'malformed_json_attempt');
  data.p17_recovery_applied = { reason: reason, recovery_type: 'defer_to_self_repair', r2_classification: r2.classification || null, output_unchanged: true, recovered_length: raw.length };
  data.p17_empty_output_deferred = true;
  // Output stays empty/unmodified so NAO flags contract_missing and IF Contract
  // Needs Repair routes to the one-shot self-repair chain.
} else {
  data.p17_recovery_applied = { reason: 'none', recovery_type: 'none', recovered_length: raw.length };
}
return { json: data };
