import { test, expect } from "@playwright/test";
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
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
