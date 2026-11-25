"""How much you trained between races, worked out from the cached Strava summaries."""

from collections import defaultdict
from datetime import date, timedelta
from itertools import pairwise

RUN_SPORTS = {"Run", "TrailRun", "VirtualRun"}
MID_MONTH = 15  # a race known only by its month is placed mid-month, and the result is flagged approximate


def race_day(value: str) -> tuple[date, bool]:
    """The day of a race date (YYYY-MM-DD or YYYY-MM) and whether it was only a month."""
    if len(value) == 7:
        return date(int(value[:4]), int(value[5:7]), MID_MONTH), True
    return date.fromisoformat(value), False


def summarize(rows: list[tuple], start: date, end: date) -> dict:
    """Totals for the days start..end. Each row is (day, sport_type, distance_m, moving_s, elevation_m)."""
    days = (end - start).days + 1
    result = {}
    for key, wanted in (("runs", lambda sport: sport in RUN_SPORTS), ("all", lambda sport: True)):
        chosen = [row for row in rows if wanted(row[1])]
        distance = sum(row[2] for row in chosen) / 1000
        moving = sum(row[3] for row in chosen)
        weeks: dict[date, float] = defaultdict(float)
        for day, _, metres, _, _ in chosen:
            parsed = date.fromisoformat(day)
            weeks[parsed - timedelta(days=parsed.weekday())] += metres / 1000
        result[key] = {
            "count": len(chosen),
            "distance_km": round(distance, 1),
            "moving_seconds": moving,
            "elevation_m": round(sum(row[4] for row in chosen)),
            "longest_km": round(max((row[2] for row in chosen), default=0) / 1000, 1),
            # Pace only makes sense for running, where distance and time are comparable.
            "pace_seconds_per_km": round(moving / distance) if key == "runs" and distance > 0 else None,
            "weekly_avg_km": round(distance / (days / 7), 1),
            "peak_week_km": round(max(weeks.values(), default=0), 1),
        }
    return {"start": start.isoformat(), "end": end.isoformat(), "days": days, **result}


def window(first: str, last: str | None, today: date) -> tuple[date, date, bool] | None:
    """Training days strictly after the `first` race up to the day before `last` (or today)."""
    first_day, first_approx = race_day(first)
    if last is None:
        end, last_approx = today, False
    else:
        last_day, last_approx = race_day(last)
        end = last_day - timedelta(days=1)
    start = first_day + timedelta(days=1)
    return (start, end, first_approx or last_approx) if start <= end else None


def consecutive(races: list[dict], today: date) -> dict[str, dict]:
    """For every run race after the first: its window since the previous run race.
    The earliest upcoming planned race gets the window since your last race, up to today."""
    dated = sorted((race for race in races if race["status"] == "run" and race["race_date"]),
                   key=lambda race: (race_day(race["race_date"])[0], race["title"]))
    windows: dict[str, dict] = {}
    for previous, race in pairwise(dated):
        span = window(previous["race_date"], race["race_date"], today)
        if span:
            windows[race["id"]] = {"span": span, "since": previous}
    upcoming = sorted((race for race in races if race["status"] == "planned" and race["race_date"]
                       and race_day(race["race_date"])[0] >= today.replace(day=1)),
                      key=lambda race: (race_day(race["race_date"])[0], race["title"]))
    if dated and upcoming:
        span = window(dated[-1]["race_date"], None, today)
        if span:
            windows[upcoming[0]["id"]] = {"span": span, "since": dated[-1], "so_far": True}
    return windows
