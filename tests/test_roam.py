import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from roam import create_app


class TravelAppTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(
            prefix="roam-test-", dir=os.environ.get("TMPDIR")
        )
        self.database = str(Path(self.directory.name) / "travel.sqlite3")
        self.app = create_app(self.database)
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()
        self.trip = {
            "country_id": "ITA",
            "title": "Summer in Italy",
            "start_date": "2026-06-01",
            "end_date": "2026-06-08",
            "notes": "A favorite memory.",
        }
        self.stadium = {
            "name": "Example Ground",
            "location": "Schwalbach am Taunus",
            "visited_on": "2026-06-01",
            "map_url": "https://maps.app.goo.gl/ojpjc9VoMbTbdpcP7",
            "notes": "A memorable match.",
            "latitude": 50.0685807,
            "longitude": 8.645472,
        }

    def tearDown(self) -> None:
        self.directory.cleanup()

    def test_map_starts_empty_and_assets_load(self) -> None:
        data = self.client.get("/api/bootstrap").get_json()
        self.assertGreater(len(data["countries"]), 170)
        self.assertEqual(len({country["id"] for country in data["countries"]}), len(data["countries"]))
        self.assertTrue(all(country["status"] == "none" for country in data["countries"]))
        self.assertEqual(data["trips"], [])
        self.assertEqual(data["stadiums"], [])
        for path in ("/", "/static/app.js", "/static/style.css", "/static/icon.svg"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                response.close()

    def test_country_status_and_notes_survive_restart(self) -> None:
        note = "Coffee in Rome. <script>not executable</script>"
        response = self.client.put(
            "/api/countries/ITA", json={"status": "visited", "notes": f" {note} "}
        )
        self.assertEqual(response.status_code, 200)
        new_client = create_app(self.database).test_client()
        italy = next(
            item for item in new_client.get("/api/bootstrap").get_json()["countries"]
            if item["id"] == "ITA"
        )
        self.assertEqual(italy["status"], "visited")
        self.assertEqual(italy["notes"], note)
        self.client.put("/api/countries/ITA", json={"status": "bucket", "notes": note})
        response = self.client.put("/api/countries/ITA", json={"status": "none", "notes": note})
        self.assertEqual(response.get_json()["status"], "none")
        self.assertEqual(response.get_json()["notes"], note)

    def test_country_validation(self) -> None:
        for payload in [
            {"status": "invalid"}, {"status": ["visited"]}, {"status": "visited", "notes": 1},
            {"status": "visited", "notes": "x" * 5001}, None, [],
        ]:
            with self.subTest(payload=payload):
                response = self.client.put("/api/countries/ITA", json=payload, content_type="application/json")
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.get_json())
        self.assertEqual(
            self.client.put("/api/countries/UNKNOWN", json={"status": "visited"}).status_code, 404
        )

    def test_trip_create_edit_persist_delete(self) -> None:
        response = self.client.post("/api/trips", json=self.trip)
        self.assertEqual(response.status_code, 201)
        trip_id = response.get_json()["id"]
        response = self.client.put(
            f"/api/trips/{trip_id}", json={**self.trip, "title": "A new chapter"}
        )
        self.assertEqual(response.status_code, 200)
        new_client = create_app(self.database).test_client()
        trips = new_client.get("/api/bootstrap").get_json()["trips"]
        self.assertEqual(len(trips), 1)
        self.assertEqual(trips[0]["title"], "A new chapter")
        countries = new_client.get("/api/bootstrap").get_json()["countries"]
        self.assertTrue(all(country["status"] == "none" for country in countries))
        self.assertEqual(self.client.delete(f"/api/trips/{trip_id}").status_code, 204)
        self.assertEqual(self.client.get("/api/bootstrap").get_json()["trips"], [])
        self.assertEqual(self.client.delete(f"/api/trips/{trip_id}").status_code, 404)
        self.assertEqual(
            self.client.put(f"/api/trips/{trip_id}", json=self.trip).status_code, 404
        )

    def test_trip_validation(self) -> None:
        for changes in [
            {"title": ""}, {"title": " "}, {"title": "x" * 101},
            {"start_date": "not-a-date"}, {"start_date": "2026-02-30"},
            {"start_date": "20260601"}, {"end_date": "2026-05-01"},
            {"country_id": "INVALID"}, {"notes": "x" * 5001}, {"title": 42},
        ]:
            with self.subTest(changes=changes):
                response = self.client.post("/api/trips", json={**self.trip, **changes})
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.get_json())
        self.assertEqual(self.client.get("/api/bootstrap").get_json()["trips"], [])

    def test_stadium_create_edit_persist_delete(self) -> None:
        response = self.client.post("/api/stadiums", json=self.stadium)
        self.assertEqual(response.status_code, 201)
        stadium_id = response.get_json()["id"]
        response = self.client.put(
            f"/api/stadiums/{stadium_id}", json={**self.stadium, "name": "Updated Ground"}
        )
        self.assertEqual(response.status_code, 200)
        new_client = create_app(self.database).test_client()
        stadiums = new_client.get("/api/bootstrap").get_json()["stadiums"]
        self.assertEqual(len(stadiums), 1)
        self.assertEqual(stadiums[0]["name"], "Updated Ground")
        self.assertEqual(stadiums[0]["map_url"], self.stadium["map_url"])
        self.assertEqual(stadiums[0]["latitude"], self.stadium["latitude"])
        self.assertEqual(stadiums[0]["longitude"], self.stadium["longitude"])
        self.assertEqual(self.client.delete(f"/api/stadiums/{stadium_id}").status_code, 204)
        self.assertEqual(self.client.get("/api/bootstrap").get_json()["stadiums"], [])
        self.assertEqual(self.client.delete(f"/api/stadiums/{stadium_id}").status_code, 404)
        self.assertEqual(
            self.client.put(f"/api/stadiums/{stadium_id}", json=self.stadium).status_code, 404
        )

    def test_stadium_validation(self) -> None:
        for changes in [
            {"name": ""}, {"name": "x" * 121}, {"location": "x" * 121},
            {"visited_on": "not-a-date"}, {"map_url": "javascript:alert(1)"},
            {"map_url": "https://example.com"}, {"notes": "x" * 5001}, {"name": 42},
            {"latitude": 91}, {"longitude": -181}, {"latitude": "not a number"},
            {"longitude": ""},
        ]:
            with self.subTest(changes=changes):
                response = self.client.post("/api/stadiums", json={**self.stadium, **changes})
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.get_json())
        self.assertEqual(self.client.get("/api/bootstrap").get_json()["stadiums"], [])

    def test_existing_stadiums_gain_coordinate_columns(self) -> None:
        legacy_database = str(Path(self.directory.name) / "legacy.sqlite3")
        with closing(sqlite3.connect(legacy_database)) as connection:
            connection.execute(
                "CREATE TABLE stadiums (id TEXT PRIMARY KEY, name TEXT NOT NULL, "
                "location TEXT NOT NULL DEFAULT '', visited_on TEXT NOT NULL DEFAULT '', "
                "map_url TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '')"
            )
            connection.execute(
                "INSERT INTO stadiums (id, name) VALUES ('old-entry', 'Old Ground')"
            )
            connection.commit()
        client = create_app(legacy_database).test_client()
        stadium = client.get("/api/bootstrap").get_json()["stadiums"][0]
        self.assertEqual(stadium["name"], "Old Ground")
        self.assertIsNone(stadium["latitude"])
        self.assertIsNone(stadium["longitude"])

    def test_mutation_request_guards(self) -> None:
        response = self.client.post(
            "/api/trips", json=self.trip, headers={"Origin": "https://other.example"}
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.post("/api/trips", data="text").status_code, 415)
        self.assertEqual(
            self.client.post("/api/trips", data="{", content_type="application/json").status_code,
            400,
        )
        self.assertEqual(
            self.client.post("/api/trips", json={**self.trip, "notes": "x" * 70000}).status_code,
            413,
        )


if __name__ == "__main__":
    unittest.main()
