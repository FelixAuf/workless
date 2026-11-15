# Career Radar

Private, selbst gehostete Jobsuche mit echter OpenAI-Webrecherche, strukturierten Bewertungen und einem responsiven Dashboard. Phase 1 ist implementiert; Status, Favoriten und einfaches Feedback sind bereits als Grundlage für Phase 2 enthalten. Der Prompt-Optimierer mit Chat, Vergleich und Wiederherstellung folgt in Phase 3.

## Lokal starten

Voraussetzungen: Python ≥3.12, [uv](https://docs.astral.sh/uv/), Node.js ≥22, npm.

```sh
cp .env.example .env
```

In `.env` ein eigenes `ADMIN_PASSWORD` mit mindestens 12 Zeichen und `OPENAI_API_KEY` setzen. Für lokale HTTP-Entwicklung `COOKIE_SECURE=false` setzen. Kein Standardpasswort, keine Registrierung. Der Admin wird beim ersten Start erstellt. Anschließend `ADMIN_PASSWORD` aus der Konfiguration entfernen; das bestehende Argon2id-Passwort wird bei Neustarts nicht überschrieben.

```sh
uv sync --locked
cd frontend
npm ci
npm run build
cd ..
PYTHONPATH=backend uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 --no-access-log
```

App: http://localhost:8000. Für Frontend-Entwicklung zusätzlich `cd frontend && npm run dev`; Vite leitet `/api` an Port 8000 weiter. Für Hot Reload des Backends `--reload` statt `--workers 1` verwenden.

Nach dem Login:

1. Unter **Mein Karriereprofil** Erfahrungen, Qualifikationen und Ziele eintragen.
2. Unter **Suchprofile** die Vorlagen Graz und International Remote individuell konfigurieren und speichern.
3. Täglich, wöchentlich oder einen eigenen Zeitplan wählen. Standard: 08:00 Europe/Vienna, wöchentlich montags. Cron verwendet APScheduler: fünf Felder; Montag=0, Sonntag=6, alternativ `mon`–`sun`. Beispiel: `0 8 * * mon`.
4. **Suche jetzt ausführen** starten; Ergebnisse erscheinen automatisch. Unbestätigte Verfügbarkeit und Remote-Berechtigung aus Österreich werden markiert.

## Docker und Coolify

Ein Container, ein Uvicorn-Prozess, keine externen Datenbank- oder Queue-Dienste.

```sh
docker compose up --build -d
```

Für lokales Compose über HTTP ebenfalls `COOKIE_SECURE=false` in `.env` setzen. Compose veröffentlicht den Port nur an localhost. Für Serverbetrieb HTTPS über den Reverse Proxy verwenden.

In Coolify:

- Git-Repository als Application verbinden, Build Pack **Dockerfile**, Dockerfile `/Dockerfile`, Kontext `/`.
- Port **8000**, Domain mit HTTPS konfigurieren.
- Persistentes Volume nach **`/data`** mounten. Bei Host-Bind-Mounts Schreibrechte für UID **10001** vergeben.
- Runtime-Variablen `OPENAI_API_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` setzen; `COOKIE_SECURE=true` belassen.
- Healthcheck: **GET `/healthz`**, Port 8000. Dieser Endpunkt enthält ausschließlich den Betriebsstatus.
- Genau **eine Instanz** mit **einem Worker** betreiben. Eine Dateisperre verhindert zwei Prozesse auf demselben SQLite-Volume. Kein Rolling Deployment mit gleichzeitig laufenden Replikaten auf diesem Volume.
- Deployen, anmelden, Admin-Passwort aus den Runtime-Variablen entfernen und erneut deployen.

SQLite-Migrationen laufen vor dem Start automatisch und transaktional über `PRAGMA user_version`. Vor Updates das Volume sichern. Ein fehlendes/zu kurzes initiales Admin-Passwort verhindert den Start mit einer verständlichen Fehlermeldung.

## Konfiguration

Secrets bleiben ausschließlich serverseitig. `.env` ist ignoriert und wird nicht in das Image kopiert.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `OPENAI_API_KEY` | leer | Eigener OpenAI-API-Key mit verfügbarem API-Guthaben |
| `ADMIN_USERNAME` | `admin` | Benutzername beim ersten Start |
| `ADMIN_PASSWORD` | leer | Initiales Passwort, mindestens 12 Zeichen; danach entfernen |
| `DATABASE_PATH` | `data/career-radar.sqlite3` | Im Container `/data/career-radar.sqlite3` |
| `COOKIE_SECURE` | `true` | Secure-Cookie; nur lokal über HTTP deaktivieren |
| `SESSION_HOURS` | `168` | Absolute Gültigkeit einer serverseitigen Session |
| `SEARCH_MODEL` | `gpt-4.1-mini` | Responses-Modell mit Unterstützung für `web_search` |
| `EVALUATION_MODEL` | `gpt-4.1-mini` | Responses-Modell mit Structured Outputs |
| `API_TIMEOUT_SECONDS` | `90` | API-Timeout pro Versuch; höchstens zwei SDK-Retries |
| `MAX_OUTPUT_TOKENS` | `6000` | Ausgabegrenze pro API-Anfrage |
| `MAX_RUN_TOKENS` | `100000` | Tokenbudget mit Reserve vor weiteren Anfragen |
| `MAX_RUN_USD` | `2` | Geschätztes Kostenbudget je Lauf mit Reserve vor weiteren Anfragen |
| `INPUT_USD_PER_MILLION` | `0.4` | Konfigurierbarer Schätzpreis für Eingabetokens |
| `OUTPUT_USD_PER_MILLION` | `1.6` | Konfigurierbarer Schätzpreis für Ausgabetokens |
| `WEB_SEARCH_USD_PER_CALL` | `0.01` | Konfigurierbarer Schätzpreis je Websuchaufruf |
| `FRONTEND_DIST` | `frontend/dist` | Pfad zum gebauten Frontend |

Preiswerte sind Schätzparameter, keine verbindlichen aktuellen Preise. Bei Modellwechsel aktualisieren. Eingabe-/Ausgabetokens und Websuchaufrufe erfolgreicher API-Antworten werden pro Lauf gespeichert. Fehlgeschlagene Requests, SDK-Retries und Websuch-Kontext können zusätzliche, hier nicht exakt erfassbare Kosten verursachen. Die Anwendungsbudgets sind keine harte OpenAI-Abrechnungsgrenze. Für zusätzliche Kontrollen die verfügbaren Projektlimits im OpenAI-Konto konfigurieren. Es gibt kein API-Key-Eingabefeld im Frontend.

## Recherche und Bewertung

- Austauschbare Suchanbieter-Schnittstelle in `backend/app/provider.py`. Das MVP nutzt die [OpenAI Responses API mit `web_search`](https://developers.openai.com/api/docs/guides/tools-web-search), erzwingt den Tool-Aufruf und begrenzt ihn auf drei Tool-Aufrufe je Recherche.
- Recherche und JSON-Extraktion sind getrennt. Extraktion und Bewertung nutzen [Strict Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), gefolgt von Pydantic-Validierung. Stellen ohne URL in den tatsächlichen Recherchequellen werden verworfen. Quellen belegen den Fund; ihre Inhalte und die Beschäftigungsbedingungen müssen bei einer Bewerbung selbst geprüft werden.
- Optional eingetragene Quelldomains beschränken die Websuche. Für möglichst viele Arbeitgeber-Originalanzeigen die Quellen leer lassen oder passende Arbeitgeberdomains ergänzen.
- `jobs` speichert eine Stelle, `job_matches` deren Score/Status je Suchprofil. URLs werden um Trackingparameter bereinigt; Arbeitgeber/Titel/Ort dienen als zweiter Schlüssel. Semantischer Abgleich und plattformübergreifende Job-ID-Extraktion sind noch nicht enthalten. Gleichnamige Rollen am selben Ort können zusammenfallen.
- Bereits bewertete Matches werden nicht erneut bewertet, auch bei Ablehnung. Erneute Funde aktualisieren `last_seen_at`. Bei neuem Suchprofil kann dieselbe Stelle eine eigene Bewertung erhalten.
- Die letzten zwölf Feedbackeinträge des jeweiligen Profils fließen kompakt in neue Bewertungen ein. Feedback ändert weder Such- noch Bewertungsprompts automatisch. Bei manuellem Speichern eines Suchprofils werden die Prompts bereits versioniert; Vergleich und Wiederherstellung über die UI sind Phase 3.
- Karriereprofil, Prompts und ausgewähltes Feedback werden zur Bewertung an OpenAI gesendet. `store=false` wird bei allen Requests gesetzt; die Aufbewahrungsregeln des API-Anbieters gelten weiterhin.

## Betrieb und Wiederanlauf

APScheduler wird aus den gespeicherten Profilen aufgebaut; die Zeitzone `Europe/Vienna` berücksichtigt Sommerzeit. Ein Datenbankindex verhindert überlappende Suchläufe desselben Profils. Bezahlte Läufe verschiedener Profile werden nacheinander abgearbeitet. Deaktiviert unterbindet automatische Läufe; manuelle Läufe sind weiterhin möglich.

Jede erfolgreich bewertete Stelle wird einzeln gespeichert. Fehler oder Budgetgrenzen beenden den Lauf sichtbar in der Historie; bereits gespeicherte Ergebnisse bleiben erhalten. Nach einem Neustart werden offene Läufe als `interrupted` markiert. Ein erneuter Lauf sucht frisch, überspringt vorhandene Matches und kann zuvor unbewertete Stellen bewerten. Während ausgeschalteter App verpasste Termine werden nicht nachträglich abgespult. Ein systemd-/Coolify-Neustart startet keine zusätzliche kostenpflichtige Suche automatisch.

Argon2id, gehashte Sessiontokens, HttpOnly/Secure/SameSite-Cookies, CSRF-Header, Login-Limit, keine CORS-Freigaben und Sicherheitsheader schützen die App. Die statische App-Oberfläche und `/healthz` sind öffentlich; sämtliche persönlichen Daten und Daten-APIs erfordern Login. Das MVP ist ein persönlicher Workspace; mehrere getrennte Mandanten sind nicht vorgesehen. Keine Request-/Response-Payloads oder API-Keys loggen.

## Backup und Export

Angemeldet über das Dashboard als CSV oder JSON exportieren. JSON enthält Profile, Stellen, Bewertungen, Feedback, Suchläufe und Promptversionen, aber keine Passwörter oder Sessions. Ein Datenimport ist noch nicht enthalten.

Konsistentes SQLite-Backup (auch während des Betriebs, neues Zieldatei verwenden):

```sh
PYTHONPATH=backend uv run python -m app.backup backups/career-radar-2026-11-14.sqlite3
```

Im Container statt `uv run python` `/app/.venv/bin/python` verwenden. Das Backup regelmäßig außerhalb des Containers ablegen. Wiederherstellen: Container stoppen, Datenbankdatei durch das Backup ersetzen, alte zugehörige `-wal`/`-shm`-Dateien entfernen, Dateirechte prüfen und starten. Einfaches Kopieren einer laufenden WAL-Datenbank kann unvollständig sein.

## Tests

```sh
uv run pytest -q
cd frontend
npm run build
```

Die Tests prüfen Authentifizierung, Cookie-Eigenschaften, CSRF, Login-Limit, Duplikate, mehrere Suchprofile pro Stelle, Migrationen, Scheduler-Zeitzone, Überschneidungsschutz, Wiederanlauf und die OpenAI-Anfrage-/Quellenvalidierung mit simuliertem HTTP-Transport. Sie verursachen keine API-Kosten. Ein echter Suchlauf benötigt den eigenen API-Key.

## Technische Entscheidungen

- Python/FastAPI und direktes `sqlite3`: kleine Anwendung ohne ORM-Schicht; SQLite-WAL und kurze Transaktionen. Nummerierte, transaktionale Migrationen statt zusätzlichem Migrationsframework.
- Ein Prozess: asynchroner Scheduler und API im selben Container. Keine Redis-/Celery-Infrastruktur.
- React/Vite, Tailwind und eine lokal gepflegte shadcn/ui-Button-Komponente auf Radix/CVA. Statische Assets werden beim Docker-Build erzeugt und durch FastAPI ausgeliefert; kein Node-Laufzeitprozess.
- Kein Scraping beliebiger URLs durch den Server. Die Recherche erfolgt über das Suchwerkzeug des Anbieters; strukturierte Angaben und Remote-Bestätigungen bleiben KI-gestützt und können unvollständig sein.
