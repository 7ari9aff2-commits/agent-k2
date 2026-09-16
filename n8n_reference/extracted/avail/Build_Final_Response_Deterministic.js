const match = $('Match & Analyze Slots (Deterministic)').item.json;
let scheduleRows = null;
const fallbackExpected = match.needs_schedule_fallback === true;
try {
  scheduleRows = $('Check Doctor Weekly Schedule (Fallback)').all().map(i => i.json || {}).filter(row => row && row.day_of_week !== undefined && row.start_time !== undefined && row.end_time !== undefined);
} catch (e) { scheduleRows = null; }
const nearbySearch = match.nearby_search === true || String(match.search_mode || '').toLowerCase() === 'nearby_alternatives';
let doctorWorksThatDay = null;
let workingHours = null;
let errorCode = match.error_code ?? null;
let message = match.message ?? null;
let verificationStatus = match.verification_status || (match.success === true ? 'verified_unavailable' : 'authority_error');
const authority = match.authority || 'supabase.rpc_get_available_slots';
if (fallbackExpected && scheduleRows !== null) {
  if (nearbySearch) {
    // An empty RPC result over a nearby window does not prove that the doctor is off
    // on the anchor day and must not collapse the entire search into that wording.
    doctorWorksThatDay = scheduleRows.length > 0;
    workingHours = scheduleRows.map(r => ({ start_time: r.start_time, end_time: r.end_time }));
    errorCode = 'NO_AVAILABLE_SLOTS_IN_WINDOW';
    message = 'لا توجد مواعيد متاحة مؤكدة في الأيام القريبة التي تم البحث فيها';
  } else if (scheduleRows.length === 0) {
    doctorWorksThatDay = false;
    workingHours = [];
    errorCode = 'DOCTOR_NOT_WORKING_THAT_DAY';
    message = 'الدكتور ما يشتغلش في اليوم ده جرب يوم تاني';
  } else {
    doctorWorksThatDay = true;
    workingHours = scheduleRows.map(r => ({ start_time: r.start_time, end_time: r.end_time }));
    errorCode = 'NO_AVAILABLE_SLOTS';
    message = 'الدكتور يعمل في هذا اليوم، لكن لا توجد مواعيد متاحة مؤكدة حاليًا';
  }
}
return [{ json: {
  success: match.success,
  matched: match.matched,
  exact_slot: match.exact_slot,
  nearest_slots: match.nearest_slots,
  available_slots_today: match.available_slots_today,
  doctor_works_that_day: doctorWorksThatDay,
  working_hours: workingHours,
  error_code: errorCode,
  message,
  requested_date: match.requested_date,
  requested_datetime: match.requested_datetime,
  clinic_id: match.clinic_id || null,
  doctor_id: match.doctor_id || null,
  service_id: match.service_id || null,
  search_mode: match.search_mode || 'requested_window',
  nearby_search: nearbySearch,
  search_window_start: match.search_window_start || null,
  search_window_end: match.search_window_end || null,
  authority,
  verification_status: verificationStatus,
  timezone: match.timezone || null,
  exact_slot: match.exact_slot || null,
  slot_status: match.exact_slot?.slot_status || null
} }];