"""Shared plumbing for the apps that main.py mounts into one server."""

import os
import secrets
import sqlite3
import socket
import threading
from collections.abc import Callable
from datetime import timedelta
from pathlib import Path

from flask import Blueprint, Flask, current_app, g, jsonify, request
from werkzeug.serving import WSGIRequestHandler

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SHARED_DIR = ROOT / "shared"
LOCAL_HOSTS = ["127.0.0.1", "localhost"]
MUTATING = ("POST", "PUT", "DELETE", "PATCH")

# Where each app lives. The home page and main.py both read this.
PREFIXES = {
    "roam": "/roam",
    "runs": "/runs",
    "fitness": "/fitness",
    "fuad": "/fuad",
    "trading": "/trading",
}
# Strava lives inside My Runs as its second tab.
ACTIVITIES_PREFIX = PREFIXES["runs"] + "/activities"


def base_app(secret_key: str | None = None, data_dir: Path | None = None) -> Flask:
    """A Flask app with the settings every app shares; blueprints add their own routes."""
    hostname = (os.environ.get("HUB_HOSTNAME") or socket.gethostname()).strip().lower().rstrip(".")
    trusted_hosts = set(LOCAL_HOSTS)
    if hostname:
        trusted_hosts.add(hostname)
        if "." not in hostname:
            trusted_hosts.add(f"{hostname}.local")
    app = Flask("hub", static_folder=None)
    app.config.update(
        SECRET_KEY=secret_key or secrets.token_hex(32),
        TRUSTED_HOSTS=sorted(trusted_hosts),
        MAX_CONTENT_LENGTH=64 * 1024,
        SESSION_COOKIE_NAME="hub_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(days=7),
        DATA_DIR=str(data_dir or DATA_DIR),
    )
    return app


def standalone_app(blueprint: Blueprint) -> Flask:
    """Mount one blueprint at the root. Used by tests and for running a single app."""
    app = base_app()
    app.register_blueprint(blueprint)
    return app


def shared_blueprint() -> Blueprint:
    """Files every app can use, such as the 'back to hub' link style, at /shared/."""
    return Blueprint("shared", __name__, static_folder=str(SHARED_DIR), static_url_path="/shared")


def harden(
    blueprint: Blueprint, csp: str, *, max_body: int, require_origin: bool = False,
    origin_error: str = "Cross-origin changes are not allowed.",
    no_store_everywhere: bool = False, extra_headers: dict | None = None,
) -> None:
    """Per-app request limit, same-origin JSON-only writes, and response headers."""

    @blueprint.before_request
    def guard():
        request.max_content_length = max_body
        if request.method in MUTATING:
            origin = request.headers.get("Origin")
            if (origin or require_origin) and origin != request.host_url.rstrip("/"):
                return jsonify(error=origin_error), 403
            if request.method != "DELETE" and not request.is_json:
                return jsonify(error="Send the request as JSON."), 415
        return None

    @blueprint.after_request
    def headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = csp
        if no_store_everywhere or "/api/" in request.path:
            response.headers["Cache-Control"] = "no-store"
        response.headers.update(extra_headers or {})
        return response


def request_database(blueprint: Blueprint, key: str, locator: "Locator", foreign_keys: bool = False):
    """Return database() giving one connection per request, closed automatically."""

    def database() -> sqlite3.Connection:
        if key not in g:
            connection = sqlite3.connect(locator.path())
            connection.row_factory = sqlite3.Row
            if foreign_keys:
                connection.execute("PRAGMA foreign_keys = ON")
            setattr(g, key, connection)
        return getattr(g, key)

    @blueprint.teardown_app_request
    def close_database(error: BaseException | None) -> None:
        connection = g.pop(key, None)
        if connection is not None:
            connection.close()

    return database


class Locator:
    """Finds an app's database for the current request and prepares it once.

    `source` is a fixed path (tests, single-user use) or a function returning the
    path for the signed-in user. The schema is created the first time each path is used.
    """

    def __init__(self, source: str | Path | Callable[[], Path], prepare: Callable[[Path], None]):
        self._fixed = not callable(source)
        self._source = source if callable(source) else (lambda: Path(source))
        self._prepare = prepare
        self._ready: set[Path] = set()
        self._lock = threading.Lock()
        if self._fixed:
            self.path()  # a fixed location is prepared immediately, as before

    def path(self) -> Path:
        path = Path(self._source())
        if path not in self._ready:
            with self._lock:
                if path not in self._ready:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    self._prepare(path)
                    self._ready.add(path)
        return path


def user_file(filename: str) -> Callable[[], Path]:
    """A function giving `filename` inside the signed-in user's own folder."""
    return lambda: Path(current_app.config["DATA_DIR"]) / "users" / g.user.username / filename


def load_secret(data_dir: Path) -> str:
    """The session-signing key, created once and kept private to this computer."""
    path = data_dir / "secret.key"
    if not path.exists():
        path.write_text(secrets.token_hex(32), encoding="utf-8")
        path.chmod(0o600)
    return path.read_text(encoding="utf-8").strip()


class PrivateRequestHandler(WSGIRequestHandler):
    """Log request paths without query strings, which can carry OAuth codes."""

    def log_request(self, code="-", size="-"):
        path = self.path.split("?", 1)[0]
        self.log("info", '"%s %s %s" %s %s', self.command, path, self.request_version, code, size)
