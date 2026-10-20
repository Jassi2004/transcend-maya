import { test, expect } from "@playwright/test";
test("a proxy HTML failure displays a useful error and never retries the mutation", async ({
  page,
}) => {
  await page.goto("/");
  let writes = 0;
  await page.route("**/api/companies/*/incidents", async (route) => {
    writes++;
    await route.fulfill({
      status: 502,
      contentType: "text/html",
      body: "<!DOCTYPE html><title>Proxy unavailable</title>",
    });
  });
  await page
    .getByRole("button", { name: "Inject incident", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Inject & investigate", exact: true })
    .click();
  const error = page.getByRole("alert");
  await expect(error).toContainText(
    "Server returned an unreadable response (HTTP 502)",
  );
  await page.waitForResponse((response) =>
    response.url().includes("/snapshot"),
  );
  await expect(error).toContainText("inspect the saved run before retrying");
  expect(writes).toBe(1);
});
test("incident, approval, memory review, repeat recovery, and stale-context rejection", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Operations, with a memory." }),
  ).toBeVisible();
  async function launch() {
    await page
      .getByRole("button", { name: "Inject incident", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Inject & investigate", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve exact repair" }),
    ).toBeVisible();
  }
  await launch();
  await page.getByRole("button", { name: "Approve exact repair" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Recovery verified. Evidence retained.",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open company memory" }).click();
  await page.getByRole("button", { name: "Review lesson" }).click();
  await page.getByRole("button", { name: "Approve lesson for reuse" }).click();
  await expect(page.getByText("active", { exact: true })).toBeVisible();
  await launch();
  await expect(
    page.getByRole("heading", { name: "Verified lesson matched" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve exact repair" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Recovery verified. Evidence retained.",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Environment", exact: true }).click();
  await page.getByLabel("Runtime context").fill("Node.js 26");
  await page.getByRole("button", { name: "Update context revision" }).click();
  await expect(page.getByText("REVISION 2", { exact: true })).toBeVisible();
  await launch();
  await expect(
    page.getByRole("heading", { name: "Stale lesson rejected" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reject proposal" }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/maya-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "New company", exact: true }).click();
  await page.getByLabel("Company name").fill("Fresh Company");
  await page
    .getByRole("button", { name: "Create simulation workspace" })
    .click();
  await expect(page.getByText("All quiet in the yard.")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByLabel("Mobile company workspace", { exact: true }),
  ).toBeVisible();
  for (const view of [
    "Workforce",
    "Memory",
    "Evidence",
    "Environment",
    "Control room",
  ]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  }
  await page.getByRole("button", { name: "New company", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create simulation workspace" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});

test("an invalidated approval stays visible across polling and a fresh investigation recovers", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Inject incident", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Inject & investigate", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve exact repair" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Environment", exact: true }).click();
  await page.getByLabel("Runtime context").fill("Node.js 25");
  await page.getByRole("button", { name: "Update context revision" }).click();
  await expect(
    page.getByText(
      "Context updated. Old lessons will be checked against the new runtime.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Control room", exact: true }).click();
  await page.getByRole("button", { name: "Approve exact repair" }).click();
  const error = page.getByRole("alert");
  await expect(error).toContainText("Company context changed");
  await page.waitForResponse((response) =>
    response.url().includes("/snapshot"),
  );
  await expect(error).toContainText("Company context changed");
  await page.getByRole("button", { name: "Reject proposal" }).click();
  await page
    .getByRole("button", { name: "Start fresh investigation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve exact repair" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve exact repair" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Recovery verified. Evidence retained.",
    }),
  ).toBeVisible();
});
