import { test, expect, type Page } from "@playwright/test";
const sha = "a".repeat(40),
  blob = "b".repeat(40),
  digest = "c".repeat(64);
function fixture() {
  const repository = {
    id: "repo",
    companyId: "field",
    provider: "gitlab",
    owner: "demo",
    name: "field-store",
    fullName: "demo/field-store",
    url: "https://gitlab.com/demo/field-store",
    defaultBranch: "main",
    headSha: sha,
    private: false,
    description: "Small ecommerce store",
    languages: { JavaScript: 100 },
    stack: ["JavaScript"],
    files: [{ path: "lib/pricing.js", sha: blob }],
    sourceFiles: [],
    tools: [
      {
        id: "gitlab",
        name: "GitLab CI",
        paths: [".gitlab-ci.yml"],
        state: "connected",
        detail: "Pipeline status and failed job logs",
      },
    ],
    envNames: [],
    workflows: [
      {
        path: ".gitlab-ci.yml",
        name: "GitLab CI",
        jobs: ["test", "package", "deploy"],
      },
    ],
    monitoring: true,
    autoInvestigate: false,
    shareWithDuo: true,
    automationMode: "assisted",
    stagingPolicy: {
      branch: "main",
      environment: "staging",
      maxAttempts: 3,
      sourcePath: ".maya.yml",
    },
    createdAt: new Date().toISOString(),
    syncedAt: new Date().toISOString(),
  };
  const evidence = {
    id: "source-proof",
    companyId: "field",
    projectId: "repo",
    incidentId: "failure",
    kind: "source",
    name: "lib/pricing.js",
    commitSha: sha,
    digest,
    createdAt: new Date().toISOString(),
    content: JSON.stringify({
      path: "lib/pricing.js",
      sha: blob,
      content: "export const free = n => n > 50;\n",
    }),
  };
  const incident = {
    id: "failure",
    companyId: "field",
    projectId: "repo",
    fingerprint: "run-1",
    title: "Pipeline #2 failed",
    category: "ci",
    severity: "high",
    status: "awaiting_approval",
    source: "gitlab",
    sourceId: "run:2:1",
    sourceUrl: "https://gitlab.com/demo/field-store/-/pipelines/2",
    commitSha: sha,
    summary: "Unit test failed at the free-shipping boundary.",
    evidenceIds: [evidence.id],
    steps: [
      {
        id: "step",
        role: "investigator",
        title: "Failed test traced to pricing source",
        detail: "Observed expected 0, actual 799 in the real job trace.",
        at: new Date().toISOString(),
        evidenceIds: [evidence.id],
        state: "complete",
      },
    ],
    taskId: "task",
    matchedLessonIds: [],
    planDigest: digest,
    plan: {
      title: "Restore inclusive shipping threshold",
      category: "ci",
      rootCause: "The free-shipping boundary should be inclusive.",
      confidence: "high",
      evidenceIds: [evidence.id],
      files: [
        {
          path: "lib/pricing.js",
          originalSha: blob,
          content: "export const free = n => n >= 50;\n",
          rationale: "Match the advertised inclusive boundary.",
        },
      ],
      verification: ["npm test"],
      risks: ["The proposal has not run in CI."],
      questions: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const task = {
    id: "task",
    companyId: "field",
    projectId: "repo",
    incidentId: "failure",
    purpose: "investigate",
    state: "complete",
    sessionId: "42",
    url: "https://gitlab.com/demo/maya/-/automate/agent-sessions/42",
    evidenceDigest: digest,
    evidenceIds: [evidence.id],
    messages: [
      {
        role: "investigator",
        type: "agent",
        content:
          "Pricing source disagrees with the captured boundary assertion.",
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const snapshot = {
    companyId: "field",
    repository,
    incidents: [incident],
    tasks: [task],
    lessons: [],
    evidence: [{ ...evidence, content: undefined }],
    integrations: [],
    audit: [],
    capabilities: {
      githubRead: true,
      githubWrite: true,
      duo: true,
      continuousObserver: true,
      durableStorage: true,
    },
  };
  return { repository, evidence, incident, snapshot };
}
async function mock(page: Page, empty = false) {
  const state = fixture();
  const calls: { path: string; body: any }[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() === "POST") calls.push({ path, body: req.postDataJSON() });
    let body: unknown = {};
    if (path === "/api/meta") body = { authenticated: true };
    else if (path === "/api/companies")
      body = empty ? [] : [{ id: "field", name: "Field Supply" }];
    else if (path.endsWith("/snapshot")) body = state.snapshot;
    else if (path.endsWith("/evidence/source-proof")) body = state.evidence;
    else if (path.endsWith("/publish")) {
      state.incident.status = "pr_open";
      body = state.incident;
    } else if (path === "/api/ops/onboard") {
      empty = false;
      state.repository.shareWithDuo = false;
      body = { repository: state.repository };
    } else if (path.endsWith("/settings")) {
      Object.assign(state.repository, req.postDataJSON());
      body = state.repository;
    }
    await route.fulfill({ json: body });
  });
  return { state, calls };
}
test("delivery UI exposes actual source diff, evidence and an exact-artifact approval before publishing", async ({
  page,
}) => {
  const { calls } = await mock(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Delivery control." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Investigator Reads failed jobs & source" })
    .click();
  const inspector = page.getByRole("dialog", {
    name: "Investigator inspector",
  });
  await expect(
    inspector.getByText("Failed test traced to pricing source"),
  ).toBeVisible();
  await inspector.getByText("investigator · agent").click();
  await expect(
    inspector.getByText(
      "Pricing source disagrees with the captured boundary assertion.",
    ),
  ).toBeVisible();
  await inspector.getByRole("button", { name: "lib/pricing.js" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Evidence inspector" })
      .getByText("IMMUTABLE EVIDENCE"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: "Review 1 file changes" }).click();
  const diff = page.getByRole("dialog", { name: "Review source repair" });
  await expect(diff.locator(".added")).toContainText("n >= 50");
  await expect(diff.locator(".removed")).toContainText("n > 50");
  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(
    page.getByRole("button", { name: "Approve & create repair MR" }),
  ).toBeDisabled();
  await page
    .getByLabel("Publication review")
    .fill(
      "The change restores the tested boundary and preserves unrelated behaviour.",
    );
  await page
    .getByRole("button", { name: "Approve & create repair MR" })
    .click();
  await expect
    .poll(
      () => calls.find((call) => call.path.endsWith("/publish"))?.body.digest,
    )
    .toBe(digest);
  await expect(
    page.getByText("Publication requested for the reviewed artifact."),
  ).toBeVisible();
});

test("onboarding displays discovered jobs and requires separate source-sharing consent", async ({
  page,
}) => {
  const { calls } = await mock(page, true);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect your repository" }).click();
  await page
    .getByLabel("Repository URL")
    .fill("https://gitlab.com/demo/field-store");
  await page.getByRole("button", { name: "Discover repository" }).click();
  await expect(
    page.getByRole("heading", { name: "Here’s what MAYA found." }),
  ).toBeVisible();
  await expect(page.getByText("test → package → deploy")).toBeVisible();
  await expect(
    page.getByLabel("Automatically investigate new pipeline failures"),
  ).toBeDisabled();
  expect(
    calls.find((call) => call.path === "/api/ops/onboard")?.body.shareWithDuo,
  ).toBe(false);
  await page
    .getByLabel("Allow GitLab Duo to analyse repository evidence")
    .check();
  await page
    .getByLabel("Automatically investigate new pipeline failures")
    .check();
  await page.getByRole("button", { name: "Open delivery workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Delivery control." }),
  ).toBeVisible();
  expect(calls.find((call) => call.path.endsWith("/settings"))?.body).toEqual({
    shareWithDuo: true,
    autoInvestigate: true,
  });
});

test("company memory, source evidence and staging permissions remain inspectable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Delivery control." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Corrector Proposes reviewed lessons" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Corrector inspector" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Company memory", exact: true })
    .click();
  await expect(
    page.getByText("Learning starts with a verified repair"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Evidence library" }).click();
  await page.getByRole("button", { name: /lib\/pricing.js/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Evidence inspector" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: "Connections & policy" }).click();
  await expect(
    page.getByRole("button", { name: "Enable supervised staging" }),
  ).toBeDisabled();
  await page
    .getByLabel("Authorise supervised staging", { exact: false })
    .check();
  await expect(
    page.getByRole("button", { name: "Enable supervised staging" }),
  ).toBeEnabled();
});
