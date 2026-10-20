import type { Check, Company, ScenarioId } from "../shared/types.js";
export interface ConnectionConfig {
  url: string;
  token: string;
}
export type Connections = Partial<
  Record<"company-a" | "company-b", ConnectionConfig>
>;
export class ConnectorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
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
    if (typeof result.body.faultId !== "string" || !result.body.faultId)
      throw new Error(
        "The demo service must support fault identity before MAYA can control it.",
      );
    return result.body.faultId as string;
  }
  async repair(
    company: Company,
    expectedFault: ScenarioId,
    expectedFaultId: string,
  ) {
    if (!expectedFaultId)
      throw new Error(
        "Recapture this incident before approving a repair; its fault identity is missing.",
      );
    const result = await this.request(company, "/api/demo/fault", {
      kind: "none",
      expectedFault,
      expectedFaultId,
    });
    if (result.status !== 200)
      throw new ConnectorError(
        result.status,
        `Repair refused (HTTP ${result.status}).${result.status === 409 ? " The live fault changed; start a fresh investigation." : ""}`,
      );
  }
  async verify(company: Company): Promise<Check[]> {
    const health = await this.request(company, "/api/health");
    const checks: Check[] = [
      {
        name: "Live service reports healthy with no active fault",
        expected: `200 · healthy · ${company.connector} · none`,
        actual: `${health.status} · ${String(health.body.status)} · ${String(health.body.service)} · ${String(health.body.fault)}`,
        passed:
          health.status === 200 &&
          health.body.service === company.connector &&
          health.body.status === "healthy" &&
          health.body.fault === "none",
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
  async inspect(company: Company) {
    const health = await this.request(company, "/api/health");
    if (
      ![200, 503].includes(health.status) ||
      health.body.service !== company.connector ||
      typeof health.body.fault !== "string" ||
      typeof health.body.faultId !== "string"
    )
      throw new Error(
        "The connector did not return the expected service identity and fault evidence.",
      );
    return {
      fault: health.body.fault as string,
      faultId: health.body.faultId as string,
      evidence: [
        `source=live-http service=${company.connector} status=${health.status}`,
        `reported_fault=${String(health.body.fault || "none")}`,
        `fault_id=${health.body.faultId}`,
        `observed_at=${new Date().toISOString()}`,
      ],
    };
  }
}
