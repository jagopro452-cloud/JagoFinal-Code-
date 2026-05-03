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

if (!process.env.DATABASE_URL) {
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

// Cloud DBs (Neon, Supabase, Railway) use intermediate CAs that trigger Node.js SSL errors.
// Fix: disable cert rejection at pool level only (not globally — global setting breaks all HTTPS).
const isLocalDb = (process.env.DATABASE_URL || "").match(/localhost|127\.0\.0\.1/);
const isProduction = process.env.NODE_ENV === 'production';
const normalizedDatabaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL || "postgres://localhost/jago_placeholder");

// Neon serverless needs enough connections to handle concurrent request bursts.
// 10 was too low — production peaks can exhaust the pool causing queue buildup.
const maxConnections = isProduction ? 25 : 20;

export const pool = new Pool({
  connectionString: normalizedDatabaseUrl,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
  max: maxConnections,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,  // Fail fast instead of hanging (was 10000ms)
  allowExitOnIdle: false,
  application_name: 'jago-api',   // For debugging in pg_stat_statements
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

pool.on("connect", () => {
  console.debug("[DB] New connection established, pool size:", pool.totalCount);
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
