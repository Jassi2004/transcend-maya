import { test, expect } from "@playwright/test";

test("Duo sharing needs consent, retains the session, and displays reports as text without approving repairs", async ({
  page,
}) => {
  let review: any = null;
  let launches = 0;
  await page.route("**/api/companies/*/snapshot", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.engine.duoConfigured = true;
    snapshot.duoReviews = review ? [review] : [];
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/api/companies/*/runs/*/duo", async (route) => {
    launches++;
    expect(route.request().postDataJSON()).toEqual({ shareEvidence: true });
    const runId = route.request().url().split("/").at(-2)!;
    review = {
      id: "review",
      companyId: "company-a",
      runId,
      status: "RUNNING",
      executionVerified: false,
      evidenceDigest: "a".repeat(64),
      webUrl:
        "https://gitlab.com/example/showcase/-/automate/agent-sessions/99",
      sessionId: "99",
      messages: [],
    };
    await route.fulfill({ json: review });
  });
  await page.route("**/api/companies/*/runs/*/duo/refresh", async (route) => {
    review = {
      ...review,
      status: "FINISHED",
      executionVerified: true,
      messages: [
        {
          componentName: "supervisor",
          messageType: "agent",
          content:
            "<script>window.untrustedDuoRan=true</script> Read-only review complete.",
        },
      ],
    };
    await route.fulfill({ json: review });
  });
  await page.goto("/?lab=1");
  await page
    .getByRole("button", { name: "Inject incident", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Inject & investigate", exact: true })
    .click();
  const launch = page.getByRole("button", {
    name: "Review with GitLab Duo",
    exact: true,
  });
  await expect(launch).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Approve exact repair" }),
  ).toBeVisible();
  await page.getByLabel("Share this run’s evidence with GitLab Duo").check();
  await launch.click();
  await expect(
    page.getByRole("link", { name: "Open GitLab session" }),
  ).toHaveAttribute("href", /agent-sessions\/99$/);
  await expect(
    page.getByText("Execution verified", { exact: true }),
  ).not.toBeVisible();
  await page
    .getByRole("button", { name: "Refresh review", exact: true })
    .click();
  await expect(
    page.getByText("Execution verified", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".duo-review-panel pre").first()).toContainText(
    "<script>",
  );
  expect(
    await page.evaluate(() => (window as any).untrustedDuoRan),
  ).toBeUndefined();
  await expect(
    page.getByRole("button", { name: "Approve exact repair" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(launches).toBe(1);
});
