import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import type {
  DiscoveredTool,
  Repository,
  SourceFile,
} from "../../shared/operations.js";
import { GitHub, parseGitHubUrl } from "./github.js";
import { parseGitLabUrl } from "./gitlab.js";
import { redact, safeSourcePath, timestamp } from "./storage.js";

const candidate = (path: string) =>
  !/(?:^|\/)(?:node_modules|vendor|dist|build|\.venv|coverage)\//.test(path) &&
  (/^(?:README(?:\.md)?|package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|render\.ya?ml|vercel\.json|netlify\.toml|Jenkinsfile|\.gitlab-ci\.yml|\.maya\.ya?ml|\.env\.(?:example|sample|template))$/i.test(
    path,
  ) ||
    /^\.github\/workflows\/[^/]+\.ya?ml$|^\.buildkite\/[^/]+\.ya?ml$/.test(
      path,
    ) ||
    /(?:^|\/)(?:package\.json|requirements\.txt|pyproject\.toml|Dockerfile|sentry\.[^/]+|datadog[^/]*|logrocket[^/]*)$/.test(
      path,
    ));
const toolRules: {
  id: DiscoveredTool["id"];
  name: string;
  file: RegExp;
  content?: RegExp;
  detail: string;
}[] = [
  {
    id: "github",
    name: "GitHub Actions",
    file: /^\.github\/workflows\//,
    detail:
      "Workflow runs and exact-commit checks. Private logs need Actions read access; opening PRs needs Contents and Pull requests write.",
  },
  {
    id: "buildkite",
    name: "Buildkite",
    file: /(?:^|\/)\.buildkite\//,
    detail:
      "Connect an organization, pipeline and read_builds token for live build signals.",
  },
  {
    id: "jenkins",
    name: "Jenkins",
    file: /(?:^|\/)Jenkinsfile$/,
    detail: "Connect your public HTTPS controller URL, user and API token.",
  },
  {
    id: "gitlab",
    name: "GitLab CI",
    file: /(?:^|\/)\.gitlab-ci\.yml$/,
    detail:
      "GitLab configuration discovered. Use signed event ingress for this source.",
  },
  {
    id: "render",
    name: "Render",
    file: /(?:^|\/)render\.ya?ml$/,
    detail:
      "Service definitions discovered. Deployment state is observed through GitHub deployments and configured health probes.",
  },
  {
    id: "docker",
    name: "Docker",
    file: /(?:^|\/)(Dockerfile|(?:docker-)?compose\.ya?ml)$/,
    detail:
      "Container configuration discovered. Repository commands are executed in your CI, never on MAYA's host.",
  },
  {
    id: "vercel",
    name: "Vercel",
    file: /(?:^|\/)vercel\.json$/,
    detail:
      "Configuration discovered. Connect deployment notifications through signed event ingress.",
  },
  {
    id: "datadog",
    name: "Datadog",
    file: /datadog/i,
    content: /(?:datadog|dd-trace|DD_API_KEY)/i,
    detail: "Connect API and application keys to read alerting monitors.",
  },
  {
    id: "incidentio",
    name: "incident.io",
    file: /incident[._-]?io/i,
    content: /incident\.io|INCIDENT_IO/i,
    detail: "Connect a read-only API key to import live incidents.",
  },
  {
    id: "logrocket",
    name: "LogRocket",
    file: /logrocket/i,
    content: /logrocket/i,
    detail:
      "Configure an authenticated webhook to receive error alerts. Discovery alone cannot access sessions.",
  },
  {
    id: "sentry",
    name: "Sentry",
    file: /sentry/i,
    content: /@sentry|sentry-sdk|SENTRY_DSN/i,
    detail:
      "Connect a Sentry organization, project and API token for unresolved errors.",
  },
];

export async function discover(
  github: GitHub,
  url: string,
  companyId: string,
): Promise<Repository> {
  const isGitLab = url.startsWith("https://gitlab.com/");
  const parsed = isGitLab ? parseGitLabUrl(url) : parseGitHubUrl(url);
  const metadata = await github.repo(parsed.fullName);
  const headSha = await github.head(parsed.fullName, metadata.default_branch);
  const [files, languages] = await Promise.all([
    github.tree(parsed.fullName, headSha),
    github.request(`/repos/${parsed.fullName}/languages`),
  ]);
  const candidates = files
    .filter((f) => candidate(f.path) && (f.size || 0) < 100_000)
    .slice(0, 35);
  const raw: SourceFile[] = [];
  // Bound concurrency so a monorepo cannot exhaust the GitHub API or process.
  for (let index = 0; index < candidates.length; index += 5) {
    const batch = await Promise.allSettled(
      candidates
        .slice(index, index + 5)
        .map((f) => github.file(parsed.fullName, f.path, headSha)),
    );
    for (const result of batch)
      if (result.status === "fulfilled") raw.push(result.value);
  }
  const tools: DiscoveredTool[] = [];
  for (const rule of toolRules) {
    const paths = [
      ...new Set([
        ...files.filter((f) => rule.file.test(f.path)).map((f) => f.path),
        ...raw.filter((f) => rule.content?.test(f.content)).map((f) => f.path),
      ]),
    ];
    if (paths.length)
      tools.push({
        id: rule.id,
        name: rule.name,
        paths: paths.slice(0, 12),
        state:
          rule.id === "github"
            ? "connected"
            : ["docker", "render", "vercel", "gitlab"].includes(rule.id)
              ? "discovered"
              : "needs_access",
        detail: rule.detail,
      });
  }
  const forge = isGitLab ? "gitlab" : "github";
  if (!tools.some((t) => t.id === forge))
    tools.unshift({
      id: forge,
      name: isGitLab ? "GitLab" : "GitHub",
      paths: [],
      state: "connected",
      detail: "Repository metadata is readable.",
    });
  for (const tool of tools) if (tool.id === forge) tool.state = "connected";
  const envNames = new Set<string>();
  const stack = new Set<string>(Object.keys(languages));
  const workflows: Repository["workflows"] = [];
  let stagingPolicy: Repository["stagingPolicy"];
  for (const file of raw) {
    for (const m of file.content.matchAll(
      /(?:process\.env\.?|os\.environ\.get\(["']|os\.getenv\(["']|\benv:\s*|\benv\.)([A-Z][A-Z0-9_]{2,})/g,
    ))
      envNames.add(m[1]);
    if (/\.env\.(example|sample|template)$/.test(file.path))
      for (const line of file.content.split("\n")) {
        const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/.exec(line);
        if (m) envNames.add(m[1]);
      }
    if (file.path.endsWith("package.json")) {
      try {
        const pkg = JSON.parse(file.content),
          deps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const [key, label] of Object.entries({
          react: "React",
          express: "Express",
          next: "Next.js",
          vite: "Vite",
          fastify: "Fastify",
          typescript: "TypeScript",
          prisma: "Prisma",
          "@nestjs/core": "NestJS",
        }))
          if (deps[key]) stack.add(label);
      } catch {
        /* Invalid manifests remain visible as evidence. */
      }
    }
    if (/requirements\.txt|pyproject\.toml/.test(file.path))
      for (const [pattern, label] of [
        [/fastapi/i, "FastAPI"],
        [/django/i, "Django"],
        [/flask/i, "Flask"],
      ] as const)
        if (pattern.test(file.content)) stack.add(label);
    if (/^\.github\/workflows\//.test(file.path)) {
      try {
        const yaml = parse(file.content, { maxAliasCount: 25 });
        workflows.push({
          path: file.path,
          name: String(yaml?.name || file.path),
          jobs: Object.keys(yaml?.jobs || {}),
        });
      } catch {
        workflows.push({ path: file.path, name: file.path, jobs: [] });
      }
    }
    if (file.path === ".gitlab-ci.yml") {
      try {
        const yaml = parse(file.content, { maxAliasCount: 25 });
        workflows.push({
          path: file.path,
          name: "GitLab CI/CD",
          jobs: Object.entries(yaml || {})
            .filter(
              ([key, value]) =>
                !key.startsWith(".") &&
                value &&
                typeof value === "object" &&
                !Array.isArray(value) &&
                ("script" in value || "trigger" in value),
            )
            .map(([key]) => key),
        });
      } catch {
        workflows.push({ path: file.path, name: "GitLab CI/CD", jobs: [] });
      }
    }
    if (/^\.maya\.ya?ml$/.test(file.path))
      try {
        const policy = parse(file.content, { maxAliasCount: 10 });
        if (
          typeof policy?.staging_branch === "string" &&
          policy.staging_environment === "staging" &&
          policy.production_requires_approval === true
        )
          stagingPolicy = {
            branch: policy.staging_branch,
            environment: "staging",
            maxAttempts: Math.min(
              3,
              Math.max(1, Number(policy.max_repair_attempts) || 2),
            ),
            sourcePath: file.path,
          };
      } catch {
        /* Missing/invalid policy disables supervised publication. */
      }
    if (/render\.ya?ml$/.test(file.path))
      try {
        const yaml = parse(file.content, { maxAliasCount: 25 });
        for (const svc of yaml?.services || [])
          for (const env of svc.envVars || [])
            if (/^[A-Z][A-Z0-9_]+$/.test(env.key)) envNames.add(env.key);
      } catch {
        /* Raw source remains inspectable. */
      }
  }
  // Never store .env template VALUES. Only variable names become operational context.
  const sourceFiles = raw
    .filter((f) => safeSourcePath(f.path))
    .map((f) => ({ ...f, content: redact(f.content).slice(0, 45_000) }));
  return {
    id: randomUUID(),
    companyId,
    ...parsed,
    provider: forge,
    remoteProjectId: isGitLab ? metadata.id : undefined,
    defaultBranch: metadata.default_branch,
    headSha,
    private: !!metadata.private,
    description: String(metadata.description || ""),
    languages,
    stack: [...stack],
    files: files.filter((f) => safeSourcePath(f.path)).slice(0, 12_000),
    sourceFiles,
    tools,
    envNames: [...envNames].sort(),
    workflows,
    monitoring: true,
    autoInvestigate: false,
    shareWithDuo: false,
    automationMode: "assisted",
    stagingPolicy,
    createdAt: timestamp(),
    syncedAt: timestamp(),
  };
}

export function prioritizeSource(repo: Repository, signal: string) {
  const ignore =
    /(?:^|\/)(?:node_modules|dist|build|vendor|coverage|\.venv)\/|(?:lock\.json|\.lock|\.svg|\.png|\.jpg|\.woff2?|\.map)$/;
  return repo.files
    .filter(
      (f) =>
        !ignore.test(f.path) &&
        safeSourcePath(f.path) &&
        (f.size || 0) < 50_000,
    )
    .map((f) => {
      const escaped = f.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const score = new RegExp(escaped, "i").test(signal)
        ? 100
        : signal.includes(f.path.split("/").at(-1) || "\0")
          ? 40
          : /test|spec/.test(f.path)
            ? 15
            : /src\/|app\.py|index\./.test(f.path)
              ? 10
              : 0;
      return { ...f, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 14);
}
