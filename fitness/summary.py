"""Weekly totals and streaks. Pure functions, shared by the app and the home page."""

from collections.abc import Iterable
from datetime import date, timedelta


def week_start(today: date) -> date:
    """The Monday of the week containing `today`."""
    return today - timedelta(days=today.weekday())


def minutes_between(workouts: Iterable[tuple[str, int]], start: date, end: date) -> int:
    """Total minutes for (ISO day, minutes) pairs falling in start..end inclusive."""
    first, last = start.isoformat(), end.isoformat()
    return sum(minutes for day, minutes in workouts if first <= day <= last)


def current_streak(days: set[str], today: date) -> int:
    """Consecutive days with a workout, ending today or yesterday (so today can still be won)."""
    day = today if today.isoformat() in days else today - timedelta(days=1)
    streak = 0
    while day.isoformat() in days:
        streak += 1
        day -= timedelta(days=1)
    return streak
