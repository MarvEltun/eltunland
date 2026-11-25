import unittest
from datetime import date, timedelta

import fitness
from fitness.summary import current_streak, minutes_between, week_start
from tests.helpers import TempDirectoryCase

WORKOUT = {"day": "2026-05-04", "kind": "run", "minutes": 35, "distance_km": 5.2, "effort": 3, "notes": "Easy."}


class FitnessApiTests(TempDirectoryCase):
    def setUp(self) -> None:
        super().setUp()
        self.database = str(self.root / "fitness.sqlite3")
        self.client = fitness.create_app(self.database).test_client()

    def workouts(self) -> list[dict]:
        return self.client.get("/api/workouts").get_json()["workouts"]

    def test_starts_empty_with_the_default_goal(self) -> None:
        data = self.client.get("/api/workouts").get_json()
        self.assertEqual((data["workouts"], data["goal_minutes"]), ([], 150))
        self.assertIn("yoga", data["kinds"])

    def test_create_edit_persist_delete(self) -> None:
        created = self.client.post("/api/workouts", json=WORKOUT)
        self.assertEqual(created.status_code, 201)
        workout_id = created.get_json()["id"]
        self.assertEqual(self.client.put(f"/api/workouts/{workout_id}", json={**WORKOUT, "minutes": 40}).status_code, 200)
        restarted = fitness.create_app(self.database).test_client().get("/api/workouts").get_json()["workouts"]
        self.assertEqual((len(restarted), restarted[0]["minutes"]), (1, 40))
        self.assertEqual(self.client.delete(f"/api/workouts/{workout_id}").status_code, 204)
        self.assertEqual(self.client.delete(f"/api/workouts/{workout_id}").status_code, 404)
        self.assertEqual(self.client.put(f"/api/workouts/{workout_id}", json=WORKOUT).status_code, 404)

    def test_distance_is_optional_and_newest_comes_first(self) -> None:
        self.client.post("/api/workouts", json={**WORKOUT, "kind": "yoga", "distance_km": None, "day": "2026-05-01"})
        self.client.post("/api/workouts", json={**WORKOUT, "day": "2026-05-09"})
        days = [w["day"] for w in self.workouts()]
        self.assertEqual(days, ["2026-05-09", "2026-05-01"])
        self.assertIsNone(self.workouts()[1]["distance_km"])

    def test_validation(self) -> None:
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        for changes in [
            {"day": "not-a-date"}, {"day": "2026-02-30"}, {"day": "20260504"}, {"day": "1999-12-31"}, {"day": tomorrow},
            {"kind": "parkour"}, {"kind": 5}, {"minutes": 0}, {"minutes": 1441}, {"minutes": 30.5}, {"minutes": True},
            {"minutes": "30"}, {"effort": 0}, {"effort": 6}, {"effort": 2.5}, {"distance_km": 0}, {"distance_km": -3},
            {"distance_km": 5000}, {"distance_km": "far"}, {"distance_km": float("inf")}, {"notes": "x" * 1001},
        ]:
            with self.subTest(changes=changes):
                response = self.client.post("/api/workouts", json={**WORKOUT, **changes})
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.get_json())
        self.assertEqual(self.workouts(), [])

    def test_weekly_goal(self) -> None:
        self.assertEqual(self.client.put("/api/goal", json={"minutes": 200}).get_json()["goal_minutes"], 200)
        self.assertEqual(self.client.get("/api/workouts").get_json()["goal_minutes"], 200)
        for bad in (5, 5000, 99.5, "200", True, None):
            with self.subTest(bad=bad):
                self.assertEqual(self.client.put("/api/goal", json={"minutes": bad}).status_code, 400)
        self.assertEqual(self.client.get("/api/workouts").get_json()["goal_minutes"], 200)

    def test_request_guards_and_assets(self) -> None:
        evil = {"Origin": "https://evil.example"}
        self.assertEqual(self.client.post("/api/workouts", json=WORKOUT, headers=evil).status_code, 403)
        self.assertEqual(self.client.post("/api/workouts", data="text").status_code, 415)
        self.assertEqual(self.client.post("/api/workouts", json={**WORKOUT, "notes": "x" * 9000}).status_code, 413)
        for path in ("/", "/static/app.js", "/static/style.css", "/static/icon.svg"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            response.close()


class SummaryTests(unittest.TestCase):
    def test_week_starts_on_monday(self) -> None:
        self.assertEqual(week_start(date(2026, 11, 20)), date(2026, 11, 16))  # a Friday
        self.assertEqual(week_start(date(2026, 11, 16)), date(2026, 11, 16))
        self.assertEqual(week_start(date(2026, 11, 22)), date(2026, 11, 16))  # the Sunday

    def test_minutes_between_is_inclusive(self) -> None:
        rows = [("2026-11-15", 99), ("2026-11-16", 30), ("2026-11-20", 45), ("2026-11-21", 60)]
        self.assertEqual(minutes_between(rows, date(2026, 11, 16), date(2026, 11, 20)), 75)
        self.assertEqual(minutes_between([], date(2026, 11, 16), date(2026, 11, 20)), 0)

    def test_streak_survives_until_the_end_of_today(self) -> None:
        today = date(2026, 11, 20)
        days = {"2026-11-17", "2026-11-18", "2026-11-19"}
        self.assertEqual(current_streak(days, today), 3)             # today not done yet: still alive
        self.assertEqual(current_streak(days | {"2026-11-20"}, today), 4)
        self.assertEqual(current_streak({"2026-11-17"}, today), 0)    # missed yesterday: broken
        self.assertEqual(current_streak({"2026-11-20", "2026-11-18"}, today), 1)  # a gap ends it
        self.assertEqual(current_streak(set(), today), 0)


if __name__ == "__main__":
    unittest.main()
