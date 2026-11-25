import unittest
from datetime import date

from tests.helpers import fake_credential
from trading import create_app
from trading.market_data import DailyBar, MarketDataError


def bars(*days: int) -> list[DailyBar]:
    return [DailyBar(date(2026, 11, day), 100.0, 105.0, 99.0, 100.0 + day, 1000.0 + day) for day in days]


class FakeMassive:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.history_error: str | None = None

    def __call__(self, path: str, key: str) -> list[DailyBar]:
        self.calls.append((path, key))
        if "/prev" in path:
            return bars(18)
        if self.history_error:
            raise MarketDataError(self.history_error)
        return bars(16, 17, 18)


class TradingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.massive = FakeMassive()
        self.now = 0.0
        self.client = create_app("", self.massive, lambda: self.now).test_client()

    def get(self, query: str = "days=90", key: str | None = "test-key"):
        return self.client.get(f"/api/pg?{query}", headers={"X-Massive-Key": key} if key else {})

    def test_returns_previous_day_and_history(self) -> None:
        data = self.get().get_json()
        self.assertEqual(data["previous"]["close"], 118.0)
        self.assertEqual([bar["day"] for bar in data["history"]], ["2026-11-16", "2026-11-17", "2026-11-18"])
        self.assertIsNone(data["history_error"])
        self.assertIn("range/1/day/2026-08-20/2026-11-18", self.massive.calls[1][0])
        self.assertEqual({key for _, key in self.massive.calls}, {"test-key"})

    def test_missing_key_and_bad_period_do_not_call_massive(self) -> None:
        self.assertEqual(self.get(key=None).status_code, 400)
        self.assertEqual(self.get("days=7").status_code, 400)
        self.assertEqual(self.get("days=abc").status_code, 400)
        self.assertEqual(self.massive.calls, [])

    def test_server_side_key_is_used_when_none_is_sent(self) -> None:
        client = create_app("server-key", self.massive).test_client()
        self.assertTrue(client.get("/api/config").get_json()["server_key"])
        self.assertEqual(client.get("/api/pg").status_code, 200)
        self.assertEqual(self.massive.calls[0][1], "server-key")

    def test_responses_are_cached_for_five_minutes_and_refreshable(self) -> None:
        self.get()
        self.get()
        self.assertEqual(len(self.massive.calls), 2)  # one previous-day + one history call
        self.get("days=90&refresh=1")
        self.assertEqual(len(self.massive.calls), 4)
        self.now = 301
        self.get()
        self.assertEqual(len(self.massive.calls), 6)
        self.get("days=30")  # a different period is a different cache entry
        self.assertEqual(len(self.massive.calls), 8)

    def test_history_failure_still_returns_the_overview_and_is_not_cached(self) -> None:
        self.massive.history_error = "Massive rate limit reached."
        data = self.get().get_json()
        self.assertEqual(data["previous"]["close"], 118.0)
        self.assertEqual(data["history"], [])
        self.assertIn("rate limit", data["history_error"])
        self.massive.history_error = None
        self.assertIsNone(self.get().get_json()["history_error"])

    def test_upstream_errors_become_a_clear_502_without_leaking_the_key(self) -> None:
        def failing(path: str, key: str):
            raise MarketDataError("API key rejected. Check your Massive API key.")
        key = fake_credential("key")
        response = create_app("", failing).test_client().get("/api/pg", headers={"X-Massive-Key": key})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn(key.encode(), response.data)

    def test_page_and_headers(self) -> None:
        for path in ("/", "/static/app.js", "/static/style.css", "/static/icon.svg"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            response.close()
        self.assertEqual(self.get().headers["Cache-Control"], "no-store")


if __name__ == "__main__":
    unittest.main()
