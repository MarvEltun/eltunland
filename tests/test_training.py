import sqlite3
import unittest
from contextlib import closing
from datetime import date

import activities
from runs import create_app
from runs.training import consecutive, race_day, summarize, window
from tests.helpers import TempDirectoryCase

ROWS = [
    ("2025-05-06", "Run", 10000, 3000, 100),
    ("2025-05-08", "Run", 5000, 1500, 50),
    ("2025-05-10", "Ride", 40000, 5400, 300),
    ("2025-05-14", "TrailRun", 20000, 7200, 600),
]


def race(identifier: str, title: str, day: str, status: str = "run") -> dict:
    return {"id": identifier, "title": title, "race_date": day, "status": status}


class TrainingMathTests(unittest.TestCase):
    def test_a_month_alone_is_placed_mid_month_and_flagged(self) -> None:
        self.assertEqual(race_day("2025-06"), (date(2025, 6, 15), True))
        self.assertEqual(race_day("2025-06-02"), (date(2025, 6, 2), False))

    def test_the_window_excludes_both_race_days(self) -> None:
        self.assertEqual(window("2025-05-04", "2025-06-01", date(2026, 1, 1)),
                         (date(2025, 5, 5), date(2025, 5, 31), False))
        self.assertEqual(window("2025-05-04", None, date(2025, 5, 20)), (date(2025, 5, 5), date(2025, 5, 20), False))
        self.assertTrue(window("2025-05", "2025-06-01", date(2026, 1, 1))[2])
        for impossible in (("2025-05-04", "2025-05-04"), ("2025-05-04", "2025-05-05"), ("2025-06-01", "2025-05-01")):
            self.assertIsNone(window(*impossible, date(2026, 1, 1)), impossible)

    def test_totals_for_runs_and_for_everything(self) -> None:
        result = summarize(ROWS, date(2025, 5, 5), date(2025, 5, 18))
        self.assertEqual(result["days"], 14)
        self.assertEqual(result["runs"], {
            "count": 3, "distance_km": 35.0, "moving_seconds": 11700, "elevation_m": 750, "longest_km": 20.0,
            "pace_seconds_per_km": 334, "weekly_avg_km": 17.5, "peak_week_km": 20.0,
        })
        self.assertEqual(result["all"], {
            "count": 4, "distance_km": 75.0, "moving_seconds": 17100, "elevation_m": 1050, "longest_km": 40.0,
            "pace_seconds_per_km": None, "weekly_avg_km": 37.5, "peak_week_km": 55.0,
        })

    def test_an_empty_period_is_all_zeros_without_dividing_by_zero(self) -> None:
        result = summarize([], date(2025, 5, 5), date(2025, 5, 5))
        self.assertEqual(result["runs"]["count"], 0)
        self.assertIsNone(result["runs"]["pace_seconds_per_km"])
        self.assertEqual(result["runs"]["weekly_avg_km"], 0)

    def test_each_run_race_is_measured_from_the_one_before(self) -> None:
        races = [
            race("c", "Third", "2025-09-01"), race("a", "First", "2025-03-02"), race("b", "Second", "2025-06-01"),
            race("w", "Wish", "", "wishlist"), race("p1", "Next", "2999-04", "planned"),
            race("p2", "Later", "2999-09", "planned"),
        ]
        found = consecutive(races, date(2026, 11, 20))
        self.assertEqual(set(found), {"b", "c", "p1"})  # nothing before the first race; only the next planned race
        self.assertEqual(found["b"]["since"]["id"], "a")
        self.assertEqual(found["b"]["span"][:2], (date(2025, 3, 3), date(2025, 5, 31)))
        self.assertEqual(found["c"]["since"]["id"], "b")
        self.assertTrue(found["p1"]["so_far"])
        self.assertEqual(found["p1"]["span"][:2], (date(2025, 9, 2), date(2026, 11, 20)))

    def test_races_on_the_same_day_have_no_period_between_them(self) -> None:
        self.assertEqual(consecutive([race("a", "A", "2025-03-02"), race("b", "B", "2025-03-02")], date(2026, 1, 1)), {})


class TrainingApiTests(TempDirectoryCase):
    def setUp(self) -> None:
        super().setUp()
        self.runs_db = str(self.root / "runs.sqlite3")
        self.strava_db = self.root / "activities.sqlite3"
        activities.prepare_database(self.strava_db)
        self.client = create_app(self.runs_db, strava_path=str(self.strava_db)).test_client()
        self.ids = {}
        for key, title, day, status in (
            ("a", "Berlin Half", "2025-05-04", "run"), ("b", "Prague Half", "2025-06-01", "run"),
            ("c", "Lisbon Half", "2025-09", "run"), ("p", "Turin Half", "2100-11", "planned"),
        ):
            response = self.client.post("/api/races", json={
                "title": title, "kind": "half", "race_date": day, "status": status})
            self.assertEqual(response.status_code, 201, response.get_json())
            self.ids[key] = response.get_json()["id"]

    def add_activities(self, rows=ROWS) -> None:
        with closing(sqlite3.connect(self.strava_db)) as connection:
            connection.executemany(
                "INSERT INTO activities (id, name, sport_type, day, start_ts, distance_m, moving_s, elevation_m) "
                "VALUES (?, 'x', ?, ?, 0, ?, ?, ?)",
                [(index, sport, day, metres, moving, climb) for index, (day, sport, metres, moving, climb) in enumerate(rows)])
            connection.commit()

    def races(self) -> dict:
        return self.client.get("/api/races").get_json()

    def test_races_carry_the_training_since_the_previous_race(self) -> None:
        self.add_activities()
        data = self.races()
        self.assertEqual(set(data["training"]), {self.ids["b"], self.ids["c"], self.ids["p"]})
        between = data["training"][self.ids["b"]]
        self.assertEqual((between["start"], between["end"], between["days"]), ("2025-05-05", "2025-05-31", 27))
        self.assertEqual(between["since"]["title"], "Berlin Half")
        self.assertEqual((between["runs"]["count"], between["runs"]["distance_km"]), (3, 35.0))
        self.assertEqual(between["all"]["distance_km"], 75.0)
        self.assertFalse(between["approximate"])
        self.assertTrue(data["training"][self.ids["c"]]["approximate"])  # Lisbon is only known by month
        self.assertTrue(data["training"][self.ids["p"]]["so_far"])
        self.assertEqual(data["strava"]["count"], 4)

    def test_activities_outside_the_period_are_ignored(self) -> None:
        self.add_activities([("2025-05-04", "Run", 21000, 6000, 0), ("2025-06-01", "Run", 21000, 6000, 0),
                             ("2025-05-05", "Run", 5000, 1500, 10), ("2025-05-31", "Run", 6000, 1800, 20)])
        training = self.races()["training"][self.ids["b"]]["runs"]
        self.assertEqual((training["count"], training["distance_km"]), (2, 11.0))  # neither race day itself

    def test_between_any_two_races(self) -> None:
        self.add_activities()
        a, b, c = self.ids["a"], self.ids["b"], self.ids["c"]
        both = self.client.get(f"/api/training?from={a}&to={c}").get_json()
        self.assertEqual((both["start"], both["end"]), ("2025-05-05", "2025-09-14"))
        self.assertEqual(both["runs"]["distance_km"], 35.0)
        until_today = self.client.get(f"/api/training?from={b}").get_json()
        self.assertEqual(until_today["end"], date.today().isoformat())
        planned = self.client.get(f"/api/training?from={c}&to={self.ids['p']}").get_json()
        self.assertEqual(planned["end"], date.today().isoformat())  # a future race is measured up to today

    def test_between_races_rejects_bad_choices(self) -> None:
        a, b = self.ids["a"], self.ids["b"]
        for query in (f"from={b}&to={a}", f"from={a}&to={a}", "from=nope", f"from={a}&to=nope", ""):
            with self.subTest(query=query):
                response = self.client.get(f"/api/training?{query}")
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.get_json())

    def test_without_synced_activities_totals_are_empty_not_errors(self) -> None:
        data = self.races()
        self.assertEqual(data["strava"], {"count": 0, "last_synced": None})
        self.assertEqual(data["training"][self.ids["b"]]["runs"]["count"], 0)

    def test_without_a_strava_source_there_are_no_totals(self) -> None:
        client = create_app(str(self.root / "plain.sqlite3")).test_client()
        self.assertEqual(client.get("/api/races").get_json()["training"], {})
        self.assertEqual(client.get("/api/training?from=x").status_code, 404)


if __name__ == "__main__":
    unittest.main()
