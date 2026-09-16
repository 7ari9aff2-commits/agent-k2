import re
from datetime import datetime, timezone, timedelta
from typing import Optional

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_24 = re.compile(r"^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$")

ARABIC_DAYS = [
    "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"
]

def iso_date_valid(date_iso: Optional[str]) -> bool:
    if not date_iso or not ISO_DATE.match(str(date_iso)):
        return False
    try:
        datetime.strptime(str(date_iso), "%Y-%m-%d")
        return True
    except ValueError:
        return False

def date_within_horizon(date_iso: Optional[str], now_local_date: Optional[str], horizon_days: int = 60) -> bool:
    if not iso_date_valid(date_iso) or not iso_date_valid(now_local_date):
        return False
    d_target = datetime.strptime(date_iso, "%Y-%m-%d")
    d_now = datetime.strptime(now_local_date, "%Y-%m-%d")
    diff = (d_target - d_now).days
    return 0 <= diff <= horizon_days

def normalize_time(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    t = str(value).strip()
    if not TIME_24.match(t):
        return None
    if len(t) == 8:
        return t[:5]
    if len(t) == 4:
        return t + ":00"
    return t

def clean_str(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    s = re.sub(r"\s+", " ", str(value)).strip()
    return s if s else None

def format_arabic_date(date_str: str) -> str:
    """Returns 'الخميس 2026-09-17' format."""
    if not iso_date_valid(date_str):
        return date_str
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        day_name = ARABIC_DAYS[dt.weekday()]
        return f"{day_name} {date_str}"
    except Exception:
        return date_str
