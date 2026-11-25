"""MyFuad: a private car dashboard. Its garage lives in your browser; only the optional first-run
starting data (your car's plate and past expenses) comes from a file in your data folder."""

import json
from collections.abc import Callable
from pathlib import Path

from flask import Blueprint, jsonify


def create_blueprint(seed_source: str | Path | Callable[[], Path] | None = None) -> Blueprint:
    """`seed_source` is a JSON file, or a function giving the signed-in person's file:
    {"car": {"plate": "AB 123"}, "expenses": [{"date", "category", "amount", ...}]}."""
    # Assets sit at the app's root (/fuad/app.js) so the page's relative imports keep working.
    bp = Blueprint("fuad", __name__, static_folder="static", static_url_path="")

    @bp.get("/")
    def index():
        return bp.send_static_file("index.html")

    @bp.get("/api/seed")
    def seed():
        path = Path(seed_source() if callable(seed_source) else seed_source) if seed_source else None
        data = {}
        if path and path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                data = loaded if isinstance(loaded, dict) else {}
            except (OSError, ValueError):
                data = {}
        response = jsonify(data)
        response.headers["Cache-Control"] = "no-store"
        return response

    @bp.after_request
    def headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    return bp
