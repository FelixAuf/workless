from app.db import connect, rows
from app.dedupe import canonical_url, upsert_job


def test_tracking_normalization_preserves_job_identity():
    assert (
        canonical_url("http://WWW.Example.com/jobs/1/?utm_source=x&jobId=42#apply")
        == "https://example.com/jobs/1?jobId=42"
    )
    assert canonical_url("https://example.com/job?id=1") != canonical_url("https://example.com/job?id=2")


def test_url_and_fingerprint_duplicates_refresh_last_seen(database):
    a = dict(company="Acme GmbH", title="Product Owner", location="Graz", url="https://acme.test/job/42?utm_medium=x")
    with connect() as db:
        first = upsert_job(db, a)
        db.execute("UPDATE jobs SET last_seen_at='2000-01-01' WHERE id=?", (first,))
        second = upsert_job(db, {**a, "url": "https://acme.test/job/42", "title": "A changed title"})
        third = upsert_job(
            db, {**a, "company": "ACME GmbH", "title": "Product   Owner", "url": "https://board.test/123"}
        )
    assert first == second == third
    assert len(rows("SELECT * FROM jobs")) == 1
    assert rows("SELECT last_seen_at FROM jobs")[0]["last_seen_at"] != "2000-01-01"


def test_distinct_locations_are_distinct_jobs(database):
    with connect() as db:
        a = upsert_job(db, dict(company="Acme", title="PO", location="Graz", url="https://a.test/1"))
        b = upsert_job(db, dict(company="Acme", title="PO", location="Wien", url="https://a.test/2"))
    assert a != b
