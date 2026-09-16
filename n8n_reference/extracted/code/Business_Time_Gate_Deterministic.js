const guard = $('Execution Transition Guard (Deterministic)').first().json || {};
const decision = guard.system_decision && typeof guard.system_decision === 'object' ? guard.system_decision : {};
const row = $json && typeof $json === 'object' ? $json : {};
const action = String(decision.action || decision.confirmation_target?.action || '').toLowerCase();
const shouldCheck = decision.allowed === true && ['create_appointment', 'reschedule_appointment'].includes(action);
const validTimezone = (value) => {
  const timezone = String(value ?? '').trim();
  if (!timezone) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(new Date()); return true; } catch { return false; }
};
const rawTimezone = String(row.timezone ?? '').trim();
const timezoneConfigured = row.timezone_configured === true && validTimezone(rawTimezone);
const timezone = timezoneConfigured ? rawTimezone : null;
const timezoneErrorCode = timezoneConfigured ? null : (String(row.timezone_error_code || '').trim() || (rawTimezone ? 'CLINIC_TIMEZONE_INVALID' : 'CLINIC_TIMEZONE_NOT_CONFIGURED'));
const parseJson = (value, fallback) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  try { const parsed = JSON.parse(String(value || '')); return parsed; } catch { return fallback; }
};
const hours = parseJson(row.business_hours, []);
const localParts = (iso) => {
  if (!timezoneConfigured) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(date).reduce((out, part) => { if (part.type !== 'literal') out[part.type] = part.value; return out; }, {});
    const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { dayOfWeek: weekdays[parts.weekday], minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60 };
  } catch { return null; }
};
const parseTime = (value) => {
  const m = String(value ?? '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const hour = Number(m[1]); const minute = Number(m[2]); const second = Number(m[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return hour * 60 + minute + second / 60;
};
let status = 'NOT_CHECKED';
let code = null;
let allowed = true;
let checked = false;
if (shouldCheck) {
  checked = true;
  if (!timezoneConfigured) {
    status = 'TIMEZONE_NOT_CONFIGURED';
    code = timezoneErrorCode;
    allowed = false;
  } else {
    const start = localParts(row.start_time);
    const end = localParts(row.end_time);
    if (!row.slot_found || !start || !end || !Array.isArray(hours) || hours.length === 0) {
      if (row.slot_found !== true) { status = 'NOT_APPLICABLE'; code = null; allowed = true; } else { status = 'UNAVAILABLE'; code = 'BUSINESS_HOURS_UNAVAILABLE'; allowed = false; }
    } else {
      const candidates = hours.filter((hour) => Number(hour.day_of_week) === start.dayOfWeek && hour.is_off_day !== true);
      const inside = candidates.some((hour) => {
        const open = parseTime(hour.open_time); const close = parseTime(hour.close_time);
        if (open === null || close === null || open === close) return false;
        if (close > open) return start.minuteOfDay >= open && start.minuteOfDay < close && end.dayOfWeek === start.dayOfWeek && end.minuteOfDay <= close;
        const nextDay = (start.dayOfWeek + 1) % 7;
        return start.minuteOfDay >= open && end.dayOfWeek === nextDay && end.minuteOfDay <= close;
      });
      status = inside ? 'VALID' : 'VIOLATION';
      code = inside ? 'BUSINESS_TIME_VALID' : 'BUSINESS_HOURS_VIOLATION';
      allowed = inside;
    }
  }
}
const finalDecision = shouldCheck && !allowed
  ? { ...decision, allowed: false, response_code: code, business_time_status: status, business_time_checked: checked, business_time_timezone: timezone, business_time_source: timezoneConfigured ? 'clinic_business_hours' : 'clinic_configuration_error', business_time_error_code: code, final_reply: status === 'TIMEZONE_NOT_CONFIGURED' ? 'تعذر تنفيذ العملية لأن المنطقة الزمنية للعيادة غير مهيأة أو غير صالحة.' : status === 'UNAVAILABLE' ? 'تعذر التحقق من ساعات عمل العيادة لذلك لن أنفذ الحجز قبل اكتمال التحقق.' : 'الموعد المطلوب خارج ساعات عمل العيادة اختر وقتاً داخل ساعات الدوام.' }
  : { ...decision, business_time_status: status, business_time_checked: checked, business_time_timezone: timezone, business_time_source: timezoneConfigured ? 'clinic_business_hours' : 'clinic_configuration_error', business_time_error_code: code };
return [{ json: { ...guard, ...row, timezone_configured: timezoneConfigured, timezone_error_code: timezoneErrorCode, business_time_allowed: allowed, business_time_checked: checked, business_time_status: status, business_time_code: code, business_time_timezone: timezone, business_time_source: timezoneConfigured ? 'clinic_business_hours' : 'clinic_configuration_error', business_time_error_code: code, business_time_slot_start: row.start_time || null, business_time_slot_end: row.end_time || null, system_decision: finalDecision } }];
