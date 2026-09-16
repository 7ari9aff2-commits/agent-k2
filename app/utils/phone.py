import re
from typing import Optional, Dict, List

PHONE_RULES: Dict[str, Dict[str, any]] = {
    "SA": {"code": "+966", "lengths": [9], "prefixes": ["5"]},
    "AE": {"code": "+971", "lengths": [9], "prefixes": ["5"]},
    "KW": {"code": "+965", "lengths": [8], "prefixes": ["5", "6", "9"]},
    "QA": {"code": "+974", "lengths": [8], "prefixes": ["3", "5", "6", "7"]},
    "BH": {"code": "+973", "lengths": [8], "prefixes": ["3"]},
    "OM": {"code": "+968", "lengths": [8], "prefixes": ["7", "9"]},
    "EG": {"code": "+20", "lengths": [10], "prefixes": ["1", "2"]},
    "PH": {"code": "+63", "lengths": [10], "prefixes": ["9"]},
    "IN": {"code": "+91", "lengths": [10], "prefixes": ["6", "7", "8", "9"]},
    "PK": {"code": "+92", "lengths": [10], "prefixes": ["3"]},
    "BD": {"code": "+880", "lengths": [10], "prefixes": ["1"]},
    "ID": {"code": "+62", "lengths": [9, 10, 11, 12], "prefixes": ["8"]},
    "YE": {"code": "+967", "lengths": [9], "prefixes": ["7"]},
    "JO": {"code": "+962", "lengths": [9], "prefixes": ["7"]},
    "SD": {"code": "+249", "lengths": [9], "prefixes": ["9"]},
    "SY": {"code": "+963", "lengths": [9], "prefixes": ["9"]},
    "IQ": {"code": "+964", "lengths": [10], "prefixes": ["7"]},
    "LB": {"code": "+961", "lengths": [7, 8], "prefixes": ["3", "7"]},
    "TR": {"code": "+90", "lengths": [10], "prefixes": ["5"]},
    "US": {"code": "+1", "lengths": [10], "prefixes": ["2", "3", "4", "5", "6", "7", "8", "9"]},
    "GB": {"code": "+44", "lengths": [10], "prefixes": ["7"]},
}

ARABIC_INDIC = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
}

def to_english_digits(s: str) -> str:
    if not s:
        return ""
    res = []
    for ch in str(s):
        res.append(ARABIC_INDIC.get(ch, ch))
    return "".join(res)

def normalize_phone(raw_input: Optional[str], default_country: str = "SA") -> Optional[str]:
    """
    Normalizes a phone number to standard E.164 format.
    Matches the exact normalization logic from K2 Decision Core.
    """
    if raw_input is None:
        return None
    s = to_english_digits(str(raw_input))
    s = re.sub(r"[^\d+]", "", s)
    if not s:
        return None

    if s.startswith("+"):
        for rule in PHONE_RULES.values():
            if s.startswith(rule["code"]):
                return s
        return s

    for rule in PHONE_RULES.values():
        if len(s) in rule["lengths"] and any(s.startswith(p) for p in rule["prefixes"]):
            return rule["code"] + s

    if s.startswith("0"):
        s = s[1:]

    def_rule = PHONE_RULES.get(default_country)
    if def_rule:
        return def_rule["code"] + s
    return "+" + s
