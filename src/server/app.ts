import express from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import { Engine, DomainError } from "./engine.js";
import { scenarios } from "./scenarios.js";
import { DuoBridge, handoff } from "./duo.js";
import type {
  Company,
  Incident,
  Lesson,
  Run,
  ScenarioId,
  Snapshot,
} from "../shared/types.js";

const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function createApp(
  engine: Engine,
  options: {
    accessToken?: string;
    secureCookie?: boolean;
    duo?: DuoBridge;
  } = {},
) {
  const app = express(),
    store = engine.store;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  const cookieValue = options.accessToken
    ? createHmac("sha256", options.accessToken)
        .update("maya-local-session-v1")
        .digest("hex")
    : "";
  const authenticated = (req: express.Request) =>
    !options.accessToken ||
    equal(
      req.get("authorization")?.replace(/^Bearer /, "") || "",
      options.accessToken,
    ) ||
    equal(
      (req.get("cookie") || "")
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("maya_session="))
        ?.slice(13) || "",
      cookieValue,
    );
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      const host = req.get("host");
      if (origin && (!URL.canParse(origin) || new URL(origin).host !== host))
        return res
          .status(403)
          .json({ error: "Cross-origin changes are not allowed." });
      if (!req.is("application/json"))
        return res.status(415).json({ error: "Use application/json." });
    }
    next();
  });
  app.get("/api/health", (_req, res) => {
    store.db.prepare("SELECT 1").get();
    res.json({
      status: "healthy",
      service: "maya",
      version: "0.1.0",
      provider: "deterministic",
      duoConnected: store
        .companies()
        .some((company) =>
          store
            .duoReviews(company.id)
            .some((review) => review.executionVerified),
        ),
      duoConfigured: !!options.duo,
      buildCommit: process.env.RENDER_GIT_COMMIT || "local",
    });
  });
  app.get("/api/meta", (req, res) =>
    res.json({
      authRequired: !!options.accessToken,
      authenticated: authenticated(req),
    }),
  );
  app.post("/api/session", (req, res) => {
    const { token } = z
      .object({ token: z.string().min(1).max(500) })
      .parse(req.body);
    if (!options.accessToken || !equal(token, options.accessToken))
      return res.status(401).json({ error: "Invalid sandbox access key." });
    res.setHeader(
      "Set-Cookie",
      `maya_session=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${options.secureCookie || req.get("x-forwarded-proto") === "https" ? "; Secure" : ""}`,
    );
    res.json({ ok: true });
  });
  app.use("/api", (req, res, next) => {
    if (!authenticated(req))
      return res
        .status(401)
        .json({ error: "Enter the sandbox access key to continue." });
    next();
  });
  app.post("/api/session/logout", (_req, res) => {
    res.setHeader(
      "Set-Cookie",
      "maya_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    res.json({ ok: true });
  });
  app.get("/api/companies", (_req, res) => res.json(store.companies()));
  app.post("/api/companies", (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(2).max(60),
        stack: z.string().trim().min(2).max(80),
        runtime: z.string().trim().min(2).max(40),
        connector: z
          .enum(["simulation", "company-a", "company-b"])
          .default("simulation"),
      })
      .strict()
      .parse(req.body);
    if (
      input.connector !== "simulation" &&
      !engine.connectors.configs[input.connector]
    )
      throw new DomainError(
        400,
        "That live connector is not configured on this server.",
      );
    if (
      input.connector !== "simulation" &&
      store.companies().some((c) => c.connector === input.connector)
    )
      throw new DomainError(
        409,
        "That demo connector is already assigned to a company.",
      );
    const company: Company = {
      id: randomUUID(),
      ...input,
      revision: 1,
      createdAt: new Date().toISOString(),
    };
    store.transaction(() => {
      store.saveCompany(company);
      store.audit(
        company.id,
        "company.onboarded",
        "Company workspace created with an isolated memory scope.",
        {
          connector: company.connector,
          stack: company.stack,
          runtime: company.runtime,
        },
      );
    });
    res.status(201).json(company);
  });
  app.get("/api/companies/:companyId/snapshot", (req, res) => {
    const company = engine.company(req.params.companyId),
      runs = store.list<Run>("runs", company.id),
      lessons = store.list<Lesson>("lessons", company.id);
    const snapshot: Snapshot = {
      companies: store.companies(),
      company,
      incidents: store.list<Incident>("incidents", company.id),
      runs,
      lessons,
      audit: store.audits(company.id),
      scenarios: scenarios.filter(
        (s) =>
          company.connector === "simulation" ||
          engine.connectors.allowed(company, s.id),
      ),
      connection: {
        configured: !!engine.connectors.config(company),
        label:
          company.connector === "simulation"
            ? "Isolated simulation"
            : `${company.connector} · live HTTP connector`,
      },
      metrics: {
        resolved: runs.filter((r) => r.status === "resolved").length,
        awaiting: runs.filter((r) => r.status === "awaiting_approval").length,
        activeLessons: lessons.filter((l) => l.status === "active").length,
        reused: runs.filter((r) => r.memory.kind === "reused").length,
        staleRejected: runs.filter((r) => r.memory.kind === "rejected").length,
      },
      engine: {
        provider: "deterministic",
        duoConnected: store
          .duoReviews(company.id)
          .some((r) => r.executionVerified),
        duoConfigured: !!options.duo,
      },
      duoReviews: store.duoReviews(company.id),
    };
    res.json(snapshot);
  });
  app.post("/api/companies/:companyId/context", (req, res) => {
    const company = engine.company(req.params.companyId),
      { runtime } = z
        .object({ runtime: z.string().trim().min(2).max(40) })
        .strict()
        .parse(req.body);
    if (
      engine.injections.has(company.id) ||
      store.list<Run>("runs", company.id).some((r) => r.status === "running")
    )
      throw new DomainError(
        409,
        "Wait for the active run to finish before changing context.",
      );
    company.runtime = runtime;
    company.revision++;
    store.transaction(() => {
      store.saveCompany(company);
      store.audit(
        company.id,
        "context.changed",
        "Runtime context changed. Existing proposals and lessons must be checked again.",
        { runtime, revision: company.revision },
      );
    });
    res.json(company);
  });
  app.post("/api/companies/:companyId/incidents", async (req, res) => {
    const body = z
      .object({
        scenario: z.enum(
          scenarios.map((s) => s.id) as [ScenarioId, ...ScenarioId[]],
        ),
        start: z.boolean().default(true),
      })
      .strict()
      .parse(req.body);
    const incident = await engine.incident(req.params.companyId, body.scenario);
    const run = body.start
      ? engine.start(incident.companyId, incident.id)
      : null;
    res.status(201).json({ incident, run });
  });
  app.post("/api/companies/:companyId/incidents/:id/run", (req, res) =>
    res.status(201).json(engine.start(req.params.companyId, req.params.id)),
  );
  app.post("/api/companies/:companyId/runs/:id/recheck", async (req, res) =>
    res.json(await engine.recheck(req.params.companyId, req.params.id)),
  );
  app.post("/api/companies/:companyId/runs/:id/decision", async (req, res) => {
    const { decision, digest, reason } = z
      .object({
        decision: z.enum(["approve", "reject"]),
        digest: z.string().max(64).default(""),
        reason: z.string().trim().min(3).max(500),
      })
      .strict()
      .parse(req.body);
    res.json(
      decision === "approve"
        ? await engine.approve(
            req.params.companyId,
            req.params.id,
            digest,
            reason,
          )
        : engine.reject(req.params.companyId, req.params.id, reason),
    );
  });
  app.post("/api/companies/:companyId/lessons/:id/review", (req, res) => {
    const { action } = z
      .object({ action: z.enum(["promote", "retire"]) })
      .strict()
      .parse(req.body);
    res.json(engine.review(req.params.companyId, req.params.id, action));
  });
  app.get("/api/companies/:companyId/connection", async (req, res) => {
    const company = engine.company(req.params.companyId);
    if (company.connector === "simulation")
      return res.json({ mode: "simulation", checks: [] });
    res.json({
      mode: "connected",
      checks: await engine.connectors.verify(company),
    });
  });
  app.get("/api/companies/:companyId/export", (req, res) => {
    const company = engine.company(req.params.companyId);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="maya-${company.id}-evidence.json"`,
    );
    res.json({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      company,
      incidents: store.list("incidents", company.id),
      runs: store.list("runs", company.id),
      lessons: store.list("lessons", company.id),
      audit: store.audits(company.id),
      provider: "deterministic",
      duoConnected: store
        .duoReviews(company.id)
        .some((review) => review.executionVerified),
      duoReviews: store.duoReviews(company.id),
    });
  });
  app.get("/api/companies/:companyId/runs/:id/handoff", (req, res) => {
    const run = engine.run(req.params.companyId, req.params.id);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="maya-${run.id}-duo-handoff.json"`,
    );
    res.json(handoff(engine, req.params.companyId, run.id));
  });
  app.post("/api/companies/:companyId/runs/:id/duo", async (req, res) => {
    z.object({ shareEvidence: z.literal(true) })
      .strict()
      .parse(req.body);
    engine.run(req.params.companyId, req.params.id);
    if (!options.duo)
      throw new DomainError(
        503,
        "GitLab Duo is not configured on this server. Download the handoff for a manual review.",
      );
    res.json(await options.duo.start(req.params.companyId, req.params.id));
  });
  app.post(
    "/api/companies/:companyId/runs/:id/duo/refresh",
    async (req, res) => {
      z.object({}).strict().parse(req.body);
      engine.run(req.params.companyId, req.params.id);
      if (!options.duo)
        throw new DomainError(
          503,
          "GitLab Duo is not configured on this server.",
        );
      res.json(await options.duo.refresh(req.params.companyId, req.params.id));
    },
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API route not found." }),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        error instanceof DomainError
          ? error.status
          : error instanceof ZodError
            ? 400
            : (error as { status?: number }).status === 400
              ? 400
              : 500;
      res.status(status).json({
        error:
          error instanceof ZodError
            ? error.issues
                .map((i) => `${i.path.join(".") || "request"}: ${i.message}`)
                .join("; ")
            : status === 500
              ? "The operation failed. Check server logs and try again."
              : (error as Error).message,
      });
      if (status === 500) console.error(error);
    },
  );
  return app;
}
