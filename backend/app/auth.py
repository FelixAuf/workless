import hashlib
import secrets
import time

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import HTTPException, Request

from .config import settings
from .db import connect

hasher = PasswordHasher()
dummy_hash = hasher.hash(secrets.token_urlsafe(32))


def bootstrap():
    with connect() as db:
        if not db.execute("SELECT id FROM users LIMIT 1").fetchone():
            if len(settings.admin_password) < 12:
                raise ValueError("ADMIN_PASSWORD muss mindestens 12 Zeichen enthalten.")
            db.execute(
                "INSERT INTO users(username,password_hash) VALUES(?,?)",
                (settings.admin_username, hasher.hash(settings.admin_password)),
            )


def require_user(request: Request):
    token = request.cookies.get("career_session", "")
    with connect() as db:
        user = db.execute(
            """SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=? AND s.expires_at>?""",
            (hashlib.sha256(token.encode()).hexdigest(), time.time()),
        ).fetchone()
    if not user:
        raise HTTPException(401, "Bitte anmelden.")
    return dict(user)


def login(username, password, ip):
    key = hashlib.sha256(ip.encode()).hexdigest()
    t = time.time()
    with connect() as db:
        db.execute("DELETE FROM login_attempts WHERE reset_at<?", (t,))
        db.execute("DELETE FROM sessions WHERE expires_at<?", (t,))
        attempt = db.execute("SELECT * FROM login_attempts WHERE key=?", (key,)).fetchone()
        if attempt and attempt["attempts"] >= 10:
            raise HTTPException(429, "Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.")
        db.execute(
            """INSERT INTO login_attempts(key,attempts,reset_at) VALUES(?,1,?)
            ON CONFLICT(key) DO UPDATE SET attempts=attempts+1""",
            (key, t + 900),
        )
        user = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    try:
        hasher.verify(user["password_hash"] if user else dummy_hash, password)
    except VerificationError:
        raise HTTPException(401, "Benutzername oder Passwort ungültig.") from None
    if not user:
        raise HTTPException(401, "Benutzername oder Passwort ungültig.")
    token = secrets.token_urlsafe(48)
    with connect() as db:
        db.execute("DELETE FROM login_attempts WHERE key=?", (key,))
        db.execute(
            "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
            (hashlib.sha256(token.encode()).hexdigest(), user["id"], t + settings.session_hours * 3600),
        )
    return token
