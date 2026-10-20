import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import request from "supertest";
import { Store } from "../src/server/store.js";
import { Engine, DomainError } from "../src/server/engine.js";
import { createApp } from "../src/server/app.js";
import {
  OpsStorage,
  redact,
  safeSourcePath,
  sha256,
} from "../src/server/operations/storage.js";
import { Operations } from "../src/server/operations/service.js";
import { Workforce, extractJson } from "../src/server/operations/workforce.js";
import { GitLab, parseGitLabUrl } from "../src/server/operations/gitlab.js";
import {
  parseGitHubUrl,
  githubLogLocation,
  githubTransport,
} from "../src/server/operations/github.js";
import {
  isPublicAddress,
  publicHttpsUrl,
} from "../src/server/operations/network.js";
import {
  GitLabBackup,
  openSnapshot,
  sealSnapshot,
} from "../src/server/operations/backup.js";
import type {
  AgentTask,
  EvidenceFile,
  OpsIncident,
  RepairPlan,
  Repository,
} from "../src/shared/operations.js";
const baseSha = "a".repeat(40),
  blobSha = "b".repeat(40),
  repairSha = "c".repeat(40),
  mergeSha = "d".repeat(40);
const url = "https://gitlab.com/demo/team/store";

test("credential filtering preserves FastAPI header type annotations through evidence capture", () => {
  const source =
    'def demo_fault(body: FaultInput, authorization: str = Header(default="")):\n    pass\n';
  assert.equal(redact(source), source);
  assert.equal(
    redact(JSON.stringify({ path: "app.py", content: source })),
    JSON.stringify({ path: "app.py", content: source }),
  );
  for (const secret of [
    "authorization: Bearer private-token-value",
    "authorization=private-token-value",
    "password: str",
    "authorization: str",
    'authorization: arbitrary = Header(default="")',
    "api_key=ghp_disposablecredential123456789",
  ]) {
    assert.notEqual(redact(secret), secret);
    assert.match(redact(secret), /\[REDACTED\]/);
  }
});

test("Actions log redirects reject credentials, private networks and unexpected hosts", async (t) => {
  for (const url of [
    "http://logs.blob.core.windows.net/file",
    "https://token@logs.blob.core.windows.net/file",
    "https://127.0.0.1/file",
    "https://logs.blob.core.windows.net.attacker.example/file",
    "https://attacker.example/file",
  ])
    assert.throws(() => githubLogLocation(url));
  assert.equal(
    githubLogLocation(
      "https://results.blob.core.windows.net/logs/file?sig=opaque",
    ),
    "https://results.blob.core.windows.net/logs/file?sig=opaque",
  );
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: any) => {
    requests++;
    assert.equal(options.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/steal" },
    });
  });
  await assert.rejects(
    githubTransport("private-repo-token")(
      "/repos/demo/store/actions/jobs/123/logs",
      "GET",
      undefined,
      true,
    ),
    /unexpected log destination/,
  );
  assert.equal(
    requests,
    1,
    "No credential-bearing request follows the redirect",
  );
});
function setup(
  options: {
    protectedEdit?: boolean | string;
    supervised?: boolean;
    delayedMerge?: boolean;
  } = {},
) {
  const store = new Store(":memory:"),
    db = new OpsStorage(store, "operator-secret");
  for (const id of ["alpha", "beta"])
    store.saveCompany({
      id,
      name: id,
      stack: "JavaScript",
      runtime: "Node.js",
      connector: "simulation",
      revision: 1,
      createdAt: new Date().toISOString(),
    });
  const policy =
    "staging_branch: main\nstaging_environment: staging\nproduction_requires_approval: true\nmax_repair_attempts: 3\n";
  const goals: string[] = [];
  let head = baseSha,
    status = "failed",
    merged = false,
    liveSha = baseSha,
    taskStatus = "FINISHED",
    launches = 0,
    commits = 0,
    merges = 0,
    stalePolicy = false;
  const sources: Record<string, string> = {
    "lib/price.js": "export const fee = x => x > 50 ? 0 : 8;\n",
    "test/price.test.js": "assert.equal(fee(50), 0);\n",
    ".maya.yml": policy,
    ".gitlab-ci.yml": "test:\n  script: npm test\n",
    "package.json": '{"type":"module"}',
    ".env.example": "PAYMENT_SECRET=do-not-retain-this-value\n",
  };
  if (typeof options.protectedEdit === "string")
    sources[options.protectedEdit] = "# Existing company build configuration\n";
  const sourceBlob = (path: string) =>
    path === ".maya.yml" ? (stalePolicy ? "e" : "f").repeat(40) : blobSha;
  const plan: RepairPlan = {
    title: "Restore inclusive threshold",
    category: "ci",
    rootCause:
      "The boundary is exclusive but the test and source contract require inclusive comparison.",
    confidence: "high",
    evidenceIds: [],
    files: [
      {
        path:
          typeof options.protectedEdit === "string"
            ? options.protectedEdit
            : options.protectedEdit
              ? "test/price.test.js"
              : "lib/price.js",
        originalSha: blobSha,
        content: "export const fee = x => x >= 50 ? 0 : 8;\n",
        rationale: "Restore inclusive threshold without weakening any test.",
      },
    ],
    verification: ["npm test"],
    risks: ["CI has not run yet."],
    questions: [],
  };
  const api = async (
    path: string,
    method = "GET",
    body?: any,
    raw?: boolean,
  ): Promise<any> => {
    const suffix = path.replace(/^projects\/[^/]+/, "");
    const route = suffix.split("?")[0];
    if (route === "")
      return {
        id: 12,
        default_branch: "main",
        visibility: "public",
        description: "Demo store",
      };
    if (route === "/languages") return { JavaScript: 100 };
    if (route.startsWith("/repository/commits/") && method === "GET")
      return { id: head };
    if (route === "/repository/tree")
      return Object.keys(sources).map((path) => ({
        path,
        id: sourceBlob(path),
        type: "blob",
      }));
    if (route.startsWith("/repository/files/")) {
      const path = decodeURIComponent(route.slice(18));
      if (!sources[path]) throw new DomainError(404, "Not found");
      return {
        blob_id: sourceBlob(path),
        encoding: "base64",
        content: Buffer.from(sources[path]).toString("base64"),
        size: sources[path].length,
      };
    }
    if (route === "/pages") return { url: "https://demo.gitlab.io" };
    if (route === "/pipelines") {
      const sha = new URLSearchParams(suffix.split("?")[1]).get("sha");
      return [
        {
          id: sha === repairSha ? 2 : sha === mergeSha ? 3 : 1,
          iid: 1,
          ref: "main",
          sha: sha || head,
          status: sha ? status : "failed",
          source: "push",
          web_url: `${url}/-/pipelines/1`,
        },
      ];
    }
    if (/^\/pipelines\/\d+\/jobs$/.test(route))
      return [
        {
          id: 10,
          name: "tests",
          status: status === "success" ? "success" : "failed",
          web_url: `${url}/-/jobs/10`,
        },
      ];
    if (route === "/jobs/10/trace")
      return "Expected fee(50) = 0, received 8, lib/price.js\n";
    if (route === "/repository/commits" && method === "POST") {
      commits++;
      return { id: repairSha, parent_ids: [body.start_sha || repairSha] };
    }
    if (route === "/merge_requests" && method === "POST")
      return {
        iid: 1,
        state: "opened",
        target_branch: "main",
        sha: repairSha,
        web_url: `${url}/-/merge_requests/1`,
      };
    if (route === "/merge_requests/1")
      return {
        iid: 1,
        state: merged ? "merged" : "opened",
        target_branch: "main",
        sha: repairSha,
        merge_commit_sha: merged ? mergeSha : null,
        merged_at: new Date().toISOString(),
        web_url: `${url}/-/merge_requests/1`,
        merge_status: "can_be_merged",
      };
    if (route === "/merge_requests/1/merge") {
      merges++;
      if (options.delayedMerge)
        throw new DOMException("Timed out", "TimeoutError");
      merged = true;
      head = mergeSha;
      return { state: "merged", merge_commit_sha: mergeSha };
    }
    if (route === "/deployments")
      return merged
        ? [
            {
              id: 9,
              sha: mergeSha,
              environment: {
                name: "staging",
                external_url: "https://demo.gitlab.io",
              },
            },
          ]
        : [];
    if (route === "/deployments/9")
      return {
        status: "success",
        environment: {
          name: "staging",
          external_url: "https://demo.gitlab.io",
        },
        updated_at: new Date().toISOString(),
      };
    throw new Error(`Unhandled fake GitLab request: ${method} ${path}`);
  };
  const workforce = new Workforce(
    db,
    { projectId: "123", projectPath: "demo/maya", consumerId: "456" },
    async (path, body: any) => {
      if (path !== "graphql") {
        launches++;
        goals.push(body.goal);
        return { id: launches, workload: { id: 8 }, status: "created" };
      }
      return {
        data: {
          duoWorkflowWorkflows: {
            nodes: [
              {
                id: body.variables.workflowId,
                status: taskStatus,
                latestCheckpoint: {
                  errors: [],
                  duoMessages: [
                    {
                      componentName: "orchestrator",
                      messageType: "agent",
                      content: goals.at(-1)?.includes('"purpose":"reflect"')
                        ? JSON.stringify({
                            title: "Inclusive thresholds",
                            symptoms: "Exact boundary failed",
                            rootCause:
                              "Exclusive comparison violated the captured assertion",
                            guidance:
                              "Check the exact boundary and both adjacent values against the advertised contract.",
                          })
                        : JSON.stringify(plan),
                    },
                  ],
                },
              },
            ],
          },
        },
      };
    },
  );
  const ops = new Operations(db, {
    workforce,
    gitlabApi: api,
    probe: async () => ({
      status: 200,
      text: JSON.stringify({ commit: liveSha }),
    }),
  });
  const app = createApp(new Engine(store, undefined, 0), {
    accessToken: "operator",
    operations: ops,
  });
  return {
    store,
    db,
    ops,
    app,
    plan,
    workforce,
    api,
    goals,
    get counts() {
      return { launches, commits, merges };
    },
    set head(value: string) {
      head = value;
    },
    set status(value: string) {
      status = value;
    },
    set liveSha(value: string) {
      liveSha = value;
    },
    set taskStatus(value: string) {
      taskStatus = value;
    },
    set stalePolicy(value: boolean) {
      stalePolicy = value;
    },
    completeDelayedMerge() {
      merged = true;
      head = mergeSha;
    },
  };
}
async function onboard(s: ReturnType<typeof setup>) {
  return (await s.ops.onboard({ url, companyId: "alpha", shareWithDuo: true }))
    .repository;
}
async function proposed(s: ReturnType<typeof setup>) {
  const repo = await onboard(s);
  await s.ops.observe("alpha");
  const incident = s.db
    .list<OpsIncident>("incident", "alpha")
    .find((i) => i.category === "ci")!;
  const work = await s.ops.investigate("alpha", incident.id);
  await s.ops.refreshTask("alpha", work.taskId!);
  return {
    repo,
    incident: s.db.get<OpsIncident>("incident", "alpha", incident.id),
  };
}

test("GitLab launch limits are enforced locally and definitive HTTP rejection is not an uncertain launch", async () => {
  const s = setup();
  try {
    const repo = await onboard(s);
    await s.ops.observe("alpha");
    const incident = s.db.list<OpsIncident>("incident", "alpha")[0];
    const evidence = s.db.evidence({
      companyId: "alpha",
      projectId: repo.id,
      incidentId: incident.id,
      kind: "log",
      name: "large.log",
      content: "x".repeat(60_000),
    });
    await assert.rejects(
      () => s.workforce.start(repo, incident, [evidence], []),
      /launch prompt limit/,
    );
    assert.equal(s.counts.launches, 0);
    assert.equal(s.db.list("task", "alpha").length, 0);
    const rejecting = new Workforce(
      s.db,
      { projectId: "123", projectPath: "demo/maya", consumerId: "456" },
      async () => {
        throw new Error("GitLab request failed (HTTP 422).");
      },
    );
    const rejected = await rejecting.start(repo, incident, [], []);
    assert.equal(rejected.state, "failed");
    assert.match(rejected.error!, /HTTP 422/);
    const uncertain = new Workforce(
      s.db,
      { projectId: "123", projectPath: "demo/maya", consumerId: "456" },
      async () => {
        throw new DOMException("timeout", "TimeoutError");
      },
    );
    assert.equal(
      (await uncertain.start(repo, incident, [], [])).state,
      "unknown",
    );
  } finally {
    s.store.db.close();
  }
});

test("a fresh investigation budgets only the latest log capture while preserving historical evidence", async () => {
  const s = setup();
  try {
    const repo = await onboard(s);
    await s.ops.observe("alpha");
    const incident = s.db.list<OpsIncident>("incident", "alpha")[0];
    const historical = s.db.evidence({
      companyId: "alpha",
      projectId: repo.id,
      incidentId: incident.id,
      kind: "log",
      name: "tests.log",
      content: "old-capture ".repeat(2000),
      commitSha: baseSha,
    });
    incident.evidenceIds.push(historical.id);
    s.db.save("incident", incident);
    await s.ops.investigate("alpha", incident.id);
    const context = JSON.parse(
      s.goals[0]
        .split("<untrusted_repository_evidence>\n")[1]
        .split("\n</untrusted_repository_evidence>")[0],
    );
    const logs = context.evidence.filter((e: any) => e.kind === "log");
    assert.equal(logs.length, 1);
    assert.match(logs[0].content, /Expected fee/);
    assert.notEqual(logs[0].id, historical.id);
    assert.ok(context.evidence.some((e: any) => e.name === "lib/price.js"));
    assert.equal(
      s.db.get<EvidenceFile>("evidence", "alpha", historical.id).content,
      historical.content,
    );
  } finally {
    s.store.db.close();
  }
});

test("unconfirmed Duo launches reconcile by exact evidence digest without another launch and require an explicit delayed recovery decision", async () => {
  const s = setup();
  try {
    let nodes: any[] = [];
    let searches = 0;
    const workforce = new Workforce(
      s.db,
      { projectId: "123", projectPath: "demo/maya", consumerId: "456" },
      async (path, body: any) => {
        assert.equal(
          path,
          "graphql",
          "Reconciliation must not call the launch endpoint",
        );
        assert.equal(body.variables.search, "a".repeat(64));
        searches++;
        return { data: { duoWorkflowWorkflows: { nodes } } };
      },
    );
    const original = {
      id: "uncertain",
      companyId: "alpha",
      projectId: "repo",
      incidentId: "incident",
      purpose: "investigate",
      state: "unknown",
      evidenceDigest: "a".repeat(64),
      evidenceIds: [],
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as AgentTask;
    s.db.save("task", original);
    const missing = await workforce.reconcileLaunch({ ...original }, false);
    assert.equal(missing.state, "unknown");
    await assert.rejects(
      () => workforce.reconcileLaunch({ ...original }, true),
      /two minutes/,
    );
    nodes = [
      {
        id: "gid://gitlab/Ai::DuoWorkflows::Workflow/999",
        goal: `The evidence SHA-256 is ${original.evidenceDigest}.`,
        status: "RUNNING",
      },
    ];
    const recovered = await workforce.reconcileLaunch({ ...original }, false);
    assert.equal(recovered.sessionId, "999");
    assert.equal(recovered.state, "running");
    await assert.rejects(
      () => workforce.reconcileLaunch({ ...original }, true),
      /state changed/,
    );
    nodes = [];
    original.createdAt = new Date(Date.now() - 180_000).toISOString();
    s.db.save("task", original);
    const released = await workforce.reconcileLaunch({ ...original }, true);
    assert.equal(released.state, "failed");
    assert.equal(released.sessionId, undefined);
    assert.ok(searches >= 4);
    assert.equal(s.counts.launches, 0);
  } finally {
    s.store.db.close();
  }
});

test("repository discovery reads real configuration, retains env names only and starts without write authorisation", async () => {
  const s = setup();
  try {
    const repo = await onboard(s);
    assert.equal(repo.provider, "gitlab");
    assert.equal(repo.workflows[0].jobs[0], "test");
    assert.equal(repo.stagingPolicy?.branch, "main");
    assert.equal(repo.automationMode, "assisted");
    assert.ok(repo.envNames.includes("PAYMENT_SECRET"));
    assert.ok(
      !JSON.stringify(s.ops.snapshot("alpha")).includes("do-not-retain"),
    );
    assert.equal(s.counts.commits, 0);
    assert.throws(() => s.db.get("repository", "beta", repo.id));
  } finally {
    s.store.db.close();
  }
});

test("source access, authentication and scoped evidence prevent leaking tokens across company boundaries", async () => {
  const s = setup();
  try {
    const repo = await onboard(s);
    s.db.setCredential("alpha", "secret", { token: "very-private-value" });
    const evidence = s.db.evidence({
      companyId: "alpha",
      projectId: repo.id,
      kind: "log",
      name: "job.log",
      content:
        "Authorization=Bearer-abcdef\npassword=hidden\nglpat-abcdefghijklmnop",
    });
    assert.ok(!evidence.content.includes("hidden"));
    assert.ok(!evidence.content.includes("abcdefghijklmnop"));
    const stored = s.store.db
      .prepare("SELECT data FROM ops_credentials")
      .get()!;
    assert.ok(!String(stored.data).includes("very-private-value"));
    assert.deepEqual(s.db.credential("alpha", "secret"), {
      token: "very-private-value",
    });
    assert.equal(s.db.credential("beta", "secret"), undefined);
    assert.equal(
      (await request(s.app).get("/api/ops/alpha/snapshot")).status,
      401,
    );
    assert.equal(
      (
        await request(s.app)
          .get(`/api/ops/beta/evidence/${evidence.id}`)
          .auth("operator", { type: "bearer" })
      ).status,
      404,
    );
    assert.equal(
      (
        await request(s.app)
          .get("/api/ops/alpha/export")
          .auth("operator", { type: "bearer" })
      ).text.includes("very-private-value"),
      false,
    );
  } finally {
    s.store.db.close();
  }
});

test("signed GitLab pipeline ingress is scoped, body-authenticated and durably deduplicated", async () => {
  const s = setup();
  try {
    const repo = await onboard(s);
    const secret = s.ops.webhookSecret("alpha");
    const payload = {
      project: { id: repo.remoteProjectId },
      object_attributes: {
        id: 8,
        iid: 8,
        status: "failed",
        ref: "main",
        sha: baseSha,
      },
    };
    const endpoint = "/hooks/alpha/gitlab";
    assert.equal(
      (await request(s.app).post(endpoint).send(payload)).status,
      403,
    );
    const one = await request(s.app)
      .post(endpoint)
      .set("X-Gitlab-Token", secret)
      .set("X-Gitlab-Event", "Pipeline Hook")
      .set("X-Gitlab-Event-UUID", "delivery-8")
      .send(payload);
    assert.equal(one.status, 202);
    assert.equal(
      (
        await request(s.app)
          .post(endpoint)
          .set("X-Gitlab-Token", secret)
          .set("X-Gitlab-Event", "Pipeline Hook")
          .set("X-Gitlab-Event-UUID", "delivery-8")
          .send(payload)
      ).body.duplicate,
      true,
    );
    assert.equal(
      (
        await request(s.app)
          .post(endpoint)
          .set("X-Gitlab-Token", secret)
          .send({ ...payload, project: { id: 999 } })
      ).status,
      403,
    );
    assert.equal(s.db.list("incident", "alpha").length, 1);
  } finally {
    s.store.db.close();
  }
});

test("proposal validation rejects unobserved source, foreign evidence, no-op changes and duplicate paths", async () => {
  const s = setup();
  try {
    const repo = await onboard(s);
    const task = {
      state: "complete",
      report: JSON.stringify(s.plan),
      evidenceIds: [],
    } as unknown as AgentTask;
    const sources = [{ path: "lib/price.js", sha: blobSha, content: "old" }];
    assert.equal(s.workforce.validatePlan(task, repo, sources).files.length, 1);
    s.plan.files[0].originalSha = "e".repeat(40);
    assert.throws(
      () =>
        s.workforce.validatePlan(
          { ...task, report: JSON.stringify(s.plan) },
          repo,
          sources,
        ),
      /captured source SHA/,
    );
    s.plan.files[0].originalSha = blobSha;
    s.plan.evidenceIds = ["outside-task"];
    assert.throws(
      () =>
        s.workforce.validatePlan(
          { ...task, report: JSON.stringify(s.plan) },
          repo,
          sources,
        ),
      /outside this task/,
    );
    s.plan.evidenceIds = [];
    s.plan.files.push(s.plan.files[0]);
    assert.throws(
      () =>
        s.workforce.validatePlan(
          { ...task, report: JSON.stringify(s.plan) },
          repo,
          sources,
        ),
      /duplicate/,
    );
    assert.throws(() => extractJson("No actual JSON report"));
    assert.deepEqual(extractJson('Report: ```json\n{"safe":true}\n```'), {
      safe: true,
    });
  } finally {
    s.store.db.close();
  }
});

test("Duo cannot authorise writes; publication is digest-bound and concurrent approvals create only one repair", async () => {
  const s = setup();
  try {
    const { incident } = await proposed(s);
    assert.equal(incident.status, "awaiting_approval");
    assert.equal(s.counts.commits, 0);
    await assert.rejects(
      () =>
        s.ops.publish("alpha", incident.id, "0".repeat(64), "invalid approval"),
      /does not match/,
    );
    const results = await Promise.allSettled([
      s.ops.publish(
        "alpha",
        incident.id,
        incident.planDigest!,
        "Reviewed exact replacement",
      ),
      s.ops.publish(
        "alpha",
        incident.id,
        incident.planDigest!,
        "Reviewed exact replacement",
      ),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(s.counts.commits, 1);
    assert.equal(
      s.db.get<OpsIncident>("incident", "alpha", incident.id).status,
      "pr_open",
    );
  } finally {
    s.store.db.close();
  }
});

test("a changed default branch invalidates approval before any source write", async () => {
  const s = setup();
  try {
    const { incident } = await proposed(s);
    s.head = "e".repeat(40);
    await assert.rejects(
      () =>
        s.ops.publish(
          "alpha",
          incident.id,
          incident.planDigest!,
          "Reviewed change",
        ),
      /default branch changed/,
    );
    assert.equal(s.counts.commits, 0);
  } finally {
    s.store.db.close();
  }
});

test("green repair CI cannot resolve delivery; release requires merge, passing release CI and exact live revision", async () => {
  const s = setup();
  try {
    const { incident } = await proposed(s);
    await s.ops.publish(
      "alpha",
      incident.id,
      incident.planDigest!,
      "Review exact source repair",
    );
    await assert.rejects(
      () =>
        s.ops.merge(
          "alpha",
          incident.id,
          incident.planDigest!,
          "Merge staging",
        ),
      /passing exact-commit/,
    );
    s.status = "success";
    const passing = await s.ops.refreshChecks("alpha", incident.id);
    assert.equal(passing.status, "pr_open");
    const before = s.db.list("evidence", "alpha").length;
    await s.ops.refreshChecks("alpha", incident.id);
    assert.equal(s.db.list("evidence", "alpha").length, before);
    await s.ops.merge(
      "alpha",
      incident.id,
      incident.planDigest!,
      "Approve staging after CI",
    );
    const stale = await s.ops.refreshChecks("alpha", incident.id);
    assert.equal(stale.status, "verifying");
    assert.equal(stale.deploymentProbe?.passed, false);
    s.liveSha = mergeSha;
    const verified = await s.ops.refreshChecks("alpha", incident.id);
    assert.equal(verified.status, "resolved");
    assert.equal(verified.deploymentProbe?.expectedSha, mergeSha);
    const evidenceCount = s.db.list("evidence", "alpha").length,
      steps = verified.steps.length;
    await s.ops.refreshChecks("alpha", incident.id);
    assert.equal(s.db.list("evidence", "alpha").length, evidenceCount);
    assert.equal(
      s.db.get<OpsIncident>("incident", "alpha", incident.id).steps.length,
      steps,
    );
  } finally {
    s.store.db.close();
  }
});

test("a timed-out merge is reconciled by observer reads, including delayed provider completion, without another merge write", async () => {
  const s = setup({ delayedMerge: true });
  try {
    const { incident } = await proposed(s);
    await s.ops.publish(
      "alpha",
      incident.id,
      incident.planDigest!,
      "Reviewed exact source repair",
    );
    s.status = "success";
    await s.ops.settings("alpha", { automationMode: "supervised" });
    const uncertain = await s.ops.merge(
      "alpha",
      incident.id,
      incident.planDigest!,
      "Approve staging after exact CI",
    );
    assert.equal(uncertain.status, "unknown");
    assert.match(uncertain.steps.at(-1)!.detail, /timed out/);
    await s.ops.observe("alpha");
    assert.equal(
      s.db.get<OpsIncident>("incident", "alpha", incident.id).status,
      "unknown",
    );
    assert.equal(s.counts.merges, 1);
    await assert.rejects(() =>
      s.ops.merge(
        "alpha",
        incident.id,
        incident.planDigest!,
        "Do not duplicate the uncertain request",
      ),
    );
    s.completeDelayedMerge();
    s.liveSha = mergeSha;
    await s.ops.observe("alpha");
    const verified = s.db.get<OpsIncident>("incident", "alpha", incident.id);
    assert.equal(verified.status, "resolved");
    assert.equal(verified.merge?.sha, mergeSha);
    assert.equal(verified.deploymentProbe?.passed, true);
    assert.equal(s.counts.merges, 1);
    assert.ok(
      s.db
        .list<AgentTask>("task", "alpha")
        .some((t) => t.purpose === "reflect"),
    );
  } finally {
    s.store.db.close();
  }
});

test("supervised Python repairs cannot rewrite dependency or deployment configuration without review", async () => {
  for (const path of [
    "pyproject.toml",
    "requirements.txt",
    "Dockerfile",
    "render.yaml",
  ]) {
    const s = setup({ protectedEdit: path });
    try {
      await onboard(s);
      await s.ops.settings("alpha", { automationMode: "supervised" });
      const incident = s.ops.report("alpha", {
        title: "Build configuration proposal",
        summary: "The proposed fix changes a company build or deployment file",
        category: "ci",
        severity: "high",
      });
      const work = await s.ops.investigate("alpha", incident.id);
      await s.ops.refreshTask("alpha", work.taskId!);
      assert.equal(
        s.db.get<OpsIncident>("incident", "alpha", incident.id).status,
        "awaiting_approval",
        path,
      );
      assert.equal(s.counts.commits, 0, path);
    } finally {
      s.store.db.close();
    }
  }
});

test("supervised staging protects tests and stops when its repository policy changes", async () => {
  const s = setup({ protectedEdit: true });
  try {
    await onboard(s);
    await s.ops.settings("alpha", { automationMode: "supervised" });
    const incident = s.ops.report("alpha", {
      title: "Failing test",
      summary: "The pricing threshold test is failing",
      category: "ci",
      severity: "high",
    });
    const work = await s.ops.investigate("alpha", incident.id);
    await s.ops.refreshTask("alpha", work.taskId!);
    assert.equal(
      s.db.get<OpsIncident>("incident", "alpha", incident.id).status,
      "awaiting_approval",
    );
    assert.equal(s.counts.commits, 0);
  } finally {
    s.store.db.close();
  }
  const t = setup();
  try {
    await onboard(t);
    await t.ops.settings("alpha", { automationMode: "supervised" });
    t.stalePolicy = true;
    const incident = t.ops.report("alpha", {
      title: "Pricing failure",
      summary: "A boundary mismatch occurred",
      category: "ci",
      severity: "high",
    });
    const work = await t.ops.investigate("alpha", incident.id);
    await t.ops.refreshTask("alpha", work.taskId!);
    assert.equal(t.counts.commits, 0);
    assert.equal(t.ops.repository("alpha").automationMode, "assisted");
    assert.match(
      t.db.get<OpsIncident>("incident", "alpha", incident.id).error!,
      /policy changed/,
    );
  } finally {
    t.store.db.close();
  }
});

test("unresolved repairs cannot become active lessons and public imports invalidate all prior authorisation", async () => {
  const s = setup();
  try {
    const { incident } = await proposed(s);
    await assert.rejects(
      () => s.ops.reflect("alpha", incident.id),
      /no published PR/,
    );
    const exported = (
      await request(s.app)
        .get("/api/ops/alpha/export")
        .auth("operator", { type: "bearer" })
    ).body;
    const t = setup();
    try {
      const restored = await request(t.app)
        .post("/api/ops/restore")
        .auth("operator", { type: "bearer" })
        .send(exported);
      assert.equal(restored.status, 201);
      const repo = t.ops.repository("alpha");
      assert.equal(repo.monitoring, false);
      assert.equal(repo.shareWithDuo, false);
      assert.equal(repo.automationMode, "assisted");
      assert.equal(
        t.db.get<OpsIncident>("incident", "alpha", incident.id).planDigest,
        undefined,
      );
      assert.equal(t.counts.commits, 0);
    } finally {
      t.store.db.close();
    }
  } finally {
    s.store.db.close();
  }
});

test("corrector receives original logs and test source with the actual merge-to-deployment link; lessons still need review", async () => {
  const s = setup();
  try {
    const { incident } = await proposed(s);
    await s.ops.publish(
      "alpha",
      incident.id,
      incident.planDigest!,
      "Review source repair",
    );
    s.status = "success";
    await s.ops.merge(
      "alpha",
      incident.id,
      incident.planDigest!,
      "Approve staging",
    );
    s.liveSha = mergeSha;
    const work = await s.ops.reflect("alpha", incident.id);
    const supplied = work.evidenceIds.map((id) =>
      s.db.get<EvidenceFile>("evidence", "alpha", id),
    );
    assert.ok(supplied.some((file) => file.kind === "log"));
    assert.ok(supplied.some((file) => file.name === "test/price.test.js"));
    const provenance = JSON.parse(
      supplied.find((file) => file.name === "merged-repair-provenance.json")!
        .content,
    );
    assert.equal(provenance.mergeRequest.merge_commit_sha, mergeSha);
    assert.equal(provenance.repairCommit, repairSha);
    assert.equal(provenance.liveProbe.passed, true);
    await s.ops.refreshTask("alpha", work.id);
    const lesson = s.db.list<any>("memory", "alpha")[0];
    assert.equal(lesson.status, "candidate");
    assert.equal(
      s.ops.reviewLesson(
        "alpha",
        lesson.id,
        "promote",
        "Reviewed actual boundary source, original failure and exact deployed revision",
      ).status,
      "active",
    );
    s.ops.reviewLesson(
      "alpha",
      lesson.id,
      "retire",
      "Corrector needs more context",
    );
    const fresh = await s.ops.reflect("alpha", incident.id);
    assert.notEqual(fresh.id, work.id);
  } finally {
    s.store.db.close();
  }
});

test("encrypted checkpoints authenticate content, preserve scope and restore evidence without plaintext secrets", async () => {
  const s = setup(),
    t = setup();
  try {
    await onboard(s);
    s.db.setCredential("alpha", "private", { token: "retained-private-token" });
    let saved: any;
    const fake = async (path: string, method = "GET", body?: any) => {
      if (path.includes("repository/files")) {
        if (!saved) throw new DomainError(404, "No file");
        return {
          content: Buffer.from(saved).toString("base64"),
          last_commit_id: repairSha,
        };
      }
      if (method === "POST") {
        saved = body.actions[0].content;
        return { id: repairSha };
      }
      return { default_branch: "main" };
    };
    const backup = new GitLabBackup(s.db, fake, "12", "stable-key");
    await backup.restore();
    await backup.save();
    assert.ok(backup.lastSavedAt);
    assert.ok(!saved.includes("retained-private-token"));
    assert.ok(!saved.includes("lib/price.js"));
    assert.throws(() => openSnapshot(saved, "wrong-key"));
    const envelope = JSON.parse(saved);
    envelope.tag = Buffer.alloc(16).toString("base64");
    assert.throws(() => openSnapshot(JSON.stringify(envelope), "stable-key"));
    const restore = new GitLabBackup(t.db, fake, "12", "stable-key");
    await restore.restore();
    assert.equal(
      t.ops.repository("alpha").fullName,
      s.ops.repository("alpha").fullName,
    );
    assert.deepEqual(t.db.credential("alpha", "private"), {
      token: "retained-private-token",
    });
    assert.equal(t.db.credential("beta", "private"), undefined);
    const roundtrip = openSnapshot(sealSnapshot({ hello: true }, "key"), "key");
    assert.equal(roundtrip.hello, true);
  } finally {
    s.store.db.close();
    t.store.db.close();
  }
});

test("periodic checkpoints reconcile lost acknowledgements without duplicate writes or stealing ownership", async () => {
  const s = setup(),
    incoming = setup();
  try {
    await onboard(s);
    let saved = "",
      revision = 0,
      writes = 0,
      loseReply = true,
      denyWrite = false;
    const api = async (path: string, method = "GET", body?: any) => {
      if (path.includes("repository/files")) {
        if (!saved) throw new DomainError(404, "No checkpoint");
        return {
          content: Buffer.from(saved).toString("base64"),
          last_commit_id: String(revision),
        };
      }
      if (method === "POST") {
        writes++;
        if (denyWrite) throw new Error("Write denied before commit");
        assert.equal(
          body.actions[0].last_commit_id,
          saved ? String(revision) : undefined,
        );
        saved = body.actions[0].content;
        revision++;
        if (loseReply) {
          loseReply = false;
          throw new Error("Acknowledgement lost after commit");
        }
        return { id: String(revision) };
      }
      return { default_branch: "main" };
    };
    const backup = new GitLabBackup(s.db, api, "12", "stable-key");
    await backup.restore();
    await backup.save();
    assert.equal(writes, 1);
    assert.equal(backup.error, undefined);
    assert.ok(backup.lastSavedAt);
    await backup.save();
    assert.equal(
      writes,
      1,
      "Reconciliation does not resubmit the committed snapshot",
    );
    s.db.evidence({
      companyId: "alpha",
      projectId: s.ops.repository("alpha").id,
      kind: "log",
      name: "after-loss.log",
      content: "A later observation",
    });
    await backup.save();
    assert.equal(
      writes,
      2,
      "The next changed snapshot uses the reconciled CAS identity",
    );
    assert.equal(backup.error, undefined);
    s.db.evidence({
      companyId: "alpha",
      projectId: s.ops.repository("alpha").id,
      kind: "log",
      name: "denied.log",
      content: "This observation has not been checkpointed yet",
    });
    denyWrite = true;
    await backup.save();
    assert.ok(
      backup.error,
      "An older owned checkpoint cannot acknowledge unsaved new state",
    );
    denyWrite = false;
    await backup.save();
    assert.equal(backup.error, undefined);
    const active = new GitLabBackup(incoming.db, api, "12", "stable-key");
    await active.restore({ claimWriter: true });
    const claimed = saved;
    s.db.evidence({
      companyId: "alpha",
      projectId: s.ops.repository("alpha").id,
      kind: "log",
      name: "fenced.log",
      content: "An outgoing observation",
    });
    await backup.save();
    assert.ok(backup.error);
    assert.equal(
      saved,
      claimed,
      "Read-only reconciliation cannot take another writer's checkpoint",
    );
  } finally {
    s.store.db.close();
    incoming.store.db.close();
  }
});

test("deployment checkpoint handoff preserves a racing final save and fences the outgoing writer", async () => {
  const old = setup(),
    incoming = setup(),
    reader = setup();
  try {
    await onboard(old);
    let saved = "",
      revision = 0,
      writes = 0;
    let race: (() => Promise<void>) | undefined;
    const api = async (path: string, method = "GET", body?: any) => {
      if (path.includes("repository/files")) {
        if (!saved) throw new DomainError(404, "No checkpoint");
        return {
          content: Buffer.from(saved).toString("base64"),
          last_commit_id: String(revision),
        };
      }
      if (method === "POST") {
        writes++;
        const competingSave = race;
        race = undefined;
        await competingSave?.();
        assert.equal(
          body.actions[0].last_commit_id,
          saved ? String(revision) : undefined,
          "Provider compare-and-swap",
        );
        saved = body.actions[0].content;
        return { id: String(++revision) };
      }
      return { default_branch: "main" };
    };
    const outgoing = new GitLabBackup(old.db, api, "12", "stable-key");
    await outgoing.restore();
    await outgoing.save();
    race = async () => {
      old.db.evidence({
        companyId: "alpha",
        projectId: old.ops.repository("alpha").id,
        kind: "log",
        name: "last-outgoing.log",
        content: "Final observation before handoff",
      });
      await outgoing.save();
    };
    const active = new GitLabBackup(incoming.db, api, "12", "stable-key");
    await active.restore({ claimWriter: true });
    assert.ok(
      incoming.db
        .list<EvidenceFile>("evidence", "alpha")
        .some((e) => e.name === "last-outgoing.log"),
      "Incoming process restores the newer state after a claim race",
    );
    const claimed = saved;
    old.db.evidence({
      companyId: "alpha",
      projectId: old.ops.repository("alpha").id,
      kind: "log",
      name: "stale.log",
      content: "This outgoing observation must not overwrite the new process",
    });
    await outgoing.save();
    assert.ok(outgoing.error);
    assert.equal(
      saved,
      claimed,
      "Outgoing shutdown cannot overwrite the incoming process",
    );
    const repo = incoming.ops.repository("alpha");
    repo.monitoring = false;
    incoming.db.save("repository", repo);
    await active.save();
    assert.equal(active.error, undefined);
    const beforeRead = writes;
    await new GitLabBackup(reader.db, api, "12", "stable-key").restore();
    assert.equal(
      writes,
      beforeRead,
      "Evidence inspection remains read-only by default",
    );
    assert.equal(reader.ops.repository("alpha").monitoring, false);
    assert.equal(
      reader.db
        .list<EvidenceFile>("evidence", "alpha")
        .some((e) => e.name === "stale.log"),
      false,
    );
  } finally {
    old.store.db.close();
    incoming.store.db.close();
    reader.store.db.close();
  }
});

test("checkpoint claim reconciles a lost response once and stops startup on unconfirmed ownership", async () => {
  const source = setup(),
    incoming = setup(),
    blocked = setup();
  try {
    await onboard(source);
    let saved = "",
      revision = 0,
      posts = 0,
      loseReply = false,
      denyWrite = false;
    const api = async (path: string, method = "GET", body?: any) => {
      if (path.includes("repository/files")) {
        if (!saved) throw new DomainError(404, "No checkpoint");
        return {
          content: Buffer.from(saved).toString("base64"),
          last_commit_id: String(revision),
        };
      }
      if (method === "POST") {
        posts++;
        if (denyWrite) throw new Error("Write denied");
        assert.equal(
          body.actions[0].last_commit_id,
          saved ? String(revision) : undefined,
        );
        saved = body.actions[0].content;
        revision++;
        if (loseReply) {
          loseReply = false;
          throw new Error("Response lost after commit");
        }
        return { id: String(revision) };
      }
      return { default_branch: "main" };
    };
    const seed = new GitLabBackup(source.db, api, "12", "stable-key");
    await seed.restore();
    await seed.save();
    loseReply = true;
    const start = posts;
    await new GitLabBackup(incoming.db, api, "12", "stable-key").restore({
      claimWriter: true,
    });
    assert.equal(
      posts,
      start + 1,
      "Lost claim response is reconciled without a second write",
    );
    assert.equal(
      incoming.ops.repository("alpha").fullName,
      source.ops.repository("alpha").fullName,
    );
    denyWrite = true;
    const beforeDenied = posts;
    await assert.rejects(
      () =>
        new GitLabBackup(blocked.db, api, "12", "stable-key").restore({
          claimWriter: true,
        }),
      /ownership could not be confirmed/,
    );
    assert.equal(
      posts,
      beforeDenied + 1,
      "A non-racing failure is not retried",
    );
    assert.equal(
      blocked.db.list("repository", "alpha").length,
      0,
      "No observer-ready state before ownership confirmation",
    );
  } finally {
    source.store.db.close();
    incoming.store.db.close();
    blocked.store.db.close();
  }
});

test("discovery and probes reject credential URLs, private networks and traversal paths", () => {
  for (const value of [
    "not-a-url",
    "http://gitlab.com/demo/store",
    "https://user:pass@gitlab.com/demo/store",
    "https://gitlab.com/demo/store/-/tree/main",
  ])
    assert.throws(() => parseGitLabUrl(value));
  for (const value of [
    "https://github.com/user/repo/tree/main",
    "https://user:pass@github.com/user/repo",
  ])
    assert.throws(() => parseGitHubUrl(value));
  assert.equal(parseGitLabUrl(url).fullName, "demo/team/store");
  for (const value of [
    "http://example.com",
    "https://127.0.0.1",
    "https://10.0.0.2",
    "https://user:pass@example.com",
    "https://host.local",
    "https://example.com:5000",
  ])
    assert.throws(() => publicHttpsUrl(value));
  for (const value of [
    "127.0.0.1",
    "169.254.169.254",
    "10.1.2.3",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "2001:db8::1",
  ])
    assert.equal(isPublicAddress(value), false, value);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  for (const path of [
    "../etc/passwd",
    ".env",
    "nested/.env.production",
    "private.pem",
    ".git/config",
    "a\\b",
  ])
    assert.equal(safeSourcePath(path), false);
  assert.equal(
    redact("https://user:password@example.com"),
    "https://[REDACTED]@example.com",
  );
});
