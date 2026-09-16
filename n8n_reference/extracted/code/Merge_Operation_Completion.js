const original = (() => { try { return $('Validate Child Envelope').first().json || {}; } catch { return $json || {}; } })();
const completion = $input.item.json || {};
return [{ json: {
  ...original,
  operation_id: completion.operation_id || original.operation_id || null,
  operation_ledger_status: completion.operation_status || original.operation_ledger_status || null,
  operation_mutation_status: completion.mutation_status || original.operation_mutation_status || null,
  operation_finalize_response: completion.response_json || null,
  operation_finalized: Boolean(completion.operation_id),
  child_execution_id: completion.child_execution_id || original.child_execution_id || null
} }];
