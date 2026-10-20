import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
test.beforeAll(async ({ request }) => {
  for (const url of [
    process.env.MAYA_URL || "http://127.0.0.1:4200",
    process.env.COMPANY_A_URL || "http://127.0.0.1:4100",
    process.env.COMPANY_B_URL || "http://127.0.0.1:4300",
  ]) {
    const health = await request.get(`${url}/api/health`, { timeout: 30000 });
    expect(health.status(), `Demo endpoint unavailable: ${url}`).toBe(200);
    expect((await health.json()).status).toBe("healthy");
  }
});
test("real TypeScript booking and Python support services recover through the same MAYA engine", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator(".boot")).not.toBeVisible({ timeout: 15000 });
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
    let affectedTicketId = "";
    let originalTicket: Record<string, unknown> = {};
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
      const rejected = await request.post(`${companyUrl}/api/bookings`, {
        headers: { "Idempotency-Key": randomUUID() },
        data: {
          serviceId: "consultation",
          name: "Demo Customer",
          email: "demo@example.com",
          date,
          time: "09:00",
          seats: 1,
        },
      });
      expect(rejected.status()).toBe(409);
    } else {
      const classification = await request.get(
        `${companyUrl}/api/classify?severity=critical`,
      );
      expect((await classification.json()).priority).toBe("low");
      const affected = await request.post(`${companyUrl}/api/tickets`, {
        headers: { "Idempotency-Key": randomUUID() },
        data: {
          subject: "Critical incident during fault",
          description:
            "A synthetic critical customer incident during the controlled fault.",
          requester: "Demo Customer",
          email: "demo@example.com",
          severity: "critical",
        },
      });
      expect(affected.status()).toBe(201);
      const body = await affected.json();
      expect(body.priority).toBe("low");
      affectedTicketId = body.id;
      originalTicket = body;
    }
    await page.getByRole("button", { name: "Approve exact repair" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Recovery verified. Evidence retained.",
      }),
    ).toBeVisible({ timeout: 90000 });
    await expect(page.locator(".live-checks .fail")).toHaveCount(0);
    if (affectedTicketId) {
      const response = await request.get(`${companyUrl}/api/overview`);
      const body = await response.json();
      const repaired = body.tickets.find(
        (t: { id: string }) => t.id === affectedTicketId,
      );
      expect(repaired.priority).toBe("critical");
      for (const field of [
        "subject",
        "description",
        "requester",
        "email",
        "severity",
        "createdAt",
        "status",
      ])
        expect(repaired[field]).toEqual(originalTicket[field]);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(process.env.COMPANY_A_URL || "http://127.0.0.1:4100");
  await page.getByRole("button", { name: "New reservation" }).click();
  await page.getByRole("dialog").getByRole("combobox").selectOption("workshop");
  await page.getByRole("button", { name: "09:00" }).click();
  await page.getByLabel("Your name").fill("HTTPS Demo");
  await page.getByLabel("Email address").fill("https-demo@example.com");
  await page.getByRole("button", { name: "Confirm reservation" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const row = page
    .getByRole("row")
    .filter({ hasText: "https-demo@example.com" })
    .first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row.getByText("cancelled", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("same-kind fault replacement refuses stale approval and a fresh live investigation recovers", async ({
  page,
  request,
}) => {
  let connectorKey = process.env.COMPANY_A_TOKEN;
  if (!connectorKey) {
    connectorKey = readFileSync(resolve("../.env"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("COMPANY_A_TOKEN="))
      ?.slice("COMPANY_A_TOKEN=".length);
  }
  if (!connectorKey)
    throw new Error(
      "Set COMPANY_A_TOKEN to verify the actual demo fault identity boundary.",
    );
  await page.goto("/");
  await expect(page.locator(".boot")).not.toBeVisible({ timeout: 15000 });
  const keyField = page.getByLabel("Sandbox access key");
  if (await keyField.isVisible()) {
    if (!key) throw new Error("Set MAYA_ACCESS_TOKEN.");
    await keyField.fill(key);
    await page.getByRole("button", { name: "Open MAYA" }).click();
  }
  await page
    .getByLabel("Company workspace", { exact: true })
    .selectOption({ label: "Company A" });
  await page
    .getByRole("button", { name: "Inject incident", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Inject & investigate", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve exact repair" }),
  ).toBeVisible({ timeout: 90000 });
  const companyUrl = process.env.COMPANY_A_URL || "http://127.0.0.1:4100";
  const replaced = await request.post(`${companyUrl}/api/demo/fault`, {
    headers: { Authorization: `Bearer ${connectorKey}` },
    data: { kind: "capacity-regression" },
  });
  expect(replaced.status()).toBe(200);
  const replacementId = (await replaced.json()).faultId;
  const decisionResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/decision") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Approve exact repair" }).click();
  expect((await decisionResponse).status()).toBe(409);
  await expect(page.getByRole("alert")).toContainText("live fault changed");
  await expect(
    page.getByRole("button", { name: "Recheck recovery (read-only)" }),
  ).toBeVisible();
  expect(
    (await (await request.get(`${companyUrl}/api/health`)).json()).faultId,
  ).toBe(replacementId);
  await page
    .getByRole("button", { name: "Start fresh investigation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve exact repair" }),
  ).toBeVisible({ timeout: 90000 });
  expect(
    (await (await request.get(`${companyUrl}/api/health`)).json()).faultId,
  ).toBe(replacementId);
  await page.getByRole("button", { name: "Approve exact repair" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Recovery verified. Evidence retained.",
    }),
  ).toBeVisible({ timeout: 90000 });
  expect(
    (await (await request.get(`${companyUrl}/api/health`)).json()).fault,
  ).toBe("none");
});
