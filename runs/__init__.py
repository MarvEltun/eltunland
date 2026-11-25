"""My Runs: a local, single-user race log."""

import math
import re
import sqlite3
import uuid
from collections.abc import Callable
from contextlib import closing
from datetime import date
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from activities import cache_summary, cached_activities
from activities import prepare_database as prepare_strava
from core import Locator, harden, request_database, standalone_app

from .training import consecutive, summarize, window

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)
# key: (label, number of races in the full series)
SERIES = {
    "abbott": ("Abbott Big Six", 6),
    "superhalfs": ("SuperHalfs", 6),
    "superhalfs-europa": ("SuperHalfs Europa", 6),
}
KINDS = {
    "marathon": 42.195,
    "half": 21.0975,
    "10k": 10.0,
    "5.6k": 5.6,
    "other": None,
}
STATUSES = ("run", "planned", "wishlist")
MONTH = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")


def valid_race_date(value: str) -> bool:
    if MONTH.match(value):
        return 1900 <= int(value[:4]) <= 2100
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return False
    return parsed.isoformat() == value and 1900 <= parsed.year <= 2100


def parse_finish_time(value: str) -> int | None:
    """Accept h:mm:ss or m:ss and return seconds."""
    parts = value.split(":")
    if len(parts) not in (2, 3) or not all(part.isdigit() for part in parts):
        return None
    numbers = [int(part) for part in parts]
    if any(number >= 60 for number in numbers[1:]):
        return None
    seconds = sum(number * 60 ** index for index, number in enumerate(reversed(numbers)))
    return seconds if 0 < seconds < 100 * 3600 else None


def clean_race(data: object) -> tuple[dict | None, str | None]:
    if not isinstance(data, dict):
        return None, "Expected a race entry."
    fields = {}
    for name in ("title", "city", "country", "kind", "race_date", "status", "finish_time", "notes"):
        value = data.get(name, "")
        if not isinstance(value, str):
            return None, f"{name.replace('_', ' ').capitalize()} must be text."
        fields[name] = value.strip()
    if not 1 <= len(fields["title"]) <= 120:
        return None, "Give the race a title between 1 and 120 characters."
    if len(fields["city"]) > 80 or len(fields["country"]) > 80:
        return None, "City and country must be at most 80 characters."
    if len(fields["notes"]) > 2000:
        return None, "Notes must be at most 2,000 characters."
    if fields["kind"] not in KINDS:
        return None, "Choose marathon, half-marathon, 10k, 5.6k, or other."
    if fields["status"] not in STATUSES:
        return None, "Choose run, planned, or wishlist."

    distance = KINDS[fields["kind"]]
    if distance is None:
        raw = data.get("distance_km")
        if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
            return None, "Enter the race distance in kilometres."
        try:
            distance = float(raw)
        except (ValueError, OverflowError):
            return None, "Enter the race distance in kilometres."
        if not math.isfinite(distance) or not 0 < distance <= 1000:
            return None, "Distance must be between 0 and 1,000 km."

    series = data.get("series", [])
    if (
        not isinstance(series, list)
        or not all(isinstance(item, str) and item in SERIES for item in series)
        or len(set(series)) != len(series)
    ):
        return None, "Choose race series from the list."

    race_date = fields["race_date"]
    if race_date and not valid_race_date(race_date):
        return None, "Use a valid date: YYYY-MM or YYYY-MM-DD."
    if fields["status"] in ("run", "planned") and not race_date:
        return None, "Run and planned races need a date (at least the month)."
    if fields["status"] == "run" and race_date[:7] > date.today().isoformat()[:7]:
        return None, "A race in a future month can't be marked as run."

    finish_seconds = None
    if fields["finish_time"]:
        if fields["status"] != "run":
            return None, "Only races you have run can have a finish time."
        finish_seconds = parse_finish_time(fields["finish_time"])
        if finish_seconds is None:
            return None, "Use a finish time like 1:45:30 or 48:12."

    return {
        "title": fields["title"], "city": fields["city"], "country": fields["country"],
        "kind": fields["kind"], "distance_km": distance, "race_date": race_date,
        "status": fields["status"], "finish_seconds": finish_seconds, "notes": fields["notes"],
        "series": sorted(series),
    }, None


def prepare_database(path: Path) -> None:
    """Create My Runs' tables in `path`."""
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS races (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                city TEXT NOT NULL DEFAULT '',
                country TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL CHECK(kind IN ('marathon', 'half', '10k', '5.6k', 'other')),
                distance_km REAL NOT NULL CHECK(distance_km > 0),
                race_date TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL CHECK(status IN ('run', 'planned', 'wishlist')),
                finish_seconds INTEGER CHECK(finish_seconds IS NULL OR finish_seconds > 0),
                notes TEXT NOT NULL DEFAULT '',
                CHECK(finish_seconds IS NULL OR status = 'run')
            );
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS race_series (
                race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
                series TEXT NOT NULL,
                PRIMARY KEY (race_id, series)
            );
            """
        )
        connection.commit()


def create_blueprint(
    source: str | Path | Callable[[], Path],
    strava_source: str | Path | Callable[[], Path] | None = None,
) -> Blueprint:
    """`source` is one database path or a function giving the signed-in user's path.
    `strava_source` locates the cached Strava summaries used for the training totals."""
    bp = Blueprint("runs", __name__, static_folder="static", static_url_path="/static")
    locator = Locator(source, prepare_database)
    strava = Locator(strava_source, prepare_strava) if strava_source else None
    database = request_database(bp, "runs_db", locator, foreign_keys=True)
    harden(bp, CSP, max_body=16 * 1024)

    def all_races() -> list[dict]:
        connection = database()
        series: dict[str, list[str]] = {}
        for row in connection.execute("SELECT race_id, series FROM race_series ORDER BY series"):
            series.setdefault(row["race_id"], []).append(row["series"])
        return [
            {**dict(row), "series": series.get(row["id"], [])}
            for row in connection.execute("SELECT * FROM races ORDER BY race_date, title")
        ]

    def training_between(start: date, end: date, approximate: bool) -> dict:
        rows = cached_activities(strava.path(), start.isoformat(), end.isoformat())
        return {**summarize(rows, start, end), "approximate": approximate}

    @bp.errorhandler(BadRequest)
    def invalid_json(error):
        return jsonify(error="Invalid JSON request."), 400

    @bp.errorhandler(RequestEntityTooLarge)
    def oversized_request(error):
        return jsonify(error="This entry is too large."), 413

    @bp.errorhandler(sqlite3.Error)
    def database_error(error):
        current_app.logger.exception("Race database operation failed.")
        return jsonify(error="Could not save or load local data. Check the server terminal."), 500

    @bp.get("/")
    def index():
        return bp.send_static_file("index.html")

    @bp.get("/api/races")
    def list_races():
        races = all_races()
        training = {}
        if strava:
            for race_id, found in consecutive(races, date.today()).items():
                start, end, approximate = found["span"]
                since = found["since"]
                training[race_id] = {
                    **training_between(start, end, approximate), "so_far": found.get("so_far", False),
                    "since": {"id": since["id"], "title": since["title"], "race_date": since["race_date"]},
                }
        catalog = [{"key": key, "label": label, "total": total} for key, (label, total) in SERIES.items()]
        return jsonify(
            races=races, series_catalog=catalog, training=training,
            strava=cache_summary(strava.path()) if strava else {"count": 0, "last_synced": None},
        )

    @bp.get("/api/training")
    def training_range():
        """Totals between two of your races: ?from=<race id>&to=<race id>. 'to' may be omitted for 'until today'."""
        if not strava:
            return jsonify(error="Training totals need Strava."), 404
        races = {race["id"]: race for race in all_races()}
        first, last = races.get(request.args.get("from", "")), races.get(request.args.get("to", ""))
        if not first or not first["race_date"]:
            return jsonify(error="Choose a starting race that has a date."), 400
        if request.args.get("to") and (not last or not last["race_date"]):
            return jsonify(error="Choose an ending race that has a date."), 400
        today = date.today()
        found = window(first["race_date"], last["race_date"] if last else None, today)
        if found:
            found = (found[0], min(found[1], today), found[2])
        if not found or found[0] > found[1]:
            return jsonify(error="The second race must come after the first."), 400
        return jsonify(training_between(*found))

    @bp.post("/api/races")
    @bp.put("/api/races/<race_id>")
    def save_race(race_id: str | None = None):
        fields, error = clean_race(request.get_json())
        if error:
            return jsonify(error=error), 400
        series = fields.pop("series")
        connection = database()
        if race_id:
            result = connection.execute(
                "UPDATE races SET title=:title, city=:city, country=:country, kind=:kind, "
                "distance_km=:distance_km, race_date=:race_date, status=:status, "
                "finish_seconds=:finish_seconds, notes=:notes WHERE id=:id",
                {**fields, "id": race_id},
            )
            if result.rowcount == 0:
                return jsonify(error="This race no longer exists."), 404
        else:
            race_id = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO races (id, title, city, country, kind, distance_km, race_date, "
                "status, finish_seconds, notes) VALUES (:id, :title, :city, :country, :kind, "
                ":distance_km, :race_date, :status, :finish_seconds, :notes)",
                {**fields, "id": race_id},
            )
        connection.execute("DELETE FROM race_series WHERE race_id = ?", (race_id,))
        connection.executemany(
            "INSERT INTO race_series (race_id, series) VALUES (?, ?)",
            [(race_id, item) for item in series],
        )
        fields["series"] = series
        connection.commit()
        return jsonify(id=race_id, **fields), 200 if request.method == "PUT" else 201

    @bp.delete("/api/races/<race_id>")
    def delete_race(race_id: str):
        connection = database()
        result = connection.execute("DELETE FROM races WHERE id = ?", (race_id,))
        if result.rowcount == 0:
            return jsonify(error="This race no longer exists."), 404
        connection.commit()
        return "", 204

    return bp


def create_app(database_path: str, strava_path: str | None = None):
    return standalone_app(create_blueprint(database_path, strava_path))
