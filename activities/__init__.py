"""My Activities: the Strava tab of My Runs.

Strava details can come from environment variables (STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET,
STRAVA_REFRESH_TOKEN). Browsing is live; a summary of each activity is cached locally on request
so My Runs can work out how much you trained between races.
"""

import os
import secrets
import sqlite3
import threading
import time
from collections.abc import Callable, Mapping
from contextlib import closing
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlencode

from flask import Blueprint, current_app, jsonify, redirect, request, session, url_for
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from core import Locator, harden, standalone_app

from .dashboard import PERIODS, build
from .strava import (
    PAGE_SIZE,
    SCOPES,
    StravaClient,
    StravaError,
    Transport,
    http_json,
    public_activity,
    public_profile,
)

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
    "base-uri 'none'; form-action 'self'; object-src 'none'"
)


def local_origin() -> str:
    """Strava only accepts the 127.0.0.1 callback domain, even if you browse via localhost."""
    port = request.host.partition(":")[2]
    return "http://127.0.0.1" + (f":{port}" if port else "")


def prepare_database(path: Path) -> None:
    """Create the private (owner-only) connection database and its tables."""
    os.close(os.open(path, os.O_CREAT | os.O_RDWR, 0o600))
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS credentials (
                id INTEGER PRIMARY KEY CHECK(id=1),
                access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
                expires_at INTEGER NOT NULL, athlete_id INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS activities (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL, sport_type TEXT NOT NULL,
                day TEXT NOT NULL, start_ts INTEGER NOT NULL, distance_m REAL NOT NULL,
                moving_s INTEGER NOT NULL, elevation_m REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS activities_day ON activities(day);
            """
        )
        connection.commit()


SYNC_PAGE_SIZE = 200
MAX_SYNC_PAGES = 40  # up to 8,000 activities per sync, well inside Strava's 100 requests per 15 minutes


def cache_row(item: object, athlete_id: int) -> tuple | None:
    """The few fields kept per activity, or None when Strava's item is unusable."""
    if not isinstance(item, dict) or type(item.get("id")) is not int:
        return None
    owner = item.get("athlete")
    if isinstance(owner, dict) and owner.get("id") != athlete_id:
        return None
    try:
        start = datetime.fromisoformat(str(item["start_date"]).replace("Z", "+00:00"))
        day = date.fromisoformat(str(item["start_date_local"])[:10]).isoformat()
        distance, moving = float(item.get("distance") or 0), int(item.get("moving_time") or 0)
        elevation = float(item.get("total_elevation_gain") or 0)
    except (KeyError, ValueError, TypeError, OverflowError):
        return None
    sport = item.get("sport_type") or item.get("type")
    if not isinstance(sport, str) or distance < 0 or moving < 0 or elevation < 0:
        return None
    return (item["id"], str(item.get("name") or "")[:200], sport[:40], day, int(start.timestamp()), distance, moving, elevation)


def cached_activities(path: Path, start: str, end: str) -> list[tuple]:
    """(day, sport_type, distance_m, moving_s, elevation_m) for activities from start to end, inclusive."""
    if not Path(path).is_file():
        return []
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as connection:
        try:
            return connection.execute(
                "SELECT day, sport_type, distance_m, moving_s, elevation_m FROM activities "
                "WHERE day BETWEEN ? AND ? ORDER BY day", (start, end),
            ).fetchall()
        except sqlite3.OperationalError:  # database from before the cache existed
            return []


def cache_summary(path: Path) -> dict:
    empty = {"count": 0, "last_synced": None}
    if not Path(path).is_file():
        return empty
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as connection:
        try:
            count = connection.execute("SELECT COUNT(*) FROM activities").fetchone()[0]
            synced = connection.execute("SELECT value FROM settings WHERE key='last_synced'").fetchone()
        except sqlite3.OperationalError:
            return empty
    return {"count": count, "last_synced": int(synced[0]) if synced else None}


def clear_oauth_state() -> None:
    """Forget a half-finished Strava login without signing the user out of the hub."""
    session.pop("oauth_state", None)
    session.pop("oauth_started", None)


def create_blueprint(
    source: str | Path | Callable[[], Path], transport: Transport = http_json,
    environ: Mapping[str, str] = os.environ,
) -> Blueprint:
    """`source` is one database path or a function giving the signed-in user's path."""
    bp = Blueprint("activities", __name__, static_folder="static", static_url_path="/static")
    locator = Locator(source, prepare_database)

    def database() -> sqlite3.Connection:
        connection = sqlite3.connect(locator.path())
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA secure_delete=ON")
        return connection

    client = StravaClient(transport)
    lock = threading.RLock()

    def settings() -> dict:
        with closing(database()) as connection:
            return dict(connection.execute("SELECT key, value FROM settings"))

    def env_value(name: str) -> str:
        return environ.get(name, "").strip()

    def strava_config() -> dict:
        """Client id and secret: environment variables win over what was typed into the app."""
        stored = settings()
        return {
            "client_id": env_value("STRAVA_CLIENT_ID") or stored.get("client_id"),
            "client_secret": env_value("STRAVA_CLIENT_SECRET") or stored.get("client_secret"),
        }

    unusable_environment_token: list[bool] = []  # set once Strava says the token lacks permissions

    def environment_ready() -> bool:
        config = strava_config()
        return bool(
            env_value("STRAVA_REFRESH_TOKEN") and config["client_id"] and config["client_secret"]
            and not unusable_environment_token
        )

    def credentials() -> dict | None:
        with closing(database()) as connection:
            row = connection.execute("SELECT * FROM credentials WHERE id=1").fetchone()
            return dict(row) if row else None

    def save_tokens(tokens: dict, athlete_id: int) -> None:
        with closing(database()) as connection:
            connection.execute(
                "INSERT OR REPLACE INTO credentials VALUES (1, ?, ?, ?, ?)",
                (tokens["access_token"], tokens["refresh_token"], tokens["expires_at"], athlete_id),
            )
            connection.commit()

    def forget_connection() -> None:
        with closing(database()) as connection:
            connection.execute("DELETE FROM credentials")
            connection.commit()
        clear_oauth_state()

    def connect_from_environment() -> dict:
        """Trade the STRAVA_REFRESH_TOKEN for working tokens the first time they are needed."""
        config = strava_config()
        try:
            tokens = client.exchange(
                config["client_id"], config["client_secret"],
                grant_type="refresh_token", refresh_token=env_value("STRAVA_REFRESH_TOKEN"),
            )
            athlete, _ = client.get("athlete", tokens["access_token"])
        except StravaError as error:
            if error.status in (400, 401):
                raise StravaError(
                    "Strava rejected STRAVA_REFRESH_TOKEN. Check STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET, "
                    "and that the token was granted the activity:read_all permission.", 401,
                ) from None
            raise
        if not isinstance(athlete, dict) or type(athlete.get("id")) is not int or athlete["id"] <= 0:
            raise StravaError("Strava did not return a valid athlete.")
        save_tokens(tokens, athlete["id"])
        return credentials()

    def access_token(force: bool = False) -> dict:
        current = credentials()
        if not current and environment_ready():
            current = connect_from_environment()
        if not current:
            raise StravaError("Connect your Strava account to load your activities.", 401)
        if not current["refresh_token"]:
            if force:
                forget_connection()
                raise StravaError(
                    "Your imported access token expired or was revoked. Import a new token "
                    "or authorize with Strava for automatic renewal.", 401,
                )
            return current
        if force or current["expires_at"] <= time.time() + 60:
            config = strava_config()
            try:
                refreshed = client.exchange(
                    config["client_id"], config["client_secret"],
                    grant_type="refresh_token", refresh_token=current["refresh_token"],
                )
            except StravaError as error:
                if error.status in (400, 401):
                    forget_connection()
                    raise StravaError("Your Strava authorization is no longer valid. Please reconnect.", 401) from None
                raise
            save_tokens(refreshed, current["athlete_id"])
            current.update(refreshed)
        return current

    def strava_get(endpoint: str) -> tuple[object, dict, int]:
        with lock:
            auth = access_token()
            try:
                data, rate = client.get(endpoint, auth["access_token"])
            except StravaError as error:
                if error.code == "scope_missing":
                    # Refreshing cannot add permissions. Drop this token and stop re-using the
                    # environment's one, so the page offers Authorize with Strava instead.
                    forget_connection()
                    unusable_environment_token.append(True)
                    raise
                if error.status != 401:
                    raise
                auth = access_token(force=True)
                try:
                    data, rate = client.get(endpoint, auth["access_token"])
                except StravaError as retry_error:
                    if retry_error.status == 401:
                        forget_connection()
                    raise
            return data, rate, auth["athlete_id"]

    def callback_url() -> str:
        return local_origin() + url_for(".callback")

    harden(
        bp, CSP, max_body=8 * 1024, require_origin=True,
        origin_error="Only requests from this local app are allowed.",
        no_store_everywhere=True,
        extra_headers={"Pragma": "no-cache", "Referrer-Policy": "no-referrer"},
    )

    @bp.errorhandler(StravaError)
    def strava_error(error: StravaError):
        current_app.logger.warning("Strava request failed: status=%s", error.status)
        return jsonify(error=str(error), rate=error.rate), error.status

    @bp.errorhandler(sqlite3.Error)
    def database_error(error):
        current_app.logger.error("Local credential database failed: %s", type(error).__name__)
        return jsonify(error="Could not read or save your local connection. Check the server terminal."), 500

    @bp.errorhandler(BadRequest)
    def bad_request(error):
        return jsonify(error="Invalid JSON request."), 400

    @bp.errorhandler(RequestEntityTooLarge)
    def too_large(error):
        return jsonify(error="The setup request is too large."), 413

    @bp.get("/")
    def index():
        if request.host.split(":")[0] == "localhost":
            return redirect(local_origin() + url_for(".index"))
        return bp.send_static_file("index.html")

    @bp.get("/api/status")
    def status():
        config = strava_config()
        current = credentials()
        return jsonify(
            configured=bool(config["client_id"] and config["client_secret"]),
            connected=current is not None or environment_ready(), callback_url=callback_url(),
            token_only=bool(current and not current["refresh_token"]),
            from_environment=bool(env_value("STRAVA_CLIENT_ID") and env_value("STRAVA_CLIENT_SECRET")),
            cache=cache_summary(locator.path()),
        )

    @bp.post("/api/token")
    def import_token():
        data = request.get_json()
        token = data.get("access_token") if isinstance(data, dict) else None
        if (
            not isinstance(token, str) or not 8 <= len(token.strip()) <= 256
            or not token.isascii() or not token.isprintable()
            or any(character.isspace() for character in token.strip())
        ):
            return jsonify(error="Enter a valid Strava access token, not a Client Secret or refresh token."), 400
        token = token.strip()
        with lock:
            if credentials():
                return jsonify(error="Disconnect your current account before importing a token."), 409
            athlete, _ = client.get("athlete", token)
            if not isinstance(athlete, dict) or type(athlete.get("id")) is not int or athlete["id"] <= 0:
                raise StravaError("Strava did not return a valid athlete.")
            try:
                available, rate = client.get("athlete/activities?page=1&per_page=1", token)
            except StravaError as error:
                if error.status in (401, 403):
                    raise StravaError(
                        "This token cannot read your activities. Use a valid token with "
                        "activity:read or activity:read_all permission. A Client Secret or "
                        "a basic read-only API-settings token is not sufficient.",
                        error.status, error.rate,
                    ) from None
                raise
            if not isinstance(available, list):
                raise StravaError("Strava returned an invalid activity list.")
            # An imported token has no refresh token or known expiry.
            save_tokens({"access_token": token, "refresh_token": "", "expires_at": 0}, athlete["id"])
            clear_oauth_state()
        return jsonify(
            message="Access token saved locally. Automatic renewal is unavailable; import a new "
            "token when it expires, or use Strava authorization for automatic renewal.",
            rate=rate,
        )

    @bp.post("/api/setup")
    def setup():
        data = request.get_json()
        if not isinstance(data, dict):
            return jsonify(error="Expected your API application settings."), 400
        if env_value("STRAVA_CLIENT_ID") and env_value("STRAVA_CLIENT_SECRET"):
            return jsonify(error="Your Strava details are set by environment variables; change them there."), 409
        client_id, secret = data.get("client_id"), data.get("client_secret")
        if not isinstance(client_id, str) or not client_id.isascii() or not client_id.isdigit() or int(client_id) <= 0:
            return jsonify(error="Enter the numeric Client ID from your Strava API application."), 400
        if not isinstance(secret, str) or not 8 <= len(secret.strip()) <= 256:
            return jsonify(error="Enter the Client Secret from your Strava API application."), 400
        with lock:
            if credentials():
                return jsonify(error="Disconnect your current account before changing API credentials."), 409
            with closing(database()) as connection:
                connection.executemany("INSERT OR REPLACE INTO settings VALUES (?, ?)", [
                    ("client_id", client_id), ("client_secret", secret.strip()),
                ])
                connection.commit()
            clear_oauth_state()
        return jsonify(message="API credentials saved locally. You can now authorize with Strava.")

    @bp.post("/api/connect")
    def connect():
        config = strava_config()
        if not config["client_id"] or not config["client_secret"]:
            return jsonify(error="Set up your Strava API application first."), 409
        session["oauth_state"] = secrets.token_urlsafe(32)
        session["oauth_started"] = time.time()
        return jsonify(url="https://www.strava.com/oauth/authorize?" + urlencode({
            "client_id": config["client_id"], "redirect_uri": callback_url(),
            "response_type": "code", "approval_prompt": "force", "scope": SCOPES,
            "state": session["oauth_state"],
        }))

    @bp.get("/oauth/callback")
    def callback():
        def done(result: str):
            return redirect(url_for(".index", connection=result))

        expected = session.pop("oauth_state", None)
        started = session.pop("oauth_started", 0)
        state = request.args.get("state", "")
        if not expected or not secrets.compare_digest(expected, state) or time.time() - started > 600:
            return done("invalid_state")
        if request.args.get("error"):
            return done("denied")
        code = request.args.get("code")
        scopes = set(request.args.get("scope", "").replace(",", " ").split())
        if not code or not set(SCOPES.split(",")).issubset(scopes):
            return done("missing_permissions")
        config = strava_config()
        with lock:
            try:
                tokens = client.exchange(
                    config["client_id"], config["client_secret"],
                    grant_type="authorization_code", code=code,
                )
                athlete = tokens.get("athlete")
                if not isinstance(athlete, dict) or type(athlete.get("id")) is not int or athlete["id"] <= 0:
                    raise StravaError("Strava did not return a valid athlete.")
                save_tokens(tokens, athlete["id"])
            except StravaError as error:
                current_app.logger.warning("Strava authorization failed: status=%s", error.status)
                if error.code == "tls_failed":
                    return done("tls_failed")
                if error.status == 503:
                    return done("unavailable")
                return done("exchange_failed")
        return done("success")

    @bp.get("/api/profile")
    def profile():
        data, rate, athlete = strava_get("athlete")
        return jsonify(profile=public_profile(data, athlete), rate=rate)

    @bp.get("/api/activities")
    def activities():
        page = request.args.get("page", "1")
        if not page.isascii() or not page.isdigit() or not 1 <= int(page) <= 100000:
            return jsonify(error="Choose a valid activity page."), 400
        data, rate, athlete = strava_get(f"athlete/activities?{urlencode({'page': int(page), 'per_page': PAGE_SIZE})}")
        if not isinstance(data, list):
            raise StravaError("Strava returned an invalid activity list.")
        return jsonify(
            activities=[public_activity(activity, athlete) for activity in data],
            page=int(page), has_more=len(data) == PAGE_SIZE, rate=rate,
        )

    @bp.get("/api/activities/<int:activity_id>")
    def activity(activity_id: int):
        data, rate, athlete = strava_get(f"activities/{activity_id}?include_all_efforts=false")
        return jsonify(activity=public_activity(data, athlete), rate=rate)

    @bp.get("/api/dashboard")
    def dashboard():
        """Charts and records from the cached summaries (sync first). ?days=90|180|365|0 (0 = everything)."""
        raw = request.args.get("days", "365")
        if not raw.isdigit() or int(raw) not in PERIODS:
            return jsonify(error="Choose 90, 180, 365 or 0 (everything) days."), 400
        rows = cached_activities(locator.path(), "0000-01-01", "9999-12-31")
        return jsonify({**build(rows, date.today(), int(raw)), "cache": cache_summary(locator.path())})

    @bp.post("/api/sync")
    def sync():
        """Cache a summary of every activity so My Runs can total your training between races."""
        data = request.get_json()
        if data not in ({}, {"full": True}):
            return jsonify(error="Invalid sync request."), 400
        full = bool(data)
        with lock:
            with closing(database()) as connection:
                newest = connection.execute("SELECT MAX(start_ts) FROM activities").fetchone()[0]
            # Re-read a few days back so activities edited or uploaded late are picked up.
            after = 0 if full or newest is None else max(0, newest - 3 * 86400)
            fetched: list[tuple] = []
            complete, rate, page = False, {}, 1
            while page <= MAX_SYNC_PAGES:
                query = urlencode({"after": after, "page": page, "per_page": SYNC_PAGE_SIZE})
                items, rate, athlete = strava_get(f"athlete/activities?{query}")
                if not isinstance(items, list):
                    raise StravaError("Strava returned an invalid activity list.")
                fetched.extend(row for row in (cache_row(item, athlete) for item in items) if row)
                if len(items) < SYNC_PAGE_SIZE:
                    complete = True
                    break
                page += 1
            # Written in one go, after all requests, so a token refresh never waits on this write.
            with closing(database()) as connection:
                connection.executemany("INSERT OR REPLACE INTO activities VALUES (?, ?, ?, ?, ?, ?, ?, ?)", fetched)
                if full and complete:  # drop activities that were deleted on Strava
                    connection.execute("CREATE TEMP TABLE seen (id INTEGER PRIMARY KEY)")
                    connection.executemany("INSERT OR IGNORE INTO seen VALUES (?)", [(row[0],) for row in fetched])
                    connection.execute("DELETE FROM activities WHERE id NOT IN (SELECT id FROM seen)")
                if complete:
                    connection.execute("INSERT OR REPLACE INTO settings VALUES ('last_synced', ?)", (str(int(time.time())),))
                connection.commit()
        return jsonify(cache=cache_summary(locator.path()), fetched=len(fetched), complete=complete, rate=rate)

    @bp.post("/api/disconnect")
    def disconnect():
        data = request.get_json()
        if data not in ({}, {"forget_only": True}):
            return jsonify(error="Invalid disconnect request."), 400
        with lock:
            if credentials() and not data.get("forget_only"):
                try:
                    auth = access_token()
                    client.deauthorize(auth["access_token"])
                except StravaError as error:
                    if error.status != 401:
                        raise StravaError(
                            "Could not revoke Strava access. Retry, or use 'Forget local connection' "
                            "and revoke access in your Strava account settings.",
                            error.status, error.rate,
                        ) from None
            forget_connection()
            with closing(database()) as connection:
                connection.execute("DELETE FROM settings WHERE key IN ('client_id', 'client_secret', 'last_synced')")
                connection.execute("DELETE FROM activities")
                connection.commit()
        return jsonify(
            message="Local credentials, connection and cached activity summaries deleted.",
            revoked=not data.get("forget_only", False),
        )

    return bp


def create_app(database_path: str, transport: Transport = http_json, environ: Mapping[str, str] = os.environ):
    return standalone_app(create_blueprint(database_path, transport, environ))
