import hashlib
import time

import pytest
from app.auth import bootstrap
from app.config import settings
from app.db import connect, rows
from app.main import app
from fastapi.testclient import TestClient


@pytest.fixture
def client(database, monkeypatch):
    monkeypatch.setattr(settings, "admin_password", "a-long-test-password")
    monkeypatch.setattr(settings, "cookie_secure", True)
    bootstrap()
    # These tests don't need scheduler lifecycle; database fixture has applied migrations.
    return TestClient(app, base_url="https://testserver")


def sign_in(client):
    return client.post(
        "/api/login", json={"username": "admin", "password": "a-long-test-password"}, headers={"X-CSRF": "1"}
    )


def test_authentication_session_revocation_and_csrf(client):
    for path in ["/api/jobs", "/api/career", "/api/profiles", "/api/runs", "/api/export/json", "/api/export/csv"]:
        assert client.get(path).status_code == 401
    assert client.post("/api/login", json={"username": "admin", "password": "bad"}).status_code == 403
    assert (
        client.post("/api/login", json={"username": "admin", "password": "bad"}, headers={"X-CSRF": "1"}).status_code
        == 401
    )
    res = sign_in(client)
    assert res.status_code == 200
    cookie = res.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
    assert client.get("/api/me").status_code == 200
    raw = client.cookies.get("career_session")
    session = rows("SELECT * FROM sessions")[0]
    assert session["token_hash"] == hashlib.sha256(raw.encode()).hexdigest()
    assert rows("SELECT * FROM users")[0]["password_hash"].startswith("$argon2id$")
    assert client.post("/api/logout", headers={"X-CSRF": "1"}).status_code == 200
    client.cookies.set("career_session", raw)
    assert client.get("/api/me").status_code == 401


def test_expired_session_rejected(client):
    sign_in(client)
    with connect() as db:
        db.execute("UPDATE sessions SET expires_at=?", (time.time() - 1,))
    assert client.get("/api/me").status_code == 401


def test_brute_force_rate_limit(client):
    for _ in range(10):
        assert (
            client.post(
                "/api/login", json={"username": "admin", "password": "bad"}, headers={"X-CSRF": "1"}
            ).status_code
            == 401
        )
    assert sign_in(client).status_code == 429


def test_bootstrap_does_not_reset_existing_password(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_password", "another-long-password")
    bootstrap()
    assert sign_in(client).status_code == 200


def test_export_excludes_sessions_and_passwords(client):
    sign_in(client)
    res = client.get("/api/export/json")
    assert res.status_code == 200
    assert "users" not in res.json() and "sessions" not in res.json()
    assert "password_hash" not in res.text
