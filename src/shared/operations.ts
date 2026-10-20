export type Category =
  "ci" | "security" | "deployment" | "runtime" | "dependency";
export type Provider =
  | "github"
  | "gitlab"
  | "buildkite"
  | "jenkins"
  | "datadog"
  | "incidentio"
  | "logrocket"
  | "sentry"
  | "health";
export interface SourceFile {
  path: string;
  sha: string;
  content: string;
}
export interface DiscoveredTool {
  id: Provider | "render" | "docker" | "gitlab" | "vercel";
  name: string;
  paths: string[];
  state: "discovered" | "connected" | "needs_access";
  detail: string;
}
export interface Repository {
  provider: "github" | "gitlab";
  remoteProjectId?: number;
  id: string;
  companyId: string;
  owner: string;
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  headSha: string;
  private: boolean;
  description: string;
  languages: Record<string, number>;
  stack: string[];
  files: { path: string; sha: string; size?: number }[];
  sourceFiles: SourceFile[];
  tools: DiscoveredTool[];
  envNames: string[];
  workflows: { path: string; name: string; jobs: string[] }[];
  monitoring: boolean;
  autoInvestigate: boolean;
  shareWithDuo: boolean;
  automationMode: "assisted" | "supervised";
  stagingPolicy?: {
    branch: string;
    environment: string;
    maxAttempts: number;
    sourcePath: string;
  };
  healthUrl?: string;
  createdAt: string;
  syncedAt: string;
  lastObservedAt?: string;
  observationError?: string;
  lastHealth?: "healthy" | "unhealthy";
}
export interface EvidenceFile {
  id: string;
  companyId: string;
  incidentId?: string;
  projectId: string;
  kind:
    "source" | "log" | "signal" | "checks" | "report" | "approval" | "lesson";
  name: string;
  content: string;
  digest: string;
  sourceUrl?: string;
  commitSha?: string;
  createdAt: string;
}
export interface FileChange {
  path: string;
  originalSha: string;
  content: string;
  rationale: string;
}
export interface RepairPlan {
  title: string;
  category: Category;
  rootCause: string;
  confidence: "low" | "medium" | "high";
  evidenceIds: string[];
  files: FileChange[];
  verification: string[];
  risks: string[];
  questions: string[];
}
export interface OpsStep {
  id: string;
  role:
    | "observer"
    | "orchestrator"
    | "investigator"
    | "specialist"
    | "verifier"
    | "corrector"
    | "operator";
  title: string;
  detail: string;
  at: string;
  evidenceIds: string[];
  state: "running" | "complete" | "blocked" | "failed";
}
export interface OpsIncident {
  id: string;
  companyId: string;
  projectId: string;
  fingerprint: string;
  title: string;
  category: Category;
  severity: "low" | "medium" | "high";
  status:
    | "detected"
    | "investigating"
    | "needs_input"
    | "awaiting_approval"
    | "publishing"
    | "pr_open"
    | "verifying"
    | "resolved"
    | "rejected"
    | "escalated"
    | "unknown";
  source: Provider | "operator";
  sourceId: string;
  sourceUrl?: string;
  commitSha: string;
  summary: string;
  evidenceIds: string[];
  steps: OpsStep[];
  taskId?: string;
  plan?: RepairPlan;
  planDigest?: string;
  matchedLessonIds: string[];
  approval?: { digest: string; baseSha: string; reason: string; at: string };
  publication?: {
    branch: string;
    state: "reserved" | "committed" | "created" | "unknown";
    commitSha?: string;
    prNumber?: number;
    url?: string;
    error?: string;
  };
  checks?: {
    sha: string;
    state: "pending" | "passing" | "failing" | "missing";
    items: {
      name: string;
      status: string;
      conclusion: string | null;
      url?: string;
    }[];
    at: string;
  };
  merge?: {
    state: "merging" | "merged" | "unknown";
    sha?: string;
    at: string;
    reason: string;
  };
  deployment?: { state: string; url?: string; at: string };
  error?: string;
  createdAt: string;
  updatedAt: string;
  planBaseSha?: string;
  attempts?: {
    taskId: string;
    baseSha: string;
    digest: string;
    commitSha?: string;
    at: string;
  }[];
  deploymentProbe?: {
    url: string;
    expectedSha: string;
    actualSha?: string;
    passed: boolean;
    httpStatus: number;
    at: string;
  };
}
export interface AgentTask {
  id: string;
  companyId: string;
  projectId: string;
  incidentId: string;
  purpose: "investigate" | "reflect";
  state:
    | "submitting"
    | "running"
    | "complete"
    | "failed"
    | "unknown"
    | "needs_input";
  sessionId?: string;
  url?: string;
  remoteStatus?: string;
  evidenceDigest: string;
  evidenceIds: string[];
  messages: { role: string; type: string; content: string }[];
  report?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface OperationalLesson {
  id: string;
  companyId: string;
  projectId: string;
  incidentId: string;
  category: Category;
  title: string;
  symptoms: string;
  rootCause: string;
  guidance: string;
  status: "candidate" | "active" | "retired";
  version: number;
  stack: string[];
  sourceSha: string;
  evidenceIds: string[];
  createdAt: string;
  expiresAt: string;
  reviews: { action: string; reason: string; at: string }[];
}
export interface IntegrationConfig {
  id: string;
  companyId: string;
  projectId: string;
  provider: Provider;
  enabled: boolean;
  settings: Record<string, string>;
  hasCredentials: boolean;
  lastSyncAt?: string;
  lastError?: string;
}
export interface StorageStatus {
  mode: "encrypted-checkpoint" | "local-disk" | "ephemeral";
  lastSavedAt?: string;
  error?: string;
}
export interface OpsSnapshot {
  storage?: StorageStatus;
  companyId: string;
  repository?: Repository;
  incidents: OpsIncident[];
  tasks: AgentTask[];
  lessons: OperationalLesson[];
  evidence: Omit<EvidenceFile, "content">[];
  integrations: IntegrationConfig[];
  audit: {
    id: number;
    kind: string;
    message: string;
    createdAt: string;
    details: unknown;
  }[];
  capabilities: {
    githubRead: boolean;
    githubWrite: boolean;
    duo: boolean;
    continuousObserver: boolean;
    durableStorage: boolean;
  };
}
