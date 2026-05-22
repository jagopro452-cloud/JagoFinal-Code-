import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function run(command: string) {
  execSync(command, {
    stdio: "inherit",
    env: process.env,
  });
}

run("vite build");
run("esbuild server/index.ts --platform=node --bundle --format=esm --packages=external --define:process.env.NODE_ENV='\"production\"' --outfile=dist/index.js");

const serverMigrationsSrc = path.resolve("server", "migrations");
const serverMigrationsDest = path.resolve("dist", "migrations");
const rootMigrationsSrc = path.resolve("migrations");
const rootMigrationsDest = path.resolve("dist", "drizzle-migrations");

if (fs.existsSync(serverMigrationsSrc)) {
  fs.mkdirSync(serverMigrationsDest, { recursive: true });
  fs.cpSync(serverMigrationsSrc, serverMigrationsDest, { recursive: true });
}

if (fs.existsSync(rootMigrationsSrc)) {
  fs.mkdirSync(rootMigrationsDest, { recursive: true });
  fs.cpSync(rootMigrationsSrc, rootMigrationsDest, { recursive: true });
}

run("node script/sync-apks.js");
