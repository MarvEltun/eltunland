"""myFitness: a personal workout log with a weekly goal, streaks and trends."""

import math
import sqlite3
import uuid
from collections.abc import Callable
from contextlib import closing
from datetime import date
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from core import Locator, harden, request_database, standalone_app

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)
KINDS = ("run", "walk", "cycle", "swim", "gym", "yoga", "hike", "other")
DEFAULT_GOAL_MINUTES = 150


def prepare_database(path: Path) -> None:
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS workouts (
                id TEXT PRIMARY KEY,
                day TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('run','walk','cycle','swim','gym','yoga','hike','other')),
                minutes INTEGER NOT NULL CHECK(minutes BETWEEN 1 AND 1440),
                distance_km REAL CHECK(distance_km IS NULL OR distance_km > 0),
                effort INTEGER NOT NULL CHECK(effort BETWEEN 1 AND 5),
                notes TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_workouts_day ON workouts (day);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """
        )
        connection.execute(
            "INSERT OR IGNORE INTO settings VALUES ('goal_minutes', ?)", (str(DEFAULT_GOAL_MINUTES),)
        )
        connection.commit()


def clean_workout(data: object, today: date) -> tuple[dict | None, str | None]:
    if not isinstance(data, dict):
        return None, "Expected a workout entry."
    day, kind, notes = (data.get(name, "") for name in ("day", "kind", "notes"))
    if not all(isinstance(value, str) for value in (day, kind, notes)):
        return None, "Day, type and notes must be text."
    day, notes = day.strip(), notes.strip()
    try:
        parsed = date.fromisoformat(day)
    except ValueError:
        return None, "Choose a valid date (YYYY-MM-DD)."
    if parsed.isoformat() != day or not date(2000, 1, 1) <= parsed <= today:
        return None, "Choose a date between 2000 and today."
    if kind not in KINDS:
        return None, "Choose a workout type from the list."
    if len(notes) > 1000:
        return None, "Notes must be at most 1,000 characters."
    minutes, effort = data.get("minutes"), data.get("effort", 3)
    for value in (minutes, effort):
        if isinstance(value, bool) or not isinstance(value, int):
            return None, "Minutes and effort must be whole numbers."
    if not 1 <= minutes <= 1440:
        return None, "Minutes must be between 1 and 1,440."
    if not 1 <= effort <= 5:
        return None, "Effort must be between 1 (easy) and 5 (very hard)."
    distance = data.get("distance_km")
    if distance in (None, ""):
        distance = None
    elif isinstance(distance, bool) or not isinstance(distance, (int, float)) or not math.isfinite(distance) \
            or not 0 < distance <= 1000:
        return None, "Distance must be between 0 and 1,000 km, or left empty."
    return {
        "day": day, "kind": kind, "minutes": minutes, "distance_km": distance,
        "effort": effort, "notes": notes,
    }, None


def create_blueprint(source: str | Path | Callable[[], Path]) -> Blueprint:
    """`source` is one database path or a function giving the signed-in user's path."""
    bp = Blueprint("fitness", __name__, static_folder="static", static_url_path="/static")
    database = request_database(bp, "fitness_db", Locator(source, prepare_database))
    harden(bp, CSP, max_body=8 * 1024)

    @bp.errorhandler(BadRequest)
    def invalid_json(error):
        return jsonify(error="Invalid JSON request."), 400

    @bp.errorhandler(RequestEntityTooLarge)
    def oversized_request(error):
        return jsonify(error="This entry is too large."), 413

    @bp.errorhandler(sqlite3.Error)
    def database_error(error):
        current_app.logger.exception("Workout database operation failed.")
        return jsonify(error="Could not save or load local data. Check the server terminal."), 500

    def goal_minutes() -> int:
        row = database().execute("SELECT value FROM settings WHERE key='goal_minutes'").fetchone()
        return int(row["value"]) if row else DEFAULT_GOAL_MINUTES

    @bp.get("/")
    def index():
        return bp.send_static_file("index.html")

    @bp.get("/api/workouts")
    def list_workouts():
        rows = database().execute("SELECT * FROM workouts ORDER BY day DESC, rowid DESC")
        return jsonify(workouts=[dict(row) for row in rows], goal_minutes=goal_minutes(), kinds=KINDS)

    @bp.post("/api/workouts")
    @bp.put("/api/workouts/<workout_id>")
    def save_workout(workout_id: str | None = None):
        fields, error = clean_workout(request.get_json(), date.today())
        if error:
            return jsonify(error=error), 400
        connection = database()
        if workout_id:
            result = connection.execute(
                "UPDATE workouts SET day=:day, kind=:kind, minutes=:minutes, distance_km=:distance_km, "
                "effort=:effort, notes=:notes WHERE id=:id",
                {**fields, "id": workout_id},
            )
            if result.rowcount == 0:
                return jsonify(error="This workout no longer exists."), 404
        else:
            workout_id = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO workouts (id, day, kind, minutes, distance_km, effort, notes) "
                "VALUES (:id, :day, :kind, :minutes, :distance_km, :effort, :notes)",
                {**fields, "id": workout_id},
            )
        connection.commit()
        return jsonify(id=workout_id, **fields), 200 if request.method == "PUT" else 201

    @bp.delete("/api/workouts/<workout_id>")
    def delete_workout(workout_id: str):
        connection = database()
        result = connection.execute("DELETE FROM workouts WHERE id = ?", (workout_id,))
        if result.rowcount == 0:
            return jsonify(error="This workout no longer exists."), 404
        connection.commit()
        return "", 204

    @bp.put("/api/goal")
    def save_goal():
        data = request.get_json()
        minutes = data.get("minutes") if isinstance(data, dict) else None
        if isinstance(minutes, bool) or not isinstance(minutes, int) or not 10 <= minutes <= 2000:
            return jsonify(error="Choose a weekly goal between 10 and 2,000 minutes."), 400
        connection = database()
        connection.execute("INSERT OR REPLACE INTO settings VALUES ('goal_minutes', ?)", (str(minutes),))
        connection.commit()
        return jsonify(goal_minutes=minutes)

    return bp


def create_app(database_path: str):
    return standalone_app(create_blueprint(database_path))
