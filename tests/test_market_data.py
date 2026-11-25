import io
import json
import unittest
from datetime import date
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from trading.market_data import MarketDataError, fetch_bars


class MarketDataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.bar = {
            "t": 1605042000000,
            "o": 115.55,
            "h": 117.59,
            "l": 114.13,
            "c": 115.97,
            "v": 131704427,
        }

    def test_prices_date_and_authentication(self) -> None:
        payload = {"status": "OK", "results": [self.bar]}
        with patch("trading.market_data.urlopen", return_value=io.BytesIO(json.dumps(payload).encode())) as fetch:
            bars = fetch_bars("/v2/aggs/ticker/PG/prev?adjusted=true", "test-key")
        self.assertEqual(bars[0].day, date(2020, 11, 10))
        self.assertEqual(bars[0].close, 115.97)
        self.assertEqual(bars[0].volume, 131704427)
        self.assertEqual(fetch.call_args.args[0].get_header("Authorization"), "Bearer test-key")
        self.assertEqual(fetch.call_args.kwargs["timeout"], 20)

    def test_invalid_or_empty_data(self) -> None:
        for payload in [
            {"status": "ERROR"},
            {"status": "OK", "results": []},
            {"status": "OK", "results": [{"c": 100}]},
            {"status": "OK", "results": [{**self.bar, "o": 0}]},
            {"status": "OK", "results": [{**self.bar, "c": float("nan")}]},
        ]:
            with self.subTest(payload=payload), patch(
                "trading.market_data.urlopen", return_value=io.BytesIO(json.dumps(payload).encode())
            ), self.assertRaises(MarketDataError):
                fetch_bars("/test", "test-key")

    def test_delayed_response_with_valid_bars(self) -> None:
        payload = {"status": "DELAYED", "results": [self.bar]}
        with patch(
            "trading.market_data.urlopen", return_value=io.BytesIO(json.dumps(payload).encode())
        ):
            bars = fetch_bars("/test", "test-key")
        self.assertEqual(bars[0].close, 115.97)

    def test_http_and_connection_errors(self) -> None:
        for error, message in [
            (HTTPError("https://api.massive.com", 401, "", None, None), "API key rejected"),
            (HTTPError("https://api.massive.com", 403, "", None, None), "Access denied"),
            (HTTPError("https://api.massive.com", 429, "", None, None), "rate limit"),
            (URLError("offline"), "Could not connect"),
        ]:
            with self.subTest(error=error), patch(
                "trading.market_data.urlopen", side_effect=error
            ), self.assertRaisesRegex(MarketDataError, message):
                fetch_bars("/test", "test-key")

    def test_missing_key_does_not_make_request(self) -> None:
        with patch("trading.market_data.urlopen") as fetch, self.assertRaises(MarketDataError):
            fetch_bars("/test", " ")
        fetch.assert_not_called()

    def test_invalid_json(self) -> None:
        with patch(
            "trading.market_data.urlopen", return_value=io.BytesIO(b"not json")
        ), self.assertRaisesRegex(MarketDataError, "invalid JSON"):
            fetch_bars("/test", "test-key")


if __name__ == "__main__":
    unittest.main()
