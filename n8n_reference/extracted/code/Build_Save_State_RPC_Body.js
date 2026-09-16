// Builds the RPC body for k2_save_conversation_state.
// Ownership contract: p_previous_state_version = current state_version - 1,
// so the SQL upsert rejects stale concurrent writes (fail-closed).
const bp = $("Build Persistent Conversation State").first().json || {};
const nv = $("Normalize & Validate").first().json || {};
const sd = bp.state_data && typeof bp.state_data === "object" ? bp.state_data : {};
const version = Number(sd.state_version || 0) || 1;
return [{ json: { rpc_body: {
  p_conversation_id: String(nv.conversation_id || ""),
  p_state_data: sd,
  p_previous_state_version: Math.max(0, version - 1)
} } }];
