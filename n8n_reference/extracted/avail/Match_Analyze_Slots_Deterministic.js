const rawItems = $input.all().map(i => i.json);
const prep = $('Prepare Search Window').item.json;
const errorItem = rawItems.find(it => it && it.error);
const common = {
  requested_date: prep.requested_date || null,
  requested_datetime: prep.requested_datetime || null,
  clinic_id: prep.clinic_id,
  doctor_id: prep.doctor_id,
  service_id: prep.service_id,
  search_mode: prep.search_mode || 'requested_window',
  nearby_search: prep.nearby_search === true,
  search_window_start: prep.start_date || null,
  search_window_end: prep.end_date || null,
  timezone: prep.timezone || null
};
if (prep.input_error) {
  return [{ json: { success: false, matched: null, exact_slot: null, nearest_slots: [], available_slots_today: [], all_slots_count: 0, needs_schedule_fallback: false, error_code: prep.input_error, message: 'تاريخ الحجز غير واضح، محتاجين توضيح من المريض', requested_datetime: null, ...common } }];
}
if (errorItem) {
  return [{ json: { success: false, matched: null, exact_slot: null, nearest_slots: [], available_slots_today: [], all_slots_count: 0, needs_schedule_fallback: false, error_code: 'RPC_ERROR', message: 'تعذر جلب الأوقات المتاحة حاليا', ...common } }];
}

const slots = rawItems.filter(s => s && s.slot_id);
const requestedDate = prep.requested_date;
const requestedDatetime = prep.requested_datetime;
const requestedTime = String(prep.requested_time || '').trim().slice(0, 5);
const displayTimezone = String(prep.timezone || 'UTC').trim() || 'UTC';
const localWallClock = (iso) => {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: displayTimezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
    const v = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
    return { date: `${v.year}-${v.month}-${v.day}`, time: `${v.hour}:${v.minute}` };
  } catch (_) { return { date: String(iso || '').slice(0, 10), time: String(iso || '').slice(11, 16) }; }
};
const slotLocal = (s) => localWallClock(s?.start_time);
const slotsForRequestedDay = slots.filter(s => slotLocal(s).date === requestedDate);
const slotDiffMinutes = (s, refMs) => Math.round(Math.abs(new Date(s.start_time).getTime() - refMs) / 60000);
const toPublicSlot = (s, refMs = null) => ({
  slot_id: s.slot_id,
  slot_status: 'available',
  clinic_id: s.clinic_id || prep.clinic_id,
  doctor_id: s.doctor_id || prep.doctor_id,
  service_id: s.service_id || prep.service_id,
  start_time: s.start_time,
  end_time: s.end_time,
  ...(refMs === null ? {} : { diff_minutes: slotDiffMinutes(s, refMs) })
});
const requestedWallClockMatches = (s) => {
  const local = slotLocal(s);
  return Boolean(requestedDate && requestedTime && local.date === requestedDate && local.time === requestedTime);
};

let matched = false;
let exactSlot = null;
let nearestSlots = [];
let errorCode = null;
let message = null;
if (requestedDatetime) {
  const reqMs = new Date(requestedDatetime).getTime();
  // Minute-granularity match first: the patient confirms HH:MM while slots may start
  // at HH:MM:SS — a sub-minute offset must not fail the exact match.
  const exact = slots.find(s => requestedWallClockMatches(s))
    || slots.find(s => {
      const startMs = new Date(s.start_time).getTime();
      const endMs = new Date(s.end_time).getTime();
      return reqMs >= startMs - 60000 && reqMs < endMs;
    });
  if (exact) {
    matched = true;
    exactSlot = toPublicSlot(exact);
    message = 'الوقت المطلوب متاح';
  } else {
    nearestSlots = slots.filter(s => !requestedWallClockMatches(s)).map(s => toPublicSlot(s, reqMs)).sort((a,b) => a.diff_minutes - b.diff_minutes).slice(0, 6);
    errorCode = 'REQUESTED_TIME_NOT_AVAILABLE';
    message = nearestSlots.length ? 'الوقت المطلوب غير متاح، وهذه أقرب المواعيد المتاحة' : 'الوقت المطلوب غير متاح حاليا';
  }
} else {
  matched = slotsForRequestedDay.length > 0;
  if (matched) {
    message = 'تم عرض الأوقات المتاحة لهذا اليوم';
  } else {
    const anchorMs = Date.parse(`${requestedDate}T12:00:00Z`);
    nearestSlots = slots.filter(s => slotLocal(s).date !== requestedDate).map(s => toPublicSlot(s, anchorMs)).sort((a,b) => a.diff_minutes - b.diff_minutes).slice(0, 6);
    errorCode = 'NO_AVAILABLE_SLOTS';
    message = nearestSlots.length ? 'لا توجد مواعيد في اليوم المطلوب، وهذه أقرب المواعيد المتاحة' : 'لا توجد مواعيد متاحة في نافذة البحث';
  }
}
const availableSlotsToday = slotsForRequestedDay
  .filter(s => !requestedDatetime || !requestedWallClockMatches(s))
  .map(s => toPublicSlot(s))
  .slice(0, 10);
const needsScheduleFallback = slots.length === 0;
return [{ json: {
  success: true,
  matched,
  exact_slot: exactSlot,
  nearest_slots: nearestSlots,
  available_slots_today: availableSlotsToday,
  all_slots_count: slots.length,
  needs_schedule_fallback: needsScheduleFallback,
  error_code: errorCode,
  message,
  ...common,
  authority: 'supabase.rpc_get_available_slots',
  verification_status: errorCode === 'RPC_ERROR' ? 'authority_error' : (matched === true || availableSlotsToday.length > 0 ? 'verified_available' : 'verified_unavailable')
} }];