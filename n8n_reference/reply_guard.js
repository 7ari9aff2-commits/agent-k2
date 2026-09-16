const item = $("Response Policy (Deterministic)").first().json || {};
const decision = (item.system_decision && typeof item.system_decision === "object") ? item.system_decision : {};
const rule = decision.decision_rule || null;
const code = decision.response_code || item.response_code || null;
const bc = decision.booking_context || {};
const ct = decision.confirmation_target || {};
const name = bc.patient_name || ct.patient_name || "المريض";
const phone = bc.patient_phone || ct.patient_phone || "";
const date = bc.date || ct.date || "";
const time = bc.time || ct.time || "";
const facts = item.facts || {};
const branchName = facts.branch_name || "الفرع الرئيسي";
const branchLoc = facts.branch_location || {};
const address = branchLoc.address || "";
const locCfg = branchLoc.location_config || {};
const queueBase = (facts.clinic_location && facts.clinic_location.queue_base_url) || "";
const pick = (...vals) => { for (const v of vals) { if (v !== undefined && v !== null && String(v).trim() !== "") return v; } return null; };
const mapsUrl = pick(locCfg.maps_url, branchLoc.maps_url, locCfg.latitude ? "https://www.google.com/maps/search/?api=1&query=" + locCfg.latitude + "," + locCfg.longitude : null);
const bookingNumber = pick(item.booking_number, decision.booking_number, bc.booking_number, ct.booking_number);
const appointmentId = pick(item.appointment_id, decision.appointment_id);
const queueNumber = pick(item.queue_number);
const queuePath = pick(item.queue_path);
const queueUrl = pick(item.queue_url, queueBase && queuePath ? queueBase.replace(/\/$/, "") + queuePath : null, queueBase && queueNumber ? queueBase.replace(/\/$/, "") + "/" + queueNumber : null);
const days = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
let dayName = "";
if (/^\d{4}-\d{2}-\d{2}$/.test(date)) { try { const d = new Date(date + "T12:00:00Z"); dayName = days[d.getUTCDay()]; } catch (_) {} }
const dateLabel = (dayName ? dayName + " " : "") + date;
let override = null;
if (code === "CONVERSATION_ONLY" && rule === "confirm_without_target") {
  override = "مفيش حجز معلق أأكده دلوقتي. تحب نبدأ حجز جديد؟";
} else if (code === "AVAILABILITY_SOURCE_ERROR") {
  override = "لحظة، مش قادرين نتأكد من المواعيد حاليًا. تحب نجرب يوم تاني؟";
} else if (code === "APPOINTMENT_CREATED" || (code === "IDEMPOTENT_REPLAY" && decision.action === "create_appointment")) {
  override = "تم الحجز بنجاح يا " + name + " ✅\nالموعد: " + dateLabel + (time ? " الساعة " + time : "") + "\nباسم: " + name + "\nتلفون: " + phone + "\nرقم الحجز: " + (bookingNumber || appointmentId || "-") + "\nالفرع: " + branchName + "\nالعنوان: " + address + (mapsUrl ? "\nلوكيشن العيادة: " + mapsUrl : "") + (queueUrl ? "\nلينك الكيو: " + queueUrl : "");
} else if (code === "CANCEL_COMPLETED") {
  override = "تم إلغاء حجزك بنجاح يا " + name + (bookingNumber ? "\nرقم الحجز: " + bookingNumber : "") + "\nنشوفك في زيجة قريبة";
} else if (code === "RESCHEDULE_COMPLETED") {
  override = "تم تعديل حجزك يا " + name + " ✅\nالموعد الجديد: " + dateLabel + (time ? " الساعة " + time : "") + (bookingNumber ? "\nرقم الحجز: " + bookingNumber : "");
} else if (code === "IDEMPOTENT_REPLAY") {
  override = "حجزك متسجل بالفعل ومتفعّل ✅" + (bookingNumber ? "\nرقم الحجز: " + bookingNumber : "");
}
if (!override) return [{ json: item }];
const rewrite = (s) => { try { const o = JSON.parse(s); if (o && typeof o.reply === "string") { o.reply = override; return JSON.stringify(o); } } catch (_) {} return s; };
const out = { ...item };
for (const k of ["output", "text", "agent_raw_output"]) { if (typeof out[k] === "string") out[k] = rewrite(out[k]); }
out.agent_reply = override;
out._reply_guard = { triggered: true, rule, code, override, read_from: "Response Policy (Deterministic)" };
return [{ json: out }];