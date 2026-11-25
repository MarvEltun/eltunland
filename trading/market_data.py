"""Fetch and validate PG's split-adjusted daily bars from Massive."""

import json
import math
from dataclasses import dataclass
from datetime import date, datetime
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


class MarketDataError(Exception):
    """A user-visible API or stock-data error."""


@dataclass(frozen=True)
class DailyBar:
    day: date
    open: float
    high: float
    low: float
    close: float
    volume: float


def fetch_bars(path: str, api_key: str) -> list[DailyBar]:
    if not api_key.strip():
        raise MarketDataError("Provide a Massive API key to load stock data.")
    request = Request(
        f"https://api.massive.com{path}",
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            data = json.load(response)
    except HTTPError as exc:
        messages = {
            401: "API key rejected. Check your Massive API key.",
            403: "Access denied. Check your Massive plan's data permissions.",
            429: "Massive rate limit reached. Wait a minute before refreshing.",
        }
        raise MarketDataError(
            messages.get(exc.code, f"Massive returned HTTP {exc.code}. Try again later.")
        ) from None
    except (URLError, TimeoutError, OSError):
        raise MarketDataError("Could not connect to Massive. Check your connection and retry.") from None
    except (ValueError, UnicodeError):
        raise MarketDataError("Massive returned an invalid JSON response.") from None

    if not isinstance(data, dict) or data.get("status") not in ("OK", "DELAYED"):
        raise MarketDataError("Massive reported an unsuccessful stock-data response.")
    results = data.get("results")
    if not isinstance(results, list) or not results:
        raise MarketDataError("No PG trading data is available for this period.")

    bars = []
    try:
        for item in results:
            values = [item[key] for key in ("t", "o", "h", "l", "c", "v")]
            if any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                for value in values
            ):
                raise ValueError("Invalid numeric field.")
            timestamp, opening, high, low, close, volume = values
            if min(opening, high, low, close) <= 0 or volume < 0:
                raise ValueError("Invalid price or volume.")
            bars.append(
                DailyBar(
                    datetime.fromtimestamp(
                        timestamp / 1000, tz=ZoneInfo("America/New_York")
                    ).date(),
                    opening,
                    high,
                    low,
                    close,
                    volume,
                )
            )
    except (KeyError, TypeError, ValueError, OverflowError, OSError):
        raise MarketDataError("Massive returned incomplete or invalid daily price data.") from None
    return sorted(bars, key=lambda bar: bar.day)
