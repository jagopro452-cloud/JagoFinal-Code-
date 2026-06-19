import { expect, test } from "@playwright/test";

test("worker smoke launches chromium and loads data url", async ({ page }) => {
  await page.goto("data:text/html,<title>smoke</title><h1>smoke</h1>", { waitUntil: "load" });
  await expect(page.locator("h1")).toHaveText("smoke");
});
