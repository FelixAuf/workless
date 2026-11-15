import asyncio
import json
import sqlite3

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from .config import settings
from .db import connect, now, profile, rows
from .dedupe import upsert_job
from .provider import OpenAIProvider

scheduler = AsyncIOScheduler(timezone="Europe/Vienna")
tasks = set()
# Serialize paid work to keep memory and account load bounded.
execution_gate = asyncio.Semaphore(1)


def trigger(config):
    expression = {"daily": "0 8 * * *", "weekly": "0 8 * * mon"}.get(config["schedule"], config["cron"])
    return CronTrigger.from_crontab(expression, timezone="Europe/Vienna")


def sync_schedule():
    scheduler.remove_all_jobs()
    for row in rows("SELECT * FROM search_profiles"):
        p = profile(row)
        if p["enabled"] and p["schedule"] != "manual":
            scheduler.add_job(
                scheduled_run,
                trigger(p),
                args=[p["id"]],
                id=str(p["id"]),
                max_instances=1,
                coalesce=True,
                misfire_grace_time=3600,
            )


async def scheduled_run(profile_id):
    enqueue(profile_id)


def enqueue(profile_id):
    with connect() as db:
        if not db.execute("SELECT id FROM search_profiles WHERE id=?", (profile_id,)).fetchone():
            raise LookupError("Suchprofil nicht gefunden.")
        try:
            run_id = db.execute(
                "INSERT INTO search_runs(profile_id,status,started_at) VALUES(?,?,?)", (profile_id, "queued", now())
            ).lastrowid
        except sqlite3.IntegrityError:
            raise RuntimeError("Für dieses Profil läuft bereits eine Suche.") from None
    task = asyncio.create_task(execute(run_id, profile_id))
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return run_id


async def execute(run_id, profile_id):
    async with execution_gate:
        await _execute(run_id, profile_id)


async def _execute(run_id, profile_id):
    provider = None
    try:
        with connect() as db:
            db.execute("UPDATE search_runs SET status='running' WHERE id=?", (run_id,))
            p = profile(dict(db.execute("SELECT * FROM search_profiles WHERE id=?", (profile_id,)).fetchone()))
            career = db.execute("SELECT content FROM career_profiles WHERE id=1").fetchone()[0]
            feedback = [
                dict(r)
                for r in db.execute(
                    """SELECT j.data,f.status,f.reason FROM job_feedback f
                JOIN job_matches m ON m.id=f.match_id JOIN jobs j ON j.id=m.job_id
                WHERE m.profile_id=? ORDER BY f.id DESC LIMIT 12""",
                    (profile_id,),
                )
            ]
            # Keep feedback context compact; never send full old descriptions.
            for f in feedback:
                old = json.loads(f.pop("data"))
                f.update(company=old["company"], title=old["title"])

        def budget_check():
            usage = rows(
                "SELECT input_tokens+output_tokens AS tokens, estimated_usd FROM search_runs WHERE id=?", (run_id,)
            )[0]
            # Reserve a conservative allowance for the next request before dispatch.
            reserve = (
                20000 * settings.input_usd_per_million + settings.max_output_tokens * settings.output_usd_per_million
            ) / 1e6 + 3 * settings.web_search_usd_per_call
            if usage["estimated_usd"] + reserve > settings.max_run_usd:
                raise ValueError("Geschätztes Kostenlimit dieses Suchlaufs erreicht.")
            if usage["tokens"] + settings.max_output_tokens + 20000 > settings.max_run_tokens:
                raise ValueError("Tokenlimit dieses Suchlaufs erreicht. Gespeicherte Ergebnisse bleiben erhalten.")

        def record(response):
            u = response.usage
            inp, out = (u.input_tokens, u.output_tokens) if u else (0, 0)
            calls = sum(item.type == "web_search_call" for item in response.output)
            cost = (inp * settings.input_usd_per_million + out * settings.output_usd_per_million) / 1e6
            cost += calls * settings.web_search_usd_per_call
            with connect() as db:
                db.execute(
                    """UPDATE search_runs SET input_tokens=input_tokens+?, output_tokens=output_tokens+?,
                    search_calls=search_calls+?,estimated_usd=estimated_usd+? WHERE id=?""",
                    (inp, out, calls, cost, run_id),
                )

        provider = OpenAIProvider(record, budget_check)
        discovered = await provider.discover(p)
        with connect() as db:
            db.execute("UPDATE search_runs SET found=? WHERE id=?", (len(discovered.jobs), run_id))
        for item in discovered.jobs:
            job = item.model_dump()
            if p["remote_only"] and item.austria_remote == "no":
                continue
            with connect() as db:
                job_id = upsert_job(db, job)
                exists = db.execute(
                    "SELECT id FROM job_matches WHERE job_id=? AND profile_id=?", (job_id, profile_id)
                ).fetchone()
            if exists:
                continue
            result = await provider.evaluate(job, p, career, feedback)
            with connect() as db:
                db.execute(
                    "INSERT INTO job_matches(job_id,profile_id,assessment,created_at) VALUES(?,?,?,?)",
                    (job_id, profile_id, result.model_dump_json(), now()),
                )
                db.execute("UPDATE search_runs SET new_jobs=new_jobs+1 WHERE id=?", (run_id,))
        with connect() as db:
            db.execute("UPDATE search_runs SET status='completed',finished_at=? WHERE id=?", (now(), run_id))
    except asyncio.CancelledError:
        with connect() as db:
            db.execute(
                "UPDATE search_runs SET status='interrupted',finished_at=?,error=? WHERE id=?",
                (now(), "Durch Herunterfahren unterbrochen; erneuter Lauf ist möglich.", run_id),
            )
        raise
    except Exception as exc:
        # Never log exception text from upstream services: it can include sensitive request data.
        safe = (
            str(exc)
            if isinstance(exc, ValueError) and type(exc) is ValueError
            else "Suche fehlgeschlagen: " + type(exc).__name__
        )
        with connect() as db:
            db.execute("UPDATE search_runs SET status='failed',finished_at=?,error=? WHERE id=?", (now(), safe, run_id))
    finally:
        if provider:
            await provider.close()
