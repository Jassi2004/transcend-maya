import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-600.css";
import "@fontsource/dm-sans/latin-700.css";
import "@fontsource/dm-sans/latin-800.css";
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/manrope/latin-700.css";
import "@fontsource/manrope/latin-800.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Boxes,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Download,
  ExternalLink,
  Eye,
  FileJson,
  FlaskConical,
  GitBranch,
  Globe,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  MemoryStick,
  Network,
  Orbit,
  Play,
  Plus,
  Radio,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Sparkles,
  Terminal,
  TriangleAlert,
  Workflow,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type {
  Check as CheckType,
  Company,
  Lesson,
  Run,
  Scenario,
  Snapshot,
  Step,
} from "../shared/types.js";
import "./styles.css";
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(
      `Server returned an unreadable response (HTTP ${res.status}). Check the connection and inspect the saved run before retrying.`,
    );
  }
  if (!res.ok) throw new Error(body.error || "Request failed.");
  return body;
}
const ago = (date: string) => {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(date).getTime()) / 1000),
  );
  return seconds < 60
    ? "just now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`;
};
const statusLabel = (s: string) =>
  ({
    awaiting_approval: "Needs approval",
    running: "Investigating",
    resolved: "Resolved",
    rejected: "Rejected",
    escalated: "Escalated",
    failed: "Failed",
    interrupted: "Interrupted",
  })[s] || s;
const agents = [
  {
    id: "observer",
    name: "Observer",
    role: "Collects the signal",
    icon: Radio,
    color: "cyan",
    description:
      "Captures source evidence from a live demo connector or isolated fixture.",
    permission: "Read-only evidence",
  },
  {
    id: "supervisor",
    name: "Supervisor",
    role: "Keeps the run on track",
    icon: Orbit,
    color: "violet",
    description:
      "Coordinates a bounded workflow and escalates cases outside the sandbox’s capabilities.",
    permission: "Delegate · escalate",
  },
  {
    id: "investigator",
    name: "Investigator",
    role: "Finds the cause",
    icon: Search,
    color: "amber",
    description:
      "Reproduces the failed contract and identifies a minimal configuration correction.",
    permission: "Read · fixture replay",
  },
  {
    id: "repair",
    name: "Repair specialist",
    role: "Proposes a correction",
    icon: Code2,
    color: "blue",
    description:
      "Produces an exact configuration patch. It cannot approve its own work.",
    permission: "Propose only",
  },
  {
    id: "verifier",
    name: "Verifier",
    role: "Checks the result",
    icon: ShieldCheck,
    color: "green",
    description:
      "Runs independent contract assertions and live post-repair checks when connected.",
    permission: "Verify · report",
  },
  {
    id: "memory",
    name: "Memory reviewer",
    role: "Keeps useful lessons",
    icon: MemoryStick,
    color: "rose",
    description:
      "Matches scoped, operator-reviewed playbooks. Rejects expired or mismatched runtime context.",
    permission: "Retrieve · propose lessons",
  },
];

function App() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [key, setKey] = useState(""),
    [loginError, setLoginError] = useState(""),
    [companies, setCompanies] = useState<Company[]>([]),
    [companyId, setCompanyId] = useState(""),
    [data, setData] = useState<Snapshot>(),
    [view, setView] = useState("Control room"),
    [selected, setSelected] = useState(""),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [connectionError, setConnectionError] = useState(""),
    [toast, setToast] = useState(""),
    [dialog, setDialog] = useState<"launch" | "onboard" | null>(null),
    [review, setReview] = useState<Lesson | null>(null),
    [busy, setBusy] = useState("");
  const selectedCompany = useRef(companyId);
  selectedCompany.current = companyId;
  async function loadCompanies() {
    const all = await api<Company[]>("/api/companies");
    setCompanies(all);
    if (!companyId && all[0]) setCompanyId(all[0].id);
  }
  useEffect(() => {
    void api<{ authenticated: boolean }>("/api/meta")
      .then((meta) => {
        setAuth(meta.authenticated);
        if (meta.authenticated)
          void loadCompanies().catch((e) => setError(e.message));
      })
      .catch((e) => setLoginError(e.message));
  }, []);
  async function refresh(id = companyId) {
    if (!id) return;
    try {
      const snapshot = await api<Snapshot>(`/api/companies/${id}/snapshot`);
      if (selectedCompany.current !== id) return;
      setData(snapshot);
      setCompanies(snapshot.companies);
      setConnectionError("");
    } catch (e) {
      setConnectionError((e as Error).message);
    }
  }
  useEffect(() => {
    setData(undefined);
    setSelected("");
    void refresh(companyId);
    const timer = setInterval(() => void refresh(companyId), 1000);
    return () => clearInterval(timer);
  }, [companyId]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ token: key }),
      });
      setKey("");
      setAuth(true);
      await loadCompanies();
    } catch (e) {
      setLoginError((e as Error).message);
    }
  }
  async function action(
    name: string,
    fn: () => Promise<unknown>,
    message: string,
  ) {
    setBusy(name);
    setError("");
    try {
      await fn();
      await refresh();
      setToast(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const prefix = `/api/companies/${companyId}`;
  const run = data?.runs.find((r) => r.id === selected) || data?.runs[0];
  const runs = (data?.runs || []).filter((r) =>
    `${data?.incidents.find((i) => i.id === r.incidentId)?.title} ${r.status} ${r.id}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  if (auth === null)
    return (
      <div className="boot">
        <Orbit className="spin" />
        <strong>MAYA</strong>
        <span>Opening the yard…</span>
        {loginError && <p>{loginError}</p>}
      </div>
    );
  if (!auth)
    return (
      <div className="login-page">
        <div className="login-art">
          <Logo />
          <span className="eyebrow">MULTI-AGENT YARD FOR AUTOMATION</span>
          <h1>
            Good systems
            <br />
            learn from
            <br />
            <em>what happened.</em>
          </h1>
          <p>
            An isolated place to investigate incidents, verify repairs, and
            remember what worked.
          </p>
          <span className="mode-label">
            <FlaskConical size={14} />
            Deterministic V1 · live Duo not connected
          </span>
        </div>
        <form className="login-form" onSubmit={(e) => void login(e)}>
          <span className="agent-icon violet">
            <LockKeyhole />
          </span>
          <h2>Enter the sandbox.</h2>
          <p>This instance is protected with an operator access key.</p>
          <label>
            Sandbox access key
            <input
              type="password"
              autoComplete="current-password"
              required
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoFocus
            />
          </label>
          {loginError && (
            <div className="error-banner" role="alert">
              {loginError}
            </div>
          )}
          <button className="button primary">
            Open MAYA <ArrowRight size={16} />
          </button>
          <small>
            Your key stays out of agent context and evidence exports.
          </small>
        </form>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <div className="company-switch">
          <span className="company-avatar">
            {data?.company.name.slice(-1) || "A"}
          </span>
          <div>
            <small>WORKSPACE</small>
            <select
              aria-label="Company workspace"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <ChevronDown size={13} />
        </div>
        <div className="nav-label">OPERATIONS</div>
        <nav>
          {[
            { name: "Control room", icon: LayoutIcon },
            { name: "Workforce", icon: Network },
            { name: "Memory", icon: BookOpen },
            { name: "Evidence", icon: Layers3 },
            { name: "Environment", icon: Settings2 },
          ].map(({ name, icon: Icon }) => (
            <button
              key={name}
              aria-label={name}
              className={`nav-item ${view === name ? "active" : ""}`}
              onClick={() => setView(name)}
            >
              <Icon size={17} />
              <span>{name}</span>
              {name === "Memory" && !!data?.metrics.activeLessons && (
                <b>{data.metrics.activeLessons}</b>
              )}
              {name === "Control room" && !!data?.metrics.awaiting && (
                <i className="nav-dot" />
              )}
            </button>
          ))}
        </nav>
        <button
          className="add-workspace"
          aria-label="New company"
          onClick={() => setDialog("onboard")}
        >
          <Plus size={15} />
          <span>New company</span>
        </button>
        <div className="sidebar-bottom">
          <div className="lab-note">
            <FlaskConical size={19} />
            <strong>A safe place to break things.</strong>
            <p>
              Every action has a scope.
              <br />
              Every lesson has a source.
            </p>
            <span>LOCAL-FIRST · V1</span>
          </div>
          <div className="operator">
            <span className="operator-avatar">OP</span>
            <div>
              <strong>Sandbox operator</strong>
              <small>Human approval enabled</small>
            </div>
            <span className="online-dot" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            Sandbox <ChevronRight size={11} />
            <strong>{data?.company.name || "Opening…"}</strong>
            <select
              className="mobile-workspace"
              aria-label="Mobile company workspace"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="environment-tag">DEVELOPMENT</span>
          </div>
          <div className="topbar-right">
            <span className="mode-label">
              <span className="online-dot" />
              Deterministic lab
            </span>
            <a
              href="/api/health"
              target="_blank"
              rel="noreferrer"
              className="icon-button"
              aria-label="Open health endpoint"
            >
              <Activity size={16} />
            </a>
            <span className="top-avatar">OP</span>
          </div>
        </header>
        <main>
          <div className="page-header">
            <div>
              <div className="eyebrow">
                {view === "Control room"
                  ? "YOUR POST-CODE COMMAND CENTER"
                  : view === "Memory"
                    ? "KNOWLEDGE THAT EARNS ITS PLACE"
                    : view === "Workforce"
                      ? "ONE WORKFORCE. CLEAR RESPONSIBILITIES."
                      : view === "Evidence"
                        ? "EVERY DECISION LEAVES A TRACE"
                        : "CONTEXT BEFORE ACTION"}
              </div>
              <h1>
                {view === "Control room" ? (
                  <>
                    Operations, with a <span>memory.</span>
                  </>
                ) : view === "Memory" ? (
                  <>
                    Learn once. <span>Verify every time.</span>
                  </>
                ) : view === "Workforce" ? (
                  <>
                    Meet the <span>workforce.</span>
                  </>
                ) : view === "Evidence" ? (
                  <>
                    Show your <span>working.</span>
                  </>
                ) : (
                  <>
                    Know your <span>environment.</span>
                  </>
                )}
              </h1>
              <p>
                {view === "Control room"
                  ? "From the first signal to a verified recovery. You stay in control."
                  : view === "Memory"
                    ? "Candidate lessons become trusted playbooks only after your review."
                    : view === "Workforce"
                      ? "Bounded workers with explicit permissions. Powered by deterministic rules in V1."
                      : view === "Evidence"
                        ? "Company-scoped events, approvals, and source records. Preserved across restarts."
                        : "Company context, connected services, and the boundaries of this sandbox."}
              </p>
            </div>
            <div className="header-actions">
              <button
                className="button secondary"
                onClick={() => window.open(`${prefix}/export`, "_blank")}
                disabled={!data}
              >
                <Download size={14} />
                Export evidence
              </button>
              <button
                className="button primary"
                onClick={() => setDialog("launch")}
                disabled={!data}
              >
                <Plus size={15} />
                Inject incident
              </button>
            </div>
          </div>
          {(error || connectionError) && (
            <div className="error-banner" role="alert">
              <TriangleAlert size={16} />
              <span>{error || connectionError}</span>
              <button
                onClick={() => {
                  setError("");
                  setConnectionError("");
                }}
                aria-label="Dismiss error"
              >
                <X size={15} />
              </button>
            </div>
          )}
          {data ? (
            <>
              <div className="honesty-banner">
                <FlaskConical size={14} />
                <span>
                  <strong>
                    {data.connection.configured
                      ? "Live demo connector"
                      : "Isolated simulation"}
                  </strong>{" "}
                  · Workers use deterministic rules. GitLab Duo is not
                  connected.
                </span>
                <a
                  href="#environment"
                  onClick={(e) => {
                    e.preventDefault();
                    setView("Environment");
                  }}
                >
                  View boundaries <ArrowUpRight size={12} />
                </a>
              </div>
              {view === "Control room" && (
                <>
                  <div className="metrics-grid">
                    {[
                      {
                        label: "Verified recoveries",
                        value: data.metrics.resolved,
                        icon: ShieldCheck,
                        color: "green",
                        note: "Approved and checked",
                      },
                      {
                        label: "Awaiting approval",
                        value: data.metrics.awaiting,
                        icon: Clock3,
                        color: "amber",
                        note: "Your decision comes next",
                      },
                      {
                        label: "Active playbooks",
                        value: data.metrics.activeLessons,
                        icon: BookOpen,
                        color: "violet",
                        note: "Reviewed · scoped · versioned",
                      },
                      {
                        label: "Lessons reused",
                        value: data.metrics.reused,
                        icon: Sparkles,
                        color: "cyan",
                        note: `${data.metrics.staleRejected} stale match${data.metrics.staleRejected === 1 ? "" : "es"} refused`,
                      },
                    ].map(({ label, value, icon: Icon, color, note }) => (
                      <section className="metric-card" key={label}>
                        <div className="metric-top">
                          <span>{label}</span>
                          <Icon className={color} size={16} />
                        </div>
                        <strong>{value.toString().padStart(2, "0")}</strong>
                        <small>
                          <span className={`tiny-dot ${color}`} />
                          {note}
                        </small>
                      </section>
                    ))}
                  </div>
                  <div className="control-grid">
                    <section className="panel incident-panel">
                      <div className="panel-heading">
                        <h2>
                          <Radio size={15} />
                          Incident runs <span>{data.runs.length}</span>
                        </h2>
                        <span className="live-indicator">
                          <i />
                          LIVE
                        </span>
                      </div>
                      <label className="run-search">
                        <Search size={14} />
                        <input
                          aria-label="Search incident runs"
                          placeholder="Find an incident…"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </label>
                      <div className="run-list">
                        {runs.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => setSelected(r.id)}
                            className={`run-list-item ${run?.id === r.id ? "selected" : ""}`}
                          >
                            <div className="run-item-top">
                              <span className={`run-status-dot ${r.status}`} />
                              <span className="run-id">
                                RUN-{r.id.slice(0, 4).toUpperCase()}
                              </span>
                              <time>{ago(r.createdAt)}</time>
                            </div>
                            <h3>
                              {data.incidents.find((i) => i.id === r.incidentId)
                                ?.title || "Incident run"}
                            </h3>
                            <div className="run-item-bottom">
                              <Status status={r.status} />
                              {r.memory.kind === "reused" ? (
                                <span className="memory-label">
                                  <Sparkles size={10} />
                                  Memory
                                </span>
                              ) : (
                                <ChevronRight size={13} />
                              )}
                            </div>
                          </button>
                        ))}
                        {data.incidents
                          .filter(
                            (i) =>
                              !data.runs.some((r) => r.incidentId === i.id) &&
                              i.status !== "resolved",
                          )
                          .map((i) => (
                            <button
                              className="run-item"
                              key={i.id}
                              disabled={!!busy}
                              onClick={() =>
                                void action(
                                  i.id,
                                  async () => {
                                    const next = await api<Run>(
                                      `${prefix}/incidents/${i.id}/run`,
                                      { method: "POST", body: "{}" },
                                    );
                                    setSelected(next.id);
                                  },
                                  "Saved incident opened for a fresh investigation.",
                                )
                              }
                            >
                              <strong>{i.title}</strong>
                              <span>Investigate saved incident</span>
                            </button>
                          ))}
                        {!runs.length &&
                          !data.incidents.some(
                            (i) =>
                              !data.runs.some((r) => r.incidentId === i.id) &&
                              i.status !== "resolved",
                          ) && (
                            <div className="list-empty">
                              <Radio size={25} />
                              <strong>
                                {query
                                  ? "Nothing matches yet."
                                  : "All quiet in the yard."}
                              </strong>
                              <p>
                                {query
                                  ? "Try another search."
                                  : "Inject a controlled incident to watch the workforce respond."}
                              </p>
                              {!query && (
                                <button
                                  className="text-button"
                                  onClick={() => setDialog("launch")}
                                >
                                  Start your first run <ArrowRight size={13} />
                                </button>
                              )}
                            </div>
                          )}
                      </div>
                      <div className="list-footer">
                        <Shield size={12} />
                        Scoped to {data.company.name}
                      </div>
                    </section>
                    <section className="panel run-panel">
                      {run ? (
                        <RunDetail
                          key={run.id}
                          run={run}
                          title={
                            data.incidents.find((i) => i.id === run.incidentId)
                              ?.title || ""
                          }
                          company={data.company}
                          busy={busy}
                          retry={() =>
                            void action(
                              run.id,
                              async () => {
                                const next = await api<Run>(
                                  `${prefix}/incidents/${run.incidentId}/run`,
                                  { method: "POST", body: "{}" },
                                );
                                setSelected(next.id);
                              },
                              "Fresh investigation started. No new fault was injected.",
                            )
                          }
                          recheck={() =>
                            void action(
                              run.id,
                              () =>
                                api(`${prefix}/runs/${run.id}/recheck`, {
                                  method: "POST",
                                  body: "{}",
                                }),
                              "Read-only recheck completed. No repair was repeated.",
                            )
                          }
                          decide={(decision, reason) =>
                            void action(
                              run.id,
                              () =>
                                api(`${prefix}/runs/${run.id}/decision`, {
                                  method: "POST",
                                  body: JSON.stringify({
                                    decision,
                                    reason,
                                    digest: run.proposal?.digest,
                                  }),
                                }),
                              decision === "approve"
                                ? "Repair approved and recovery checked."
                                : "Proposal rejected. No repair was applied.",
                            )
                          }
                          handoff={() =>
                            window.open(
                              `${prefix}/runs/${run.id}/handoff`,
                              "_blank",
                            )
                          }
                          openMemory={() => setView("Memory")}
                        />
                      ) : (
                        <div className="run-welcome">
                          <div className="constellation">
                            <span className="constellation-line l1" />
                            <span className="constellation-line l2" />
                            <span className="constellation-line l3" />
                            <span className="constellation-node n1">
                              <Radio size={18} />
                            </span>
                            <span className="constellation-node n2">
                              <ShieldCheck size={20} />
                            </span>
                            <span className="constellation-node n3">
                              <BookOpen size={18} />
                            </span>
                            <span className="constellation-center">
                              <Orbit size={37} />
                            </span>
                          </div>
                          <span className="eyebrow">
                            SIGNAL → ACTION → EVIDENCE → MEMORY
                          </span>
                          <h2>
                            A failure is just
                            <br />
                            the beginning of a lesson.
                          </h2>
                          <p>
                            Launch a controlled incident. Watch the workforce
                            investigate, propose a repair, and prove it worked.
                          </p>
                          <button
                            className="button primary"
                            onClick={() => setDialog("launch")}
                          >
                            <Play size={14} />
                            Launch the first incident
                          </button>
                          <div className="welcome-principles">
                            <span>
                              <Check size={12} />
                              Explicit approval
                            </span>
                            <span>
                              <Check size={12} />
                              Verified outcomes
                            </span>
                            <span>
                              <Check size={12} />
                              Scoped memory
                            </span>
                          </div>
                        </div>
                      )}
                    </section>
                  </div>
                  <div className="bottom-grid">
                    <section className="panel workforce-strip">
                      <div className="panel-heading">
                        <h2>
                          <Network size={15} />
                          Your workforce
                        </h2>
                        <button
                          className="text-button"
                          onClick={() => setView("Workforce")}
                        >
                          Meet the team <ArrowRight size={12} />
                        </button>
                      </div>
                      <div className="agent-strip">
                        {agents.map(({ id, name, icon: Icon, color }) => (
                          <div key={id}>
                            <span className={`agent-icon ${color}`}>
                              <Icon size={18} />
                            </span>
                            <strong>
                              {name === "Repair specialist"
                                ? "Repair"
                                : name === "Memory reviewer"
                                  ? "Memory"
                                  : name}
                            </strong>
                            <small>
                              {run?.status === "running" &&
                              run.steps.at(-1)?.agent === id
                                ? "Working"
                                : "Standby"}
                            </small>
                          </div>
                        ))}
                      </div>
                    </section>
                    <section className="panel memory-teaser">
                      <span className="agent-icon violet">
                        <Sparkles size={19} />
                      </span>
                      <div>
                        <h3>The second time should be smarter.</h3>
                        <p>
                          Resolve an incident. Review the lesson. Repeat it.
                          <br />
                          Then change the runtime and watch MAYA refuse a stale
                          match.
                        </p>
                        <button
                          className="text-button"
                          onClick={() => setView("Memory")}
                        >
                          Explore company memory <ArrowRight size={12} />
                        </button>
                      </div>
                    </section>
                  </div>
                </>
              )}
              {view === "Workforce" && (
                <div className="workforce-grid">
                  {agents.map(
                    ({
                      id,
                      name,
                      role,
                      icon: Icon,
                      color,
                      description,
                      permission,
                    }) => {
                      const last = data.runs
                        .flatMap((r) => r.steps)
                        .filter((s) => s.agent === id)
                        .sort((a, b) => b.at.localeCompare(a.at))[0];
                      return (
                        <section className="panel agent-card" key={id}>
                          <div className="agent-card-top">
                            <span className={`agent-icon ${color}`}>
                              <Icon size={23} />
                            </span>
                            <span className="role-tag">RULE-BASED V1</span>
                          </div>
                          <h2>{name}</h2>
                          <strong>{role}</strong>
                          <p>{description}</p>
                          <div className="permission">
                            <LockKeyhole size={12} />
                            {permission}
                          </div>
                          <div className="agent-last">
                            <small>LAST ACTION</small>
                            <span>{last?.title || "No actions yet"}</span>
                            {last && <time>{ago(last.at)}</time>}
                          </div>
                        </section>
                      );
                    },
                  )}
                </div>
              )}
              {view === "Memory" && (
                <>
                  <div className="memory-principles">
                    <span>
                      <Eye size={15} />
                      Evidence before memory
                    </span>
                    <ChevronRight size={14} />
                    <span>
                      <ShieldCheck size={15} />
                      Separate operator review
                    </span>
                    <ChevronRight size={14} />
                    <span>
                      <GitBranch size={15} />
                      Scoped, versioned reuse
                    </span>
                  </div>
                  {data.lessons.length ? (
                    <div className="lessons-grid">
                      {data.lessons.map((l) => (
                        <section
                          className={`panel lesson-card ${l.status}`}
                          key={l.id}
                        >
                          <div className="lesson-card-top">
                            <span className="agent-icon violet">
                              <BookOpen size={20} />
                            </span>
                            <span className={`lesson-status ${l.status}`}>
                              {l.status}
                            </span>
                          </div>
                          <span className="lesson-version">
                            PLAYBOOK V{l.version} ·{" "}
                            {data.company.name.toUpperCase()}
                          </span>
                          <h2>{l.title}</h2>
                          <p>
                            <Terminal size={12} />
                            {l.runtime}
                          </p>
                          <pre>{JSON.stringify(l.patch, null, 2)}</pre>
                          <div className="lesson-meta">
                            <span>Created {ago(l.createdAt)}</span>
                            <span>
                              Valid until{" "}
                              {new Date(l.expiresAt).toLocaleDateString()}
                            </span>
                          </div>
                          <div className="lesson-actions">
                            <button
                              className="button secondary"
                              onClick={() => {
                                setSelected(l.sourceRunId);
                                setView("Control room");
                              }}
                            >
                              Source run <ArrowUpRight size={13} />
                            </button>
                            {l.status === "candidate" ? (
                              <button
                                className="button primary"
                                onClick={() => setReview(l)}
                              >
                                Review lesson <ArrowRight size={13} />
                              </button>
                            ) : l.status === "active" ? (
                              <button
                                className="text-button danger"
                                disabled={busy === l.id}
                                onClick={() =>
                                  void action(
                                    l.id,
                                    () =>
                                      api(`${prefix}/lessons/${l.id}/review`, {
                                        method: "POST",
                                        body: JSON.stringify({
                                          action: "retire",
                                        }),
                                      }),
                                    "Lesson retired. Its evidence is preserved.",
                                  )
                                }
                              >
                                Retire lesson
                              </button>
                            ) : (
                              <span className="small-muted">
                                History preserved
                              </span>
                            )}
                          </div>
                        </section>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      icon={BookOpen}
                      title="Memory starts with proof."
                      text="Resolve an incident and approve its repair. MAYA will propose a lesson for separate review."
                      action={() => setDialog("launch")}
                      actionLabel="Create the first lesson"
                    />
                  )}
                </>
              )}
              {view === "Evidence" && (
                <section className="panel evidence-panel">
                  <div className="panel-heading">
                    <h2>
                      <Layers3 size={15} />
                      Audit trail <span>{data.audit.length}</span>
                    </h2>
                    <span className="small-muted">
                      Latest 200 events · company scoped
                    </span>
                  </div>
                  {data.audit.map((event) => (
                    <details className="audit-row" key={event.id}>
                      <summary>
                        <span
                          className={`audit-dot ${event.kind.includes("rejected") || event.kind.includes("failed") ? "warn" : ""}`}
                        />
                        <div>
                          <strong>{event.message}</strong>
                          <small>{event.kind}</small>
                        </div>
                        <time>
                          {new Date(event.createdAt).toLocaleString()}
                        </time>
                        <ChevronDown size={13} />
                      </summary>
                      <pre>{JSON.stringify(event.details, null, 2)}</pre>
                    </details>
                  ))}
                </section>
              )}
              {view === "Environment" && (
                <Environment
                  data={data}
                  busy={busy}
                  changeRuntime={(runtime) =>
                    void action(
                      "context",
                      () =>
                        api(`${prefix}/context`, {
                          method: "POST",
                          body: JSON.stringify({ runtime }),
                        }),
                      "Context updated. Old lessons will be checked against the new runtime.",
                    )
                  }
                  checkConnection={() =>
                    api<{ mode: string; checks: CheckType[] }>(
                      `${prefix}/connection`,
                    )
                  }
                />
              )}
              <footer>
                <span>
                  <Shield size={12} />
                  Company-isolated memory · explicit approvals · persistent
                  evidence
                </span>
                <span>
                  MAYA <i />
                  Multi-Agent Yard for Automation
                </span>
              </footer>
            </>
          ) : (
            <div className="loading">
              <LoaderCircle className="spin" />
              Loading company context…
            </div>
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
      {dialog === "launch" && data && (
        <LaunchDialog
          scenarios={data.scenarios}
          company={data.company}
          close={() => setDialog(null)}
          launch={async (scenario) => {
            const result = await api<{ run: Run }>(`${prefix}/incidents`, {
              method: "POST",
              body: JSON.stringify({ scenario, start: true }),
            });
            setSelected(result.run.id);
            setView("Control room");
            setDialog(null);
            await refresh();
          }}
        />
      )}
      {dialog === "onboard" && (
        <OnboardDialog
          close={() => setDialog(null)}
          save={async (input) => {
            const company = await api<Company>("/api/companies", {
              method: "POST",
              body: JSON.stringify(input),
            });
            await loadCompanies();
            setCompanyId(company.id);
            setView("Control room");
            setDialog(null);
            setToast(`${company.name} has its own isolated workspace.`);
          }}
        />
      )}
      {review && data && (
        <Modal
          close={() => setReview(null)}
          title="Give this lesson a second look."
          eyebrow="INDEPENDENT MEMORY REVIEW"
        >
          <p className="dialog-description">
            A resolved run is evidence for a candidate. Your review makes it
            reusable.
          </p>
          <div className="review-summary">
            <strong>{review.title}</strong>
            <span>
              Version {review.version} · {review.runtime}
            </span>
            <pre>{JSON.stringify(review.patch, null, 2)}</pre>
          </div>
          <ul className="review-list">
            <li>
              <CheckCircle2 size={15} />
              Source run resolved with an approved artifact.
            </li>
            <li>
              <CheckCircle2 size={15} />
              Candidate fixture checks passed.
            </li>
            <li>
              <CheckCircle2 size={15} />
              Reuse is restricted to this company and runtime.
            </li>
            <li>
              <Clock3 size={15} />
              Expires after 30 days; may be retired earlier.
            </li>
          </ul>
          <p className="fine-print">
            This is a deterministic sandbox lesson, not model training. Review
            the source run before promoting.
          </p>
          <button
            className="button primary full"
            disabled={busy === review.id}
            onClick={() =>
              void action(
                review.id,
                async () => {
                  await api(`${prefix}/lessons/${review.id}/review`, {
                    method: "POST",
                    body: JSON.stringify({ action: "promote" }),
                  });
                  setReview(null);
                },
                "Lesson activated. A matching future incident can reuse it.",
              )
            }
          >
            <ShieldCheck size={15} />
            Approve lesson for reuse
          </button>
        </Modal>
      )}
    </div>
  );
}
function Logo() {
  return (
    <a href="/" className="brand">
      <span className="brand-mark">
        <i />
        <i />
        <i />
        <i />
      </span>
      <strong>MAYA</strong>
      <span>LAB</span>
    </a>
  );
}
function LayoutIcon({ size = 17 }: { size?: number }) {
  return <Boxes size={size} />;
}
function Status({ status }: { status: string }) {
  return (
    <span className={`status-badge ${status}`}>
      {status === "running" ? (
        <LoaderCircle className="spin" size={10} />
      ) : status === "resolved" ? (
        <Check size={10} />
      ) : status === "awaiting_approval" ? (
        <Clock3 size={10} />
      ) : (
        <Circle size={8} />
      )}{" "}
      {statusLabel(status)}
    </span>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
  action,
  actionLabel,
}: {
  icon: typeof BookOpen;
  title: string;
  text: string;
  action: () => void;
  actionLabel: string;
}) {
  return (
    <section className="panel full-empty">
      <span className="agent-icon violet">
        <Icon size={28} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      <button className="button primary" onClick={action}>
        {actionLabel}
        <ArrowRight size={14} />
      </button>
    </section>
  );
}
function RunDetail({
  run,
  title,
  company,
  busy,
  decide,
  handoff,
  openMemory,
  retry,
  recheck,
}: {
  run: Run;
  title: string;
  company: Company;
  busy: string;
  decide: (d: "approve" | "reject", reason: string) => void;
  handoff: () => void;
  openMemory: () => void;
  retry: () => void;
  recheck: () => void;
}) {
  const [reason, setReason] = useState(
    "Reviewed the exact patch and verification evidence.",
  );
  return (
    <>
      <div className="run-detail-heading">
        <div className="run-detail-meta">
          <span className="run-id">RUN-{run.id.slice(0, 4).toUpperCase()}</span>
          <span className="small-muted">
            {run.mode === "connected"
              ? "LIVE DEMO SERVICE"
              : "ISOLATED FIXTURE"}
          </span>
          <Status status={run.status} />
        </div>
        <h2>{title}</h2>
        <div className="run-detail-sub">
          <span>
            <Terminal size={12} />
            {run.runtime}
          </span>
          <span>
            <GitBranch size={12} />
            Context r{run.contextRevision}
          </span>
          <button className="text-button" onClick={handoff}>
            <FileJson size={12} />
            Duo handoff
          </button>
        </div>
      </div>
      <div className="run-pipeline">
        {["Signal", "Investigate", "Verify", "Approve", "Remember"].map(
          (label, i) => {
            const stage =
              run.status === "resolved"
                ? 5
                : run.status === "awaiting_approval" || run.verification
                  ? 3
                  : run.proposal
                    ? 2
                    : run.steps.length >= 2
                      ? 1
                      : 0;
            return (
              <React.Fragment key={label}>
                <div
                  className={i < stage ? "done" : i === stage ? "current" : ""}
                >
                  <span>{i < stage ? <Check size={11} /> : i + 1}</span>
                  <small>{label}</small>
                </div>
                {i < 4 && <i />}
              </React.Fragment>
            );
          },
        )}
      </div>
      <div className="run-timeline">
        {run.steps.map((step: Step) => {
          const agent = agents.find((a) => a.id === step.agent),
            Icon = agent?.icon || Shield;
          return (
            <article
              className={`timeline-step ${step.state === "warning" ? "warning" : ""}`}
              key={step.id}
            >
              <span className={`step-icon ${agent?.color || "green"}`}>
                <Icon size={15} />
              </span>
              <div className="step-body">
                <div>
                  <h3>{step.title}</h3>
                  <time>
                    {new Date(step.at).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </time>
                </div>
                <span className="step-agent">{agent?.name || step.agent}</span>
                <p>{step.detail}</p>
                {step.data !== undefined && (
                  <details>
                    <summary>
                      Inspect evidence <ChevronDown size={10} />
                    </summary>
                    <pre>{JSON.stringify(step.data, null, 2)}</pre>
                  </details>
                )}
              </div>
            </article>
          );
        })}
        {run.status === "running" && (
          <div className="working-line">
            <LoaderCircle className="spin" size={14} />
            <span>Working through the next bounded step…</span>
          </div>
        )}
      </div>
      {run.proposal && (
        <section className="proposal-section">
          <div className="section-title">
            <Code2 size={14} />
            <h3>Proposed configuration change</h3>
            <span className="scope-tag">
              {run.mode === "connected" ? "DEMO ONLY" : "FIXTURE ONLY"}
            </span>
          </div>
          <div className="patch-diff">
            {Object.entries(run.proposal.patch).map(([key, value]) => (
              <React.Fragment key={key}>
                <div className="removed">
                  <span>−</span>
                  <code>
                    {key}:{" "}
                    {JSON.stringify(
                      run.proposal!.before[
                        key as keyof typeof run.proposal.before
                      ],
                    )}
                  </code>
                </div>
                <div className="added">
                  <span>+</span>
                  <code>
                    {key}: {JSON.stringify(value)}
                  </code>
                </div>
              </React.Fragment>
            ))}
          </div>
          <small className="artifact-digest">
            <LockKeyhole size={10} />
            Artifact SHA-256{" "}
            <code title={run.proposal.digest}>
              {run.proposal.digest.slice(0, 20)}…
            </code>
          </small>
        </section>
      )}
      {run.verification && (
        <section className="verification-section">
          <div className="section-title">
            <ShieldCheck size={14} />
            <h3>Independent fixture checks</h3>
            <span>
              {run.verification.candidate.filter((c) => c.passed).length}/
              {run.verification.candidate.length} passed
            </span>
          </div>
          <div className="checks-table">
            <div className="checks-header">
              <span>Contract assertion</span>
              <span>Before</span>
              <span>Candidate</span>
            </div>
            {run.verification.candidate.map((check, i) => (
              <div key={check.name}>
                <span>{check.name}</span>
                <span
                  className={
                    run.verification!.baseline[i]?.passed ? "pass" : "fail"
                  }
                >
                  {run.verification!.baseline[i]?.passed ? (
                    <Check size={12} />
                  ) : (
                    <X size={12} />
                  )}
                </span>
                <span className={check.passed ? "pass" : "fail"}>
                  {check.passed ? <Check size={12} /> : <X size={12} />}
                </span>
              </div>
            ))}
          </div>
          {run.verification.live && (
            <div className="live-checks">
              <h4>
                <Globe size={12} />
                Live service checks{" "}
                {run.verification.livePhase === "after_repair" ||
                run.status === "resolved"
                  ? "after repair"
                  : "before repair"}
              </h4>
              {run.verification.live.map((c) => (
                <div key={c.name}>
                  <span className={c.passed ? "pass" : "fail"}>
                    {c.passed ? (
                      <CheckCircle2 size={13} />
                    ) : (
                      <XCircle size={13} />
                    )}
                  </span>
                  <span>{c.name}</span>
                  <code>{String(c.actual)}</code>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {run.status === "awaiting_approval" && (
        <section className="approval-panel">
          <div>
            <span className="agent-icon amber">
              <LockKeyhole size={19} />
            </span>
            <div>
              <h3>Your approval is the next step.</h3>
              <p>
                {run.proposal?.scope}. Context r{company.revision}.
              </p>
            </div>
          </div>
          <label>
            Decision note
            <input
              aria-label="Decision note"
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="approval-actions">
            <button
              className="button secondary"
              disabled={busy === run.id || reason.trim().length < 3}
              onClick={() => decide("reject", reason)}
            >
              Reject proposal
            </button>
            <button
              className="button approve"
              disabled={busy === run.id || reason.trim().length < 3}
              onClick={() => decide("approve", reason)}
            >
              {busy === run.id ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Check size={14} />
              )}
              Approve exact repair
            </button>
          </div>
        </section>
      )}
      {run.status === "resolved" && (
        <div className="resolved-panel">
          <span className="agent-icon green">
            <CheckCheck size={22} />
          </span>
          <div>
            <h3>Recovery verified. Evidence retained.</h3>
            <p>
              {run.recoveryRechecked
                ? "Current health was confirmed by a read-only recheck. No lesson was created from the uncertain repair."
                : run.memory.kind === "reused"
                  ? "An existing verified lesson helped guide this recovery."
                  : "A candidate lesson is ready for separate operator review."}
            </p>
            <button className="text-button" onClick={openMemory}>
              Open company memory <ArrowRight size={13} />
            </button>
          </div>
        </div>
      )}
      {["failed", "interrupted", "escalated", "rejected"].includes(
        run.status,
      ) && (
        <div className="stopped-panel">
          <TriangleAlert size={17} />
          <div>
            <strong>
              {run.status === "escalated"
                ? "Some decisions belong to people."
                : "This run did not complete a verified recovery."}
            </strong>
            <p>
              {run.status === "rejected"
                ? "The proposed repair was not applied. For connected demos, the injected fault remains until a later repair or manual reset."
                : "Inspect the evidence and address the blocker before starting another run."}
            </p>
            {run.status !== "escalated" && (
              <div className="recovery-actions">
                <button
                  className="button secondary"
                  disabled={!!busy}
                  onClick={retry}
                >
                  Start fresh investigation
                </button>
                {run.mode === "connected" &&
                  run.approval &&
                  ["failed", "interrupted"].includes(run.status) && (
                    <button
                      className="button secondary"
                      disabled={!!busy}
                      onClick={recheck}
                    >
                      Recheck recovery (read-only)
                    </button>
                  )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
function Modal({
  close,
  title,
  eyebrow,
  children,
}: {
  close: () => void;
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={close}
      className="modal"
      aria-labelledby="dialog-title"
    >
      <div className="modal-top">
        <span className="eyebrow">{eyebrow}</span>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close dialog"
        >
          <X size={19} />
        </button>
      </div>
      <h2 id="dialog-title">{title}</h2>
      {children}
    </dialog>
  );
}
function LaunchDialog({
  scenarios,
  company,
  close,
  launch,
}: {
  scenarios: Scenario[];
  company: Company;
  close: () => void;
  launch: (id: string) => Promise<void>;
}) {
  const [choice, setChoice] = useState(scenarios[0]?.id || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      close={close}
      title="Make a little controlled chaos."
      eyebrow="INCIDENT LAUNCHPAD"
    >
      <p className="dialog-description">
        {company.connector === "simulation"
          ? "Choose a failure fixture. No external application will be changed."
          : `This changes the demo configuration on ${company.name}. The repair requires a separate approval.`}
      </p>
      <div className="scenario-options">
        {scenarios.map((s) => (
          <button
            key={s.id}
            className={choice === s.id ? "selected" : ""}
            onClick={() => setChoice(s.id)}
          >
            <span className="scenario-radio">{choice === s.id && <i />}</span>
            <div>
              <strong>{s.title}</strong>
              <p>{s.description}</p>
              <small>
                {s.category} · {s.severity} severity
              </small>
            </div>
            {s.patch ? <Zap size={16} /> : <LockKeyhole size={16} />}
          </button>
        ))}
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="launch-boundary">
        <Shield size={13} />
        Scope: {company.name} ·{" "}
        {company.connector === "simulation"
          ? "isolated fixtures"
          : "connected demo service"}
      </div>
      <button
        className="button primary full"
        disabled={busy || !choice}
        onClick={async () => {
          setBusy(true);
          try {
            await launch(choice);
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <LoaderCircle className="spin" size={14} />
        ) : (
          <Play size={14} />
        )}{" "}
        {busy ? "Capturing the signal…" : "Inject & investigate"}
      </button>
    </Modal>
  );
}
function OnboardDialog({
  close,
  save,
}: {
  close: () => void;
  save: (input: {
    name: string;
    stack: string;
    runtime: string;
    connector: "simulation";
  }) => Promise<void>;
}) {
  const [name, setName] = useState(""),
    [stack, setStack] = useState("TypeScript · React · SQLite"),
    [runtime, setRuntime] = useState("Node.js 24"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      close={close}
      title="A new company. A clean slate."
      eyebrow="WORKSPACE ONBOARDING"
    >
      <p className="dialog-description">
        Create an isolated simulation workspace. Live connectors are configured
        on the server; no production secrets belong in this form.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await save({ name, stack, runtime, connector: "simulation" });
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        <label>
          Company name
          <input
            required
            minLength={2}
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your demo company"
            autoFocus
          />
        </label>
        <label>
          Technology stack
          <input
            required
            minLength={2}
            maxLength={80}
            value={stack}
            onChange={(e) => setStack(e.target.value)}
          />
        </label>
        <label>
          Runtime context
          <input
            required
            minLength={2}
            maxLength={40}
            value={runtime}
            onChange={(e) => setRuntime(e.target.value)}
          />
        </label>
        <div className="onboard-policy">
          <ShieldCheck size={16} />
          <div>
            <strong>Safe defaults, already in place.</strong>
            <p>
              Separate memory. Human repair approval. Independent lesson review.
              No arbitrary shell execution.
            </p>
          </div>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <button className="button primary full" disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <Plus size={14} />
          )}
          Create simulation workspace
        </button>
      </form>
    </Modal>
  );
}
function Environment({
  data,
  busy,
  changeRuntime,
  checkConnection,
}: {
  data: Snapshot;
  busy: string;
  changeRuntime: (runtime: string) => void;
  checkConnection: () => Promise<{ mode: string; checks: CheckType[] }>;
}) {
  const [runtime, setRuntime] = useState(data.company.runtime),
    [checks, setChecks] = useState<CheckType[] | null>(null),
    [error, setError] = useState(""),
    [checking, setChecking] = useState(false);
  useEffect(() => {
    setRuntime(data.company.runtime);
    setChecks(null);
  }, [data.company.id, data.company.runtime]);
  return (
    <div className="environment-grid">
      <section className="panel environment-card">
        <div className="panel-heading">
          <h2>
            <Boxes size={16} />
            Company context
          </h2>
          <span className="scope-tag">REVISION {data.company.revision}</span>
        </div>
        <dl>
          <dt>Workspace</dt>
          <dd>{data.company.name}</dd>
          <dt>Company scope</dt>
          <dd>
            <code>{data.company.id}</code>
          </dd>
          <dt>Stack</dt>
          <dd>{data.company.stack}</dd>
          <dt>Connector</dt>
          <dd>{data.connection.label}</dd>
          <dt>Execution engine</dt>
          <dd>Deterministic workers · no LLM calls</dd>
        </dl>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            changeRuntime(runtime);
          }}
        >
          <label>
            Runtime context
            <input
              required
              minLength={2}
              maxLength={40}
              value={runtime}
              onChange={(e) => setRuntime(e.target.value)}
            />
          </label>
          <p className="fine-print">
            Change this to demonstrate stale-lesson rejection. It changes
            sandbox metadata; it does not upgrade the company’s actual runtime.
          </p>
          <button
            className="button secondary"
            disabled={busy === "context" || runtime === data.company.runtime}
          >
            <GitBranch size={14} />
            Update context revision
          </button>
        </form>
      </section>
      <section className="panel environment-card">
        <div className="panel-heading">
          <h2>
            <Globe size={16} />
            Connection check
          </h2>
          <span
            className={`connection-tag ${data.connection.configured ? "connected" : ""}`}
          >
            {data.connection.configured ? "Configured" : "Simulation"}
          </span>
        </div>
        <p>
          {data.connection.configured
            ? "Probe the demo service’s real health endpoint and behavior contract. No repair is performed by this check."
            : "This workspace uses fixture evidence. Configure a supported connector on the server to observe a real demo service."}
        </p>
        <button
          className="button secondary"
          disabled={!data.connection.configured || checking}
          onClick={async () => {
            setChecking(true);
            setError("");
            try {
              const result = await checkConnection();
              setChecks(result.checks);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setChecking(false);
            }
          }}
        >
          {checking ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <Activity size={14} />
          )}
          Test live connection
        </button>
        {error && <div className="error-banner">{error}</div>}
        {checks && (
          <div className="connection-results">
            {checks.map((c) => (
              <div key={c.name} className={c.passed ? "pass" : "fail"}>
                {c.passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                <span>{c.name}</span>
                <code>{String(c.actual)}</code>
              </div>
            ))}
          </div>
        )}
        <div className="duo-boundary">
          <GitBranch size={18} />
          <h3>GitLab Duo is the next integration.</h3>
          <p>
            The repository includes an incident-review flow definition and
            downloadable evidence handoffs. No live Duo session has been
            launched or verified by this V1.
          </p>
        </div>
      </section>
      <section className="panel boundaries-card">
        <h2>
          <ShieldCheck size={16} />
          Boundaries enforced in code
        </h2>
        <div>
          {[
            "A worker cannot approve its own repair.",
            "Approval is tied to the exact artifact and company revision.",
            "Only reviewed lessons are eligible for reuse.",
            "Memory never crosses a company scope.",
            "No production credentials or arbitrary commands are accepted.",
            "Live actions are limited to authenticated demo fault controls.",
          ].map((text) => (
            <span key={text}>
              <Check size={13} />
              {text}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
