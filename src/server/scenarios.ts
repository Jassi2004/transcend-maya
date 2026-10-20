import type { Check, Fixture, Scenario, ScenarioId } from "../shared/types.js";
export const scenarios: Scenario[] = [
  {
    id: "capacity-regression",
    title: "Booking capacity regression",
    description:
      "A configuration change sets available seats to zero. Valid reservations are rejected.",
    category: "CI / application",
    severity: "high",
    signal: "BOOKING_CAPACITY_ZERO",
    patch: { capacity: 4 },
    metric: "Seats available",
  },
  {
    id: "health-route",
    title: "Deployment health mismatch",
    description:
      "The deployment probes /health, but the application serves /api/health.",
    category: "Deployment",
    severity: "high",
    signal: "HEALTHCHECK_404",
    patch: { configuredPath: "/api/health" },
    metric: "Health probe",
  },
  {
    id: "pool-exhaustion",
    title: "Connection pool exhaustion",
    description:
      "A small database pool backs up under a controlled synthetic workload.",
    category: "Performance",
    severity: "medium",
    signal: "POOL_QUEUE_SATURATION",
    patch: { poolSize: 8 },
    metric: "Synthetic p95",
  },
  {
    id: "priority-inversion",
    title: "Support priority inversion",
    description:
      "Critical support tickets are classified as low priority after a configuration change.",
    category: "Application",
    severity: "high",
    signal: "CRITICAL_PRIORITY_LOW",
    patch: { priority: "critical" },
    metric: "Critical routing",
  },
  {
    id: "expired-credential",
    title: "Expired integration credential",
    description:
      "An external credential expired. The workforce must ask the owner to rotate it.",
    category: "Security / access",
    severity: "high",
    signal: "UPSTREAM_AUTH_401",
    patch: null,
    metric: "Authentication",
  },
];
export const scenarioById = (id: ScenarioId) =>
  scenarios.find((s) => s.id === id)!;
export function makeFixture(id: ScenarioId): Fixture {
  const fixture: Fixture = {
    capacity: 4,
    expectedCapacity: 4,
    configuredPath: "/api/health",
    healthPath: "/api/health",
    poolSize: 8,
    parallel: 24,
    maxConnections: 20,
    credentialValid: true,
    priority: "critical",
  };
  if (id === "capacity-regression") fixture.capacity = 0;
  if (id === "health-route") fixture.configuredPath = "/health";
  if (id === "pool-exhaustion") fixture.poolSize = 2;
  if (id === "priority-inversion") fixture.priority = "low";
  if (id === "expired-credential") fixture.credentialValid = false;
  return fixture;
}
const check = (
  name: string,
  expected: Check["expected"],
  actual: Check["actual"],
): Check => ({ name, expected, actual, passed: expected === actual });
export function verifyFixture(id: ScenarioId, f: Fixture): Check[] {
  switch (id) {
    case "capacity-regression": {
      const accepts = (n: number) => n > 0 && n <= f.capacity;
      return [
        check(
          "Configured capacity matches service contract",
          f.expectedCapacity,
          f.capacity,
        ),
        check(
          "A full valid booking is accepted",
          true,
          accepts(f.expectedCapacity),
        ),
        check(
          "Over-capacity reservation is rejected",
          false,
          accepts(f.expectedCapacity + 1),
        ),
      ];
    }
    case "health-route":
      return [
        check(
          "Deployment probe returns HTTP 200",
          200,
          f.configuredPath === f.healthPath ? 200 : 404,
        ),
        check(
          "Probe targets the application health contract",
          f.healthPath,
          f.configuredPath,
        ),
        check("Health contract remains unchanged", "/api/health", f.healthPath),
      ];
    case "pool-exhaustion":
      return [
        check(
          "Synthetic p95 stays within 200ms",
          true,
          Math.ceil(f.parallel / f.poolSize) * 40 <= 200,
        ),
        check(
          "Pool stays within database budget",
          true,
          f.poolSize <= f.maxConnections,
        ),
        check("Pool has positive capacity", true, f.poolSize > 0),
      ];
    case "priority-inversion":
      return [
        check(
          "Critical tickets retain critical priority",
          "critical",
          f.priority,
        ),
        check(
          "Critical tickets enter urgent queue",
          true,
          f.priority === "critical",
        ),
      ];
    case "expired-credential":
      return [
        check("Integration credential is valid", true, f.credentialValid),
      ];
  }
}
