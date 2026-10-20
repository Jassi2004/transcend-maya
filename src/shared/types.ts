export type ScenarioId =
  | "capacity-regression"
  | "health-route"
  | "pool-exhaustion"
  | "priority-inversion"
  | "expired-credential";
export type RunStatus =
  | "running"
  | "awaiting_approval"
  | "resolved"
  | "rejected"
  | "escalated"
  | "failed"
  | "interrupted";
export interface Company {
  id: string;
  name: string;
  stack: string;
  runtime: string;
  revision: number;
  connector: "simulation" | "company-a" | "company-b";
  createdAt: string;
}
export interface Check {
  name: string;
  expected: string | number | boolean;
  actual: string | number | boolean;
  passed: boolean;
}
export interface Fixture {
  capacity: number;
  expectedCapacity: number;
  configuredPath: string;
  healthPath: string;
  poolSize: number;
  parallel: number;
  maxConnections: number;
  credentialValid: boolean;
  priority: string;
}
export interface Scenario {
  id: ScenarioId;
  title: string;
  description: string;
  category: string;
  severity: "high" | "medium";
  signal: string;
  patch: Partial<Fixture> | null;
  metric: string;
}
export interface Incident {
  id: string;
  companyId: string;
  scenario: ScenarioId;
  title: string;
  status: string;
  context: Fixture;
  evidence: string[];
  faultId?: string;
  createdAt: string;
}
export interface Step {
  id: string;
  agent: string;
  title: string;
  detail: string;
  state: "complete" | "warning";
  at: string;
  data?: unknown;
}
export interface Proposal {
  patch: Partial<Fixture>;
  before: Fixture;
  after: Fixture;
  digest: string;
  action: string;
  scope: string;
}
export interface Verification {
  baseline: Check[];
  candidate: Check[];
  live?: Check[];
  liveBefore?: Check[];
  liveAfter?: Check[];
  livePhase?: "before_repair" | "after_repair";
}
export interface MemoryMatch {
  kind: "new" | "reused" | "rejected";
  lessonId?: string;
  reason: string;
}
export interface Run {
  id: string;
  companyId: string;
  incidentId: string;
  status: RunStatus;
  stage: string;
  mode: "simulation" | "connected";
  contextRevision: number;
  runtime: string;
  scenario: ScenarioId;
  steps: Step[];
  proposal: Proposal | null;
  verification: Verification | null;
  memory: MemoryMatch;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  faultId?: string;
  approval?: { digest: string; reason: string; at: string };
  recoveryRechecked?: boolean;
}
export interface Lesson {
  id: string;
  companyId: string;
  scenario: ScenarioId;
  runtime: string;
  version: number;
  status: "candidate" | "active" | "retired";
  title: string;
  patch: Partial<Fixture>;
  sourceRunId: string;
  createdAt: string;
  expiresAt: string;
}
export interface Audit {
  id: number;
  companyId: string;
  kind: string;
  message: string;
  details: unknown;
  createdAt: string;
}
export interface DuoReview {
  id: string;
  companyId: string;
  runId: string;
  evidenceDigest: string;
  evidence: unknown;
  projectPath: string;
  status: string;
  sessionId?: string;
  webUrl?: string;
  messages: {
    componentName: string | null;
    messageType: string;
    content: string;
  }[];
  executionVerified: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Snapshot {
  companies: Company[];
  company: Company;
  incidents: Incident[];
  runs: Run[];
  lessons: Lesson[];
  audit: Audit[];
  scenarios: Scenario[];
  connection: { configured: boolean; label: string };
  metrics: {
    resolved: number;
    awaiting: number;
    activeLessons: number;
    reused: number;
    staleRejected: number;
  };
  engine: {
    provider: "deterministic";
    duoConnected: boolean;
    duoConfigured?: boolean;
  };
  duoReviews?: DuoReview[];
}
