const ctx = $('Normalize & Validate').item.json;
const row = $input.first()?.json || {};
const clinicFound = row.clinic_found !== false && !!row.clinic_id;
const ownershipValid = clinicFound && row.ownership_valid === true && String(row.conversation_patient_id || '') === String(ctx.patient_id) && String(row.clinic_id || '') === String(ctx.clinic_id);
const isValidTimezone = (value) => {
  const timezone = String(value ?? '').trim();
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
};
const rawTimezone = String(row.clinic_timezone ?? '').trim();
const timezoneConfigured = isValidTimezone(rawTimezone);
const timezone = timezoneConfigured ? rawTimezone : null;
const timezoneErrorCode = rawTimezone ? (timezoneConfigured ? null : 'CLINIC_TIMEZONE_INVALID') : 'CLINIC_TIMEZONE_NOT_CONFIGURED';
const referenceNowIso = ctx.time_context?.now_iso || new Date().toISOString();
const referenceMs = Date.parse(referenceNowIso);
const parts = timezoneConfigured && Number.isFinite(referenceMs) ? new Intl.DateTimeFormat('en-GB', {
  timeZone: timezone,
  year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).formatToParts(new Date(referenceMs)).reduce((out, part) => {
  if (part.type !== 'literal') out[part.type] = part.value;
  return out;
}, {}) : {};
const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const localAsUtc = timezoneConfigured && parts.year && parts.month && parts.day && parts.hour && parts.minute && parts.second
  ? Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  : null;
const offsetMs = timezoneConfigured && Number.isFinite(referenceMs) && Number.isFinite(localAsUtc)
  ? localAsUtc - Math.floor(referenceMs / 1000) * 1000
  : null;
const sign = offsetMs !== null && offsetMs >= 0 ? '+' : '-';
const absMinutes = offsetMs === null ? null : Math.round(Math.abs(offsetMs) / 60000);
const utcOffset = absMinutes === null ? null : `${sign}${String(Math.floor(absMinutes / 60)).padStart(2, '0')}:${String(absMinutes % 60).padStart(2, '0')}`;
const canonicalTimeContext = {
  schema_version: 4,
  timezone,
  timezone_configured: timezoneConfigured,
  timezone_source: timezoneConfigured ? 'clinic_configuration' : 'invalid_or_missing_clinic_configuration',
  timezone_error_code: timezoneErrorCode,
  utc_offset: utcOffset,
  now_iso: referenceNowIso,
  now_local_date: timezoneConfigured && parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : null,
  now_local_time: timezoneConfigured && parts.hour && parts.minute && parts.second ? `${parts.hour}:${parts.minute}:${parts.second}` : null,
  now_local_weekday: timezoneConfigured && Number.isInteger(weekdayMap[parts.weekday]) ? weekdayMap[parts.weekday] : null,
};
return [{ json: {
  ...row,
  ownership_valid: ownershipValid,
  security_checked: true,
  security_error: !clinicFound ? 'CLINIC_NOT_FOUND' : (ownershipValid ? null : 'PATIENT_CONVERSATION_OWNERSHIP_MISMATCH'),
  clinic_found: clinicFound,
  clinic_timezone: timezone,
  clinic_timezone_raw: rawTimezone || null,
  clinic_timezone_configured: timezoneConfigured,
  clinic_timezone_error_code: timezoneErrorCode,
  canonical_time_context: canonicalTimeContext,
} }];
