const item = $input.item.json || {};
const candidates = ['output', 'text', 'agent_raw_output', 'raw', 'data'];
let key = null;
for (const k of candidates) {
  if (typeof item[k] === 'string' && item[k].trim().startsWith('{')) { key = k; break; }
}
let parsed = null;
if (key) { try { parsed = JSON.parse(item[key]); } catch (_) { parsed = null; } }
if (!parsed || parsed.schema_version !== 'k2.dialogue.v4') {
  return [{ json: { ...item, _adapter: { action: 'passthrough', reason: parsed ? 'not_v4' : 'unparseable' } } }];
}
const e = parsed.entities || {};
const ref = typeof e.reference === 'string' ? e.reference.trim() : '';
const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref);
// FIX (2026-09-07): v4 has no `certainty` enum, only numeric `confidence`.
// The old code hardcoded certainty:null here, which the deterministic layer
// then defaulted to 'uncertain' for every normal turn. Derive it from the
// model's own confidence score instead of discarding the signal.
const confidenceNum = typeof parsed.confidence === 'number' ? parsed.confidence : null;
const derivedCertainty = confidenceNum === null ? null
  : confidenceNum >= 0.75 ? 'certain'
  : confidenceNum >= 0.4 ? 'probable'
  : 'uncertain';
// FIX (2026-09-07): v4 has no direct references_prior_conversation signal
// either. The old code hardcoded this to false for every turn, silently
// disabling every downstream policy branch keyed on it. Derive a reasonable
// proxy from what v4 DOES capture: the patient stated an explicit
// reference/booking number, or the model classified this turn as a
// follow_up relative to the previous one.
const relation = (parsed.turn && parsed.turn.relation_to_previous_turn) || 'none';
const derivedPriorReference = ref.length > 0 || relation === 'follow_up';
const v3 = {
  schema_version: 'k2.dialogue.v3',
  phase: 'understand',
  reply: parsed.reply || '',
  turn: { intent: (parsed.turn && parsed.turn.intent) || 'other', relation_to_previous_turn: relation, certainty: derivedCertainty, confidence: confidenceNum },
  confirmation: { intent: (parsed.confirmation && parsed.confirmation.intent) || 'none' },
  selection: { kind: (parsed.selection && parsed.selection.kind) || 'none', rank: (parsed.selection && parsed.selection.rank) ?? null, date: e.date || null, time: e.time || null },
  entities: { doctor_name: e.doctor_name || null, service_name: e.service_name || null, date: e.date || null, time: e.time || null, visit_type: e.visit_type || null, patient_name: e.patient_name || null, patient_phone: e.patient_phone || null, patient_age: typeof e.patient_age === 'number' ? e.patient_age : null, patient_address: e.patient_address || null, appointment_id: isUuid ? ref : null, booking_number: ref && !isUuid ? ref : null },
  operation_proposal: { type: !parsed.operation_proposal || !parsed.operation_proposal.type || parsed.operation_proposal.type === 'none' ? '' : parsed.operation_proposal.type, requested: !!(parsed.operation_proposal && parsed.operation_proposal.requested === true) },
  references_prior_conversation: derivedPriorReference,
  escalate: !!parsed.escalate,
  handoff_reason: parsed.escalate || null,
  ambiguous: Array.isArray(parsed.ambiguous) ? parsed.ambiguous : []
};
const out = { ...item };
if (key) out[key] = JSON.stringify(v3);
out.output = JSON.stringify(v3);
out.text = JSON.stringify(v3);
out._adapter = { action: 'v4_to_v3', escalated_reason: v3.handoff_reason, ambiguous: v3.ambiguous, derived_certainty: derivedCertainty, derived_prior_reference: derivedPriorReference };
return [{ json: out }];