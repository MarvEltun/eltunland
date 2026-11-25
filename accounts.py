"""Accounts: people with 4-digit PINs, separate data, and per-person app access.

Who exists is configured in data/accounts.json (see data.example/), not in the code.
This is a convenience lock for a shared computer, not strong security: a 4-digit
PIN has only 10,000 possibilities. It is hashed with a salt, wrong guesses lock the
account for longer and longer, and every request is checked, but anyone with access
to the files in data/ can still read them.
"""

import hashlib
import hmac
import json
import math
import os
import re
import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlencode

from flask import Blueprint, Response, g, jsonify, redirect, request, session

from core import PREFIXES, harden

ALL_APPS = tuple(PREFIXES)
USERNAME = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")  # also the name of the person's data folder
PBKDF2_ROUNDS = 200_000
MAX_FAILURES = 5  # wrong PINs in a row before the account locks
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)
# Reachable without signing in: the sign-in page and its API, plus static assets.
PUBLIC_PATHS = {
    "/login", "/api/users", "/api/login", "/api/pin", "/api/logout",
    "/manifest.webmanifest", "/service-worker.js", "/setup/ios", "/setup/ios/certificate",
}
PUBLIC_PREFIXES = ("/static/", "/shared/")


@dataclass(frozen=True)
class Account:
    username: str
    name: str
    apps: tuple[str, ...]

    @property
    def initial(self) -> str:
        return self.name[:1].upper()

    def public(self) -> dict:
        return {"username": self.username, "name": self.name, "initial": self.initial}


# Used until data/accounts.json exists, so a fresh checkout works.
DEFAULT_ACCOUNTS = (Account("owner", "Owner", ALL_APPS),)


def load_accounts(path: Path) -> tuple[Account, ...]:
    """Read data/accounts.json: {"accounts": [{"username", "name", "apps": "all" or a list}]}."""
    if not Path(path).is_file():
        return DEFAULT_ACCOUNTS
    try:
        entries = json.loads(Path(path).read_text(encoding="utf-8"))["accounts"]
        people = []
        for entry in entries:
            apps = ALL_APPS if entry.get("apps", "all") == "all" else tuple(entry["apps"])
            person = Account(entry["username"], str(entry["name"]).strip(), apps)
            if not USERNAME.match(person.username) or not person.name or len(person.name) > 40:
                raise ValueError(f"invalid username or name for {person.username!r}")
            if not apps or not set(apps) <= set(ALL_APPS):
                raise ValueError(f"unknown app for {person.username!r}; choose from {', '.join(ALL_APPS)}")
            people.append(person)
        if not people or len({person.username for person in people}) != len(people):
            raise ValueError("list each person once, with at least one person")
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise SystemExit(f"Cannot use {path}: {error}") from None
    return tuple(people)


def valid_pin(pin: object) -> bool:
    return isinstance(pin, str) and len(pin) == 4 and pin.isascii() and pin.isdigit()


def hash_pin(pin: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, PBKDF2_ROUNDS)


class AccountStore:
    """Who can sign in, and the salted hash of each person's PIN."""

    def __init__(self, path: Path, accounts: tuple[Account, ...] = DEFAULT_ACCOUNTS):
        self.path = Path(path)
        self.accounts = {account.username: account for account in accounts}
        os.close(os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600))
        with closing(self._connect()) as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS credentials (username TEXT PRIMARY KEY, salt BLOB NOT NULL, "
                "hash BLOB NOT NULL, failures INTEGER NOT NULL DEFAULT 0, locked_until REAL NOT NULL DEFAULT 0)"
            )
            connection.commit()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path, timeout=5)

    def get(self, username: object) -> Account | None:
        return self.accounts.get(username) if isinstance(username, str) else None

    def has_pin(self, username: str) -> bool:
        with closing(self._connect()) as connection:
            return connection.execute("SELECT 1 FROM credentials WHERE username=?", (username,)).fetchone() is not None

    def set_pin(self, username: str, pin: str) -> None:
        salt = os.urandom(16)
        with closing(self._connect()) as connection:
            connection.execute(
                "INSERT OR REPLACE INTO credentials (username, salt, hash) VALUES (?, ?, ?)",
                (username, salt, hash_pin(pin, salt)),
            )
            connection.commit()

    def clear_pin(self, username: str) -> None:
        with closing(self._connect()) as connection:
            connection.execute("DELETE FROM credentials WHERE username=?", (username,))
            connection.commit()

    def check(self, username: str, pin: str, now: float | None = None) -> tuple[str, int]:
        """Returns ('ok'|'wrong'|'locked'|'nopin', number): attempts left, or seconds to wait."""
        now = time.time() if now is None else now
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT salt, hash, failures, locked_until FROM credentials WHERE username=?", (username,)
            ).fetchone()
            if row is None:
                return "nopin", 0
            salt, stored, failures, locked_until = row
            if now < locked_until:
                return "locked", math.ceil(locked_until - now)
            if hmac.compare_digest(hash_pin(pin, salt), stored):
                connection.execute("UPDATE credentials SET failures=0, locked_until=0 WHERE username=?", (username,))
                connection.commit()
                return "ok", 0
            failures += 1
            wait = min(900, 30 * 2 ** (failures - MAX_FAILURES)) if failures >= MAX_FAILURES else 0
            connection.execute(
                "UPDATE credentials SET failures=?, locked_until=? WHERE username=?",
                (failures, now + wait if wait else 0, username),
            )
            connection.commit()
            return ("locked", wait) if wait else ("wrong", MAX_FAILURES - failures)


def app_for_path(path: str) -> str | None:
    for key, prefix in PREFIXES.items():
        if path == prefix or path.startswith(prefix + "/"):
            return key
    return None


def safe_next(value: str | None) -> str:
    """Only same-site paths, so a crafted link can't send you somewhere else after sign-in."""
    if value and value.startswith("/") and not value.startswith("//") and "\\" not in value and value != "/login":
        return value
    return "/"


def sign_in(username: str) -> None:
    session.clear()
    session["uid"] = username
    session.permanent = True


def create_blueprint(store: AccountStore) -> Blueprint:
    bp = Blueprint("accounts", __name__)
    harden(bp, CSP, max_body=1024, require_origin=True, no_store_everywhere=True)

    def credentials():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return None, None, (jsonify(error="Send a username and PIN."), 400)
        account, pin = store.get(data.get("username")), data.get("pin")
        if account is None:
            return None, None, (jsonify(error="Unknown user."), 404)
        if not valid_pin(pin):
            return None, None, (jsonify(error="Enter exactly four digits."), 400)
        return account, pin, None

    @bp.get("/api/users")
    def users():
        return jsonify(users=[{**a.public(), "has_pin": store.has_pin(a.username)} for a in store.accounts.values()])

    @bp.post("/api/login")
    def login():
        account, pin, problem = credentials()
        if problem:
            return problem
        result, number = store.check(account.username, pin)
        if result == "ok":
            sign_in(account.username)
            return jsonify(user=account.public())
        if result == "nopin":
            return jsonify(error="Create a PIN for this user first.", needs_pin=True), 409
        if result == "locked":
            return jsonify(error=f"Too many wrong PINs. Try again in {number} seconds.", retry_after=number), 429
        return jsonify(error="That PIN is not right.", attempts_left=number), 401

    @bp.post("/api/pin")
    def create_pin():
        account, pin, problem = credentials()
        if problem:
            return problem
        if store.has_pin(account.username):
            return jsonify(error="This user already has a PIN."), 409
        store.set_pin(account.username, pin)
        sign_in(account.username)
        return jsonify(user=account.public())

    @bp.post("/api/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    @bp.get("/api/me")
    def me():
        return jsonify(user=g.user.public(), apps=g.user.apps)

    return bp


def forbidden_page() -> Response:
    page = (
        '<!doctype html><meta charset="utf-8"><title>No access</title>'
        '<link rel="stylesheet" href="/static/style.css"><script src="/static/theme.js"></script>'
        '<main><div class="empty"><h2>This area isn\'t available to your account.</h2>'
        '<p>It isn\'t part of your hub.</p><p><a href="/">Back to your hub</a></p></div></main>'
    )
    return Response(page, status=403, mimetype="text/html")


def wants_page() -> bool:
    """True for browser page loads; fetch() calls and API clients ask for JSON or */*."""
    return "text/html" in request.headers.get("Accept", "") and "/api/" not in request.path


def install_gate(app, store: AccountStore) -> None:
    """Require sign-in everywhere except the sign-in page, and check app access."""

    @app.before_request
    def gate():
        request.host  # noqa: B018 - raises 400 for hosts outside TRUSTED_HOSTS before anything is answered
        path = request.path
        if path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES):
            return None
        account = store.get(session.get("uid"))
        if account is None:
            if wants_page():
                target = path + ("?" + request.query_string.decode() if request.query_string else "")
                return redirect("/login?" + urlencode({"next": target}))
            return jsonify(error="Sign in to continue."), 401
        g.user = account
        key = app_for_path(path)
        if key and key not in account.apps:
            if not wants_page():
                return jsonify(error="Your account does not have access to this app."), 403
            return forbidden_page()
        return None
