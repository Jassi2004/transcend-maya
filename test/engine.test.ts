import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { Store } from "../src/server/store.js";
import { Engine } from "../src/server/engine.js";
import { Connectors } from "../src/server/connectors.js";
import { createApp } from "../src/server/app.js";
import {
  scenarios,
  makeFixture,
  verifyFixture,
} from "../src/server/scenarios.js";
import type { Company, Lesson, Run } from "../src/shared/types.js";
function setup() {
  const store = new Store(":memory:");
  const company: Company = {
    id: "alpha",
    name: "Alpha",
    stack: "TypeScript",
    runtime: "Node.js 24",
    revision: 1,
    connector: "simulation",
    createdAt: new Date().toISOString(),
  };
  store.saveCompany(company);
  store.saveCompany({ ...company, id: "beta", name: "Beta" });
  const engine = new Engine(store, new Connectors(), 0);
  return { store, engine, company };
}
async function pending(engine: Engine) {
  const i = await engine.incident("alpha", "capacity-regression");
  const r = engine.start("alpha", i.id);
  await engine.idle();
  return engine.run("alpha", r.id);
}
test("every repair scenario reproduces a failure and its candidate passes; credentials cannot self-heal", () => {
  for (const s of scenarios) {
    const fixture = makeFixture(s.id);
    assert.ok(verifyFixture(s.id, fixture).some((c) => !c.passed));
    if (s.patch)
      assert.ok(
        verifyFixture(s.id, { ...fixture, ...s.patch }).every((c) => c.passed),
      );
    else assert.equal(s.id, "expired-credential");
  }
});
test("repair requires exact approval and lesson requires independent promotion", async () => {
  const { store, engine } = setup();
  try {
    const run = await pending(engine);
    assert.equal(run.status, "awaiting_approval");
    assert.equal(store.list<Lesson>("lessons", "alpha").length, 0);
    await assert.rejects(
      () => engine.approve("alpha", run.id, "wrong", "Reviewed"),
      /exact proposed artifact/,
    );
    const resolved = await engine.approve(
      "alpha",
      run.id,
      run.proposal!.digest,
      "Reviewed the patch and checks",
    );
    assert.equal(resolved.status, "resolved");
    const lesson = store.list<Lesson>("lessons", "alpha")[0];
    assert.equal(lesson.status, "candidate");
    engine.review("alpha", lesson.id, "promote");
    assert.equal(
      store.get<Lesson>("lessons", lesson.id, "alpha")!.status,
      "active",
    );
    await assert.rejects(
      () => engine.approve("alpha", run.id, run.proposal!.digest, "Again"),
      /not waiting/,
    );
  } finally {
    store.db.close();
  }
});
test("verified memory shortens repeat workflow and changed context rejects a stale match", async () => {
  const { store, engine, company } = setup();
  try {
    const first = await pending(engine);
    await engine.approve("alpha", first.id, first.proposal!.digest, "Verified");
    engine.review(
      "alpha",
      store.list<Lesson>("lessons", "alpha")[0].id,
      "promote",
    );
    const repeat = await pending(engine);
    assert.equal(repeat.memory.kind, "reused");
    assert.ok(repeat.steps.length < first.steps.length);
    engine.reject("alpha", repeat.id, "Testing a changed context");
    company.runtime = "Node.js 26";
    company.revision++;
    store.saveCompany(company);
    const changed = await pending(engine);
    assert.equal(changed.memory.kind, "rejected");
    assert.ok(changed.steps.some((s) => s.title === "Stale lesson rejected"));
  } finally {
    store.db.close();
  }
});
test("company isolation holds for runs, lessons, decisions and handoff exports", async () => {
  const { store, engine } = setup();
  try {
    const run = await pending(engine);
    assert.throws(() => engine.run("beta", run.id), /not found/);
    const app = createApp(engine);
    assert.equal(
      (await request(app).get(`/api/companies/beta/runs/${run.id}/handoff`))
        .status,
      404,
    );
    assert.equal(
      (
        await request(app)
          .post(`/api/companies/beta/runs/${run.id}/decision`)
          .send({
            decision: "approve",
            digest: run.proposal!.digest,
            reason: "Reviewed",
          })
      ).status,
      404,
    );
    const snapshot = await request(app).get("/api/companies/beta/snapshot");
    assert.equal(snapshot.body.runs.length, 0);
    await engine.approve("alpha", run.id, run.proposal!.digest, "Reviewed");
    const lesson = store.list<Lesson>("lessons", "alpha")[0];
    assert.throws(
      () => engine.review("beta", lesson.id, "promote"),
      /not found/,
    );
    const beta = await engine.incident("beta", "capacity-regression");
    const betaRun = engine.start("beta", beta.id);
    await engine.idle();
    assert.equal(engine.run("beta", betaRun.id).memory.kind, "new");
  } finally {
    store.db.close();
  }
});
test("a changed company revision invalidates an outstanding approval", async () => {
  const { store, engine, company } = setup();
  try {
    const run = await pending(engine);
    company.revision++;
    store.saveCompany(company);
    await assert.rejects(
      () => engine.approve("alpha", run.id, run.proposal!.digest, "Reviewed"),
      /context changed/,
    );
    assert.equal(engine.run("alpha", run.id).status, "awaiting_approval");
  } finally {
    store.db.close();
  }
});
test("corrupted lesson patches cannot be promoted", async () => {
  const { store, engine } = setup();
  try {
    const run = await pending(engine);
    await engine.approve("alpha", run.id, run.proposal!.digest, "Reviewed");
    const lesson = store.list<Lesson>("lessons", "alpha")[0];
    lesson.patch = { capacity: 100 };
    store.saveLesson(lesson);
    assert.throws(
      () => engine.review("alpha", lesson.id, "promote"),
      /invalid/,
    );
  } finally {
    store.db.close();
  }
});
test("rejection applies no repair and records no lesson", async () => {
  const { store, engine } = setup();
  try {
    const run = await pending(engine);
    engine.reject("alpha", run.id, "Need more evidence");
    assert.equal(engine.run("alpha", run.id).status, "rejected");
    assert.equal(store.list<Lesson>("lessons", "alpha").length, 0);
    assert.ok(
      store.audits("alpha").some((a) => a.kind === "approval.rejected"),
    );
  } finally {
    store.db.close();
  }
});
test("credential failures escalate without proposing a fabricated secret", async () => {
  const { store, engine } = setup();
  try {
    const i = await engine.incident("alpha", "expired-credential");
    const r = engine.start("alpha", i.id);
    await engine.idle();
    const run = engine.run("alpha", r.id);
    assert.equal(run.status, "escalated");
    assert.equal(run.proposal, null);
    assert.equal(store.list<Lesson>("lessons", "alpha").length, 0);
  } finally {
    store.db.close();
  }
});
test("restart recovery interrupts running work instead of reporting success", async () => {
  const { store, engine } = setup();
  try {
    const run = await pending(engine);
    run.status = "running";
    store.saveRun(run);
    store.recover();
    assert.equal(engine.run("alpha", run.id).status, "interrupted");
  } finally {
    store.db.close();
  }
});
test("API enforces operator access, same-origin writes and validation", async () => {
  const { store, engine } = setup();
  try {
    const app = createApp(engine, { accessToken: "operator-test-key" });
    assert.equal((await request(app).get("/api/companies")).status, 401);
    assert.equal((await request(app).get("/api/health")).status, 200);
    const login = await request(app)
      .post("/api/session")
      .send({ token: "operator-test-key" });
    assert.equal(login.status, 200);
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    assert.equal(
      (await request(app).get("/api/companies").set("Cookie", cookie)).status,
      200,
    );
    assert.equal(
      (
        await request(app)
          .post("/api/companies")
          .set("Cookie", cookie)
          .set("Origin", "https://evil.example")
          .send({ name: "Test" })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(app).post("/api/companies").set("Cookie", cookie).send({
          name: "X",
          stack: "TS",
          runtime: "24",
          token: "never-accept-secrets",
        })
      ).status,
      400,
    );
  } finally {
    store.db.close();
  }
});
test("active runs are deduplicated and retired lessons remain in history", async () => {
  const { store, engine } = setup();
  try {
    const run = await pending(engine);
    assert.throws(() => engine.start("alpha", run.incidentId), /already/);
    await engine.approve("alpha", run.id, run.proposal!.digest, "Reviewed");
    const lesson = store.list<Lesson>("lessons", "alpha")[0];
    engine.review("alpha", lesson.id, "promote");
    engine.review("alpha", lesson.id, "retire");
    assert.equal(
      store.get<Lesson>("lessons", lesson.id, "alpha")!.status,
      "retired",
    );
    const repeat = await pending(engine);
    assert.equal(repeat.memory.kind, "new");
  } finally {
    store.db.close();
  }
});
