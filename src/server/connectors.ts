import type { Check, Company, ScenarioId } from "../shared/types.js";
export interface ConnectionConfig {
  url: string;
  token: string;
}
export type Connections = Partial<
  Record<"company-a" | "company-b", ConnectionConfig>
>;
export class Connectors {
  constructor(readonly configs: Connections = {}) {}
  config(company: Company) {
    return company.connector === "simulation"
      ? undefined
      : this.configs[company.connector];
  }
  async request(
    company: Company,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const config = this.config(company);
    if (!config) throw new Error("This company has no configured connector.");
    const response = await fetch(new URL(path, config.url), {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(75000),
      redirect: "error",
    });
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error("Connector returned an invalid response.");
    }
    return { status: response.status, body: result };
  }
  allowed(company: Company, scenario: ScenarioId) {
    return company.connector === "company-a"
      ? scenario === "capacity-regression"
      : company.connector === "company-b"
        ? scenario === "priority-inversion"
        : true;
  }
  async inject(company: Company, scenario: ScenarioId) {
    if (!this.allowed(company, scenario))
      throw new Error("This connector does not support that scenario.");
    const result = await this.request(company, "/api/demo/fault", {
      kind: scenario,
    });
    if (result.status !== 200)
      throw new Error(`Fault injection refused (HTTP ${result.status}).`);
  }
  async repair(company: Company, expectedFault: ScenarioId) {
    const result = await this.request(company, "/api/demo/fault", {
      kind: "none",
      expectedFault,
    });
    if (result.status !== 200)
      throw new Error(`Repair refused (HTTP ${result.status}).`);
  }
  async verify(company: Company): Promise<Check[]> {
    const health = await this.request(company, "/api/health");
    const checks: Check[] = [
      {
        name: "Live service health returns HTTP 200",
        expected: 200,
        actual: health.status,
        passed: health.status === 200,
      },
    ];
    if (company.connector === "company-a") {
      const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const slots = await this.request(
        company,
        `/api/slots?serviceId=consultation&date=${date}`,
      );
      const capacity = Array.isArray(slots.body)
        ? slots.body.reduce(
            (n: number, s: { remaining: number }) => Math.max(n, s.remaining),
            0,
          )
        : 0;
      checks.push({
        name: "Live consultation has a bookable seat",
        expected: true,
        actual: capacity > 0,
        passed: slots.status === 200 && capacity > 0,
      });
    } else if (company.connector === "company-b") {
      const result = await this.request(
        company,
        "/api/classify?severity=critical",
      );
      const priority = result.body.priority;
      checks.push({
        name: "Live classifier routes critical tickets correctly",
        expected: "critical",
        actual: priority ?? "unknown",
        passed: result.status === 200 && priority === "critical",
      });
    }
    return checks;
  }
  async observe(company: Company) {
    const health = await this.request(company, "/api/health");
    return [
      `source=live-http service=${company.connector} status=${health.status}`,
      `reported_fault=${String(health.body.fault || "none")}`,
      `observed_at=${new Date().toISOString()}`,
    ];
  }
}
