import asyncio
import csv
import hashlib
import io
import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .auth import bootstrap, login, require_user
from .config import settings
from .db import connect, migrate, now, profile, rows
from .models import MatchUpdate, SearchProfile
from .runner import enqueue, scheduler, sync_schedule, tasks


@asynccontextmanager
async def lifespan(app):
    # One process per SQLite volume; prevents a second scheduler sharing the database.
    import fcntl

    Path(settings.database_path).parent.mkdir(parents=True, exist_ok=True)
    lock = open(settings.database_path + ".lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        migrate()
        bootstrap()
        with connect() as db:
            db.execute(
                "UPDATE search_runs SET status='interrupted',finished_at=?,error=? WHERE status IN ('running','queued')",
                (now(), "Prozess neu gestartet; erneuter Lauf ist möglich."),
            )
        scheduler.start()
        sync_schedule()
        yield
    finally:
        if scheduler.running:
            scheduler.shutdown(wait=False)
        for task in list(tasks):
            task.cancel()
        await asyncio.gather(*list(tasks), return_exceptions=True)
        lock.close()


app = FastAPI(title="Career Radar", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def security(request, call_next):
    # Custom header cannot be sent by cross-origin HTML forms; no CORS grants are exposed.
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("x-csrf") != "1":
        return JSONResponse({"detail": "CSRF-Header fehlt."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    return response


class Credentials(BaseModel):
    username: str = Field(max_length=100)
    password: str = Field(max_length=1000)


@app.get("/healthz")
def health():
    rows("SELECT 1")
    return {"status": "ok"}


@app.post("/api/login")
def sign_in(body: Credentials, request: Request, response: Response):
    token = login(body.username, body.password, request.client.host if request.client else "unknown")
    response.set_cookie(
        "career_session",
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        max_age=settings.session_hours * 3600,
        path="/",
    )
    return {"ok": True}


@app.post("/api/logout")
def sign_out(request: Request, response: Response, user=Depends(require_user)):
    with connect() as db:
        db.execute(
            "DELETE FROM sessions WHERE token_hash=?",
            (hashlib.sha256(request.cookies.get("career_session", "").encode()).hexdigest(),),
        )
    response.delete_cookie("career_session", path="/")
    return {"ok": True}


@app.get("/api/me")
def me(user=Depends(require_user)):
    return {
        **user,
        "openai_configured": bool(settings.openai_api_key),
        "search_model": settings.search_model,
        "evaluation_model": settings.evaluation_model,
    }


class Career(BaseModel):
    content: str = Field(max_length=16000)


@app.get("/api/career")
def get_career(user=Depends(require_user)):
    return rows("SELECT content FROM career_profiles WHERE id=1")[0]


@app.put("/api/career")
def save_career(body: Career, user=Depends(require_user)):
    with connect() as db:
        db.execute("UPDATE career_profiles SET content=? WHERE id=1", (body.content,))
    return body


@app.get("/api/profiles")
def profiles(user=Depends(require_user)):
    result = [profile(r) for r in rows("SELECT * FROM search_profiles ORDER BY id")]
    for p in result:
        scheduled = scheduler.get_job(str(p["id"]))
        p["next_run_at"] = scheduled.next_run_time.isoformat() if scheduled and scheduled.next_run_time else None
    return result


@app.post("/api/profiles", status_code=201)
async def create_profile(body: SearchProfile, user=Depends(require_user)):
    return await write_profile(body)


@app.put("/api/profiles/{profile_id}")
async def update_profile(profile_id: int, body: SearchProfile, user=Depends(require_user)):
    return await write_profile(body, profile_id)


async def write_profile(body, profile_id=None):
    with connect() as db:
        if profile_id is None:
            profile_id = db.execute(
                "INSERT INTO search_profiles(config) VALUES(?)", (body.model_dump_json(),)
            ).lastrowid
        elif not db.execute(
            "UPDATE search_profiles SET config=? WHERE id=?", (body.model_dump_json(), profile_id)
        ).rowcount:
            raise HTTPException(404, "Suchprofil nicht gefunden.")
        db.execute(
            "INSERT INTO prompt_versions(profile_id,search_prompt,evaluation_prompt,created_at) VALUES(?,?,?,?)",
            (profile_id, body.search_prompt, body.evaluation_prompt, now()),
        )
    sync_schedule()
    return {"id": profile_id, **body.model_dump()}


@app.post("/api/profiles/{profile_id}/run", status_code=202)
async def run(profile_id: int, user=Depends(require_user)):
    if not settings.openai_api_key:
        raise HTTPException(503, "OPENAI_API_KEY ist nicht konfiguriert.")
    try:
        return {"run_id": enqueue(profile_id)}
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from None
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from None


@app.get("/api/jobs")
def jobs(user=Depends(require_user)):
    return [
        {**r, "job": json.loads(r["data"]), "assessment": json.loads(r["assessment"])}
        for r in rows("""SELECT m.*, j.data,j.first_seen_at,j.last_seen_at FROM job_matches m
                JOIN jobs j ON j.id=m.job_id ORDER BY m.created_at DESC""")
    ]


@app.patch("/api/matches/{match_id}")
def update_match(match_id: int, body: MatchUpdate, user=Depends(require_user)):
    with connect() as db:
        existing = db.execute("SELECT * FROM job_matches WHERE id=?", (match_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Stelle nicht gefunden.")
        db.execute("UPDATE job_matches SET status=?,favorite=? WHERE id=?", (body.status, body.favorite, match_id))
        if body.status != existing["status"] or body.reason:
            db.execute(
                "INSERT INTO job_feedback(match_id,status,reason,created_at) VALUES(?,?,?,?)",
                (match_id, body.status, body.reason, now()),
            )
    return {"ok": True}


@app.get("/api/runs")
def runs(user=Depends(require_user)):
    return rows("SELECT * FROM search_runs ORDER BY id DESC LIMIT 100")


@app.get("/api/export/{format}")
def export(format: str, user=Depends(require_user)):
    if format == "json":
        data = {
            t: rows("SELECT * FROM " + t)
            for t in (
                "career_profiles",
                "search_profiles",
                "jobs",
                "job_matches",
                "job_feedback",
                "search_runs",
                "prompt_versions",
            )
        }
        return Response(
            json.dumps(data, ensure_ascii=False, indent=2),
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="career-radar.json"'},
        )
    if format == "csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["Unternehmen", "Titel", "Ort", "Gehalt", "URL", "Score", "Status", "Suchprofil"])
        for r in jobs(user):
            j = r["job"]
            values = [
                j["company"],
                j["title"],
                j["location"],
                j["salary"] or "",
                j["url"],
                r["assessment"]["score"],
                r["status"],
                r["profile_id"],
            ]
            writer.writerow(
                ["'" + str(v) if str(v).startswith(("=", "+", "-", "@", "\t", "\r", "\n")) else v for v in values]
            )
        return Response(
            "\ufeff" + buffer.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="career-radar.csv"'},
        )
    raise HTTPException(404, "Format nicht vorhanden.")


# Only the static app shell is public. All personal data is fetched through protected /api routes.
if Path(settings.frontend_dist, "assets").exists():
    app.mount("/assets", StaticFiles(directory=Path(settings.frontend_dist, "assets")), name="assets")


@app.get("/{path:path}")
def spa(path: str):
    if path.startswith("api/"):
        raise HTTPException(404)
    index = Path(settings.frontend_dist, "index.html")
    if not index.exists():
        raise HTTPException(503, "Frontend bauen oder Vite-Entwicklungsserver verwenden.")
    return FileResponse(index)
