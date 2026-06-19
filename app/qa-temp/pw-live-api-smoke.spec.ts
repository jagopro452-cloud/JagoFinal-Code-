import { expect, request, test } from "@playwright/test";
import { runtime } from "../tests/playwright/support/runtime";

test("live api smoke", async () => {
  const api = await request.newContext({
    baseURL: runtime.apiBaseURL,
    extraHTTPHeaders: {
      "content-type": "application/json",
      "x-jago-playwright-suite": "true",
    },
    ignoreHTTPSErrors: true,
  });

  try {
    const health = await api.get("/api/health");
    expect(health.ok()).toBeTruthy();
  } finally {
    await api.dispose();
  }
});
