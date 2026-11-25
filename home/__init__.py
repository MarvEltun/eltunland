"""The home page at / and the sign-in page at /login."""

from pathlib import Path

from flask import Blueprint, current_app, g, jsonify, redirect, session

from accounts import AccountStore

from .registry import home_for


def create_blueprint(store: AccountStore) -> Blueprint:
    bp = Blueprint("home", __name__, static_folder="static", static_url_path="/static")

    @bp.after_request
    def headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @bp.get("/")
    def index():
        return bp.send_static_file("index.html")

    @bp.get("/login")
    def login_page():
        if store.get(session.get("uid")):
            return redirect("/")
        return bp.send_static_file("login.html")

    @bp.get("/api/apps")
    def list_apps():
        user_dir = Path(current_app.config["DATA_DIR"]) / "users" / g.user.username
        return jsonify(home_for(g.user, user_dir))

    return bp
