#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import express from "express";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { Connectors, type Connections } from "./connectors.js";
import { createApp } from "./app.js";
import { DuoBridge, glabRequest, tokenRequest } from "./duo.js";
import { OpsStorage } from "./operations/storage.js";
import { Operations } from "./operations/service.js";
import { GitLabBackup } from "./operations/backup.js";
import { gitlabRest } from "./operations/gitlab.js";
import { Workforce } from "./operations/workforce.js";
if (process.argv.includes("--help")) {
  console.log(
    "MAYA — Multi-Agent Yard for Automation\n\nUsage: maya [--port 4200] [--data /path/to/maya.sqlite]\n\nEnvironment: PORT, HOST, DATABASE_PATH, MAYA_ACCESS_TOKEN, COMPANY_A_URL, COMPANY_A_TOKEN, COMPANY_B_URL, COMPANY_B_TOKEN\nDelivery workforce: MAYA_DUO_PROJECT_ID, MAYA_DUO_PROJECT_PATH, MAYA_DUO_CONSUMER_ID, MAYA_OPS_CONSUMER_ID, plus MAYA_DUO_AUTH=glab (local) or MAYA_GITLAB_TOKEN (server-only).\nNode.js 24+ required. Repository repair proposals run in GitLab Duo. The legacy simulation lab is available at /?lab=1.",
  );
  process.exit(0);
}
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const port = Number(arg("--port") || process.env.PORT || 4200),
  host = process.env.HOST || "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be between 1 and 65535.");
if (
  !["localhost", "127.0.0.1", "::1"].includes(host) &&
  !process.env.MAYA_ACCESS_TOKEN
)
  throw new Error(
    "A network-exposed MAYA instance requires MAYA_ACCESS_TOKEN.",
  );
const configs: Connections = {};
for (const [key, prefix] of [
  ["company-a", "COMPANY_A"],
  ["company-b", "COMPANY_B"],
] as const) {
  const url = process.env[`${prefix}_URL`],
    token = process.env[`${prefix}_TOKEN`];
  if (url) {
    if (!token)
      throw new Error(`${prefix}_TOKEN is required for a connected company.`);
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error(
        "Connector URLs must be HTTP(S) and contain no credentials.",
      );
    configs[key] = { url, token };
  }
}
const defaultData = resolve(homedir(), ".maya", "data", "maya.sqlite");
const store = new Store(
  arg("--data") || process.env.DATABASE_PATH || defaultData,
);
store.recover();
if (!store.companies().length) {
  const c = {
    id: "company-a",
    name: "Company A",
    stack: "TypeScript · React · SQLite",
    runtime: "Node.js 24",
    revision: 1,
    connector: configs["company-a"]
      ? ("company-a" as const)
      : ("simulation" as const),
    createdAt: new Date().toISOString(),
  };
  store.saveCompany(c);
  store.audit(c.id, "company.onboarded", "Company A workspace initialized.", {
    connector: c.connector,
  });
}
if (
  configs["company-b"] &&
  !store.companies().some((c) => c.connector === "company-b")
) {
  const c = {
    id: "company-b",
    name: "Company B",
    stack: "Python · FastAPI · SQLite",
    runtime: "Python 3.12",
    revision: 1,
    connector: "company-b" as const,
    createdAt: new Date().toISOString(),
  };
  store.saveCompany(c);
  store.audit(
    c.id,
    "company.onboarded",
    "Company B live connector configured.",
    { connector: c.connector },
  );
}
const engine = new Engine(
  store,
  new Connectors(configs),
  Number(process.env.MAYA_STEP_DELAY_MS || 550),
);
let duo: DuoBridge | undefined;
let workforce: Workforce | undefined;
const opsStorage = new OpsStorage(
  store,
  process.env.MAYA_ENCRYPTION_KEY ||
    process.env.MAYA_ACCESS_TOKEN ||
    "local-development-only",
);
if (process.env.MAYA_DUO_PROJECT_ID) {
  const projectPath = process.env.MAYA_DUO_PROJECT_PATH,
    consumerId = process.env.MAYA_DUO_CONSUMER_ID;
  if (!projectPath || !consumerId)
    throw new Error(
      "Duo needs MAYA_DUO_PROJECT_PATH and MAYA_DUO_CONSUMER_ID.",
    );
  if (
    process.env.MAYA_DUO_AUTH === "glab" &&
    !["localhost", "127.0.0.1", "::1"].includes(host)
  )
    throw new Error(
      "glab authentication is limited to a loopback MAYA instance. Use a dedicated server-side token for hosting.",
    );
  const request =
    process.env.MAYA_DUO_AUTH === "glab"
      ? glabRequest
      : process.env.MAYA_GITLAB_TOKEN
        ? tokenRequest(process.env.MAYA_GITLAB_TOKEN)
        : undefined;
  if (!request)
    throw new Error(
      "Duo needs local glab authentication or MAYA_GITLAB_TOKEN.",
    );
  duo = new DuoBridge(
    engine,
    { projectId: process.env.MAYA_DUO_PROJECT_ID, projectPath, consumerId },
    request,
  );
  workforce = new Workforce(
    opsStorage,
    {
      projectId: process.env.MAYA_DUO_PROJECT_ID,
      projectPath,
      consumerId:
        process.env.MAYA_OPS_CONSUMER_ID ||
        (process.env.MAYA_DUO_PROJECT_ID === "87777593"
          ? "12824897"
          : consumerId),
    },
    request,
  );
}
if (
  process.env.MAYA_GITHUB_AUTH === "gh" &&
  !["localhost", "127.0.0.1", "::1"].includes(host)
)
  throw new Error(
    "GitHub CLI authentication is limited to a loopback instance. Use per-workspace tokens or MAYA_GITHUB_TOKEN for hosting.",
  );
const backupProject =
  process.env.MAYA_BACKUP_PROJECT_ID ||
  (process.env.RENDER ? process.env.MAYA_DUO_PROJECT_ID : undefined);
const backup = backupProject
  ? new GitLabBackup(
      opsStorage,
      gitlabRest(
        process.env.MAYA_GITLAB_TOKEN,
        process.env.MAYA_DUO_AUTH === "glab",
      ),
      backupProject,
      process.env.MAYA_ENCRYPTION_KEY || process.env.MAYA_ACCESS_TOKEN || "",
    )
  : undefined;
await backup?.restore();
backup?.start();
const operations = new Operations(opsStorage, {
  githubToken: process.env.MAYA_GITHUB_TOKEN,
  githubCli: process.env.MAYA_GITHUB_AUTH === "gh",
  gitlabToken: process.env.MAYA_GITLAB_TOKEN,
  gitlabCli: process.env.MAYA_DUO_AUTH === "glab",
  workforce,
  durableStorage:
    process.env.MAYA_DURABLE_STORAGE === "true" || !process.env.RENDER,
  storageStatus: () =>
    backup
      ? {
          mode: "encrypted-checkpoint",
          lastSavedAt: backup.lastSavedAt,
          error: backup.error,
        }
      : { mode: process.env.RENDER ? "ephemeral" : "local-disk" },
});
operations.start();
const app = createApp(engine, {
  accessToken: process.env.MAYA_ACCESS_TOKEN,
  secureCookie: process.env.SECURE_COOKIE === "true",
  duo,
  operations,
});
let vite: { close: () => Promise<void> } | undefined;
const client = fileURLToPath(new URL("../client", import.meta.url));
if (existsSync(resolve(client, "index.html"))) {
  app.use(express.static(client));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve(client, "index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const server = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  vite = server;
  app.use(server.middlewares);
}
const server = app.listen(port, host, () =>
  console.log(
    `MAYA → http://${host}:${port} · repository operations · Duo workforce ${workforce ? "configured" : "not configured"} · lab available at /?lab=1`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    operations.stop();
    backup?.stop();
    server.close(async () => {
      await engine.idle();
      await backup?.save();
      await vite?.close();
      store.db.close();
      process.exit(0);
    });
  });
