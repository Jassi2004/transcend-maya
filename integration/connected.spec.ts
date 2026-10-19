import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
let key = process.env.MAYA_ACCESS_TOKEN;
if (!key) {
  try {
    key = readFileSync(resolve("../.env"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("MAYA_ACCESS_TOKEN="))
      ?.split("=")
      .slice(1)
      .join("=");
  } catch {}
}
test("real TypeScript booking and Python support services recover through the same MAYA engine", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const keyField = page.getByLabel("Sandbox access key");
  if (await keyField.isVisible()) {
    if (!key)
      throw new Error(
        "Set MAYA_ACCESS_TOKEN to test an authenticated deployment.",
      );
    await keyField.fill(key);
    await page.getByRole("button", { name: "Open MAYA" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Operations, with a memory." }),
  ).toBeVisible();
  for (const company of ["Company A", "Company B"]) {
    await page
      .getByLabel("Company workspace", { exact: true })
      .selectOption({ label: company });
    await expect(
      page.getByText("Live demo connector", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Environment", exact: true })
      .click();
    await page.getByRole("button", { name: "Test live connection" }).click();
    await expect(page.locator(".connection-results .fail")).toHaveCount(0);
    await expect(page.locator(".connection-results .pass")).toHaveCount(2);
    await page
      .getByRole("button", { name: "Inject incident", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Inject & investigate", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve exact repair" }),
    ).toBeVisible({ timeout: 90000 });
    const companyUrl =
      company === "Company A"
        ? process.env.COMPANY_A_URL || "http://127.0.0.1:4100"
        : process.env.COMPANY_B_URL || "http://127.0.0.1:4300";
    if (company === "Company A") {
      const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const slots = await request.get(
        `${companyUrl}/api/slots?serviceId=consultation&date=${date}`,
      );
      expect(
        (await slots.json()).every(
          (s: { remaining: number }) => s.remaining === 0,
        ),
      ).toBeTruthy();
    } else {
      const classification = await request.get(
        `${companyUrl}/api/classify?severity=critical`,
      );
      expect((await classification.json()).priority).toBe("low");
    }
    await page.getByRole("button", { name: "Approve exact repair" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Recovery verified. Evidence retained.",
      }),
    ).toBeVisible({ timeout: 90000 });
    await expect(page.locator(".live-checks .fail")).toHaveCount(0);
    await page.screenshot({
      path: `test-results/connected/${company === "Company A" ? "company-a-recovered" : "company-b-recovered"}.png`,
      fullPage: true,
    });
  }
  await page.goto(process.env.COMPANY_B_URL || "http://127.0.0.1:4300");
  await page.getByRole("button", { name: "New ticket" }).click();
  await page
    .getByLabel("Subject", { exact: true })
    .fill("Cross-stack browser demonstration");
  await page
    .getByLabel("What happened?")
    .fill("A critical service issue for a fictional customer.");
  await page.getByLabel("Your name").fill("Demo Customer");
  await page.getByLabel("Email address").fill("demo@example.com");
  await page.getByLabel("Severity", { exact: true }).selectOption("critical");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(
    page
      .getByText("Cross-stack browser demonstration", { exact: true })
      .first(),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/connected/company-b-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
