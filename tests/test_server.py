import stat

from core import ACTIVITIES_PREFIX, ROOT
from main import create_app
from tests.helpers import HOST, TempDirectoryCase, fake_credential, sign_in

STRAVA = ACTIVITIES_PREFIX
SECRET = fake_credential("client")  # fresh each run; no secret-looking literal in the source


class ServerTests(TempDirectoryCase):
    """Routing, per-app limits and headers, checked while signed in as the owner (who has every app)."""

    def setUp(self) -> None:
        super().setUp()
        self.data = self.root / "data"
        self.client = create_app(self.data, massive_key="").test_client()
        self.assertEqual(sign_in(self.client).status_code, 200)

    def get(self, path: str, **kwargs):
        return self.client.get(path, base_url=HOST, **kwargs)

    def test_every_app_and_its_assets_are_served_under_its_own_prefix(self) -> None:
        for path in (
            "/", "/static/app.js", "/roam/", "/roam/static/app.js", "/roam/static/flights.html",
            "/roam/api/flights.tsv", "/runs/", "/runs/static/app.js", "/runs/activities/",
            "/runs/activities/static/app.js", "/fitness/", "/fitness/static/app.js", "/fuad/", "/fuad/app.js",
            "/fuad/car-scene.js", "/fuad/styles.css", "/trading/", "/trading/static/app.js",
            "/shared/hub-link.css", "/shared/app-tabs.css", "/shared/data/countries.geojson",
        ):
            with self.subTest(path=path):
                response = self.get(path)
                self.assertEqual(response.status_code, 200)
                response.close()
        response = self.get("/fuad/car-scene.js")
        self.assertEqual(response.mimetype, "text/javascript")
        response.close()

    def test_prefix_without_slash_redirects_and_unknown_paths_404(self) -> None:
        for prefix in ("/roam", "/runs", "/runs/activities", "/fitness", "/fuad", "/trading"):
            response = self.get(prefix)
            self.assertEqual(response.status_code, 308, prefix)
            self.assertTrue(response.location.endswith(prefix + "/"))
        self.assertEqual(self.get("/nope").status_code, 404)
        self.assertEqual(self.get("/roam/nope").status_code, 404)

    def test_pages_only_use_relative_links_so_they_work_under_a_prefix(self) -> None:
        for app in ("roam", "runs", "activities", "fitness", "trading", "fuad"):
            html = (ROOT / app / "static" / "index.html").read_text(encoding="utf-8")
            for attribute in ('href="/static', 'src="/static', "fetch(\"/", "fetch('/"):
                self.assertNotIn(attribute, html, f"{app}: {attribute}")
        scripts = ("roam", "runs", "activities", "fitness", "trading")
        for script in (f"{name}/static/app.js" for name in scripts):
            source = (ROOT / script).read_text(encoding="utf-8")
            for forbidden in ('api("/', 'api(`/', 'api(id ? `/', 'fetch("/api', 'fetch(`/api'):
                self.assertNotIn(forbidden, source, f"{script}: {forbidden}")

    def test_the_users_own_data_lives_in_their_own_folder(self) -> None:
        trip = {"country_id": "ITA", "title": "Rome", "start_date": "2026-06-01", "end_date": "2026-06-02"}
        self.assertEqual(self.client.post("/roam/api/trips", json=trip, base_url=HOST).status_code, 201)
        self.assertEqual(len(self.get("/roam/api/bootstrap").get_json()["trips"]), 1)
        self.get("/runs/api/races")
        self.get(f"{STRAVA}/api/status")
        self.get("/fitness/api/workouts")
        folder = self.data / "users" / "owner"
        self.assertEqual(sorted(path.name for path in folder.glob("*.sqlite3")),
                         [
                             "activities.sqlite3", "fitness.sqlite3", "offline-sync.sqlite3",
                             "roam.sqlite3", "runs.sqlite3",
                         ])
        # An API of one app is not reachable through another app's prefix.
        self.assertEqual(self.get("/runs/api/bootstrap").status_code, 404)
        self.assertEqual(self.get("/roam/api/races").status_code, 404)

    def test_a_new_users_runs_are_not_seeded_with_someone_elses_races(self) -> None:
        self.assertEqual(self.get("/runs/api/races").get_json()["races"], [])

    def test_each_app_keeps_its_own_request_size_limit(self) -> None:
        post = lambda path, size, **headers: self.client.post(  # noqa: E731
            path, json={"notes": "x" * size}, base_url=HOST, headers=headers).status_code
        self.assertNotEqual(post("/roam/api/trips", 20_000), 413)
        self.assertEqual(post("/roam/api/trips", 70_000), 413)
        self.assertNotEqual(post("/runs/api/races", 4_000), 413)
        self.assertEqual(post("/runs/api/races", 20_000), 413)
        self.assertEqual(post("/fitness/api/workouts", 9_000), 413)
        self.assertEqual(post(f"{STRAVA}/api/setup", 9_000, Origin=HOST), 413)

    def test_security_headers_are_per_app(self) -> None:
        roam, runs = self.get("/roam/"), self.get("/runs/")
        self.addCleanup(roam.close)
        self.addCleanup(runs.close)
        self.assertIn("'unsafe-inline'", roam.headers["Content-Security-Policy"])
        self.assertNotIn("'unsafe-inline'", runs.headers["Content-Security-Policy"])
        home = self.get("/api/apps")
        self.assertEqual(home.headers["Cache-Control"], "no-store")
        self.assertIn("frame-ancestors 'none'", home.headers["Content-Security-Policy"])
        self.assertEqual(self.get(f"{STRAVA}/api/status").headers["Cache-Control"], "no-store")
        self.assertEqual(self.get("/roam/api/bootstrap").headers["Cache-Control"], "no-store")

    def test_cross_origin_writes_and_foreign_hosts_are_refused(self) -> None:
        trip = {"country_id": "ITA", "title": "Rome", "start_date": "2026-06-01", "end_date": "2026-06-02"}
        evil = {"Origin": "https://evil.example"}
        self.assertEqual(self.client.post("/roam/api/trips", json=trip, base_url=HOST, headers=evil).status_code, 403)
        self.assertEqual(self.client.post(f"{STRAVA}/api/setup", json={}, base_url=HOST).status_code, 403)
        self.assertEqual(self.client.get("/", base_url="http://evil.example").status_code, 400)
        self.assertEqual(self.client.get("/roam/", base_url="http://evil.example").status_code, 400)

    def test_strava_callback_follows_the_address_you_use_and_keeps_cookie_private(self) -> None:
        origin = {"Origin": HOST}
        self.client.post(f"{STRAVA}/api/setup", json={"client_id": "1", "client_secret": SECRET},
                         base_url=HOST, headers=origin)
        response = self.client.post(f"{STRAVA}/api/connect", json={}, base_url=HOST, headers=origin)
        self.assertEqual(response.status_code, 200)
        self.assertIn("redirect_uri=http%3A%2F%2F127.0.0.1%3A5173%2Fruns%2Factivities%2Foauth%2Fcallback", response.get_json()["url"])
        cookie = response.headers["Set-Cookie"]
        self.assertTrue(cookie.startswith("hub_session="))
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)
        status = self.get(f"{STRAVA}/api/status").get_json()
        self.assertEqual(status["callback_url"], f"{HOST}{STRAVA}/oauth/callback")

    def test_strava_setup_does_not_sign_you_out_of_the_hub(self) -> None:
        origin = {"Origin": HOST}
        self.client.post(f"{STRAVA}/api/setup", json={"client_id": "1", "client_secret": SECRET},
                         base_url=HOST, headers=origin)
        self.client.post(f"{STRAVA}/api/connect", json={}, base_url=HOST, headers=origin)
        self.client.post(f"{STRAVA}/api/disconnect", json={"forget_only": True}, base_url=HOST, headers=origin)
        self.assertEqual(self.get("/api/me").status_code, 200)

    def test_localhost_visitors_of_the_strava_tab_are_sent_to_127_0_0_1(self) -> None:
        localhost = "http://localhost:5173"
        self.assertEqual(sign_in(self.client, host=localhost).status_code, 200)
        response = self.client.get(f"{STRAVA}/", base_url=localhost)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.location, f"http://127.0.0.1:5173{STRAVA}/")

    def test_the_old_activities_address_leads_to_the_activities_tab(self) -> None:
        response = self.get("/activities/")
        self.assertEqual((response.status_code, response.location), (301, f"{STRAVA}/"))

    def test_secret_key_is_created_once_and_private(self) -> None:
        secret = self.data / "secret.key"
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o600)
        first = secret.read_text()
        create_app(self.data, massive_key="")
        self.assertEqual(secret.read_text(), first)

    def test_trading_page_reports_whether_the_server_has_a_key(self) -> None:
        self.assertFalse(self.get("/trading/api/config").get_json()["server_key"])
        keyed = create_app(self.root / "other", massive_key="abc").test_client()
        sign_in(keyed)
        self.assertTrue(keyed.get("/trading/api/config", base_url=HOST).get_json()["server_key"])


if __name__ == "__main__":
    import unittest
    unittest.main()
