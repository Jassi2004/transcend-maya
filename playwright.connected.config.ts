import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./integration",
  timeout: 120000,
  workers: 1,
  use: {
    baseURL: process.env.MAYA_URL || "http://127.0.0.1:4200",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  outputDir: "test-results/connected",
});
