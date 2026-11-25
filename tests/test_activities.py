import io
import os
import sqlite3
import ssl
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

from activities import create_app
from activities.strava import (
    PAGE_SIZE,
    StravaError,
    http_json,
    public_activity,
    rate_limits,
    tokens_from_response,
)
from tests.helpers import fake_credential

BASE_URL = "http://127.0.0.1:8503"
CALLBACK = f"{BASE_URL}/oauth/callback"
# Made up fresh on every run; nothing credential-shaped is written in this file.
CLIENT_SECRET = fake_credential("client")
OTHER_SECRET = fake_credential("other")
IMPORTED = fake_credential("imported")
ACCESS = fake_credential("access")
REFRESH = fake_credential("refresh")
NEW_ACCESS = fake_credential("access-new")
NEW_REFRESH = fake_credential("refresh-new")
ENV_SECRET = fake_credential("env-client")
ENV_REFRESH = fake_credential("env-refresh")
BEARER = fake_credential("bearer")


def activity(identifier=10, **changes):
    return {
        "id": identifier, "athlete": {"id": 7}, "name": "Synthetic morning run",
        "sport_type": "Run", "start_date": "2026-03-01T22:30:00Z",
        "start_date_local": "2026-03-02T00:30:00Z", "distance": 5200,
        "moving_time": 1800, "elapsed_time": 2000, "total_elevation_gain": 53,
        "average_speed": 2.9, "map": {"summary_polyline": "_p~iF~ps|U_ulLnnqC_mqNvxq`@"},
        "comments": [{"athlete": {"id": 999}}], **changes,
    }


class FakeStrava:
    def __init__(self):
        self.calls = []
        self.handler = None

    def __call__(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if self.handler:
            return self.handler(method, url, kwargs)
        if url.endswith("/oauth/token"):
            return {
                "access_token": ACCESS, "refresh_token": REFRESH,
                "expires_at": int(time.time()) + 21600, "athlete": {"id": 7},
            }, {}
        if url.endswith("/oauth/deauthorize"):
            return {}, {}
        if url.endswith("/athlete"):
            return {"id": 7, "firstname": "Synthetic", "lastname": "Athlete", "email": "omit@example.invalid"}, {}
        if "/athlete/activities?" in url:
            return [activity()], {"read_limit": [100, 1000], "read_usage": [1, 1]}
        if "/activities/" in url:
            return activity(description="A test, not a real activity.", gear={"name": "Test shoes"}), {}
        raise AssertionError(f"Unexpected URL: {url}")


class ActivityAppTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="myactivities-tests-", dir=os.environ.get("TMPDIR"))
        self.path = Path(self.directory.name) / "connection.sqlite3"
        self.remote = FakeStrava()
        self.app = create_app(str(self.path), self.remote, {})
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def tearDown(self):
        self.directory.cleanup()

    def get(self, url):
        return self.client.get(url, base_url=BASE_URL)

    def post(self, url, data):
        return self.client.post(url, json=data, content_type="application/json", base_url=BASE_URL, headers={"Origin": BASE_URL})

    def setup_credentials(self):
        response = self.post("/api/setup", {"client_id": "12345", "client_secret": CLIENT_SECRET})
        self.assertEqual(response.status_code, 200)

    def begin(self):
        self.setup_credentials()
        response = self.post("/api/connect", {})
        self.assertEqual(response.status_code, 200)
        return parse_qs(urlsplit(response.get_json()["url"]).query)["state"][0]

    def authorize(self):
        state = self.begin()
        response = self.get("/oauth/callback?" + f"state={state}&code={fake_credential('code')}&scope=read,activity:read_all")
        self.assertEqual(response.location, "/?connection=success")

    def db_rows(self, sql):
        with closing(sqlite3.connect(self.path)) as connection:
            return connection.execute(sql).fetchall()

    def test_setup_is_private_and_requires_same_origin_json(self):
        self.assertEqual(self.get("/api/status").get_json()["configured"], False)
        self.assertEqual(self.client.post("/api/setup", json={}, base_url=BASE_URL).status_code, 403)
        self.assertEqual(self.client.post("/api/setup", data="{}", base_url=BASE_URL, headers={"Origin": BASE_URL}).status_code, 415)
        for data in (None, [], {"client_id": "x", "client_secret": OTHER_SECRET}, {"client_id": "１２", "client_secret": OTHER_SECRET}, {"client_id": "1", "client_secret": ""}):
            self.assertEqual(self.post("/api/setup", data).status_code, 400)
        self.setup_credentials()
        status = self.get("/api/status")
        self.assertNotIn(CLIENT_SECRET, status.text)
        self.assertNotIn("client_secret", status.text)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.get("/data/connection.sqlite3").status_code, 404)
        self.assertEqual(self.get("/api/activities").status_code, 401)

    def test_oauth_redirect_requests_only_read_permissions_and_fixed_callback(self):
        state = self.begin()
        response = self.post("/api/connect", {})
        query = parse_qs(urlsplit(response.get_json()["url"]).query)
        self.assertEqual(query["scope"], ["read,activity:read_all"])
        self.assertEqual(query["redirect_uri"], [CALLBACK])
        self.assertNotEqual(query["state"], [state])
        self.assertNotIn(CLIENT_SECRET, response.text)

    def test_imported_token_connects_without_client_credentials_and_can_be_revoked(self):
        response = self.post("/api/token", {"access_token": IMPORTED})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(IMPORTED, response.text)
        self.assertNotIn("Synthetic", response.text)
        self.assertTrue(self.get("/api/status").get_json()["token_only"])
        self.assertFalse(self.get("/api/status").get_json()["configured"])
        self.assertEqual(len(self.remote.calls), 2)
        self.assertTrue(self.remote.calls[1][1].endswith("athlete/activities?page=1&per_page=1"))
        restarted = create_app(str(self.path), self.remote).test_client()
        self.assertTrue(restarted.get("/api/status", base_url=BASE_URL).get_json()["connected"])
        self.assertEqual(self.get("/api/activities").status_code, 200)
        self.assertNotIn(b"Synthetic morning run", self.path.read_bytes())
        self.assertNotIn(b"Synthetic", self.path.read_bytes())
        response = self.post("/api/disconnect", {})
        self.assertTrue(response.get_json()["revoked"])
        self.assertEqual(self.remote.calls[-1][2]["data"]["access_token"], IMPORTED)
        self.assertEqual(self.db_rows("SELECT * FROM credentials"), [])

    def test_token_import_rejects_bad_input_and_protects_existing_connection(self):
        self.assertEqual(self.client.post("/api/token", json={}, base_url=BASE_URL).status_code, 403)
        for data in (None, [], {}, {"access_token": 123}, {"access_token": IMPORTED[:4]},
                     {"access_token": f"{IMPORTED} x"}, {"access_token": f"{IMPORTED}\nx"}):
            with self.subTest(data=data):
                self.assertEqual(self.post("/api/token", data).status_code, 400)
        self.assertEqual(self.remote.calls, [])
        self.authorize()
        self.remote.calls.clear()
        self.assertEqual(self.post("/api/token", {"access_token": IMPORTED}).status_code, 409)
        self.assertEqual(self.remote.calls, [])
        self.assertFalse(self.get("/api/status").get_json()["token_only"])
        self.assertEqual(self.db_rows("SELECT access_token FROM credentials"), [(ACCESS,)])

    def test_token_import_checks_activity_permission_and_never_saves_rejected_tokens(self):
        for status in (401, 403, 429):
            def handler(method, url, args, status=status):
                if url.endswith("/athlete"):
                    return {"id": 7}, {}
                raise StravaError("Rejected", status)
            self.remote.handler = handler
            with self.subTest(status=status):
                response = self.post("/api/token", {"access_token": IMPORTED})
                self.assertEqual(response.status_code, status)
                if status in (401, 403):
                    self.assertIn("activity:read", response.get_json()["error"])
                self.assertFalse(self.get("/api/status").get_json()["connected"])
                self.assertEqual(self.db_rows("SELECT * FROM credentials"), [])
        for athlete, activities in (({}, []), ({"id": True}, []), ({"id": 7}, {})):
            self.remote.handler = lambda method, url, args, athlete=athlete, activities=activities: (
                athlete if url.endswith("/athlete") else activities, {})
            self.assertEqual(self.post("/api/token", {"access_token": IMPORTED}).status_code, 502)
            self.assertEqual(self.db_rows("SELECT * FROM credentials"), [])

    def test_imported_token_expiry_forgets_it_without_attempting_refresh(self):
        self.assertEqual(self.post("/api/token", {"access_token": IMPORTED}).status_code, 200)
        self.remote.calls.clear()
        self.remote.handler = MagicMock(side_effect=StravaError("Expired", 401))
        response = self.get("/api/activities")
        self.assertEqual(response.status_code, 401)
        self.assertIn("imported access token expired or was revoked", response.get_json()["error"])
        self.assertEqual(len(self.remote.calls), 1)
        self.assertFalse(self.get("/api/status").get_json()["connected"])
        self.assertEqual(self.db_rows("SELECT * FROM credentials"), [])
        self.assertNotIn(IMPORTED.encode(), self.path.read_bytes())

    def test_oauth_rejects_mismatched_expired_replayed_and_missing_permissions(self):
        state = self.begin()
        self.assertEqual(self.get("/oauth/callback?state=wrong&code=x").location, "/?connection=invalid_state")
        self.assertEqual(len(self.remote.calls), 0)
        self.assertEqual(self.get(f"/oauth/callback?state={state}&code=x").location, "/?connection=invalid_state")
        state = parse_qs(urlsplit(self.post("/api/connect", {}).get_json()["url"]).query)["state"][0]
        with self.client.session_transaction(base_url=BASE_URL) as session:
            session["oauth_started"] = time.time() - 601
        self.assertEqual(self.get(f"/oauth/callback?state={state}").location, "/?connection=invalid_state")
        state = self.begin()
        self.assertEqual(self.get(f"/oauth/callback?state={state}&code=x&scope=read").location, "/?connection=missing_permissions")
        self.assertEqual(self.remote.calls, [])

    def test_denial_and_exchange_failure_do_not_connect(self):
        state = self.begin()
        self.assertEqual(self.get(f"/oauth/callback?state={state}&error=access_denied").location, "/?connection=denied")
        state = self.begin()
        def fail(*args):
            raise StravaError("Rejected", 400)
        self.remote.handler = fail
        self.assertEqual(self.get(f"/oauth/callback?state={state}&code=x&scope=read,activity:read_all").location, "/?connection=exchange_failed")
        self.assertFalse(self.get("/api/status").get_json()["connected"])

    def test_live_profile_activities_and_detail_never_persist_responses(self):
        self.authorize()
        profile = self.get("/api/profile").get_json()["profile"]
        self.assertEqual(profile["firstname"], "Synthetic")
        self.assertNotIn("email", profile)
        response = self.get("/api/activities?page=2")
        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertEqual(result["page"], 2)
        self.assertFalse(result["has_more"])
        self.assertNotIn("comments", result["activities"][0])
        self.assertIn(f"page=2&per_page={PAGE_SIZE}", self.remote.calls[-1][1])
        detail = self.get("/api/activities/10").get_json()["activity"]
        self.assertEqual(detail["gear"], "Test shoes")
        self.assertTrue(detail["polyline"])
        for key in ("access_token", "refresh_token"):
            self.assertNotIn(key, response.text)
        tables = self.db_rows("SELECT name FROM sqlite_master WHERE type='table'")
        self.assertEqual({t[0] for t in tables}, {"settings", "credentials", "activities"})
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM activities"), [(0,)])  # browsing alone saves nothing
        self.assertNotIn(b"Synthetic morning run", self.path.read_bytes())
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        for page in ("0", "-1", "abc", "100001"):
            self.assertEqual(self.get(f"/api/activities?page={page}").status_code, 400)

    def test_oauth_reports_tls_and_connectivity_failures_without_blaming_credentials(self):
        for error, notice in (
            (StravaError("Certificate failed", 503, code="tls_failed"), "tls_failed"),
            (StravaError("Offline", 503), "unavailable"),
        ):
            with self.subTest(notice=notice):
                state = self.begin()
                with patch.object(self.remote, "handler", MagicMock(side_effect=error)):
                    response = self.get(f"/oauth/callback?state={state}&code=x&scope=read,activity:read_all")
                self.assertEqual(response.location, f"/?connection={notice}")
                self.assertFalse(self.get("/api/status").get_json()["connected"])
                self.assertEqual(self.db_rows("SELECT * FROM credentials"), [])

    def test_full_page_indicates_next_page_and_empty_page_ends_pagination(self):
        self.authorize()
        self.remote.handler = lambda method, url, args: ([activity(i + 1) for i in range(PAGE_SIZE)] if "page=1&" in url else [], {})
        self.assertTrue(self.get("/api/activities?page=1").get_json()["has_more"])
        result = self.get("/api/activities?page=2").get_json()
        self.assertEqual(result["activities"], [])
        self.assertFalse(result["has_more"])

    def test_expired_tokens_rotate_and_persist_new_refresh_token(self):
        self.authorize()
        with closing(sqlite3.connect(self.path)) as connection:
            connection.execute("UPDATE credentials SET expires_at=1")
            connection.commit()
        def handler(method, url, args):
            if url.endswith("/oauth/token"):
                self.assertEqual(args["data"]["refresh_token"], REFRESH)
                return {"access_token": NEW_ACCESS, "refresh_token": NEW_REFRESH, "expires_at": int(time.time()) + 21600}, {}
            self.assertEqual(args["token"], NEW_ACCESS)
            return {"id": 7}, {}
        self.remote.handler = handler
        self.assertEqual(self.get("/api/profile").status_code, 200)
        self.assertEqual(self.db_rows("SELECT refresh_token, athlete_id FROM credentials"), [(NEW_REFRESH, 7)])
        self.assertTrue(create_app(str(self.path), self.remote).test_client().get("/api/status", base_url=BASE_URL).get_json()["connected"])

    def test_401_refresh_retries_once_and_repeated_401_forgets_connection(self):
        self.authorize()
        def handler(method, url, args):
            if url.endswith("/oauth/token"):
                return {"access_token": NEW_ACCESS, "refresh_token": NEW_REFRESH, "expires_at": int(time.time()) + 21600}, {}
            raise StravaError("Revoked", 401)
        self.remote.handler = handler
        self.remote.calls.clear()
        self.assertEqual(self.get("/api/profile").status_code, 401)
        self.assertEqual(len(self.remote.calls), 3)
        self.assertFalse(self.get("/api/status").get_json()["connected"])
        self.assertEqual(self.db_rows("SELECT * FROM credentials"), [])

    def test_invalid_refresh_is_reported_as_reconnect_required(self):
        self.authorize()
        with closing(sqlite3.connect(self.path)) as connection:
            connection.execute("UPDATE credentials SET expires_at=1")
            connection.commit()
        def handler(*args):
            raise StravaError("Invalid refresh token", 400)
        self.remote.handler = handler
        response = self.get("/api/profile")
        self.assertEqual(response.status_code, 401)
        self.assertIn("reconnect", response.get_json()["error"].lower())

    def test_rate_limit_and_other_athletes_are_not_success_shaped(self):
        self.authorize()
        def limited(*args):
            raise StravaError("Rate limited", 429, {"read_usage": [100, 100]})
        self.remote.handler = limited
        response = self.get("/api/activities")
        self.assertEqual(response.status_code, 429)
        self.assertNotIn("activities", response.get_json())
        self.assertEqual(response.get_json()["rate"]["read_usage"], [100, 100])
        self.remote.handler = lambda *args: (activity(athlete={"id": 999}), {})
        self.assertEqual(self.get("/api/activities/10").status_code, 403)

    def test_disconnect_revokes_then_deletes_all_local_api_credentials(self):
        self.authorize()
        self.post("/api/sync", {})
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM activities"), [(1,)])
        self.assertEqual(self.post("/api/setup", {"client_id": "1", "client_secret": OTHER_SECRET}).status_code, 409)
        response = self.post("/api/disconnect", {})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["revoked"])
        self.assertIn("deleted", response.get_json()["message"])
        self.assertEqual(self.db_rows("SELECT * FROM credentials"), [])
        self.assertEqual(self.db_rows("SELECT key FROM settings"), [])
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM activities"), [(0,)])
        self.assertFalse(self.get("/api/status").get_json()["configured"])

    def test_sync_saves_only_a_summary_of_each_activity(self):
        self.authorize()
        result = self.post("/api/sync", {})
        self.assertEqual(result.status_code, 200)
        self.assertEqual((result.get_json()["fetched"], result.get_json()["complete"]), (1, True))
        self.assertEqual(self.db_rows("SELECT id, sport_type, day, distance_m, moving_s, elevation_m FROM activities"),
                         [(10, "Run", "2026-03-02", 5200.0, 1800, 53.0)])
        self.assertNotIn(b"_p~iF", self.path.read_bytes())  # no route
        cache = self.get("/api/status").get_json()["cache"]
        self.assertEqual(cache["count"], 1)
        self.assertGreater(cache["last_synced"], 0)
        self.assertIn("after=0", self.remote.calls[-1][1])
        # A second sync asks only for recent activities, with a few days of overlap, and updates in place.
        self.remote.handler = lambda *args: ([activity(name="Renamed", distance=6000)], {})
        self.post("/api/sync", {})
        self.assertIn("after=1772145000", self.remote.calls[-1][1])
        self.assertEqual(self.db_rows("SELECT name, distance_m FROM activities"), [("Renamed", 6000.0)])

    def test_sync_pages_until_a_short_page_and_full_sync_drops_deleted_activities(self):
        self.authorize()
        pages = []

        def handler(method, url, kwargs):
            if "/athlete/activities?" not in url:
                return FakeStrava()(method, url, **kwargs)
            page = int(parse_qs(urlsplit(url).query)["page"][0])
            pages.append(page)
            return ([activity(page * 1000 + n) for n in range(200)] if page == 1 else [activity(2001)]), {}

        self.remote.handler = handler
        self.assertEqual(self.post("/api/sync", {}).get_json()["fetched"], 201)
        self.assertEqual(pages, [1, 2])
        self.remote.handler = lambda *args: ([activity(1000)], {})
        self.post("/api/sync", {"full": True})
        self.assertEqual(self.db_rows("SELECT id FROM activities"), [(1000,)])

    def test_sync_skips_unusable_items_and_other_athletes_and_checks_the_request(self):
        self.authorize()
        self.remote.handler = lambda *args: ([
            activity(11, athlete={"id": 999}), activity(12, start_date="nope"), "junk",
            activity(13, distance=-5), activity(14, moving_time=None, total_elevation_gain=None),
        ], {})
        self.assertEqual(self.post("/api/sync", {}).get_json()["fetched"], 1)
        self.assertEqual(self.db_rows("SELECT id, moving_s, elevation_m FROM activities"), [(14, 0, 0.0)])
        self.assertEqual(self.post("/api/sync", {"full": "yes"}).status_code, 400)
        self.assertEqual(self.client.post("/api/sync", json={}, base_url=BASE_URL).status_code, 403)

    def test_sync_needs_a_connection(self):
        self.assertEqual(self.post("/api/sync", {}).status_code, 401)

    def test_revocation_failure_requires_explicit_local_forget(self):
        self.authorize()
        def unavailable(*args):
            raise StravaError("Offline", 503)
        self.remote.handler = unavailable
        self.assertEqual(self.post("/api/disconnect", {}).status_code, 503)
        self.assertTrue(self.get("/api/status").get_json()["connected"])
        result = self.post("/api/disconnect", {"forget_only": True})
        self.assertFalse(result.get_json()["revoked"])
        self.assertEqual(self.db_rows("SELECT * FROM credentials"), [])

    def test_sanitization_and_invalid_token_responses(self):
        for payload in (None, {}, {"access_token": ACCESS, "refresh_token": REFRESH, "expires_at": True}):
            with self.assertRaises(StravaError):
                tokens_from_response(payload)
        with self.assertRaises(StravaError):
            public_activity({"id": 1, "athlete": {"id": 8}}, 7)
        self.assertEqual(rate_limits({"X-ReadRateLimit-Limit": "100,1000"}), {"read_limit": [100, 1000]})
        self.assertEqual(rate_limits({"X-ReadRateLimit-Limit": "bad"}), {})

    def test_strava_details_from_the_environment_connect_without_any_setup(self):
        env = {"STRAVA_CLIENT_ID": "12345", "STRAVA_CLIENT_SECRET": ENV_SECRET, "STRAVA_REFRESH_TOKEN": ENV_REFRESH}
        client = create_app(str(self.path), self.remote, env).test_client()
        get = lambda url: client.get(url, base_url=BASE_URL)  # noqa: E731
        status = get("/api/status").get_json()
        self.assertEqual((status["configured"], status["connected"], status["from_environment"]), (True, True, True))
        self.assertNotIn(ENV_SECRET, str(status))
        self.assertEqual(get("/api/profile").status_code, 200)
        exchange = next(call for call in self.remote.calls if call[1].endswith("/oauth/token"))
        self.assertEqual(exchange[2]["data"], {
            "client_id": "12345", "client_secret": ENV_SECRET,
            "grant_type": "refresh_token", "refresh_token": ENV_REFRESH,
        })
        # The rotated tokens are kept, so the environment token is only used once.
        self.assertEqual(self.db_rows("SELECT refresh_token, athlete_id FROM credentials"), [(REFRESH, 7)])
        self.assertEqual(get("/api/activities").status_code, 200)
        self.assertEqual(sum(call[1].endswith("/oauth/token") for call in self.remote.calls), 1)
        # Details set by the environment cannot be overwritten from the page.
        saved = client.post("/api/setup", json={"client_id": "1", "client_secret": CLIENT_SECRET},
                            base_url=BASE_URL, headers={"Origin": BASE_URL})
        self.assertEqual(saved.status_code, 409)

    def test_a_refused_environment_refresh_token_explains_what_to_check(self):
        def refuse(method, url, kwargs):
            raise StravaError("Strava rejected the request.", 400)
        self.remote.handler = refuse
        env = {"STRAVA_CLIENT_ID": "12345", "STRAVA_CLIENT_SECRET": ENV_SECRET, "STRAVA_REFRESH_TOKEN": BEARER}
        response = create_app(str(self.path), self.remote, env).test_client().get("/api/profile", base_url=BASE_URL)
        self.assertEqual(response.status_code, 401)
        self.assertIn("STRAVA_REFRESH_TOKEN", response.get_json()["error"])
        self.assertIn("activity:read_all", response.get_json()["error"])

    def test_environment_without_a_refresh_token_still_needs_authorization(self):
        env = {"STRAVA_CLIENT_ID": "12345", "STRAVA_CLIENT_SECRET": ENV_SECRET}
        client = create_app(str(self.path), self.remote, env).test_client()
        status = client.get("/api/status", base_url=BASE_URL).get_json()
        self.assertEqual((status["configured"], status["connected"]), (True, False))
        connect = client.post("/api/connect", json={}, base_url=BASE_URL, headers={"Origin": BASE_URL})
        self.assertEqual(connect.status_code, 200)
        self.assertIn("client_id=12345", connect.get_json()["url"])

    def test_app_assets_and_host_restrictions(self):
        for path in ("/", "/static/app.js", "/static/model.js", "/static/style.css", "/static/icon.svg"):
            response = self.get(path)
            self.assertEqual(response.status_code, 200, path)
            response.close()
        self.assertEqual(self.client.get("/", base_url="http://untrusted.invalid").status_code, 400)

    def test_transport_uses_server_side_bearer_and_form_encoding(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.headers = {"X-ReadRateLimit-Limit": "100,1000"}
        response.read.return_value = b'{"ok": true}'
        with patch("activities.strava.urlopen", return_value=response) as remote:
            data, rate = http_json("GET", "https://www.strava.com/api/v3/athlete", token=BEARER)
            req = remote.call_args.args[0]
            self.assertEqual(req.get_header("Authorization"), f"Bearer {BEARER}")
            self.assertNotIn(BEARER, req.full_url)
            self.assertTrue(data["ok"])
            self.assertEqual(rate["read_limit"], [100, 1000])
            context = remote.call_args.kwargs["context"]
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            http_json("POST", "https://www.strava.com/oauth/token", data={"client_secret": f"{CLIENT_SECRET}&x"})
            req = remote.call_args.args[0]
            self.assertEqual(req.data, f"client_secret={CLIENT_SECRET}%26x".encode())
            self.assertEqual(req.get_header("Content-type"), "application/x-www-form-urlencoded")

    def test_invalid_local_ca_bundle_fails_before_sending_credentials(self):
        bundle = Path(self.directory.name) / "ca-bundle.pem"
        bundle.write_text("not a certificate", encoding="ascii")
        with patch("activities.strava.LOCAL_CA_BUNDLE", bundle), patch.dict(os.environ, {"SSL_CERT_FILE": ""}):
            with patch("activities.strava.urlopen") as remote, self.assertRaises(StravaError) as caught:
                http_json("POST", "https://www.strava.com/oauth/token", data={"client_secret": CLIENT_SECRET})
            remote.assert_not_called()
        self.assertEqual(caught.exception.code, "tls_failed")
        self.assertIn("trusted HTTPS CA bundle", str(caught.exception))
        self.assertNotIn(CLIENT_SECRET, str(caught.exception))

    def test_a_token_without_activity_permission_is_reported_and_offers_authorization(self):
        env = {"STRAVA_CLIENT_ID": "12345", "STRAVA_CLIENT_SECRET": ENV_SECRET, "STRAVA_REFRESH_TOKEN": ENV_REFRESH}
        fake = self.remote

        def handler(method, url, kwargs):
            if "/athlete/activities" in url:
                raise StravaError("Not granted activity:read_all.", 401, code="scope_missing")
            return FakeStrava()(method, url, **kwargs)

        fake.handler = handler
        client = create_app(str(self.path), fake, env).test_client()
        self.assertEqual(client.get("/api/profile", base_url=BASE_URL).status_code, 200)
        response = client.post("/api/sync", json={}, base_url=BASE_URL, headers={"Origin": BASE_URL})
        self.assertEqual(response.status_code, 401)
        self.assertIn("activity:read_all", response.get_json()["error"])
        self.assertEqual(self.db_rows("SELECT * FROM credentials"), [])
        status = client.get("/api/status", base_url=BASE_URL).get_json()
        # The environment token is no longer used, so the page offers Authorize with Strava.
        self.assertEqual((status["configured"], status["connected"]), (True, False))
        self.assertEqual(sum(call[1].endswith("/oauth/token") for call in fake.calls), 1)
        self.assertEqual(client.get("/api/profile", base_url=BASE_URL).status_code, 401)

    def test_transport_recognises_a_missing_activity_permission(self):
        body = b'{"message":"Authorization Error","errors":[{"resource":"AccessToken","field":"activity:read_permission","code":"missing"}]}'
        error = HTTPError("https://www.strava.com/api/v3/athlete/activities", 401, "Unauthorized", {}, io.BytesIO(body))
        with patch("activities.strava.urlopen", side_effect=error), self.assertRaises(StravaError) as caught:
            http_json("GET", "https://www.strava.com/api/v3/athlete/activities")
        self.assertEqual((caught.exception.status, caught.exception.code), (401, "scope_missing"))
        self.assertNotIn("AccessToken", str(caught.exception))
        plain = HTTPError("https://www.strava.com/api/v3/athlete", 401, "Unauthorized", {}, io.BytesIO(b'{"message":"expired"}'))
        with patch("activities.strava.urlopen", side_effect=plain), self.assertRaises(StravaError) as caught:
            http_json("GET", "https://www.strava.com/api/v3/athlete")
        self.assertIsNone(caught.exception.code)

    def test_transport_surfaces_rate_limits_network_errors_and_bad_json(self):
        errors = [
            (HTTPError("https://www.strava.com/api/v3/athlete", 429, "limited", {}, io.BytesIO(b"private upstream body")), 429),
            (URLError("synthetic connectivity failure"), 503),
        ]
        for error, status in errors:
            with self.subTest(status=status), patch("activities.strava.urlopen", side_effect=error):
                with self.assertRaises(StravaError) as caught:
                    http_json("GET", "https://www.strava.com/api/v3/athlete")
                self.assertEqual(caught.exception.status, status)
                self.assertNotIn("private upstream body", str(caught.exception))
        for error in (
            URLError(ssl.SSLCertVerificationError("self-signed certificate")),
            ssl.SSLCertVerificationError("self-signed certificate"),
        ):
            with self.subTest(error=type(error).__name__), patch("activities.strava.urlopen", side_effect=error):
                with self.assertRaises(StravaError) as caught:
                    http_json("POST", "https://www.strava.com/oauth/token", data={"code": fake_credential("code")})
                self.assertEqual(caught.exception.status, 503)
                self.assertEqual(caught.exception.code, "tls_failed")
                self.assertIn("SSL_CERT_FILE", str(caught.exception))
        response = MagicMock()
        response.__enter__.return_value = response
        response.headers = {}
        response.read.return_value = b"not-json"
        with patch("activities.strava.urlopen", return_value=response), self.assertRaisesRegex(StravaError, "invalid response"):
            http_json("GET", "https://www.strava.com/api/v3/athlete")


if __name__ == "__main__":
    unittest.main()
