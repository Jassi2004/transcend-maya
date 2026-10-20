import type express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type {
  EvidenceFile,
  OpsIncident,
  Repository,
} from "../../shared/operations.js";
import { Operations } from "./service.js";
import { DomainError } from "../engine.js";
import { sha256 } from "./storage.js";

const provider = z.enum([
  "github",
  "gitlab",
  "buildkite",
  "jenkins",
  "datadog",
  "incidentio",
  "logrocket",
  "sentry",
  "health",
]);
const reason = z.string().trim().min(3).max(2000);
const empty = z.object({}).strict();
const scope = (req: express.Request) => String(req.params.companyId);
const recordId = (req: express.Request) => String(req.params.id);

export function registerOperationsWebhooks(
  app: express.Express,
  ops: Operations,
) {
  app.post("/hooks/:companyId/:provider", (req, res) => {
    const source = provider.parse(req.params.provider),
      companyId = scope(req),
      repo = ops.repository(companyId);
    const secret = ops.db.credential(companyId, `${repo.id}:webhook`)?.secret;
    if (!secret)
      throw new DomainError(403, "Webhook ingress is not configured.");
    const raw = (req as express.Request & { rawBody?: Buffer }).rawBody;
    if (!raw) throw new DomainError(400, "Raw webhook body is required.");
    const expected =
      source === "gitlab"
        ? secret
        : `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    const supplied =
      req.get(
        source === "gitlab"
          ? "x-gitlab-token"
          : source === "github"
            ? "x-hub-signature-256"
            : "x-maya-signature",
      ) || "";
    const a = Buffer.from(expected),
      b = Buffer.from(supplied);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new DomainError(403, "Webhook signature is invalid.");
    const delivery = (
      req.get("x-gitlab-event-uuid") ||
      req.get("x-github-delivery") ||
      req.get("x-maya-delivery") ||
      sha256(raw.toString())
    ).slice(0, 180);
    const dedupKey = `delivery:${source}:${delivery}`;
    if (ops.db.dedup(companyId, dedupKey))
      return res.json({ ok: true, duplicate: true });
    const result = ops.ingest(
      companyId,
      source,
      req.body,
      delivery,
      req.get("x-github-event") || req.get("x-gitlab-event"),
    );
    ops.db.remember(companyId, dedupKey, "received");
    res.status(202).json(result);
  });
}

export function registerOperationsRoutes(
  app: express.Express,
  ops: Operations,
) {
  const base = "/api/ops/:companyId";
  app.post("/api/ops/onboard", async (req, res) => {
    const input = z
      .object({
        url: z.string().max(300),
        companyId: z.string().max(100).optional(),
        name: z.string().trim().min(2).max(60).optional(),
        token: z.string().min(10).max(500).optional(),
        shareWithDuo: z.boolean().default(false),
        autoInvestigate: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(await ops.onboard(input));
  });
  app.get(`${base}/snapshot`, (req, res) => res.json(ops.snapshot(scope(req))));
  app.post(`${base}/observe`, async (req, res) => {
    empty.parse(req.body);
    res.json(await ops.observe(scope(req)));
  });
  app.post(`${base}/rescan`, async (req, res) => {
    empty.parse(req.body);
    res.json(await ops.rescan(scope(req)));
  });
  app.post(`${base}/settings`, async (req, res) => {
    const input = z
      .object({
        monitoring: z.boolean().optional(),
        shareWithDuo: z.boolean().optional(),
        autoInvestigate: z.boolean().optional(),
        automationMode: z.enum(["assisted", "supervised"]).optional(),
        healthUrl: z.string().max(500).optional(),
        token: z.string().min(10).max(500).optional(),
      })
      .strict()
      .parse(req.body);
    res.json(await ops.settings(scope(req), input));
  });
  app.post(`${base}/incidents`, (req, res) => {
    const input = z
      .object({
        title: z.string().trim().min(3).max(180),
        summary: z.string().trim().min(5).max(20000),
        category: z.enum([
          "ci",
          "security",
          "deployment",
          "runtime",
          "dependency",
        ]),
        severity: z.enum(["low", "medium", "high"]).default("medium"),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(ops.report(scope(req), input));
  });
  app.post(`${base}/incidents/:id/investigate`, async (req, res) => {
    empty.parse(req.body);
    res.status(202).json(await ops.investigate(scope(req), recordId(req)));
  });
  app.post(`${base}/tasks/:id/refresh`, async (req, res) => {
    empty.parse(req.body);
    res.json(await ops.refreshTask(scope(req), recordId(req)));
  });
  app.post(`${base}/incidents/:id/publish`, async (req, res) => {
    const input = z
      .object({ digest: z.string().length(64), reason })
      .strict()
      .parse(req.body);
    res.json(
      await ops.publish(scope(req), recordId(req), input.digest, input.reason),
    );
  });
  app.post(`${base}/incidents/:id/reconcile`, async (req, res) => {
    empty.parse(req.body);
    res.json(await ops.reconcile(scope(req), recordId(req)));
  });
  app.post(`${base}/incidents/:id/checks`, async (req, res) => {
    empty.parse(req.body);
    res.json(await ops.refreshChecks(scope(req), recordId(req)));
  });
  app.post(`${base}/incidents/:id/merge`, async (req, res) => {
    const input = z
      .object({ digest: z.string().length(64), reason })
      .strict()
      .parse(req.body);
    res.json(
      await ops.merge(scope(req), recordId(req), input.digest, input.reason),
    );
  });
  app.post(`${base}/incidents/:id/feedback`, (req, res) => {
    const input = z.object({ text: reason }).strict().parse(req.body);
    res.json(ops.feedback(scope(req), recordId(req), input.text));
  });
  app.post(`${base}/incidents/:id/reject`, (req, res) => {
    const input = z.object({ reason }).strict().parse(req.body);
    res.json(ops.reject(scope(req), recordId(req), input.reason));
  });
  app.post(`${base}/incidents/:id/reflect`, async (req, res) => {
    empty.parse(req.body);
    res.status(202).json(await ops.reflect(scope(req), recordId(req)));
  });
  app.post(`${base}/memory/:id/review`, (req, res) => {
    const input = z
      .object({ action: z.enum(["promote", "retire"]), reason })
      .strict()
      .parse(req.body);
    res.json(
      ops.reviewLesson(scope(req), recordId(req), input.action, input.reason),
    );
  });
  app.post(`${base}/integrations`, async (req, res) => {
    const input = z
      .object({
        provider: z.enum([
          "buildkite",
          "jenkins",
          "datadog",
          "incidentio",
          "logrocket",
          "sentry",
        ]),
        settings: z.record(z.string().max(50), z.string().max(500)),
        credentials: z
          .record(
            z.enum(["token", "username", "apiKey", "appKey"]),
            z.string().max(2000),
          )
          .optional(),
        enabled: z.boolean(),
      })
      .strict()
      .parse(req.body);
    res.json(await ops.configureIntegration(scope(req), input));
  });
  app.post(`${base}/webhook-secret`, (req, res) => {
    const { rotate } = z
      .object({ rotate: z.boolean().default(false) })
      .strict()
      .parse(req.body);
    res.json({ secret: ops.webhookSecret(scope(req), rotate) });
  });
  app.post(`${base}/webhook-install`, async (req, res) => {
    const { baseUrl } = z
      .object({ baseUrl: z.string().url().max(300) })
      .strict()
      .parse(req.body);
    res.json(await ops.installWebhook(scope(req), baseUrl));
  });
  app.get(`${base}/evidence/:id`, (req, res) =>
    res.json(ops.db.get<EvidenceFile>("evidence", scope(req), recordId(req))),
  );
  app.get(`${base}/evidence/:id/download`, (req, res) => {
    const evidence = ops.db.get<EvidenceFile>(
      "evidence",
      scope(req),
      recordId(req),
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${evidence.id}.txt"`,
    );
    res.type("text/plain").send(evidence.content);
  });
  app.get(`${base}/source`, async (req, res) => {
    const repo = ops.repository(scope(req)),
      path = z.string().max(240).parse(req.query.path);
    if (!repo.files.some((f) => f.path === path))
      throw new DomainError(404, "File is outside the discovered inventory.");
    res.json(await ops.github(repo).file(repo.fullName, path, repo.headSha));
  });
  app.get(`${base}/export`, (req, res) => {
    const companyId = scope(req),
      company = ops.company(companyId);
    const records: Record<string, unknown[]> = {};
    for (const kind of [
      "repository",
      "incident",
      "task",
      "memory",
      "evidence",
      "integration",
    ])
      records[kind] = ops.db.list(kind, companyId);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="maya-${companyId}-operations.json"`,
    );
    res.json({
      schema: "maya-operations-backup-v2",
      exportedAt: new Date().toISOString(),
      company,
      records,
      note: "Credentials are excluded. Reconnect tools after restoring. Active writes will require reconciliation.",
    });
  });
  app.post("/api/ops/restore", (req, res) => {
    const input = z
      .object({
        schema: z.literal("maya-operations-backup-v2"),
        company: z.object({
          id: z.string().min(1).max(100),
          name: z.string().min(1).max(60),
          stack: z.string().max(100),
          runtime: z.string().max(100),
          revision: z.number().int().min(1),
          connector: z.enum(["simulation", "company-a", "company-b"]),
          createdAt: z.string(),
        }),
        records: z.object({
          repository: z.array(z.any()).max(1),
          incident: z.array(z.any()).max(300),
          task: z.array(z.any()).max(600),
          memory: z.array(z.any()).max(300),
          evidence: z.array(z.any()).max(3000),
          integration: z.array(z.any()).max(20),
        }),
      })
      .passthrough()
      .parse(req.body);
    const companyId = input.company.id;
    if (
      ops.db.list("repository", companyId).length ||
      ops.db.list("incident", companyId).length
    )
      throw new DomainError(
        409,
        "Restore requires an empty workspace. Export existing records before replacing a deployment.",
      );
    for (const list of Object.values(input.records))
      for (const row of list) {
        if (typeof row.id !== "string" || row.companyId !== companyId)
          throw new DomainError(
            400,
            "Backup contains a record outside its workspace.",
          );
        if (row.kind && row.content && row.digest !== sha256(row.content))
          throw new DomainError(
            400,
            "An evidence hash does not match the backup content.",
          );
      }
    // Restore is a data import, never an execution or approval channel.
    ops.db.store.transaction(() => {
      ops.db.store.saveCompany({ ...input.company, connector: "simulation" });
      for (const [kind, rows] of Object.entries(input.records))
        for (const row of rows) {
          if (kind === "repository")
            Object.assign(row, {
              monitoring: false,
              autoInvestigate: false,
              shareWithDuo: false,
              automationMode: "assisted",
            });
          if (kind === "incident") {
            row.status = "needs_input";
            row.planDigest = undefined;
            row.approval = undefined;
            row.merge = undefined;
            row.error =
              "Restored record. Reconnect credentials and independently verify remote state before any action.";
          }
          if (kind === "task") {
            row.state = "failed";
            row.error =
              "Restored historical session. This task will not resume automatically.";
          }
          if (kind === "memory") row.status = "retired";
          if (kind === "integration") {
            row.enabled = false;
            row.hasCredentials = false;
          }
          ops.db.save(kind, row);
        }
      ops.db.store.audit(
        companyId,
        "operations.restored",
        "Backup restored with automation disabled, credentials excluded and imported authorizations invalidated.",
      );
    });
    res.status(201).json({ companyId });
  });
}
