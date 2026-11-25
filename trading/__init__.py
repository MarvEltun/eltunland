"""Trading: Procter & Gamble daily bars from Massive, for the Trading page."""

import hashlib
import os
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from flask import Blueprint, jsonify, request

from core import harden, standalone_app

from .market_data import DailyBar, MarketDataError, fetch_bars

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)
CACHE_SECONDS = 300
PERIODS = (30, 90, 180, 365)  # days of history offered on the page


def bar_json(bar: DailyBar) -> dict:
    return {
        "day": bar.day.isoformat(), "open": bar.open, "high": bar.high,
        "low": bar.low, "close": bar.close, "volume": bar.volume,
    }


def create_blueprint(
    env_key: str | None = None,
    fetch: Callable[[str, str], list[DailyBar]] = fetch_bars,
    clock: Callable[[], float] = time.monotonic,
) -> Blueprint:
    bp = Blueprint("trading", __name__, static_folder="static", static_url_path="/static")
    server_key = (os.environ.get("MASSIVE_API_KEY", "") if env_key is None else env_key).strip()
    cache: dict[tuple[str, int], tuple[float, dict]] = {}
    lock = threading.Lock()
    harden(bp, CSP, max_body=1024)

    @bp.get("/")
    def index():
        return bp.send_static_file("index.html")

    @bp.get("/api/config")
    def config():
        return jsonify(server_key=bool(server_key), periods=PERIODS)

    @bp.get("/api/pg")
    def pg():
        # The key is hashed for the cache so it is never kept in memory twice.
        key = (request.headers.get("X-Massive-Key", "") or server_key).strip()
        if not key:
            return jsonify(error="Enter your Massive API key to load PG's stock data."), 400
        try:
            days = int(request.args.get("days", "90"))
        except ValueError:
            days = 0
        if days not in PERIODS:
            return jsonify(error="Choose one of the listed chart periods."), 400
        cache_key = (hashlib.sha256(key.encode()).hexdigest(), days)
        with lock:
            hit = cache.get(cache_key)
            if request.args.get("refresh") == "1":
                cache.pop(cache_key, None)
                hit = None
            if hit and clock() - hit[0] < CACHE_SECONDS:
                return jsonify(hit[1])
        try:
            previous = fetch("/v2/aggs/ticker/PG/prev?adjusted=true", key)[-1]
        except MarketDataError as error:
            return jsonify(error=str(error)), 502
        payload = {
            "ticker": "PG", "previous": bar_json(previous), "history": [],
            "history_error": None, "fetched_at": datetime.now(UTC).isoformat(),
        }
        start = previous.day - timedelta(days=days)
        try:
            history = fetch(
                f"/v2/aggs/ticker/PG/range/1/day/{start}/{previous.day}"
                "?adjusted=true&sort=asc&limit=50000",
                key,
            )
            payload["history"] = [bar_json(bar) for bar in history]
        except MarketDataError as error:
            payload["history_error"] = str(error)
        if not payload["history_error"]:
            with lock:
                cache[cache_key] = (clock(), payload)
        return jsonify(payload)

    return bp


def create_app(env_key: str | None = None, fetch=fetch_bars, clock=time.monotonic):
    return standalone_app(create_blueprint(env_key, fetch, clock))
