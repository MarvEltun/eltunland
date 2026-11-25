"""Small read-only Strava client. Activity responses are never persisted."""

import json
import os
import ssl
from collections.abc import Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API = "https://www.strava.com/api/v3"
TOKEN_URL = "https://www.strava.com/oauth/token"
DEAUTHORIZE_URL = "https://www.strava.com/oauth/deauthorize"
SCOPES = "read,activity:read_all"
PAGE_SIZE = 30
LOCAL_CA_BUNDLE = Path(__file__).resolve().parent.parent / "data" / "ca-bundle.pem"


class StravaError(Exception):
    def __init__(self, message: str, status: int = 502, rate: dict | None = None, *, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.rate = rate or {}
        self.code = code


def rate_limits(headers: Mapping) -> dict:
    result = {}
    for kind, prefix in (("read", "X-ReadRateLimit"), ("overall", "X-RateLimit")):
        for field in ("Limit", "Usage"):
            raw = headers.get(f"{prefix}-{field}", "")
            values = [part.strip() for part in raw.split(",")]
            if len(values) == 2 and all(value.isdigit() for value in values):
                result[f"{kind}_{field.lower()}"] = [int(value) for value in values]
    return result


def http_json(
    method: str, url: str, *, data: dict | None = None, token: str | None = None
) -> tuple[object, dict]:
    headers = {"Accept": "application/json", "User-Agent": "MyActivities-local/1.0"}
    body = None
    if data is not None:
        body = urlencode(data).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = Request(url, data=body, headers=headers, method=method)
    ca_bundle = os.environ.get("SSL_CERT_FILE") or (
        str(LOCAL_CA_BUNDLE) if LOCAL_CA_BUNDLE.is_file() else None
    )
    try:
        context = ssl.create_default_context(cafile=ca_bundle)
    except OSError:
        raise StravaError(
            "Could not load the trusted HTTPS CA bundle. Check SSL_CERT_FILE or "
            "data/ca-bundle.pem and restart the local server.",
            503, code="tls_failed",
        ) from None
    try:
        with urlopen(req, timeout=20, context=context) as response:
            rate = rate_limits(response.headers)
            raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise StravaError("Strava returned an unexpectedly large response.")
    except HTTPError as error:
        rate = rate_limits(error.headers)
        scope_missing = False
        if error.code in (401, 403):
            # Only a fixed marker is read from the body; nothing from it is shown or kept.
            with suppress(OSError):
                scope_missing = "activity:read_permission" in error.read(16 * 1024).decode("utf-8", "replace")
        messages = {
            400: "Strava rejected the request. Check your API application credentials or reconnect.",
            401: "Your Strava authorization expired or was revoked. Please reconnect.",
            403: "Strava denied access. Check your permissions, subscription and API application eligibility.",
            404: "This activity is no longer available on Strava.",
            429: "Strava's API rate limit has been reached. Wait for the next limit window before retrying.",
        }
        status = error.code if error.code in (400, 401, 403, 404, 429) else 502
        error.close()
        if scope_missing:
            raise StravaError(
                "This Strava token can't read activities: it was not granted the activity:read_all "
                "permission. Use Authorize with Strava to grant it.", 401, rate, code="scope_missing",
            ) from None
        raise StravaError(messages.get(status, "Strava is temporarily unavailable. Try again later."), status, rate) from None
    except (URLError, TimeoutError, ssl.SSLCertVerificationError) as error:
        reason = error.reason if isinstance(error, URLError) else error
        if isinstance(reason, ssl.SSLCertVerificationError):
            raise StravaError(
                "Could not verify Strava's HTTPS certificate. Configure Python's trusted CA "
                "bundle (SSL_CERT_FILE) and restart the local server. Do not disable certificate verification.",
                503, code="tls_failed",
            ) from None
        raise StravaError("Could not reach Strava. Check your internet connection and try again.", 503) from None
    try:
        return json.loads(raw), rate
    except (ValueError, UnicodeDecodeError):
        raise StravaError("Strava returned an invalid response. Please try again later.") from None


Transport = Callable[..., tuple[object, dict]]


def tokens_from_response(data: object) -> dict:
    if not isinstance(data, dict):
        raise StravaError("Strava returned an invalid authorization response.")
    access = data.get("access_token")
    refresh = data.get("refresh_token")
    expires = data.get("expires_at")
    if (
        not isinstance(access, str) or not access
        or not isinstance(refresh, str) or not refresh
        or type(expires) is not int or expires <= 0
    ):
        raise StravaError("Strava did not return valid access and refresh tokens. Please reconnect.")
    return {"access_token": access, "refresh_token": refresh, "expires_at": expires, "athlete": data.get("athlete")}


def public_profile(data: object, athlete_id: int) -> dict:
    if not isinstance(data, dict) or data.get("id") != athlete_id:
        raise StravaError("Strava returned an unexpected athlete profile.")
    return {key: data.get(key) for key in ("id", "firstname", "lastname", "city", "state", "country")}


ACTIVITY_FIELDS = (
    "id", "name", "sport_type", "type", "distance", "moving_time", "elapsed_time",
    "total_elevation_gain", "start_date", "start_date_local", "timezone",
    "average_speed", "max_speed", "average_heartrate", "max_heartrate",
    "average_cadence", "average_watts", "max_watts", "kilojoules", "calories",
    "trainer", "commute", "manual", "visibility", "device_name",
    "description", "elev_high", "elev_low",
)


def public_activity(data: object, athlete_id: int) -> dict:
    if not isinstance(data, dict):
        raise StravaError("Strava returned an invalid activity.")
    owner = data.get("athlete")
    if not isinstance(owner, dict) or owner.get("id") != athlete_id:
        raise StravaError("The activity does not belong to the connected athlete.", 403)
    if type(data.get("id")) is not int or data["id"] <= 0:
        raise StravaError("Strava returned an activity without a valid ID.")
    result = {key: data.get(key) for key in ACTIVITY_FIELDS}
    route = data.get("map")
    result["polyline"] = (
        route.get("polyline") or route.get("summary_polyline") or ""
        if isinstance(route, dict) else ""
    )
    gear = data.get("gear")
    result["gear"] = gear.get("name") if isinstance(gear, dict) else None
    return result


@dataclass
class StravaClient:
    transport: Transport

    def exchange(self, client_id: str, client_secret: str, **fields) -> dict:
        data, _ = self.transport("POST", TOKEN_URL, data={
            "client_id": client_id, "client_secret": client_secret, **fields,
        })
        return tokens_from_response(data)

    def get(self, path: str, token: str) -> tuple[object, dict]:
        return self.transport("GET", f"{API}/{path}", token=token)

    def deauthorize(self, token: str) -> None:
        self.transport("POST", DEAUTHORIZE_URL, data={"access_token": token})
