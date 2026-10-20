import { createHash, randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { ConnectorError, Connectors } from "./connectors.js";
import { makeFixture, scenarioById, verifyFixture } from "./scenarios.js";
import type {
  Company,
  Incident,
  Lesson,
  Proposal,
  Run,
  ScenarioId,
  Step,
} from "../shared/types.js";
export class DomainError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class Engine {
  readonly tasks = new Map<string, Promise<unknown>>();
  readonly injections = new Set<string>();
  constructor(
    readonly store: Store,
    readonly connectors = new Connectors(),
    readonly delay = 550,
  ) {}
  company(id: string) {
    const c = this.store.company(id);
    if (!c) throw new DomainError(404, "Company not found.");
    return c;
  }
  run(companyId: string, id: string) {
    const r = this.store.get<Run>("runs", id, companyId);
    if (!r) throw new DomainError(404, "Run not found in this company.");
    return r;
  }
  async incident(companyId: string, scenario: ScenarioId) {
    if (this.injections.has(companyId))
      throw new DomainError(
        409,
        "An incident is already being injected for this company.",
      );
    this.injections.add(companyId);
    try {
      return await this.createIncident(companyId, scenario);
    } finally {
      this.injections.delete(companyId);
    }
  }
  private async createIncident(companyId: string, scenario: ScenarioId) {
    const company = this.company(companyId),
      s = scenarioById(scenario);
    if (company.connector !== "simulation") {
      if (!this.connectors.allowed(company, scenario))
        throw new DomainError(
          400,
          "This connected company does not support that scenario.",
        );
      if (
        this.store
          .list<Incident>("incidents", companyId)
          .some((i) => !["resolved", "rejected"].includes(i.status))
      )
        throw new DomainError(
          409,
          "Investigate the saved incident or retry its run before injecting another live fault.",
        );
    }
    const incident: Incident = {
      id: randomUUID(),
      companyId,
      scenario,
      title: s.title,
      status: company.connector === "simulation" ? "open" : "injecting",
      context: makeFixture(scenario),
      evidence:
        company.connector === "simulation"
          ? [
              `source=isolated-fixture signal=${s.signal}`,
              `runtime=${company.runtime} company_revision=${company.revision}`,
              `observed_at=${new Date().toISOString()}`,
            ]
          : [],
      createdAt: new Date().toISOString(),
    };
    // Journal the intent before contacting a service: a timeout or restart must not hide a fault.
    this.store.transaction(() => {
      this.store.saveIncident(incident);
      this.store.audit(
        companyId,
        "incident.created",
        `${company.connector === "simulation" ? "Simulated" : "Live demo"} incident: ${s.title}`,
        { incidentId: incident.id, scenario },
      );
    });
    if (company.connector !== "simulation") {
      try {
        incident.faultId = await this.connectors.inject(company, scenario);
        this.store.saveIncident(incident);
        const observed = await this.connectors.inspect(company);
        if (
          observed.fault !== scenario ||
          observed.faultId !== incident.faultId
        )
          throw new Error(
            "The injected fault changed before its evidence was captured.",
          );
        incident.evidence = observed.evidence;
        incident.status = "open";
      } catch (error) {
        incident.status = "failed";
        incident.evidence.push(
          `Injection outcome requires investigation: ${(error as Error).message}`,
        );
        this.store.audit(
          companyId,
          "incident.injection_uncertain",
          "The injection outcome must be checked; its intent was retained.",
          { incidentId: incident.id, error: (error as Error).message },
        );
      }
      this.store.saveIncident(incident);
    }
    return incident;
  }
  start(companyId: string, incidentId: string) {
    const company = this.company(companyId),
      incident = this.store.get<Incident>("incidents", incidentId, companyId);
    if (!incident)
      throw new DomainError(404, "Incident not found in this company.");
    if (
      this.store
        .list<Run>("runs", companyId)
        .some(
          (r) =>
            r.incidentId === incidentId &&
            ["running", "awaiting_approval", "resolved"].includes(r.status),
        )
    )
      throw new DomainError(
        409,
        "This incident already has an active or successful run.",
      );
    if (
      company.connector !== "simulation" &&
      this.store
        .list<Run>("runs", companyId)
        .some((r) => ["running", "awaiting_approval"].includes(r.status))
    )
      throw new DomainError(
        409,
        "Finish the active live run before starting another investigation.",
      );
    if (incident.status === "resolved")
      throw new DomainError(409, "This incident is already resolved.");
    const run: Run = {
      id: randomUUID(),
      companyId,
      incidentId,
      status: "running",
      stage: "Queued",
      mode: company.connector === "simulation" ? "simulation" : "connected",
      contextRevision: company.revision,
      runtime: company.runtime,
      scenario: incident.scenario,
      steps: [],
      proposal: null,
      verification: null,
      memory: { kind: "new", reason: "Memory has not been checked yet." },
      createdAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
    };
    this.store.transaction(() => {
      this.store.saveRun(run);
      incident.status = "investigating";
      this.store.saveIncident(incident);
      this.store.audit(
        companyId,
        "run.started",
        "Supervisor started a bounded incident run.",
        { runId: run.id, provider: "deterministic" },
      );
    });
    const task = this.execute(run, company, incident)
      .catch((error) => this.fail(run, error as Error))
      .finally(() => this.tasks.delete(run.id));
    this.tasks.set(run.id, task);
    return run;
  }
  private step(
    run: Run,
    agent: string,
    title: string,
    detail: string,
    state: Step["state"] = "complete",
    data?: unknown,
  ) {
    run.stage = title;
    run.steps.push({
      id: randomUUID(),
      agent,
      title,
      detail,
      state,
      at: new Date().toISOString(),
      ...(data ? { data } : {}),
    });
    this.store.saveRun(run);
  }
  private async pause() {
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
  }
  private finish(run: Run) {
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - new Date(run.createdAt).getTime();
    this.store.saveRun(run);
  }
  private async execute(run: Run, company: Company, incident: Incident) {
    if (run.mode === "connected") {
      const observed = await this.connectors.inspect(company);
      if (observed.fault !== incident.scenario || !observed.faultId)
        throw new Error(
          "No matching live fault is present. No repair will be proposed; inspect the service before retrying.",
        );
      run.faultId = observed.faultId;
      incident.faultId = observed.faultId;
      incident.evidence = observed.evidence;
      this.store.saveIncident(incident);
    }
    this.step(
      run,
      "observer",
      "Evidence captured",
      `${incident.evidence.length} source records captured. ${run.mode === "simulation" ? "All signals are from isolated fixtures." : "Signals came from the connected demo service."}`,
      "complete",
      incident.evidence,
    );
    await this.pause();
    const lessons = this.store
      .list<Lesson>("lessons", company.id)
      .filter((l) => l.scenario === incident.scenario && l.status === "active");
    const matching = lessons.find((l) => this.validLesson(l, company));
    if (matching) {
      run.memory = {
        kind: "reused",
        lessonId: matching.id,
        reason: `Verified playbook v${matching.version} matches this company, scenario, runtime, and expiry.`,
      };
      this.step(run, "memory", "Verified lesson matched", run.memory.reason);
    } else if (lessons.length) {
      run.memory = {
        kind: "rejected",
        lessonId: lessons[0].id,
        reason:
          "A similar lesson exists, but its runtime, validity window, or source evidence does not match. Fresh investigation required.",
      };
      this.step(
        run,
        "memory",
        "Stale lesson rejected",
        run.memory.reason,
        "warning",
      );
    } else {
      run.memory = {
        kind: "new",
        reason:
          "No active, verified playbook matches this incident. Fresh investigation required.",
      };
      this.step(run, "memory", "No verified precedent", run.memory.reason);
    }
    await this.pause();
    const s = scenarioById(incident.scenario);
    if (!s.patch) {
      run.status = "escalated";
      this.step(
        run,
        "supervisor",
        "Owner action required",
        "Credentials cannot be invented or rotated by this sandbox. Ask the integration owner to rotate the expired credential.",
        "warning",
      );
      incident.status = "escalated";
      this.store.saveIncident(incident);
      this.finish(run);
      this.store.audit(
        company.id,
        "run.escalated",
        "Credential incident escalated to its owner.",
        { runId: run.id },
      );
      return;
    }
    if (!matching) {
      this.step(
        run,
        "investigator",
        "Root cause isolated",
        `${s.signal}: replayed the failing contract against the captured fixture. A minimal configuration correction is available.`,
      );
      await this.pause();
    }
    const patch = matching?.patch || s.patch,
      after = { ...incident.context, ...patch };
    const proposal: Proposal = {
      patch,
      before: incident.context,
      after,
      digest: "",
      action:
        run.mode === "connected"
          ? "Reset the injected demo fault through the authenticated connector."
          : "Apply the configuration patch to this isolated incident fixture.",
      scope:
        run.mode === "connected"
          ? `${company.connector} · demo configuration only`
          : `${company.name} · isolated fixture only`,
    };
    proposal.digest = digest({
      companyId: company.id,
      revision: run.contextRevision,
      incidentId: incident.id,
      before: proposal.before,
      after: proposal.after,
      action: proposal.action,
      patch: proposal.patch,
      scope: proposal.scope,
      faultId: run.faultId,
    });
    run.proposal = proposal;
    this.step(
      run,
      "repair",
      "Minimal repair proposed",
      proposal.action,
      "complete",
      patch,
    );
    await this.pause();
    run.verification = {
      baseline: verifyFixture(incident.scenario, incident.context),
      candidate: verifyFixture(incident.scenario, after),
    };
    if (run.mode === "connected") {
      run.verification.live = await this.connectors.verify(company);
      run.verification.liveBefore = run.verification.live;
      run.verification.livePhase = "before_repair";
      if (run.verification.live.every((c) => c.passed))
        throw new Error(
          "Live checks did not reproduce the incident. No repair will be proposed.",
        );
    }
    if (!run.verification.candidate.every((c) => c.passed))
      throw new Error("The proposed repair did not pass its fixture checks.");
    if (run.verification.baseline.every((c) => c.passed))
      throw new Error("The captured baseline does not reproduce a failure.");
    this.step(
      run,
      "verifier",
      "Candidate fixture checks passed",
      `${run.verification.candidate.length} independent fixture assertions passed. Baseline failure is reproduced. ${run.mode === "connected" ? "Pre-repair HTTP checks reproduced the live failure. Post-repair HTTP checks require approval first." : "No external code or deployment was changed."}`,
      "complete",
      run.verification,
    );
    await this.pause();
    run.status = "awaiting_approval";
    incident.status = "awaiting_approval";
    this.store.saveIncident(incident);
    this.step(
      run,
      "approval",
      "Waiting for your approval",
      "Review the exact patch, evidence, and checks. Approval is bound to this artifact digest and company revision.",
    );
    this.store.audit(
      company.id,
      "approval.requested",
      "A verified proposal is waiting for the operator.",
      { runId: run.id, digest: proposal.digest },
    );
  }
  private artifactDigest(run: Run) {
    return digest({
      companyId: run.companyId,
      revision: run.contextRevision,
      incidentId: run.incidentId,
      before: run.proposal!.before,
      after: run.proposal!.after,
      action: run.proposal!.action,
      patch: run.proposal!.patch,
      scope: run.proposal!.scope,
      faultId: run.faultId,
    });
  }
  private requireContext(run: Run, company: Company) {
    if (
      run.contextRevision !== company.revision ||
      run.runtime !== company.runtime
    )
      throw new DomainError(
        409,
        "Company context changed. Run a fresh investigation before any action.",
      );
  }
  private fail(run: Run, error: Error) {
    this.store.transaction(() => {
      run.status = "failed";
      this.step(
        run,
        "supervisor",
        "Recovery not confirmed",
        error.message,
        "warning",
      );
      this.finish(run);
      const incident = this.store.get<Incident>(
        "incidents",
        run.incidentId,
        run.companyId,
      )!;
      incident.status = "failed";
      this.store.saveIncident(incident);
      this.store.audit(
        run.companyId,
        "run.failed",
        "No verified recovery was recorded. Inspect the saved evidence before retrying.",
        { runId: run.id, error: error.message },
      );
    });
  }
  private complete(run: Run, recheck = false) {
    this.store.transaction(() => {
      run.recoveryRechecked = recheck;
      this.step(
        run,
        "verifier",
        recheck
          ? "Read-only recovery recheck passed"
          : run.mode === "connected"
            ? "Live recovery verified"
            : "Fixture recovery verified",
        recheck
          ? "The service is healthy now. No repair was repeated; this check does not establish who restored it."
          : run.mode === "connected"
            ? "The connected service passed its live health and behavior checks."
            : "The fixture passed every contract check after the approved patch.",
      );
      run.status = "resolved";
      this.finish(run);
      const incident = this.store.get<Incident>(
        "incidents",
        run.incidentId,
        run.companyId,
      )!;
      incident.status = "resolved";
      this.store.saveIncident(incident);
      const existing = this.store.list<Lesson>("lessons", run.companyId);
      // An uncertain repair followed by a recheck is useful evidence, not proof of a causal repair.
      if (
        !recheck &&
        run.memory.kind !== "reused" &&
        !existing.some((l) => l.sourceRunId === run.id)
      ) {
        const lesson: Lesson = {
          id: randomUUID(),
          companyId: run.companyId,
          scenario: run.scenario,
          runtime: run.runtime,
          version:
            Math.max(
              0,
              ...existing
                .filter((l) => l.scenario === run.scenario)
                .map((l) => l.version),
            ) + 1,
          status: "candidate",
          title: scenarioById(run.scenario).title,
          patch: run.proposal!.patch,
          sourceRunId: run.id,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        };
        this.store.saveLesson(lesson);
        this.store.audit(
          run.companyId,
          "lesson.candidate",
          "A lesson was proposed. Separate review is required before reuse.",
          { lessonId: lesson.id, runId: run.id },
        );
      }
      this.store.audit(
        run.companyId,
        recheck ? "run.reconciled" : "run.resolved",
        recheck
          ? "Read-only verification confirmed the current recovery; no repair was repeated."
          : "Approved repair and verification completed.",
        { runId: run.id, mode: run.mode, digest: run.approval?.digest },
      );
    });
    return run;
  }
  async approve(
    companyId: string,
    runId: string,
    approvalDigest: string,
    reason: string,
  ) {
    const run = this.run(companyId, runId),
      company = this.company(companyId);
    if (
      run.status !== "awaiting_approval" ||
      !run.proposal ||
      !run.verification
    )
      throw new DomainError(409, "This run is not waiting for approval.");
    this.requireContext(run, company);
    const expected = this.artifactDigest(run);
    if (expected !== run.proposal.digest || approvalDigest !== expected)
      throw new DomainError(
        409,
        "The approval does not match the exact proposed artifact.",
      );
    if (!verifyFixture(run.scenario, run.proposal.after).every((c) => c.passed))
      throw new DomainError(409, "Verification no longer passes.");
    if (run.mode === "connected" && !run.faultId)
      throw new DomainError(
        409,
        "Recapture this incident before approval; its fault identity is missing.",
      );
    // Persist authorization and claim the run atomically, before the first external write.
    this.store.transaction(() => {
      this.store.decide(companyId, runId, "approved", reason, expected);
      run.approval = { digest: expected, reason, at: new Date().toISOString() };
      run.status = "running";
      this.step(run, "operator", "Exact proposal approved", reason);
      this.store.audit(
        companyId,
        "approval.granted",
        "Operator authorization was saved before repair execution.",
        { runId, digest: expected },
      );
    });
    const task = (async () => {
      try {
        if (run.mode === "connected") {
          await this.connectors.repair(company, run.scenario, run.faultId!);
          run.verification!.livePhase = "after_repair";
          run.verification!.live = undefined;
          run.verification!.live = await this.connectors.verify(company);
          run.verification!.liveAfter = run.verification!.live;
          if (
            !run.verification!.live.length ||
            !run.verification!.live.every((c) => c.passed)
          )
            throw new Error(
              "Live post-repair checks failed. The incident is not resolved.",
            );
        }
        return this.complete(run);
      } catch (error) {
        this.fail(run, error as Error);
        throw new DomainError(
          error instanceof ConnectorError && error.status === 409 ? 409 : 502,
          (error as Error).message,
        );
      }
    })();
    this.tasks.set(run.id, task);
    try {
      return await task;
    } finally {
      this.tasks.delete(run.id);
    }
  }
  async recheck(companyId: string, runId: string) {
    const run = this.run(companyId, runId),
      company = this.company(companyId);
    if (
      run.mode !== "connected" ||
      !["failed", "interrupted"].includes(run.status) ||
      !run.approval ||
      !run.proposal ||
      !run.verification
    )
      throw new DomainError(
        409,
        "Only an interrupted or failed approved live repair can be rechecked.",
      );
    this.requireContext(run, company);
    const decision = this.store.decision(companyId, runId);
    if (
      decision?.decision !== "approved" ||
      decision.digest !== this.artifactDigest(run) ||
      run.approval.digest !== decision.digest
    )
      throw new DomainError(
        409,
        "The saved authorization does not match this artifact.",
      );
    if (
      this.store
        .list<Incident>("incidents", companyId)
        .some(
          (i) =>
            i.id !== run.incidentId &&
            !["resolved", "rejected"].includes(i.status),
        )
    )
      throw new DomainError(
        409,
        "Another incident needs attention before this recovery can be rechecked.",
      );
    if (
      this.store
        .list<Run>("runs", companyId)
        .some(
          (r) =>
            ["running", "awaiting_approval"].includes(r.status) ||
            (r.id !== run.id &&
              r.incidentId === run.incidentId &&
              r.status === "resolved"),
        )
    )
      throw new DomainError(
        409,
        "Finish the active run before rechecking this recovery.",
      );
    run.status = "running";
    run.finishedAt = null;
    this.step(
      run,
      "verifier",
      "Read-only recovery recheck",
      "Inspecting current service health. This action never repeats a repair.",
    );
    const task = (async () => {
      try {
        run.verification!.livePhase = "after_repair";
        run.verification!.live = undefined;
        run.verification!.live = await this.connectors.verify(company);
        run.verification!.liveAfter = run.verification!.live;
        if (
          !run.verification!.live.length ||
          !run.verification!.live.every((c) => c.passed)
        )
          throw new Error(
            "The service is not healthy yet. Recheck evidence or start a fresh investigation.",
          );
        return this.complete(run, true);
      } catch (error) {
        this.fail(run, error as Error);
        throw new DomainError(502, (error as Error).message);
      }
    })();
    this.tasks.set(run.id, task);
    try {
      return await task;
    } finally {
      this.tasks.delete(run.id);
    }
  }
  reject(companyId: string, id: string, reason: string) {
    const r = this.run(companyId, id);
    if (r.status !== "awaiting_approval")
      throw new DomainError(409, "This run is not waiting for approval.");
    this.store.transaction(() => {
      this.store.decide(
        companyId,
        id,
        "rejected",
        reason,
        r.proposal?.digest || "",
      );
      r.status = "rejected";
      this.step(r, "operator", "Proposal rejected", reason, "warning");
      this.finish(r);
      const i = this.store.get<Incident>("incidents", r.incidentId, companyId)!;
      i.status = "rejected";
      this.store.saveIncident(i);
      this.store.audit(
        companyId,
        "approval.rejected",
        "Operator rejected the repair. No repair was applied.",
        { runId: id },
      );
    });
    return r;
  }
  private validLesson(lesson: Lesson, company: Company) {
    const source = this.store.get<Run>("runs", lesson.sourceRunId, company.id);
    if (
      !source?.proposal ||
      !source.verification ||
      source.status !== "resolved" ||
      source.recoveryRechecked
    )
      return false;
    const expires = new Date(lesson.expiresAt).getTime();
    const expected = source.approval
      ? this.artifactDigest(source)
      : digest({
          companyId: source.companyId,
          revision: source.contextRevision,
          incidentId: source.incidentId,
          before: source.proposal.before,
          after: source.proposal.after,
          action: source.proposal.action,
        });
    const decision = this.store.decision(company.id, source.id);
    return (
      lesson.runtime === company.runtime &&
      lesson.runtime === source.runtime &&
      lesson.scenario === source.scenario &&
      Number.isFinite(expires) &&
      expires > Date.now() &&
      digest(lesson.patch) === digest(source.proposal.patch) &&
      expected === source.proposal.digest &&
      decision?.decision === "approved" &&
      decision.digest === expected &&
      source.verification.baseline.some((c) => !c.passed) &&
      source.verification.candidate.length > 0 &&
      source.verification.candidate.every((c) => c.passed) &&
      (source.mode === "simulation" ||
        (!!source.verification.live?.length &&
          source.verification.live.every((c) => c.passed)))
    );
  }
  review(companyId: string, id: string, action: "promote" | "retire") {
    const company = this.company(companyId),
      lesson = this.store.get<Lesson>("lessons", id, companyId);
    if (!lesson)
      throw new DomainError(404, "Lesson not found in this company.");
    if (action === "promote") {
      if (lesson.status !== "candidate")
        throw new DomainError(409, "Only candidate lessons can be promoted.");
      if (!this.validLesson(lesson, company))
        throw new DomainError(
          409,
          "Lesson provenance, runtime, or verification is invalid.",
        );
      this.store.transaction(() => {
        for (const old of this.store
          .list<Lesson>("lessons", companyId)
          .filter(
            (l) =>
              l.scenario === lesson.scenario &&
              l.runtime === lesson.runtime &&
              l.status === "active",
          )) {
          old.status = "retired";
          this.store.saveLesson(old);
        }
        lesson.status = "active";
        this.store.saveLesson(lesson);
        this.store.audit(
          companyId,
          "lesson.promoted",
          "Operator reviewed and activated a verified lesson.",
          { lessonId: id, version: lesson.version },
        );
      });
    } else {
      if (lesson.status === "retired")
        throw new DomainError(409, "This lesson is already retired.");
      lesson.status = "retired";
      this.store.saveLesson(lesson);
      this.store.audit(
        companyId,
        "lesson.retired",
        "Lesson retired; evidence and history were retained.",
        { lessonId: id },
      );
    }
    return lesson;
  }
  async idle() {
    await Promise.all(this.tasks.values());
  }
}
