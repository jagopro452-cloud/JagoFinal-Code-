import { test } from "@playwright/test";
import { LiveClient } from "../tests/playwright/support/live-client";

test("live admin login smoke", async () => {
  const client = await LiveClient.create();
  try {
    await client.loginAdmin(true);
  } finally {
    await client.dispose();
  }
});
