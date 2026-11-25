"""Roam: a local travel map, trip journal, flight atlas and stadium log."""

import json
import math
import sqlite3
import uuid
from collections.abc import Callable
from contextlib import closing
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

from flask import Blueprint, Response, current_app, jsonify, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from core import SHARED_DIR, Locator, harden, request_database, standalone_app

GOOGLE_MAPS_HOSTS = {"maps.app.goo.gl", "goo.gl", "maps.google.com", "google.com", "www.google.com"}
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
    "base-uri 'none'; form-action 'self'"
)


def text_fields(data: dict, names: tuple[str, ...]) -> tuple[dict, str | None]:
    """Read stripped text fields; a missing field is empty, a non-text one is an error."""
    fields = {}
    for name in names:
        value = data.get(name, "")
        if not isinstance(value, str):
            return {}, f"{name.replace('_', ' ').capitalize()} must be text."
        fields[name] = value.strip()
    return fields, None


def parse_date(value: str) -> date | None:
    """Parse a strict YYYY-MM-DD date, or return None."""
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.isoformat() == value else None


def parse_coordinate(value: object, name: str, limit: int) -> tuple[float | None, str | None]:
    if value is None or value == "":
        return None, None
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None, f"{name.capitalize()} must be a number."
    try:
        coordinate = float(value)
    except (ValueError, OverflowError):
        return None, f"{name.capitalize()} must be a number."
    if not math.isfinite(coordinate) or abs(coordinate) > limit:
        return None, f"{name.capitalize()} is out of range."
    return coordinate, None


def valid_map_url(url: str) -> bool:
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return (
        parts.scheme == "https" and parts.hostname in GOOGLE_MAPS_HOSTS
        and not parts.username and not parts.password
    )


def load_countries() -> dict:
    with (SHARED_DIR / "data" / "countries.geojson").open() as source:
        features = json.load(source)["features"]
    countries = {}
    for feature in features:
        properties = feature["properties"]
        if properties["CONTINENT"] == "Antarctica":
            continue
        code = properties["ADM0_A3"]
        countries[code] = {
            "id": code,
            "name": properties.get("NAME_EN") or properties["ADMIN"],
            "continent": properties["CONTINENT"],
            "region": properties["SUBREGION"],
            "iso2": properties["ISO_A2_EH"],
            "center": [properties["LABEL_X"], properties["LABEL_Y"]],
            "geometry": feature["geometry"],
        }
    return countries


FLIGHT_COLUMNS = (
    "date", "airline", "destination_code", "destination_icao_code", "destination_latitude",
    "destination_longitude", "destination_name", "origin_code", "origin_icao_code",
    "origin_latitude", "origin_longitude", "origin_name", "distance", "distance_units",
    "duration", "co2",
)


def prepare_database(path: Path) -> None:
    """Create Roam's tables in `path` (safe to run on an existing database)."""
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS country_states (
                country_id TEXT PRIMARY KEY,
                status TEXT NOT NULL CHECK(status IN ('none', 'visited', 'bucket')),
                notes TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS trips (
                id TEXT PRIMARY KEY,
                country_id TEXT NOT NULL,
                title TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS stadiums (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                location TEXT NOT NULL DEFAULT '',
                visited_on TEXT NOT NULL DEFAULT '',
                map_url TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                latitude REAL,
                longitude REAL
            );
            """
        )
        stadium_columns = {row[1] for row in connection.execute("PRAGMA table_info(stadiums)")}
        for column in ("latitude", "longitude"):
            if column not in stadium_columns:
                connection.execute(f"ALTER TABLE stadiums ADD COLUMN {column} REAL")
        connection.commit()

def create_blueprint(
    source: str | Path | Callable[[], Path], flights: Callable[[], Path] | None = None,
) -> Blueprint:
    """`source` is one database path or a function giving the signed-in user's path;
    `flights` likewise locates that user's flight file (none means an empty atlas)."""
    bp = Blueprint("roam", __name__, static_folder="static", static_url_path="/static")
    countries = load_countries()
    database = request_database(bp, "roam_db", Locator(source, prepare_database))
    harden(bp, CSP, max_body=64 * 1024)

    @bp.errorhandler(BadRequest)
    def invalid_json(error):
        return jsonify(error="Invalid JSON request."), 400

    @bp.errorhandler(RequestEntityTooLarge)
    def oversized_request(error):
        return jsonify(error="This entry is too large. Keep notes under 5,000 characters."), 413

    @bp.errorhandler(sqlite3.Error)
    def database_error(error):
        current_app.logger.exception("Travel database operation failed.")
        return jsonify(error="Could not save or load local data. Check the server terminal."), 500

    @bp.get("/")
    def index():
        return bp.send_static_file("index.html")

    @bp.get("/api/flights.tsv")
    def flight_file():
        path = flights() if flights else None
        text = path.read_text(encoding="utf-8") if path and path.is_file() else "\t".join(FLIGHT_COLUMNS) + "\n"
        return Response(text, mimetype="text/tab-separated-values")

    @bp.get("/api/bootstrap")
    def bootstrap():
        states = {
            row["country_id"]: dict(row)
            for row in database().execute("SELECT * FROM country_states")
        }
        trips = [
            dict(row)
            for row in database().execute("SELECT * FROM trips ORDER BY start_date DESC, id")
        ]
        stadiums = [
            dict(row)
            for row in database().execute(
                "SELECT * FROM stadiums ORDER BY visited_on DESC, name COLLATE NOCASE"
            )
        ]
        return jsonify(
            countries=[
                {
                    **country,
                    "status": states.get(code, {}).get("status", "none"),
                    "notes": states.get(code, {}).get("notes", ""),
                }
                for code, country in sorted(countries.items(), key=lambda item: item[1]["name"])
            ],
            trips=trips,
            stadiums=stadiums,
        )

    @bp.put("/api/countries/<code>")
    def update_country(code: str):
        if code not in countries:
            return jsonify(error="Unknown country or territory."), 404
        data = request.get_json()
        if not isinstance(data, dict):
            return jsonify(error="Expected a country entry."), 400
        status = data.get("status")
        notes = data.get("notes", "")
        if status not in ("none", "visited", "bucket"):
            return jsonify(error="Choose visited, bucket list, or not tracked."), 400
        if not isinstance(notes, str) or len(notes) > 5000:
            return jsonify(error="Country notes must be at most 5,000 characters."), 400
        connection = database()
        connection.execute(
            "INSERT INTO country_states (country_id, status, notes) VALUES (?, ?, ?) "
            "ON CONFLICT(country_id) DO UPDATE SET status=excluded.status, notes=excluded.notes",
            (code, status, notes.strip()),
        )
        connection.commit()
        return jsonify(country_id=code, status=status, notes=notes.strip())

    @bp.post("/api/trips")
    @bp.put("/api/trips/<trip_id>")
    def save_trip(trip_id: str | None = None):
        data = request.get_json()
        if not isinstance(data, dict):
            return jsonify(error="Expected a trip entry."), 400
        fields, error = text_fields(data, ("country_id", "title", "start_date", "end_date", "notes"))
        if error:
            return jsonify(error=error), 400
        if fields["country_id"] not in countries:
            return jsonify(error="Choose a country or territory for your trip."), 400
        if not 1 <= len(fields["title"]) <= 100:
            return jsonify(error="Give your trip a title between 1 and 100 characters."), 400
        if len(fields["notes"]) > 5000:
            return jsonify(error="Trip notes must be at most 5,000 characters."), 400
        start, end = parse_date(fields["start_date"]), parse_date(fields["end_date"])
        if not start or not end:
            return jsonify(error="Choose valid start and end dates (YYYY-MM-DD)."), 400
        if end < start:
            return jsonify(error="The end date cannot be before the start date."), 400
        connection = database()
        if trip_id:
            result = connection.execute(
                "UPDATE trips SET country_id=:country_id, title=:title, start_date=:start_date, "
                "end_date=:end_date, notes=:notes WHERE id=:id",
                {**fields, "id": trip_id},
            )
            if result.rowcount == 0:
                return jsonify(error="This trip no longer exists."), 404
        else:
            trip_id = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO trips (id, country_id, title, start_date, end_date, notes) "
                "VALUES (:id, :country_id, :title, :start_date, :end_date, :notes)",
                {**fields, "id": trip_id},
            )
        connection.commit()
        return jsonify(id=trip_id, **fields), 200 if request.method == "PUT" else 201

    @bp.delete("/api/trips/<trip_id>")
    def delete_trip(trip_id: str):
        connection = database()
        result = connection.execute("DELETE FROM trips WHERE id = ?", (trip_id,))
        if result.rowcount == 0:
            return jsonify(error="This trip no longer exists."), 404
        connection.commit()
        return "", 204

    @bp.post("/api/stadiums")
    @bp.put("/api/stadiums/<stadium_id>")
    def save_stadium(stadium_id: str | None = None):
        data = request.get_json()
        if not isinstance(data, dict):
            return jsonify(error="Expected a stadium entry."), 400
        fields, error = text_fields(data, ("name", "location", "visited_on", "map_url", "notes"))
        if error:
            return jsonify(error=error), 400
        for field, limit in (("latitude", 90), ("longitude", 180)):
            fields[field], error = parse_coordinate(data.get(field), field, limit)
            if error:
                return jsonify(error=error), 400
        if (fields["latitude"] is None) != (fields["longitude"] is None):
            return jsonify(error="Enter both latitude and longitude."), 400
        if not 1 <= len(fields["name"]) <= 120:
            return jsonify(error="Give the stadium a name between 1 and 120 characters."), 400
        if len(fields["location"]) > 120:
            return jsonify(error="Stadium location must be at most 120 characters."), 400
        if len(fields["notes"]) > 5000:
            return jsonify(error="Stadium notes must be at most 5,000 characters."), 400
        if fields["visited_on"] and not parse_date(fields["visited_on"]):
            return jsonify(error="Choose a valid visit date (YYYY-MM-DD)."), 400
        if len(fields["map_url"]) > 500:
            return jsonify(error="Map link must be at most 500 characters."), 400
        if fields["map_url"] and not valid_map_url(fields["map_url"]):
            return jsonify(error="Use a valid HTTPS Google Maps link."), 400

        connection = database()
        if stadium_id:
            result = connection.execute(
                "UPDATE stadiums SET name=:name, location=:location, visited_on=:visited_on, "
                "map_url=:map_url, notes=:notes, latitude=:latitude, longitude=:longitude "
                "WHERE id=:id",
                {**fields, "id": stadium_id},
            )
            if result.rowcount == 0:
                return jsonify(error="This stadium no longer exists."), 404
        else:
            stadium_id = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO stadiums "
                "(id, name, location, visited_on, map_url, notes, latitude, longitude) "
                "VALUES (:id, :name, :location, :visited_on, :map_url, :notes, :latitude, :longitude)",
                {**fields, "id": stadium_id},
            )
        connection.commit()
        return jsonify(id=stadium_id, **fields), 200 if request.method == "PUT" else 201

    @bp.delete("/api/stadiums/<stadium_id>")
    def delete_stadium(stadium_id: str):
        connection = database()
        result = connection.execute("DELETE FROM stadiums WHERE id = ?", (stadium_id,))
        if result.rowcount == 0:
            return jsonify(error="This stadium no longer exists."), 404
        connection.commit()
        return "", 204

    return bp


def create_app(database_path: str, flights: Callable[[], Path] | None = None):
    return standalone_app(create_blueprint(database_path, flights))
