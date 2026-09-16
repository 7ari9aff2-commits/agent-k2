const parentPayload = $('Prepare Handoff Input').first().json || {};
const handoffResult = $json || {};
const result = handoffResult.result && typeof handoffResult.result === 'object' ? handoffResult.result : handoffResult;
// P-HANDOFF v40: a failed handoff must be loud. Previously a child failure was
// swallowed: the turn still claimed a human would respond while no handoff_requests
// row existed and nobody was notified. Throwing halts the turn and fires the K2
// Error Monitor; the child itself now retries transient RPC failures.
const handoffCreatedFlag = result.success === true || result.created === true || result.reused === true;
if (handoffCreatedFlag !== true) {
  const failReason = String((result && (result.code || (result.error && (result.error.message || result.error)))) || 'unknown_error');
  throw new Error('K2_HANDOFF_CHILD_FAILED: ' + failReason);
}
return { json: {
  ...parentPayload,
  handoff_result: result,
  handoff_created: handoffCreatedFlag,
  handoff_request_id: result.handoff_request_id || result.request_id || result.id || null
} };