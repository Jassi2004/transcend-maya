import type {
  Category,
  IntegrationConfig,
  Provider,
} from "../../shared/operations.js";
import { DomainError } from "../engine.js";
import { publicHttpsUrl, publicRequest } from "./network.js";

export interface Signal {
  id: string;
  title: string;
  summary: string;
  category: Category;
  severity: "low" | "medium" | "high";
  source: Provider | "operator";
  url?: string;
  commitSha?: string;
  payload: unknown;
}
const get = async (url: string, headers: Record<string, string>) => {
  const result = await publicRequest(url, headers, 1_000_000);
  if (result.status < 200 || result.status >= 300)
    throw new DomainError(
      502,
      `Integration returned HTTP ${result.status}. Check the endpoint and read permissions.`,
    );
  try {
    return JSON.parse(result.text);
  } catch {
    throw new DomainError(502, "Integration returned unreadable JSON.");
  }
};
export async function pollIntegration(
  config: IntegrationConfig,
  secrets: Record<string, string>,
): Promise<Signal[]> {
  const { settings: s, provider } = config;
  const bearer = { Authorization: `Bearer ${secrets.token}` };
  if (provider === "buildkite") {
    if (!s.organization || !s.pipeline || !secrets.token)
      throw new DomainError(
        400,
        "Buildkite needs an organization, pipeline and read_builds token.",
      );
    const data = await get(
      `https://api.buildkite.com/v2/organizations/${encodeURIComponent(s.organization)}/pipelines/${encodeURIComponent(s.pipeline)}/builds?state=failed&per_page=10`,
      bearer,
    );
    return data.map((b: any) => ({
      id: String(b.id),
      title: `Buildkite: ${b.pipeline?.name || s.pipeline} #${b.number} failed`,
      summary: String(b.message || "Build failed"),
      category: "ci",
      severity: "high",
      source: provider,
      url: b.web_url,
      commitSha: /^[a-f0-9]{40}$/.test(b.commit) ? b.commit : undefined,
      payload: {
        id: b.id,
        number: b.number,
        state: b.state,
        branch: b.branch,
        commit: b.commit,
        jobs: b.jobs?.map((j: any) => ({
          name: j.name,
          state: j.state,
          exit_status: j.exit_status,
        })),
      },
    }));
  }
  if (provider === "datadog") {
    const site = s.site || "datadoghq.com";
    if (
      ![
        "datadoghq.com",
        "datadoghq.eu",
        "us3.datadoghq.com",
        "us5.datadoghq.com",
        "ap1.datadoghq.com",
        "ap2.datadoghq.com",
      ].includes(site)
    )
      throw new DomainError(400, "Choose a supported Datadog site.");
    if (!secrets.apiKey || !secrets.appKey)
      throw new DomainError(
        400,
        "Datadog needs API and application keys with monitor read access.",
      );
    const data = await get(
      `https://api.${site}/api/v1/monitor?group_states=alert`,
      { "DD-API-KEY": secrets.apiKey, "DD-APPLICATION-KEY": secrets.appKey },
    );
    return data
      .filter((m: any) => m.overall_state === "Alert")
      .map((m: any) => ({
        id: `${m.id}:${m.overall_state_modified || m.modified}`,
        title: String(m.name),
        summary: String(m.message || "Monitor is alerting"),
        category: "runtime",
        severity: "high",
        source: provider,
        url: `https://app.${site}/monitors/${m.id}`,
        payload: {
          id: m.id,
          name: m.name,
          query: m.query,
          state: m.overall_state,
          tags: m.tags,
        },
      }));
  }
  if (provider === "incidentio") {
    if (!secrets.token)
      throw new DomainError(400, "incident.io needs a read-only API key.");
    const data = await get(
      "https://api.incident.io/v2/incidents?page_size=25",
      bearer,
    );
    return (data.incidents || [])
      .filter((i: any) =>
        ["live", "triage"].includes(i.incident_status?.category),
      )
      .map((i: any) => ({
        id: String(i.id),
        title: String(i.name),
        summary: String(i.summary || "Live incident"),
        category: "runtime",
        severity: "high",
        source: provider,
        url: i.permalink,
        payload: {
          id: i.id,
          name: i.name,
          summary: i.summary,
          status: i.incident_status,
          severity: i.severity,
        },
      }));
  }
  if (provider === "sentry") {
    if (!s.organization || !s.project || !secrets.token)
      throw new DomainError(
        400,
        "Sentry needs an organization, project and project:read API token.",
      );
    const data = await get(
      `https://sentry.io/api/0/projects/${encodeURIComponent(s.organization)}/${encodeURIComponent(s.project)}/issues/?query=is%3Aunresolved&limit=15`,
      bearer,
    );
    return data.map((i: any) => ({
      id: `${i.id}:${i.lastSeen}`,
      title: String(i.title),
      summary: String(i.culprit || i.metadata?.value || "Unresolved error"),
      category: "runtime",
      severity: i.level === "warning" ? "medium" : "high",
      source: provider,
      url: i.permalink,
      payload: {
        id: i.id,
        title: i.title,
        culprit: i.culprit,
        metadata: i.metadata,
        count: i.count,
        lastSeen: i.lastSeen,
      },
    }));
  }
  if (provider === "jenkins") {
    if (!s.url || !secrets.username || !secrets.token)
      throw new DomainError(
        400,
        "Jenkins needs a public HTTPS controller URL, user and API token.",
      );
    const base = publicHttpsUrl(s.url).toString().replace(/\/$/, "");
    const data = await get(
      `${base}/api/json?tree=jobs[name,url,lastBuild[number,result,timestamp,url]]`,
      {
        Authorization: `Basic ${Buffer.from(`${secrets.username}:${secrets.token}`).toString("base64")}`,
      },
    );
    return (data.jobs || [])
      .filter((j: any) => j.lastBuild?.result === "FAILURE")
      .map((j: any) => ({
        id: `${j.name}:${j.lastBuild.number}`,
        title: `Jenkins: ${j.name} #${j.lastBuild.number} failed`,
        summary:
          "The most recent build failed. Configure signed ingress with console logs for deeper investigation.",
        category: "ci",
        severity: "high",
        source: provider,
        url: j.lastBuild.url,
        payload: { name: j.name, build: j.lastBuild },
      }));
  }
  if (provider === "logrocket")
    throw new DomainError(
      400,
      "LogRocket uses signed event ingress. Configure its alert webhook rather than API polling.",
    );
  return [];
}
