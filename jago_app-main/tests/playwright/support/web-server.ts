import express from "express";
import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist", "public");
const port = Number(process.env.PW_UI_PORT || 4173);

function ensureBuildExists() {
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `Playwright UI build not found at ${indexPath}. Run the build step before starting the Playwright web server.`,
    );
  }
}

async function main() {
  ensureBuildExists();
  const indexHtml = await fs.promises.readFile(path.join(distDir, "index.html"), "utf8");

  const app = express();
  app.use(express.static(distDir, { extensions: ["html"] }));

  app.get(/.*/, (_req, res) => {
    res.type("html").send(indexHtml);
  });

  app.listen(port, "127.0.0.1", () => {
    console.log(`[playwright-web-server] serving ${distDir} on ${port}`);
  });
}

main().catch((error) => {
  console.error("[playwright-web-server] failed", error);
  process.exit(1);
});
