import { test, expect } from "@playwright/test";

test("worker smoke launches chromium and loads data url js", async ({ page }) => {
  await page.goto("data:text/html,<title>smokejs</title><h1>smokejs</h1>", { waitUntil: "load" });
  await expect(page.locator("h1")).toHaveText("smokejs");
});
