"""Dashboard numbers for the Activities tab, worked out from the cached activity summaries."""

from collections import defaultdict
from datetime import date, timedelta

RUN_SPORTS = {"Run", "TrailRun", "VirtualRun"}
PERIODS = (90, 180, 365, 0)  # days; 0 means everything
CALENDAR_WEEKS = 53


def monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def totals(rows: list[tuple]) -> dict:
    return {
        "count": len(rows),
        "distance_km": round(sum(row[2] for row in rows) / 1000, 1),
        "moving_seconds": sum(row[3] for row in rows),
        "elevation_m": round(sum(row[4] for row in rows)),
        "active_days": len({row[0] for row in rows}),
    }


def longest_run_of(days: list[date], step: timedelta) -> int:
    """The longest chain of consecutive periods (days or weeks) in a sorted list."""
    best = current = 0
    previous = None
    for item in days:
        current = current + 1 if previous is not None and item - previous == step else 1
        best = max(best, current)
        previous = item
    return best


def live_streak(periods: set[date], latest: date, step: timedelta) -> int:
    """Consecutive periods up to `latest`, or up to the one before it when `latest` is still empty."""
    cursor = latest if latest in periods else latest - step
    count = 0
    while cursor in periods:
        count += 1
        cursor -= step
    return count


def build(rows: list[tuple], today: date, days: int) -> dict:
    """rows are (day, sport_type, distance_m, moving_s, elevation_m) for every cached activity."""
    parsed = [(date.fromisoformat(row[0]), *row[1:]) for row in rows]
    if not parsed:
        return {"empty": True, "days": days}
    first = min(row[0] for row in parsed)
    start = first if days == 0 else today - timedelta(days=days - 1)
    in_period = [row for row in parsed if start <= row[0] <= today]
    result: dict = {
        "empty": False, "days": days, "start": start.isoformat(), "end": today.isoformat(),
        "totals": totals(in_period),
    }
    if days:
        before = [row for row in parsed if start - timedelta(days=days) <= row[0] < start]
        result["previous"] = totals(before) if before else None

    weeks: dict[date, dict] = {}
    cursor = monday(start)
    while cursor <= today:
        weeks[cursor] = {"start": cursor.isoformat(), "runs_km": 0.0, "other_km": 0.0, "count": 0, "seconds": 0}
        cursor += timedelta(days=7)
    for day, sport, metres, moving, _ in in_period:
        week = weeks[monday(day)]
        week["runs_km" if sport in RUN_SPORTS else "other_km"] += metres / 1000
        week["count"] += 1
        week["seconds"] += moving
    result["weeks"] = [{**week, "runs_km": round(week["runs_km"], 1), "other_km": round(week["other_km"], 1)}
                       for week in weeks.values()]

    sports: dict[str, dict] = defaultdict(lambda: {"count": 0, "distance_km": 0.0, "moving_seconds": 0, "elevation_m": 0.0})
    for _, sport, metres, moving, climb in in_period:
        entry = sports[sport]
        entry["count"] += 1
        entry["distance_km"] += metres / 1000
        entry["moving_seconds"] += moving
        entry["elevation_m"] += climb
    result["sports"] = sorted(
        ({"sport": sport, **{key: round(value, 1) for key, value in entry.items()}} for sport, entry in sports.items()),
        key=lambda entry: (-entry["moving_seconds"], entry["sport"]),
    )

    months: dict[str, dict] = {}
    for day, sport, metres, moving, _ in in_period:
        entry = months.setdefault(day.strftime("%Y-%m"), {"runs_km": 0.0, "run_seconds": 0, "other_km": 0.0, "count": 0})
        entry["count"] += 1
        if sport in RUN_SPORTS:
            entry["runs_km"] += metres / 1000
            entry["run_seconds"] += moving
        else:
            entry["other_km"] += metres / 1000
    result["months"] = [
        {"month": month, "runs_km": round(entry["runs_km"], 1), "other_km": round(entry["other_km"], 1),
         "count": entry["count"],
         "run_pace_seconds_per_km": round(entry["run_seconds"] / entry["runs_km"]) if entry["runs_km"] > 0 else None}
        for month, entry in sorted(months.items())
    ]

    weekdays = [0] * 7
    for day, *_ in in_period:
        weekdays[day.weekday()] += 1
    result["weekdays"] = weekdays

    calendar_start = monday(today) - timedelta(weeks=CALENDAR_WEEKS - 1)
    daily: dict[date, dict] = defaultdict(lambda: {"seconds": 0, "km": 0.0, "count": 0})
    for day, _, metres, moving, _ in parsed:
        if calendar_start <= day <= today:
            daily[day]["seconds"] += moving
            daily[day]["km"] += metres / 1000
            daily[day]["count"] += 1
    result["calendar"] = {
        "start": calendar_start.isoformat(),
        "days": [{"day": day.isoformat(), "seconds": entry["seconds"], "km": round(entry["km"], 1), "count": entry["count"]}
                 for day, entry in sorted(daily.items())],
    }

    runs = [row for row in parsed if row[1] in RUN_SPORTS]
    week_km: dict[date, float] = defaultdict(float)
    month_km: dict[str, float] = defaultdict(float)
    for day, _, metres, _, _ in runs:
        week_km[monday(day)] += metres / 1000
        month_km[day.strftime("%Y-%m")] += metres / 1000
    longest_run = max(runs, key=lambda row: row[2], default=None)
    longest = max(parsed, key=lambda row: row[2])
    climb = max(parsed, key=lambda row: row[4])
    best_week = max(week_km.items(), key=lambda item: item[1], default=None)
    best_month = max(month_km.items(), key=lambda item: item[1], default=None)
    active_days = sorted({row[0] for row in parsed})
    active_weeks = sorted({monday(day) for day in active_days})
    one_day, one_week = timedelta(days=1), timedelta(days=7)
    result["records"] = {
        "longest_run": {"km": round(longest_run[2] / 1000, 1), "day": longest_run[0].isoformat()} if longest_run else None,
        "longest_activity": {"km": round(longest[2] / 1000, 1), "day": longest[0].isoformat(), "sport": longest[1]},
        "most_climbing": {"m": round(climb[4]), "day": climb[0].isoformat(), "sport": climb[1]},
        "best_run_week": {"km": round(best_week[1], 1), "start": best_week[0].isoformat()} if best_week else None,
        "best_run_month": {"km": round(best_month[1], 1), "month": best_month[0]} if best_month else None,
        "first_activity": first.isoformat(),
        "total_activities": len(parsed),
    }
    result["streaks"] = {
        "current_days": live_streak(set(active_days), today, one_day),
        "best_days": longest_run_of(active_days, one_day),
        "current_weeks": live_streak(set(active_weeks), monday(today), one_week),
        "best_weeks": longest_run_of(active_weeks, one_week),
    }
    return result
