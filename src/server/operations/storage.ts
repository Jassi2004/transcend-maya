import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { Store } from "../store.js";
import type { EvidenceFile } from "../../shared/operations.js";
import { DomainError } from "../engine.js";

export const sha256 = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export const timestamp = () => new Date().toISOString();
export function redact(text: string): string {
  return text
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{10,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(
      /((?:authorization|password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[=:]\s*)[^\s,;"'}]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@");
}
export const safeSourcePath = (path: string) =>
  path.length <= 240 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.split("/").some((part) => !part || part === "." || part === "..") &&
  !/(^|\/)\.git(\/|$)|(^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\.json)?|secrets?\.(?:json|ya?ml)|.*\.(?:pem|key|p12|pfx))$/i.test(
    path,
  );

export class OpsStorage {
  private readonly encryptionKey: Buffer;
  constructor(
    readonly store: Store,
    secret: string,
  ) {
    this.encryptionKey = createHash("sha256")
      .update(`maya-credentials-v2:${secret}`)
      .digest();
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS ops_records(id TEXT PRIMARY KEY, companyId TEXT NOT NULL REFERENCES companies(id), kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ops_scope ON ops_records(companyId,kind);
      CREATE TABLE IF NOT EXISTS ops_credentials(id TEXT PRIMARY KEY,companyId TEXT NOT NULL REFERENCES companies(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ops_dedup(key TEXT PRIMARY KEY,companyId TEXT NOT NULL REFERENCES companies(id),recordId TEXT NOT NULL);`);
  }
  save<T extends { id: string; companyId: string }>(
    kind: string,
    record: T,
  ): T {
    const old = this.store.db
      .prepare("SELECT companyId,kind FROM ops_records WHERE id=?")
      .get(record.id);
    if (old && (old.companyId !== record.companyId || old.kind !== kind))
      throw new DomainError(409, "Record scope cannot change.");
    this.store.db
      .prepare(
        "INSERT INTO ops_records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(record.id, record.companyId, kind, JSON.stringify(record));
    return record;
  }
  list<T>(kind: string, companyId: string): T[] {
    return this.store.db
      .prepare(
        "SELECT data FROM ops_records WHERE companyId=? AND kind=? ORDER BY rowid DESC",
      )
      .all(companyId, kind)
      .map((r) => JSON.parse(String(r.data)));
  }
  get<T>(kind: string, companyId: string, id: string): T {
    const row = this.store.db
      .prepare(
        "SELECT data FROM ops_records WHERE id=? AND companyId=? AND kind=?",
      )
      .get(id, companyId, kind);
    if (!row) throw new DomainError(404, "Record not found in this workspace.");
    return JSON.parse(String(row.data));
  }
  credential(
    companyId: string,
    id: string,
  ): Record<string, string> | undefined {
    const row = this.store.db
      .prepare("SELECT data FROM ops_credentials WHERE id=? AND companyId=?")
      .get(id, companyId);
    if (!row) return undefined;
    const value = JSON.parse(String(row.data));
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.encryptionKey,
        Buffer.from(value.iv, "hex"),
      );
      decipher.setAAD(Buffer.from(`${companyId}:${id}`));
      decipher.setAuthTag(Buffer.from(value.tag, "hex"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(value.value, "hex")),
          decipher.final(),
        ]).toString(),
      );
    } catch {
      throw new DomainError(
        503,
        "Stored credentials cannot be opened. Restore the original encryption key or reconnect this integration.",
      );
    }
  }
  setCredential(companyId: string, id: string, values: Record<string, string>) {
    const old = this.store.db
      .prepare("SELECT companyId FROM ops_credentials WHERE id=?")
      .get(id);
    if (old && old.companyId !== companyId)
      throw new DomainError(409, "Credential scope cannot change.");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(`${companyId}:${id}`));
    const value = Buffer.concat([
      cipher.update(JSON.stringify(values)),
      cipher.final(),
    ]);
    this.store.db
      .prepare(
        "INSERT INTO ops_credentials VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        id,
        companyId,
        JSON.stringify({
          iv: iv.toString("hex"),
          tag: cipher.getAuthTag().toString("hex"),
          value: value.toString("hex"),
        }),
      );
  }
  removeCredential(companyId: string, id: string) {
    this.store.db
      .prepare("DELETE FROM ops_credentials WHERE id=? AND companyId=?")
      .run(id, companyId);
  }
  dedup(companyId: string, key: string): string | undefined {
    return this.store.db
      .prepare("SELECT recordId FROM ops_dedup WHERE key=? AND companyId=?")
      .get(`${companyId}:${key}`, companyId)?.recordId as string | undefined;
  }
  remember(companyId: string, key: string, recordId: string) {
    this.store.db
      .prepare("INSERT OR IGNORE INTO ops_dedup VALUES(?,?,?)")
      .run(`${companyId}:${key}`, companyId, recordId);
  }
  evidence(
    input: Omit<EvidenceFile, "id" | "createdAt" | "digest">,
  ): EvidenceFile {
    const content = redact(input.content).slice(0, 120_000);
    const record = {
      ...input,
      content,
      id: randomUUID(),
      digest: sha256(content),
      createdAt: timestamp(),
    };
    return this.save("evidence", record);
  }
}
