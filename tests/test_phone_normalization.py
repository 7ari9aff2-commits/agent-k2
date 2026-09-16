import pytest
from app.utils.phone import normalize_phone

def test_saudi_phone_normalization():
    assert normalize_phone("0501234567", "SA") == "+966501234567"
    assert normalize_phone("501234567", "SA") == "+966501234567"
    assert normalize_phone("+966501234567", "SA") == "+966501234567"
    # Arabic digits
    assert normalize_phone("٠٥٠١٢٣٤٥٦٧", "SA") == "+966501234567"

def test_egypt_phone_normalization():
    assert normalize_phone("01012345678", "EG") == "+201012345678"
    assert normalize_phone("+201012345678", "EG") == "+201012345678"

def test_uae_phone_normalization():
    assert normalize_phone("0509876543", "AE") == "+971509876543"
    assert normalize_phone("+971509876543", "AE") == "+971509876543"
