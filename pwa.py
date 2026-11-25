"""Progressive Web App routes and local HTTPS certificate setup."""

import ipaddress
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from flask import Flask, Response, abort, jsonify, send_from_directory

from core import SHARED_DIR

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)


def ensure_tls_certificate(data_dir: Path, hostname: str) -> tuple[str, str]:
    """Create a stable local CA and a host certificate signed by it."""
    tls_dir = Path(data_dir) / "tls"
    tls_dir.mkdir(parents=True, exist_ok=True)
    ca_cert_path = tls_dir / "hub-ca.crt"
    ca_key_path = tls_dir / "hub-ca.key"
    cert_path = tls_dir / "hub.crt"
    key_path = tls_dir / "hub.key"
    now = datetime.now(timezone.utc)

    if not ca_cert_path.exists() and not ca_key_path.exists():
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Hub Local Certificate Authority")])
        ca_cert = (
            x509.CertificateBuilder()
            .subject_name(ca_name)
            .issuer_name(ca_name)
            .public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(
                x509.KeyUsage(
                    digital_signature=False,
                    content_commitment=False,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=True,
                    crl_sign=True,
                    encipher_only=None,
                    decipher_only=None,
                ),
                critical=True,
            )
            .sign(ca_key, hashes.SHA256())
        )
        ca_key_path.write_bytes(
            ca_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        ca_cert_path.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    elif not ca_cert_path.is_file() or not ca_key_path.is_file():
        raise RuntimeError("The Hub local CA is incomplete; restore both files from data/tls or remove both to recreate it.")

    ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
    ca_cert = x509.load_pem_x509_certificate(ca_cert_path.read_bytes())
    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    try:
        hostname_san = x509.IPAddress(ipaddress.ip_address(hostname))
    except ValueError:
        hostname_san = x509.DNSName(hostname)
    sans = {
        hostname_san,
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
    }
    server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)])
    server_cert = (
        x509.CertificateBuilder()
        .subject_name(server_name)
        .issuer_name(ca_cert.subject)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(list(sans)), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=None,
                decipher_only=None,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    key_path.write_bytes(
        server_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    cert_path.write_bytes(server_cert.public_bytes(serialization.Encoding.PEM))
    ca_key_path.chmod(0o600)
    key_path.chmod(0o600)
    return str(cert_path), str(key_path)


def install_pwa(app: Flask) -> None:
    @app.get("/manifest.webmanifest")
    def pwa_manifest():
        return jsonify(
            name="Hub",
            short_name="Hub",
            start_url="/",
            scope="/",
            display="standalone",
            background_color="#f4f3ef",
            theme_color="#203d35",
            icons=[
                {
                    "src": "/shared/pwa-icon.svg",
                    "sizes": "any",
                    "type": "image/svg+xml",
                    "purpose": "any maskable",
                }
            ],
        ), 200, {"Content-Type": "application/manifest+json"}

    @app.get("/service-worker.js")
    def service_worker():
        response = send_from_directory(SHARED_DIR, "service-worker.js")
        response.headers["Service-Worker-Allowed"] = "/"
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/setup/ios")
    def ios_setup():
        page = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up Hub on iPhone</title><link rel="stylesheet" href="/shared/pwa.css"></head><body>
<main class="setup"><h1>Set up Hub on iPhone</h1>
<ol><li>On your iPhone, open this page in Safari over your private Wi-Fi.</li>
<li><a href="/setup/ios/certificate">Download the Hub certificate</a>, then install the downloaded profile in Settings → General → VPN &amp; Device Management.</li>
<li>Enable full trust in Settings → General → About → Certificate Trust Settings.</li>
<li>Open Hub at <code id="hub-address"></code>, sign in, then use Share → Add to Home Screen.</li></ol>
<p>Install this certificate only on devices you control. If Safari cannot open this page before the certificate is trusted, AirDrop <code>data/tls/hub-ca.crt</code> from the laptop and install it first.</p>
<p>The Hub is available to other devices on your Wi-Fi while its laptop server is running.</p></main>
<script src="/shared/ios-setup.js" defer></script></body></html>"""
        return Response(page, mimetype="text/html")

    @app.get("/setup/ios/certificate")
    def ios_certificate():
        cert = Path(app.config["HUB_TLS_CA_CERT"])
        if not cert.is_file():
            abort(404)
        response = send_from_directory(
            cert.parent,
            cert.name,
            as_attachment=True,
            download_name="hub-local-certificate.crt",
            mimetype="application/x-x509-ca-cert",
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.after_request
    def add_pwa_tags(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Content-Security-Policy", CSP)
        if response.mimetype != "text/html":
            return response
        response.direct_passthrough = False
        content = response.get_data()
        if b"</head>" not in content.lower():
            return response
        additions = (
            '<link rel="manifest" href="/manifest.webmanifest">'
            '<link rel="stylesheet" href="/shared/pwa.css">'
            '<meta name="apple-mobile-web-app-capable" content="yes">'
            '<meta name="apple-mobile-web-app-title" content="Hub">'
            '<meta name="apple-mobile-web-app-status-bar-style" content="default">'
            '<meta name="theme-color" content="#203d35">'
            '<script src="/shared/pwa.js"></script>'
        ).encode()
        lowered = content.lower()
        position = lowered.rfind(b"</head>")
        content = content[:position] + additions + content[position:]
        response.set_data(content)
        return response

    @app.get("/shared/ios-setup.js")
    def ios_setup_script():
        script = (
            "document.getElementById('hub-address').textContent = "
            f"{json.dumps('https://' + app.config['HUB_HOSTNAME'] + ':' + str(app.config['HUB_PORT']))};"
        )
        return Response(script, mimetype="text/javascript")
