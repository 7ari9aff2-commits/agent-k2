={{ (() => {
  const c = $("Get Clinic Context").first().json || {};
  const t = $("Validate Patient Ownership").first().json?.canonical_time_context || {};
  const x = $("Normalize & Validate").first().json || {};
  const b = $("Build Clinic Persona Context (Deterministic)").first().json || {};
  const st = (() => { try { return $("Get Conversation State").first().json.state_data || {}; } catch (_) { return {}; } })();
  const persona = { clinic: c.clinic_name || "", assistant: (c.persona && c.persona.name) || "┘å┘ê╪▒", role: (c.persona && c.persona.role) || "┘à╪│╪º╪╣╪»╪⌐ ╪º╪│╪¬┘é╪¿╪º┘ä ┘ê╪¡╪¼┘ê╪▓╪º╪¬", tone: (c.persona && c.persona.tone) || "warm_professional", dialect: (c.persona && c.persona.dialect) || "saudi" };
  const faq = (() => { try { const f = $('Prefetch Clinic FAQ').first().json || {}; return Object.keys(f).length ? f : null; } catch (_) { return null; } })();
  const includeFaqFacts = b.agent_prompt_profile === 'clinic_query' && !!faq && Array.isArray(faq.results) && faq.results.length > 0;
  const service = b.service_facts || {};
  const includeService = service.is_service_fact_inquiry === true || service.is_price_inquiry === true || service.is_service_catalog_inquiry === true;
  const bc = st.booking_context || {};
  const conf = (st.confirmation_target && st.confirmation_state === "required") ? st.confirmation_target : null;
  const offeredRaw = (st.pending_offer && Array.isArray(st.pending_offer.alternatives)) ? st.pending_offer.alternatives : [];
  const review = st.patient_data_review || null;
  const collecting = !conf;
  const appt = bc.appointment_type || null;
  const mustAsk = (st.turn_directive && Array.isArray(st.turn_directive.must_ask)) ? st.turn_directive.must_ask : [];
  const missing = Array.isArray(st.missing_human_fields) ? st.missing_human_fields : [];
  const asked = (st.last_open_question && Array.isArray(st.last_open_question.requested_fields)) ? st.last_open_question.requested_fields : [];
  const wantRef = (Array.isArray(mustAsk) && mustAsk.includes('appointment_id')) || (Array.isArray(asked) && asked.includes('appointment_id')) || (Array.isArray(missing) && missing.includes('appointment_id'));
  let nextAsk = null;
  if (conf) {
    if (review && review.status === "pending") nextAsk = "patient_data_confirm";
  } else if (wantRef) {
    nextAsk = "appointment_reference";
  } else if (collecting) {
    if (!appt) nextAsk = "visit_type";
    else if (asked.length === 1) nextAsk = asked[0];
    else if (mustAsk.length === 1) nextAsk = mustAsk[0];
    else if (missing.length) {
      const order = ["date","time","reference","patient_name","patient_phone","patient_age","patient_address"];
      nextAsk = order.find(f => missing.includes(f)) || missing[0];
    }
  }
  const payload = {
    assistant_persona: persona,
    clinic_name: c.clinic_name || null,
    context: {
      clinic_name: c.clinic_name || null,
      local_time: { timezone: t.timezone || null, date: t.now_local_date || null, time: t.now_local_time || null, offset: t.utc_offset || null },
      doctors: { count: c.doctor_count || 0, directory: b.clinic_doctor_directory || [] }
    },
    situation: {
      today: t.now_local_date || null,
      current_booking: (bc.doctor_name || bc.doctor_id || bc.date) ? { doctor_name: bc.doctor_name || null, doctor_id: bc.doctor_id || null, date: bc.date || null, time: bc.time || null } : null,
      pending_confirmation: conf ? { action: conf.action || null, doctor_name: conf.doctor_name || null, date: conf.date || null, time: conf.time || null, expires_at: conf.expires_at || null } : null,
      offered: offeredRaw.map(s => ({ rank: s.rank || null, date: s.local_date || null, time: s.local_time || null })),
      patient_review: review && review.status === "pending" ? { status: "pending", fields: review.fields || null } : null,
      next_ask: nextAsk
    },
    faq_facts: includeFaqFacts ? faq : null,
    current_message: x.message_text || ""
  };
  return JSON.stringify(payload);
})() }}