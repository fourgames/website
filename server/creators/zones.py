"""The recipient's likely time zone, so outreach emails arrive in their working hours (send.py).

From the channel's or outlet's country first (one zone per country; for wide ones like the US, a
middle one), else from a language that is mostly spoken in one region, else None (send.py then uses
its own TIMEZONE, Stockholm). English and Spanish say too little about where someone lives.
"""

from __future__ import annotations

COUNTRY = {
    "US": "America/Chicago", "CA": "America/Toronto", "MX": "America/Mexico_City", "BR": "America/Sao_Paulo",
    "AR": "America/Argentina/Buenos_Aires", "CL": "America/Santiago", "CO": "America/Bogota", "PE": "America/Lima",
    "VE": "America/Caracas", "GB": "Europe/London", "IE": "Europe/Dublin", "PT": "Europe/Lisbon", "ES": "Europe/Madrid",
    "FR": "Europe/Paris", "BE": "Europe/Brussels", "NL": "Europe/Amsterdam", "LU": "Europe/Luxembourg",
    "DE": "Europe/Berlin", "AT": "Europe/Vienna", "CH": "Europe/Zurich", "IT": "Europe/Rome", "DK": "Europe/Copenhagen",
    "NO": "Europe/Oslo", "SE": "Europe/Stockholm", "FI": "Europe/Helsinki", "PL": "Europe/Warsaw", "CZ": "Europe/Prague",
    "SK": "Europe/Bratislava", "HU": "Europe/Budapest", "RO": "Europe/Bucharest", "BG": "Europe/Sofia",
    "GR": "Europe/Athens", "HR": "Europe/Zagreb", "RS": "Europe/Belgrade", "SI": "Europe/Ljubljana",
    "UA": "Europe/Kyiv", "BY": "Europe/Minsk", "LT": "Europe/Vilnius", "LV": "Europe/Riga", "EE": "Europe/Tallinn",
    "RU": "Europe/Moscow", "KZ": "Asia/Almaty", "TR": "Europe/Istanbul", "IL": "Asia/Jerusalem", "EG": "Africa/Cairo",
    "SA": "Asia/Riyadh", "AE": "Asia/Dubai", "ZA": "Africa/Johannesburg", "NG": "Africa/Lagos", "IN": "Asia/Kolkata",
    "PK": "Asia/Karachi", "BD": "Asia/Dhaka", "TH": "Asia/Bangkok", "VN": "Asia/Ho_Chi_Minh", "ID": "Asia/Jakarta",
    "MY": "Asia/Kuala_Lumpur", "SG": "Asia/Singapore", "PH": "Asia/Manila", "CN": "Asia/Shanghai", "HK": "Asia/Hong_Kong",
    "TW": "Asia/Taipei", "KR": "Asia/Seoul", "JP": "Asia/Tokyo", "AU": "Australia/Sydney", "NZ": "Pacific/Auckland",
}
LANGUAGE = {
    "de": "Europe/Berlin", "fr": "Europe/Paris", "it": "Europe/Rome", "nl": "Europe/Amsterdam", "pl": "Europe/Warsaw",
    "cs": "Europe/Prague", "sk": "Europe/Bratislava", "hu": "Europe/Budapest", "ro": "Europe/Bucharest",
    "el": "Europe/Athens", "sv": "Europe/Stockholm", "da": "Europe/Copenhagen", "no": "Europe/Oslo", "nb": "Europe/Oslo",
    "fi": "Europe/Helsinki", "uk": "Europe/Kyiv", "ru": "Europe/Moscow", "tr": "Europe/Istanbul", "he": "Asia/Jerusalem",
    "ar": "Asia/Riyadh", "hi": "Asia/Kolkata", "th": "Asia/Bangkok", "vi": "Asia/Ho_Chi_Minh", "id": "Asia/Jakarta",
    "ms": "Asia/Kuala_Lumpur", "zh": "Asia/Shanghai", "ko": "Asia/Seoul", "ja": "Asia/Tokyo", "pt": "America/Sao_Paulo",
}


def zone_for(country: str | None, language: str | None) -> str | None:
    """An IANA zone name, or None when neither says where they are."""
    zone = COUNTRY.get((country or "").strip().upper())
    if zone:
        return zone
    return LANGUAGE.get((language or "").split("-")[0].split("_")[0].strip().lower())
