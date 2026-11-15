import hashlib
import re
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .db import now


def canonical_url(url):
    u = urlsplit(url)
    query = sorted(
        (k, v)
        for k, v in parse_qsl(u.query)
        if not k.lower().startswith("utm_") and k.lower() not in {"fbclid", "gclid", "ref", "source", "trackingid"}
    )
    host = (u.hostname or "").lower().removeprefix("www.")
    port = f":{u.port}" if u.port and u.port not in (80, 443) else ""
    return urlunsplit(("https", host + port, u.path.rstrip("/") or "/", urlencode(query), ""))


def normalized(value):
    return re.sub(r"[^\w]+", " ", unicodedata.normalize("NFKC", value).casefold()).strip()


def fingerprint(job):
    return hashlib.sha256("|".join(normalized(job[k]) for k in ("company", "title", "location")).encode()).hexdigest()


def upsert_job(db, job):
    import json

    url, fp, timestamp = canonical_url(job["url"]), fingerprint(job), now()
    existing = db.execute("SELECT id FROM jobs WHERE canonical_url=? OR fingerprint=?", (url, fp)).fetchone()
    if existing:
        db.execute("UPDATE jobs SET last_seen_at=? WHERE id=?", (timestamp, existing["id"]))
        return existing["id"]
    return db.execute(
        "INSERT INTO jobs(canonical_url,fingerprint,data,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)",
        (url, fp, json.dumps(job), timestamp, timestamp),
    ).lastrowid
