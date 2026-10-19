import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Audit, Company, Incident, Lesson, Run } from "../shared/types.js";
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,companyId TEXT NOT NULL REFERENCES companies(id),data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,companyId TEXT NOT NULL REFERENCES companies(id),incidentId TEXT NOT NULL REFERENCES incidents(id),status TEXT NOT NULL,data TEXT NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(incidentId) WHERE status IN ('running','awaiting_approval');
   CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY,companyId TEXT NOT NULL REFERENCES companies(id),data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,companyId TEXT NOT NULL REFERENCES companies(id),runId TEXT NOT NULL UNIQUE REFERENCES runs(id),data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,companyId TEXT NOT NULL REFERENCES companies(id),kind TEXT NOT NULL,message TEXT NOT NULL,details TEXT NOT NULL,createdAt TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS company_incidents ON incidents(companyId);
   CREATE INDEX IF NOT EXISTS company_runs ON runs(companyId);
   CREATE INDEX IF NOT EXISTS company_lessons ON lessons(companyId);
  `);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  companies(): Company[] {
    return this.db
      .prepare("SELECT data FROM companies ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(String(r.data)));
  }
  company(id: string): Company | undefined {
    return this.companies().find((c) => c.id === id);
  }
  saveCompany(c: Company) {
    this.db
      .prepare(
        "INSERT INTO companies VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(c.id, JSON.stringify(c));
  }
  list<T>(table: "incidents" | "runs" | "lessons", companyId: string): T[] {
    return this.db
      .prepare(
        `SELECT data FROM ${table} WHERE companyId=? ORDER BY rowid DESC`,
      )
      .all(companyId)
      .map((r) => JSON.parse(String(r.data)));
  }
  get<T>(
    table: "incidents" | "runs" | "lessons",
    id: string,
    companyId: string,
  ): T | undefined {
    const row = this.db
      .prepare(`SELECT data FROM ${table} WHERE id=? AND companyId=?`)
      .get(id, companyId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  saveIncident(i: Incident) {
    this.db
      .prepare(
        "INSERT INTO incidents VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(i.id, i.companyId, JSON.stringify(i));
  }
  saveRun(r: Run) {
    this.db
      .prepare(
        "INSERT INTO runs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",
      )
      .run(r.id, r.companyId, r.incidentId, r.status, JSON.stringify(r));
  }
  saveLesson(l: Lesson) {
    this.db
      .prepare(
        "INSERT INTO lessons VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(l.id, l.companyId, JSON.stringify(l));
  }
  audit(
    companyId: string,
    kind: string,
    message: string,
    details: unknown = {},
  ) {
    this.db
      .prepare(
        "INSERT INTO audit(companyId,kind,message,details,createdAt) VALUES(?,?,?,?,?)",
      )
      .run(
        companyId,
        kind,
        message,
        JSON.stringify(details),
        new Date().toISOString(),
      );
  }
  audits(companyId: string): Audit[] {
    return this.db
      .prepare(
        "SELECT * FROM audit WHERE companyId=? ORDER BY id DESC LIMIT 200",
      )
      .all(companyId)
      .map((r) => ({
        ...r,
        details: JSON.parse(String(r.details)),
      })) as unknown as Audit[];
  }
  decide(
    companyId: string,
    runId: string,
    decision: string,
    reason: string,
    digest: string,
  ) {
    this.db.prepare("INSERT INTO decisions VALUES(?,?,?,?)").run(
      randomUUID(),
      companyId,
      runId,
      JSON.stringify({
        decision,
        reason,
        digest,
        at: new Date().toISOString(),
      }),
    );
  }
  recover() {
    for (const row of this.db
      .prepare("SELECT data FROM runs WHERE status='running'")
      .all()) {
      const r = JSON.parse(String(row.data)) as Run;
      r.status = "interrupted";
      r.stage = "Interrupted by restart";
      r.finishedAt = new Date().toISOString();
      this.saveRun(r);
      this.audit(
        r.companyId,
        "run.interrupted",
        "An unfinished run was interrupted by a server restart.",
        { runId: r.id },
      );
    }
  }
}
