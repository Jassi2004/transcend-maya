import { spawn } from "node:child_process";
import { GitHub, type GitHubTransport } from "./github.js";
import { DomainError } from "../engine.js";
import { safeSourcePath } from "./storage.js";

export type GitLabRest = (
  path: string,
  method?: string,
  body?: unknown,
  raw?: boolean,
) => Promise<any>;
export function parseGitLabUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new DomainError(400, "Paste a complete GitLab repository URL.");
  }
  const path = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
  if (
    url.protocol !== "https:" ||
    url.hostname !== "gitlab.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:[\w.-]+\/)+[\w.-]+$/.test(path) ||
    path.split("/").some((p) => p === "." || p === ".." || p === "-")
  )
    throw new DomainError(
      400,
      "Use the GitLab.com project URL without a branch, query or credentials.",
    );
  const fullName = path.slice(1);
  return {
    owner: fullName.split("/").slice(0, -1).join("/"),
    name: fullName.split("/").at(-1)!,
    fullName,
    url: `https://gitlab.com/${fullName}`,
  };
}
export function gitlabRest(token?: string, cli = false): GitLabRest {
  return async (path, method = "GET", body, raw = false) => {
    if (!/^projects\//.test(path) || path.includes("..") || path.includes("\\"))
      throw new Error("Invalid GitLab REST path.");
    if (cli && !token)
      return new Promise((resolve, reject) => {
        const args = [
          "api",
          path,
          "--hostname",
          "gitlab.com",
          "--method",
          method,
        ];
        if (body !== undefined) args.push("--input", "-");
        const child = spawn("glab", args, { stdio: ["pipe", "pipe", "pipe"] });
        let output = "",
          diagnostic = "";
        child.stderr.on("data", (chunk) => {
          diagnostic += chunk.toString().slice(0, 3000);
        });
        const timer = setTimeout(() => child.kill(), 40_000);
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          if (output.length > 5_000_000) child.kill();
        });
        child.on("error", () => {
          clearTimeout(timer);
          reject(new DomainError(503, "GitLab CLI is unavailable."));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0)
            return reject(
              new DomainError(
                /HTTP 404/.test(diagnostic)
                  ? 404
                  : /HTTP (401|403)/.test(diagnostic)
                    ? 403
                    : 502,
                "GitLab request failed. Check project access and permissions.",
              ),
            );
          try {
            resolve(raw ? output : output.trim() ? JSON.parse(output) : {});
          } catch {
            reject(new DomainError(502, "GitLab returned unreadable JSON."));
          }
        });
        child.stdin.on("error", () => {});
        child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const res = await fetch(`https://gitlab.com/api/v4/${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok)
      throw new DomainError(
        [401, 403].includes(res.status) ? 403 : res.status === 404 ? 404 : 502,
        `GitLab returned HTTP ${res.status}. Check project access and token permissions.`,
      );
    const text = await res.text();
    if (text.length > 5_000_000)
      throw new DomainError(413, "GitLab response exceeds the size limit.");
    return raw ? text : text.trim() ? JSON.parse(text) : {};
  };
}
const conclusion = (status: string) =>
  ({
    failed: "failure",
    canceled: "cancelled",
    success: "success",
    skipped: "skipped",
  })[status] || null;
const normalizePr = (mr: any) => ({
  number: mr.iid,
  html_url: mr.web_url,
  head: { sha: mr.diff_refs?.head_sha || mr.sha },
  base: { ref: mr.target_branch },
  state:
    mr.state === "opened"
      ? "open"
      : mr.state === "merged"
        ? "closed"
        : mr.state,
  merged: mr.state === "merged",
  merged_at: mr.merged_at,
  merge_commit_sha:
    mr.merge_commit_sha ||
    mr.squash_commit_sha ||
    (mr.state === "merged" ? mr.sha : null),
  mergeable: ["cannot_be_merged", "conflict"].includes(mr.merge_status)
    ? false
    : mr.merge_status === "can_be_merged"
      ? true
      : null,
});

/** Normalizes forge operations so the same evidence/approval engine works on both hosts. */
export class GitLab extends GitHub {
  constructor(readonly api: GitLabRest) {
    const request: GitHubTransport = async (
      path,
      method = "GET",
      body: any,
      raw = false,
    ) => {
      const parsed = new URL(path, "https://api.github.com");
      const match =
        /^\/repos\/(.+?)(\/(?:contents|git|commits|actions|pulls|languages|deployments|hooks)(?:\/.*)?|$)/.exec(
          parsed.pathname,
        );
      if (!match) throw new Error("Unsupported forge operation.");
      const fullName = match[1],
        suffix = match[2],
        base = `projects/${encodeURIComponent(fullName)}`;
      if (!suffix) {
        const p = await api(base);
        return {
          ...p,
          private: p.visibility !== "public",
          default_branch: p.default_branch,
        };
      }
      if (suffix === "/languages") return api(`${base}/languages`);
      if (suffix.startsWith("/commits/")) {
        const commit = await api(
          `${base}/repository/commits/${suffix.slice(9)}`,
        );
        return { ...commit, sha: commit.id };
      }
      if (suffix.startsWith("/contents/")) {
        const file = await api(
          `${base}/repository/files/${encodeURIComponent(decodeURIComponent(suffix.slice(10)))}?ref=${encodeURIComponent(parsed.searchParams.get("ref") || "HEAD")}`,
        );
        return { ...file, type: "file", sha: file.blob_id };
      }
      if (suffix.startsWith("/git/trees/")) {
        const sha = suffix.slice(11),
          result: any[] = [];
        for (let page = 1; page <= 120; page++) {
          const rows = await api(
            `${base}/repository/tree?ref=${encodeURIComponent(sha)}&recursive=true&per_page=100&page=${page}`,
          );
          result.push(...rows.map((r: any) => ({ ...r, sha: r.id, size: 0 })));
          if (rows.length < 100) return { tree: result, truncated: false };
        }
        return { tree: result, truncated: true };
      }
      if (suffix === "/actions/runs") {
        const rows = await api(`${base}/pipelines?per_page=15`);
        return {
          workflow_runs: rows.map((p: any) => ({
            id: p.id,
            run_attempt: 1,
            name: `Pipeline #${p.iid || p.id}`,
            run_number: p.iid || p.id,
            head_branch: p.ref,
            head_sha: p.sha,
            conclusion: conclusion(p.status),
            html_url: p.web_url,
            created_at: p.created_at,
            status: p.status,
          })),
        };
      }
      let m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(suffix);
      if (m) {
        const jobs = await api(`${base}/pipelines/${m[1]}/jobs?per_page=100`);
        return {
          jobs: jobs.map((j: any) => ({
            ...j,
            conclusion: conclusion(j.status),
            html_url: j.web_url,
          })),
        };
      }
      m = /^\/actions\/jobs\/(\d+)\/logs$/.exec(suffix);
      if (m) return api(`${base}/jobs/${m[1]}/trace`, "GET", undefined, true);
      if (suffix === "/pulls" && method === "POST")
        return normalizePr(
          await api(`${base}/merge_requests`, "POST", {
            source_branch: body.head,
            target_branch: body.base,
            title: body.title,
            description: body.body,
            remove_source_branch: false,
          }),
        );
      if (suffix === "/pulls") {
        const branch = parsed.searchParams.get("head")?.split(":").at(-1);
        const mrs = await api(
          `${base}/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(branch || "")}`,
        );
        return mrs.map(normalizePr);
      }
      m = /^\/pulls\/(\d+)$/.exec(suffix);
      if (m) return normalizePr(await api(`${base}/merge_requests/${m[1]}`));
      m = /^\/pulls\/(\d+)\/merge$/.exec(suffix);
      if (m && method === "PUT") {
        const mr = await api(`${base}/merge_requests/${m[1]}/merge`, "PUT", {
          sha: body.sha,
          merge_commit_message: body.commit_title,
          should_remove_source_branch: false,
        });
        return {
          merged: mr.state === "merged",
          sha: mr.merge_commit_sha || mr.squash_commit_sha,
        };
      }
      if (suffix === "/deployments") {
        const sha = parsed.searchParams.get("sha");
        const rows = await api(
          `${base}/deployments?order_by=updated_at&sort=desc&per_page=10`,
        );
        return rows.filter(
          (d: any) => d.sha === sha || d.deployable?.commit?.id === sha,
        );
      }
      m = /^\/deployments\/(\d+)\/statuses$/.exec(suffix);
      if (m) {
        const d = await api(`${base}/deployments/${m[1]}`);
        return [
          {
            state: d.status,
            environment_url: d.environment?.external_url,
            created_at: d.updated_at,
          },
        ];
      }
      throw new DomainError(
        422,
        "This operation is not supported by the GitLab adapter.",
      );
    };
    super(request);
  }
  async commit(
    fullName: string,
    branch: string,
    baseSha: string,
    files: { path: string; content: string }[],
    message: string,
    existing = false,
  ) {
    if (files.some((f) => !safeSourcePath(f.path)))
      throw new DomainError(
        400,
        "The proposal contains a restricted file path.",
      );
    const data = await this.api(
      `projects/${encodeURIComponent(fullName)}/repository/commits`,
      "POST",
      {
        branch,
        ...(existing ? {} : { start_sha: baseSha }),
        commit_message: message,
        actions: files.map((f) => ({
          action: "update",
          file_path: f.path,
          content: f.content,
        })),
      },
    );
    if (
      !Array.isArray(data.parent_ids) ||
      data.parent_ids.length !== 1 ||
      data.parent_ids[0] !== baseSha
    )
      throw new DomainError(
        409,
        "The repair branch changed during the commit. Inspect the reserved branch; merging remains blocked.",
      );
    return data.id as string;
  }
  async checks(fullName: string, sha: string, releaseBranch?: string) {
    const base = `projects/${encodeURIComponent(fullName)}`;
    const pipelines = await this.api(
      `${base}/pipelines?sha=${sha}&per_page=5${releaseBranch ? `&ref=${encodeURIComponent(releaseBranch)}&source=push` : ""}`,
    );
    const pipeline = pipelines[0];
    if (!pipeline)
      return {
        sha,
        state: "missing" as const,
        items: [],
        at: new Date().toISOString(),
      };
    const jobs = await this.api(
      `${base}/pipelines/${pipeline.id}/jobs?per_page=100`,
    );
    const latest = new Map<string, any>();
    for (const j of jobs)
      if (!latest.has(j.name) || j.id > latest.get(j.name).id)
        latest.set(j.name, j);
    const items = [...latest.values()].map((j) => ({
      name: j.name,
      status:
        ["success", "failed", "canceled", "skipped"].includes(j.status) ||
        (j.status === "manual" && j.allow_failure)
          ? "completed"
          : "in_progress",
      conclusion:
        j.status === "manual" && j.allow_failure
          ? "skipped"
          : conclusion(j.status),
      url: j.web_url,
    }));
    return {
      sha,
      state:
        pipeline.status === "success"
          ? ("passing" as const)
          : ["failed", "canceled"].includes(pipeline.status)
            ? ("failing" as const)
            : ("pending" as const),
      items,
      at: new Date().toISOString(),
    };
  }
  async failingRun(fullName: string, sha: string): Promise<number | undefined> {
    const rows = await this.api(
      `projects/${encodeURIComponent(fullName)}/pipelines?sha=${sha}&status=failed&per_page=1`,
    );
    return rows[0]?.id;
  }
  async pagesUrl(fullName: string): Promise<string | undefined> {
    try {
      const data = await this.api(
        `projects/${encodeURIComponent(fullName)}/pages`,
      );
      if (data.url || data.deployments?.[0]?.url)
        return data.url || data.deployments?.[0]?.url;
    } catch {
      /* Developers can read deployment environments even when Pages settings are restricted. */
    }
    const deployments = await this.api(
      `projects/${encodeURIComponent(fullName)}/deployments?environment=staging&order_by=updated_at&sort=desc&per_page=5`,
    );
    return deployments.find(
      (d: any) => d.status === "success" && d.environment?.external_url,
    )?.environment.external_url;
  }
}
