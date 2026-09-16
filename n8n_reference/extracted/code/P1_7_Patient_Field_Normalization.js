const PHONE_RULES = {
  SA: { code: '+966', lengths: [9], prefixes: ['5'] },
  AE: { code: '+971', lengths: [9], prefixes: ['5'] },
  KW: { code: '+965', lengths: [8], prefixes: ['5', '6', '9'] },
  QA: { code: '+974', lengths: [8], prefixes: ['3', '5', '6', '7'] },
  BH: { code: '+973', lengths: [8], prefixes: ['3'] },
  OM: { code: '+968', lengths: [8], prefixes: ['7', '9'] },
  EG: { code: '+20', lengths: [10], prefixes: ['1', '2'] },
  PH: { code: '+63', lengths: [10], prefixes: ['9'] },
  IN: { code: '+91', lengths: [10], prefixes: ['6', '7', '8', '9'] },
  PK: { code: '+92', lengths: [10], prefixes: ['3'] },
  BD: { code: '+880', lengths: [10], prefixes: ['1'] },
  ID: { code: '+62', lengths: [9, 10, 11, 12], prefixes: ['8'] },
  YE: { code: '+967', lengths: [9], prefixes: ['7'] },
  JO: { code: '+962', lengths: [9], prefixes: ['7'] },
  SD: { code: '+249', lengths: [9], prefixes: ['9'] },
  SY: { code: '+963', lengths: [9], prefixes: ['9'] },
  IQ: { code: '+964', lengths: [10], prefixes: ['7'] },
  LB: { code: '+961', lengths: [7, 8], prefixes: ['3', '7'] },
  TR: { code: '+90', lengths: [10], prefixes: ['5'] },
  US: { code: '+1', lengths: [10], prefixes: ['2', '3', '4', '5', '6', '7', '8', '9'] },
  GB: { code: '+44', lengths: [10], prefixes: ['7'] }
};
const ARABIC_INDIC = { '\u0660': '0', '\u0661': '1', '\u0662': '2', '\u0663': '3', '\u0664': '4', '\u0665': '5', '\u0666': '6', '\u0667': '7', '\u0668': '8', '\u0669': '9' };
const PHONE_KEYWORDS = /(?:هاتف|تلفون|جوال|موبايل|واتس|whatsapp|phone|tel|mobile|cell|call)/i;

function toEnglishDigits(s) { return String(s).replace(/[\u0660-\u0669]/g, function (ch) { return ARABIC_INDIC[ch]; }); }
function isMostlyDigits(s) { if (!s) return false; const noSpace = s.replace(/[\s\-\.\/\,\:]/g, ''); if (noSpace.length === 0) return false; const digits = (noSpace.match(/\d/g) || []).length; return digits >= 5 && digits / noSpace.length > 0.6; }

function normalizePhone(rawInput, defaultCountry) {
  if (defaultCountry == null) defaultCountry = 'SA';
  if (rawInput == null || rawInput === '') return null;
  let s = toEnglishDigits(String(rawInput)).replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.charAt(0) === '+') {
    for (const cc in PHONE_RULES) {
      const rule = PHONE_RULES[cc];
      if (s.indexOf(rule.code) === 0) return s;
    }
    return s;
  }
  for (const cc in PHONE_RULES) {
    const rule = PHONE_RULES[cc];
    if (rule.lengths.indexOf(s.length) !== -1) {
      const startsWithValidPrefix = rule.prefixes.some(function (p) { return s.indexOf(p) === 0; });
      if (startsWithValidPrefix) return rule.code + s;
    }
  }
  if (s.charAt(0) === '0') s = s.slice(1);
  const def = PHONE_RULES[defaultCountry];
  if (def) return def.code + s;
  return '+' + s;
}

function extractPhoneFromText(text) {
  if (!text) return null;
  const s = toEnglishDigits(String(text));
  const e164Match = s.match(/\+\d{7,15}/);
  if (e164Match) return normalizePhone(e164Match[0]);
  let localMatches = s.match(/\d[\d\s\-\.]{7,18}\d/g);
  if (localMatches) {
    let best = null;
    for (let i = 0; i < localMatches.length; i++) {
      const m = localMatches[i].replace(/[\s\-\.]/g, '');
      if (m.length < 9 || m.length > 15) continue;
      const idx = Math.max(0, (s.indexOf(localMatches[i]) || 0) - 20);
      const contextBefore = s.substring(idx, s.indexOf(localMatches[i]));
      const hasPhoneContext = PHONE_KEYWORDS.test(contextBefore);
      const normalized = normalizePhone(m);
      if (normalized) {
        if (!best || (hasPhoneContext && !best.hasPhoneContext) || m.length > best.length) {
          best = { normalized: normalized, hasPhoneContext: hasPhoneContext, length: m.length };
        }
      }
    }
    return best ? best.normalized : null;
  }
  return null;
}

function extractAge(rawInput) {
  if (rawInput == null) return null;
  const s = toEnglishDigits(String(rawInput));
  const patterns = [
    /(?:i\s*am|i'm|عمري|عمرها|عمره|عمر)\s*(\d{1,3})/i,
    /(\d{1,3})\s*(?:years?\s*old|سنة|سنوات|عام|اعوام|أعوام)/i,
    /\b(?:age|العمر)\s*[:=]?\s*(\d{1,3})\b/i
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = s.match(patterns[i]);
    if (m) { const n = parseInt(m[1], 10); if (n >= 0 && n <= 130) return n; }
  }
  return null;
}

function extractAddress(rawInput) {
  if (rawInput == null) return null;
  const INDIC = { '\u0660': '0', '\u0661': '1', '\u0662': '2', '\u0663': '3', '\u0664': '4', '\u0665': '5', '\u0666': '6', '\u0667': '7', '\u0668': '8', '\u0669': '9' };
  const toDigits = function (x) { return String(x).replace(/[\u0660-\u0669]/g, function (ch) { return INDIC[ch]; }); };
  const s = toDigits(String(rawInput)).trim();
  if (s.length < 5) return null;
  if (s.length > 300) return null;
  if (s.indexOf('{') !== -1 || s.indexOf('[') !== -1) return null;
  if (s.indexOf('\\') !== -1) return null;
  if (isMostlyDigits(s)) return null;
  if (s.indexOf('schema_version') !== -1 || s.indexOf('k2.dialogue') !== -1 || s.indexOf('phase') !== -1 || s.indexOf('reply') !== -1) return null;
  if (/[\r\n\t]/.test(s)) return null;
  const hasPostal = /\b\d{4,6}\b/.test(s);
  const englishKeywords = /\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|building|bldg|floor|fl|apartment|apt|suite|ste|house|home|address)\b/i;
  // Arabic keywords are word-delimited: حي matches only when followed by a space
  // ('حي الروضة'), never inside 'حياك' / 'يحيك'.
  const arabicKeywords = /(?:شارع|طريق|مبنى|بناية|عمارة|طابق|دور|شقة|رقم|حي\s+|منطقة|مدينة|عنوان|بجوار|بالقرب|ميدان|محلة)/;
  if (hasPostal || englishKeywords.test(s) || arabicKeywords.test(s)) return s;
  return null;
}

const items = $input.all();
const output = [];
const canonicalInbound = (() => { try { return $('Normalize & Validate').first().json || {}; } catch (_) { return {}; } })();
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const data = item.json || {};
  // Patient data comes from the PATIENT words only — never from an agent-output blob.
  const canonicalUserText = String(canonicalInbound.message_text || '').trim();
  let text = canonicalUserText;
  if (!text) {
    const candidate = String(data.message_text || '').trim();
    const looksPlain = candidate.length > 0 && candidate.length <= 500 && candidate.indexOf('{') === -1 && candidate.indexOf('schema_version') === -1 && candidate.indexOf('k2.dialogue') === -1 && /[A-Za-z\u0600-\u06FF]/.test(candidate);
    text = looksPlain ? candidate : '';
  }
  const clinicCountry = data.clinic_country_code || canonicalInbound.clinic_country_code || 'SA';
  const extractedPhone = extractPhoneFromText(text);
  const extractedAge = extractAge(text);
  const extractedAddress = extractAddress(text);
  const result = {};
  for (const k in data) result[k] = data[k];
  if (extractedPhone) result.p17_extracted_phone = extractedPhone;
  if (extractedAge != null) result.p17_extracted_age = extractedAge;
  if (extractedAddress) result.p17_extracted_address = extractedAddress;
  result.p17_extraction_meta = { phone_found: !!extractedPhone, age_found: extractedAge != null, address_found: !!extractedAddress, clinic_country: clinicCountry, text_length: text.length };
  output.push({ json: result });
}
return output;