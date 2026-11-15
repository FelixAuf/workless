import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .config import settings


def now():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def connect():
    Path(settings.database_path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(settings.database_path, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        with db:
            yield db
    finally:
        db.close()


MIGRATIONS = [
    """
CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at REAL NOT NULL);
CREATE TABLE login_attempts(key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at REAL NOT NULL);
CREATE TABLE career_profiles(id INTEGER PRIMARY KEY CHECK(id=1), content TEXT NOT NULL DEFAULT '');
INSERT INTO career_profiles(id) VALUES(1);
CREATE TABLE search_profiles(id INTEGER PRIMARY KEY, config TEXT NOT NULL);
CREATE TABLE jobs(id INTEGER PRIMARY KEY, canonical_url TEXT UNIQUE NOT NULL, fingerprint TEXT UNIQUE NOT NULL,
 data TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE job_matches(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id),
 profile_id INTEGER NOT NULL REFERENCES search_profiles(id), assessment TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'new', favorite INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 UNIQUE(job_id,profile_id));
CREATE TABLE job_feedback(id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL REFERENCES job_matches(id),
 status TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE search_runs(id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES search_profiles(id),
 status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, found INTEGER DEFAULT 0,
 new_jobs INTEGER DEFAULT 0, error TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
 search_calls INTEGER DEFAULT 0, estimated_usd REAL DEFAULT 0);
CREATE UNIQUE INDEX one_active_run ON search_runs(profile_id) WHERE status IN ('queued','running');
CREATE TABLE prompt_versions(id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES search_profiles(id),
 search_prompt TEXT NOT NULL, evaluation_prompt TEXT NOT NULL, created_at TEXT NOT NULL);
"""
]


def migrate():
    with connect() as db:
        db.execute("PRAGMA journal_mode=WAL")
        version = db.execute("PRAGMA user_version").fetchone()[0]
        for i, sql in enumerate(MIGRATIONS[version:], start=version + 1):
            db.executescript("BEGIN IMMEDIATE;\n" + sql + f"\nPRAGMA user_version={i};\nCOMMIT;")


def rows(sql, args=()):
    with connect() as db:
        return [dict(r) for r in db.execute(sql, args).fetchall()]


def profile(row):
    return {"id": row["id"], **json.loads(row["config"])}
