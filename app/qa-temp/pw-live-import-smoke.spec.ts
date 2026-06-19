import { expect, test } from "@playwright/test";
import { runtime } from "../tests/playwright/support/runtime";
import { createQaTag } from "../tests/playwright/support/runtime";
import type { LiveClient } from "../tests/playwright/support/live-client";

test("live support import smoke", async () => {
  const tag = createQaTag("import smoke");
  expect(runtime.envName).toBeTruthy();
  expect(tag).toContain("import smoke");
  const typeOnlyCheck: LiveClient | null = null;
  expect(typeOnlyCheck).toBeNull();
});
