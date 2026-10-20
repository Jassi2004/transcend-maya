import React, {
  useEffect,
  useState,
  useRef,
  useLayoutEffect,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Globe,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Network,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  TriangleAlert,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { diffLines } from "diff";
import type {
  AgentTask,
  EvidenceFile,
  OperationalLesson,
  OpsIncident,
  OpsSnapshot,
  Repository,
} from "../shared/operations.js";
import type { Company } from "../shared/types.js";
import "./operations.css";

async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(
    path,
    data === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      `MAYA did not return JSON (HTTP ${response.status}). Check the connection before repeating a remote action.`,
    );
  }
  if (!response.ok)
    throw new Error(
      result.error || `Request failed (HTTP ${response.status}).`,
    );
  return result;
}
const short = (value?: string) => value?.slice(0, 8) || "—";
const label = (value: string) =>
  ({
    awaiting_approval: "Review repair",
    needs_input: "Needs attention",
    detected: "Failure detected",
    investigating: "Duo investigating",
    publishing: "Publishing repair",
    pr_open: "Repair in CI",
    verifying: "Verifying staging",
    resolved: "Staging verified",
    rejected: "Dismissed",
    escalated: "Escalated",
    unknown: "Check remote state",
    ci: "CI / build",
    dependency: "Dependencies",
    runtime: "Runtime",
    security: "Security",
    deployment: "Deployment",
  })[value] || value.replaceAll("_", " ");
const when = (date?: string) =>
  date
    ? new Date(date).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not yet observed";
function Link({
  href,
  children,
  className = "",
}: {
  href?: string;
  children: ReactNode;
  className?: string;
}) {
  return href && /^https:\/\//.test(href) ? (
    <a
      className={`op-link ${className}`}
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {children}
      <ArrowUpRight size={13} />
    </a>
  ) : (
    <span className={className}>{children}</span>
  );
}
function Badge({ value }: { value: string }) {
  return (
    <span className={`op-badge op-state-${value}`}>
      <i />
      {label(value)}
    </span>
  );
}
function Empty({
  title,
  children,
  icon = <Workflow size={30} />,
}: {
  title: string;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="op-empty">
      {icon}
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
const roles = [
  {
    id: "observer",
    name: "Observer",
    hint: "Watches pipelines & deployment",
    icon: Eye,
  },
  {
    id: "orchestrator",
    name: "Orchestrator",
    hint: "Routes work & enforces policy",
    icon: Network,
  },
  {
    id: "investigator",
    name: "Investigator",
    hint: "Reads failed jobs & source",
    icon: Search,
  },
  {
    id: "specialist",
    name: "Fixer",
    hint: "Proposes & refines source edits",
    icon: Code2,
  },
  {
    id: "verifier",
    name: "Verifier",
    hint: "Checks CI & deployed revision",
    icon: ShieldCheck,
  },
  {
    id: "corrector",
    name: "Corrector",
    hint: "Proposes reviewed lessons",
    icon: BookOpen,
  },
  {
    id: "operator",
    name: "Human approval",
    hint: "Authorises changes & memory",
    icon: LockKeyhole,
  },
] as const;
type Role = (typeof roles)[number]["id"];
type View = "delivery" | "memory" | "evidence" | "connections";

export default function OperationsApp() {
  const [auth, setAuth] = useState<"loading" | "locked" | "ready">("loading");
  const [key, setKey] = useState("");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [workspace, setWorkspace] = useState(
    localStorage.getItem("maya.ops.workspace") || "",
  );
  const currentWorkspace = useRef(workspace);
  const [snapshot, setSnapshot] = useState<OpsSnapshot>();
  const [view, setView] = useState<View>("delivery");
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("all");
  const [onboard, setOnboard] = useState(false);
  const [inspector, setInspector] = useState<{
    role?: Role;
    evidenceId?: string;
    changes?: boolean;
  }>();
  const [evidence, setEvidence] = useState<EvidenceFile>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const base = `/api/ops/${workspace}`;
  const repo = snapshot?.repository;
  const incident =
    snapshot?.incidents.find((item) => item.id === selected) ||
    snapshot?.incidents.find(
      (item) => !["rejected", "resolved"].includes(item.status),
    ) ||
    snapshot?.incidents.find((item) => item.status === "resolved") ||
    snapshot?.incidents[0];
  const task = snapshot?.tasks.find((item) => item.id === incident?.taskId);
  const activeCount =
    snapshot?.incidents.filter(
      (item) => !["resolved", "rejected"].includes(item.status),
    ).length || 0;

  async function refresh(id = workspace) {
    if (id) {
      const result = await api<OpsSnapshot>(`/api/ops/${id}/snapshot`);
      if (currentWorkspace.current === id) setSnapshot(result);
    }
  }
  async function loadWorkspaces(preferred = workspace) {
    const all = await api<Company[]>("/api/companies");
    const states = await Promise.all(
      all.map(async (company) => ({
        company,
        state: await api<OpsSnapshot>(`/api/ops/${company.id}/snapshot`),
      })),
    );
    const connected = states.filter(({ state }) => state.repository);
    setCompanies(connected.map(({ company }) => company));
    const current =
      connected.find(({ company }) => company.id === preferred) || connected[0];
    if (current) {
      currentWorkspace.current = current.company.id;
      setWorkspace(current.company.id);
      setSnapshot(current.state);
      localStorage.setItem("maya.ops.workspace", current.company.id);
    } else {
      setWorkspace("");
      setSnapshot(undefined);
    }
  }
  async function action(
    name: string,
    operation: () => Promise<unknown>,
    message?: string,
  ) {
    setBusy(name);
    setError("");
    try {
      await operation();
      await refresh();
      if (message) setToast(message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }
  const post = (path: string, body: unknown = {}) =>
    api(`${base}${path}`, body);
  useEffect(() => {
    api<{ authenticated: boolean }>("/api/meta")
      .then(async (meta) => {
        if (meta.authenticated) {
          setAuth("ready");
          await loadWorkspaces();
        } else setAuth("locked");
      })
      .catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    if (!workspace || auth !== "ready") return;
    const timer = setInterval(() => {
      refresh(workspace).catch((err) => setError(err.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [workspace, auth]);
  useEffect(() => {
    setSelected("");
    setInspector(undefined);
  }, [workspace]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    setEvidence(undefined);
    if (inspector?.evidenceId)
      api<EvidenceFile>(`${base}/evidence/${inspector.evidenceId}`)
        .then(setEvidence)
        .catch((err) => setError(err.message));
  }, [inspector?.evidenceId, workspace]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setInspector(undefined);
        setOnboard(false);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  if (auth !== "ready")
    return (
      <div className="op-app op-gate">
        <div className="op-brand">
          <div className="op-logo">M</div>
          <span>MAYA</span>
        </div>
        <span className="op-eyebrow">POST-CODE. UNDER CONTROL.</span>
        <h1>
          A workforce for
          <br />
          the road to deployment.
        </h1>
        <p>
          Observe real pipeline failures. Repair with GitLab Duo.
          <br />
          Verify what actually reached staging.
        </p>
        {auth === "locked" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              action("login", async () => {
                await api("/api/session", { token: key });
                setKey("");
                setAuth("ready");
                await loadWorkspaces();
              });
            }}
          >
            <label>
              Operator access key
              <input
                type="password"
                autoComplete="current-password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                required
              />
            </label>
            <button className="op-button op-primary" disabled={!!busy}>
              Open workspace <ArrowRight size={16} />
            </button>
          </form>
        ) : (
          <p>
            <LoaderCircle className="op-spin" size={18} /> Connecting to MAYA…
          </p>
        )}
        {error && (
          <div role="alert" className="op-alert">
            {error}
          </div>
        )}
      </div>
    );

  return (
    <div className="op-app">
      <aside className="op-sidebar">
        <div className="op-brand">
          <div className="op-logo">M</div>
          <span>
            MAYA<span className="op-brand-sub">DELIVERY WORKFORCE</span>
          </span>
        </div>
        <div className="op-workspace-label">WORKSPACE</div>
        <select
          aria-label="Company workspace"
          className="op-company-select"
          value={workspace}
          onChange={(event) => {
            currentWorkspace.current = event.target.value;
            setWorkspace(event.target.value);
            localStorage.setItem("maya.ops.workspace", event.target.value);
            refresh(event.target.value).catch((err) => setError(err.message));
          }}
        >
          <option value="" disabled>
            Connect a company
          </option>
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
        <nav>
          {(
            [
              { id: "delivery", title: "Delivery", icon: Workflow },
              { id: "memory", title: "Company memory", icon: BookOpen },
              { id: "evidence", title: "Evidence library", icon: Layers3 },
              {
                id: "connections",
                title: "Connections & policy",
                icon: Settings2,
              },
            ] as const
          ).map(({ id, title, icon: Icon }) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => setView(id)}
            >
              <Icon size={18} />
              {title}
              {id === "delivery" && activeCount > 0 && (
                <span className="op-nav-count">{activeCount}</span>
              )}
            </button>
          ))}
        </nav>
        <button className="op-add-company" onClick={() => setOnboard(true)}>
          <Plus size={17} /> Onboard a repository
        </button>
        <div className="op-sidebar-bottom">
          <div className="op-duo-mark">
            <Sparkles size={18} />
            <div>
              GitLab Duo
              <span>
                {snapshot?.capabilities.duo
                  ? "Workforce configured"
                  : "Configuration required"}
              </span>
            </div>
            <i className={snapshot?.capabilities.duo ? "op-live-dot" : ""} />
          </div>
          <p>
            Real source. Real CI.
            <br />
            Proof before “fixed.”
          </p>
          <a href="/?lab=1">
            Open legacy simulation lab <ArrowUpRight size={12} />
          </a>
        </div>
      </aside>
      <div className="op-main">
        <header className="op-topbar">
          <div>
            <span className="op-breadcrumb">WORKSPACE</span>
            <ChevronRight size={13} />
            <strong>
              {companies.find((company) => company.id === workspace)?.name ||
                "New company"}
            </strong>
          </div>
          <div>
            <span className="op-status">
              <i className={repo?.monitoring ? "op-live-dot" : ""} />
              {repo?.monitoring ? "Observer enabled" : "Observer paused"}
            </span>
            {repo && (
              <Link href={repo.url}>
                <GitBranch size={14} />
                {repo.provider === "gitlab" ? "GitLab" : "GitHub"}
              </Link>
            )}
            <button
              className="op-icon-button"
              aria-label="Refresh workspace"
              disabled={!!busy}
              onClick={() =>
                action(
                  "refresh",
                  () => post("/observe"),
                  "Source and pipeline state refreshed.",
                )
              }
            >
              <RefreshCw
                size={16}
                className={busy === "refresh" ? "op-spin" : ""}
              />
            </button>
          </div>
        </header>
        <main className="op-content">
          {error && (
            <div role="alert" className="op-alert">
              <TriangleAlert size={17} />
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {toast && (
            <div role="status" className="op-toast">
              <CheckCircle2 size={17} />
              {toast}
            </div>
          )}
          {!repo ? (
            <div className="op-welcome">
              <span className="op-eyebrow">MEET YOUR DELIVERY WORKFORCE</span>
              <h1>
                From a failed pipeline
                <br />
                to a verified release.
              </h1>
              <p>
                Connect an existing GitLab or GitHub repository. MAYA discovers
                its stack, reads its pipeline and brings the right agents to the
                failure.
              </p>
              <button
                className="op-button op-primary"
                onClick={() => setOnboard(true)}
              >
                Connect your repository <ArrowRight size={17} />
              </button>
              <div className="op-welcome-stages">
                {[
                  "Observe failure",
                  "Investigate source",
                  "Propose repair",
                  "Verify CI",
                  "Deploy staging",
                  "Review learning",
                ].map((stage, index) => (
                  <div key={stage}>
                    <span>0{index + 1}</span>
                    {stage}
                  </div>
                ))}
              </div>
              <p className="op-muted">
                External tools require their own connections. A repository URL
                discovers configuration; it does not grant access to every
                service.
              </p>
            </div>
          ) : (
            <>
              <div className="op-page-heading">
                <div>
                  <span className="op-eyebrow">
                    {view === "delivery"
                      ? "FROM PUSH TO PROOF"
                      : "YOUR COMPANY, IN CONTEXT"}
                  </span>
                  <h1>
                    {view === "delivery"
                      ? "Delivery control"
                      : view === "memory"
                        ? "Company memory"
                        : view === "evidence"
                          ? "Evidence library"
                          : "Connections & policy"}
                    <span className="op-title-dot">.</span>
                  </h1>
                  <p>
                    {view === "delivery"
                      ? "Every failure has a trail. Every repair has to prove itself."
                      : view === "memory"
                        ? "Verified outcomes become reviewable lessons, scoped to this company."
                        : view === "evidence"
                          ? "Source snapshots, job traces, agent reports and verification receipts."
                          : "Discovered configuration, real access and the boundaries of automation."}
                  </p>
                </div>
                <div className="op-head-actions">
                  <Badge value={repo.automationMode} />
                  <button
                    className="op-button"
                    disabled={!!busy}
                    onClick={() =>
                      action(
                        "observe",
                        () => post("/observe"),
                        "Observation complete.",
                      )
                    }
                  >
                    <Radio size={15} />
                    {busy === "observe" ? "Observing…" : "Observe now"}
                  </button>
                </div>
              </div>
              {snapshot?.storage?.error && (
                <div className="op-notice">
                  <TriangleAlert size={15} />
                  <span>{snapshot.storage.error}</span>
                </div>
              )}
              {repo.observationError && (
                <div className="op-notice">
                  <TriangleAlert size={15} />
                  <span>
                    Observation needs attention: {repo.observationError}
                  </span>
                </div>
              )}
              {view === "delivery" && (
                <>
                  <div className="op-metrics">
                    <Metric
                      label="WATCHING"
                      value={repo.workflows.length.toString()}
                      note={`${repo.workflows.flatMap((flow) => flow.jobs).length} pipeline jobs discovered`}
                      icon={<Workflow size={19} />}
                    />
                    <Metric
                      label="OPEN FAILURES"
                      value={activeCount.toString().padStart(2, "0")}
                      note="Real signals awaiting verified recovery"
                      icon={<Activity size={19} />}
                    />
                    <Metric
                      label="VERIFIED RELEASES"
                      value={(
                        snapshot?.incidents.filter(
                          (item) => item.status === "resolved",
                        ).length || 0
                      )
                        .toString()
                        .padStart(2, "0")}
                      note="CI + deployment + exact live SHA"
                      icon={<ShieldCheck size={19} />}
                    />
                    <Metric
                      label="REVIEWED LESSONS"
                      value={(
                        snapshot?.lessons.filter(
                          (lesson) => lesson.status === "active",
                        ).length || 0
                      )
                        .toString()
                        .padStart(2, "0")}
                      note="Available to this company’s next repair"
                      icon={<BookOpen size={19} />}
                    />
                  </div>
                  <section className="op-panel op-journey-panel">
                    <div className="op-panel-heading">
                      <div>
                        <span className="op-kicker">DELIVERY JOURNEY</span>
                        <h2>
                          {incident
                            ? incident.plan?.title || incident.title
                            : "Your next push starts here"}
                        </h2>
                      </div>
                      {incident ? (
                        <Badge value={incident.status} />
                      ) : (
                        <Badge value="watching" />
                      )}
                    </div>
                    <DeliveryJourney
                      incident={incident}
                      reviewed={
                        !!snapshot?.lessons.some(
                          (lesson) =>
                            lesson.incidentId === incident?.id &&
                            lesson.status === "active",
                        )
                      }
                      onSelect={(role) => setInspector({ role })}
                    />
                    <div className="op-journey-footer">
                      <span>
                        <GitCommitHorizontal size={14} />
                        {short(incident?.commitSha || repo.headSha)}
                        <span className="op-muted">
                          {" "}
                          · {repo.defaultBranch}
                        </span>
                      </span>
                      <span>
                        {incident
                          ? `${incident.attempts?.length || 0} repair attempts · ${incident.evidenceIds.length} evidence files`
                          : `${repo.fullName} · ${when(repo.lastObservedAt)}`}
                      </span>
                      {incident?.sourceUrl && (
                        <Link href={incident.sourceUrl}>Original failure</Link>
                      )}
                    </div>
                  </section>
                  <div className="op-delivery-grid">
                    <section className="op-panel op-workforce">
                      <div className="op-panel-heading">
                        <div>
                          <span className="op-kicker">
                            CONNECTED INTELLIGENCE
                          </span>
                          <h2>Your workforce</h2>
                        </div>
                        <span className="op-small op-muted">
                          Click any node to inspect
                        </span>
                      </div>
                      <WorkforceMap
                        incident={incident}
                        task={task}
                        onSelect={(role) => setInspector({ role })}
                      />
                      <div className="op-map-note">
                        <i className="op-live-dot" />
                        <span>
                          Observer and policy run in MAYA. Reasoning runs in
                          GitLab Duo.
                        </span>
                      </div>
                    </section>
                    <section className="op-panel op-delivery-detail">
                      <div className="op-panel-heading">
                        <div>
                          <span className="op-kicker">CURRENT DELIVERY</span>
                          <h2>What happens next</h2>
                        </div>
                        <CircleDot size={19} />
                      </div>
                      {incident ? (
                        <>
                          <p className="op-detail-summary">
                            {incident.plan?.rootCause || incident.summary}
                          </p>
                          <div className="op-detail-facts">
                            <span>
                              Category{" "}
                              <strong>{label(incident.category)}</strong>
                            </span>
                            <span>
                              Last update{" "}
                              <strong>{when(incident.updatedAt)}</strong>
                            </span>
                            <span>
                              Source revision{" "}
                              <code>
                                {short(
                                  incident.planBaseSha || incident.commitSha,
                                )}
                              </code>
                            </span>
                            {incident.plan && (
                              <span>
                                Model confidence{" "}
                                <strong>{incident.plan.confidence}</strong>
                              </span>
                            )}
                            {task?.sessionId && (
                              <span>
                                Duo session{" "}
                                <Link href={task.url}>#{task.sessionId}</Link>
                              </span>
                            )}
                          </div>
                          <NextAction
                            incident={incident}
                            task={task}
                            busy={!!busy}
                            sharing={repo.shareWithDuo}
                            act={(name, body, message) =>
                              action(
                                name,
                                () =>
                                  post(
                                    `/incidents/${incident.id}/${name}`,
                                    body || {},
                                  ),
                                message,
                              )
                            }
                            refreshTask={() =>
                              task &&
                              action("task", () =>
                                post(`/tasks/${task.id}/refresh`),
                              )
                            }
                            reconcileLaunch={(allowNewInvestigation, reason) =>
                              task &&
                              action("reconcile-launch", () =>
                                post(`/tasks/${task.id}/reconcile-launch`, {
                                  allowNewInvestigation,
                                  reason,
                                }),
                              )
                            }
                            viewChanges={() => setInspector({ changes: true })}
                          />
                          {incident.error && (
                            <p className="op-inline-error">{incident.error}</p>
                          )}
                          {incident.publication?.url && (
                            <div className="op-remote-result">
                              <GitMerge size={17} />
                              <Link href={incident.publication.url}>
                                Repair{" "}
                                {repo.provider === "gitlab" ? "MR !" : "PR #"}
                                {incident.publication.prNumber}
                              </Link>
                              <Badge
                                value={incident.checks?.state || "pending"}
                              />
                            </div>
                          )}
                          {incident.deploymentProbe && (
                            <div className="op-probe">
                              <span>
                                <Globe size={14} /> Live revision probe
                              </span>
                              <code>
                                {short(incident.deploymentProbe.actualSha)}
                              </code>
                              <Badge
                                value={
                                  incident.deploymentProbe.passed
                                    ? "passing"
                                    : "pending"
                                }
                              />
                              <small>
                                Expected{" "}
                                {short(incident.deploymentProbe.expectedSha)} ·
                                HTTP {incident.deploymentProbe.httpStatus}
                              </small>
                            </div>
                          )}
                        </>
                      ) : (
                        <Empty
                          title="Watching for pipeline failures"
                          icon={<Radio size={28} />}
                        >
                          Push code to {repo.defaultBranch}. A real failed
                          pipeline will appear here; MAYA does not create a fake
                          failure on onboarding.
                        </Empty>
                      )}
                    </section>
                  </div>
                  <section className="op-panel">
                    <div className="op-panel-heading">
                      <div>
                        <span className="op-kicker">SOURCE TO STAGING</span>
                        <h2>
                          Delivery history{" "}
                          <span className="op-count">
                            {snapshot?.incidents.length || 0}
                          </span>
                        </h2>
                      </div>
                      <div className="op-filters">
                        {[
                          "all",
                          "ci",
                          "security",
                          "deployment",
                          "runtime",
                          "dependency",
                        ].map((category) => (
                          <button
                            className={filter === category ? "active" : ""}
                            key={category}
                            onClick={() => setFilter(category)}
                          >
                            {category === "all" ? "All" : label(category)}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="op-history">
                      {snapshot?.incidents
                        .filter(
                          (item) =>
                            filter === "all" || item.category === filter,
                        )
                        .map((item) => (
                          <button
                            key={item.id}
                            className={`op-history-row ${item.id === incident?.id ? "selected" : ""}`}
                            onClick={() => {
                              setSelected(item.id);
                              setInspector(undefined);
                            }}
                          >
                            <div
                              className={`op-failure-icon ${item.status === "resolved" ? "success" : ""}`}
                            >
                              {item.status === "resolved" ? (
                                <Check size={17} />
                              ) : (
                                <Workflow size={17} />
                              )}
                            </div>
                            <div>
                              <strong>{item.plan?.title || item.title}</strong>
                              <span>
                                {label(item.category)} <b>·</b>{" "}
                                {short(item.commitSha)} <b>·</b>{" "}
                                {when(item.createdAt)}
                              </span>
                            </div>
                            <Badge value={item.status} />
                            <ChevronRight size={16} />
                          </button>
                        ))}
                      {!snapshot?.incidents.length && (
                        <div className="op-empty-row">
                          No failed pipelines observed yet. Last checked{" "}
                          {when(repo.lastObservedAt)}.
                        </div>
                      )}
                    </div>
                  </section>
                  {incident && (
                    <section className="op-panel">
                      <div className="op-panel-heading">
                        <div>
                          <span className="op-kicker">
                            EXPLAINABLE AT EVERY STEP
                          </span>
                          <h2>Activity & evidence</h2>
                        </div>
                        <span className="op-small op-muted">
                          {incident.steps.length} recorded steps
                        </span>
                      </div>
                      <div className="op-timeline">
                        {[...incident.steps].reverse().map((step) => (
                          <div
                            className={`op-timeline-step ${step.state}`}
                            key={step.id}
                          >
                            <div className="op-timeline-dot" />
                            <div>
                              <span className="op-small op-muted">
                                {
                                  roles.find((role) => role.id === step.role)
                                    ?.name
                                }{" "}
                                · {when(step.at)}
                              </span>
                              <h3>{step.title}</h3>
                              <p>{step.detail}</p>
                              {step.evidenceIds.length > 0 && (
                                <div className="op-evidence-chips">
                                  {step.evidenceIds.slice(0, 8).map((id) => (
                                    <button
                                      key={id}
                                      onClick={() =>
                                        setInspector({ evidenceId: id })
                                      }
                                    >
                                      <FileText size={12} />
                                      {snapshot?.evidence.find(
                                        (file) => file.id === id,
                                      )?.name || "Evidence"}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}
              {view === "memory" && (
                <MemoryView
                  snapshot={snapshot!}
                  busy={!!busy}
                  review={(lesson, type, reason) =>
                    action(
                      "memory",
                      () =>
                        post(`/memory/${lesson.id}/review`, {
                          action: type,
                          reason,
                        }),
                      `Lesson ${type === "promote" ? "promoted" : "retired"}.`,
                    )
                  }
                  openEvidence={(id) => setInspector({ evidenceId: id })}
                />
              )}
              {view === "evidence" && (
                <EvidenceLibrary
                  snapshot={snapshot!}
                  open={(id) => setInspector({ evidenceId: id })}
                />
              )}
              {view === "connections" && (
                <Connections
                  snapshot={snapshot!}
                  busy={!!busy}
                  post={(path, data) =>
                    action(
                      "settings",
                      () => post(path, data),
                      "Workspace configuration updated.",
                    )
                  }
                  rescan={() =>
                    action(
                      "rescan",
                      () => post("/rescan"),
                      "Repository configuration rediscovered.",
                    )
                  }
                />
              )}
            </>
          )}
          <footer className="op-footer">
            <span>MAYA / MULTI-AGENT YARD FOR AUTOMATION</span>
            <span>
              GitLab Duo Agent Platform <i /> Staging-first automation
            </span>
          </footer>
        </main>
      </div>
      {onboard && (
        <Onboarding
          busy={!!busy}
          onClose={() => setOnboard(false)}
          onComplete={async (id) => {
            await loadWorkspaces(id);
            setView("delivery");
            setOnboard(false);
            setToast(
              "Repository connected. MAYA is watching its real pipelines.",
            );
          }}
        />
      )}
      {inspector && (
        <div className="op-overlay" onClick={() => setInspector(undefined)}>
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={
              inspector.changes
                ? "Review source repair"
                : inspector.role
                  ? `${roles.find((role) => role.id === inspector.role)?.name} inspector`
                  : "Evidence inspector"
            }
            className="op-inspector"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="op-close"
              aria-label="Close inspector"
              onClick={() => setInspector(undefined)}
            >
              <X size={20} />
            </button>
            {inspector.role && (
              <RoleInspector
                role={inspector.role}
                snapshot={snapshot!}
                incident={incident}
                openEvidence={(id) => setInspector({ evidenceId: id })}
              />
            )}
            {inspector.evidenceId &&
              (evidence ? (
                <>
                  <span className="op-eyebrow">IMMUTABLE EVIDENCE</span>
                  <h2>{evidence.name}</h2>
                  <div className="op-evidence-metadata">
                    <Badge value={evidence.kind} />
                    <span>{when(evidence.createdAt)}</span>
                    <span>
                      Revision <code>{short(evidence.commitSha)}</code>
                    </span>
                  </div>
                  <div className="op-inspector-actions">
                    <Link href={evidence.sourceUrl}>Original source</Link>
                    <a
                      className="op-link"
                      href={`${base}/evidence/${evidence.id}/download`}
                      download
                    >
                      <Download size={14} /> Download evidence
                    </a>
                  </div>
                  <pre className="op-code">{evidence.content}</pre>
                  <p className="op-hash">
                    SHA-256
                    <br />
                    {evidence.digest}
                  </p>
                </>
              ) : (
                <p>
                  <LoaderCircle size={18} className="op-spin" /> Loading
                  evidence…
                </p>
              ))}
            {inspector.changes && incident && (
              <Changes incident={incident} snapshot={snapshot!} base={base} />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  icon,
}: {
  label: string;
  value: string;
  note: string;
  icon: ReactNode;
}) {
  return (
    <div className="op-metric">
      <span className="op-kicker">
        {label}
        {icon}
      </span>
      <strong>{value}</strong>
      <p>{note}</p>
    </div>
  );
}
function DeliveryJourney({
  incident,
  reviewed,
  onSelect,
}: {
  incident?: OpsIncident;
  reviewed: boolean;
  onSelect: (role: Role) => void;
}) {
  const stages: {
    title: string;
    subtitle: string;
    icon: typeof Code2;
    role: Role;
    done: boolean;
    current: boolean;
  }[] = [
    {
      title: "Code pushed",
      subtitle: short(incident?.commitSha),
      icon: GitCommitHorizontal,
      role: "observer",
      done: !!incident,
      current: !incident,
    },
    {
      title: "Failure captured",
      subtitle: incident ? label(incident.category) : "Watching CI",
      icon: Terminal,
      role: "investigator",
      done: !!incident,
      current: incident?.status === "detected",
    },
    {
      title: "Repair proposed",
      subtitle: incident?.plan
        ? `${incident.plan.files.length} files`
        : "GitLab Duo",
      icon: Sparkles,
      role: "specialist",
      done: !!incident?.plan,
      current:
        incident?.status === "investigating" ||
        incident?.status === "awaiting_approval",
    },
    {
      title: "CI verified",
      subtitle: incident?.checks?.state || "Exact repair SHA",
      icon: ShieldCheck,
      role: "verifier",
      done: incident?.checks?.state === "passing",
      current: incident?.status === "pr_open",
    },
    {
      title: "Staging live",
      subtitle:
        incident?.status === "resolved"
          ? short(incident.merge?.sha)
          : "Revision probe",
      icon: Globe,
      role: "verifier",
      done: incident?.status === "resolved",
      current: incident?.status === "verifying",
    },
    {
      title: "Learning reviewed",
      subtitle: "Company memory",
      icon: BookOpen,
      role: "corrector",
      done: reviewed,
      current: incident?.status === "resolved" && !reviewed,
    },
  ];
  return (
    <div className="op-journey">
      {stages.map(
        ({ title, subtitle, icon: Icon, role, done, current }, index) => (
          <React.Fragment key={title}>
            {index > 0 && (
              <span className={`op-journey-line ${done ? "done" : ""}`} />
            )}
            <button
              onClick={() => onSelect(role)}
              className={`op-journey-stage ${done ? "done" : ""} ${current ? "current" : ""}`}
            >
              <span className="op-stage-icon">
                {done ? <Check size={19} /> : <Icon size={19} />}
              </span>
              <strong>{title}</strong>
              <small>{subtitle}</small>
            </button>
          </React.Fragment>
        ),
      )}
    </div>
  );
}
function WorkforceMap({
  incident,
  task,
  onSelect,
}: {
  incident?: OpsIncident;
  task?: AgentTask;
  onSelect: (role: Role) => void;
}) {
  const map = useRef<HTMLDivElement>(null);
  const [connections, setConnections] = useState({
    width: 800,
    height: 410,
    paths: [] as string[],
    loop: "",
  });
  useLayoutEffect(() => {
    if (!map.current) return;
    const element = map.current;
    const update = () => {
      const root = element.getBoundingClientRect();
      const bounds = (role: Role) => {
        const rect = element
          .querySelector<HTMLElement>(`[data-role="${role}"]`)!
          .getBoundingClientRect();
        return {
          x: rect.left - root.left,
          y: rect.top - root.top,
          width: rect.width,
          height: rect.height,
        };
      };
      const between = (from: Role, to: Role) => {
        const a = bounds(from),
          b = bounds(to);
        const x1 = a.x + a.width / 2,
          y1 = a.y + a.height + 2,
          x2 = b.x + b.width / 2,
          y2 = b.y - 3,
          middle = (y1 + y2) / 2;
        return `M${x1} ${y1} V${middle} H${x2} V${y2}`;
      };
      const master = bounds("orchestrator"),
        human = bounds("operator"),
        memory = bounds("corrector");
      setConnections({
        width: root.width,
        height: root.height,
        paths: [
          between("observer", "orchestrator"),
          ...(["investigator", "specialist", "verifier"] as Role[]).flatMap(
            (role) => [
              between("orchestrator", role),
              between(role, "corrector"),
            ],
          ),
          `M${human.x - 2} ${human.y + human.height / 2} H${master.x + master.width + 3}`,
        ],
        loop: `M${memory.x - 3} ${memory.y + memory.height / 2} H12 V${master.y + master.height / 2} H${master.x - 3}`,
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const node of element.querySelectorAll<HTMLElement>("[data-role]"))
      observer.observe(node);
    update();
    return () => observer.disconnect();
  }, []);
  const node = (id: Role) => {
    const role = roles.find((item) => item.id === id)!;
    const latest = incident?.steps.filter((step) => step.role === id).at(-1);
    const Icon = role.icon;
    const active = task?.state === "running" && id === "orchestrator";
    return (
      <button
        data-role={id}
        onClick={() => onSelect(id)}
        className={`op-agent-node op-agent-${id} ${active ? "running" : latest ? "visited" : ""}`}
      >
        <span className="op-agent-icon">
          <Icon size={20} />
        </span>
        <span>
          <strong>{role.name}</strong>
          <small>{role.hint}</small>
        </span>
        <span className="op-agent-state">
          {active ? (
            <LoaderCircle size={13} className="op-spin" />
          ) : latest ? (
            <Check size={13} />
          ) : (
            <ChevronRight size={13} />
          )}
        </span>
      </button>
    );
  };
  return (
    <div className="op-agent-map" ref={map}>
      <svg
        viewBox={`0 0 ${connections.width} ${connections.height}`}
        aria-hidden="true"
      >
        <defs>
          <marker
            id="op-arrow"
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L6,3 L0,6" />
          </marker>
        </defs>
        {connections.paths.map((path, index) => (
          <path d={path} key={index} />
        ))}
        <path className="memory-loop" d={connections.loop} />
      </svg>
      <div className="op-agent-observer-wrap">{node("observer")}</div>
      <div className="op-agent-top">
        <div />
        {node("orchestrator")}
        {node("operator")}
      </div>
      <div className="op-agent-specialists">
        {node("investigator")}
        {node("specialist")}
        {node("verifier")}
      </div>
      <div className="op-agent-memory-wrap">{node("corrector")}</div>
      <span className="op-map-label op-label-memory">REVIEWED CONTEXT</span>
      <span className="op-map-label op-label-evidence">
        CENTRAL EVIDENCE · SCOPED BY CATEGORY
      </span>
    </div>
  );
}
function NextAction({
  incident,
  task,
  busy,
  sharing,
  act,
  refreshTask,
  reconcileLaunch,
  viewChanges,
}: {
  incident: OpsIncident;
  task?: AgentTask;
  busy: boolean;
  sharing: boolean;
  act: (name: string, body?: unknown, message?: string) => void;
  refreshTask: () => void;
  reconcileLaunch: (allowNewInvestigation: boolean, reason: string) => void;
  viewChanges: () => void;
}) {
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  useEffect(() => setReason(""), [incident.id, incident.status]);
  const explain = {
    detected:
      "Duo will read the failed job traces, captured source and reviewed company lessons to propose a repair.",
    investigating:
      "The Duo workforce is reasoning over a frozen evidence snapshot. Its session and component messages are inspectable.",
    awaiting_approval:
      "Review the actual source diff. Approval creates a repair merge request; CI must pass before a separate merge decision.",
    pr_open:
      incident.checks?.state === "failing"
        ? "The repair pipeline failed. Investigate its fresh logs and refine the same repair branch."
        : "MAYA is checking the exact repair commit. A passing MR alone does not prove staging deployment.",
    verifying:
      "Merged. Waiting for default-branch CI, a successful staging deployment and the exact revision at the live endpoint.",
    resolved:
      "Staging returned the merged revision and the release pipeline passed. The corrector can now propose a reviewed lesson.",
    needs_input:
      "Inspect the saved report and questions. Add context before requesting a fresh investigation.",
    unknown:
      "A remote outcome is uncertain. Inspect the existing session or repair branch before taking another action.",
    publishing:
      "The approved repair is being written to its reserved branch. Do not repeat publication.",
    rejected: "This failure was dismissed. Its evidence remains available.",
    escalated: "This delivery requires operator input.",
  }[incident.status];
  const canInvestigate =
    ["detected", "needs_input", "escalated"].includes(incident.status) ||
    (incident.status === "pr_open" && incident.checks?.state === "failing");
  return (
    <div className="op-next-action">
      <p>{explain}</p>
      {incident.plan?.questions.map((question) => (
        <div key={question} className="op-notice">
          {question}
        </div>
      ))}
      <div className="op-action-buttons">
        {incident.plan && (
          <button className="op-button" onClick={viewChanges}>
            <FileCode2 size={15} />
            Review {incident.plan.files.length} file changes
          </button>
        )}
        {canInvestigate && (
          <button
            className="op-button op-primary"
            disabled={busy || !sharing}
            onClick={() =>
              act(
                "investigate",
                {},
                "Duo investigation requested. Its output will be retained.",
              )
            }
          >
            <Sparkles size={15} />
            {incident.status === "detected"
              ? "Investigate & propose repair"
              : "Investigate fresh evidence"}
          </button>
        )}
        {incident.status === "investigating" && (
          <button className="op-button" disabled={busy} onClick={refreshTask}>
            <RefreshCw size={15} /> Refresh Duo session
          </button>
        )}
        {incident.status === "unknown" &&
          task?.state === "unknown" &&
          !task.sessionId && (
            <button
              className="op-button"
              disabled={busy}
              onClick={() =>
                reconcileLaunch(
                  false,
                  "Look up the frozen evidence digest in GitLab before any new launch.",
                )
              }
            >
              <RefreshCw size={15} /> Find existing Duo session
            </button>
          )}
        {incident.publication?.prNumber && (
          <button
            className="op-button"
            disabled={busy}
            onClick={() => act("checks")}
          >
            <RefreshCw size={15} /> Check CI & staging
          </button>
        )}
        {incident.publication?.state === "unknown" && (
          <button
            className="op-button"
            disabled={busy}
            onClick={() => act("reconcile")}
          >
            Reconcile existing repair
          </button>
        )}
        {incident.status === "resolved" && (
          <button
            className="op-button op-primary"
            disabled={busy}
            onClick={() =>
              act(
                "reflect",
                {},
                "Corrector requested. Any lesson needs independent review.",
              )
            }
          >
            <BookOpen size={15} /> Propose learning
          </button>
        )}
      </div>
      {incident.status === "unknown" &&
        task?.state === "unknown" &&
        !task.sessionId && (
          <div className="op-approval">
            <p>
              A session search is repeated before releasing this launch. An
              empty search alone does not prove the original request was
              rejected. Inspect GitLab and explain the evidence for allowing
              another investigation. This action retains the old attempt and
              does not launch a new session.
            </p>
            <label>
              Launch recovery decision
              <textarea
                value={reason}
                placeholder="Explain what you checked in GitLab…"
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <button
              className="op-button"
              disabled={busy || reason.trim().length < 3}
              onClick={() => reconcileLaunch(true, reason)}
            >
              Record decision & allow fresh investigation
            </button>
          </div>
        )}
      {(incident.status === "awaiting_approval" ||
        (incident.status === "pr_open" &&
          incident.checks?.state === "passing" &&
          !incident.merge)) && (
        <div className="op-approval">
          <label>
            {incident.status === "awaiting_approval"
              ? "Publication review"
              : "Staging merge review"}
            <textarea
              placeholder="Explain why you approve this exact change…"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            className="op-button op-primary"
            disabled={busy || reason.trim().length < 3}
            onClick={() =>
              act(
                incident.status === "awaiting_approval" ? "publish" : "merge",
                { digest: incident.planDigest, reason },
                incident.status === "awaiting_approval"
                  ? "Publication requested for the reviewed artifact."
                  : "Staging merge requested after exact-commit CI.",
              )
            }
          >
            {incident.status === "awaiting_approval"
              ? "Approve & create repair MR"
              : "Approve merge to staging"}
            <ArrowRight size={15} />
          </button>
          <small>
            Bound to artifact {short(incident.planDigest)}.{" "}
            {incident.status === "awaiting_approval"
              ? "Merging is a separate action."
              : "The configured staging pipeline deploys after merge."}
          </small>
        </div>
      )}
      {!["rejected", "publishing"].includes(incident.status) && (
        <details className="op-operator-feedback">
          <summary>Add context or feedback</summary>
          <label>
            Context for the workforce
            <textarea
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="Clarify a requirement or explain why the proposed repair needs changing…"
            />
          </label>
          <div className="op-action-buttons">
            <button
              className="op-button"
              disabled={busy || feedback.trim().length < 3}
              onClick={() => {
                act(
                  "feedback",
                  { text: feedback },
                  "Feedback captured as evidence for the next investigation.",
                );
                setFeedback("");
              }}
            >
              Save context
            </button>
            {[
              "detected",
              "awaiting_approval",
              "needs_input",
              "escalated",
            ].includes(incident.status) && (
              <button
                className="op-button"
                disabled={busy || feedback.trim().length < 3}
                onClick={() =>
                  act(
                    "reject",
                    { reason: feedback },
                    "Failure dismissed with its evidence retained.",
                  )
                }
              >
                Dismiss with reason
              </button>
            )}
          </div>
        </details>
      )}
      {!sharing && canInvestigate && (
        <p className="op-small op-muted">
          Enable evidence sharing in Connections & policy to use GitLab Duo.
        </p>
      )}
      {task?.error && <p className="op-inline-error">{task.error}</p>}
    </div>
  );
}
function RoleInspector({
  role,
  snapshot,
  incident,
  openEvidence,
}: {
  role: Role;
  snapshot: OpsSnapshot;
  incident?: OpsIncident;
  openEvidence: (id: string) => void;
}) {
  const config = roles.find((item) => item.id === role)!;
  const Icon = config.icon;
  const steps = incident?.steps.filter((step) => step.role === role) || [];
  const task =
    role === "corrector"
      ? snapshot.tasks.find(
          (item) =>
            item.incidentId === incident?.id && item.purpose === "reflect",
        ) || snapshot.tasks.find((item) => item.id === incident?.taskId)
      : snapshot.tasks.find((item) => item.id === incident?.taskId);
  const messages =
    task?.messages.filter((message) =>
      message.role.includes(role === "specialist" ? "specialist" : role),
    ) || [];
  return (
    <>
      <span className="op-eyebrow">WORKFORCE INSPECTOR</span>
      <h2>
        <Icon size={24} /> {config.name}
      </h2>
      <p className="op-inspector-intro">
        {config.hint}.{" "}
        {role === "observer"
          ? "Signals come from real provider APIs and signed webhooks."
          : role === "operator"
            ? "Approvals belong to people or an explicitly enabled staging policy. Agent output never grants itself authority."
            : role === "corrector"
              ? "Lessons are candidate records until reviewed. This is scoped retrieval memory, not model retraining."
              : "Duo reasoning and MAYA’s recorded controller actions are shown separately below."}
      </p>
      {task && (
        <div className="op-session-card">
          <span>GitLab Duo session #{task.sessionId || "unconfirmed"}</span>
          <Badge value={task.state} />
          <Link href={task.url}>Open execution</Link>
          <small>
            Evidence digest <code>{short(task.evidenceDigest)}</code>
          </small>
        </div>
      )}
      <h3>Recorded actions</h3>
      {steps.length ? (
        steps.map((step) => (
          <div className="op-inspector-record" key={step.id}>
            <Badge value={step.state} />
            <h4>{step.title}</h4>
            <p>{step.detail}</p>
            <small>{when(step.at)}</small>
            <div className="op-evidence-chips">
              {step.evidenceIds.map((id) => (
                <button key={id} onClick={() => openEvidence(id)}>
                  <FileText size={12} />
                  {snapshot.evidence.find((item) => item.id === id)?.name ||
                    "Evidence"}
                </button>
              ))}
            </div>
          </div>
        ))
      ) : (
        <p className="op-muted">
          No action by this role for the selected delivery yet.
        </p>
      )}
      <h3>Duo component messages</h3>
      {messages.length ? (
        messages.map((message, index) => (
          <details className="op-message" key={index}>
            <summary>
              {message.role} · {message.type}
            </summary>
            <pre className="op-code">{message.content}</pre>
          </details>
        ))
      ) : (
        <p className="op-muted">
          No separate component message was returned for this role. Open the
          session for the execution trace.
        </p>
      )}
      {role === "orchestrator" && task?.report && (
        <details className="op-message">
          <summary>Final workforce report</summary>
          <pre className="op-code">{task.report}</pre>
        </details>
      )}
      {role === "corrector" && (
        <div className="op-memory-categories">
          {["ci", "security", "deployment", "runtime", "dependency"].map(
            (category) => (
              <span key={category}>
                {label(category)}
                <strong>
                  {
                    snapshot.lessons.filter(
                      (item) =>
                        item.category === category && item.status === "active",
                    ).length
                  }
                </strong>
              </span>
            ),
          )}
        </div>
      )}
    </>
  );
}
function Changes({
  incident,
  snapshot,
  base,
}: {
  incident: OpsIncident;
  snapshot: OpsSnapshot;
  base: string;
}) {
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    Promise.all(
      (incident.plan?.files || []).map(async (file) => {
        const evidence = snapshot.evidence.find(
          (item) =>
            item.incidentId === incident.id &&
            item.kind === "source" &&
            item.name === file.path &&
            item.commitSha === (incident.planBaseSha || incident.commitSha),
        );
        if (!evidence)
          throw new Error(`Original source evidence missing for ${file.path}.`);
        const raw = await api<EvidenceFile>(`${base}/evidence/${evidence.id}`);
        const source = JSON.parse(raw.content);
        if (source.sha !== file.originalSha)
          throw new Error(
            "Original source identity does not match the proposal.",
          );
        return [file.path, source.content] as const;
      }),
    )
      .then((rows) => {
        if (alive) setOriginals(Object.fromEntries(rows));
      })
      .catch((err) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [incident.planDigest]);
  return (
    <>
      <span className="op-eyebrow">REVIEW THE ACTUAL CHANGE</span>
      <h2>{incident.plan?.title}</h2>
      <p className="op-inspector-intro">{incident.plan?.rootCause}</p>
      <div className="op-evidence-metadata">
        <Badge value={incident.plan?.confidence || "unknown"} />
        <span>
          Base <code>{short(incident.planBaseSha || incident.commitSha)}</code>
        </span>
        <span>{incident.plan?.files.length} changed files</span>
      </div>
      {error && <div className="op-alert">{error}</div>}
      {incident.plan?.files.map((file) => (
        <section className="op-diff-file" key={file.path}>
          <h3>
            <FileCode2 size={17} />
            {file.path}
          </h3>
          <p>{file.rationale}</p>
          <small>Original blob {file.originalSha}</small>
          {originals[file.path] !== undefined ? (
            <pre className="op-diff">
              {diffLines(originals[file.path], file.content).map(
                (part, index) => (
                  <span
                    className={
                      part.added ? "added" : part.removed ? "removed" : ""
                    }
                    key={index}
                  >
                    {part.value.split("\n").map((line, lineIndex, lines) =>
                      lineIndex === lines.length - 1 && line === "" ? null : (
                        <span className="op-diff-line" key={lineIndex}>
                          <b>{part.added ? "+" : part.removed ? "−" : " "}</b>
                          {line || " "}
                          {"\n"}
                        </span>
                      ),
                    )}
                  </span>
                ),
              )}
            </pre>
          ) : (
            !error && <p>Loading captured source…</p>
          )}
        </section>
      ))}
      <h3>Verification the agent requests</h3>
      <ul className="op-text-list">
        {incident.plan?.verification.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h3>Risks & uncertainty</h3>
      <ul className="op-text-list">
        {incident.plan?.risks.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="op-hash">
        Approved artifact identity
        <br />
        {incident.planDigest}
      </p>
    </>
  );
}
function MemoryView({
  snapshot,
  busy,
  review,
  openEvidence,
}: {
  snapshot: OpsSnapshot;
  busy: boolean;
  review: (
    lesson: OperationalLesson,
    action: "promote" | "retire",
    reason: string,
  ) => void;
  openEvidence: (id: string) => void;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  return (
    <>
      <div className="op-notice">
        <BookOpen size={17} />
        <span>
          The corrector proposes learning from a verified repair. Reviewed
          lessons guide later investigations; fresh source and CI evidence still
          decide the repair.
        </span>
      </div>
      <div className="op-memory-categories">
        {["ci", "security", "deployment", "runtime", "dependency"].map(
          (category) => (
            <span key={category}>
              {label(category)}
              <strong>
                {
                  snapshot.lessons.filter(
                    (item) =>
                      item.category === category && item.status === "active",
                  ).length
                }
              </strong>
            </span>
          ),
        )}
      </div>
      {snapshot.lessons.length ? (
        <div className="op-lesson-grid">
          {snapshot.lessons.map((lesson) => (
            <section className="op-panel op-lesson" key={lesson.id}>
              <div className="op-panel-heading">
                <span className="op-kicker">
                  {label(lesson.category)} · VERSION {lesson.version}
                </span>
                <Badge value={lesson.status} />
              </div>
              <h2>{lesson.title}</h2>
              <h4>When this applies</h4>
              <p>{lesson.symptoms}</p>
              <h4>What the evidence established</h4>
              <p>{lesson.rootCause}</p>
              <h4>Guidance for the next repair</h4>
              <p>{lesson.guidance}</p>
              <div className="op-small op-muted">
                Company scope: {snapshot.repository?.name} · Verified revision{" "}
                {short(lesson.sourceSha)}
                <br />
                Expires {when(lesson.expiresAt)}
              </div>
              <div className="op-evidence-chips">
                {lesson.evidenceIds.slice(0, 5).map((id) => (
                  <button key={id} onClick={() => openEvidence(id)}>
                    <FileText size={12} />
                    {snapshot.evidence.find((item) => item.id === id)?.name ||
                      "Evidence"}
                  </button>
                ))}
              </div>
              {lesson.status !== "retired" && (
                <div className="op-approval">
                  <label>
                    Independent review
                    <textarea
                      placeholder="Explain the evidence supporting your decision…"
                      value={reasons[lesson.id] || ""}
                      onChange={(event) =>
                        setReasons({
                          ...reasons,
                          [lesson.id]: event.target.value,
                        })
                      }
                    />
                  </label>
                  <div className="op-action-buttons">
                    {lesson.status === "candidate" && (
                      <button
                        className="op-button op-primary"
                        disabled={
                          busy || (reasons[lesson.id] || "").trim().length < 3
                        }
                        onClick={() =>
                          review(lesson, "promote", reasons[lesson.id])
                        }
                      >
                        Promote reviewed lesson
                      </button>
                    )}
                    <button
                      className="op-button"
                      disabled={
                        busy || (reasons[lesson.id] || "").trim().length < 3
                      }
                      onClick={() =>
                        review(lesson, "retire", reasons[lesson.id])
                      }
                    >
                      Retire lesson
                    </button>
                  </div>
                </div>
              )}
              {lesson.reviews.map((item, index) => (
                <p key={index} className="op-small op-muted">
                  {item.action} · {when(item.at)} · {item.reason}
                </p>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <section className="op-panel">
          <Empty title="Learning starts with a verified repair">
            Once a repair reaches staging and its revision is confirmed, use
            “Propose learning” on that delivery. The corrector will produce a
            candidate for your review.
          </Empty>
        </section>
      )}
    </>
  );
}
function EvidenceLibrary({
  snapshot,
  open,
}: {
  snapshot: OpsSnapshot;
  open: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  return (
    <section className="op-panel">
      <div className="op-panel-heading">
        <label className="op-search">
          <Search size={16} />
          <input
            aria-label="Search evidence"
            placeholder="Search source, logs, checks…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <select
          aria-label="Evidence type"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="all">All evidence</option>
          {[
            "source",
            "log",
            "signal",
            "checks",
            "report",
            "approval",
            "lesson",
          ].map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
      </div>
      <div className="op-evidence-table">
        <div className="op-table-header">
          <span>FILE / PROVENANCE</span>
          <span>TYPE</span>
          <span>REVISION</span>
          <span>CAPTURED</span>
        </div>
        {snapshot.evidence
          .filter(
            (item) =>
              (kind === "all" || item.kind === kind) &&
              item.name.toLowerCase().includes(search.toLowerCase()),
          )
          .map((item) => (
            <button key={item.id} onClick={() => open(item.id)}>
              <span>
                <FileText size={16} />
                <span>
                  <strong>{item.name}</strong>
                  <small>SHA-256 {item.digest.slice(0, 16)}…</small>
                </span>
              </span>
              <Badge value={item.kind} />
              <code>{short(item.commitSha)}</code>
              <span>
                {when(item.createdAt)}
                <ChevronRight size={14} />
              </span>
            </button>
          ))}
      </div>
      {!snapshot.evidence.length && (
        <Empty title="No captured evidence yet">
          Repository onboarding and pipeline observation populate this library.
        </Empty>
      )}
    </section>
  );
}
function Connections({
  snapshot,
  busy,
  post,
  rescan,
}: {
  snapshot: OpsSnapshot;
  busy: boolean;
  post: (path: string, data: unknown) => void;
  rescan: () => void;
}) {
  const repo = snapshot.repository!;
  const [healthUrl, setHealthUrl] = useState(repo.healthUrl || "");
  const [token, setToken] = useState("");
  const [supervisedConsent, setSupervisedConsent] = useState(false);
  useEffect(() => setHealthUrl(repo.healthUrl || ""), [repo.healthUrl]);
  return (
    <div className="op-connections-grid">
      <section className="op-panel op-setting-panel">
        <div className="op-panel-heading">
          <div>
            <span className="op-kicker">REPOSITORY DISCOVERY</span>
            <h2>{repo.name}</h2>
          </div>
          <Link href={repo.url}>Open source</Link>
        </div>
        <p>{repo.description || repo.fullName}</p>
        <div className="op-tags">
          {repo.stack.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        <dl className="op-definition">
          <dt>Default branch</dt>
          <dd>
            {repo.defaultBranch} <code>{short(repo.headSha)}</code>
          </dd>
          <dt>Inventory</dt>
          <dd>
            {repo.files.length} files · {repo.workflows.length} workflows
          </dd>
          <dt>Source access</dt>
          <dd>
            {snapshot.capabilities.githubRead ? "Readable" : "Unavailable"}
          </dd>
          <dt>Write credential</dt>
          <dd>
            {snapshot.capabilities.githubWrite
              ? "Available; provider permissions checked at action time"
              : "Connect a scoped token to publish repairs"}
          </dd>
          <dt>Data durability</dt>
          <dd>
            {snapshot.capabilities.durableStorage
              ? snapshot.storage?.mode === "encrypted-checkpoint"
                ? `Encrypted checkpoint · ${when(snapshot.storage.lastSavedAt)}`
                : "Local persistent disk"
              : "Ephemeral host disk — export evidence before redeploying"}
          </dd>
        </dl>
        <button className="op-button" disabled={busy} onClick={rescan}>
          <RefreshCw size={15} /> Rediscover configuration
        </button>
        <div className="op-setting-section">
          <h3>Pipeline jobs</h3>
          {repo.workflows.map((flow) => (
            <div key={flow.path}>
              <code>{flow.path}</code>
              <div className="op-tags">
                {flow.jobs.map((job) => (
                  <span key={job}>{job}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="op-setting-section">
          <h3>Environment variable names</h3>
          <p className="op-small op-muted">
            Discovered names only. MAYA does not import production environment
            values from your repository.
          </p>
          <div className="op-tags">
            {repo.envNames.length ? (
              repo.envNames.map((name) => <code key={name}>{name}</code>)
            ) : (
              <span>No variable names found in scanned configuration.</span>
            )}
          </div>
        </div>
        <div className="op-setting-section">
          <h3>Update repository credential</h3>
          <label>
            Scoped {repo.provider} token
            <input
              type="password"
              value={token}
              autoComplete="off"
              placeholder="Stored encrypted on the server"
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button
            className="op-button"
            disabled={busy || token.length < 10}
            onClick={() => {
              post("/settings", { token });
              setToken("");
            }}
          >
            Validate & save credential
          </button>
        </div>
      </section>
      <div>
        <section className="op-panel op-setting-panel">
          <span className="op-kicker">AUTOMATION POLICY</span>
          <h2>You choose the boundary.</h2>
          <label className="op-check">
            <input
              type="checkbox"
              checked={repo.monitoring}
              disabled={busy}
              onChange={(event) =>
                post("/settings", { monitoring: event.target.checked })
              }
            />
            <span>
              <strong>Observe pipelines continuously</strong>
              <small>
                Read source-provider status about once a minute and accept
                authenticated webhook signals.
              </small>
            </span>
          </label>
          <label className="op-check">
            <input
              type="checkbox"
              checked={repo.shareWithDuo}
              disabled={busy}
              onChange={(event) =>
                post("/settings", {
                  shareWithDuo: event.target.checked,
                  ...(!event.target.checked
                    ? { autoInvestigate: false, automationMode: "assisted" }
                    : {}),
                })
              }
            />
            <span>
              <strong>Share repository evidence with GitLab Duo</strong>
              <small>
                Captured source, redacted logs and scoped lessons are sent to
                the configured GitLab project for reasoning.
              </small>
            </span>
          </label>
          <label className="op-check">
            <input
              type="checkbox"
              checked={repo.autoInvestigate}
              disabled={busy || !repo.shareWithDuo}
              onChange={(event) =>
                post("/settings", { autoInvestigate: event.target.checked })
              }
            />
            <span>
              <strong>Investigate new failures automatically</strong>
              <small>
                Creates a Duo proposal when the observer sees a failed
                default-branch pipeline.
              </small>
            </span>
          </label>
          <div className="op-mode">
            <Badge value={repo.automationMode} />
            <p>
              {repo.automationMode === "assisted"
                ? "You review publication and merging separately. CI and staging verification are always required."
                : "High-confidence source repairs can be published, checked, refined and merged into the explicitly declared staging branch. Protected files and uncertainty return to you."}
            </p>
            {repo.stagingPolicy ? (
              <div className="op-policy">
                <code>{repo.stagingPolicy.sourcePath}</code>
                <span>
                  {repo.stagingPolicy.branch} → {repo.stagingPolicy.environment}
                </span>
                <small>
                  Up to {repo.stagingPolicy.maxAttempts} repair attempts.
                  Production requires approval.
                </small>
              </div>
            ) : (
              <p className="op-small op-muted">
                Supervised staging needs a .maya.yml declaring the default
                branch as staging and production_requires_approval: true.
              </p>
            )}
            {repo.automationMode === "assisted" ? (
              <>
                <label className="op-check">
                  <input
                    type="checkbox"
                    checked={supervisedConsent}
                    onChange={(event) =>
                      setSupervisedConsent(event.target.checked)
                    }
                  />
                  <span>
                    <strong>Authorise supervised staging</strong>
                    <small>
                      I authorise high-confidence source repair MRs and merges
                      after passing CI under the discovered staging policy.
                      Tests, CI config and scripts need human review.
                    </small>
                  </span>
                </label>
                <button
                  className="op-button op-primary"
                  disabled={
                    busy ||
                    !supervisedConsent ||
                    !repo.stagingPolicy ||
                    !repo.shareWithDuo ||
                    !snapshot.capabilities.githubWrite
                  }
                  onClick={() =>
                    post("/settings", {
                      automationMode: "supervised",
                      autoInvestigate: true,
                    })
                  }
                >
                  Enable supervised staging
                </button>
              </>
            ) : (
              <button
                className="op-button"
                disabled={busy}
                onClick={() =>
                  post("/settings", { automationMode: "assisted" })
                }
              >
                Return to assisted mode
              </button>
            )}
          </div>
          <div className="op-setting-section">
            <h3>Deployed revision endpoint</h3>
            <p className="op-small op-muted">
              Return JSON with commit, buildCommit or sha equal to the deployed
              Git SHA. HTTP 200 alone is not release verification.
            </p>
            <label>
              Public HTTPS URL
              <input
                type="url"
                value={healthUrl}
                onChange={(event) => setHealthUrl(event.target.value)}
                placeholder="https://staging.example.com/version.json"
              />
            </label>
            <button
              className="op-button"
              disabled={busy}
              onClick={() => post("/settings", { healthUrl })}
            >
              Save verification endpoint
            </button>
          </div>
        </section>
        <section className="op-panel op-setting-panel">
          <span className="op-kicker">DISCOVERED TOOLS</span>
          <h2>Configuration ≠ access.</h2>
          {repo.tools.map((tool) => (
            <div className="op-tool" key={tool.id}>
              <div>
                <strong>{tool.name}</strong>
                <Badge value={tool.state} />
              </div>
              <p>{tool.detail}</p>
              <small>{tool.paths.join(" · ")}</small>
            </div>
          ))}
          <p className="op-small op-muted">
            External providers need separate credentials or signed event
            ingress. Repository discovery does not automatically connect
            Datadog, Buildkite or other company tools.
          </p>
          <a
            className="op-button"
            href={`/api/ops/${snapshot.companyId}/export`}
            download
          >
            <Download size={15} /> Export workspace evidence
          </a>
        </section>
      </div>
    </div>
  );
}
function Onboarding({
  onClose,
  onComplete,
}: {
  busy: boolean;
  onClose: () => void;
  onComplete: (id: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [repository, setRepository] = useState<Repository>();
  const [sharing, setSharing] = useState(false);
  const [automatic, setAutomatic] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  async function scan(event: React.FormEvent) {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      const result = await api<{ repository: Repository }>("/api/ops/onboard", {
        url,
        ...(name ? { name } : {}),
        ...(token ? { token } : {}),
        shareWithDuo: false,
        autoInvestigate: false,
      });
      setRepository(result.repository);
      setToken("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function finish() {
    if (!repository) return;
    setWorking(true);
    setError("");
    try {
      await api(`/api/ops/${repository.companyId}/settings`, {
        shareWithDuo: sharing,
        autoInvestigate: automatic && sharing,
      });
      await onComplete(repository.companyId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="op-overlay op-modal-overlay" onClick={onClose}>
      <section
        className="op-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboard-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="op-close"
          aria-label="Close onboarding"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <span className="op-eyebrow">BRING YOUR OWN COMPANY</span>
        <h2 id="onboard-title">
          {repository
            ? "Here’s what MAYA found."
            : "One repository. A real starting point."}
        </h2>
        <div className="op-onboarding-steps">
          <span className="done">01 · Connect source</span>
          <ArrowRight size={13} />
          <span className={repository ? "done" : ""}>02 · Discover</span>
          <ArrowRight size={13} />
          <span>03 · Choose automation</span>
        </div>
        {error && (
          <div role="alert" className="op-alert">
            {error}
          </div>
        )}
        {!repository ? (
          <form onSubmit={scan}>
            <p>
              MAYA reads your repository configuration to discover the stack,
              pipeline jobs and deployment policy. It does not run your code on
              its host.
            </p>
            <label>
              Repository URL
              <input
                type="url"
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://gitlab.com/your-team/your-project"
              />
            </label>
            <label>
              Company name <span className="op-muted">(optional)</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your company"
                maxLength={60}
              />
            </label>
            <details className="op-credential-details">
              <summary>Private repository or write access</summary>
              <p className="op-small op-muted">
                Public source can be read without a token. Publishing repairs
                requires scoped repository write access. Credentials stay
                encrypted on MAYA’s backend.
              </p>
              <label>
                Repository token
                <input
                  type="password"
                  value={token}
                  autoComplete="off"
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="GitLab api token or GitHub scoped token"
                />
              </label>
            </details>
            <button className="op-button op-primary" disabled={working}>
              {working ? (
                <LoaderCircle className="op-spin" size={16} />
              ) : (
                <Search size={16} />
              )}{" "}
              {working ? "Reading real configuration…" : "Discover repository"}
            </button>
          </form>
        ) : (
          <>
            <div className="op-discovery-result">
              <div>
                <GitBranch size={22} />
                <strong>{repository.name}</strong>
                <Badge value="connected" />
              </div>
              <Link href={repository.url}>{repository.fullName}</Link>
              <div className="op-tags">
                {repository.stack.map((stack) => (
                  <span key={stack}>{stack}</span>
                ))}
              </div>
              <div className="op-discovery-counts">
                <span>
                  <strong>{repository.files.length}</strong> files
                </span>
                <span>
                  <strong>{repository.workflows.length}</strong> workflows
                </span>
                <span>
                  <strong>
                    {repository.workflows.flatMap((flow) => flow.jobs).length}
                  </strong>{" "}
                  jobs
                </span>
              </div>
              {repository.workflows.map((flow) => (
                <p key={flow.path}>
                  <code>{flow.path}</code>
                  <br />
                  {flow.jobs.join(" → ")}
                </p>
              ))}
              {repository.tools.map((tool) => (
                <div className="op-discovered-row" key={tool.id}>
                  <span>{tool.name}</span>
                  <Badge value={tool.state} />
                </div>
              ))}
              {repository.stagingPolicy && (
                <p className="op-small">
                  Staging policy discovered: {repository.stagingPolicy.branch} →{" "}
                  {repository.stagingPolicy.environment}. Supervised writes
                  require separate authorisation in Connections & policy.
                </p>
              )}
            </div>
            <label className="op-check">
              <input
                type="checkbox"
                checked={sharing}
                onChange={(event) => {
                  setSharing(event.target.checked);
                  if (!event.target.checked) setAutomatic(false);
                }}
              />
              <span>
                <strong>Allow GitLab Duo to analyse repository evidence</strong>
                <small>
                  Send captured source, redacted failed-job logs and reviewed
                  lessons to the configured Duo workforce.
                </small>
              </span>
            </label>
            <label className="op-check">
              <input
                type="checkbox"
                checked={automatic}
                disabled={!sharing}
                onChange={(event) => setAutomatic(event.target.checked)}
              />
              <span>
                <strong>Automatically investigate new pipeline failures</strong>
                <small>
                  Start in assisted mode: you review repair MRs and staging
                  merges before writes.
                </small>
              </span>
            </label>
            <button
              className="op-button op-primary"
              disabled={working}
              onClick={finish}
            >
              {working ? "Saving…" : "Open delivery workspace"}
              <ArrowRight size={16} />
            </button>
            <p className="op-small op-muted">
              Repository connected in read mode. External services still need
              their own access.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
