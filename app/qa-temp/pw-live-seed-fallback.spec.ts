import { test } from "@playwright/test";
import { LiveClient } from "../tests/playwright/support/live-client";

test("live seed fallback smoke", async () => {
  const client = await LiveClient.create();
  try {
    await client.seedTestAccounts();
  } finally {
    await client.dispose();
  }
});
