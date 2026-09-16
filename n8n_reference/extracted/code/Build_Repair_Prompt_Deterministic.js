// K2 self-repair prompt builder (deterministic; exactly one repair attempt).
const readNode = (name) => { try { const f = $(name).first(); return (f && f.json) || {}; } catch (_) { return {}; } };
const nao = readNode('Normalize Agent Output (Deterministic)');
const inbound = readNode('Normalize & Validate');
const persona = readNode('Build Clinic Persona Context (Deterministic)');
const clinic = readNode('Get Clinic Context');
const ownership = readNode('Validate Patient Ownership');
const errors = Array.isArray(nao._contract_errors) ? nao._contract_errors.slice(0, 8) : [];
const prevRaw = String(nao.agent_raw_output || '').slice(0, 600);
const timeCtx = ownership.canonical_time_context && typeof ownership.canonical_time_context === 'object'
  ? ownership.canonical_time_context : (inbound.time_context && typeof inbound.time_context === 'object' ? inbound.time_context : {});
const compactContext = {
  clinic_name: clinic.clinic_name || null,
  local_time: { date: timeCtx.now_local_date || null, time: timeCtx.now_local_time || null, timezone: timeCtx.timezone || null },
  doctor_count: clinic.doctor_count ?? null,
  state: persona.agent_context_model || null
};
const prompt = [
  'K2_SELF_REPAIR: Your previous understanding output for the patient message below was structurally invalid and could not be parsed.',
  'Structural errors: ' + (errors.join(', ') || 'unparseable_json') + '.',
  prevRaw ? 'Your previous raw output (truncated): ' + prevRaw : null,
  'Produce the corrected output now, following the contract rules exactly.',
  "Output contract k2.dialogue.v3 — JSON only, no Markdown, no commentary.\nTop-level keys exactly: schema_version, phase, reply, turn, confirmation, selection, entities, operation_proposal, references_prior_conversation, escalate, handoff_reason.\nschema_version = \"k2.dialogue.v3\". phase = \"understand\".\nreply: one short natural Arabic sentence(s) answering the patient in the clinic dialect. Never expose internal labels, enums, IDs, or stage names. Never claim a booking, cancellation, availability, or any execution result — only the Result phase may report results. Affirmation of a pending confirmation gets a brief acknowledgment only, no restated details.\nturn: { intent, relation_to_previous_turn, certainty, confidence }.\n  intent ∈ {booking_request, booking_continuation, availability_inquiry, cancellation_request, reschedule_request, confirmation, correction, small_talk, clinic_query, greeting, unclear, other}.\n  relation_to_previous_turn ∈ {new_request, answer, confirmation, correction, change_details, follow_up, none, unclear}.\n  certainty ∈ {certain, probable, uncertain}. confidence ∈ [0..1] or null.\nconfirmation: { intent } with intent ∈ {affirmative, negative, question, conditional, none}.\nselection: { kind, rank, date, time } — use ONLY when the assistant previously presented concrete appointment options (numbered alternatives or day/time offers) and the current message picks one. kind ∈ {presented_rank, presented_match, any, none}. rank = the presented option number 1..4 when chosen by number. date (ISO) / time (HH:MM) when the patient echoes a specific presented day/time. kind=any when the patient accepts whatever was offered without naming one. Otherwise kind=none with rank=null, date=null, time=null.\nentities: exactly { doctor_name, service_name, date, time, visit_type, patient_name, patient_phone, patient_age, patient_address, appointment_id, booking_number }. Every absent value = null. Entities are NEW values stated in the current message only; null never deletes a known value.\n  date: ISO YYYY-MM-DD in the clinic's local calendar. Convert relative wording (today, tomorrow, weekday names, \"after tomorrow\") using context.local_time.date as today. Only a date you can resolve with certainty; never guess. Allowed window: today through today+60 days; outside that, set null.\n  time: 24h HH:MM only when stated clearly; convert morning/evening wording. null otherwise.\n  visit_type ∈ {NEW_VISIT, FOLLOW_UP, null}. NEW_VISIT = first/regular visit, FOLLOW_UP = review/follow-up. Never inferred from service_name.\n  patient_phone: copy exactly as the patient wrote it; a deterministic layer normalizes it.\n  patient_age: integer 0..130 or null.\n  appointment_id / booking_number: only when the patient explicitly provides one.\noperation_proposal: { type, requested }. type ∈ {create_appointment, cancel_appointment, reschedule_appointment, check_availability, \"\"}. requested=true only when this message asks for that operation; a proposal is never execution.\nreferences_prior_conversation: true only on a clear reference to an earlier conversation or appointment.\nescalate: true only when the request is unsafe, abusive, medical-emergency, or beyond K2 abilities; set handoff_reason (short) with it, else null.",
  'Patient message: ' + String(inbound.message_text || ''),
  'Context JSON: ' + JSON.stringify(compactContext)
].filter(Boolean).join('\n\n');
return { json: { repair_attempt: 1, errors, prompt } };