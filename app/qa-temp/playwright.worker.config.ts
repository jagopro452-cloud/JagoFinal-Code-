import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["line"]],
  outputDir: process.env.PW_MIN_OUTPUT_DIR || "C:/tmp/pw-output-cert",
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
    headless: true,
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
