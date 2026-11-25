"""Shared test helpers: temporary data folders and signing in as a user."""

import os
import secrets
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import accounts

HOST = "http://127.0.0.1:5173"
accounts.PBKDF2_ROUNDS = 1_000  # real PINs use 200,000 rounds; tests only need the behaviour


def sign_in(client, username: str = "owner", pin: str = "1234", host: str = HOST):
    """Create the user's PIN on first use, otherwise sign in with it. Returns the response."""
    headers = {"Origin": host}
    response = client.post("/api/pin", json={"username": username, "pin": pin}, base_url=host, headers=headers)
    if response.status_code == 409:
        response = client.post("/api/login", json={"username": username, "pin": pin}, base_url=host, headers=headers)
    return response


def fake_credential(label: str) -> str:
    """A throwaway value for tests, made fresh each run, so no secret-looking literal sits in the source."""
    return f"{label}-{secrets.token_hex(8)}"


class TempDirectoryCase(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix="hub-test-", dir=os.environ.get("TMPDIR"))
        self.root = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)
        # Strava details in the developer's own shell must not leak into the tests.
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        for name in [name for name in os.environ if name.startswith("STRAVA_")]:
            del os.environ[name]
