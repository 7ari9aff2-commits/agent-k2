const trig = $json || {};
const requestedDate = String(trig.requested_date || '').trim();
const requestedTimeRaw = String(trig.requested_time || '').trim();
const searchMode = String(trig.search_mode || '').trim().toLowerCase();
const nearbySearch = ['nearby_alternatives', 'nearby', 'date_alternative'].includes(searchMode);
const rangeDaysRaw = parseInt(trig.search_range_days, 10);
const requestedRangeDays = Number.isFinite(rangeDaysRaw) && rangeDaysRaw > 0 ? rangeDaysRaw : 3;
// Keep the window bounded. Nearby searches may look farther than a normal exact-day lookup,
// but never beyond 14 local calendar days in one RPC call.
const rangeDays = Math.min(14, nearbySearch ? Math.max(7, requestedRangeDays) : requestedRangeDays);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!uuidPattern.test(String(trig.clinic_id || '')) || !uuidPattern.test(String(trig.doctor_id || ''))) {
  return [{ json: { ...trig, input_error: 'INVALID_OR_MISSING_IDENTIFIER', start_date: null, end_date: null, requested_datetime: null } }];
}
const clinicTimezone = String(trig.clinic_timezone || '').trim();
const requestedTimezone = clinicTimezone || String(trig.timezone || '').trim();
let timezone = requestedTimezone;
let timezoneValid = false;
try {
  if (requestedTimezone) {
    new Intl.DateTimeFormat('en-US', { timeZone: requestedTimezone }).format(new Date());
    timezoneValid = true;
  }
} catch (_) {
  timezoneValid = false;
}
if (!timezoneValid) {
  return [{ json: {
    ...trig,
    timezone: null,
    timezone_source: 'clinic_timezone_invalid_or_missing',
    input_error: 'CLINIC_TIMEZONE_NOT_CONFIGURED',
    start_date: null,
    end_date: null,
    requested_datetime: null
  } }];
}

const pad = n => String(n).padStart(2, '0');
const addDaysToDateString = (dateString, days) => {
  const [year, month, day] = dateString.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const offsetForLocalWallClock = (tz, dateString, timeString) => {
  const [year, month, day] = dateString.split('-').map(Number);
  const [hour, minute, second] = timeString.split(':').map(Number);
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guessUtcMs));
  const value = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const localAsUtcMs = Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day), Number(value.hour), Number(value.minute), Number(value.second));
  const offsetMinutes = Math.round((localAsUtcMs - guessUtcMs) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
};

if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
  return [{ json: { ...trig, timezone, timezone_source: 'clinic_configuration', input_error: 'INVALID_OR_MISSING_DATE', start_date: null, end_date: null, requested_datetime: null } }];
}

const startDate = requestedDate;
const endDate = addDaysToDateString(requestedDate, rangeDays);
let requestedDatetime = null;
if (requestedTimeRaw) {
  let t = requestedTimeRaw;
  if (/^\d{2}:\d{2}$/.test(t)) t += ':00';
  if (/^\d{2}:\d{2}:\d{2}$/.test(t)) {
    let offset = '+00:00';
    try { offset = offsetForLocalWallClock(timezone, requestedDate, t); } catch (_) {}
    requestedDatetime = `${requestedDate}T${t}${offset}`;
  }
}

return [{ json: { ...trig, search_mode: searchMode || 'requested_window', nearby_search: nearbySearch, timezone, timezone_source: 'clinic_configuration', input_error: null, start_date: startDate, end_date: endDate, requested_datetime: requestedDatetime } }];