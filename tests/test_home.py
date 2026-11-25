import sqlite3
from contextlib import closing
from datetime import date

import fitness
import roam
import runs
from accounts import DEFAULT_ACCOUNTS, Account
from home.registry import highlight, home_for, months_between, personal_message
from tests.helpers import TempDirectoryCase

OWNER = DEFAULT_ACCOUNTS[0]  # has every app
LIMITED = Account("guest", "Guest", ("roam", "fitness"))  # an account without My Runs, to check per-account content
TODAY = date(2026, 11, 20)  # a Friday; this week started on Monday 16 November


class HomeTests(TempDirectoryCase):
    def setUp(self) -> None:
        super().setUp()
        self.folder = self.root / "person"
        self.folder.mkdir()

    def add_races(self, rows) -> None:
        runs.prepare_database(self.folder / "runs.sqlite3")
        with closing(sqlite3.connect(self.folder / "runs.sqlite3")) as connection:
            connection.executemany(
                "INSERT INTO races (id, title, kind, distance_km, race_date, status) VALUES (?, ?, 'half', ?, ?, ?)", rows)
            connection.commit()

    def add_workouts(self, rows, goal: int | None = None) -> None:
        fitness.prepare_database(self.folder / "fitness.sqlite3")
        with closing(sqlite3.connect(self.folder / "fitness.sqlite3")) as connection:
            connection.executemany(
                "INSERT INTO workouts (id, day, kind, minutes, effort) VALUES (?, ?, 'run', ?, 3)",
                [(f"{day}-{minutes}", day, minutes) for day, minutes in rows])
            if goal:
                connection.execute("UPDATE settings SET value=? WHERE key='goal_minutes'", (str(goal),))
            connection.commit()

    # ---- headline numbers -------------------------------------------------------------------

    def test_numbers_come_from_the_users_own_files(self) -> None:
        roam.prepare_database(self.folder / "roam.sqlite3")
        with closing(sqlite3.connect(self.folder / "roam.sqlite3")) as connection:
            connection.executemany("INSERT INTO country_states (country_id, status) VALUES (?, ?)",
                                   [("ITA", "visited"), ("DEU", "visited"), ("FRA", "bucket")])
            connection.execute("INSERT INTO stadiums (id, name) VALUES ('a', 'A')")
            connection.commit()
        (self.folder / "flights.tsv").write_text("date\tairline\n2/15/2025\tX\n2/11/2025\tY\n\n", encoding="utf-8")
        self.add_races([("1", "Old 10k", 10, "2025-06", "run"), ("2", "Old 5k", 5.6, "2025-07-01", "run"),
                        ("3", "Past plan", 21.1, "2001-01", "planned"), ("4", "Later half", 21.1, "2999-04", "planned"),
                        ("5", "Sooner half", 21.1, "2998-08", "planned"), ("6", "Dream", 42.2, "", "wishlist")])
        apps = {item["key"]: item for item in home_for(OWNER, self.folder, TODAY)["apps"]}
        pairs = lambda key: [(s["value"], s["label"]) for s in apps[key]["stats"]]  # noqa: E731
        self.assertEqual(pairs("roam"), [("2", "countries visited"), ("1", "stadiums"), ("2", "flights logged")])
        self.assertEqual(pairs("runs"), [("2", "races run"), ("15.6 km", "raced"), ("Sooner half", "next · Aug 2998")])

    def test_apps_a_person_cannot_open_are_not_listed(self) -> None:
        self.assertEqual([a["key"] for a in home_for(LIMITED, self.folder, TODAY)["apps"]], ["roam", "fitness"])
        self.assertEqual(len(home_for(OWNER, self.folder, TODAY)["apps"]), 5)

    def test_strava_activities_are_counted_on_the_runs_card_without_reading_tokens(self) -> None:
        def labels() -> list[str]:
            return [s["label"] for a in home_for(OWNER, self.folder, TODAY)["apps"] if a["key"] == "runs" for s in a["stats"]]
        self.add_races([("1", "Old 10k", 10, "2025-06", "run")])
        self.assertNotIn("Strava activities synced", labels())
        from activities import prepare_database
        prepare_database(self.folder / "activities.sqlite3")
        with closing(sqlite3.connect(self.folder / "activities.sqlite3")) as connection:
            connection.execute("INSERT INTO credentials VALUES (1, 'secret-token', 'secret-refresh', 0, 7)")
            connection.execute("INSERT INTO activities VALUES (1, 'Secret run name', 'Run', '2025-06-01', 0, 5000, 1500, 10)")
            connection.commit()
        self.assertIn("Strava activities synced", labels())
        self.assertNotIn("secret", str(home_for(OWNER, self.folder, TODAY)).lower())

    def test_home_never_modifies_a_database(self) -> None:
        self.add_races([("1", "A race", 21.1, "2999-04", "planned")])
        before = (self.folder / "runs.sqlite3").read_bytes()
        home_for(OWNER, self.folder, TODAY)
        self.assertEqual((self.folder / "runs.sqlite3").read_bytes(), before)

    def test_missing_files_give_empty_stats(self) -> None:
        apps = {a["key"]: a for a in home_for(OWNER, self.folder / "nothing-here", TODAY)["apps"]}
        self.assertEqual(apps["roam"]["stats"], [])
        self.assertEqual(apps["runs"]["stats"], [])
        self.assertEqual(apps["fitness"]["stats"][0]["value"], "Fresh start")

    # ---- the personal message ---------------------------------------------------------------

    def test_message_for_an_upcoming_race(self) -> None:
        self.add_races([("1", "Turin Half-marathon", 21.1, "2026-11", "planned")])
        self.assertEqual(personal_message(OWNER, self.folder, TODAY), "Turin Half-marathon is this month. Trust the training.")
        self.add_races([("2", "Berlin Half-marathon", 21.1, "2026-12", "planned")])
        with closing(sqlite3.connect(self.folder / "runs.sqlite3")) as connection:
            connection.execute("DELETE FROM races WHERE id='1'")
            connection.commit()
        self.assertIn("next month", personal_message(OWNER, self.folder, TODAY))
        with closing(sqlite3.connect(self.folder / "runs.sqlite3")) as connection:
            connection.execute("UPDATE races SET race_date='2027-04' WHERE id='2'")
            connection.commit()
        self.assertEqual(personal_message(OWNER, self.folder, TODAY),
                         "Berlin Half-marathon is 5 months away. Plenty of time to build.")

    def test_message_for_the_weekly_fitness_goal(self) -> None:
        self.add_workouts([("2026-11-16", 40), ("2026-11-18", 35), ("2026-11-19", 30)])
        self.assertEqual(personal_message(LIMITED, self.folder, TODAY), "105 of 150 minutes this week, 45 to go.")
        self.add_workouts([("2026-11-20", 50)])
        self.assertEqual(personal_message(LIMITED, self.folder, TODAY),
                         "Weekly goal reached: 155 of 150 minutes. Enjoy the rest!")

    def test_message_mentions_a_streak_worth_keeping(self) -> None:
        self.add_workouts([("2026-11-17", 20), ("2026-11-18", 20), ("2026-11-19", 20), ("2026-11-20", 20)])
        self.assertTrue(personal_message(LIMITED, self.folder, TODAY).endswith("Your 4-day streak is going strong."))

    def test_message_for_a_fresh_week(self) -> None:
        self.add_workouts([("2026-11-10", 60)])  # last week only
        self.assertEqual(personal_message(LIMITED, self.folder, TODAY), "A fresh week: 150 minutes to go.")

    def test_message_uses_the_users_own_goal(self) -> None:
        self.add_workouts([("2026-11-19", 100)], goal=120)
        self.assertEqual(personal_message(LIMITED, self.folder, TODAY), "100 of 120 minutes this week, 20 to go.")

    def test_message_falls_back_to_travel_then_a_greeting(self) -> None:
        self.assertEqual(personal_message(LIMITED, self.folder, TODAY), "Good to see you.")
        roam.prepare_database(self.folder / "roam.sqlite3")
        with closing(sqlite3.connect(self.folder / "roam.sqlite3")) as connection:
            connection.execute("INSERT INTO country_states (country_id, status) VALUES ('ITA', 'visited')")
            connection.commit()
        self.assertEqual(personal_message(LIMITED, self.folder, TODAY), "You've visited 1 country. Where to next?")

    def test_one_person_never_gets_a_message_about_an_app_they_lack(self) -> None:
        self.add_races([("1", "Turin Half-marathon", 21.1, "2026-11", "planned")])
        self.assertNotIn("Turin", personal_message(LIMITED, self.folder, TODAY))  # no My Runs

    # ---- the highlight card -----------------------------------------------------------------

    def test_highlight_is_the_next_race_or_this_weeks_progress(self) -> None:
        self.assertIsNone(highlight(LIMITED, self.folder, TODAY))
        self.add_workouts([("2026-11-19", 45), ("2026-11-20", 30)])
        card = highlight(LIMITED, self.folder, TODAY)
        self.assertEqual((card["kicker"], card["title"], card["detail"]), ("This week", "75 of 150 min", "2 workouts · 2-day streak"))
        self.add_races([("1", "Turin Half-marathon", 21.1, "2026-11", "planned")])
        self.assertEqual(highlight(OWNER, self.folder, TODAY)["title"], "Turin Half-marathon")

    def test_month_arithmetic(self) -> None:
        self.assertEqual(months_between(TODAY, "2026-11"), 0)
        self.assertEqual(months_between(TODAY, "2027-01-15"), 2)
        self.assertEqual(months_between(TODAY, "2026-09"), -2)
