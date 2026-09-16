// P-RETURN (2026-09-05): terminal node of the availability child. The persist
// branch runs BEFORE this node (side effect), but the sub-workflow contract for
// both callers (agent tool + deterministic path) is the Build Final Response
// object. Pass it through unchanged so callers never see persistence internals.
const result = (() => { try { return $('Build Final Response (Deterministic)').first().json || {}; } catch (_) { return {}; } })();
return [{ json: result }];