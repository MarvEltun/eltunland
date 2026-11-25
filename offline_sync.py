"""Per-user storage for offline MyFuad snapshots."""

import json
import os
import sqlite3
import threading
from pathlib import Path

from flask import Blueprint, Flask, Response, current_app, g, jsonify, request

from core import harden

FUAD_STATE_LIMIT = 2 * 1024 * 1024
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)
_write_locks: dict[str, threading.Lock] = {}
_write_locks_guard = threading.Lock()


def _is_syncable_path(path: str) -> bool:
    return (
        path.startswith(("/roam/api/trips", "/roam/api/stadiums", "/roam/api/countries"))
        or path.startswith("/runs/api/races")
        or path.startswith(("/fitness/api/workouts", "/fitness/api/goal"))
    )


def _database() -> sqlite3.Connection:
    existing = g.get("_offline_sync_connection")
    if existing is not None:
        return existing
    path = (
        Path(current_app.config["DATA_DIR"])
        / "users"
        / g.user.username
        / "offline-sync.sqlite3"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(descriptor)
    connection = sqlite3.connect(path)
    path.chmod(0o600)
    connection.row_factory = sqlite3.Row
    connection.execute(
        "CREATE TABLE IF NOT EXISTS fuad_snapshot ("
        "id INTEGER PRIMARY KEY CHECK (id = 1), "
        "revision INTEGER NOT NULL, payload TEXT NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS changes ("
        "revision INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, device TEXT NOT NULL DEFAULT '')"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS sync_operations ("
        "operation_id TEXT PRIMARY KEY, status INTEGER NOT NULL, content_type TEXT NOT NULL, body TEXT NOT NULL)"
    )
    connection.commit()
    g._offline_sync_connection = connection
    return connection


def install_change_tracking(app: Flask) -> None:
    @app.teardown_request
    def close_offline_sync_database(error):
        connection = g.pop("_offline_sync_connection", None)
        if connection is not None:
            connection.close()
        lock = g.pop("_offline_sync_write_lock", None)
        if lock is not None:
            lock.release()

    @app.before_request
    def reject_stale_offline_write():
        if (
            request.method in {"POST", "PUT", "PATCH", "DELETE"}
            and _is_syncable_path(request.path)
            and getattr(g, "user", None) is not None
        ):
            username = g.user.username
            with _write_locks_guard:
                lock = _write_locks.setdefault(username, threading.Lock())
            lock.acquire()
            g._offline_sync_write_lock = lock

        revision_header = request.headers.get("X-Hub-Sync-Revision")
        entity = request.headers.get("X-Hub-Sync-Entity")
        if request.method not in {"POST", "PUT", "PATCH", "DELETE"} or not _is_syncable_path(request.path):
            return None
        if getattr(g, "user", None) is None:
            return None
        operation_id = request.headers.get("X-Hub-Sync-Operation")
        if operation_id:
            if len(operation_id) > 80:
                return jsonify(error="Invalid offline sync operation ID."), 400
            row = _database().execute(
                "SELECT status, content_type, body FROM sync_operations WHERE operation_id=?",
                (operation_id,),
            ).fetchone()
            if row:
                g._offline_sync_replay = True
                return Response(row["body"], status=row["status"], content_type=row["content_type"])
        if not revision_header or not entity:
            return None
        if request.headers.get("X-Hub-Sync-Force") == "1":
            return None
        try:
            revision = int(revision_header)
        except ValueError:
            return jsonify(error="Invalid offline sync revision."), 400
        if revision < 0:
            return jsonify(error="Invalid offline sync revision."), 400
        connection = _database()
        device = request.headers.get("X-Hub-Sync-Device", "")
        changed = connection.execute(
            "SELECT 1 FROM changes WHERE entity=? AND revision>? AND device<>? LIMIT 1",
            (entity, revision, device),
        ).fetchone()
        if changed:
            return jsonify(error="This item changed on the laptop since the offline edit."), 409
        return None

    @app.after_request
    def record_syncable_change(response):
        if not request.path.startswith("/api/") and "/api/" not in request.path:
            return response
        user = getattr(g, "user", None)
        if user is None:
            return response
        path = request.path
        syncable = _is_syncable_path(path)
        if (
            syncable
            and request.method in {"POST", "PUT", "PATCH", "DELETE"}
            and response.status_code < 400
            and not getattr(g, "_offline_sync_replay", False)
        ):
            entity = path
            if request.method == "POST":
                result = response.get_json(silent=True) or {}
                if isinstance(result, dict) and result.get("id"):
                    entity = f"{path.rstrip('/')}/{result['id']}"
            connection = _database()
            connection.execute(
                "INSERT INTO changes (entity, device) VALUES (?, ?)",
                (entity, request.headers.get("X-Hub-Sync-Device", "")),
            )
            operation_id = request.headers.get("X-Hub-Sync-Operation")
            if operation_id:
                body = "" if response.status_code == 204 else response.get_data(as_text=True)
                connection.execute(
                    "INSERT OR IGNORE INTO sync_operations (operation_id, status, content_type, body) "
                    "VALUES (?, ?, ?, ?)",
                    (operation_id, response.status_code, response.content_type or "application/json", body),
                )
            connection.commit()
        if "/api/" in path:
            connection = _database()
            latest = connection.execute("SELECT COALESCE(MAX(revision), 0) FROM changes").fetchone()[0]
            response.headers["X-Hub-Revision"] = str(latest)
        return response


def _valid_payload(value: object) -> bool:
    return (
        isinstance(value, dict)
        and value.get("version") == 1
        and isinstance(value.get("car"), dict)
        and isinstance(value.get("expenses"), list)
        and isinstance(value.get("reminders"), list)
    )


def create_blueprint() -> Blueprint:
    bp = Blueprint("offline_sync", __name__)
    harden(bp, CSP, max_body=FUAD_STATE_LIMIT, require_origin=True, no_store_everywhere=True)

    @bp.get("/api/offline/fuad")
    def get_fuad_snapshot():
        with _database() as connection:
            row = connection.execute(
                "SELECT revision, payload FROM fuad_snapshot WHERE id=1"
            ).fetchone()
        if row is None:
            return jsonify(payload=None, revision=0)
        return jsonify(payload=json.loads(row["payload"]), revision=row["revision"])

    @bp.put("/api/offline/fuad")
    def put_fuad_snapshot():
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or not _valid_payload(data.get("payload")):
            return jsonify(error="Send a valid MyFuad version 1 backup."), 400
        expected = data.get("expected_revision")
        if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
            return jsonify(error="Send the snapshot revision you last synced."), 400

        payload = json.dumps(data["payload"], ensure_ascii=False, separators=(",", ":"))
        with _database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT revision, payload FROM fuad_snapshot WHERE id=1"
            ).fetchone()
            revision = row["revision"] if row else 0
            if expected != revision:
                current = json.loads(row["payload"]) if row else None
                return jsonify(
                    error="MyFuad changed on the laptop since the last sync.",
                    payload=current,
                    revision=revision,
                ), 409
            revision += 1
            connection.execute(
                "INSERT INTO fuad_snapshot (id, revision, payload) VALUES (1, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, payload=excluded.payload",
                (revision, payload),
            )
            connection.commit()
        return jsonify(payload=data["payload"], revision=revision)

    return bp
