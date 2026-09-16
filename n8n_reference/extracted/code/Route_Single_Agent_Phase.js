const raw = String($json.output ?? $json.text ?? '').trim();
function parse(value) {
  let text = String(value || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  try { return JSON.parse(text); } catch { return {}; }
}
const contract = parse(raw);
// Result Reply Composer returns plain text. This adapter wraps it technically
// and never changes its wording.
const parsedReply = String(contract.reply ?? contract.final_reply ?? '').trim();
// A valid JSON contract with an empty reply must never fall back to the whole JSON
// document. Plain-text Result Composer output is preserved only when parsing found
// no JSON contract at all.
const modelReply = parsedReply || (Object.keys(contract).length === 0 ? raw : '');
// The model may formulate the reply, but it is never authoritative for the
// execution phase. Only the deterministic result-context may authorize result.
let resultContext = {};
try { resultContext = $('Prepare Single Agent Result Context').first().json || {}; } catch (_) {}
const upstreamPhase = resultContext.single_agent_phase || null;
const executionResult = resultContext.execution_result && typeof resultContext.execution_result === 'object'
  ? resultContext.execution_result
  : {};
const hasExecutionEvidence = upstreamPhase === 'result' && Boolean(
  resultContext.operation_id
  || resultContext.response_code
  || resultContext.operation_status
  || resultContext.mutation_status
  || resultContext.child_contract_checked === true
  || executionResult.operation_id
  || executionResult.response_code
  || executionResult.operation_status
  || executionResult.mutation_status
  || executionResult.child_contract_checked === true
);
// P-PHASE v40: hard iteration cap for the understand/result phase machine. The
// macro-cycle (Response Policy -> Composer -> Route -> Orchestrator -> Response
// Policy) terminates on response_code evidence today, but an evidence-less
// branch would spin forever (each pass costs an LLM call + a state write).
const prevLoopCount = (() => { try { const p = $('Route Single Agent Phase').first().json || {}; return Number(p.loop_count || 0); } catch (_) { return 0; } })();
const loopCount = prevLoopCount + 1;
const loopCapped = loopCount >= 4;
const phase = (hasExecutionEvidence || loopCapped) ? 'result' : 'understand';
const reply = modelReply.replace(/\s+/g, ' ').trim() || null;
return [{ json: { ...$json, loop_count: loopCount, agent_phase: phase, agent_contract: { ...contract, phase: contract.phase || phase, reply: contract.reply || reply }, agent_reply: reply, agent_raw_output: raw, phase_guard: { upstream_phase: upstreamPhase, has_execution_evidence: hasExecutionEvidence, loop_count: loopCount, loop_capped: loopCapped } } }];