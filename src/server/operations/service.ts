import { randomBytes, randomUUID } from "node:crypto";
import type {
  AgentTask,
  Category,
  EvidenceFile,
  IntegrationConfig,
  OperationalLesson,
  OpsIncident,
  OpsSnapshot,
  Provider,
  RepairPlan,
  Repository,
  SourceFile,
  StorageStatus,
} from "../../shared/operations.js";
import { DomainError } from "../engine.js";
import type { Company } from "../../shared/types.js";
import { discover, prioritizeSource } from "./discovery.js";
import { GitHub, githubTransport, type GitHubTransport } from "./github.js";
import {
  GitLab,
  gitlabRest,
  parseGitLabUrl,
  type GitLabRest,
} from "./gitlab.js";
import { OpsStorage, redact, sha256, timestamp } from "./storage.js";
import { Workforce, extractJson } from "./workforce.js";
import { pollIntegration, type Signal } from "./integrations.js";
import { publicHttpsUrl, publicRequest } from "./network.js";
import { z } from "zod";

export interface OperationsOptions {
  githubToken?: string;
  githubCli?: boolean;
  gitlabToken?: string;
  gitlabCli?: boolean;
  gitlabApi?: GitLabRest;
  workforce?: Workforce;
  observerIntervalMs?: number;
  durableStorage?: boolean;
  storageStatus?: () => StorageStatus;
  probe?: typeof publicRequest;
  transport?: (companyId: string, projectId: string) => GitHubTransport;
}
export class Operations {
  private timer?: ReturnType<typeof setInterval>;
  private readonly busy = new Set<string>();
  private readonly investigating = new Set<string>();
  private readonly merging = new Set<string>();
  private readonly reflecting = new Set<string>();
  private readonly refreshingTasks = new Set<string>();
  private ticking = false;
  constructor(
    readonly db: OpsStorage,
    readonly options: OperationsOptions = {},
  ) {}
  company(id: string) {
    const c = this.db.store.company(id);
    if (!c) throw new DomainError(404, "Workspace not found.");
    return c;
  }
  repository(companyId: string): Repository {
    this.company(companyId);
    const repo = this.db.list<Repository>("repository", companyId)[0];
    if (!repo)
      throw new DomainError(
        404,
        "Connect a repository to this workspace first.",
      );
    return repo;
  }
  github(repo: Repository): GitHub {
    if (repo.provider === "gitlab")
      return new GitLab(
        this.options.gitlabApi ||
          gitlabRest(
            this.db.credential(repo.companyId, `${repo.id}:gitlab`)?.token ||
              this.options.gitlabToken,
            this.options.gitlabCli,
          ),
      );
    return new GitHub(
      this.options.transport?.(repo.companyId, repo.id) ||
        githubTransport(
          this.db.credential(repo.companyId, `${repo.id}:github`)?.token ||
            this.options.githubToken,
          this.options.githubCli,
        ),
    );
  }
  hasWriteCredential(repo: Repository) {
    return repo.provider === "gitlab"
      ? !!(
          this.options.gitlabApi ||
          this.options.gitlabCli ||
          this.options.gitlabToken ||
          this.db.credential(repo.companyId, `${repo.id}:gitlab`)?.token
        )
      : !!(
          this.options.transport ||
          this.options.githubCli ||
          this.options.githubToken ||
          this.db.credential(repo.companyId, `${repo.id}:github`)?.token
        );
  }
  async onboard(input: {
    url: string;
    companyId?: string;
    name?: string;
    token?: string;
    shareWithDuo?: boolean;
    autoInvestigate?: boolean;
  }) {
    const id = input.companyId || randomUUID();
    if (input.companyId) {
      this.company(id);
      if (this.db.list<Repository>("repository", id).length)
        throw new DomainError(409, "This workspace already has a repository.");
    }
    const isGitLab = input.url.startsWith("https://gitlab.com/");
    if (isGitLab) parseGitLabUrl(input.url);
    const github = isGitLab
      ? new GitLab(
          this.options.gitlabApi ||
            gitlabRest(
              input.token || this.options.gitlabToken,
              this.options.gitlabCli,
            ),
        )
      : new GitHub(
          this.options.transport?.(id, "onboarding") ||
            githubTransport(
              input.token || this.options.githubToken,
              this.options.githubCli,
            ),
        );
    const repo = await discover(github, input.url, id);
    if (github instanceof GitLab) {
      const pages = await github.pagesUrl(repo.fullName).catch(() => undefined);
      if (pages) repo.healthUrl = `${pages.replace(/\/$/, "")}/version.json`;
    }
    if (
      this.db.store
        .companies()
        .some((c) =>
          this.db
            .list<Repository>("repository", c.id)
            .some(
              (r) => r.fullName.toLowerCase() === repo.fullName.toLowerCase(),
            ),
        )
    )
      throw new DomainError(
        409,
        "This repository is already connected. Select its existing workspace.",
      );
    repo.shareWithDuo = !!input.shareWithDuo;
    repo.autoInvestigate = !!input.autoInvestigate && repo.shareWithDuo;
    this.db.store.transaction(() => {
      const company: Company = input.companyId
        ? {
            ...this.company(id),
            name: input.name?.trim() || this.company(id).name,
            stack: repo.stack.join(" · ").slice(0, 80) || "Repository",
          }
        : {
            id,
            name: input.name?.trim() || repo.name,
            stack: repo.stack.join(" · ").slice(0, 80) || "Repository",
            runtime: repo.stack.includes("Python")
              ? "Python"
              : repo.stack.includes("TypeScript") ||
                  repo.stack.includes("JavaScript")
                ? "Node.js"
                : "Discovered",
            connector: "simulation",
            revision: 1,
            createdAt: timestamp(),
          };
      this.db.store.saveCompany(company);
      this.db.save("repository", repo);
      if (input.token)
        this.db.setCredential(id, `${repo.id}:${repo.provider}`, {
          token: input.token,
        });
      for (const f of repo.sourceFiles)
        this.db.evidence({
          companyId: id,
          projectId: repo.id,
          kind: "source",
          name: f.path,
          content: JSON.stringify(f, null, 2),
          commitSha: repo.headSha,
          sourceUrl: this.sourceUrl(repo, repo.headSha, f.path),
        });
      this.db.store.audit(
        id,
        "repository.connected",
        `Connected ${repo.fullName}; discovered ${repo.files.length} files and ${repo.workflows.length} workflows.`,
        {
          projectId: repo.id,
          headSha: repo.headSha,
          sourceFiles: repo.sourceFiles.length,
          consent: repo.shareWithDuo,
        },
      );
    });
    return { company: this.company(id), repository: repo };
  }
  snapshot(companyId: string): OpsSnapshot {
    this.company(companyId);
    const repository = this.db.list<Repository>("repository", companyId)[0];
    return {
      companyId,
      repository,
      storage: this.options.storageStatus?.(),
      incidents: this.db.list("incident", companyId),
      tasks: this.db.list("task", companyId),
      lessons: this.db.list("memory", companyId),
      integrations: this.db.list("integration", companyId),
      evidence: this.db
        .list<EvidenceFile>("evidence", companyId)
        .map(({ content: _content, ...meta }) => meta),
      audit: this.db.store.audits(companyId),
      capabilities: {
        githubRead: !!repository,
        githubWrite: !!repository && this.hasWriteCredential(repository),
        duo: !!this.options.workforce,
        continuousObserver: !!this.timer,
        durableStorage:
          !!this.options.durableStorage ||
          !!(
            this.options.storageStatus?.().lastSavedAt &&
            !this.options.storageStatus?.().error
          ),
      },
    };
  }
  sourceUrl(repo: Repository, sha: string, path: string) {
    return `${repo.url}/${repo.provider === "gitlab" ? "-/" : ""}blob/${sha}/${path}`;
  }
  async settings(
    companyId: string,
    input: {
      monitoring?: boolean;
      shareWithDuo?: boolean;
      autoInvestigate?: boolean;
      healthUrl?: string;
      token?: string;
      automationMode?: Repository["automationMode"];
    },
  ) {
    const repo = this.repository(companyId);
    if (input.healthUrl !== undefined) {
      if (input.healthUrl) publicHttpsUrl(input.healthUrl);
      repo.healthUrl = input.healthUrl || undefined;
    }
    for (const key of [
      "monitoring",
      "shareWithDuo",
      "autoInvestigate",
    ] as const)
      if (input[key] !== undefined) repo[key] = input[key];
    if (repo.autoInvestigate && !repo.shareWithDuo)
      throw new DomainError(
        400,
        "Automatic investigation requires explicit GitLab Duo evidence sharing consent.",
      );
    if (input.automationMode) {
      if (
        input.automationMode === "supervised" &&
        (!repo.shareWithDuo ||
          !repo.stagingPolicy ||
          repo.stagingPolicy.branch !== repo.defaultBranch ||
          !this.hasWriteCredential(repo))
      )
        throw new DomainError(
          400,
          "Supervised mode requires source-sharing consent, write access, and a discovered .maya.yml policy explicitly declaring the default branch as staging.",
        );
      repo.automationMode = input.automationMode;
    }
    if (input.token) {
      const client =
        repo.provider === "gitlab"
          ? new GitLab(gitlabRest(input.token))
          : new GitHub(githubTransport(input.token));
      await client.repo(repo.fullName);
      this.db.setCredential(companyId, `${repo.id}:${repo.provider}`, {
        token: input.token,
      });
    }
    this.db.save("repository", repo);
    this.db.store.audit(
      companyId,
      "repository.settings",
      "Repository access and automation settings updated.",
      {
        monitoring: repo.monitoring,
        shareWithDuo: repo.shareWithDuo,
        autoInvestigate: repo.autoInvestigate,
        automationMode: repo.automationMode,
        stagingPolicy: repo.stagingPolicy,
        healthUrl: repo.healthUrl,
        credentialChanged: !!input.token,
      },
    );
    return repo;
  }
  private async assertStagingPolicy(repo: Repository) {
    if (
      repo.automationMode !== "supervised" ||
      !repo.shareWithDuo ||
      !repo.stagingPolicy ||
      repo.stagingPolicy.branch !== repo.defaultBranch
    )
      throw new DomainError(409, "Supervised staging is no longer authorised.");
    const captured = repo.sourceFiles.find(
      (f) => f.path === repo.stagingPolicy!.sourcePath,
    );
    const head = await this.github(repo).head(
      repo.fullName,
      repo.defaultBranch,
    );
    const current = await this.github(repo)
      .file(repo.fullName, repo.stagingPolicy.sourcePath, head)
      .catch(() => undefined);
    if (!captured || !current || captured.sha !== current.sha) {
      repo.automationMode = "assisted";
      this.db.save("repository", repo);
      throw new DomainError(
        409,
        "Staging policy changed or was removed. Rediscover configuration and review automation permissions again.",
      );
    }
  }
  async rescan(companyId: string) {
    const repo = this.repository(companyId),
      current = await discover(this.github(repo), repo.url, companyId);
    const updated = {
      ...repo,
      ...current,
      id: repo.id,
      createdAt: repo.createdAt,
      monitoring: repo.monitoring,
      shareWithDuo: repo.shareWithDuo,
      autoInvestigate: repo.autoInvestigate,
      automationMode: repo.automationMode,
      healthUrl: repo.healthUrl,
      lastObservedAt: repo.lastObservedAt,
    };
    if (
      !updated.stagingPolicy ||
      updated.stagingPolicy.branch !== updated.defaultBranch ||
      JSON.stringify(updated.stagingPolicy) !==
        JSON.stringify(repo.stagingPolicy)
    )
      updated.automationMode = "assisted";
    this.db.save("repository", updated);
    this.db.store.audit(
      companyId,
      "repository.rescanned",
      "Repository inventory refreshed from its current default branch.",
      { headSha: updated.headSha },
    );
    return updated;
  }
  private step(
    incident: OpsIncident,
    role: OpsIncident["steps"][number]["role"],
    title: string,
    detail: string,
    evidenceIds: string[] = [],
    state: OpsIncident["steps"][number]["state"] = "complete",
  ) {
    incident.steps.push({
      id: randomUUID(),
      role,
      title,
      detail: redact(detail),
      at: timestamp(),
      evidenceIds,
      state,
    });
    incident.updatedAt = timestamp();
    this.db.save("incident", incident);
    this.db.store.audit(incident.companyId, `operations.${role}`, title, {
      incidentId: incident.id,
      evidenceIds,
      state,
    });
  }
  signal(repo: Repository, signal: Signal): OpsIncident {
    const fingerprint = `${repo.id}:${signal.source}:${signal.id}`;
    const prior = this.db.dedup(repo.companyId, fingerprint);
    if (prior) return this.db.get("incident", repo.companyId, prior);
    const incident: OpsIncident = {
      id: randomUUID(),
      companyId: repo.companyId,
      projectId: repo.id,
      fingerprint,
      title: redact(signal.title).slice(0, 180),
      category: signal.category,
      severity: signal.severity,
      status: "detected",
      source: signal.source,
      sourceId: signal.id,
      sourceUrl: signal.url,
      commitSha: signal.commitSha || repo.headSha,
      summary: redact(signal.summary).slice(0, 12_000),
      evidenceIds: [],
      steps: [],
      matchedLessonIds: [],
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    this.db.store.transaction(() => {
      this.db.save("incident", incident);
      const evidence = this.db.evidence({
        companyId: repo.companyId,
        projectId: repo.id,
        incidentId: incident.id,
        kind: "signal",
        name: `${signal.source}-signal.json`,
        content: JSON.stringify(signal.payload, null, 2),
        sourceUrl: signal.url,
        commitSha: incident.commitSha,
      });
      incident.evidenceIds.push(evidence.id);
      this.db.remember(repo.companyId, fingerprint, incident.id);
      this.step(
        incident,
        "observer",
        "Signal captured",
        `${signal.source} reported ${signal.title}. Raw signal preserved with a content hash.`,
        [evidence.id],
      );
      this.step(
        incident,
        "orchestrator",
        `Routed to ${incident.category}`,
        "Initial routing uses the signal type. The AI investigator can revise this category from evidence.",
      );
    });
    return incident;
  }
  report(
    companyId: string,
    input: {
      title: string;
      summary: string;
      category: Category;
      severity: OpsIncident["severity"];
    },
  ) {
    const repo = this.repository(companyId);
    return this.signal(repo, {
      ...input,
      source: "operator",
      id: randomUUID(),
      payload: {
        ...input,
        reportedAt: timestamp(),
        provenance: "operator report; unverified until investigated",
      },
    });
  }
  async observe(companyId: string) {
    if (this.busy.has(companyId))
      throw new DomainError(409, "An observation is already in progress.");
    const repo = this.repository(companyId);
    this.busy.add(companyId);
    const errors: string[] = [];
    try {
      const github = this.github(repo);
      try {
        repo.headSha = await github.head(repo.fullName, repo.defaultBranch);
        const runs = await github.runs(repo.fullName);
        for (const run of runs.filter(
          (r: any) =>
            r.head_branch === repo.defaultBranch &&
            r.head_sha === repo.headSha &&
            [
              "failure",
              "timed_out",
              "action_required",
              "startup_failure",
            ].includes(r.conclusion),
        )) {
          const incident = this.signal(repo, {
            source: repo.provider,
            id: `run:${run.id}:${run.run_attempt}`,
            title: `${run.name || "Workflow"} failed`,
            summary: `${repo.provider === "gitlab" ? "GitLab pipeline" : "GitHub Actions run"} #${run.run_number} on ${run.head_branch} ended ${run.conclusion}.`,
            category: "ci",
            severity: "high",
            commitSha: run.head_sha,
            url: run.html_url,
            payload: {
              id: run.id,
              name: run.name,
              conclusion: run.conclusion,
              head_sha: run.head_sha,
              head_branch: run.head_branch,
              run_attempt: run.run_attempt,
              created_at: run.created_at,
              html_url: run.html_url,
            },
          });
          if (
            repo.autoInvestigate &&
            incident.status === "detected" &&
            incident.commitSha === repo.headSha
          )
            void this.investigate(companyId, incident.id).catch(() => {});
        }
        for (const incident of this.db
          .list<OpsIncident>("incident", companyId)
          .filter(
            (i) =>
              i.publication?.prNumber &&
              (["pr_open", "verifying"].includes(i.status) ||
                (i.status === "unknown" && i.merge?.state === "unknown")),
          )) {
          try {
            const refreshed = await this.refreshChecks(companyId, incident.id);
            if (
              this.repository(companyId).automationMode === "supervised" &&
              refreshed.status === "pr_open" &&
              refreshed.checks?.state === "passing" &&
              !refreshed.merge
            ) {
              await this.assertStagingPolicy(this.repository(companyId));
              await this.merge(
                companyId,
                refreshed.id,
                refreshed.planDigest!,
                "Supervised staging policy: exact repair commit passed CI; merge into the explicitly declared staging branch.",
              );
            } else if (
              repo.automationMode === "supervised" &&
              refreshed.status === "pr_open" &&
              refreshed.checks?.state === "failing"
            ) {
              if (
                (refreshed.attempts?.length || 0) <
                (repo.stagingPolicy?.maxAttempts || 2)
              )
                await this.investigate(companyId, refreshed.id);
              else {
                refreshed.status = "needs_input";
                this.step(
                  refreshed,
                  "orchestrator",
                  "Repair attempt budget reached",
                  "The staging policy's bounded correction loop is exhausted. Inspect the failed CI and provide guidance.",
                  [],
                  "blocked",
                );
              }
            } else if (
              refreshed.status === "resolved" &&
              repo.automationMode === "supervised" &&
              !this.db
                .list<AgentTask>("task", companyId)
                .some(
                  (t) =>
                    t.incidentId === refreshed.id && t.purpose === "reflect",
                )
            )
              await this.reflect(companyId, refreshed.id);
          } catch (error) {
            errors.push((error as Error).message);
          }
        }
      } catch (error) {
        errors.push((error as Error).message);
      }
      if (repo.healthUrl) {
        try {
          const result = await (this.options.probe || publicRequest)(
            repo.healthUrl,
            {},
            20_000,
          );
          const healthy = result.status >= 200 && result.status < 300;
          if (!healthy && repo.lastHealth !== "unhealthy")
            this.signal(repo, {
              id: `health:${Date.now()}`,
              title: "Service health probe failed",
              summary: `${repo.healthUrl} returned HTTP ${result.status}.`,
              source: "health",
              category: "runtime",
              severity: "high",
              url: repo.healthUrl,
              payload: {
                endpoint: repo.healthUrl,
                httpStatus: result.status,
                body: result.text.slice(0, 4000),
                at: timestamp(),
              },
            });
          repo.lastHealth = healthy ? "healthy" : "unhealthy";
        } catch (error) {
          errors.push(`Health probe: ${(error as Error).message}`);
          if (repo.lastHealth !== "unhealthy")
            this.signal(repo, {
              id: `health:${Date.now()}`,
              title: "Service health endpoint unreachable",
              summary:
                "The configured endpoint could not be reached. This alone does not prove a service defect.",
              source: "health",
              category: "runtime",
              severity: "medium",
              url: repo.healthUrl,
              payload: {
                endpoint: repo.healthUrl,
                error: (error as Error).message,
                at: timestamp(),
              },
            });
          repo.lastHealth = "unhealthy";
        }
      }
      for (const config of this.db
        .list<IntegrationConfig>("integration", companyId)
        .filter(
          (c) =>
            c.enabled &&
            !["github", "gitlab", "logrocket"].includes(c.provider),
        )) {
        try {
          const signals = await pollIntegration(
            config,
            this.db.credential(companyId, config.id) || {},
          );
          for (const signal of signals) this.signal(repo, signal);
          config.lastError = undefined;
          config.lastSyncAt = timestamp();
        } catch (error) {
          config.lastError = (error as Error).message;
          errors.push(`${config.provider}: ${config.lastError}`);
        }
        this.db.save("integration", config);
      }
      // Keep consent/settings changes made during a slow poll instead of overwriting them.
      const latest = this.repository(companyId);
      Object.assign(latest, {
        headSha: repo.headSha,
        lastHealth: repo.lastHealth,
        lastObservedAt: timestamp(),
        observationError: errors.length
          ? errors.join(" ").slice(0, 1500)
          : undefined,
      });
      this.db.save("repository", latest);
      return this.snapshot(companyId);
    } finally {
      this.busy.delete(companyId);
    }
  }
  async investigate(companyId: string, incidentId: string) {
    const repo = this.repository(companyId);
    const incident = this.db.get<OpsIncident>(
      "incident",
      companyId,
      incidentId,
    );
    if (!this.options.workforce)
      throw new DomainError(
        503,
        "GitLab Duo workforce is not configured. Connect its project and consumer ID.",
      );
    if (!repo.shareWithDuo)
      throw new DomainError(
        403,
        "Enable repository evidence sharing with GitLab Duo first.",
      );
    const refining =
      incident.status === "pr_open" && incident.checks?.state === "failing";
    if (
      this.investigating.has(incidentId) ||
      (!refining &&
        [
          "investigating",
          "publishing",
          "unknown",
          "pr_open",
          "verifying",
          "resolved",
        ].includes(incident.status))
    )
      throw new DomainError(
        409,
        "This failure already has active or completed work. Inspect its saved session and repair.",
      );
    this.investigating.add(incidentId);
    incident.status = "investigating";
    incident.error = undefined;
    this.db.save("incident", incident);
    try {
      const github = this.github(repo);
      const sourceSha = refining
        ? incident.publication!.commitSha!
        : incident.commitSha;
      incident.planBaseSha = sourceSha;
      const files = await github.tree(repo.fullName, sourceSha);
      const captured = { ...repo, files, headSha: sourceSha };
      let failureRun = /^run:\d+:/.test(incident.sourceId)
        ? Number(incident.sourceId.split(":")[1])
        : undefined;
      if (refining && github instanceof GitLab)
        failureRun = await github.failingRun(repo.fullName, sourceSha);
      else if (refining)
        failureRun = (await github.runs(repo.fullName)).find(
          (r: any) => r.head_sha === sourceSha && r.conclusion === "failure",
        )?.id;
      if (["github", "gitlab"].includes(incident.source) && failureRun) {
        const result = await github.runEvidence(repo.fullName, failureRun);
        for (const log of result.logs) {
          const evidence = this.db.evidence({
            companyId,
            projectId: repo.id,
            incidentId,
            kind: "log",
            name: log.name,
            content: log.content.slice(-8_000),
            sourceUrl: incident.sourceUrl,
            commitSha: sourceSha,
          });
          incident.evidenceIds.push(evidence.id);
        }
      }
      const selectedEvidence = new Set<string>();
      const allEvidence = [...incident.evidenceIds]
        .reverse()
        .map((id) => this.db.get<EvidenceFile>("evidence", companyId, id))
        .filter(
          (e) =>
            e.kind === "signal" ||
            (e.kind === "log" && e.commitSha === sourceSha),
        )
        .filter((e) => {
          const key = `${e.kind}:${e.name}:${e.commitSha || ""}`;
          if (selectedEvidence.has(key)) return false;
          selectedEvidence.add(key);
          return true;
        })
        .slice(0, 10)
        .reverse();
      const sourcePaths = prioritizeSource(
        captured,
        allEvidence.map((e) => e.content).join("\n"),
      );
      const sources: SourceFile[] = [];
      let budget =
        36_000 - allEvidence.reduce((total, e) => total + e.content.length, 0);
      for (const file of sourcePaths) {
        try {
          const source = await github.file(repo.fullName, file.path, sourceSha);
          if (source.content.length > budget || source.content.length > 45_000)
            continue;
          budget -= source.content.length;
          sources.push(source);
          const evidence = this.db.evidence({
            companyId,
            projectId: repo.id,
            incidentId,
            kind: "source",
            name: source.path,
            content: JSON.stringify(source),
            sourceUrl: this.sourceUrl(repo, sourceSha, source.path),
            commitSha: sourceSha,
          });
          incident.evidenceIds.push(evidence.id);
          allEvidence.push(evidence);
        } catch {
          /* A missing/oversized file is not substituted with a fixture. */
        }
      }
      const lessons = this.db
        .list<OperationalLesson>("memory", companyId)
        .filter(
          (l) =>
            l.projectId === repo.id &&
            l.status === "active" &&
            l.category === incident.category &&
            new Date(l.expiresAt).getTime() > Date.now() &&
            JSON.stringify(l.stack) === JSON.stringify(repo.stack),
        )
        .slice(0, 5);
      incident.matchedLessonIds = lessons.map((l) => l.id);
      this.step(
        incident,
        "investigator",
        "Repository evidence collected",
        `Captured ${sources.length} source files at ${sourceSha.slice(0, 8)} and ${allEvidence.filter((e) => e.kind === "log").length} logs.`,
        allEvidence.map((e) => e.id),
      );
      this.step(
        incident,
        "corrector",
        lessons.length
          ? "Reviewed memory retrieved"
          : "No matching reviewed memory",
        lessons.length
          ? `${lessons.length} company- and stack-scoped lessons supplied as advisory context. Every proposed change still requires fresh evidence and approval.`
          : "No active, unexpired lesson matches this category and stack. The AI must investigate from source.",
        lessons.flatMap((l) => l.evidenceIds),
      );
      const task = await this.options.workforce.start(
        captured,
        incident,
        allEvidence,
        lessons,
      );
      incident.taskId = task.id;
      this.step(
        incident,
        "orchestrator",
        "Duo workforce launched",
        task.sessionId
          ? `GitLab session ${task.sessionId} owns this investigation. Its output is a proposal, never authorization.`
          : "Launch outcome is uncertain. Inspect GitLab before starting anything else.",
        [],
        task.state === "unknown" ? "blocked" : "running",
      );
      if (task.state === "unknown") {
        incident.status = "unknown";
        incident.error = task.error;
        this.db.save("incident", incident);
      } else if (task.state === "failed") {
        incident.status = "needs_input";
        incident.error = task.error;
        this.db.save("incident", incident);
      }
      return incident;
    } catch (error) {
      incident.status = "needs_input";
      incident.error = (error as Error).message;
      this.step(
        incident,
        "orchestrator",
        "Investigation needs attention",
        incident.error,
        [],
        "blocked",
      );
      throw error;
    } finally {
      this.investigating.delete(incidentId);
    }
  }
  async reconcileTaskLaunch(
    companyId: string,
    taskId: string,
    allowNewInvestigation: boolean,
    reason: string,
  ) {
    if (!this.options.workforce)
      throw new DomainError(503, "GitLab Duo workforce is not configured.");
    const task = this.db.get<AgentTask>("task", companyId, taskId);
    const incident = this.db.get<OpsIncident>(
      "incident",
      companyId,
      task.incidentId,
    );
    if (
      incident.taskId !== taskId ||
      incident.status !== "unknown" ||
      task.purpose !== "investigate"
    )
      throw new DomainError(
        409,
        "This is not the incident's unconfirmed investigation launch.",
      );
    const reconciled = await this.options.workforce.reconcileLaunch(
      task,
      allowNewInvestigation,
    );
    if (reconciled.sessionId) {
      incident.status = "investigating";
      incident.error = undefined;
      this.step(
        incident,
        "orchestrator",
        "Existing Duo session reconciled",
        `Matched the frozen evidence digest to session ${reconciled.sessionId}. No new launch was requested.`,
      );
    } else if (reconciled.state === "failed") {
      incident.status = "needs_input";
      incident.error = reconciled.error;
      this.step(
        incident,
        "operator",
        "Unconfirmed launch released after provider inspection",
        reason,
        [],
        "blocked",
      );
    }
    this.db.store.audit(companyId, "workforce.launch_reconciled", reason, {
      taskId,
      sessionId: reconciled.sessionId,
      allowNewInvestigation,
      state: reconciled.state,
    });
    return reconciled;
  }
  async refreshTask(companyId: string, taskId: string) {
    if (this.refreshingTasks.has(taskId))
      return this.db.get<AgentTask>("task", companyId, taskId);
    this.refreshingTasks.add(taskId);
    try {
      if (!this.options.workforce)
        throw new DomainError(503, "GitLab Duo workforce is not configured.");
      const task = await this.options.workforce.refresh(
        this.db.get<AgentTask>("task", companyId, taskId),
      );
      const incident = this.db.get<OpsIncident>(
        "incident",
        companyId,
        task.incidentId,
      );
      if (task.purpose === "reflect") {
        if (
          task.state === "complete" &&
          !this.db.dedup(companyId, `reflection:${task.id}`)
        ) {
          try {
            this.finishReflection(task, incident);
          } catch {
            task.state = "failed";
            task.error =
              "The corrector report did not contain a valid lesson artifact. Its report is retained; no memory was activated.";
            this.db.save("task", task);
            this.step(
              incident,
              "corrector",
              "Learning needs review",
              task.error,
              [],
              "blocked",
            );
          }
        }
        return task;
      }
      if (
        incident.taskId !== task.id ||
        !["investigating", "unknown"].includes(incident.status) ||
        incident.publication?.state === "unknown"
      )
        return task;
      if (task.state === "complete") {
        let automatic = false;
        const repo = this.repository(companyId);
        const evidence = task.evidenceIds.map((id) =>
          this.db.get<EvidenceFile>("evidence", companyId, id),
        );
        const sources = evidence
          .filter((e) => e.kind === "source")
          .map((e) => {
            try {
              return JSON.parse(e.content) as SourceFile;
            } catch {
              return null;
            }
          })
          .filter((s): s is SourceFile => !!s);
        try {
          const captured = {
            ...repo,
            files: sources.map((s) => ({ path: s.path, sha: s.sha })),
            headSha: incident.planBaseSha || incident.commitSha,
          };
          incident.plan = this.options.workforce.validatePlan(
            task,
            captured,
            sources,
          );
          incident.category = incident.plan.category;
          incident.planDigest = sha256({
            repository: repo.fullName,
            baseSha: incident.planBaseSha || incident.commitSha,
            plan: incident.plan,
          });
          const report = this.db.evidence({
            companyId,
            projectId: repo.id,
            incidentId: incident.id,
            kind: "report",
            name: "duo-repair-proposal.json",
            content: JSON.stringify(incident.plan, null, 2),
            sourceUrl: task.url,
            commitSha: incident.planBaseSha || incident.commitSha,
          });
          incident.evidenceIds.push(report.id);
          incident.status =
            incident.plan.files.length && !incident.plan.questions.length
              ? "awaiting_approval"
              : "needs_input";
          this.step(
            incident,
            "specialist",
            `${incident.category} specialist proposed ${incident.plan.files.length} file changes`,
            incident.plan.rootCause,
            [report.id],
          );
          this.step(
            incident,
            "verifier",
            "Proposal provenance validated",
            "GitLab completed the workforce session. MAYA validated the JSON artifact, scoped evidence references, allowed paths and original blob identities. CI has not run on this proposal yet.",
            [report.id],
          );
          this.step(
            incident,
            "operator",
            incident.status === "awaiting_approval"
              ? "Waiting for publication approval"
              : "Information needed",
            incident.status === "awaiting_approval"
              ? `Review the full replacements and approve artifact ${incident.planDigest.slice(0, 12)} to create a PR. This does not approve merging.`
              : incident.plan.questions.join("\n") ||
                  "No source changes were proposed. Inspect the AI report.",
            [],
            "blocked",
          );
          const protectedPaths =
            /(?:^|\/)(?:test|tests|__tests__|\.github|scripts)\/|(?:\.test\.|\.spec\.|^\.gitlab-ci\.yml$|^\.maya\.ya?ml$|(?:^|\/)(?:package(?:-lock)?\.json|pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(?:\.lock)?|requirements[^/]*\.txt|setup\.(?:py|cfg)|Dockerfile(?:\.[^/]+)?|(?:docker-)?compose\.ya?ml|render\.ya?ml)$)/;
          automatic =
            repo.automationMode === "supervised" &&
            repo.shareWithDuo &&
            incident.status === "awaiting_approval" &&
            incident.plan.confidence === "high" &&
            incident.plan.files.every((f) => !protectedPaths.test(f.path));
        } catch (error) {
          incident.status = "needs_input";
          incident.error = (error as Error).message;
          this.step(
            incident,
            "verifier",
            "AI artifact rejected",
            incident.error,
            [],
            "blocked",
          );
        }
        if (automatic) {
          try {
            await this.assertStagingPolicy(this.repository(companyId));
            await this.publish(
              companyId,
              incident.id,
              incident.planDigest!,
              "Supervised staging policy: publish the validated high-confidence source repair. Tests, CI definitions, deployment policy and package scripts remain protected from automatic changes.",
            );
          } catch (error) {
            incident.error = (error as Error).message;
            this.step(
              incident,
              "orchestrator",
              "Automatic publication needs attention",
              incident.error,
              [],
              "blocked",
            );
          }
        }
      } else if (["failed", "needs_input"].includes(task.state)) {
        incident.status = "needs_input";
        incident.error = task.error;
        this.step(
          incident,
          "orchestrator",
          "Duo needs attention",
          task.error || "Inspect the session.",
          [],
          "blocked",
        );
      }
      return task;
    } finally {
      this.refreshingTasks.delete(taskId);
    }
  }
  async publish(
    companyId: string,
    incidentId: string,
    digest: string,
    reason: string,
  ) {
    const repo = this.repository(companyId),
      incident = this.db.get<OpsIncident>("incident", companyId, incidentId),
      github = this.github(repo);
    const planBase = incident.planBaseSha || incident.commitSha;
    const refining = !!incident.publication?.prNumber;
    if (
      incident.status !== "awaiting_approval" ||
      !incident.plan ||
      !incident.planDigest ||
      incident.planDigest !== digest ||
      sha256({
        repository: repo.fullName,
        baseSha: planBase,
        plan: incident.plan,
      }) !== digest
    )
      throw new DomainError(
        409,
        "The approval does not match the current repair artifact.",
      );
    if (!this.hasWriteCredential(repo))
      throw new DomainError(
        403,
        "Connect repository write access to publish this proposal.",
      );
    if (
      (await github.head(repo.fullName, repo.defaultBranch)) !==
      incident.commitSha
    )
      throw new DomainError(
        409,
        "The default branch changed since this investigation. Reinvestigate the current failure before publishing.",
      );
    if (!incident.plan.files.length || incident.plan.questions.length)
      throw new DomainError(
        409,
        "Resolve the proposal's questions before publication.",
      );
    if (
      refining &&
      (await github.pr(repo.fullName, incident.publication!.prNumber!)).head
        .sha !== planBase
    )
      throw new DomainError(
        409,
        "The repair branch changed. Capture fresh evidence before publishing another correction.",
      );
    for (const file of incident.plan.files) {
      const actual = await github.file(repo.fullName, file.path, planBase);
      if (actual.sha !== file.originalSha)
        throw new DomainError(
          409,
          "Source identity changed. Approval refused.",
        );
    }
    // All remote reads precede the atomic local reservation. Concurrent approvals cannot both win.
    this.db.store.transaction(() => {
      const fresh = this.db.get<OpsIncident>("incident", companyId, incidentId);
      if (fresh.status !== "awaiting_approval" || fresh.planDigest !== digest)
        throw new DomainError(409, "This proposal was already decided.");
      incident.approval = {
        digest,
        baseSha: planBase,
        reason,
        at: timestamp(),
      };
      incident.publication = {
        ...incident.publication,
        branch:
          incident.publication?.branch ||
          `maya/repair-${incident.id.slice(0, 12)}`,
        state: "reserved",
      };
      incident.status = "publishing";
      const evidence = this.db.evidence({
        companyId,
        projectId: repo.id,
        incidentId,
        kind: "approval",
        name: "publication-approval.json",
        content: JSON.stringify(incident.approval),
      });
      incident.evidenceIds.push(evidence.id);
      this.step(
        incident,
        "operator",
        "Exact proposal approved for a PR",
        reason,
        [evidence.id],
      );
    });
    try {
      const message = `fix: ${incident.plan.title}\n\nMAYA failure: ${incident.id}\nApproved artifact: ${digest}`;
      let commit: { sha: string };
      if (github instanceof GitLab)
        commit = {
          sha: await github.commit(
            repo.fullName,
            incident.publication!.branch,
            planBase,
            incident.plan.files,
            message,
            refining,
          ),
        };
      else {
        const parent = await github.request(
          `/repos/${repo.fullName}/git/commits/${planBase}`,
        );
        const tree = await github.request(
          `/repos/${repo.fullName}/git/trees`,
          "POST",
          {
            base_tree: parent.tree.sha,
            tree: incident.plan.files.map((f) => ({
              path: f.path,
              mode: "100644",
              type: "blob",
              content: f.content,
            })),
          },
        );
        commit = await github.request(
          `/repos/${repo.fullName}/git/commits`,
          "POST",
          { message, tree: tree.sha, parents: [planBase] },
        );
      }
      incident.publication!.commitSha = commit.sha;
      incident.publication!.state = "committed";
      this.db.save("incident", incident);
      if (!(github instanceof GitLab)) {
        if (refining)
          await github.request(
            `/repos/${repo.fullName}/git/refs/heads/${incident.publication!.branch}`,
            "PATCH",
            { sha: commit.sha, force: false },
          );
        else
          await github.request(`/repos/${repo.fullName}/git/refs`, "POST", {
            ref: `refs/heads/${incident.publication!.branch}`,
            sha: commit.sha,
          });
      }
      const pr = refining
        ? {
            number: incident.publication!.prNumber,
            html_url: incident.publication!.url,
          }
        : await github.request(`/repos/${repo.fullName}/pulls`, "POST", {
            title: incident.plan.title,
            head: incident.publication!.branch,
            base: repo.defaultBranch,
            body: this.prBody(incident, repo),
            draft: false,
          });
      incident.publication!.prNumber = pr.number;
      incident.publication!.url = pr.html_url;
      incident.publication!.state = "created";
      incident.status = "pr_open";
      incident.checks = undefined;
      (incident.attempts ||= []).push({
        taskId: incident.taskId!,
        baseSha: planBase,
        digest,
        commitSha: commit.sha,
        at: timestamp(),
      });
      this.step(
        incident,
        "specialist",
        refining
          ? "Repair refined from failing CI"
          : "Repair merge request opened",
        `${repo.provider === "gitlab" ? "MR !" : "PR #"}${pr.number} contains the approved file replacements. Awaiting CI for ${commit.sha.slice(0, 8)}.`,
        incident.evidenceIds.filter(
          (id) =>
            this.db.get<EvidenceFile>("evidence", companyId, id).kind ===
            "approval",
        ),
      );
    } catch (error) {
      incident.status = "unknown";
      incident.publication!.state = "unknown";
      incident.publication!.error =
        "Publication stopped with an uncertain remote outcome. Reconcile the reserved branch; do not repeat the write.";
      this.step(
        incident,
        "orchestrator",
        "Publication requires reconciliation",
        incident.publication!.error,
        [],
        "blocked",
      );
    }
    return incident;
  }
  private prBody(incident: OpsIncident, repo: Repository) {
    const plan = incident.plan!;
    return `${plan.rootCause}\n\n${plan.files.map((f) => `- ${f.path}: ${f.rationale}`).join("\n")}\n\nValidation required:\n${plan.verification.map((v) => `- ${v}`).join("\n")}\n\nRisks:\n${plan.risks.map((v) => `- ${v}`).join("\n") || "- No additional risks reported by the model; human review is still required."}\n\nGenerated by MAYA through GitLab Duo. The AI proposal was approved for publication; tests and merging remain separate.\nRepository base: ${repo.fullName}@${incident.commitSha}\nIncident: ${incident.id}\nArtifact SHA-256: ${incident.planDigest}\nDuo: ${incident.taskId ? this.db.get<AgentTask>("task", incident.companyId, incident.taskId).url : "unavailable"}`;
  }
  async reconcile(companyId: string, incidentId: string) {
    const repo = this.repository(companyId),
      incident = this.db.get<OpsIncident>("incident", companyId, incidentId);
    if (!incident.publication || incident.publication.state !== "unknown")
      throw new DomainError(409, "No ambiguous publication to reconcile.");
    const prs = await this.github(repo).request(
      `/repos/${repo.fullName}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:${incident.publication.branch}`)}`,
    );
    const pr = prs.find(
      (p: any) =>
        p.head?.sha === incident.publication!.commitSha &&
        p.base?.ref === repo.defaultBranch,
    );
    if (!pr)
      throw new DomainError(
        409,
        "No matching PR was found. Inspect the reserved branch on GitHub before manually recovering. No write was repeated.",
      );
    incident.publication.prNumber = pr.number;
    incident.publication.url = pr.html_url;
    incident.publication.state = "created";
    incident.publication.error = undefined;
    incident.status = "pr_open";
    this.step(
      incident,
      "orchestrator",
      "Existing PR reconciled",
      `Matched PR #${pr.number} to the exact reserved branch and commit without repeating publication.`,
    );
    return incident;
  }
  async refreshChecks(companyId: string, incidentId: string) {
    const repo = this.repository(companyId),
      incident = this.db.get<OpsIncident>("incident", companyId, incidentId),
      github = this.github(repo);
    if (!incident.publication?.prNumber || !incident.publication.commitSha)
      throw new DomainError(409, "This incident has no published PR.");
    const pr = await github.pr(repo.fullName, incident.publication.prNumber);
    if (
      pr.head.sha !== incident.publication.commitSha ||
      pr.base.ref !== repo.defaultBranch
    )
      throw new DomainError(
        409,
        "The PR head or target changed after approval. Its original approval no longer authorizes merging.",
      );
    incident.checks = await github.checks(repo.fullName, pr.head.sha);
    const previous = this.db.get<OpsIncident>(
      "incident",
      companyId,
      incidentId,
    ).checks;
    if (
      previous?.state !== incident.checks.state ||
      previous?.sha !== incident.checks.sha ||
      JSON.stringify(previous?.items) !== JSON.stringify(incident.checks.items)
    ) {
      const evidence = this.db.evidence({
        companyId,
        projectId: repo.id,
        incidentId,
        kind: "checks",
        name: `ci-${pr.head.sha.slice(0, 8)}.json`,
        content: JSON.stringify(incident.checks, null, 2),
        sourceUrl: pr.html_url,
        commitSha: pr.head.sha,
      });
      incident.evidenceIds.push(evidence.id);
      this.step(
        incident,
        "verifier",
        `CI is ${incident.checks.state}`,
        `${incident.checks.items.length} checks observed for exact PR commit ${pr.head.sha.slice(0, 8)}. A green PR does not prove deployment.`,
        [evidence.id],
        incident.checks.state === "failing"
          ? "failed"
          : incident.checks.state === "passing"
            ? "complete"
            : "running",
      );
    }
    if (pr.merged) {
      incident.merge = {
        state: "merged",
        sha: pr.merge_commit_sha,
        at: pr.merged_at,
        reason: incident.merge?.reason || "Merged externally on GitHub.",
      };
      incident.status = "verifying";
      const mergeChecks =
        github instanceof GitLab
          ? await github.checks(
              repo.fullName,
              pr.merge_commit_sha,
              repo.defaultBranch,
            )
          : await github.checks(repo.fullName, pr.merge_commit_sha);
      const deployments = await github
        .request(
          `/repos/${repo.fullName}/deployments?sha=${pr.merge_commit_sha}&per_page=5`,
        )
        .catch(() => []);
      if (deployments[0]?.id) {
        const statuses = await github
          .request(
            `/repos/${repo.fullName}/deployments/${deployments[0].id}/statuses?per_page=1`,
          )
          .catch(() => []);
        if (statuses[0])
          incident.deployment = {
            state: String(statuses[0].state),
            url: statuses[0].environment_url || statuses[0].log_url,
            at: statuses[0].created_at,
          };
      }
      if (!repo.healthUrl && github instanceof GitLab) {
        const pages = await github
          .pagesUrl(repo.fullName)
          .catch(() => undefined);
        if (pages) {
          repo.healthUrl = `${pages.replace(/\/$/, "")}/version.json`;
          this.db.save("repository", repo);
        }
      }
      if (repo.healthUrl) {
        try {
          const response = await (this.options.probe || publicRequest)(
            repo.healthUrl,
            {},
            20_000,
          );
          let version: any;
          try {
            version = JSON.parse(response.text);
          } catch {
            version = {};
          }
          incident.deploymentProbe = {
            url: repo.healthUrl,
            expectedSha: pr.merge_commit_sha,
            actualSha: version.commit || version.buildCommit || version.sha,
            httpStatus: response.status,
            passed:
              response.status === 200 &&
              (version.commit || version.buildCommit || version.sha) ===
                pr.merge_commit_sha,
            at: timestamp(),
          };
          if (
            mergeChecks.state === "passing" &&
            incident.deploymentProbe.passed &&
            incident.deployment?.state === "success"
          ) {
            const wasResolved =
              this.db.get<OpsIncident>("incident", companyId, incidentId)
                .status === "resolved";
            incident.status = "resolved";
            if (!wasResolved) {
              const release = this.db.evidence({
                companyId,
                projectId: repo.id,
                incidentId,
                kind: "checks",
                name: "verified-staging-deployment.json",
                content: JSON.stringify(
                  {
                    pipeline: mergeChecks,
                    deployment: incident.deployment,
                    probe: incident.deploymentProbe,
                  },
                  null,
                  2,
                ),
                commitSha: pr.merge_commit_sha,
                sourceUrl: repo.healthUrl,
              });
              incident.evidenceIds.push(release.id);
              incident.status = "resolved";
              this.step(
                incident,
                "verifier",
                "Staging deployment verified",
                `Default-branch CI passed and the live staging endpoint returned exact commit ${pr.merge_commit_sha.slice(0, 8)}.`,
                [release.id],
              );
            }
          }
        } catch {
          /* A failed/unreachable probe cannot mark a delivery as resolved. */
        }
      }
    } else if (pr.state === "closed") incident.status = "rejected";
    this.db.save("incident", incident);
    return incident;
  }
  async merge(
    companyId: string,
    incidentId: string,
    digest: string,
    reason: string,
  ) {
    if (this.merging.has(incidentId))
      throw new DomainError(409, "A merge is already in progress.");
    this.merging.add(incidentId);
    try {
      const repo = this.repository(companyId),
        incident = await this.refreshChecks(companyId, incidentId),
        github = this.github(repo);
      if (
        incident.status !== "pr_open" ||
        incident.merge ||
        incident.planDigest !== digest ||
        !incident.approval ||
        incident.approval.digest !== digest ||
        incident.checks?.state !== "passing"
      )
        throw new DomainError(
          409,
          "Merging requires a current approved artifact and passing exact-commit CI.",
        );
      if (
        (await github.head(repo.fullName, repo.defaultBranch)) !==
        incident.commitSha
      )
        throw new DomainError(
          409,
          "The base branch changed. Rebase and reinvestigate before merging.",
        );
      const pr = await github.pr(
        repo.fullName,
        incident.publication!.prNumber!,
      );
      if (
        pr.head.sha !== incident.publication!.commitSha ||
        pr.base.ref !== repo.defaultBranch ||
        pr.mergeable === false
      )
        throw new DomainError(409, "PR identity changed or has conflicts.");
      incident.merge = { state: "merging", at: timestamp(), reason };
      this.db.save("incident", incident);
      this.step(
        incident,
        "operator",
        "Merge approved after exact-commit CI",
        reason,
      );
      try {
        const result = await github.request(
          `/repos/${repo.fullName}/pulls/${incident.publication!.prNumber}/merge`,
          "PUT",
          {
            sha: incident.publication!.commitSha,
            merge_method: "merge",
            commit_title: incident.plan!.title,
          },
        );
        if (!result.merged) throw new Error("Merge not confirmed.");
        incident.merge.state = "merged";
        incident.merge.sha = result.sha;
        incident.status = "verifying";
        this.step(
          incident,
          "specialist",
          "Approved repair merged",
          `${repo.provider} confirmed merge ${result.sha}. Waiting for default-branch CI and deployment signals.`,
        );
      } catch (error) {
        incident.merge.state = "unknown";
        incident.status = "unknown";
        const diagnostic =
          error instanceof DomainError
            ? error.message
            : error instanceof Error &&
                ["AbortError", "TimeoutError"].includes(error.name)
              ? "The provider request timed out before a merge response."
              : "The provider did not confirm the merge result.";
        this.step(
          incident,
          "orchestrator",
          "Merge outcome needs reconciliation",
          `${diagnostic} MAYA will reread the PR to reconcile a delayed completion and will not repeat the merge write.`,
          [],
          "blocked",
        );
      }
      return incident;
    } finally {
      this.merging.delete(incidentId);
    }
  }
  feedback(companyId: string, incidentId: string, text: string) {
    const incident = this.db.get<OpsIncident>(
      "incident",
      companyId,
      incidentId,
    );
    const evidence = this.db.evidence({
      companyId,
      projectId: incident.projectId,
      incidentId,
      kind: "signal",
      name: "operator-feedback.txt",
      content: text,
    });
    incident.evidenceIds.push(evidence.id);
    this.step(incident, "operator", "Operator feedback captured", text, [
      evidence.id,
    ]);
    return incident;
  }
  reject(companyId: string, incidentId: string, reason: string) {
    const incident = this.db.get<OpsIncident>(
      "incident",
      companyId,
      incidentId,
    );
    if (
      !["detected", "awaiting_approval", "needs_input", "escalated"].includes(
        incident.status,
      )
    )
      throw new DomainError(
        409,
        "Active or externally published work must be reconciled, not discarded.",
      );
    incident.status = "rejected";
    this.step(incident, "operator", "Incident dismissed", reason);
    return incident;
  }
  async reflect(companyId: string, incidentId: string) {
    if (this.reflecting.has(incidentId))
      throw new DomainError(409, "A reflection is already being requested.");
    this.reflecting.add(incidentId);
    try {
      const repo = this.repository(companyId),
        incident = await this.refreshChecks(companyId, incidentId);
      if (!this.options.workforce || !repo.shareWithDuo)
        throw new DomainError(
          403,
          "Configure Duo and enable evidence sharing first.",
        );
      if (
        incident.status !== "resolved" ||
        incident.merge?.state !== "merged" ||
        incident.checks?.state !== "passing"
      )
        throw new DomainError(
          409,
          "Learning requires a merged repair and passing CI evidence.",
        );
      const prior = this.db
        .list<AgentTask>("task", companyId)
        .find((t) => t.incidentId === incidentId && t.purpose === "reflect");
      if (prior && prior.state !== "failed") {
        const lessonId = this.db.dedup(companyId, `reflection:${prior.id}`);
        if (
          !lessonId ||
          this.db.get<OperationalLesson>("memory", companyId, lessonId)
            .status !== "retired"
        )
          return prior;
      }
      const remote = await this.github(repo).pr(
        repo.fullName,
        incident.publication!.prNumber!,
      );
      if (
        !remote.merged ||
        remote.head.sha !== incident.publication!.commitSha ||
        remote.merge_commit_sha !== incident.merge!.sha
      )
        throw new DomainError(
          409,
          "The verified merge identity no longer matches the repair. Reconcile it before learning.",
        );
      const provenance = this.db.evidence({
        companyId,
        projectId: repo.id,
        incidentId,
        kind: "checks",
        name: "merged-repair-provenance.json",
        commitSha: incident.merge!.sha,
        sourceUrl: incident.publication!.url,
        content: JSON.stringify(
          {
            provider: repo.provider,
            mergeRequest: {
              number: remote.number,
              url: remote.html_url,
              merged: remote.merged,
              head: { ref: remote.head.ref, sha: remote.head.sha },
              base: { ref: remote.base.ref, sha: remote.base.sha },
              merge_commit_sha: remote.merge_commit_sha,
              merged_at: remote.merged_at,
            },
            originalCommit: incident.commitSha,
            repairCommit: incident.publication!.commitSha,
            mergedCommit: incident.merge!.sha,
            approvedArtifact: incident.approval,
            deployment: incident.deployment,
            liveProbe: incident.deploymentProbe,
          },
          null,
          2,
        ),
      });
      incident.evidenceIds.push(provenance.id);
      this.db.save("incident", incident);
      // Include raw logs and original tests/source, not only earlier model summaries.
      const newest = new Map<string, EvidenceFile>();
      for (const id of [...incident.evidenceIds].reverse()) {
        const file = this.db.get<EvidenceFile>("evidence", companyId, id);
        const key = `${file.kind}:${file.name}:${file.commitSha || ""}`;
        if (!newest.has(key)) newest.set(key, file);
      }
      const changedPaths = new Set(incident.plan?.files.map((f) => f.path));
      const evidence = [...newest.values()].filter(
        (file) =>
          file.kind !== "source" ||
          ((file.commitSha === incident.commitSha ||
            file.commitSha === incident.planBaseSha) &&
            (changedPaths.has(file.name) ||
              /(?:^|\/)(?:test|tests|__tests__)\/|\.test\.|\.spec\./.test(
                file.name,
              ))),
      );
      const task = await this.options.workforce.start(
        repo,
        incident,
        evidence,
        [],
        "reflect",
      );
      this.step(
        incident,
        "corrector",
        "Corrector reviewing the verified outcome",
        "The AI will propose a company-scoped lesson. Promotion remains a separate operator decision.",
        [],
        "running",
      );
      return task;
    } finally {
      this.reflecting.delete(incidentId);
    }
  }
  private finishReflection(task: AgentTask, incident: OpsIncident) {
    const repo = this.repository(task.companyId);
    const result = z
      .object({
        title: z.string().max(160),
        symptoms: z.string().max(4000),
        rootCause: z.string().max(4000),
        guidance: z.string().max(7000),
      })
      .strict()
      .parse(extractJson(task.report!));
    const lesson: OperationalLesson = {
      ...result,
      id: randomUUID(),
      companyId: repo.companyId,
      projectId: repo.id,
      incidentId: incident.id,
      category: incident.category,
      status: "candidate",
      version:
        1 +
        this.db
          .list<OperationalLesson>("memory", repo.companyId)
          .filter((lesson) => lesson.incidentId === incident.id).length,
      stack: repo.stack,
      sourceSha: incident.merge!.sha!,
      evidenceIds: task.evidenceIds,
      createdAt: timestamp(),
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      reviews: [],
    };
    this.db.store.transaction(() => {
      this.db.save("memory", lesson);
      this.db.remember(repo.companyId, `reflection:${task.id}`, lesson.id);
      this.step(
        incident,
        "corrector",
        "Operational lesson proposed",
        lesson.guidance,
        lesson.evidenceIds,
      );
    });
    return lesson;
  }
  reviewLesson(
    companyId: string,
    lessonId: string,
    action: "promote" | "retire",
    reason: string,
  ) {
    const lesson = this.db.get<OperationalLesson>(
      "memory",
      companyId,
      lessonId,
    );
    if (action === "promote") {
      const incident = this.db.get<OpsIncident>(
        "incident",
        companyId,
        lesson.incidentId,
      );
      if (
        lesson.status !== "candidate" ||
        incident.status !== "resolved" ||
        incident.merge?.state !== "merged" ||
        new Date(lesson.expiresAt).getTime() <= Date.now()
      )
        throw new DomainError(
          409,
          "Only an unexpired candidate from a verified resolved incident can be promoted.",
        );
      for (const id of lesson.evidenceIds)
        this.db.get<EvidenceFile>("evidence", companyId, id);
    }
    lesson.status = action === "promote" ? "active" : "retired";
    lesson.reviews.push({ action, reason, at: timestamp() });
    this.db.save("memory", lesson);
    this.db.store.audit(
      companyId,
      `memory.${action}`,
      `${lesson.title}: ${reason}`,
      { lessonId },
    );
    return lesson;
  }
  async configureIntegration(
    companyId: string,
    input: {
      provider: Provider;
      settings: Record<string, string>;
      credentials?: Record<string, string>;
      enabled: boolean;
    },
  ) {
    const repo = this.repository(companyId),
      id = `${repo.id}:${input.provider}`;
    if (input.settings.url) publicHttpsUrl(input.settings.url);
    if (
      Object.keys(input.settings).some((k) =>
        /token|secret|password|key/i.test(k),
      )
    )
      throw new DomainError(
        400,
        "Put credentials in the credential fields, not integration settings.",
      );
    const credentials =
      input.credentials && Object.values(input.credentials).some(Boolean)
        ? input.credentials
        : this.db.credential(companyId, id) || {};
    const config: IntegrationConfig = {
      id,
      companyId,
      projectId: repo.id,
      provider: input.provider,
      enabled: input.enabled,
      settings: input.settings,
      hasCredentials: Object.values(credentials).some(Boolean),
    };
    if (input.enabled && input.provider !== "logrocket") {
      await pollIntegration(config, credentials);
      config.lastSyncAt = timestamp();
    }
    if (Object.keys(credentials).length)
      this.db.setCredential(companyId, id, credentials);
    this.db.save("integration", config);
    this.db.store.audit(
      companyId,
      "integration.configured",
      `${input.provider} integration ${config.enabled ? "connected" : "disabled"}.`,
      { provider: input.provider },
    );
    return config;
  }
  webhookSecret(companyId: string, rotate = false) {
    const repo = this.repository(companyId),
      id = `${repo.id}:webhook`;
    const prior = this.db.credential(companyId, id)?.secret;
    const secret = prior && !rotate ? prior : randomBytes(32).toString("hex");
    if (!prior || rotate) {
      this.db.setCredential(companyId, id, { secret });
      this.db.store.audit(
        companyId,
        "webhook.secret",
        "Webhook signing secret generated or rotated.",
      );
    }
    return secret;
  }
  async installWebhook(companyId: string, baseUrl: string) {
    const repo = this.repository(companyId);
    publicHttpsUrl(baseUrl);
    const url = `${baseUrl.replace(/\/$/, "")}/hooks/${companyId}/github`;
    const prior = await this.github(repo).request(
      `/repos/${repo.fullName}/hooks`,
    );
    if (prior.some((h: any) => h.config?.url === url))
      return { url, status: "already_installed" };
    const secret = this.webhookSecret(companyId);
    // Journal before the external mutation; do not auto-retry on a network failure.
    this.db.store.audit(
      companyId,
      "webhook.install.requested",
      "GitHub webhook installation requested.",
      { url },
    );
    await this.github(repo).request(`/repos/${repo.fullName}/hooks`, "POST", {
      name: "web",
      active: true,
      events: ["workflow_run", "deployment_status", "issues"],
      config: { url, content_type: "json", secret, insecure_ssl: "0" },
    });
    return { url, status: "installed" };
  }
  ingest(
    companyId: string,
    provider: Provider,
    payload: any,
    delivery: string,
    event?: string,
  ) {
    const repo = this.repository(companyId);
    if (provider === "gitlab") {
      if (Number(payload.project?.id) !== repo.remoteProjectId)
        throw new DomainError(
          403,
          "Webhook project does not match this workspace.",
        );
      if (
        event === "Pipeline Hook" &&
        payload.object_attributes?.status === "failed" &&
        payload.object_attributes.ref === repo.defaultBranch
      ) {
        const p = payload.object_attributes;
        const failure = this.signal(repo, {
          source: "gitlab",
          id: `run:${p.id}:1`,
          title: `Pipeline #${p.iid || p.id} failed`,
          summary: `GitLab CI failed on ${p.ref}.`,
          category: "ci",
          severity: "high",
          commitSha: p.sha,
          url: `${repo.url}/-/pipelines/${p.id}`,
          payload: {
            id: p.id,
            sha: p.sha,
            ref: p.ref,
            status: p.status,
            failedJobs: (payload.builds || [])
              .filter((j: any) => j.status === "failed")
              .map((j: any) => ({
                id: j.id,
                name: j.name,
                stage: j.stage,
                status: j.status,
              })),
          },
        });
        if (repo.autoInvestigate && failure.status === "detected")
          void this.investigate(companyId, failure.id).catch(() => {});
        return failure;
      }
      return { ok: true, ignored: true };
    }
    if (provider === "github") {
      if (
        payload.repository?.full_name?.toLowerCase() !==
        repo.fullName.toLowerCase()
      )
        throw new DomainError(
          403,
          "Webhook repository does not match this workspace.",
        );
      if (event === "ping") return { ok: true };
      const run = payload.workflow_run;
      if (
        event === "workflow_run" &&
        run &&
        run.head_branch === repo.defaultBranch &&
        ["failure", "timed_out", "action_required"].includes(run.conclusion)
      ) {
        const incident = this.signal(repo, {
          source: provider,
          id: `run:${run.id}:${run.run_attempt}`,
          title: `${run.name || "Workflow"} failed`,
          summary: `Workflow run #${run.run_number} failed on ${run.head_branch}.`,
          category: "ci",
          severity: "high",
          commitSha: run.head_sha,
          url: run.html_url,
          payload: {
            id: run.id,
            head_sha: run.head_sha,
            head_branch: run.head_branch,
            conclusion: run.conclusion,
          },
        });
        if (repo.autoInvestigate && incident.status === "detected")
          void this.investigate(companyId, incident.id).catch(() => {});
        return incident;
      }
      if (event === "issues" && payload.action === "opened")
        return this.signal(repo, {
          source: provider,
          id: `issue:${payload.issue.id}`,
          title: payload.issue.title,
          summary: String(payload.issue.body || "Issue opened").slice(0, 10000),
          category: "runtime",
          severity: "medium",
          url: payload.issue.html_url,
          payload: {
            number: payload.issue.number,
            title: payload.issue.title,
            body: payload.issue.body,
          },
        });
      if (event === "deployment_status")
        this.db.store.audit(
          companyId,
          "deployment.signal",
          `Deployment is ${payload.deployment_status?.state || "unknown"}.`,
          {
            sha: payload.deployment?.sha,
            url: payload.deployment_status?.environment_url,
          },
        );
      return { ok: true, ignored: true };
    }
    const signal = z
      .object({
        id: z.string().min(1).max(150).default(delivery),
        title: z.string().min(3).max(180),
        summary: z.string().max(20000),
        category: z.enum([
          "ci",
          "security",
          "deployment",
          "runtime",
          "dependency",
        ]),
        severity: z.enum(["low", "medium", "high"]).default("medium"),
        url: z.string().url().optional(),
        commitSha: z
          .string()
          .regex(/^[a-f0-9]{40}$/)
          .optional(),
      })
      .parse(payload);
    return this.signal(repo, { ...signal, source: provider, payload });
  }
  start() {
    if (this.timer) return;
    // Interrupted writes and uncertain launches remain visible; never repeat them after restart.
    for (const company of this.db.store.companies())
      for (const i of this.db.list<OpsIncident>("incident", company.id)) {
        if (i.status === "publishing" || i.merge?.state === "merging") {
          i.status = "unknown";
          if (i.publication && i.publication.state !== "created")
            i.publication.state = "unknown";
          this.step(
            i,
            "orchestrator",
            "Interrupted remote write needs reconciliation",
            "The process restarted before the remote outcome was confirmed. No write was repeated.",
            [],
            "blocked",
          );
        }
        if (i.status === "investigating" && !i.taskId) {
          const task = this.db
            .list<AgentTask>("task", company.id)
            .find((t) => t.incidentId === i.id && t.purpose === "investigate");
          if (task?.sessionId) {
            i.taskId = task.id;
            this.db.save("incident", i);
          } else {
            i.status = "unknown";
            this.step(
              i,
              "orchestrator",
              "Interrupted investigation",
              "Inspect GitLab sessions before another launch. The original request was not repeated.",
              [],
              "blocked",
            );
          }
        }
      }
    this.timer = setInterval(() => void this.tick(), 8000);
    this.timer.unref();
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const c of this.db.store.companies()) {
        for (const task of this.db
          .list<AgentTask>("task", c.id)
          .filter(
            (t) =>
              t.sessionId &&
              ["running", "unknown", "needs_input"].includes(t.state),
          ))
          await this.refreshTask(c.id, task.id).catch(() => {});
        const repo = this.db.list<Repository>("repository", c.id)[0];
        if (
          repo?.monitoring &&
          Date.now() - new Date(repo.lastObservedAt || 0).getTime() >=
            (this.options.observerIntervalMs || 60_000)
        )
          await this.observe(c.id).catch(() => {});
      }
    } finally {
      this.ticking = false;
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
