import json
import sqlite3
import unittest
from contextlib import closing
from pathlib import Path

import accounts
import main
from accounts import Account, AccountStore, load_accounts, safe_next
from tests.helpers import HOST, TempDirectoryCase, sign_in

PAGE = {"Accept": "text/html,application/xhtml+xml"}
# What Chrome really sends; Werkzeug's `best` picks application/signed-exchange for it.
CHROME_PAGE = {"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,"
                         "application/signed-exchange;v=b3;q=0.7"}
ORIGIN = {"Origin": HOST}
# A second, limited account exercises access control and data separation.
GUEST = Account("guest", "Guest", ("roam", "fitness"))
PEOPLE = (*accounts.DEFAULT_ACCOUNTS, GUEST)


class AccountTests(TempDirectoryCase):
    def setUp(self) -> None:
        super().setUp()
        self.data = self.root / "data"
        self.app = main.create_app(self.data, massive_key="", people=PEOPLE)
        self.client = self.app.test_client()
        self.store = AccountStore(self.data / "users.sqlite3", PEOPLE)

    def post(self, path: str, payload, client=None, headers=None):
        return (client or self.client).post(path, json=payload, base_url=HOST, headers=headers or ORIGIN)

    def get(self, path: str, client=None, **kwargs):
        response = (client or self.client).get(path, base_url=HOST, **kwargs)
        self.addCleanup(response.close)
        return response

    def other_client(self, username: str):
        client = self.app.test_client()
        self.assertEqual(sign_in(client, username).status_code, 200)
        return client

    # ---- signing in -------------------------------------------------------------------------

    def test_profile_list_is_public_and_shows_who_still_needs_a_pin(self) -> None:
        users = {user["username"]: user for user in self.get("/api/users").get_json()["users"]}
        self.assertEqual(set(users), {"owner", "guest"})
        self.assertEqual(users["owner"], {"username": "owner", "name": "Owner", "initial": "O", "has_pin": False})
        sign_in(self.client, "owner")
        self.assertTrue(self.get("/api/users").get_json()["users"][0]["has_pin"])

    def test_nothing_private_is_reachable_without_signing_in(self) -> None:
        redirect = self.get("/", headers=PAGE)
        self.assertEqual(redirect.status_code, 302)
        self.assertEqual(redirect.location, "/login?next=%2F")
        self.assertIn("next=%2Froam%2F", self.get("/roam/", headers=PAGE).location)
        self.assertEqual(self.get("/", headers=CHROME_PAGE).status_code, 302)
        self.assertEqual(self.get("/", headers={"Accept": "*/*"}).status_code, 401)
        for path in ("/api/apps", "/api/me", "/roam/api/bootstrap", "/runs/api/races", "/fitness/api/workouts",
                     "/roam/api/flights.tsv", "/fuad/api/seed", "/trading/api/pg"):
            with self.subTest(path=path):
                self.assertEqual(self.get(path).status_code, 401)
        for path in ("/login", "/static/style.css", "/static/login.js", "/shared/hub-link.css"):
            with self.subTest(path=path):
                response = self.get(path)
                self.assertEqual(response.status_code, 200)
                response.close()

    def test_creating_a_pin_signs_you_in_once_and_only_once(self) -> None:
        created = self.post("/api/pin", {"username": "owner", "pin": "4821"})
        self.assertEqual(created.status_code, 200)
        self.assertEqual(self.get("/api/me").get_json()["user"]["name"], "Owner")
        self.assertEqual(self.post("/api/pin", {"username": "owner", "pin": "1111"}).status_code, 409)
        cookie = created.headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)

    def test_pins_must_be_exactly_four_digits(self) -> None:
        for pin in ("123", "12345", "abcd", "12 4", "١٢٣٤", 1234, None, ["1", "2", "3", "4"]):
            with self.subTest(pin=pin):
                self.assertEqual(self.post("/api/pin", {"username": "owner", "pin": pin}).status_code, 400)
        self.assertEqual(self.post("/api/pin", {"username": "nobody", "pin": "1234"}).status_code, 404)
        self.assertEqual(self.post("/api/pin", ["not", "an", "object"]).status_code, 400)
        self.assertFalse(self.store.has_pin("owner"))

    def test_login_checks_the_pin_and_can_sign_out(self) -> None:
        sign_in(self.client, "owner", "2468")
        self.post("/api/logout", {})
        self.assertEqual(self.get("/api/me").status_code, 401)
        wrong = self.post("/api/login", {"username": "owner", "pin": "0000"})
        self.assertEqual((wrong.status_code, wrong.get_json()["attempts_left"]), (401, 4))
        self.assertEqual(self.get("/api/me").status_code, 401)
        self.assertEqual(self.post("/api/login", {"username": "owner", "pin": "2468"}).status_code, 200)
        self.assertEqual(self.get("/api/me").get_json()["user"]["username"], "owner")

    def test_login_without_a_pin_asks_to_create_one(self) -> None:
        response = self.post("/api/login", {"username": "owner", "pin": "1234"})
        self.assertEqual((response.status_code, response.get_json()["needs_pin"]), (409, True))

    def test_repeated_wrong_pins_lock_the_account_even_for_the_right_pin(self) -> None:
        sign_in(self.client, "owner", "1357")
        self.post("/api/logout", {})
        for _ in range(4):
            self.assertEqual(self.post("/api/login", {"username": "owner", "pin": "0000"}).status_code, 401)
        locked = self.post("/api/login", {"username": "owner", "pin": "0000"})
        self.assertEqual(locked.status_code, 429)
        self.assertGreater(locked.get_json()["retry_after"], 0)
        self.assertEqual(self.post("/api/login", {"username": "owner", "pin": "1357"}).status_code, 429)

    def test_lockout_expires_and_grows_with_more_failures(self) -> None:
        self.store.set_pin("owner", "1357")
        for attempt in range(1, 5):
            self.assertEqual(self.store.check("owner", "0000", now=1000)[0], "wrong", attempt)
        self.assertEqual(self.store.check("owner", "0000", now=1000), ("locked", 30))
        self.assertEqual(self.store.check("owner", "1357", now=1010), ("locked", 20))
        self.assertEqual(self.store.check("owner", "1357", now=1031), ("ok", 0))
        for _ in range(5):
            self.store.check("owner", "0000", now=2000)
        self.assertEqual(self.store.check("owner", "0000", now=2031), ("locked", 60))  # doubles after each lockout

    def test_pins_are_stored_hashed_with_a_salt(self) -> None:
        self.store.set_pin("owner", "1234")
        self.store.set_pin("guest", "1234")
        with closing(sqlite3.connect(self.data / "users.sqlite3")) as connection:
            rows = connection.execute("SELECT username, salt, hash FROM credentials ORDER BY username").fetchall()
        self.assertNotEqual(rows[0][2], rows[1][2])
        for _, salt, digest in rows:
            self.assertEqual(len(salt), 16)
            self.assertNotIn(b"1234", digest)
        self.assertNotIn(b"1234", (self.data / "users.sqlite3").read_bytes())

    def test_signing_in_needs_a_same_origin_request(self) -> None:
        payload = {"username": "owner", "pin": "1234"}
        self.assertEqual(self.client.post("/api/pin", json=payload, base_url=HOST).status_code, 403)
        evil = {"Origin": "https://evil.example"}
        self.assertEqual(self.post("/api/pin", payload, headers=evil).status_code, 403)
        self.assertFalse(self.store.has_pin("owner"))

    def test_switching_user_replaces_the_session(self) -> None:
        sign_in(self.client, "owner")
        sign_in(self.client, "guest")
        self.assertEqual(self.get("/api/me").get_json()["user"]["username"], "guest")

    def test_next_link_only_allows_paths_on_this_site(self) -> None:
        self.assertEqual(safe_next("/roam/"), "/roam/")
        self.assertEqual(safe_next("/runs/activities/?connection=success"), "/runs/activities/?connection=success")
        for bad in (None, "", "//evil.example", "https://evil.example", "javascript:alert(1)", "/\\evil.example", "/login"):
            with self.subTest(bad=bad):
                self.assertEqual(safe_next(bad), "/")

    def test_signed_in_users_skip_the_login_page(self) -> None:
        self.assertEqual(self.get("/login").status_code, 200)
        sign_in(self.client)
        self.assertEqual(self.get("/login").status_code, 302)

    def test_forgotten_pin_can_be_cleared_from_the_command_line(self) -> None:
        self.store.set_pin("owner", "1234")
        (self.data / "accounts.json").write_text(json.dumps({"accounts": [{"username": "owner", "name": "Owner"}]}))
        self.assertEqual(main.reset_pin("owner", self.data), 0)
        self.assertFalse(self.store.has_pin("owner"))
        self.assertEqual(main.reset_pin("nobody", self.data), 1)

    # ---- who can open what ------------------------------------------------------------------

    def test_a_limited_account_only_sees_its_own_apps(self) -> None:
        guest = self.other_client("guest")
        apps = self.get("/api/apps", guest).get_json()["apps"]
        self.assertEqual([item["key"] for item in apps], ["roam", "fitness"])
        for path in ("/roam/", "/fitness/", "/roam/api/bootstrap", "/fitness/api/workouts"):
            self.assertEqual(self.get(path, guest).status_code, 200, path)
        for path in ("/runs/", "/runs/activities/", "/fuad/", "/trading/"):
            page = self.get(path, guest, headers=PAGE)
            self.assertEqual(page.status_code, 403, path)
            self.assertIn(b"isn't available to your account", page.data)
        for path in ("/runs/api/races", "/runs/activities/api/status", "/trading/api/pg", "/fuad/app.js", "/fuad/api/seed"):
            self.assertEqual(self.get(path, guest).status_code, 403, path)

    def test_the_owner_sees_every_app(self) -> None:
        owner = self.other_client("owner")
        keys = [item["key"] for item in self.get("/api/apps", owner).get_json()["apps"]]
        self.assertEqual(keys, ["roam", "runs", "fitness", "fuad", "trading"])

    def test_writes_to_an_app_you_cannot_open_are_refused(self) -> None:
        guest = self.other_client("guest")
        response = self.post("/runs/api/races", {"title": "x", "kind": "10k", "status": "wishlist"}, client=guest)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.post("/runs/activities/api/sync", {}, client=guest).status_code, 403)
        self.assertFalse((self.data / "users" / "guest" / "runs.sqlite3").exists())

    # ---- separate data ----------------------------------------------------------------------

    def test_each_person_sees_only_their_own_data(self) -> None:
        owner, guest = self.other_client("owner"), self.other_client("guest")
        trip = {"country_id": "ITA", "title": "A private trip", "start_date": "2026-06-01", "end_date": "2026-06-02"}
        self.assertEqual(self.post("/roam/api/trips", trip, client=owner).status_code, 201)
        self.assertEqual([t["title"] for t in self.get("/roam/api/bootstrap", owner).get_json()["trips"]], ["A private trip"])
        self.assertEqual(self.get("/roam/api/bootstrap", guest).get_json()["trips"], [])
        (self.data / "users" / "owner" / "flights.tsv").write_text("date\tairline\n2/15/2025\tX\n", encoding="utf-8")
        self.assertEqual(self.get("/roam/api/flights.tsv", owner).data.decode().count("\n"), 2)
        self.assertEqual(self.get("/roam/api/flights.tsv", guest).data.decode().count("\n"), 1)  # header only

    def test_flight_files_are_never_served_statically(self) -> None:
        owner = self.other_client("owner")
        for path in ("/roam/static/data/flights.tsv", "/static/data/flights.tsv"):
            self.assertEqual(self.get(path, owner).status_code, 404, path)

    def test_garage_starting_data_is_served_only_from_the_persons_own_file(self) -> None:
        owner, guest = self.other_client("owner"), self.other_client("guest")
        self.assertEqual(self.get("/fuad/api/seed", owner).get_json(), {})
        seed = {"car": {"plate": "AB 123"}, "expenses": [{"date": "2026-03", "category": "Gas", "amount": 60}]}
        (self.data / "users" / "owner" / "fuad-seed.json").write_text(json.dumps(seed), encoding="utf-8")
        response = self.get("/fuad/api/seed", owner)
        self.assertEqual(response.get_json(), seed)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        (self.data / "users" / "owner" / "fuad-seed.json").write_text("not json", encoding="utf-8")
        self.assertEqual(self.get("/fuad/api/seed", owner).get_json(), {})
        self.assertEqual(self.get("/fuad/api/seed", guest).status_code, 403)


class AccountFileTests(TempDirectoryCase):
    def write(self, content) -> Path:
        path = self.root / "accounts.json"
        path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
        return path

    def test_without_a_file_there_is_one_owner_with_every_app(self) -> None:
        people = load_accounts(self.root / "accounts.json")
        self.assertEqual([(p.username, p.apps) for p in people], [("owner", accounts.ALL_APPS)])

    def test_people_and_their_apps_come_from_the_file(self) -> None:
        people = load_accounts(self.write({"accounts": [
            {"username": "ann", "name": "Ann"},
            {"username": "bo-2", "name": "Bo", "apps": ["roam", "fitness"]},
        ]}))
        self.assertEqual([(p.username, p.name, p.apps) for p in people], [
            ("ann", "Ann", accounts.ALL_APPS), ("bo-2", "Bo", ("roam", "fitness"))])

    def test_a_bad_file_stops_the_server_with_a_clear_message(self) -> None:
        bad = [
            "not json", {"accounts": []}, {"nope": 1},
            {"accounts": [{"username": "../x", "name": "X"}]},
            {"accounts": [{"username": "Upper", "name": "X"}]},
            {"accounts": [{"username": "ann", "name": ""}]},
            {"accounts": [{"username": "ann", "name": "A", "apps": ["bitcoin"]}]},
            {"accounts": [{"username": "ann", "name": "A", "apps": []}]},
            {"accounts": [{"username": "ann", "name": "A"}, {"username": "ann", "name": "B"}]},
        ]
        for content in bad:
            with self.subTest(content=content), self.assertRaises(SystemExit) as caught:
                load_accounts(self.write(content))
            self.assertIn("accounts.json", str(caught.exception))

    def test_the_server_uses_the_accounts_file_in_its_data_folder(self) -> None:
        data = self.root / "data"
        data.mkdir()
        (data / "accounts.json").write_text(json.dumps({"accounts": [{"username": "ann", "name": "Ann"}]}))
        client = main.create_app(data, massive_key="").test_client()
        users = client.get("/api/users", base_url=HOST).get_json()["users"]
        self.assertEqual([user["username"] for user in users], ["ann"])
        self.assertTrue((data / "users" / "ann").is_dir())


if __name__ == "__main__":
    unittest.main()
