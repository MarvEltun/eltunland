"""One server for all my apps, behind a PIN sign-in.

Setup: python3 -m venv .venv
       .venv/bin/python -m pip install -r requirements.txt
Run:   .venv/bin/python main.py
Laptop: http://127.0.0.1:5173
iPhone: https://<computer-name>.local:5174/setup/ios
Forgot a PIN?  .venv/bin/python main.py reset-pin <username>
Everything personal lives in data/ (git-ignored); see data.example/ for the file formats.
"""

import ipaddress
import os
import socket
import sys
import threading
from pathlib import Path

from flask import Flask, redirect
from werkzeug.serving import make_server

import accounts
import activities
import fitness
import fuad
import home
import roam
import runs
import trading
from core import (
    ACTIVITIES_PREFIX,
    DATA_DIR,
    PREFIXES,
    PrivateRequestHandler,
    base_app,
    load_secret,
    shared_blueprint,
    user_file,
)
from offline_sync import create_blueprint as create_offline_sync_blueprint, install_change_tracking
from pwa import ensure_tls_certificate, install_pwa


NON_LAN_IPV4 = (ipaddress.ip_network("192.0.0.0/24"), ipaddress.ip_network("100.64.0.0/10"))


def _routed_address(family: int, target: str) -> str:
    probe = socket.socket(family, socket.SOCK_DGRAM)
    try:
        probe.connect((target, 80))
        return probe.getsockname()[0]
    except OSError:
        return ""
    finally:
        probe.close()


def _is_lan_ipv4(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if ip.is_loopback or ip.is_unspecified or ip.is_link_local:
        return False
    return not any(ip in network for network in NON_LAN_IPV4)


def lan_bind_address() -> str:
    """Choose the default-route interface instead of exposing Hub on every interface.

    IPv6-only networks (some mobile hotspots) only offer a translation address such as
    192.0.0.2, which other devices cannot reach; there Hub listens on IPv6 instead.
    """
    address = _routed_address(socket.AF_INET, "192.0.2.1")
    if _is_lan_ipv4(address):
        return address
    if socket.has_ipv6 and _routed_address(socket.AF_INET6, "2001:db8::1"):
        return "::"
    return "127.0.0.1"


def create_app(data_dir: Path | None = None, massive_key: str | None = None, people=None) -> Flask:
    """Mount every app. massive_key overrides the MASSIVE_API_KEY environment variable;
    `people` overrides the accounts in data/accounts.json."""
    data_dir = Path(data_dir or DATA_DIR)
    data_dir.mkdir(parents=True, exist_ok=True)
    store = accounts.AccountStore(data_dir / "users.sqlite3", people or accounts.load_accounts(data_dir / "accounts.json"))
    for person in store.accounts.values():
        (data_dir / "users" / person.username).mkdir(parents=True, exist_ok=True)

    app = base_app(load_secret(data_dir), data_dir)
    hostname = (os.environ.get("HUB_HOSTNAME") or socket.gethostname()).strip().lower().rstrip(".")
    if hostname and "." not in hostname:
        hostname += ".local"
    https_port = int(os.environ.get("HUB_HTTPS_PORT", "5174"))
    app.config.update(
        HUB_HOSTNAME=hostname,
        HUB_PORT=https_port,
        HUB_TLS_CERT=str(data_dir / "tls" / "hub.crt"),
        HUB_TLS_CA_CERT=str(data_dir / "tls" / "hub-ca.crt"),
    )
    accounts.install_gate(app, store)
    install_change_tracking(app)
    app.register_blueprint(shared_blueprint())
    app.register_blueprint(create_offline_sync_blueprint())
    app.register_blueprint(home.create_blueprint(store))
    app.register_blueprint(accounts.create_blueprint(store))
    # Each of these opens the signed-in person's own database or file.
    app.register_blueprint(
        roam.create_blueprint(user_file("roam.sqlite3"), flights=user_file("flights.tsv")), url_prefix=PREFIXES["roam"]
    )
    app.register_blueprint(
        runs.create_blueprint(user_file("runs.sqlite3"), strava_source=user_file("activities.sqlite3")),
        url_prefix=PREFIXES["runs"],
    )
    app.register_blueprint(
        activities.create_blueprint(user_file("activities.sqlite3")), url_prefix=ACTIVITIES_PREFIX
    )
    app.add_url_rule("/activities/", "old_activities_address", lambda: redirect(ACTIVITIES_PREFIX + "/", 301))
    app.register_blueprint(fitness.create_blueprint(user_file("fitness.sqlite3")), url_prefix=PREFIXES["fitness"])
    app.register_blueprint(fuad.create_blueprint(user_file("fuad-seed.json")), url_prefix=PREFIXES["fuad"])
    app.register_blueprint(trading.create_blueprint(massive_key), url_prefix=PREFIXES["trading"])
    install_pwa(app)
    return app


def reset_pin(username: str, data_dir: Path = DATA_DIR) -> int:
    store = accounts.AccountStore(data_dir / "users.sqlite3", accounts.load_accounts(data_dir / "accounts.json"))
    if store.get(username) is None:
        print(f"No such user: {username}. Users: {', '.join(store.accounts)}")
        return 1
    store.clear_pin(username)
    print(f"{store.accounts[username].name}'s PIN is cleared. Choose a new one at the next sign-in.")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "reset-pin":
        return reset_pin(argv[2].lower())
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    app = create_app()
    http_port = int(os.environ.get("HUB_PORT", "5173"))
    https_port = app.config["HUB_PORT"]
    if http_port == https_port:
        raise SystemExit("HUB_PORT and HUB_HTTPS_PORT must use different ports.")
    bind_host = os.environ.get("HUB_BIND", lan_bind_address())
    certificate = ensure_tls_certificate(DATA_DIR, app.config["HUB_HOSTNAME"])
    app.config["HUB_TLS_CERT"] = certificate[0]

    local_server = make_server(
        "127.0.0.1",
        http_port,
        app,
        threaded=True,
        request_handler=PrivateRequestHandler,
    )
    local_thread = threading.Thread(
        target=local_server.serve_forever,
        name="hub-local-http",
        daemon=True,
    )
    local_thread.start()
    print(f"Hub on laptop: http://127.0.0.1:{http_port}")
    print(f"Hub for iPhone: https://{app.config['HUB_HOSTNAME']}:{https_port}/setup/ios")
    if bind_host == "::":
        print("No usable IPv4 network found; listening on IPv6 (all interfaces). Use the .local name above.")
    server = make_server(
        bind_host,
        https_port,
        app,
        threaded=True,
        request_handler=PrivateRequestHandler,
        ssl_context=certificate,
    )
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
