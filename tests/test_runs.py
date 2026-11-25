import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from runs import create_app


class RunsAppTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(
            prefix="runs-test-", dir=os.environ.get("TMPDIR")
        )
        self.database = str(Path(self.directory.name) / "runs.sqlite3")
        self.client = create_app(self.database).test_client()
        self.race = {
            "title": "Test Half-marathon", "city": "Testville", "country": "Germany",
            "kind": "half", "race_date": "2025-05", "status": "run", "finish_time": "1:45:30",
            "notes": "Windy.",
        }

    def tearDown(self) -> None:
        self.directory.cleanup()

    def races(self) -> list[dict]:
        return self.client.get("/api/races").get_json()["races"]

    def test_a_new_database_starts_empty(self) -> None:
        self.assertEqual(self.races(), [])
        self.assertEqual(create_app(self.database).test_client().get("/api/races").get_json()["races"], [])

    def test_create_edit_persist_delete(self) -> None:
        response = self.client.post("/api/races", json=self.race)
        self.assertEqual(response.status_code, 201)
        saved = response.get_json()
        self.assertEqual(saved["finish_seconds"], 6330)
        self.assertEqual(saved["distance_km"], 21.0975)
        response = self.client.put(f"/api/races/{saved['id']}", json={**self.race, "finish_time": "1:40:00"})
        self.assertEqual(response.status_code, 200)
        reloaded = create_app(self.database).test_client().get("/api/races").get_json()["races"]
        match = next(race for race in reloaded if race["id"] == saved["id"])
        self.assertEqual(match["finish_seconds"], 6000)
        self.assertEqual(self.client.delete(f"/api/races/{saved['id']}").status_code, 204)
        self.assertEqual(self.client.delete(f"/api/races/{saved['id']}").status_code, 404)
        self.assertEqual(self.client.put(f"/api/races/{saved['id']}", json=self.race).status_code, 404)

    def test_other_distance_and_wishlist_without_date(self) -> None:
        response = self.client.post(
            "/api/races", json={"title": "Odd one", "kind": "other", "distance_km": "15", "status": "wishlist"}
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["distance_km"], 15.0)
        self.assertEqual(response.get_json()["race_date"], "")

    def test_validation(self) -> None:
        for changes in [
            {"title": ""}, {"title": "x" * 121}, {"kind": "ultra"}, {"status": "dnf"},
            {"race_date": ""}, {"race_date": "2025-13"}, {"race_date": "2025-02-30"},
            {"race_date": "2999-01"}, {"finish_time": "fast"}, {"finish_time": "1:75:00"},
            {"status": "planned", "race_date": "2999-01"},  # finish time only allowed once run
            {"notes": "x" * 2001}, {"city": "x" * 81}, {"title": 42},
            {"kind": "other"}, {"kind": "other", "distance_km": 0}, {"kind": "other", "distance_km": "abc"},
        ]:
            with self.subTest(changes=changes):
                response = self.client.post("/api/races", json={**self.race, **changes})
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.get_json())
        self.assertEqual(len(self.races()), 0)

    def test_series_can_be_set_edited_and_removed_with_the_race(self) -> None:
        created = self.client.post(
            "/api/races", json={**self.race, "series": ["superhalfs", "abbott"]}
        ).get_json()
        self.assertEqual(created["series"], ["abbott", "superhalfs"])
        payload = {**created, "finish_time": "", "series": ["abbott"]}
        self.assertEqual(self.client.put(f"/api/races/{created['id']}", json=payload).status_code, 200)
        restarted = create_app(self.database).test_client().get("/api/races").get_json()["races"]
        self.assertEqual(restarted[0]["series"], ["abbott"])
        catalog = self.client.get("/api/races").get_json()["series_catalog"]
        self.assertEqual([item["key"] for item in catalog], ["abbott", "superhalfs", "superhalfs-europa"])
        self.client.delete(f"/api/races/{created['id']}")
        with closing(sqlite3.connect(self.database)) as connection:
            left = connection.execute("SELECT COUNT(*) FROM race_series WHERE race_id=?", (created["id"],)).fetchone()[0]
        self.assertEqual(left, 0)

    def test_series_validation(self) -> None:
        for series in (["parkrun"], "abbott", [1], ["abbott", "abbott"]):
            with self.subTest(series=series):
                response = self.client.post("/api/races", json={**self.race, "series": series})
                self.assertEqual(response.status_code, 400)

    def test_mutation_request_guards(self) -> None:
        response = self.client.post("/api/races", json=self.race, headers={"Origin": "https://other.example"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.post("/api/races", data="text").status_code, 415)
        self.assertEqual(self.client.post("/api/races", data="{", content_type="application/json").status_code, 400)
        self.assertEqual(self.client.post("/api/races", json={**self.race, "notes": "x" * 20000}).status_code, 413)

    def test_database_rejects_finish_time_on_unrun_race(self) -> None:
        with closing(sqlite3.connect(self.database)) as connection, self.assertRaises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO races (id, title, kind, distance_km, status, finish_seconds) "
                "VALUES ('x', 'Bad', 'half', 21.0975, 'planned', 5000)"
            )

    def test_pages_load_and_foreign_host_is_refused(self) -> None:
        for path in ("/", "/static/app.js", "/static/style.css", "/static/icon.svg"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                response.close()
        self.assertEqual(self.client.get("/", base_url="http://evil.example").status_code, 400)


if __name__ == "__main__":
    unittest.main()
