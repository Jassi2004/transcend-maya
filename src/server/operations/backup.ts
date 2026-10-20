import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { OpsStorage } from "./storage.js";
import type { GitLabRest } from "./gitlab.js";
import { sha256 } from "./storage.js";
import { DomainError } from "../engine.js";

const tables = ["ops_records", "ops_credentials", "ops_dedup"] as const;
const aad = Buffer.from("maya-operations-backup-v2");
export function sealSnapshot(value: unknown, secret: string): string {
  const key = createHash("sha256").update(`maya-backup:${secret}`).digest();
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(gzipSync(JSON.stringify(value))),
    cipher.final(),
  ]);
  return JSON.stringify({
    format: "maya-encrypted-operations-v2",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
  });
}
export function openSnapshot(text: string, secret: string): any {
  const envelope = JSON.parse(text);
  if (envelope.format !== "maya-encrypted-operations-v2")
    throw new Error("Unknown backup format.");
  const key = createHash("sha256").update(`maya-backup:${secret}`).digest();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(
    gunzipSync(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]),
      { maxOutputLength: 25_000_000 },
    ).toString(),
  );
}
/** Single-writer, encrypted snapshots for an ephemeral demo host. Not a transaction database. */
export class GitLabBackup {
  private readonly writerId = randomUUID();
  private lastCommit?: string;
  private digest?: string;
  private exists = false;
  private writing = false;
  private timer?: ReturnType<typeof setInterval>;
  lastSavedAt?: string;
  error?: string;
  readonly branch = "maya-state-v2";
  readonly path = "state/operations.enc.json";
  constructor(
    readonly db: OpsStorage,
    private readonly api: GitLabRest,
    readonly projectId: string,
    private readonly secret: string,
  ) {
    if (!secret || secret === "local-development-only")
      throw new Error(
        "Encrypted cloud backups require a stable operator or encryption key.",
      );
  }
  private snapshot() {
    return this.db.store.transaction(() => {
      const companies = this.db.store
        .companies()
        .filter((c) => this.db.list("repository", c.id).length);
      const ids = new Set(companies.map((c) => c.id));
      const records = Object.fromEntries(
        tables.map((table) => [
          table,
          this.db.store.db
            .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
            .all()
            .filter((r) => ids.has(String(r.companyId))),
        ]),
      );
      const audit = this.db.store.db
        .prepare("SELECT * FROM audit ORDER BY id")
        .all()
        .filter((r) => ids.has(String(r.companyId)));
      return { schema: "maya-private-state-v2", companies, records, audit };
    });
  }
  private async commit(data: unknown, lastCommit?: string, exists = true) {
    const base = `projects/${encodeURIComponent(this.projectId)}`;
    const result = await this.api(`${base}/repository/commits`, "POST", {
      branch: this.branch,
      ...(!exists
        ? { start_branch: (await this.api(base)).default_branch }
        : {}),
      commit_message: "Persist encrypted MAYA operations [skip ci]",
      actions: [
        {
          action: exists ? "update" : "create",
          file_path: this.path,
          content: sealSnapshot(data, this.secret),
          ...(lastCommit ? { last_commit_id: lastCommit } : {}),
        },
      ],
    });
    if (!result.id) throw new Error("No checkpoint commit was confirmed.");
    return result;
  }
  async restore(options: { claimWriter?: boolean } = {}) {
    let file: any;
    try {
      file = await this.api(
        `projects/${encodeURIComponent(this.projectId)}/repository/files/${encodeURIComponent(this.path)}?ref=${this.branch}`,
      );
    } catch (error) {
      if (error instanceof DomainError && error.status === 404) return;
      throw new Error(
        "Cloud backup cannot be read. Startup stopped to avoid overwriting saved state.",
      );
    }
    let data = openSnapshot(
      Buffer.from(file.content, "base64").toString(),
      this.secret,
    );
    if (
      data.schema !== "maya-private-state-v2" ||
      !Array.isArray(data.companies) ||
      !data.records ||
      !Array.isArray(data.audit)
    )
      throw new Error("Invalid saved cloud state.");
    if (options.claimWriter) {
      // Render briefly overlaps old and new processes during deployment. Claim the
      // unchanged saved state before becoming healthy, fencing the outgoing writer.
      // A failed compare-and-swap only retries after reading the newer checkpoint;
      // it never publishes a stale local snapshot over another process's work.
      for (let attempt = 0; attempt < 3; attempt++) {
        const checkpoint = {
          writerId: this.writerId,
          savedAt: new Date().toISOString(),
        };
        try {
          const result = await this.commit(
            { ...data, checkpoint },
            file.last_commit_id,
          );
          file.last_commit_id = result.id;
          data.checkpoint = checkpoint;
          break;
        } catch {
          const latest = await this.api(
            `projects/${encodeURIComponent(this.projectId)}/repository/files/${encodeURIComponent(this.path)}?ref=${this.branch}`,
          );
          const current = openSnapshot(
            Buffer.from(latest.content, "base64").toString(),
            this.secret,
          );
          // A lost response may hide a successful claim. Reconcile without another
          // write, exactly as for other ambiguous provider operations.
          if (current.checkpoint?.writerId === this.writerId) {
            file = latest;
            data = current;
            break;
          }
          if (
            attempt === 2 ||
            latest.last_commit_id === file.last_commit_id ||
            current.schema !== "maya-private-state-v2" ||
            !Array.isArray(current.companies) ||
            !current.records ||
            !Array.isArray(current.audit)
          )
            throw new Error(
              "Cloud checkpoint ownership could not be confirmed. Startup stopped to preserve saved state.",
            );
          file = latest;
          data = current;
        }
      }
    }
    this.lastCommit = file.last_commit_id;
    this.exists = true;
    if (
      this.db.store.db.prepare("SELECT count(*) AS n FROM ops_records").get()!
        .n === 0
    ) {
      const ids = new Set(data.companies.map((c: any) => c.id));
      this.db.store.transaction(() => {
        for (const c of data.companies) this.db.store.saveCompany(c);
        for (const table of tables)
          for (const row of data.records[table] || []) {
            if (!ids.has(row.companyId))
              throw new Error("Saved state contains an invalid workspace.");
            if (table === "ops_records") {
              const record = JSON.parse(row.data);
              if (
                record.id !== row.id ||
                record.companyId !== row.companyId ||
                (row.kind === "evidence" &&
                  sha256(record.content) !== record.digest)
              )
                throw new Error("Saved record integrity check failed.");
              this.db.save(row.kind, record);
            } else if (table === "ops_credentials")
              this.db.store.db
                .prepare("INSERT INTO ops_credentials VALUES(?,?,?)")
                .run(row.id, row.companyId, row.data);
            else
              this.db.store.db
                .prepare("INSERT INTO ops_dedup VALUES(?,?,?)")
                .run(row.key, row.companyId, row.recordId);
          }
        for (const row of data.audit) {
          if (!ids.has(row.companyId)) throw new Error("Invalid audit scope.");
          this.db.store.db
            .prepare(
              "INSERT INTO audit(companyId,kind,message,details,createdAt) VALUES(?,?,?,?,?)",
            )
            .run(
              row.companyId,
              row.kind,
              row.message,
              row.details,
              row.createdAt,
            );
        }
      });
      this.digest = sha256(this.snapshot());
    }
    this.lastSavedAt =
      data.checkpoint?.savedAt ||
      file.commit?.committed_date ||
      file.commit?.created_at;
  }
  async save() {
    if (this.writing) return;
    this.writing = true;
    let attemptedDigest: string | undefined;
    try {
      const data = this.snapshot(),
        digest = sha256(data);
      if (!data.companies.length || digest === this.digest) return;
      attemptedDigest = digest;
      const savedAt = new Date().toISOString();
      const result = await this.commit(
        { ...data, checkpoint: { writerId: this.writerId, savedAt } },
        this.lastCommit,
        this.exists,
      );
      this.lastCommit = result.id;
      this.exists = true;
      this.digest = digest;
      this.lastSavedAt = savedAt;
      this.error = undefined;
    } catch {
      this.error =
        "Encrypted state checkpoint failed. Export evidence and inspect the backup branch; do not run multiple writers.";
      // A successful commit can lose its HTTP acknowledgement. Reconcile only
      // this process's authenticated checkpoint; never reclaim another writer
      // or repeat the mutation. A newer local snapshot is saved next interval.
      try {
        const file = await this.api(
          `projects/${encodeURIComponent(this.projectId)}/repository/files/${encodeURIComponent(this.path)}?ref=${this.branch}`,
        );
        const current = openSnapshot(
          Buffer.from(file.content, "base64").toString(),
          this.secret,
        );
        if (
          current.schema === "maya-private-state-v2" &&
          current.checkpoint?.writerId === this.writerId &&
          file.last_commit_id
        ) {
          const { checkpoint, ...data } = current;
          this.lastCommit = file.last_commit_id;
          this.exists = true;
          this.digest = sha256(data);
          this.lastSavedAt = checkpoint.savedAt;
          if (this.digest === attemptedDigest) this.error = undefined;
        }
      } catch {
        // Keep the failure visible until remote ownership can be confirmed.
      }
    } finally {
      this.writing = false;
    }
  }
  start() {
    this.timer = setInterval(() => void this.save(), 60_000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
