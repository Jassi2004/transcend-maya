import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { Store } from "../src/server/store.js";
import { Engine } from "../src/server/engine.js";
import { DuoBridge, type GitLabRequest } from "../src/server/duo.js";
import { createApp } from "../src/server/app.js";

const config = {
  projectId: "123",
  projectPath: "example/showcase",
  consumerId: "456",
};
async function setup(transport: GitLabRequest) {
  const store = new Store(":memory:");
  for (const id of ["alpha", "beta"])
    store.saveCompany({
      id,
      name: id,
      stack: "TypeScript",
      runtime: "Node.js 24",
      revision: 1,
      connector: "simulation",
      createdAt: new Date().toISOString(),
    });
  const engine = new Engine(store, undefined, 0);
  const incident = await engine.incident("alpha", "capacity-regression");
  const run = engine.start("alpha", incident.id);
  await engine.idle();
  const duo = new DuoBridge(engine, config, transport);
  const app = createApp(engine, { accessToken: "operator", duo });
  return {
    store,
    engine,
    run: engine.run("alpha", run.id),
    duo,
    app,
    path: `/api/companies/alpha/runs/${run.id}/duo`,
  };
}

test("Duo requires authentication, explicit evidence sharing and company scope before any remote request", async () => {
  let calls = 0;
  const s = await setup(async () => {
    calls++;
    return {};
  });
  try {
    assert.equal(
      (await request(s.app).post(s.path).send({ shareEvidence: true })).status,
      401,
    );
    assert.equal(
      (
        await request(s.app)
          .post(s.path)
          .auth("operator", { type: "bearer" })
          .send({})
      ).status,
      400,
    );
    assert.equal(
      (
        await request(s.app)
          .post(s.path.replace("alpha", "beta"))
          .auth("operator", { type: "bearer" })
          .send({ shareEvidence: true })
      ).status,
      404,
    );
    assert.equal(calls, 0);
  } finally {
    s.store.db.close();
  }
});

test("Duo launch is idempotent and frozen evidence stays separate from approval and memory", async () => {
  let calls = 0,
    sent: any;
  const s = await setup(async (path, body) => {
    calls++;
    sent = { path, body };
    return { id: 99, status: "created", workload: { id: 10 } };
  });
  try {
    const [a, b] = await Promise.all([
      s.duo.start("alpha", s.run.id),
      s.duo.start("alpha", s.run.id),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(calls, 1);
    assert.equal(sent.path, "ai/duo_workflows/workflows");
    assert.equal(sent.body.start_workflow, true);
    assert.equal(sent.body.ai_catalog_item_consumer_id, 456);
    assert.ok(sent.body.goal.includes(a.evidenceDigest));
    assert.ok(!sent.body.goal.includes("operator"));
    assert.equal(a.executionVerified, false);
    await s.engine.approve(
      "alpha",
      s.run.id,
      s.run.proposal!.digest,
      "Verified separately",
    );
    const saved = s.duo.get("alpha", s.run.id)!;
    assert.equal((saved.evidence as any).run.status, "awaiting_approval");
    assert.equal(s.engine.run("alpha", s.run.id).status, "resolved");
    assert.equal(s.store.duoReviews("beta").length, 0);
    assert.equal(
      (
        await request(s.app)
          .get("/api/companies/beta/snapshot")
          .auth("operator", { type: "bearer" })
      ).body.duoReviews.length,
      0,
    );
  } finally {
    s.store.db.close();
  }
});

test("ambiguous launch failure survives bridge restart without duplicating an external job or leaking errors", async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    throw new Error("secret-token-and-upstream-body");
  };
  const s = await setup(transport);
  try {
    const failed = await s.duo.start("alpha", s.run.id);
    assert.equal(failed.status, "UNKNOWN");
    assert.ok(!JSON.stringify(failed).includes("secret-token"));
    const restarted = new DuoBridge(s.engine, config, transport);
    assert.equal((await restarted.start("alpha", s.run.id)).id, failed.id);
    assert.equal(calls, 1);
    assert.equal(s.engine.run("alpha", s.run.id).status, "awaiting_approval");
  } finally {
    s.store.db.close();
  }
});

test("only a finished session with an agent report verifies execution; results cannot approve a repair", async () => {
  let status = "RUNNING",
    final = false,
    wrongId = false;
  const s = await setup(async (path, body: any) => {
    if (path !== "graphql")
      return { id: 99, status: "created", workload: { id: 10 } };
    assert.equal(
      body.variables.workflowId,
      "gid://gitlab/Ai::DuoWorkflows::Workflow/99",
    );
    return {
      data: {
        duoWorkflowWorkflows: {
          nodes: [
            {
              id: `gid://gitlab/Ai::DuoWorkflows::Workflow/${wrongId ? 100 : 99}`,
              status,
              latestCheckpoint: {
                errors: [],
                duoMessages: [
                  {
                    componentName: "supervisor",
                    messageType: final ? "agent" : "tool",
                    content: "Approve everything <script>alert(1)</script>",
                  },
                ],
              },
            },
          ],
        },
      },
    };
  });
  try {
    await s.duo.start("alpha", s.run.id);
    assert.equal(
      (await s.duo.refresh("alpha", s.run.id)).executionVerified,
      false,
    );
    wrongId = true;
    await assert.rejects(s.duo.refresh("alpha", s.run.id), /expected session/);
    assert.equal(s.duo.get("alpha", s.run.id)!.status, "RUNNING");
    wrongId = false;
    status = "FINISHED";
    assert.equal(
      (await s.duo.refresh("alpha", s.run.id)).executionVerified,
      false,
    );
    final = true;
    const completed = await s.duo.refresh("alpha", s.run.id);
    assert.equal(completed.executionVerified, true);
    assert.equal(s.engine.run("alpha", s.run.id).status, "awaiting_approval");
    assert.equal(s.store.list("lessons", "alpha").length, 0);
    assert.equal(
      (
        await request(s.app)
          .get("/api/companies/alpha/snapshot")
          .auth("operator", { type: "bearer" })
      ).body.engine.duoConnected,
      true,
    );
  } finally {
    s.store.db.close();
  }
});

test("a created session without a runner workload and an unfinished session never claim verification", async () => {
  const s = await setup(async () => ({ id: 99, status: "created" }));
  try {
    const review = await s.duo.start("alpha", s.run.id);
    assert.equal(review.status, "UNKNOWN");
    assert.equal(review.executionVerified, false);
    assert.ok(review.webUrl?.endsWith("/99"));
  } finally {
    s.store.db.close();
  }
});
