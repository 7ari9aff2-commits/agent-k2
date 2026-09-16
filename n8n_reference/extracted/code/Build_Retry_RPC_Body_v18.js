// v18 root continuity fix: retry must preserve the complete current-turn state.
// The previous implementation merged only booking_context, slot_state, and facts.
// If the first save lost a race, stale last_open_question / missing fields survived.
const fresh = $('Get Conversation State (retry) (v18)').first().json.state_data || {};
const bp = $('Build Persistent Conversation State').first().json || {};
const sv = Number(fresh.state_version || 0) || 0;
const bpStateData = (bp.state_data && typeof bp.state_data === 'object') ? bp.state_data : {};
const merged = { ...fresh };
// ORCH-SEC: semantic merge guard — if the freshly fetched state reached a
// terminal operation state, or a different operation won the conversation,
// our current-turn state-machine keys are stale and must not overwrite it.
const TERMINAL_OP_STATES = ['COMPLETED','CANCELLED','FAILED_FINAL'];
const freshOpState = String(fresh.operation_state || '').toUpperCase();
const freshOpId = String(fresh.operation_id || '');
const myOpId = String(bpStateData.operation_id || '');
const semanticConflict = TERMINAL_OP_STATES.includes(freshOpState) || (myOpId !== '' && freshOpId !== '' && freshOpId !== myOpId);
const currentTurnKeys = semanticConflict ? [
  'last_channel','last_updated'
] : [
  'patient_data_review','conversation_stage','required_next_step','state_schema_version',
  'availability_inquiry','availability_lookup_lineage_status','availability_lineage','availability_outcome',
  'availability_alternatives','availability_requested_time_unavailable','deterministic_slot_lookup','slot_lookup_ready',
  'next_best_missing_human_field','missing_human_fields','superseded_operation','last_intent','current_intent',
  'active_operation','operation_status','operation_state','operation_id','operation_action','original_response_code',
  'routing_action','resume_eligible','retryable','failure_code','migration_status','migration_issues','pending_action',
  'last_open_question','waiting_for_reference','confirmation_state','confirmation_target','confirmation_delivery_status',
  'confirmation_delivery_recorded_at','confirmation_ttl_seconds','confirmation_expires_at','confirmation_target_hash',
  'draft_started_at','draft_expires_at','draft_ttl_seconds','business_time_checked','business_time_status',
  'business_time_timezone','business_time_source','business_time_error_code','confirmation_target_invalidated',
  'confirmation_contract','appointment_id','response_code','confidence','escalate','conversation_summary',
  'recent_turns','last_message_id','last_idempotency_key','last_channel','last_updated'
];
for (const key of currentTurnKeys) {
  if (Object.prototype.hasOwnProperty.call(bpStateData, key)) merged[key] = bpStateData[key];
}
if (!semanticConflict && bpStateData.booking_context && typeof bpStateData.booking_context === 'object') merged.booking_context = bpStateData.booking_context;
if (!semanticConflict && bpStateData.slot_state && typeof bpStateData.slot_state === 'object') merged.slot_state = bpStateData.slot_state;
if (!semanticConflict && bpStateData.facts && typeof bpStateData.facts === 'object') {
  const freshFacts = fresh.facts && typeof fresh.facts === 'object' ? fresh.facts : {};
  merged.facts = { ...freshFacts, ...bpStateData.facts };
  if (freshFacts.patient || bpStateData.facts.patient) merged.facts.patient = { ...(freshFacts.patient || {}), ...(bpStateData.facts.patient || {}) };
  if (freshFacts.clinic || bpStateData.facts.clinic) merged.facts.clinic = { ...(freshFacts.clinic || {}), ...(bpStateData.facts.clinic || {}) };
}
const nv = $('Normalize & Validate').first().json || {};
return [{ json: { semantic_merge_conflict: semanticConflict === true, rpc_body: {
  p_conversation_id: String(nv.conversation_id || ''),
  p_state_data: { ...merged, state_version: sv + 1 },
  p_previous_state_version: sv
} } }];