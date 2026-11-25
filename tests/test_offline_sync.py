import socket
import ssl
import stat
from pathlib import Path
from unittest.mock import patch

from cryptography import x509
from main import create_app, lan_bind_address
from pwa import ensure_tls_certificate
from tests.helpers import HOST, TempDirectoryCase, sign_in


class OfflineSyncTests(TempDirectoryCase):
    def setUp(self) -> None:
        super().setUp()
        self.data = self.root / "data"
        self.client = create_app(self.data, massive_key="").test_client()
        sign_in(self.client)

    def request(self, method: str, path: str, **kwargs):
        return getattr(self.client, method)(path, base_url=HOST, **kwargs)

    def test_pwa_routes_are_public_and_html_registers_the_client(self) -> None:
        manifest = self.request("get", "/manifest.webmanifest")
        self.assertEqual(manifest.status_code, 200)
        self.assertEqual(manifest.mimetype, "application/manifest+json")
        self.assertIn("default-src 'self'", manifest.headers["Content-Security-Policy"])
        manifest.close()

        worker = self.request("get", "/service-worker.js")
        self.assertEqual(worker.status_code, 200)
        self.assertEqual(worker.headers["Service-Worker-Allowed"], "/")
        worker.close()

        page = self.request("get", "/")
        self.assertIn(b"/manifest.webmanifest", page.data)
        self.assertIn(b"/shared/pwa.js", page.data)
        page.close()

    def test_ios_setup_downloads_only_the_public_ca_certificate(self) -> None:
        ensure_tls_certificate(self.data, "hub.local")
        response = self.request("get", "/setup/ios/certificate")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/x-x509-ca-cert")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        certificate = x509.load_pem_x509_certificate(response.data)
        constraints = certificate.extensions.get_extension_for_class(x509.BasicConstraints).value
        self.assertTrue(constraints.ca)
        response.close()

    def test_fuad_snapshot_uses_per_user_revision_compare_and_swap(self) -> None:
        origin = {"Origin": HOST}
        empty = self.request("get", "/api/offline/fuad").get_json()
        self.assertEqual(empty, {"payload": None, "revision": 0})
        database = self.data / "users" / "owner" / "offline-sync.sqlite3"
        self.assertEqual(stat.S_IMODE(database.stat().st_mode), 0o600)

        payload = {"version": 1, "car": {}, "expenses": [], "reminders": []}
        saved = self.request(
            "put",
            "/api/offline/fuad",
            json={"payload": payload, "expected_revision": 0},
            headers=origin,
        )
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.get_json()["revision"], 1)

        stale = self.request(
            "put",
            "/api/offline/fuad",
            json={"payload": payload, "expected_revision": 0},
            headers=origin,
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.get_json()["payload"], payload)

    def test_offline_edit_detects_a_laptop_change_to_the_same_record(self) -> None:
        origin = {"Origin": HOST}
        trip = {
            "country_id": "ITA",
            "title": "Rome",
            "start_date": "2026-06-01",
            "end_date": "2026-06-02",
            "notes": "",
        }
        created = self.request("post", "/roam/api/trips", json=trip, headers=origin)
        trip_id = created.get_json()["id"]
        revision = int(created.headers["X-Hub-Revision"])

        laptop_edit = {**trip, "title": "Rome, updated"}
        self.assertEqual(
            self.request(
                "put",
                f"/roam/api/trips/{trip_id}",
                json=laptop_edit,
                headers=origin,
            ).status_code,
            200,
        )

        phone_edit = {**trip, "title": "Rome, offline"}
        conflict = self.request(
            "put",
            f"/roam/api/trips/{trip_id}",
            json=phone_edit,
            headers={
                **origin,
                "X-Hub-Sync-Revision": str(revision),
                "X-Hub-Sync-Entity": f"/roam/api/trips/{trip_id}",
                "X-Hub-Sync-Device": "phone",
            },
        )
        self.assertEqual(conflict.status_code, 409)

        forced = self.request(
            "put",
            f"/roam/api/trips/{trip_id}",
            json=phone_edit,
            headers={
                **origin,
                "X-Hub-Sync-Revision": str(revision),
                "X-Hub-Sync-Entity": f"/roam/api/trips/{trip_id}",
                "X-Hub-Sync-Device": "phone",
                "X-Hub-Sync-Force": "1",
            },
        )
        self.assertEqual(forced.status_code, 200)
        self.assertEqual(
            self.request("get", "/roam/api/bootstrap").get_json()["trips"][0]["title"],
            "Rome, offline",
        )

    def test_retried_sync_operation_is_idempotent(self) -> None:
        origin = {"Origin": HOST}
        trip = {
            "country_id": "ITA",
            "title": "Rome",
            "start_date": "2026-06-01",
            "end_date": "2026-06-02",
            "notes": "",
        }
        trip_id = self.request("post", "/roam/api/trips", json=trip, headers=origin).get_json()["id"]
        revision = int(self.request("get", "/roam/api/bootstrap").headers["X-Hub-Revision"])
        sync_headers = {
            **origin,
            "X-Hub-Sync-Revision": str(revision),
            "X-Hub-Sync-Entity": f"/roam/api/trips/{trip_id}",
            "X-Hub-Sync-Device": "phone",
            "X-Hub-Sync-Operation": "phone-operation-1",
        }
        phone_edit = {**trip, "title": "Phone copy"}
        first = self.request("put", f"/roam/api/trips/{trip_id}", json=phone_edit, headers=sync_headers)
        self.assertEqual(first.status_code, 200)

        laptop_edit = {**trip, "title": "Laptop copy"}
        self.request("put", f"/roam/api/trips/{trip_id}", json=laptop_edit, headers=origin)
        retried = self.request(
            "put",
            f"/roam/api/trips/{trip_id}",
            json=phone_edit,
            headers=sync_headers,
        )
        self.assertEqual(retried.status_code, 200)
        current = self.request("get", "/roam/api/bootstrap").get_json()["trips"][0]
        self.assertEqual(current["title"], "Laptop copy")

    def test_local_tls_certificate_matches_the_configured_hostname(self) -> None:
        cert, key = ensure_tls_certificate(self.root / "tls", "hub.local")
        self.assertTrue(Path(cert).is_file())
        self.assertEqual(stat.S_IMODE(Path(key).stat().st_mode), 0o600)
        ca_key = Path(cert).with_name("hub-ca.key")
        self.assertEqual(stat.S_IMODE(ca_key.stat().st_mode), 0o600)
        details = ssl._ssl._test_decode_cert(cert)
        self.assertIn(("DNS", "hub.local"), details["subjectAltName"])

    def test_bind_address_falls_back_to_ipv6_without_a_usable_ipv4_lan(self) -> None:
        def routed(translated_ipv4: str, ipv6: str):
            return lambda family, target: translated_ipv4 if family == socket.AF_INET else ipv6

        cases = [
            ("172.20.10.2", "", "172.20.10.2"),
            ("192.168.1.5", "2001:db8::5", "192.168.1.5"),
            ("192.0.0.2", "2001:db8::5", "::"),
            ("", "", "127.0.0.1"),
        ]
        for ipv4, ipv6, expected in cases:
            with self.subTest(ipv4=ipv4, ipv6=ipv6), patch("main._routed_address", routed(ipv4, ipv6)):
                self.assertEqual(lan_bind_address(), expected)


if __name__ == "__main__":
    import unittest

    unittest.main()
