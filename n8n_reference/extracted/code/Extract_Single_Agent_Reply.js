const input = $json || {};
let source = input;
// Extract is a single explicit final-reply selector. It must use only the
// item delivered by the gate; cross-branch .first() lookups can resurrect an
// older Agent item after Composer has already produced the result reply.
const normalized = input;
const composed = input;
function parseReplyCandidate(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return '';
  if (typeof value === 'object') {
    return String(value.reply || value.final_reply || value.result_reply_text || value.output || '').trim()
      || parseReplyCandidate(value.message, depth + 1)
      || parseReplyCandidate(value.content, depth + 1);
  }
  const text = String(value).trim();
  if (!text) return '';
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(unfenced);
    return parseReplyCandidate(parsed, depth + 1);
  } catch (_) {
    // Some n8n/LangChain outputs contain two adjacent JSON objects. Extract
    // balanced objects one by one instead of taking first-to-last braces.
    for (let start = 0; start < unfenced.length; start += 1) {
      if (unfenced[start] !== '{' && unfenced[start] !== '[') continue;
      const open = unfenced[start];
      const close = open === '{' ? '}' : ']';
      let depthCount = 0;
      let quoted = false;
      let escaped = false;
      for (let end = start; end < unfenced.length; end += 1) {
        const ch = unfenced[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (ch === '\\\\') escaped = true;
          else if (ch === '"') quoted = false;
          continue;
        }
        if (ch === '"') { quoted = true; continue; }
        if (ch === open) depthCount += 1;
        else if (ch === close) depthCount -= 1;
        if (depthCount === 0) {
          try {
            const parsed = JSON.parse(unfenced.slice(start, end + 1));
            const found = parseReplyCandidate(parsed, depth + 1);
            if (found) return found;
          } catch (_) {}
          break;
        }
      }
    }
  }
  return '';
}
function plainReplyCandidate(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.startsWith('{') || text.startsWith('[')) return '';
  return text;
}
function extractCompletedJsonStringField(value, fieldName) {
  const text = String(value || '');
  const fieldPattern = new RegExp('"' + String(fieldName).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '"\\s*:\\s*"', 'i');
  const match = fieldPattern.exec(text);
  if (!match) return '';
  const openingQuote = match.index + match[0].lastIndexOf('"');
  for (let end = openingQuote + 1; end < text.length; end += 1) {
    if (text[end] !== '"') continue;
    let slashCount = 0;
    for (let i = end - 1; i > openingQuote && text[i] === '\\\\'; i -= 1) slashCount += 1;
    if (slashCount % 2 === 1) continue;
    try {
      const parsed = JSON.parse(text.slice(openingQuote, end + 1));
      return typeof parsed === 'string' ? parsed.trim() : '';
    } catch (_) { return ''; }
  }
  return '';
}
// Result Reply Composer is authoritative after a deterministic result has been
// prepared. Resolve the policy snapshot before selecting the reply so a fan-in
// race cannot make the first Agent item win over the Composer item.
let policySnapshot = {};
try { policySnapshot = $('Response Policy (Deterministic)').first().json || {}; } catch (_) {}
const replySource = { ...policySnapshot, ...input };
const composerPhase = input.single_agent_phase === 'result'
  || input.agent_phase === 'result'
  || composed.single_agent_phase === 'result'
  || replySource.single_agent_phase === 'result';
const composerRaw = input.result_reply_text
  || input.composer_reply
  || replySource.result_reply_text
  || composed.result_reply_text
  || composed.output
  || input.output
  || '';
const composedReplyCandidate = composerPhase
  ? (parseReplyCandidate(composerRaw) || (typeof composerRaw === 'string' && !composerRaw.trim().startsWith('{') ? composerRaw.trim() : ''))
  : '';
const firstAgentReplyCandidate = plainReplyCandidate(replySource.agent_reply)
  || parseReplyCandidate(replySource.agent_reply)
  || plainReplyCandidate(replySource.contract?.reply)
  || parseReplyCandidate(replySource.contract?.reply)
  || plainReplyCandidate(replySource.final_reply)
  || parseReplyCandidate(replySource.final_reply)
  || plainReplyCandidate(replySource.canonical_reply)
  || parseReplyCandidate(replySource.canonical_reply)
  || parseReplyCandidate(replySource.output)
  || extractCompletedJsonStringField(replySource.agent_raw_output, 'reply')
  || extractCompletedJsonStringField(replySource.output, 'reply');
const firstAgentReply = firstAgentReplyCandidate;
const terminalSuccessCode = new Set(['APPOINTMENT_CREATED','CREATE_COMPLETED','IDEMPOTENT_REPLAY']);
const policyCode = String(replySource.response_code || replySource.facts?.response_code || replySource.system_decision?.response_code || '').trim().toUpperCase();
const verifiedSuccess = terminalSuccessCode.has(policyCode)
  && (replySource.success === true || replySource.facts?.success === true || replySource.execution_result?.success === true)
  && (replySource.child_contract_valid === true || replySource.facts?.child_contract_valid === true || replySource.execution_result?.child_contract_valid === true || policyCode === 'IDEMPOTENT_REPLAY');
const unverifiedSuccessClaim = /(?:حجزك\s+تم|تم\s+(?:تأكيد|تأكيده|تأكيد الحجز|حجز|تثبيت)|سيصلك\s+تأكيد|أكدنا\s+لك|تم اعتماد الحجز|أصبح\s+حجزك|ثبتنا\s+الحجز|ثبتنا\s+موعدك|(?:حجز|تأكيد)[^\n]{0,24}مؤكد|مؤكد[^\n]{0,24}(?:حجز|تأكيد))/iu;
const safeReplyCandidate = (candidate) => {
  const text = String(candidate || '').trim();
  if (!text) return '';
  if (!verifiedSuccess && unverifiedSuccessClaim.test(text)) return '';
  return text;
};
const composedReply = safeReplyCandidate(composedReplyCandidate);
const safeFirstAgentReply = safeReplyCandidate(firstAgentReply);
let reply = composedReply || safeFirstAgentReply;
// A trusted agent_reply may already be plain patient-facing text. Preserve it
// explicitly even if an upstream parser classified the same value as non-JSON.
if (!reply && typeof replySource.agent_reply === 'string' && replySource.agent_reply.trim()) reply = safeReplyCandidate(replySource.agent_reply);
if (!reply && typeof input.output === 'string' && !input.output.trim().startsWith('{')) reply = input.output.trim();
const layoutCode = String(replySource.response_code || source.response_code || '').toUpperCase();
const preserveConfirmationLayout = ['APPOINTMENT_CREATED','IDEMPOTENT_REPLAY'].includes(layoutCode);
reply = preserveConfirmationLayout
  ? String(reply || '').split(/\r?\n/).map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n')
  : String(reply || '').replace(/\s+/g, ' ').trim();
// Response Policy is authoritative for the current deterministic envelope.
source = replySource;
let isConversationStart = false;
try {
  isConversationStart = $('Build Clinic Persona Context (Deterministic)').first().json.is_conversation_start === true;
} catch (_) {}

// Identity wording remains model-authored. No deterministic deletion or rewriting is applied.
// A specialization is not a requested/booked service. Remove it from a
// booking reply unless current-turn or deterministic service evidence exists.
function stripUnsupportedDoctorSpecializations(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  let bookingTurn = false;
  let serviceEvidence = false;
  let specialties = [];
  try {
    const contract = replySource.contract || {};
    const intent = String(contract.turn?.intent || replySource.turn?.intent || '').toLowerCase();
    bookingTurn = ['booking_request','booking_continuation'].includes(intent) || String(replySource.routing?.target || '').toLowerCase() === 'booking';
    serviceEvidence = Boolean(contract.entities?.service_name || replySource.service_name);
  } catch (_) {}
  try {
    const ctx = $('Normalize & Validate').first().json || {};
    const currentText = String(ctx.message_text || '').normalize('NFKC').toLowerCase();
    const resolver = $('Resolve Service Fact (Deterministic)').first().json || {};
    serviceEvidence = serviceEvidence || Boolean(resolver.service_name || resolver.is_service_fact_inquiry || resolver.is_price_inquiry || resolver.is_service_catalog_inquiry);
    const catalog = Array.isArray(resolver.catalog) ? resolver.catalog : [];
    serviceEvidence = serviceEvidence || catalog.some(item => item?.service_name && currentText.includes(String(item.service_name).toLowerCase()));
    const clinic = $('Get Clinic Context').first().json || {};
    specialties = (Array.isArray(clinic.doctor_directory) ? clinic.doctor_directory : [])
      .map(item => String(item?.specialization || '').trim()).filter(Boolean)
      .sort((a,b) => b.length - a.length);
    serviceEvidence = serviceEvidence || specialties.some(term => currentText.includes(term.toLowerCase()));
  } catch (_) {}
  if (!bookingTurn || serviceEvidence || !specialties.length) return text;
  for (const term of specialties) text = text.split(term).join('');
  return text.replace(/\s{2,}/g, ' ').trim();
}
// Final deterministic formatting guard for the patient-facing reply only.
// JSON syntax remains untouched because this is applied after reply extraction.
function stripReplyPunctuation(value) {
  const protectedTokens = [];
  const source = String(value || '');
  // Keep separators that carry meaning in patient-facing data while still removing ordinary punctuation.
  const semanticToken = /(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https?:\/\/[^\s]+|[0-9٠-٩]{1,2}:[0-9٠-٩]{2}(?:\s*(?:صباح(?:ا|ًا)?|مساء(?:ا|ًا)?|صباحًا|مساءً))?|[0-9٠-٩]{1,4}[\/-][0-9٠-٩]{1,2}(?:[\/-][0-9٠-٩]{1,4})?|[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}|[A-Za-z0-9_]{2,}-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{2,})/gu;
  const protectedText = source.replace(semanticToken, (token) => {
    const marker = `K2SEMANTICTOKEN${protectedTokens.length}K`;
    protectedTokens.push(token);
    return marker;
  });
  const cleaned = preserveConfirmationLayout
    ? protectedText.split(/\r?\n/).map(line => line
        .replace(/[،,؛;:.!?؟!؟\"“”'‘’()\[\]{}<>…ـ\-_/\\|@#$%^&*+=~`]/g, '')
        .replace(/[ \t]+/g, ' ')
        .trim()).filter(Boolean).join('\n')
    : protectedText
        .replace(/[،,؛;:.!?؟!؟\"“”'‘’()\[\]{}<>…ـ\-_/\\|@#$%^&*+=~`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
  return protectedTokens.reduce((text, token, index) => text.replace(`K2SEMANTICTOKEN${index}K`, token), cleaned);
}
// Never expose a success claim before a deterministic terminal result exists.
let currentResponseCode = '';
try { currentResponseCode = String($('Response Policy (Deterministic)').first().json.response_code || '').toUpperCase(); } catch (_) {}
const terminalSuccess = ['APPOINTMENT_CREATED','CANCEL_COMPLETED','RESCHEDULE_COMPLETED','IDEMPOTENT_REPLAY'].includes(currentResponseCode);
// ORCH-NATURAL: stage asks are a SAFETY NET, never a replacement. The model
// reply is preferred verbatim; the deterministic stage text is appended only
// when the model reply does not already cover the stage ask.
const stagePlan = (() => {
  const code = String(currentResponseCode || '').toUpperCase();
  const sd = replySource.system_decision || {};
  const bc = replySource.booking_context || sd.booking_context || {};
  const fmtTime = (t) => {
    const s = String(t || '');
    const i = s.indexOf(':');
    if (i < 1) return s;
    const h = parseInt(s.slice(0, i), 10);
    const mi = s.slice(i + 1, i + 3);
    if (!Number.isFinite(h) || mi.length !== 2 || Number.isNaN(Number(mi))) return s;
    let hh = h % 12; if (hh === 0) hh = 12;
    return hh + ':' + mi + (h >= 12 ? ' مساءً' : ' صباحًا');
  };
  const fmtDate = (d) => {
    const p = String(d || '').split('-');
    if (p.length !== 3 || p[0].length !== 4) return String(d || '');
    const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    return parseInt(p[2], 10) + ' ' + months[parseInt(p[1], 10) - 1];
  };
  // BOOKING CARD: terminal success renders a deterministic formatted card.
  if (code === 'APPOINTMENT_CREATED' || code === 'IDEMPOTENT_REPLAY') {
    const er = input.execution_result || replySource.execution_result || {};
    const t2 = replySource.confirmation_target || sd.confirmation_target || {};
    const bc2 = replySource.booking_context || sd.booking_context || {};
    const cardName = er.patient_name || t2.patient_name || bc2.patient_name || null;
    const cardPhone = er.patient_phone || t2.patient_phone || bc2.patient_phone || null;
    const cardDoctor = er.doctor_name || t2.doctor_name || bc2.doctor_name || null;
    const cardDate = er.date || t2.date || bc2.date || null;
    const cardTime = er.time || t2.time || bc2.time || null;
    const cardBn = er.booking_number || replySource.booking_number || null;
    const cardQueue = er.queue_url || er.queue_path || null;
    let cardAddr = null;
    try {
      const cc = $('Get Clinic Context').first().json || {};
      const dir = Array.isArray(cc.branch_directory) ? cc.branch_directory : [];
      const wantBranch = er.branch_id || t2.branch_id || bc2.branch_id || null;
      const bb = (wantBranch && dir.find((b) => String(b && b.branch_id || '') === String(wantBranch))) || (dir.length === 1 ? dir[0] : null);
      const lc = (bb && bb.location_config) || {};
      cardAddr = lc.address || lc.label || (bb && bb.address) || null;
    } catch (_) {}
    const cardLines = ['تم تأكيد الحجز بنجاح'];
    if (cardName) cardLines.push('الاسم ' + cardName);
    if (cardPhone) cardLines.push('رقم الجوال ' + cardPhone);
    if (cardDoctor) cardLines.push('الطبيب ' + cardDoctor);
    if (cardDate && cardTime) cardLines.push('الموعد يوم ' + fmtDate(cardDate) + ' الساعة ' + fmtTime(cardTime));
    else if (cardDate) cardLines.push('الموعد يوم ' + fmtDate(cardDate));
    if (cardBn) cardLines.push('رقم الحجز ' + cardBn);
    if (cardAddr) cardLines.push('العنوان ' + cardAddr);
    if (cardQueue && /^https?:\/\//.test(String(cardQueue))) cardLines.push('رابط الدور ' + cardQueue);
    if (cardLines.length >= 4) return { kind: 'card', keywords: ['تم'], text: cardLines.join(String.fromCharCode(10)) };
    return null;
  }
  if (code === 'MISSING_REQUIRED_FIELDS') {
    const list = Array.isArray(replySource.missing_human_fields) && replySource.missing_human_fields.length ? replySource.missing_human_fields : (Array.isArray(sd.missing_human_fields) ? sd.missing_human_fields : []);
    const labels = { patient_name: 'الاسم', patient_age: 'العمر', patient_phone: 'رقم الجوال', patient_address: 'العنوان', doctor_or_service: 'الدكتور أو الخدمة', doctor: 'الدكتور', service: 'الخدمة', date: 'اليوم', time: 'الوقت' };
    const parts = [];
    for (const f of list) { const l = labels[String(f).trim().toLowerCase()]; if (l && !parts.includes(l)) parts.push(l); }
    if (!parts.length) return null;
    return { kind: 'collect', keywords: parts, text: (parts.length >= 3 ? 'محتاج منك بياناتك كاملة عشان نكمل الحجز: ' : 'محتاج منك: ') + parts.join(' و') };
  }
  if (code === 'PATIENT_DATA_CONFIRMATION_REQUIRED') {
    const fields = (replySource.patient_data_review && replySource.patient_data_review.fields) || {};
    const bits = [];
    if (fields.name) bits.push('الاسم ' + fields.name);
    if (fields.age) bits.push('العمر ' + fields.age);
    if (fields.phone) bits.push('الجوال ' + fields.phone);
    if (fields.address) bits.push('العنوان ' + fields.address);
    if (!bits.length) return null;
    return { kind: 'review', keywords: ['بياناتك', 'صح', bits[0].split(' ')[1] || ''], text: 'بياناتك: ' + bits.join(' ') + ' لو كل حاجة صح قول نعم ولو في تعديل قوله' };
  }
  if (code === 'SLOT_LOOKUP_REQUIRED') {
    return { kind: 'collect', keywords: ['اليوم', 'موعد', 'متاح', 'تاريخ'], text: 'تحب الموعد يكون أي يوم' };
  }
  if (code === 'CONFIRMATION_REQUIRED' || code === 'CONFIDENCE_REVIEW_REQUIRED') {
    const t = replySource.confirmation_target || sd.confirmation_target || null;
    if (!t) return null;
    const typeWord = bc.appointment_type === 'FOLLOW_UP' ? 'متابعة' : (bc.appointment_type === 'NEW_VISIT' ? 'كشف جديد' : '');
    if (t.action === 'create_appointment') {
      const bits = [];
      if (typeWord) bits.push(typeWord);
      if (t.doctor_name) bits.push('مع ' + t.doctor_name);
      if (t.date) bits.push('يوم ' + fmtDate(t.date));
      if (t.time) bits.push('الساعة ' + fmtTime(t.time));
      if (!bits.length) return null;
      return { kind: 'confirm', keywords: ['أأكد', 'تأكيد', 'الموعد', 'أحجز'], text: 'الموعد المقترح ' + bits.join(' ') + ' أأكد الحجز' };
    }
    if (t.action === 'cancel_appointment') return { kind: 'confirm', keywords: ['أأكد', 'تأكيد', 'إلغاء'], text: 'تأكيد إلغاء الموعد أأكد' };
    if (t.action === 'reschedule_appointment') return { kind: 'confirm', keywords: ['أأكد', 'تأكيد', 'تعديل'], text: 'تأكيد تعديل الموعد أأكد' };
    return null;
  }
  return null;
})();
// The model-authored reply is preserved. No response-code template may replace it.
const preservedAgentReply = safeReplyCandidate(replySource.agent_reply ? String(replySource.agent_reply).trim() : '');
const fallbackResponseCode = String(replySource.response_code || source.response_code || '').toUpperCase();
const fallbackMissingField = String(replySource.next_best_missing_human_field || source.next_best_missing_human_field || '').trim().toLowerCase();
const fallbackReviewNameMissing = Boolean(
  fallbackResponseCode === 'PATIENT_DATA_CONFIRMATION_REQUIRED'
  && !(replySource.patient_data_review?.fields?.name || replySource.booking_context?.patient_name)
);
const deterministicEmptyReply = String(source.deterministic_fallback_reply || '').trim()
  || (fallbackMissingField === 'patient_name' || fallbackReviewNameMissing ? 'ممكن اسمك الكامل لو تكرمت' : 'تعذر صياغة الرد من نتيجة العملية الحالية');
// MODEL-FIRST 2026-09-03: the model reply IS the reply. Deterministic stage
// text is an empty-reply safety net only — it never replaces or appends.
let finalReply = String(reply || preservedAgentReply || '').trim()
  || (stagePlan ? stagePlan.text : '')
  || deterministicEmptyReply;
if (preserveConfirmationLayout) finalReply = String(finalReply || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n');
// Defense in depth: never expose provider markers, internal booking enums, or
// first-visit wording even if a raw reply bypasses the upstream sanitizer.
finalReply = String(finalReply || '')
  .replace(/<\|end_of_thinking\|>/giu, '')
  .replace(/\bNEW(?:[_ -]?VISIT)\b/giu, 'كشف جديد')
  .replace(/\bFOLLOW(?:[_ -]?UP)\b/giu, 'متابعة')
  .replace(/(?:زيارتك|الزيارة|الزياره|زيارة|زياره)\s+(?:الأولى|الاولي|أولى|اولى)/giu, 'كشف جديد')
  .replace(/\s+/g, ' ').trim();
// P42b CLAIM-GUARD + CONTRACT-DISTRUST (final line of defense at render time),
// hotfixed per regression team: negation/question aware (RG-6). The composer's
// deterministic mutation replies legitimately say 'تم تأكيد الحجز' on the result
// phase, so the guard applies to understand-phase replies only. When the contract
// itself could not be trusted, raw model text is never rendered (the exact 27895
// failure: 'نثبت لك الموعد' rendered from raw output while the contract said unclear).
const effPhase = String(input.agent_phase || input.single_agent_phase || 'understand');
const CLAIM_RE = /(نثبت|ثبت)\s*(?:لك)?\s*(?:الموعد|الحجز)|تم\s+(?:الحجز|التثبيت|تأكيد\s*الحجز)|اتأكد\s*(?:الحجز)?|اتسجل\s*(?:الحجز|لك)/;
const claimSafe = (text) => String(text || '').replace(CLAIM_RE, (m, ...rest) => {
  const str = rest[rest.length - 1];
  const off = rest[rest.length - 2];
  const before = str.slice(Math.max(0, off - 10), off);
  return /(?:مش|ما\s|مفيش|لن|لما|غير)(?:[\sه]{1,2})?$/.test(before) ? m : 'تمام';
}).replace(/\s{2,}/g, ' ').trim();
const contractInvalidUnderstand = effPhase !== 'result'
  && source._contract_status
  && ['REPAIR_NEEDED', 'INVALID_AFTER_REPAIR', 'MODEL_CALL_FAILED'].includes(String(source._contract_status));
if (contractInvalidUnderstand) {
  finalReply = 'معلش، مفهمتش رسالتك كويس. ممكن توضحها تاني؟';
} else if (effPhase !== 'result' && typeof finalReply === 'string' && !/^\s*هل/.test(finalReply) && CLAIM_RE.test(finalReply)) {
  finalReply = claimSafe(finalReply);
}
return [{ json: {
  ...source,
  rendered_reply: finalReply,
  final_reply: finalReply,
  canonical_reply: finalReply,
  render_error: reply ? null : 'EMPTY_SINGLE_AGENT_REPLY',
  render_used: Boolean(reply),
  single_model: true,
  single_agent_phase: input.agent_phase || input.single_agent_phase || 'understand'
} }]
