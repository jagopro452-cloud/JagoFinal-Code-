import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, ".env") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;
const isProduction = process.env.NODE_ENV === 'production';
const databaseUrl = (process.env.DATABASE_URL || "").trim();

if (!databaseUrl) {
  if (isProduction) {
    throw new Error("[db] DATABASE_URL is required in production");
  }
  console.error("[db] WARNING: DATABASE_URL not set — DB operations will fail at runtime");
}

function normalizeDatabaseUrl(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    // Let node-postgres honor the explicit ssl object below instead of
    // inheriting stricter sslmode semantics from the URL query string.
    parsed.searchParams.delete("sslmode");
    parsed.searchParams.delete("sslcert");
    parsed.searchParams.delete("sslkey");
    parsed.searchParams.delete("sslrootcert");
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

const isLocalDb = databaseUrl.match(/localhost|127\.0\.0\.1/);
const normalizedDatabaseUrl = normalizeDatabaseUrl(databaseUrl);
const rejectUnauthorized =
  String(process.env.DB_SSL_REJECT_UNAUTHORIZED || "true").toLowerCase() !== "false";

// Neon serverless needs enough connections to handle concurrent request bursts.
// 10 was too low — production peaks can exhaust the pool causing queue buildup.
// Increased to 25 for production, 15 for dev to handle multiple async startup operations.
const maxConnections = Number(process.env.DB_POOL_MAX || (isProduction ? "25" : "15"));

export const pool = new Pool({
  connectionString: normalizedDatabaseUrl,
  ssl: isLocalDb ? false : { rejectUnauthorized },
  max: maxConnections,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  allowExitOnIdle: false,
  application_name: 'jago-api',   // For debugging in pg_stat_statements
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

pool.on("connect", () => {
  if (!isProduction) {
    console.debug("[DB] New connection established, pool size:", pool.totalCount);
  }
});

export const db = drizzle(pool, { schema });
export const rawDb = db;
export const rawSql = sql;

const gracefulShutdown = async (signal: string) => {
  console.log(`[DB] ${signal} received — draining pool...`);
  try { await pool.end(); } catch (e) { /* ignore */ }
  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
