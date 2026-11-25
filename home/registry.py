"""The home page content for one signed-in user: their apps, headline numbers, and a personal message.

Everything is read from that user's own files in read-only mode, so the home page can
never change anything. Only a count of cached Strava summaries is read, never tokens or activity details.
MyFuad keeps its data in the browser, so it has no numbers here.
"""

import sqlite3
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from accounts import Account
from core import PREFIXES
from fitness.summary import current_streak, minutes_between, week_start


@dataclass(frozen=True)
class AppSpec:
    key: str
    name: str
    tagline: str
    group: str
    shortcuts: tuple[tuple[str, str], ...] = ()

    @property
    def url(self) -> str:
        return PREFIXES[self.key] + "/"


def chip(value: str | int, label: str) -> dict:
    return {"value": str(value), "label": label}


def read_rows(path: Path, sql: str, params: tuple = ()) -> list[tuple]:
    """Run a read-only query; a missing file or schema yields no rows."""
    if not path.is_file():
        return []
    try:
        with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=1)) as connection:
            return connection.execute(sql, params).fetchall()
    except sqlite3.Error:
        return []


def count(path: Path, sql: str, params: tuple = ()) -> int:
    rows = read_rows(path, sql, params)
    return rows[0][0] if rows else 0


def month_label(value: str) -> str:
    return date(int(value[:4]), int(value[5:7]), 1).strftime("%b %Y")


def months_between(today: date, value: str) -> int:
    return int(value[:4]) * 12 + int(value[5:7]) - (today.year * 12 + today.month)


def next_race(user_dir: Path, today: date) -> tuple[str, str] | None:
    rows = read_rows(
        user_dir / "runs.sqlite3",
        "SELECT title, race_date FROM races WHERE status='planned' AND race_date >= ? ORDER BY race_date LIMIT 1",
        (today.isoformat()[:7],),
    )
    return rows[0] if rows else None


def fitness_week(user_dir: Path, today: date) -> dict | None:
    """This week's totals, or None if nothing has ever been logged."""
    database = user_dir / "fitness.sqlite3"
    rows = read_rows(database, "SELECT day, minutes FROM workouts")
    if not rows:
        return None
    goal_rows = read_rows(database, "SELECT value FROM settings WHERE key='goal_minutes'")
    start = week_start(today)
    return {
        "minutes": minutes_between(rows, start, today),
        "goal": int(goal_rows[0][0]) if goal_rows else 150,
        "workouts": sum(1 for day, _ in rows if start.isoformat() <= day <= today.isoformat()),
        "streak": current_streak({day for day, _ in rows}, today),
    }


def roam_stats(user_dir: Path, today: date) -> list[dict]:
    database = user_dir / "roam.sqlite3"
    if not database.is_file():
        return []
    try:
        lines = (user_dir / "flights.tsv").read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    flights = max(0, sum(1 for line in lines if line.strip()) - 1)
    return [
        chip(count(database, "SELECT COUNT(*) FROM country_states WHERE status='visited'"), "countries visited"),
        chip(count(database, "SELECT COUNT(*) FROM stadiums"), "stadiums"),
        chip(flights, "flights logged"),
    ]


def runs_stats(user_dir: Path, today: date) -> list[dict]:
    database = user_dir / "runs.sqlite3"
    if not database.is_file():
        return []
    run = read_rows(database, "SELECT COUNT(*), COALESCE(SUM(distance_km), 0) FROM races WHERE status='run'")
    races, km = run[0] if run else (0, 0)
    stats = [chip(races, "races run"), chip(f"{km:.1f} km", "raced")]
    upcoming = next_race(user_dir, today)
    if upcoming:
        stats.append(chip(upcoming[0], f"next · {month_label(upcoming[1])}"))
    synced = count(user_dir / "activities.sqlite3", "SELECT COUNT(*) FROM activities")
    if synced:
        stats.append(chip(synced, "Strava activities synced"))
    return stats


def fitness_stats(user_dir: Path, today: date) -> list[dict]:
    week = fitness_week(user_dir, today)
    if not week:
        return [chip("Fresh start", "log your first workout")]
    stats = [chip(f"{week['minutes']}/{week['goal']}", "min this week")]
    if week["streak"]:
        stats.append(chip(week["streak"], "day streak"))
    return stats


def fuad_stats(user_dir: Path, today: date) -> list[dict]:
    return [chip("Private", "data stays in your browser")]


def trading_stats(user_dir: Path, today: date) -> list[dict]:
    return [chip("PG", "daily bars via Massive")]


APPS: tuple[tuple[AppSpec, Callable[[Path, date], list[dict]]], ...] = (
    (AppSpec(
        "roam", "Roam", "Travel map, bucket list, trip journal, flights and stadiums.", "travel",
        (("Flights", "static/flights.html"),),
    ), roam_stats),
    (AppSpec(
        "runs", "My Runs", "Race log and Strava activities: what you've run, what's next, and your training.", "fitness",
        (("Activities", "activities/"),),
    ), runs_stats),
    (AppSpec(
        "fitness", "myFitness", "Workouts, a weekly goal, streaks and trends.", "fitness",
    ), fitness_stats),
    (AppSpec(
        "fuad", "MyFuad", "Car dashboard: expenses, fuel economy, reminders and a 3D explorer.", "car",
        (("Garage", "#garage"), ("Car explorer", "#explorer")),
    ), fuad_stats),
    (AppSpec(
        "trading", "Trading", "Procter & Gamble daily stock dashboard.", "markets",
    ), trading_stats),
)


def personal_message(account: Account, user_dir: Path, today: date) -> str:
    """One friendly sentence drawn from what this person actually has going on."""
    race = next_race(user_dir, today) if "runs" in account.apps else None
    if race:
        title, race_date = race
        months = months_between(today, race_date)
        if months <= 0:
            return f"{title} is this month. Trust the training."
        if months == 1:
            return f"{title} is next month. Keep building."
        return f"{title} is {months} months away. Plenty of time to build."
    week = fitness_week(user_dir, today) if "fitness" in account.apps else None
    if week:
        minutes, goal, streak = week["minutes"], week["goal"], week["streak"]
        if minutes >= goal:
            return f"Weekly goal reached: {minutes} of {goal} minutes. Enjoy the rest!"
        tail = f" Your {streak}-day streak is going strong." if streak >= 3 else ""
        if minutes == 0:
            return f"A fresh week: {goal} minutes to go.{tail}"
        return f"{minutes} of {goal} minutes this week, {goal - minutes} to go.{tail}"
    visited = count(user_dir / "roam.sqlite3", "SELECT COUNT(*) FROM country_states WHERE status='visited'") \
        if "roam" in account.apps else 0
    if visited:
        return f"You've visited {visited} {'country' if visited == 1 else 'countries'}. Where to next?"
    return "Good to see you."


def highlight(account: Account, user_dir: Path, today: date) -> dict | None:
    """The one thing worth a glance at the top of the page."""
    race = next_race(user_dir, today) if "runs" in account.apps else None
    if race:
        return {"kicker": "Next race", "title": race[0], "detail": month_label(race[1]), "icon": "flag"}
    week = fitness_week(user_dir, today) if "fitness" in account.apps else None
    if week:
        detail = f"{week['workouts']} workout{'s' if week['workouts'] != 1 else ''}"
        if week["streak"]:
            detail += f" · {week['streak']}-day streak"
        return {"kicker": "This week", "title": f"{week['minutes']} of {week['goal']} min", "detail": detail, "icon": "pulse"}
    return None


def describe(spec: AppSpec, stats: Callable[[Path, date], list[dict]], user_dir: Path, today: date) -> dict:
    return {
        "key": spec.key,
        "name": spec.name,
        "tagline": spec.tagline,
        "group": spec.group,
        "url": spec.url,
        "stats": stats(user_dir, today),
        "shortcuts": [{"label": label, "url": spec.url + path} for label, path in spec.shortcuts],
    }


def home_for(account: Account, user_dir: Path, today: date | None = None) -> dict:
    today = today or date.today()
    return {
        "user": account.public(),
        "message": personal_message(account, user_dir, today),
        "highlight": highlight(account, user_dir, today),
        "apps": [describe(spec, stats, user_dir, today) for spec, stats in APPS if spec.key in account.apps],
    }
