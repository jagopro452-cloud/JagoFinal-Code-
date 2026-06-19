import { chromium } from "playwright";

const headed = process.env.PW_HEADED === "true";
const args = process.env.PW_CHROMIUM_ARGS ? process.env.PW_CHROMIUM_ARGS.split(" ").filter(Boolean) : [];

async function main() {
  const browser = await chromium.launch({
    headless: !headed,
    args,
  });
  const page = await browser.newPage();
  await page.goto("data:text/html,<title>ok</title><h1>ok</h1>", { waitUntil: "load", timeout: 30000 });
  console.log(JSON.stringify({
    headless: !headed,
    args,
    title: await page.title(),
    contentOk: await page.locator("h1").textContent(),
  }));
  await browser.close();
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
