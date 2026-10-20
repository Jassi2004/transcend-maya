import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";

test.use({ trace: "off" });
test("opt-in: a real GitLab Duo review is launched from a recovered company run", async ({
  page,
  request,
}) => {
  test.skip(
    process.env.MAYA_DUO_LIVE_TEST !== "true",
    "Explicit opt-in required: consumes real GitLab Duo credits.",
  );
  test.setTimeout(600_000);
  const token = process.env.MAYA_ACCESS_TOKEN!;
  const headers = { Authorization: `Bearer ${token}` };
  const company = process.env.MAYA_DUO_TEST_COMPANY || "company-a";
  // Recover first, so a slow external review never leaves the demo broken.
  const created = await request.post(`/api/companies/${company}/incidents`, {
    headers,
    data: {
      scenario:
        company === "company-b" ? "priority-inversion" : "capacity-regression",
    },
  });
  expect(created.status()).toBe(201);
  const { run: initial } = await created.json();
  let run: any;
  await expect
    .poll(
      async () => {
        const snapshot = await (
          await request.get(`/api/companies/${company}/snapshot`, { headers })
        ).json();
        run = snapshot.runs.find((r: any) => r.id === initial.id);
        return run.status;
      },
      { timeout: 30_000 },
    )
    .toBe("awaiting_approval");
  const decision = await request.post(
    `/api/companies/${company}/runs/${run.id}/decision`,
    {
      headers,
      data: {
        decision: "approve",
        digest: run.proposal.digest,
        reason: "Controlled live integration test: reviewed exact demo repair.",
      },
    },
  );
  expect(decision.status()).toBe(200);
  expect((await decision.json()).status).toBe("resolved");
  await page.goto("/?lab=1");
  const field = page.getByLabel("Sandbox access key");
  await expect(page.locator(".boot")).not.toBeVisible();
  if (await field.isVisible()) {
    await field.fill(token);
    await page.getByRole("button", { name: "Open MAYA" }).click();
  }
  await page
    .getByLabel("Company workspace", { exact: true })
    .selectOption(company);
  await page.getByLabel("Share this run’s evidence with GitLab Duo").check();
  await page
    .getByRole("button", { name: "Review with GitLab Duo", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Open GitLab session" }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(
    page.getByText("Execution verified", { exact: true }),
  ).toBeVisible({ timeout: 540_000 });
  await expect(page.locator(".duo-review-panel pre").first()).toBeVisible();
  const snapshot = await (
    await request.get(`/api/companies/${company}/snapshot`, { headers })
  ).json();
  const review = snapshot.duoReviews.find((r: any) => r.runId === run.id);
  expect(review.executionVerified).toBe(true);
  expect(snapshot.runs.find((r: any) => r.id === run.id).status).toBe(
    "resolved",
  );
  writeFileSync(
    process.env.MAYA_DUO_TEST_RESULT || "test-results/duo-live-review.json",
    JSON.stringify(review, null, 2),
  );
  await page.screenshot({
    path: "test-results/duo-live-review.png",
    fullPage: true,
  });
});
