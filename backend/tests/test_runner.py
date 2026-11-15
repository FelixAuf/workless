import asyncio
import json
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from app import runner
from app.db import connect, migrate, rows
from app.models import Assessment, Discoveries, Job, SearchProfile


def make_profile():
    return SearchProfile(name="Graz", search_prompt="Find jobs", evaluation_prompt="Evaluate", schedule="weekly")


def insert_profile():
    with connect() as db:
        return db.execute(
            "INSERT INTO search_profiles(config) VALUES(?)", (make_profile().model_dump_json(),)
        ).lastrowid


def test_timezone_and_weekly_schedule():
    t = runner.trigger(make_profile().model_dump())
    for month in (1, 7):
        nxt = t.get_next_fire_time(None, datetime(2026, month, 1, tzinfo=ZoneInfo("Europe/Vienna")))
        assert nxt.weekday() == 0 and nxt.hour == 8
        assert str(nxt.tzinfo) == "Europe/Vienna"


def test_invalid_cron_rejected():
    with pytest.raises(ValueError):
        SearchProfile(name="x", search_prompt="x", evaluation_prompt="x", cron="not cron")


def test_migrations_repeat_safely(database):
    migrate()
    assert rows("SELECT * FROM career_profiles") == [{"id": 1, "content": ""}]


def test_run_prevents_overlap_and_failure_allows_retry(database, monkeypatch):
    p = insert_profile()

    class Failing:
        def __init__(self, *args):
            pass

        async def discover(self, p):
            raise RuntimeError("secret should not leak")

        async def close(self):
            pass

    monkeypatch.setattr(runner, "OpenAIProvider", Failing)

    async def check():
        first = runner.enqueue(p)
        with pytest.raises(RuntimeError):
            runner.enqueue(p)
        await asyncio.gather(*list(runner.tasks))
        assert rows("SELECT * FROM search_runs WHERE id=?", (first,))[0]["status"] == "failed"
        assert "secret" not in rows("SELECT * FROM search_runs")[0]["error"]
        runner.enqueue(p)
        await asyncio.gather(*list(runner.tasks))

    asyncio.run(check())


def test_rerun_reuses_job_and_match_with_feedback_preserved(database, monkeypatch):
    p = insert_profile()
    j = Job(
        company="Acme",
        title="PO",
        location="Graz",
        remote_policy="Hybrid",
        austria_remote="unconfirmed",
        availability="confirmed",
        salary=None,
        requirements=[],
        description="A job",
        url="https://a.test/1",
        source_url="https://a.test/1",
        published_at=None,
    )
    a = Assessment(
        score=85,
        reasoning="Good",
        matching_qualifications=[],
        missing_qualifications=[],
        role_type="realistic",
        decision_authority="Yes",
        development_potential="Yes",
        red_flags=[],
    )
    evaluated = []

    class Fake:
        def __init__(self, *args):
            pass

        async def discover(self, p):
            return Discoveries(jobs=[j])

        async def evaluate(self, *args):
            evaluated.append(1)
            return a

        async def close(self):
            pass

    monkeypatch.setattr(runner, "OpenAIProvider", Fake)

    async def check():
        runner.enqueue(p)
        await asyncio.gather(*list(runner.tasks))
        with connect() as db:
            db.execute("UPDATE job_matches SET status='rejected'")
        runner.enqueue(p)
        await asyncio.gather(*list(runner.tasks))

    asyncio.run(check())
    assert len(evaluated) == 1
    assert len(rows("SELECT * FROM jobs")) == len(rows("SELECT * FROM job_matches")) == 1
    assert rows("SELECT * FROM job_matches")[0]["status"] == "rejected"
    assert [r["new_jobs"] for r in rows("SELECT * FROM search_runs ORDER BY id")] == [1, 0]


def test_same_job_can_match_multiple_profiles(database, monkeypatch):
    # DB uniqueness is per profile, not per job.
    from app.dedupe import upsert_job

    p1, p2 = insert_profile(), insert_profile()
    with connect() as db:
        j = upsert_job(db, dict(company="X", title="PO", location="Graz", url="https://a.test/2"))
        for p in (p1, p2):
            db.execute(
                "INSERT INTO job_matches(job_id,profile_id,assessment,created_at) VALUES(?,?,?,?)",
                (j, p, json.dumps({"score": 50}), "now"),
            )
    assert len(rows("SELECT * FROM jobs")) == 1
    assert len(rows("SELECT * FROM job_matches")) == 2
