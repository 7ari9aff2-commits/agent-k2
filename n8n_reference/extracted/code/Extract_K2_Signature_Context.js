const normalized = $('Normalize & Validate').first().json || {};
const inbound = $('Webhook - Incoming Message').first().json || {};
const sourceBody = (inbound.body && typeof inbound.body === 'object') ? inbound.body : inbound;
const headers = (inbound.headers && typeof inbound.headers === 'object') ? inbound.headers : {};
const signature = headers['x-k2-signature'] || headers['X-K2-Signature'] || headers['X-K2-SIGNATURE'] || null;
return [{ json: { ...normalized, k2_signature: signature, k2_signed_payload: JSON.stringify(sourceBody) } }];