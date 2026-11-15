import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Radar,
  LayoutDashboard,
  SlidersHorizontal,
  UserRound,
  History,
  LogOut,
  ArrowUpRight,
  Plus,
  Search,
  MapPin,
  Star,
  X,
  ChevronRight,
  Clock3,
  CircleCheck,
  AlertCircle,
  LoaderCircle,
  Download,
  BriefcaseBusiness,
  Sparkles,
  Globe2,
} from "lucide-react";
import { Button } from "./components/ui/button";
import "./style.css";

type Profile = {
  id?: number;
  name: string;
  description: string;
  search_prompt: string;
  evaluation_prompt: string;
  sources: string[];
  geography: string;
  remote_only: boolean;
  schedule: string;
  cron: string;
  enabled: boolean;
  max_jobs: number;
  next_run_at?: string;
};
type Match = {
  id: number;
  profile_id: number;
  status: string;
  favorite: boolean;
  created_at: string;
  first_seen_at: string;
  last_seen_at: string;
  job: {
    company: string;
    title: string;
    location: string;
    remote_policy: string;
    austria_remote: string;
    availability: string;
    salary?: string;
    description: string;
    requirements: string[];
    url: string;
    source_url: string;
    published_at?: string;
  };
  assessment: {
    score: number;
    reasoning: string;
    matching_qualifications: string[];
    missing_qualifications: string[];
    role_type: string;
    decision_authority: string;
    development_potential: string;
    red_flags: string[];
  };
};
type Run = {
  id: number;
  profile_id: number;
  status: string;
  started_at: string;
  finished_at?: string;
  found: number;
  new_jobs: number;
  input_tokens: number;
  output_tokens: number;
  estimated_usd: number;
  error?: string;
};
type User = {
  username: string;
  openai_configured: boolean;
  search_model: string;
  evaluation_model: string;
};
const statuses: Record<string, string> = {
  new: "Neu",
  interesting: "Interessant",
  rejected: "Abgelehnt",
  applied: "Beworben",
  archived: "Archiviert",
};
const runStatuses: Record<string, string> = {
  queued: "In Warteschlange",
  running: "Suche läuft",
  completed: "Abgeschlossen",
  failed: "Fehlgeschlagen",
  interrupted: "Unterbrochen",
};
const schedules: Record<string, string> = {
  manual: "Manuell",
  daily: "Täglich, 08:00",
  weekly: "Montags, 08:00",
  cron: "Eigener Zeitplan",
};
const date = (s?: string) =>
  s
    ? new Intl.DateTimeFormat("de-AT", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(s))
    : "–";
const usd = (n: number) =>
  new Intl.NumberFormat("de-AT", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 3,
  }).format(n);
const blank: Profile = {
  name: "",
  description: "",
  search_prompt:
    "Finde aktuelle Stellen in Product Ownership, Projektmanagement und Digitalisierung mit echter Business-Verantwortung. Bevorzuge Originalanzeigen beim Arbeitgeber.",
  evaluation_prompt:
    "Bewerte die Passung zu meinem Karriereprofil. Priorisiere Entscheidungskompetenz, Gestaltungsspielraum und Entwicklung Richtung Produkt-, Geschäfts- und Führungsverantwortung. Benenne fehlende Qualifikationen ehrlich.",
  sources: [],
  geography: "Graz, Österreich; vor Ort oder hybrid",
  remote_only: false,
  schedule: "manual",
  cron: "0 8 * * *",
  enabled: true,
  max_jobs: 10,
};
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/login" && path !== "/me")
      window.dispatchEvent(new Event("session-expired"));
    throw new Error(
      typeof error.detail === "string"
        ? error.detail
        : res.status === 422
          ? "Bitte Eingaben prüfen (z. B. Cron-Ausdruck, Quellen oder Textlänge)."
          : `Anfrage fehlgeschlagen (${res.status}).`,
    );
  }
  return res.json();
}
function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "modal wide" : "modal"}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <Button variant="ghost" aria-label="Schließen" onClick={close}>
          <X size={20} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true);
  const [page, setPage] = useState("dashboard"),
    [profiles, setProfiles] = useState<Profile[]>([]),
    [matches, setMatches] = useState<Match[]>([]),
    [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Profile | null>(null),
    [selected, setSelected] = useState<Match | null>(null);
  const [career, setCareer] = useState(""),
    [profileFilter, setProfileFilter] = useState(""),
    [query, setQuery] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [scoreFilter, setScoreFilter] = useState("0"),
    [locationFilter, setLocationFilter] = useState(""),
    [salaryFilter, setSalaryFilter] = useState(""),
    [sort, setSort] = useState("score"),
    [favoriteOnly, setFavoriteOnly] = useState(false);
  const [runProfile, setRunProfile] = useState("");
  const refresh = useCallback(async () => {
    const [p, j, r] = await Promise.all([
      api<Profile[]>("/profiles"),
      api<Match[]>("/jobs"),
      api<Run[]>("/runs"),
    ]);
    setProfiles(p);
    setMatches(j);
    setRuns(r);
  }, []);
  useEffect(() => {
    api<User>("/me")
      .then(setUser)
      .catch(() => {})
      .finally(() => setLoading(false));
    const expire = () => {
      setUser(null);
      setMatches([]);
      setProfiles([]);
      setRuns([]);
      setCareer("");
      setSelected(null);
      setEdit(null);
    };
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, []);
  useEffect(() => {
    if (!user) return;
    refresh().catch((e) => setError(e.message));
    api<{ content: string }>("/career")
      .then((c) => setCareer(c.content))
      .catch((e) => setError(e.message));
    const timer = setInterval(
      () => refresh().catch((e) => setError(e.message)),
      10000,
    );
    return () => clearInterval(timer);
  }, [user, refresh]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 5000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const profileName = (id: number) =>
    profiles.find((p) => p.id === id)?.name || "Suchprofil";
  async function searchNow() {
    const id = runProfile || String(profiles[0]?.id || "");
    if (!id) {
      setPage("profiles");
      setNotice("Lege zuerst ein Suchprofil an.");
      return;
    }
    await act(async () => {
      await api(`/profiles/${id}/run`, "POST");
      await refresh();
      setNotice(
        "Die Suche wurde gestartet. Ergebnisse erscheinen automatisch.",
      );
    });
  }
  async function updateMatch(
    m: Match,
    patch: Partial<Match> & { reason?: string },
  ) {
    await act(async () => {
      await api(`/matches/${m.id}`, "PATCH", {
        status: m.status,
        favorite: Boolean(m.favorite),
        ...patch,
      });
      await refresh();
      if (selected?.id === m.id) setSelected({ ...m, ...patch });
      setNotice("Gespeichert.");
    });
  }
  const filtered = matches
    .filter(
      (m) =>
        (!profileFilter || String(m.profile_id) === profileFilter) &&
        (!statusFilter || m.status === statusFilter) &&
        (!favoriteOnly || m.favorite) &&
        m.assessment.score >= Number(scoreFilter) &&
        `${m.job.title} ${m.job.company}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        m.job.location.toLowerCase().includes(locationFilter.toLowerCase()) &&
        (m.job.salary || "").toLowerCase().includes(salaryFilter.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "score"
        ? b.assessment.score - a.assessment.score
        : b.created_at.localeCompare(a.created_at),
    );
  const activeRuns = runs.filter((r) =>
    ["running", "queued"].includes(r.status),
  );
  if (loading)
    return (
      <div className="loading">
        <Radar className="spin" size={36} />
        <span>Career Radar wird geladen …</span>
      </div>
    );
  if (!user)
    return (
      <div className="login-page">
        <div className="login-story">
          <div className="brand">
            <Radar size={32} /> career<span>radar</span>
          </div>
          <div>
            <span className="eyebrow">DEIN NÄCHSTER SCHRITT</span>
            <h1>
              Gute Chancen.
              <br />
              Klarer Fokus.
            </h1>
            <p>
              Ein persönlicher Radar für Stellen, die zu deinen Fähigkeiten und
              Ambitionen passen.
            </p>
          </div>
          <div className="login-foot">Deine Karriere. Dein Kurs.</div>
        </div>
        <main className="login-main">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              act(async () => {
                await api("/login", "POST", Object.fromEntries(f));
                setUser(await api<User>("/me"));
              });
            }}
          >
            <div className="small-brand">
              <Radar /> Career Radar
            </div>
            <span className="eyebrow">WILLKOMMEN ZURÜCK</span>
            <h2>Auf Chancen-Kurs.</h2>
            <p className="muted">
              Melde dich bei deinem persönlichen Dashboard an.
            </p>
            {error && (
              <div role="alert" className="alert error">
                {error}
              </div>
            )}
            <label>
              Benutzername
              <input
                name="username"
                autoComplete="username"
                required
                autoFocus
                maxLength={100}
              />
            </label>
            <label>
              Passwort
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                maxLength={1000}
              />
            </label>
            <Button disabled={busy} type="submit">
              {busy ? <LoaderCircle className="spin" size={16} /> : null}
              Anmelden <ArrowUpRight size={17} />
            </Button>
            <p className="login-hint">
              Der erste Zugang wird über die Server-Konfiguration eingerichtet.
            </p>
          </form>
        </main>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("dashboard");
          }}
        >
          <Radar size={29} /> career<span>radar</span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">CR</span>
          <div>
            Mein Workspace<small>Persönlicher Karriere-Radar</small>
          </div>
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          {[
            ["dashboard", "Entdecken", LayoutDashboard],
            ["profiles", "Suchprofile", SlidersHorizontal],
            ["career", "Mein Karriereprofil", UserRound],
            ["runs", "Suchhistorie", History],
          ].map(([id, label, Icon]) => {
            const I = Icon as typeof Radar;
            return (
              <button
                key={String(id)}
                className={page === id ? "active" : ""}
                onClick={() => setPage(String(id))}
              >
                <I size={19} />
                {String(label)}
                {id === "dashboard" && (
                  <span className="nav-count">
                    {matches.filter((m) => m.status === "new").length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="engine">
            <span className={user.openai_configured ? "dot" : "dot warning"} />
            <div>
              {user.openai_configured ? "OpenAI verbunden" : "API-Key fehlt"}
              <small>Privat auf deinem Server</small>
            </div>
          </div>
          <button
            className="account"
              aria-label="Abmelden"
            onClick={() =>
              act(async () => {
                await api("/logout", "POST");
                setUser(null);
                setMatches([]);
                setSelected(null);
                setCareer("");
              })
            }
          >
            <span className="avatar">{user.username[0].toUpperCase()}</span>
            <div>
              {user.username}
              <small>Abmelden</small>
            </div>
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <span className="muted">Workspace</span>
            <ChevronRight size={14} />
            <span>
              {
                (
                  {
                    dashboard: "Entdecken",
                    profiles: "Suchprofile",
                    career: "Mein Karriereprofil",
                    runs: "Suchhistorie",
                  } as Record<string, string>
                )[page]
              }
            </span>
          </div>
          <span className="private-label">
            <span className="dot" /> Privat & selbst gehostet
          </span>
        </header>
        <main className="content">
          {error && (
            <div role="alert" className="alert error">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button
                aria-label="Meldung schließen"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="alert success">
              <CircleCheck size={18} />
              {notice}
            </div>
          )}
          {!user.openai_configured && (
            <div className="alert warning">
              <AlertCircle size={18} />
              <span>
                Für die Jobsuche OPENAI_API_KEY in der Server-Konfiguration
                hinterlegen und die App neu starten.
              </span>
            </div>
          )}
          <div className="page-heading">
            <div>
              <span className="eyebrow">DEIN KARRIERE-RADAR</span>
              <h1>
                {
                  (
                    {
                      dashboard: "Chancen entdecken.",
                      profiles: "Dein Fokus. Deine Suche.",
                      career: "Was dich ausmacht.",
                      runs: "Dein Radar in Aktion.",
                    } as Record<string, string>
                  )[page]
                }
              </h1>
              <p className="muted">
                {
                  (
                    {
                      dashboard:
                        "Passende Stellen finden. Bewusst den nächsten Schritt machen.",
                      profiles:
                        "Definiere, wonach dein Radar Ausschau halten soll.",
                      career:
                        "Dieses Profil bildet die Grundlage für alle KI-Bewertungen.",
                      runs: "Alle Suchläufe, Ergebnisse und geschätzten API-Kosten im Blick.",
                    } as Record<string, string>
                  )[page]
                }
              </p>
            </div>
            {page === "dashboard" || page === "runs" ? (
              <div className="search-action">
                {profiles.length > 1 && (
                  <select
                    aria-label="Suchprofil für sofortige Suche"
                    value={runProfile || profiles[0]?.id}
                    onChange={(e) => setRunProfile(e.target.value)}
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                <Button
                  disabled={
                    busy ||
                    !user.openai_configured ||
                    activeRuns.some(
                      (r) =>
                        String(r.profile_id) ===
                        (runProfile || String(profiles[0]?.id)),
                    )
                  }
                  onClick={searchNow}
                >
                  <Radar size={17} />
                  Suche jetzt ausführen
                </Button>
              </div>
            ) : page === "profiles" ? (
              <Button onClick={() => setEdit({ ...blank })}>
                <Plus size={17} />
                Suchprofil anlegen
              </Button>
            ) : null}
          </div>
          {page === "dashboard" && (
            <>
              <section className="stats">
                {[
                  [
                    matches.filter((m) => m.status === "new").length,
                    "Neue Stellen",
                    BriefcaseBusiness,
                    "Bereit zum Entdecken",
                  ],
                  [
                    matches.filter((m) => m.assessment.score >= 80).length,
                    "Hohe Passung",
                    Sparkles,
                    "Heuristischer Score ab 80",
                  ],
                  [
                    profiles.filter((p) => p.enabled).length,
                    "Aktive Suchprofile",
                    Radar,
                    "Dein persönlicher Suchfokus",
                  ],
                ].map(([value, label, Icon, sub]) => {
                  const I = Icon as typeof Radar;
                  return (
                    <div className="stat" key={String(label)}>
                      <div>
                        <span>{String(label)}</span>
                        <I size={20} />
                      </div>
                      <strong>{String(value).padStart(2, "0")}</strong>
                      <small>{String(sub)}</small>
                    </div>
                  );
                })}
              </section>
              {!career.trim() && (
                <div className="onboarding">
                  <div className="onboarding-icon">
                    <UserRound size={24} />
                  </div>
                  <div>
                    <h3>Gute Matches beginnen bei dir.</h3>
                    <p>
                      Ergänze deine Erfahrung, Stärken und Ziele für
                      aussagekräftige Bewertungen.
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => setPage("career")}>
                    Karriereprofil ausfüllen <ArrowUpRight size={16} />
                  </Button>
                </div>
              )}
              <section className="results-section">
                <div className="section-heading">
                  <div>
                    <h2>
                      Deine Stellen{" "}
                      <span className="count">{filtered.length}</span>
                    </h2>
                    <p className="muted">
                      Entdeckt für dich. Bewertet anhand deines Profils.
                    </p>
                  </div>
                  <div className="exports">
                    <a href="/api/export/csv">
                      <Download size={15} /> CSV
                    </a>
                    <a href="/api/export/json">JSON</a>
                  </div>
                </div>
                <div className="filters">
                  <div className="search-field">
                    <Search size={17} />
                    <input
                      aria-label="Titel oder Unternehmen suchen"
                      placeholder="Titel oder Unternehmen suchen …"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <select
                    aria-label="Suchprofil filtern"
                    value={profileFilter}
                    onChange={(e) => setProfileFilter(e.target.value)}
                  >
                    <option value="">Alle Suchprofile</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Status filtern"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="">Alle Status</option>
                    {Object.entries(statuses).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <Button
                    aria-pressed={favoriteOnly}
                    variant={favoriteOnly ? "default" : "outline"}
                    onClick={() => setFavoriteOnly(!favoriteOnly)}
                  >
                    <Star size={16} />
                    Favoriten
                  </Button>
                </div>
                <div className="subfilters">
                  <label>
                    Score
                    <select
                      value={scoreFilter}
                      onChange={(e) => setScoreFilter(e.target.value)}
                    >
                      <option value="0">Alle</option>
                      <option value="60">Ab 60</option>
                      <option value="80">Ab 80</option>
                      <option value="90">Ab 90</option>
                    </select>
                  </label>
                  <label>
                    Ort
                    <input
                      placeholder="z. B. Graz"
                      value={locationFilter}
                      onChange={(e) => setLocationFilter(e.target.value)}
                    />
                  </label>
                  <label>
                    Gehalt
                    <input
                      placeholder="Text filtern"
                      value={salaryFilter}
                      onChange={(e) => setSalaryFilter(e.target.value)}
                    />
                  </label>
                  <label className="sort">
                    Sortieren
                    <select
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
                    >
                      <option value="score">Höchste Passung</option>
                      <option value="date">Zuletzt entdeckt</option>
                    </select>
                  </label>
                </div>
                {activeRuns.length > 0 && (
                  <div className="running">
                    <LoaderCircle className="spin" size={17} /> Dein Radar
                    sucht. Neue Ergebnisse erscheinen automatisch.
                  </div>
                )}
                {filtered.length ? (
                  <div className="job-grid">
                    {filtered.map((m) => (
                      <article className="job-card" key={m.id}>
                        <div className="job-card-top">
                          <div className="company-initial">
                            {m.job.company.slice(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <strong>{m.job.company}</strong>
                            <small>{profileName(m.profile_id)}</small>
                          </div>
                          <button
                            className={
                              "favorite " + (m.favorite ? "is-favorite" : "")
                            }
                            aria-label={
                              m.favorite
                                ? "Favorit entfernen"
                                : "Als Favorit speichern"
                            }
                            disabled={busy}
                            onClick={() =>
                              updateMatch(m, { favorite: !m.favorite })
                            }
                          >
                            <Star
                              size={19}
                              fill={m.favorite ? "currentColor" : "none"}
                            />
                          </button>
                        </div>
                        <button
                          className="job-title"
                          onClick={() => setSelected(m)}
                        >
                          {m.job.title}
                        </button>
                        <div className="job-meta">
                          <span>
                            <MapPin size={14} />
                            {m.job.location}
                          </span>
                          <span>
                            <Globe2 size={14} />
                            {m.job.remote_policy}
                          </span>
                        </div>
                        <div className="job-salary">
                          {m.job.salary || "Gehalt nicht angegeben"}
                        </div>
                        <p className="job-reason">{m.assessment.reasoning}</p>
                        <div className="tags">
                          <span
                            className={
                              "tag " + (m.status === "new" ? "green" : "")
                            }
                          >
                            {statuses[m.status]}
                          </span>
                          {m.job.availability !== "confirmed" && (
                            <span className="tag amber">
                              Verfügbarkeit unbestätigt
                            </span>
                          )}
                          {m.job.austria_remote === "unconfirmed" && (
                            <span className="tag amber">
                              Remote AT ungeklärt
                            </span>
                          )}
                        </div>
                        <div className="job-footer">
                          <div
                            className={
                              "score " + (m.assessment.score < 60 ? "low" : "")
                            }
                          >
                            <strong>
                              {m.assessment.score}
                              <small>/100</small>
                            </strong>
                            <span>Passung</span>
                          </div>
                          <Button
                            variant="ghost"
                            onClick={() => setSelected(m)}
                          >
                            Details ansehen <ArrowUpRight size={17} />
                          </Button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="empty">
                    <div className="radar-illustration">
                      <Radar size={68} strokeWidth={1} />
                    </div>
                    <h3>
                      {matches.length
                        ? "Hier ist es gerade ruhig."
                        : "Deine nächste Chance wartet."}
                    </h3>
                    <p>
                      {matches.length
                        ? "Passe deine Filter an, um weitere Stellen zu entdecken."
                        : "Lege ein Suchprofil an und starte deinen ersten Suchlauf. Dein Radar findet aktuelle Stellen und bewertet ihre Passung."}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (matches.length) {
                          setQuery("");
                          setProfileFilter("");
                          setStatusFilter("");
                          setScoreFilter("0");
                          setLocationFilter("");
                          setSalaryFilter("");
                          setFavoriteOnly(false);
                        } else if (profiles.length) searchNow();
                        else setPage("profiles");
                      }}
                    >
                      {matches.length
                        ? "Filter zurücksetzen"
                        : profiles.length
                          ? "Erste Suche starten"
                          : "Suchprofil einrichten"}
                      <ArrowUpRight size={16} />
                    </Button>
                  </div>
                )}
              </section>
            </>
          )}
          {page === "profiles" && (
            <>
              <div className="info-line">
                <Clock3 size={17} /> Alle Zeitpläne verwenden Europe/Vienna,
                inklusive Sommerzeit.
              </div>
              <div className="profile-grid">
                {profiles.map((p) => (
                  <article className="profile-card" key={p.id}>
                    <div className="section-heading">
                      <div className="profile-icon">
                        {p.remote_only ? <Globe2 /> : <MapPin />}
                      </div>
                      <span className={"tag " + (p.enabled ? "green" : "")}>
                        {p.enabled ? "Aktiv" : "Pausiert"}
                      </span>
                    </div>
                    <h2>{p.name}</h2>
                    <p className="muted">{p.description || p.geography}</p>
                    <dl>
                      <div>
                        <dt>Region</dt>
                        <dd>{p.geography}</dd>
                      </div>
                      <div>
                        <dt>Zeitplan</dt>
                        <dd>
                          {schedules[p.schedule]}
                          {p.schedule === "cron" ? ` · ${p.cron}` : ""}
                        </dd>
                      </div>
                      <div>
                        <dt>Nächste Suche</dt>
                        <dd>{date(p.next_run_at)}</dd>
                      </div>
                      <div>
                        <dt>Pro Suchlauf</dt>
                        <dd>Max. {p.max_jobs} Stellen</dd>
                      </div>
                    </dl>
                    <div className="profile-actions">
                      <Button
                        variant="outline"
                        onClick={() => setEdit({ ...p })}
                      >
                        Bearbeiten
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={
                          busy ||
                          !user.openai_configured ||
                          activeRuns.some((r) => r.profile_id === p.id)
                        }
                        onClick={() =>
                          act(async () => {
                            await api(`/profiles/${p.id}/run`, "POST");
                            await refresh();
                            setNotice("Suche gestartet.");
                          })
                        }
                      >
                        <Radar size={16} />
                        Jetzt suchen
                      </Button>
                    </div>
                  </article>
                ))}
                <button
                  className="new-profile"
                  onClick={() => setEdit({ ...blank })}
                >
                  <Plus size={30} />
                  <strong>Neues Suchprofil</strong>
                  <span>Eine weitere Richtung entdecken</span>
                </button>
              </div>
              {profiles.length === 0 && (
                <div className="template-section">
                  <h2>Mit einem Fokus starten</h2>
                  <div className="templates">
                    <Button
                      variant="outline"
                      onClick={() =>
                        setEdit({
                          ...blank,
                          name: "Graz",
                          description:
                            "Produkt, Projekte und Digitalisierung mit Verantwortung.",
                        })
                      }
                    >
                      <MapPin size={18} /> Graz & Umgebung{" "}
                      <ArrowUpRight size={16} />
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setEdit({
                          ...blank,
                          name: "International Remote",
                          geography:
                            "International; dauerhaft remote aus Österreich",
                          remote_only: true,
                          description:
                            "Product, Operations und Strategy – von Österreich aus.",
                          search_prompt:
                            "Finde aktuelle internationale Remote-Stellen in Product Management, Product Operations und Strategy. Ausschließlich dauerhaft remote aus Österreich mögliche Beschäftigung. Prüfe Austria eligibility und benenne fehlende Belege ausdrücklich.",
                        })
                      }
                    >
                      <Globe2 size={18} />
                      International Remote <ArrowUpRight size={16} />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
          {page === "career" && (
            <form
              className="career-form panel"
              onSubmit={(e) => {
                e.preventDefault();
                act(async () => {
                  await api("/career", "PUT", { content: career });
                  setNotice("Karriereprofil gespeichert.");
                });
              }}
            >
              <div className="section-heading">
                <div>
                  <h2>Dein persönliches Profil</h2>
                  <p className="muted">
                    Was bringst du mit – und wo möchtest du hin?
                  </p>
                </div>
                <UserRound size={24} />
              </div>
              <label>
                Erfahrung, Qualifikationen und Karriereziele
                <textarea
                  value={career}
                  onChange={(e) => setCareer(e.target.value)}
                  maxLength={16000}
                  rows={17}
                  placeholder={
                    "Zum Beispiel:\n\nMeine bisherige Erfahrung …\n\nMeine Stärken und Qualifikationen …\n\nIch möchte Verantwortung übernehmen für …\n\nWichtig sind mir …\n\nNicht infrage kommen …"
                  }
                />
              </label>
              <div className="form-footer">
                <span className="muted">
                  Wird bei jeder neuen Bewertung berücksichtigt.
                </span>
                <Button type="submit" disabled={busy}>
                  Profil speichern
                </Button>
              </div>
            </form>
          )}
          {page === "runs" && (
            <>
              <section className="stats">
                <div className="stat">
                  <span>Suchläufe gesamt angezeigt</span>
                  <strong>{runs.length}</strong>
                  <small>Die letzten 100 Durchläufe</small>
                </div>
                <div className="stat">
                  <span>Verarbeitete Tokens</span>
                  <strong>
                    {runs
                      .reduce((n, r) => n + r.input_tokens + r.output_tokens, 0)
                      .toLocaleString("de-AT")}
                  </strong>
                  <small>Eingabe und Ausgabe</small>
                </div>
                <div className="stat">
                  <span>Geschätzte API-Kosten</span>
                  <strong>
                    {usd(runs.reduce((n, r) => n + r.estimated_usd, 0))}
                  </strong>
                  <small>Konfigurierbare Schätzpreise, keine Abrechnung</small>
                </div>
              </section>
              <div className="panel history-panel">
                <h2>Suchhistorie</h2>
                {!runs.length ? (
                  <div className="empty">
                    <History size={36} />
                    <h3>Noch keine Suchläufe.</h3>
                    <p>
                      Starte eine Suche, um hier Ergebnisse und Verbrauch zu
                      sehen.
                    </p>
                  </div>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Suchprofil / Start</th>
                          <th>Status</th>
                          <th>Gefunden</th>
                          <th>Neue Matches</th>
                          <th>Tokens</th>
                          <th>Schätzung</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <strong>{profileName(r.profile_id)}</strong>
                              <small>{date(r.started_at)}</small>
                              {r.error && (
                                <span className="run-error">{r.error}</span>
                              )}
                            </td>
                            <td>
                              <span
                                className={
                                  "tag " +
                                  (r.status === "completed"
                                    ? "green"
                                    : ["failed", "interrupted"].includes(
                                          r.status,
                                        )
                                      ? "amber"
                                      : "")
                                }
                              >
                                {runStatuses[r.status]}
                              </span>
                            </td>
                            <td>{r.found}</td>
                            <td>{r.new_jobs}</td>
                            <td>
                              {(
                                r.input_tokens + r.output_tokens
                              ).toLocaleString("de-AT")}
                            </td>
                            <td>{usd(r.estimated_usd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
          <footer className="page-footer">
            <span>
              <Radar size={14} /> Career Radar
            </span>
            <span>Weniger suchen. Bewusster entscheiden.</span>
          </footer>
        </main>
      </div>
      {edit && (
        <ProfileEditor
          initial={edit}
          error={error}
          busy={busy}
          close={() => setEdit(null)}
          save={(p) =>
            act(async () => {
              await api(
                `/profiles${p.id ? "/" + p.id : ""}`,
                p.id ? "PUT" : "POST",
                p,
              );
              await refresh();
              setEdit(null);
              setNotice("Suchprofil gespeichert.");
            })
          }
        />
      )}
      {selected && (
        <JobDetail
          match={selected}
          busy={busy}
          close={() => setSelected(null)}
          update={(patch) => updateMatch(selected, patch)}
        />
      )}
    </div>
  );
}
function ProfileEditor({
  initial,
  close,
  save,
  busy,
  error,
}: {
  error: string;
  initial: Profile;
  close: () => void;
  save: (p: Profile) => void;
  busy: boolean;
}) {
  const [p, setP] = useState(initial),
    [sources, setSources] = useState(initial.sources.join(", "));
  function field<K extends keyof Profile>(k: K, v: Profile[K]) {
    setP({ ...p, [k]: v });
  }
  return (
    <Modal
      title={p.id ? "Suchprofil bearbeiten" : "Suchprofil anlegen"}
      close={close}
      wide
    >
      {error && (
        <div role="alert" className="alert error">
          {error}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save({
            ...p,
            sources: sources
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          });
        }}
      >
        <div className="form-grid">
          <label>
            Name
            <input
              required
              maxLength={100}
              value={p.name}
              onChange={(e) => field("name", e.target.value)}
            />
          </label>
          <label>
            Region & Arbeitsort
            <input
              maxLength={1000}
              value={p.geography}
              onChange={(e) => field("geography", e.target.value)}
            />
          </label>
        </div>
        <label>
          Beschreibung
          <textarea
            rows={2}
            maxLength={3000}
            value={p.description}
            onChange={(e) => field("description", e.target.value)}
          />
        </label>
        <label>
          Suchprompt
          <textarea
            required
            rows={4}
            maxLength={8000}
            value={p.search_prompt}
            onChange={(e) => field("search_prompt", e.target.value)}
          />
          <small>Welche Rollen soll die Webrecherche finden?</small>
        </label>
        <label>
          Bewertungsprompt
          <textarea
            required
            rows={4}
            maxLength={8000}
            value={p.evaluation_prompt}
            onChange={(e) => field("evaluation_prompt", e.target.value)}
          />
          <small>Was macht eine Stelle für dich passend?</small>
        </label>
        <label>
          Suchquellen (optional)
          <input
            value={sources}
            onChange={(e) => setSources(e.target.value)}
            placeholder="karriere.at, jobs.example.com"
          />
          <small>
            Domains durch Komma trennen. Leer = offene Websuche. Quellen
            beschränken auch Arbeitgeberseiten.
          </small>
        </label>
        <div className="form-grid">
          <label>
            Zeitplan
            <select
              aria-label="Zeitplan"
              value={p.schedule}
              onChange={(e) => field("schedule", e.target.value)}
            >
              {Object.entries(schedules).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Maximale Stellen pro Lauf
            <input
              type="number"
              min={1}
              max={30}
              required
              value={p.max_jobs}
              onChange={(e) => field("max_jobs", Number(e.target.value))}
            />
          </label>
        </div>
        {p.schedule === "cron" && (
          <label>
            Cron-Ausdruck
            <input
              required
              value={p.cron}
              onChange={(e) => field("cron", e.target.value)}
              placeholder="0 8 * * 1"
            />
            <small>
              Minute Stunde Tag Monat Wochentag · Europe/Vienna · Mo=0, So=6
              (oder mon–sun)
            </small>
          </label>
        )}
        <div className="checkboxes">
          <label>
            <input
              type="checkbox"
              checked={p.remote_only}
              onChange={(e) => field("remote_only", e.target.checked)}
            />
            Nur Remote aus Österreich
          </label>
          <label>
            <input
              type="checkbox"
              checked={p.enabled}
              onChange={(e) => field("enabled", e.target.checked)}
            />
            Suchprofil aktiviert
          </label>
        </div>
        <div className="form-footer">
          <Button type="button" variant="outline" onClick={close}>
            Abbrechen
          </Button>
          <Button type="submit" disabled={busy}>
            Suchprofil speichern
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function JobDetail({
  match: m,
  close,
  update,
  busy,
}: {
  match: Match;
  close: () => void;
  update: (p: Partial<Match> & { reason?: string }) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState(""),
    a = m.assessment,
    j = m.job;
  return (
    <Modal title="Stellendetails" close={close} wide>
      <div className="detail-header">
        <span className="eyebrow">{j.company}</span>
        <h2>{j.title}</h2>
        <p className="muted">
          {j.location} · {j.remote_policy}
        </p>
        <div className="tags">
          <span className="tag green">{a.score}/100 Passung · heuristisch</span>
          <span className="tag">
            {a.role_type === "stretch" ? "Stretch-Rolle" : "Realistische Rolle"}
          </span>
          <span className="tag">{j.salary || "Gehalt unbekannt"}</span>
        </div>
      </div>
      {(j.availability !== "confirmed" ||
        j.austria_remote === "unconfirmed") && (
        <div className="alert warning">
          <AlertCircle size={18} />
          <span>
            {j.availability !== "confirmed" &&
              "Verfügbarkeit nicht bestätigt. "}
            {j.austria_remote === "unconfirmed" &&
              "Dauerhafte Remote-Arbeit aus Österreich nicht bestätigt."}
          </span>
        </div>
      )}
      <section className="detail-section">
        <h3>Die KI-Einschätzung</h3>
        <p>{a.reasoning}</p>
        <div className="form-grid">
          <div>
            <h4>Das bringst du mit</h4>
            <ul>
              {a.matching_qualifications.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4>Hier fehlt noch etwas</h4>
            <ul>
              {a.missing_qualifications.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        </div>
        <h4>Entscheidungskompetenz & Gestaltungsspielraum</h4>
        <p>{a.decision_authority}</p>
        <h4>Entwicklungspotenzial</h4>
        <p>{a.development_potential}</p>
        {a.red_flags.length > 0 && (
          <>
            <h4>Warnsignale</h4>
            <ul>
              {a.red_flags.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section className="detail-section">
        <h3>Über die Stelle</h3>
        <p className="whitespace">{j.description}</p>
        <h4>Anforderungen laut Anzeige</h4>
        <ul>
          {j.requirements.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
        <p className="muted">
          Veröffentlicht: {j.published_at || "Unbekannt"}
          <br />
          Erstmals recherchiert: {date(m.first_seen_at)}
          <br />
          Zuletzt gefunden: {date(m.last_seen_at)}
        </p>
        <div className="detail-links">
          <a href={j.url} target="_blank" rel="noopener noreferrer">
            Stellenanzeige öffnen <ArrowUpRight size={16} />
          </a>
          <a href={j.source_url} target="_blank" rel="noopener noreferrer">
            Recherchequelle <ArrowUpRight size={16} />
          </a>
        </div>
      </section>
      <section className="detail-section">
        <h3>Deine Entscheidung</h3>
        <label>
          Status
          <select
            disabled={busy}
            aria-label="Status"
            value={m.status}
            onChange={(e) => update({ status: e.target.value })}
          >
            {Object.entries(statuses).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ablehnungsgrund (optional)
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            list="reasons"
            maxLength={2000}
            placeholder="Weshalb passt diese Stelle nicht?"
          />
          <datalist id="reasons">
            {[
              "Zu technisch",
              "Zu wenig Verantwortung",
              "Zu senior",
              "Falscher Standort",
              "Uninteressantes Unternehmen",
            ].map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <div className="form-footer">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => update({ status: "rejected", reason })}
          >
            Ablehnen
          </Button>
          <Button
            disabled={busy}
            onClick={() => update({ status: "interesting" })}
          >
            Interessant <Star size={16} />
          </Button>
        </div>
        <p className="muted">
          Dein Feedback fließt in künftige Bewertungen dieses Suchprofils ein.
        </p>
      </section>
    </Modal>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
