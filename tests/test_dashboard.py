import sqlite3
import unittest
from contextlib import closing
from datetime import date

import activities
from activities.dashboard import build
from tests.helpers import TempDirectoryCase

TODAY = date(2026, 11, 20)  # a Friday
ROWS = [
    ("2025-01-05", "Run", 30000, 9000, 200),
    ("2026-11-10", "Run", 20000, 7200, 600),
    ("2026-11-16", "Run", 10000, 3000, 100),
    ("2026-11-17", "Run", 5000, 1500, 50),
    ("2026-11-18", "Ride", 40000, 5400, 300),
    ("2026-11-19", "Walk", 3000, 1000, 10),
]


class DashboardMathTests(unittest.TestCase):
    def test_no_activities_means_an_empty_dashboard(self) -> None:
        self.assertEqual(build([], TODAY, 365), {"empty": True, "days": 365})

    def test_totals_cover_only_the_chosen_period_and_compare_with_the_one_before(self) -> None:
        result = build(ROWS, TODAY, 90)
        self.assertEqual((result["start"], result["end"]), ("2026-08-23", "2026-11-20"))
        self.assertEqual(result["totals"], {
            "count": 5, "distance_km": 78.0, "moving_seconds": 18100, "elevation_m": 1060, "active_days": 5})
        self.assertIsNone(result["previous"])  # nothing in the 90 days before
        wider = build(ROWS, TODAY, 365)
        self.assertEqual(wider["totals"]["count"], 5)
        self.assertEqual(wider["previous"]["count"], 1)  # the January 2025 run falls in the year before
        everything = build(ROWS, TODAY, 0)
        self.assertEqual((everything["start"], everything["totals"]["count"]), ("2025-01-05", 6))
        self.assertNotIn("previous", everything)

    def test_previous_period_is_the_same_length_just_before(self) -> None:
        rows = ROWS + [("2026-07-01", "Run", 8000, 2400, 20)]
        result = build(rows, TODAY, 90)
        self.assertEqual(result["previous"]["count"], 1)
        self.assertEqual(result["previous"]["distance_km"], 8.0)

    def test_weeks_run_monday_to_sunday_and_split_running_from_the_rest(self) -> None:
        weeks = build(ROWS, TODAY, 90)["weeks"]
        self.assertEqual((weeks[0]["start"], weeks[-1]["start"], len(weeks)), ("2026-08-17", "2026-11-16", 14))
        self.assertEqual(weeks[-1], {"start": "2026-11-16", "runs_km": 15.0, "other_km": 43.0, "count": 4, "seconds": 10900})
        self.assertEqual(weeks[-2]["runs_km"], 20.0)
        self.assertEqual(sum(week["count"] for week in weeks), 5)
        every = build(ROWS, TODAY, 0)["weeks"]
        self.assertEqual((every[0]["start"], len(every)), ("2024-12-30", 99))

    def test_sports_are_ordered_by_time(self) -> None:
        sports = build(ROWS, TODAY, 90)["sports"]
        self.assertEqual([entry["sport"] for entry in sports], ["Run", "Ride", "Walk"])
        self.assertEqual(sports[0], {"sport": "Run", "count": 3, "distance_km": 35.0, "moving_seconds": 11700, "elevation_m": 750.0})

    def test_months_and_running_pace(self) -> None:
        months = build(ROWS, TODAY, 0)["months"]
        self.assertEqual([month["month"] for month in months], ["2025-01", "2026-11"])
        self.assertEqual(months[1]["runs_km"], 35.0)
        self.assertEqual(months[1]["other_km"], 43.0)
        self.assertEqual(months[1]["run_pace_seconds_per_km"], 334)  # 11,700 s over 35 km
        only_ride = build([("2026-11-18", "Ride", 40000, 5400, 0)], TODAY, 90)["months"]
        self.assertIsNone(only_ride[0]["run_pace_seconds_per_km"])

    def test_weekday_counts_start_on_monday(self) -> None:
        self.assertEqual(build(ROWS, TODAY, 90)["weekdays"], [1, 2, 1, 1, 0, 0, 0])

    def test_calendar_covers_a_year_of_weeks_ending_this_one(self) -> None:
        calendar = build(ROWS, TODAY, 90)["calendar"]
        self.assertEqual(calendar["start"], "2025-11-17")
        self.assertEqual([entry["day"] for entry in calendar["days"]][-2:], ["2026-11-18", "2026-11-19"])
        self.assertNotIn("2025-01-05", [entry["day"] for entry in calendar["days"]])
        self.assertEqual(calendar["days"][-1], {"day": "2026-11-19", "seconds": 1000, "km": 3.0, "count": 1})

    def test_records_and_streaks_use_all_activities(self) -> None:
        result = build(ROWS, TODAY, 90)
        records = result["records"]
        self.assertEqual(records["longest_run"], {"km": 30.0, "day": "2025-01-05"})
        self.assertEqual(records["longest_activity"]["sport"], "Ride")
        self.assertEqual(records["most_climbing"], {"m": 600, "day": "2026-11-10", "sport": "Run"})
        self.assertEqual(records["best_run_week"], {"km": 30.0, "start": "2024-12-30"})
        self.assertEqual(records["best_run_month"], {"km": 35.0, "month": "2026-11"})
        self.assertEqual((records["first_activity"], records["total_activities"]), ("2025-01-05", 6))
        self.assertEqual(result["streaks"], {"current_days": 4, "best_days": 4, "current_weeks": 2, "best_weeks": 2})

    def test_a_streak_survives_today_but_not_a_missed_day(self) -> None:
        self.assertEqual(build([("2026-11-19", "Run", 1000, 300, 0)], TODAY, 90)["streaks"]["current_days"], 1)
        self.assertEqual(build([("2026-11-18", "Run", 1000, 300, 0)], TODAY, 90)["streaks"]["current_days"], 0)
        self.assertEqual(build([("2026-11-20", "Run", 1000, 300, 0)], TODAY, 90)["streaks"]["current_days"], 1)

    def test_no_runs_means_no_running_records(self) -> None:
        records = build([("2026-11-18", "Ride", 40000, 5400, 300)], TODAY, 90)["records"]
        self.assertIsNone(records["longest_run"])
        self.assertIsNone(records["best_run_week"])


class DashboardApiTests(TempDirectoryCase):
    def setUp(self) -> None:
        super().setUp()
        self.path = self.root / "activities.sqlite3"
        self.client = activities.create_app(str(self.path), environ={}).test_client()
        self.base = "http://127.0.0.1:5173"

    def get(self, url: str):
        return self.client.get(url, base_url=self.base)

    def test_empty_until_something_is_synced_and_needs_no_strava_connection(self) -> None:
        data = self.get("/api/dashboard").get_json()
        self.assertEqual((data["empty"], data["cache"]["count"]), (True, 0))
        with closing(sqlite3.connect(self.path)) as connection:
            connection.execute("INSERT INTO activities VALUES (1, 'x', 'Run', ?, 0, 5000, 1500, 10)", (date.today().isoformat(),))
            connection.commit()
        data = self.get("/api/dashboard?days=90").get_json()
        self.assertEqual((data["empty"], data["totals"]["count"], data["cache"]["count"]), (False, 1, 1))
        self.assertEqual(self.get("/api/dashboard").headers["Cache-Control"], "no-store")

    def test_only_known_periods_are_accepted(self) -> None:
        for bad in ("7", "abc", "-1", "366", ""):
            with self.subTest(days=bad):
                self.assertEqual(self.get(f"/api/dashboard?days={bad}").status_code, 400)
        for good in ("90", "180", "365", "0"):
            self.assertEqual(self.get(f"/api/dashboard?days={good}").status_code, 200)

    def test_dashboard_assets_are_served(self) -> None:
        for path in ("/static/dashboard.js", "/"):
            response = self.get(path)
            self.assertEqual(response.status_code, 200, path)
            response.close()


if __name__ == "__main__":
    unittest.main()
