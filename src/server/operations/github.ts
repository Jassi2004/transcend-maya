import { spawn } from "node:child_process";
import type { Repository, SourceFile } from "../../shared/operations.js";
import { DomainError } from "../engine.js";
import { safeSourcePath } from "./storage.js";
import { publicHttpsUrl, publicRequest } from "./network.js";

export function githubLogLocation(input: string) {
  const url = publicHttpsUrl(input);
  if (
    ![".blob.core.windows.net", ".githubusercontent.com"].some((suffix) =>
      url.hostname.endsWith(suffix),
    )
  )
    throw new DomainError(
      502,
      "GitHub returned an unexpected log destination.",
    );
  return url.toString();
}

export type GitHubTransport = (
  path: string,
  method?: string,
  body?: unknown,
  raw?: boolean,
) => Promise<any>;
export function parseGitHubUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new DomainError(400, "Paste a complete GitHub repository URL.");
  }
  const match = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    match[1] === "." ||
    match[2] === "."
  )
    throw new DomainError(
      400,
      "Use https://github.com/owner/repository without a branch, query or credentials.",
    );
  return {
    owner: match[1],
    name: match[2],
    fullName: `${match[1]}/${match[2]}`,
    url: `https://github.com/${match[1]}/${match[2]}`,
  };
}
export function githubTransport(
  token?: string,
  useCli = false,
): GitHubTransport {
  return async (path, method = "GET", body, raw = false) => {
    if (
      !/^\/(?:repos|user)(?:\/|$)/.test(path) ||
      path.includes("..") ||
      path.includes("\\")
    )
      throw new Error("Invalid GitHub API path.");
    if (useCli && !token)
      return new Promise((resolve, reject) => {
        const args = [
          "api",
          path,
          "--hostname",
          "github.com",
          "--method",
          method,
          "-H",
          "Accept: application/vnd.github+json",
          "-H",
          "X-GitHub-Api-Version: 2022-11-28",
        ];
        if (body !== undefined) args.push("--input", "-");
        const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
        let out = "",
          err = "";
        const timer = setTimeout(() => child.kill(), 35_000);
        child.stdout.on("data", (data) => {
          out += data.toString();
          if (out.length > 5_000_000) child.kill();
        });
        child.stderr.on("data", (data) => {
          err += data.toString().slice(0, 2000);
        });
        child.on("error", () => {
          clearTimeout(timer);
          reject(
            new DomainError(
              503,
              "GitHub CLI is unavailable. Connect a repository token.",
            ),
          );
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            const status = /HTTP (\d+)/.exec(err)?.[1];
            return reject(
              new DomainError(
                status === "404" ? 404 : status === "403" ? 403 : 502,
                `GitHub request failed${status ? ` (HTTP ${status})` : ""}. Check repository permissions.`,
              ),
            );
          }
          if (raw) return resolve(out);
          try {
            resolve(out.trim() ? JSON.parse(out) : {});
          } catch {
            reject(
              new DomainError(502, "GitHub returned an unreadable response."),
            );
          }
        });
        child.stdin.on("error", () => {});
        child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(35_000),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MAYA-Operations",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    });
    if (
      response.status === 302 &&
      raw &&
      method === "GET" &&
      /^\/repos\/[\w.-]+\/[\w.-]+\/actions\/jobs\/\d+\/logs$/.test(path)
    ) {
      // GitHub uses a short-lived signed object URL for Actions logs. Resolve
      // only the documented storage hosts, pin public DNS and never forward
      // the repository token or follow any further redirect.
      const location = githubLogLocation(
        response.headers.get("location") || "",
      );
      const log = await publicRequest(location, {}, 5_000_000);
      if (log.status !== 200)
        throw new DomainError(502, "GitHub Actions log download failed.");
      return log.text;
    }
    if (!response.ok)
      throw new DomainError(
        response.status === 404
          ? 404
          : response.status === 403 || response.status === 401
            ? 403
            : 502,
        `GitHub request failed (HTTP ${response.status}). ${response.status === 404 ? "The repository may be private; connect a token with access." : "Check token permissions and API limits."}`,
      );
    const text = await response.text();
    if (text.length > 5_000_000)
      throw new DomainError(413, "GitHub response is too large.");
    return raw ? text : text.trim() ? JSON.parse(text) : {};
  };
}

export class GitHub {
  constructor(readonly request: GitHubTransport) {}
  repo(fullName: string) {
    return this.request(`/repos/${fullName}`);
  }
  async head(fullName: string, branch: string): Promise<string> {
    return (
      await this.request(
        `/repos/${fullName}/commits/${encodeURIComponent(branch)}`,
      )
    ).sha;
  }
  async tree(fullName: string, sha: string) {
    const data = await this.request(
      `/repos/${fullName}/git/trees/${sha}?recursive=1`,
    );
    if (data.truncated)
      throw new DomainError(
        422,
        "Repository exceeds the current discovery limit. Connect a smaller service repository.",
      );
    return (data.tree || [])
      .filter((f: any) => f.type === "blob")
      .map((f: any) => ({
        path: String(f.path),
        sha: String(f.sha),
        size: Number(f.size || 0),
      })) as Repository["files"];
  }
  async file(fullName: string, path: string, ref: string): Promise<SourceFile> {
    if (
      !safeSourcePath(path) &&
      !/^(?:\.env\.(?:example|sample|template)|[^/]+\/\.env\.(?:example|sample|template))$/.test(
        path,
      )
    )
      throw new DomainError(400, "This file is excluded from agent access.");
    const file = await this.request(
      `/repos/${fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
    );
    if (
      Array.isArray(file) ||
      file.type !== "file" ||
      file.encoding !== "base64" ||
      file.size > 100_000
    )
      throw new DomainError(
        422,
        "This source file is not supported (text files up to 100 KB).",
      );
    const content = Buffer.from(file.content, "base64").toString("utf8");
    if (content.includes("\0"))
      throw new DomainError(422, "Binary source is not supported.");
    return { path, sha: file.sha, content };
  }
  async runs(fullName: string) {
    return (
      (await this.request(`/repos/${fullName}/actions/runs?per_page=15`))
        .workflow_runs || []
    );
  }
  async runEvidence(fullName: string, id: number) {
    const jobs =
      (
        await this.request(
          `/repos/${fullName}/actions/runs/${id}/jobs?per_page=30`,
        )
      ).jobs || [];
    const logs: { name: string; content: string }[] = [];
    for (const job of jobs
      .filter((j: any) => j.conclusion === "failure")
      .slice(0, 3)) {
      try {
        logs.push({
          name: `${job.name}.log`,
          content: (
            await this.request(
              `/repos/${fullName}/actions/jobs/${job.id}/logs`,
              "GET",
              undefined,
              true,
            )
          ).slice(-60_000),
        });
      } catch {
        logs.push({
          name: `${job.name}.json`,
          content: JSON.stringify(
            {
              conclusion: job.conclusion,
              steps: job.steps,
              note: "Job logs require authenticated Actions read access.",
            },
            null,
            2,
          ),
        });
      }
    }
    return { jobs, logs };
  }
  async checks(fullName: string, sha: string) {
    const [runs, statuses] = await Promise.all([
      this.request(`/repos/${fullName}/commits/${sha}/check-runs?per_page=100`),
      this.request(`/repos/${fullName}/commits/${sha}/status`),
    ]);
    const latest = new Map<string, any>();
    for (const c of runs.check_runs || []) {
      const key = `${c.app?.id}:${c.name}`;
      if (!latest.has(key) || c.id > latest.get(key).id) latest.set(key, c);
    }
    const items = [...latest.values()].map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion ?? null,
      url: c.html_url,
    }));
    for (const s of statuses.statuses || [])
      if (!items.some((i) => i.name === s.context))
        items.push({
          name: s.context,
          status: s.state === "pending" ? "in_progress" : "completed",
          conclusion:
            s.state === "success"
              ? "success"
              : s.state === "pending"
                ? null
                : "failure",
          url: s.target_url,
        });
    return {
      sha,
      state: !items.length
        ? ("missing" as const)
        : items.some((i) =>
              [
                "failure",
                "cancelled",
                "timed_out",
                "action_required",
                "startup_failure",
                "stale",
              ].includes(i.conclusion || ""),
            )
          ? ("failing" as const)
          : items.some((i) => i.status !== "completed" || !i.conclusion)
            ? ("pending" as const)
            : items.every((i) =>
                  ["success", "skipped", "neutral"].includes(
                    i.conclusion || "",
                  ),
                ) && items.some((i) => i.conclusion === "success")
              ? ("passing" as const)
              : ("missing" as const),
      items,
      at: new Date().toISOString(),
    };
  }
  pr(fullName: string, number: number) {
    return this.request(`/repos/${fullName}/pulls/${number}`);
  }
}
