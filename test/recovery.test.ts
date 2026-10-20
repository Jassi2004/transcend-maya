import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { Store } from "../src/server/store.js";
import { Engine } from "../src/server/engine.js";
import { ConnectorError, Connectors } from "../src/server/connectors.js";
import { createApp } from "../src/server/app.js";
import type {
  Company,
  Incident,
  Lesson,
  ScenarioId,
} from "../src/shared/types.js";

// A controlled external service lets us stop exactly at the network boundary.
// Atomic fault-ID enforcement is separately exercised against both real company APIs.
class ControlledService extends Connectors {
  fault: string = "none";
  faultId = "";
  injections = 0;
  repairs = 0;
  verificationUnavailable = false;
  onInject?: () => void;
  onRepair?: () => Promise<void> | void;
  override async inject(_company: Company, scenario: ScenarioId) {
    this.injections++;
    this.fault = scenario;
    this.faultId = randomUUID();
    this.onInject?.();
    return this.faultId;
  }
  override async inspect(_company: Company) {
    return {
      fault: this.fault,
      faultId: this.faultId,
      evidence: [`fault=${this.fault}`, `fault_id=${this.faultId}`],
    };
  }
  override async verify(_company: Company) {
    if (this.verificationUnavailable && this.fault === "none")
      throw new Error("Monitoring temporarily unavailable");
    return ["Service is healthy", "Bookings are available"].map((name) => ({
      name,
      expected: true,
      actual: this.fault === "none",
      passed: this.fault === "none",
    }));
  }
  override async repair(
    _company: Company,
    scenario: ScenarioId,
    expectedFaultId: string,
  ) {
    this.repairs++;
    if (this.fault !== scenario || this.faultId !== expectedFaultId)
      throw new ConnectorError(409, "Fault identity changed; repair refused");
    await this.onRepair?.();
    this.fault = "none";
    this.faultId = randomUUID();
  }
}
function setup() {
  const store = new Store(":memory:");
  const company: Company = {
    id: "live",
    name: "Live company",
    connector: "company-a",
    runtime: "Node.js 24",
    stack: "TypeScript",
    revision: 1,
    createdAt: new Date().toISOString(),
  };
  store.saveCompany(company);
  const service = new ControlledService();
  const engine = new Engine(store, service, 0);
  return { store, company, service, engine };
}
async function pending(engine: Engine) {
  const incident = await engine.incident("live", "capacity-regression");
  const run = engine.start("live", incident.id);
  await engine.idle();
  return engine.run("live", run.id);
}
test("approval is durable before network execution and concurrent approval executes only once", async () => {
  const { store, engine, service } = setup();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const run = await pending(engine);
    service.onRepair = async () => {
      assert.equal(store.decision("live", run.id)?.decision, "approved");
      assert.equal(
        engine.run("live", run.id).approval?.digest,
        run.proposal!.digest,
      );
      assert.ok(
        store.audits("live").some((a) => a.kind === "approval.granted"),
      );
      await hold;
    };
    const action = engine.approve(
      "live",
      run.id,
      run.proposal!.digest,
      "Reviewed artifact",
    );
    await assert.rejects(
      () => engine.approve("live", run.id, run.proposal!.digest, "Duplicate"),
      /not waiting/,
    );
    assert.ok(engine.tasks.has(run.id));
    release();
    const completed = await action;
    assert.equal(completed.status, "resolved");
    assert.ok(
      completed.verification!.liveBefore!.some((check) => !check.passed),
    );
    assert.ok(
      completed.verification!.liveAfter!.every((check) => check.passed),
    );
    assert.equal(service.repairs, 1);
  } finally {
    release();
    await engine.idle();
    store.db.close();
  }
});
test("uncertain recovery preserves approval and incident failure; read-only recheck repeats no repair or lesson", async () => {
  const { store, engine, service } = setup();
  try {
    const run = await pending(engine);
    service.verificationUnavailable = true;
    await assert.rejects(
      () => engine.approve("live", run.id, run.proposal!.digest, "Reviewed"),
      /Monitoring temporarily/,
    );
    assert.equal(service.fault, "none");
    assert.equal(engine.run("live", run.id).status, "failed");
    assert.equal(
      store.get<Incident>("incidents", run.incidentId, "live")!.status,
      "failed",
    );
    assert.equal(store.decision("live", run.id)?.decision, "approved");
    assert.equal(store.list<Lesson>("lessons", "live").length, 0);
    const app = createApp(engine);
    assert.equal(
      (
        await request(app)
          .post(`/api/companies/live/runs/${run.id}/recheck`)
          .send({})
      ).status,
      502,
    );
    service.verificationUnavailable = false;
    const checked = await engine.recheck("live", run.id);
    assert.equal(checked.status, "resolved");
    assert.equal(checked.recoveryRechecked, true);
    assert.equal(service.repairs, 1);
    assert.equal(store.list<Lesson>("lessons", "live").length, 0);
    assert.ok(store.audits("live").some((a) => a.kind === "run.reconciled"));
  } finally {
    store.db.close();
  }
});
test("replacing a fault with the same kind invalidates approval; fresh investigation captures its new identity", async () => {
  const { store, engine, service } = setup();
  try {
    const first = await pending(engine);
    service.faultId = randomUUID();
    const refused = await request(createApp(engine))
      .post(`/api/companies/live/runs/${first.id}/decision`)
      .send({
        decision: "approve",
        digest: first.proposal!.digest,
        reason: "Reviewed",
      });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /identity changed/);
    assert.equal(service.fault, "capacity-regression");
    const next = engine.start("live", first.incidentId);
    await engine.idle();
    const fresh = engine.run("live", next.id);
    assert.notEqual(fresh.proposal!.digest, first.proposal!.digest);
    assert.equal(fresh.faultId, service.faultId);
    assert.equal(
      (
        await engine.approve(
          "live",
          fresh.id,
          fresh.proposal!.digest,
          "Reviewed fresh evidence",
        )
      ).status,
      "resolved",
    );
    await assert.rejects(() => engine.recheck("live", first.id), /active run/);
    assert.equal(service.injections, 1);
  } finally {
    store.db.close();
  }
});
test("an already healthy service never receives a fixture-derived repair proposal", async () => {
  const { store, engine, service } = setup();
  try {
    const first = await pending(engine);
    engine.reject("live", first.id, "Investigate again");
    service.fault = "none";
    const retry = engine.start("live", first.incidentId);
    await engine.idle();
    assert.equal(engine.run("live", retry.id).status, "failed");
    assert.equal(engine.run("live", retry.id).proposal, null);
    assert.equal(service.repairs, 0);
    assert.equal(
      store.get<Incident>("incidents", first.incidentId, "live")!.status,
      "failed",
    );
  } finally {
    store.db.close();
  }
});
test("timed-out injection is journaled before the write and actual evidence can recover its uncertain outcome", async () => {
  const { store, engine, service } = setup();
  try {
    service.onInject = () => {
      assert.equal(
        store.list<Incident>("incidents", "live")[0].status,
        "injecting",
      );
      throw new Error("Reply was lost after injection");
    };
    const run = await pending(engine);
    assert.equal(run.status, "awaiting_approval");
    assert.equal(run.faultId, service.faultId);
    assert.ok(
      store
        .audits("live")
        .some((a) => a.kind === "incident.injection_uncertain"),
    );
    assert.equal(
      (
        await engine.approve(
          "live",
          run.id,
          run.proposal!.digest,
          "Reviewed recaptured evidence",
        )
      ).status,
      "resolved",
    );
  } finally {
    store.db.close();
  }
});
test("restart marks run and incident interrupted and preserves authorization for read-only reconciliation", async () => {
  const { store, engine, service } = setup();
  try {
    const run = await pending(engine);
    store.decide(
      "live",
      run.id,
      "approved",
      "Reviewed before restart",
      run.proposal!.digest,
    );
    run.approval = {
      digest: run.proposal!.digest,
      reason: "Reviewed before restart",
      at: new Date().toISOString(),
    };
    run.status = "running";
    store.saveRun(run);
    service.fault = "none";
    store.recover();
    const interrupted = engine.run("live", run.id);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(typeof interrupted.durationMs, "number");
    assert.equal(
      store.get<Incident>("incidents", run.incidentId, "live")!.status,
      "interrupted",
    );
    assert.equal((await engine.recheck("live", run.id)).status, "resolved");
    assert.equal(service.repairs, 0);
  } finally {
    store.db.close();
  }
});
test("recheck refuses changed company context or a tampered approved artifact", async () => {
  const { store, engine, service, company } = setup();
  try {
    const run = await pending(engine);
    service.verificationUnavailable = true;
    await assert.rejects(() =>
      engine.approve("live", run.id, run.proposal!.digest, "Reviewed"),
    );
    company.revision++;
    store.saveCompany(company);
    await assert.rejects(
      () => engine.recheck("live", run.id),
      /context changed/,
    );
    company.revision--;
    store.saveCompany(company);
    const changed = engine.run("live", run.id);
    changed.proposal!.scope = "Different scope";
    store.saveRun(changed);
    await assert.rejects(() => engine.recheck("live", run.id), /authorization/);
    assert.equal(service.repairs, 1);
  } finally {
    store.db.close();
  }
});
test("a saved injection with no run is recoverable after restart without another fault injection", async () => {
  const { store, engine, service } = setup();
  try {
    const incident = await engine.incident("live", "capacity-regression");
    incident.status = "injecting";
    store.saveIncident(incident);
    store.recover();
    assert.equal(
      store.get<Incident>("incidents", incident.id, "live")!.status,
      "interrupted",
    );
    const result = await request(createApp(engine))
      .post(`/api/companies/live/incidents/${incident.id}/run`)
      .send({});
    assert.equal(result.status, 201);
    await engine.idle();
    assert.equal(
      engine.run("live", result.body.id).status,
      "awaiting_approval",
    );
    assert.equal(service.injections, 1);
  } finally {
    store.db.close();
  }
});
