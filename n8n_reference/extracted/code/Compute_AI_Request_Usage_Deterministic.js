// v19 (2026-09-04): use real provider tokenUsage when the chat-model node exposes
// it on the main channel; otherwise a calibrated char-count estimate. Also fixes
// the model name: deployed models are deepseek/deepseek-v3.2 (previously every
// row was logged with a stale flash alias).
function readNode(name) { try { return $(name).first().json || {}; } catch (_) { return {}; } }
function readModelTokens(name) {
  try {
    const all = $(name).all();
    let sum = 0;
    for (const item of all) {
      const d = (item && item.json) || {};
      const u = d.tokenUsage || d.usage || (d.response && (d.response.tokenUsage || d.response.usage)) || {};
      const t = Number(u.totalTokens ?? u.total_tokens ?? u.total);
      if (Number.isFinite(t) && t > 0) { sum += t; continue; }
      const p = Number(u.promptTokens ?? u.inputTokens ?? u.prompt_tokens ?? u.input_tokens) || 0;
      const c = Number(u.completionTokens ?? u.outputTokens ?? u.completion_tokens ?? u.output_tokens) || 0;
      if (p > 0 || c > 0) sum += p + c;
    }
    return sum;
  } catch (_) { return 0; }
}
const CHARS_PER_TOKEN = 3.2; // calibrated against observed provider totals
const nowIso = $now.toISO();
const ctx = (() => { try { return $('Normalize & Validate').first().json || {}; } catch (_) { return {}; } })();
const persona = readNode('Build Clinic Persona Context (Deterministic)');
const promptChars = Number(persona.agent_system_prompt_chars) || 0;
const reply1 = String(readNode('Booking Assistant Agent').output || '');
const reply2 = String(readNode('Result Reply Composer').output || '');
const ctx2 = (() => { try { return JSON.stringify($('Prepare Single Agent Result Context').first().json || {}); } catch (_) { return ''; } })();
const est = (chars) => Math.max(1, Math.round(chars / CHARS_PER_TOKEN));
const MODEL = 'deepseek/deepseek-v3.2';
const rows = [];
const pushRow = (nodeName, exactTokens, inputEst, outputEst) => {
  const exact = Number(exactTokens) > 0 ? Number(exactTokens) : null;
  const input = exact === null ? est(inputEst) : null;
  const output = exact === null ? est(outputEst) : null;
  const total = exact !== null ? exact : (input || 0) + (output || 0);
  if (!total) return;
  rows.push({ json: {
    clinic_id: ctx.clinic_id || null,
    conversation_id: ctx.conversation_id || null,
    provider: 'deepseek',
    model: MODEL,
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cost: null,
    response_received_at: nowIso,
    metadata: JSON.stringify({ source: 'agent_k2', estimated: exact === null, basis: exact === null ? 'char_count_approximation' : 'provider_tokenUsage', model_node: nodeName, execution_id: $execution.id }),
    request_payload: JSON.stringify({ model_node: nodeName, estimated: exact === null })
  } });
};
if (promptChars > 0 || reply1) pushRow('DeepSeek Model', readModelTokens('DeepSeek Model'), promptChars + 1400, reply1.length);
if (reply2) pushRow('Result Reply Composer', readModelTokens('DeepSeek Result Model'), ctx2.length + 2400, reply2.length);
return rows;