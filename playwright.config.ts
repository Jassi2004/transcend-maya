import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:4210",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:4210/api/health",
    reuseExistingServer: false,
    env: {
      PORT: "4210",
      HOST: "127.0.0.1",
      MAYA_STEP_DELAY_MS: "5",
      DATABASE_PATH: `./data/e2e-${process.pid}.sqlite`,
      MAYA_ACCESS_TOKEN: "",
    },
  },
});
