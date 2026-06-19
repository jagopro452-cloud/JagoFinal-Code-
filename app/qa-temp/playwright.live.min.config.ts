import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/playwright/specs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [["line"]],
  outputDir: process.env.PW_MIN_OUTPUT_DIR || "C:/tmp/pw-output-cert",
  use: {
    baseURL: process.env.PW_BASE_URL || "http://127.0.0.1:4173",
    trace: "off",
    screenshot: "off",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    headless: process.env.PW_HEADED === "true" ? false : true,
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: process.env.PW_EXTRA_ARGS ? process.env.PW_EXTRA_ARGS.split(" ").filter(Boolean) : [],
    },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
});
