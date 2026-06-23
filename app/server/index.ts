// Register crash handlers FIRST — before any imports or async code runs
process.on("uncaughtException", (err: any) => {
  console.error("[FATAL uncaughtException]", err?.stack || err);
  // Don't exit — keep server alive for health checks
});
process.on("unhandledRejection", (reason: any) => {
  console.error("[FATAL unhandledRejection]", reason?.stack || reason);
});

console.log("BOOT START");

import "./env-bootstrap";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { setupSocket } from "./socket";
import { parseEnv, validateProductionReadiness } from "./config/env";
import { makeErrorId, sendAlert } from "./observability";
import { recordRequest, recordError } from "./metrics";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db as drizzleDb, pool as dbPool } from "./db";
import { settleCustomerRidePaymentByOrder, settleDriverPaymentByOrder } from "./payment-settlement";
import { startRefundReconciliationJob, reconcilePendingRefunds } from "./refund-reconciliation";
import { verifyCriticalSchemaOrThrow } from "./schema-health";
import fs from "node:fs/promises";
import fsSync from "node:fs";

try {
  parseEnv();
} catch (startupErr: any) {
  console.error("[startup] Invalid production configuration:", startupErr.message);
  if (process.env.NODE_ENV === "production") {
    process.exit(1);
  }
}

const app = express();
app.set("trust proxy", 1);
const httpServer = createServer(app);
let bootstrapReady = false;
let bootstrapError: string | null = null;
const useLocalStaticFrontend = process.env.LOCAL_STATIC_FRONTEND === "1";
const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFilePath);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    // Driver onboarding and KYC still send some images as base64 JSON payloads.
    // Keep this comfortably above typical compressed camera captures to avoid
    // generic submit failures on selfie/document upload.
    limit: "35mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "10mb", parameterLimit: 100 }));

app.get("/_health", (_req, res) => {
  return res.status(200).json({
    status: bootstrapReady ? "ok" : "starting",
    ready: bootstrapReady,
    error: bootstrapError,
    ts: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get("/health", (_req, res) => {
  return res.status(200).json({
    status: bootstrapReady ? "ok" : "starting",
    ready: bootstrapReady,
    error: bootstrapError,
    ts: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get("/api/health", (_req, res) => {
  return res.status(200).json({
    status: bootstrapReady ? "ok" : "starting",
    ready: bootstrapReady,
    error: bootstrapError,
    ts: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

function maskEmail(email: string | null | undefined): string {
  if (!email) return "[REDACTED_EMAIL]";
  const [local, domain] = email.split("@");
  if (!domain) return "[REDACTED_EMAIL]";
  const safeLocal =
    local.length <= 2 ? `${local[0] || "*"}*` : `${local.slice(0, 2)}***`;
  return `${safeLocal}@${domain}`;
}

function redactLogValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length > 160) return `${value.slice(0, 157)}...`;
    return value;
  }
  if (Array.isArray(value)) {
    return `[array:${value.length}]`;
  }
  if (typeof value === "object") {
    return "[object]";
  }
  return value;
}

function sanitizeResponseForDebug(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const obj = body as Record<string, unknown>;
  const sensitiveKeys = new Set([
    "otp",
    "password",
    "passwordHash",
    "token",
    "sessionToken",
    "authToken",
    "resetOtp",
    "firebaseToken",
    "fcmToken",
    "phone",
    "email",
    "address",
    "wallet",
    "walletBalance",
    "transactions",
    "data",
    "users",
  ]);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.has(key)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }
    sanitized[key] = redactLogValue(value);
  }
  return sanitized;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDependencies() {
  const requireRedis = Boolean(process.env.REDIS_URL);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await dbPool.query("SELECT 1");
      if (requireRedis) {
        const { checkRedis } = await import("./presence");
        const redisHealth = await checkRedis();
        if (redisHealth.status !== "ok") {
          throw new Error(redisHealth.error || `redis_${redisHealth.status}`);
        }
      }
      return;
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      log(`[startup] waiting for dependencies (${attempt}/20): ${lastError.message}`);
      await sleep(1000);
    }
  }

  throw lastError || new Error("dependency_check_failed");
}

async function loadRuntimeConfigFromDb() {
  const settingsRes = await dbPool.query(
    "SELECT key_name, value FROM business_settings WHERE key_name = ANY($1::text[])",
    [[
      "razorpay_key_id",
      "razorpay_key_secret",
      "razorpay_webhook_secret",
      "google_maps_key",
      "google_maps_api_key",
      "firebase_service_account",
      "firebase_web_api_key",
      "app_base_url",
    ]]
  );

  const ENV_MAP: Record<string, string> = {
    razorpay_key_id: "RAZORPAY_KEY_ID",
    razorpay_key_secret: "RAZORPAY_KEY_SECRET",
    razorpay_webhook_secret: "RAZORPAY_WEBHOOK_SECRET",
    google_maps_key: "GOOGLE_MAPS_API_KEY",
    google_maps_api_key: "GOOGLE_MAPS_API_KEY",
    firebase_service_account: "FIREBASE_SERVICE_ACCOUNT_KEY",
    firebase_web_api_key: "FIREBASE_WEB_API_KEY",
    app_base_url: "APP_BASE_URL",
  };

  for (const row of settingsRes.rows as any[]) {
    const envKey = ENV_MAP[row.key_name];
    if (envKey && !process.env[envKey] && row.value?.trim()) {
      process.env[envKey] = row.value.trim();
      log(`[config] Loaded ${envKey} from DB settings`);
    }
  }

  log("[config] DB settings loaded into runtime config");
}

function validateResolvedProductionConfig() {
  try {
    const env = parseEnv();
    validateProductionReadiness(env);
  } catch (startupErr: any) {
    console.error("[startup] Invalid resolved production configuration:", startupErr.message);
    if (process.env.NODE_ENV === "production") {
      throw startupErr;
    }
  }
}

async function setupSocketRedisAdapter() {
  try {
    const redisUrl = (process.env.REDIS_URL || "").trim();
    if (!redisUrl) {
      log("[Socket.IO] REDIS_URL not set; using in-memory adapter");
      return;
    }

    const { createAdapter } = await import("@socket.io/redis-adapter");
    const { default: IORedis } = await import("ioredis");
    const pubClient = new IORedis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 500, 5000),
      reconnectOnError: () => true,
      keepAlive: 15000,
    });
    const subClient = pubClient.duplicate();
    pubClient.on("error", (error) => { log(`[Socket.IO][Redis] publisher error: ${error.message}`); });
    subClient.on("error", (error) => { log(`[Socket.IO][Redis] subscriber error: ${error.message}`); });
    pubClient.on("end", () => { log("[Socket.IO][Redis] publisher connection ended"); });
    subClient.on("end", () => { log("[Socket.IO][Redis] subscriber connection ended"); });
    const { io: socketIo } = await import("./socket");

    await Promise.all([
      new Promise<void>((resolve, reject) => { pubClient.once("ready", resolve); pubClient.once("error", reject); pubClient.connect().catch(reject); }),
      new Promise<void>((resolve, reject) => { subClient.once("ready", resolve); subClient.once("error", reject); subClient.connect().catch(reject); }),
    ]);

    socketIo.adapter(createAdapter(pubClient, subClient));
    log("[Socket.IO] Redis adapter connected");
  } catch (error: any) {
    log(`[Socket.IO] Redis unavailable, using in-memory adapter (non-fatal): ${error?.message || error}`);
  }
}

async function ensureMigrationTable() {
  const result = await dbPool.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'migrations'
     LIMIT 1`,
  );
  if (!result.rowCount) {
    throw new Error("Missing migrations table. Apply bootstrap SQL migrations before starting the API.");
  }
}

/** Read SQL migration as UTF-8; auto-detect UTF-16 (Windows) and strip null bytes. */
function readMigrationSql(migrationPath: string): string {
  const raw = fsSync.readFileSync(migrationPath);
  let text: string;
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    text = raw.toString("utf16le");
  } else if (raw.length >= 2 && raw[1] === 0x00 && raw[0] !== 0x00 && raw[0] !== 0xef) {
    text = raw.toString("utf16le");
  } else {
    text = raw.toString("utf8");
  }
  return text.replace(/^\uFEFF/, "").replace(/\0/g, "").trim();
}

async function markMigrationApplied(file: string) {
  await dbPool.query(
    "INSERT INTO migrations (name, applied_at) VALUES ($1, NOW()) ON CONFLICT (name) DO NOTHING",
    [file],
  ).catch(() => {});
}

async function applySqlMigrationsFromDir(migrationsDir: string) {
  await ensureMigrationTable();
  if (!fsSync.existsSync(migrationsDir)) {
    log(`[migration] directory missing, skipping: ${migrationsDir}`);
    return;
  }

  const files = (await fs.readdir(migrationsDir))
    .filter((name) => name.toLowerCase().endsWith(".sql"))
    .sort();

  for (const file of files) {
    const existing = await dbPool.query("SELECT 1 FROM migrations WHERE name = $1 LIMIT 1", [file]);
    if ((existing.rowCount ?? 0) > 0) {
      log(`[migration] ${file} already marked applied`);
      continue;
    }

    const migrationPath = path.join(migrationsDir, file);
    try {
      const migrationSql = readMigrationSql(migrationPath);
      if (migrationSql) {
        await dbPool.query(migrationSql);
      }
      await markMigrationApplied(file);
      log(`[migration] ${file} applied`);
    } catch (e: any) {
      // Non-fatal: mark applied so a bad/legacy file never blocks production boot.
      log(`[migration] ${file} skipped with error (non-fatal): ${e.message}`);
      await markMigrationApplied(file);
    }
  }
}

async function runDrizzleMigrationsIfAvailable() {
  const candidates = [
    path.join(process.cwd(), "migrations"),
    path.join(currentDir, "drizzle-migrations"),
    path.join(currentDir, "..", "migrations"),
  ];

  const selected = candidates.find((folder) =>
    fsSync.existsSync(folder) &&
    fsSync.existsSync(path.join(folder, "meta", "_journal.json"))
  );

  if (!selected) {
    const checked = candidates
      .map((folder) => path.join(folder, "meta", "_journal.json"))
      .join(", ");
    log(`[db] Drizzle migrations skipped; journal not found. Checked: ${checked}`);
    return;
  }

  await migrate(drizzleDb, { migrationsFolder: selected });
  log(`[db] Drizzle migrations applied OK from ${selected}`);
}

// Security headers
app.use((req, res, next) => {
  const isApiRequest =
    req.path.startsWith("/api") ||
    req.path.startsWith("/v1/") ||
    req.path.startsWith("/v2/");
  // CORS headers — allow requests from frontend domain(s)
  const origin = req.headers.origin;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const requestProto = forwardedProto || req.protocol || "https";
  const requestOrigin = `${requestProto}://${req.headers.host}`;
  const defaultOrigins = "https://jagopro.org,https://www.jagopro.org,https://sea-lion-app-h5luj.ondigitalocean.app,http://localhost:5173,http://localhost:5000,http://127.0.0.1:5173,http://127.0.0.1:5000,http://192.168.1.9:5000";
  const allowedOrigins = ((process.env.ALLOWED_ORIGINS || defaultOrigins))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isSameOrigin = !!origin && origin === requestOrigin;

  if (!origin) {
    // Native mobile requests usually do not send Origin.
  } else if (!isApiRequest || isSameOrigin || allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    return res.status(403).json({ message: "Origin not allowed" });
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "3600");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;
  const allowResponsePreview = process.env.NODE_ENV !== "production";

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      recordRequest();
      if (res.statusCode >= 500) recordError();
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (allowResponsePreview && capturedJsonResponse) {
        const sanitized = sanitizeResponseForDebug(capturedJsonResponse);
        if (sanitized) {
        logLine += ` :: ${JSON.stringify(sanitized)}`;
        }
      }

      log(logLine);
    }
  });

  next();
});

app.use((req, res, next) => {
  if (bootstrapReady || req.path === "/" || req.path === "/_health" || req.path === "/health" || req.path === "/api/health") {
    return next();
  }

  return res.status(503).json({
    message: "Server is starting. Please try again in a few seconds.",
    ready: false,
  });
});

app.get("/", (_req, res, next) => {
  if (bootstrapReady) {
    return next();
  }

  return res.status(200).send("starting");
});

const port = parseInt(process.env.PORT || "5000", 10);

(async () => {
  // ─── STEP 1: Register error handler ───
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const errorId = makeErrorId();
    console.error(`Internal Server Error [${errorId}]:`, err);
    sendAlert({ level: status >= 500 ? "critical" : "error", source: "express", message: `Request failed with status ${status} (${errorId})`, details: typeof err?.stack === "string" ? err.stack : String(err?.message || err) }).catch(() => { });
    if (res.headersSent) return next(err);
    const isProd = process.env.NODE_ENV === "production";
    return res.status(status).json({ message: isProd && status >= 500 ? `An internal error occurred. Reference: ${errorId}` : (err.message || "Internal Server Error"), errorId });
  });

  try {
    await waitForDependencies();
    log("[startup] Dependencies ready");
  } catch (e: any) {
    bootstrapError = `dependency_check_failed:${e.message}`;
    console.error("[startup] Dependency check failed:", e.message);
    sendAlert({
      level: "critical",
      source: "startup",
      message: "Dependency check failed during boot",
      details: String(e.message || e),
    }).catch(() => { });
    return;
  }

  try {
    await loadRuntimeConfigFromDb();
    validateResolvedProductionConfig();
  } catch (e: any) {
    bootstrapError = `runtime_config_failed:${e.message}`;
    console.error("[config] Runtime configuration bootstrap failed:", e.message);
    sendAlert({
      level: "critical",
      source: "startup-config",
      message: "Runtime configuration bootstrap failed",
      details: String(e.message || e),
    }).catch(() => {});
    return;
  }

  // ─── STEP 2: Register routes (non-fatal if fails) ───
  try {
    log("[server] Registering API routes...");
    await registerRoutes(httpServer, app);
    log("[server] API routes registered OK");
  } catch (e: any) {
    bootstrapError = `route_registration_failed:${e.message}`;
    console.error("[routes] Failed to register routes:", e.message);
    sendAlert({ level: "critical", source: "routes", message: "Failed to register API routes", details: String(e.message || e) }).catch(() => { });
    return;
  }

  // ─── STEP 3: Static files or Vite dev middleware ───
  if (process.env.NODE_ENV === "production" || useLocalStaticFrontend) {
    try {
      serveStatic(app);
      log(useLocalStaticFrontend ? "[static] Frontend assets configured via LOCAL_STATIC_FRONTEND" : "[static] Frontend assets configured");
    } catch (e: any) {
      bootstrapError = `static_files_failed:${e.message}`;
      console.error("[static] Failed to configure frontend assets:", e.message);
      console.error("[static] Run 'npm run build' to generate dist/public, then restart");
      sendAlert({ level: "error", source: "static", message: "Failed to configure frontend assets", details: e.message }).catch(() => {});
      return;
    }
  } else {
    // Dev mode: register Vite BEFORE server starts listening so the SPA catch-all
    // is always ready when the first connection arrives
    try {
      const { setupVite } = await import("./vite");
      await setupVite(httpServer, app);
      log("[vite] Vite middleware registered");
    } catch (e: any) {
      console.error("[vite] Failed to setup Vite — frontend will not be served:", e.message);
      return;
    }
  }

  // ─── STEP 4: Drizzle migrations (MUST happen before ready flag) ───
  try {
    await runDrizzleMigrationsIfAvailable();
  } catch (e: any) {
    bootstrapError = `migration_failed:${e.message}`;
    console.error("[db] Drizzle migration failed:", e.message);
    sendAlert({ level: "critical", source: "migrations", message: "Drizzle migrations failed", details: e.message }).catch(() => {});
    return;
  }

  // ─── STEP 5: Apply custom SQL migrations (root + server dirs) — never abort boot ───
  try {
    await applySqlMigrationsFromDir(path.join(currentDir, "..", "migrations"));
    await applySqlMigrationsFromDir(path.join(currentDir, "migrations"));
  } catch (e: any) {
    log(`[migration] SQL migration pass finished with errors (non-fatal): ${e.message}`);
    sendAlert({ level: "error", source: "migrations", message: "SQL migration pass had errors", details: e.message }).catch(() => {});
  }

  // ─── STEP 6: Mark server ready — health probe passes from here ───
  try {
    await verifyCriticalSchemaOrThrow();
    log("[schema] Critical schema health verified");
  } catch (e: any) {
    bootstrapError = `schema_health_failed:${e.message}`;
    log(`[schema] Critical schema verification failed (non-fatal): ${e.message}`);
    sendAlert({ level: "error", source: "schema-health", message: "Schema verification failed", details: e.message }).catch(() => {});
  }

  try {
    setupSocket(httpServer);
    await setupSocketRedisAdapter();
  } catch (e: any) {
    bootstrapError = `socket_init_failed:${e.message}`;
    log(`[socket] Socket init warning (non-fatal): ${e.message}`);
    sendAlert({ level: "error", source: "socket", message: "Socket.IO initialization had errors", details: String(e.message || e) }).catch(() => {});
  }

  bootstrapReady = true;
  bootstrapError = null;
  console.log(`BOOT READY port=${port}`);

  // ─── START LISTENING (only after all critical setup is done) ───
  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`BOOT LISTEN OK port=${port}`);
  });

  // ─── BACKGROUND: Alert engine ───
  setTimeout(() => {
    (async () => {
      try {
        const { startAlertEngine } = await import("./alert-engine");
        startAlertEngine();
      } catch (e: any) {
        console.error("[alert-engine] Failed to start:", e.message);
      }
    })();
  }, 3000);

  reconcilePendingRefunds().catch((e: any) => {
    console.error("[refund-reconcile] initial run failed:", e.message);
  });
  startRefundReconciliationJob();

  // ─── DB MIGRATION: production_hardening indexes + constraints ───
  // ─── INITIALIZE PRODUCTION HARDENING (CRITICAL) ───
  (async () => {
    try {
      const { startHardeningJobs, loadHardeningSettings, logInfo } = await import("./hardening");
      await loadHardeningSettings();
      await startHardeningJobs();
      await logInfo('HARDENING-STARTUP', 'Production hardening system initialized', {});
    } catch (e: any) {
      console.error('[hardening] Failed to initialize:', e.message);
      // Non-fatal: hardening should not prevent server startup
      // but log it loudly for visibility
      sendAlert({
        level: "error",
        source: "hardening",
        message: "Hardening system failed to initialize",
        details: e.message,
      }).catch(() => { });
    }
  })();

  // Payment retry job: every 5 minutes, check trips stuck in payment_pending
  // for more than 5 minutes and query Razorpay to auto-resolve them
  setInterval(async () => {
    try {
      const { rawDb, rawSql } = await import("./db");
      const { io: socketIo } = await import("./socket");
      const { getRazorpayKeys } = await import("./routes");
      const { keyId: RAZORPAY_KEY_ID, keySecret: RAZORPAY_KEY_SECRET } = await getRazorpayKeys();
      if (!RAZORPAY_KEY_ID) return;
      // Find trips stuck in payment_pending for > 5 minutes
      const pendingDriverPayments = await rawDb.execute(rawSql`
        SELECT
          'driver'::text AS payment_source,
          t.id as trip_id,
          t.customer_id,
          dp.razorpay_order_id,
          dp.id as payment_id,
          dp.driver_id
        FROM trip_requests t
        JOIN driver_payments dp ON dp.trip_id = t.id
        WHERE t.current_status = 'payment_pending'
          AND t.updated_at < NOW() - INTERVAL '5 minutes'
          AND dp.status = 'pending'
          AND dp.razorpay_order_id IS NOT NULL
        LIMIT 20
      `);
      const pendingCustomerPayments = await rawDb.execute(rawSql`
        SELECT
          'customer'::text AS payment_source,
          t.id as trip_id,
          t.customer_id,
          cp.razorpay_order_id,
          cp.id as payment_id,
          NULL::uuid AS driver_id
        FROM trip_requests t
        JOIN customer_payments cp ON cp.trip_id = t.id
        WHERE t.current_status = 'payment_pending'
          AND t.updated_at < NOW() - INTERVAL '5 minutes'
          AND cp.status = 'pending'
          AND cp.razorpay_order_id IS NOT NULL
        LIMIT 20
      `);
      const stuckTrips = [
        ...((pendingDriverPayments.rows as any[]) || []),
        ...((pendingCustomerPayments.rows as any[]) || []),
      ];
      for (const row of stuckTrips) {
        try {
          // Query Razorpay for order payment status
          const rzpRes = await fetch(`https://api.razorpay.com/v1/orders/${row.razorpay_order_id}/payments`, {
            headers: { Authorization: `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64")}` },
          });
          if (!rzpRes.ok) continue;
          const rzpData = await rzpRes.json() as any;
          const captured = rzpData?.items?.find((p: any) => p.status === "captured");
          if (captured) {
            // Payment confirmed — complete the trip
            if (row.payment_source === "driver") {
              await settleDriverPaymentByOrder({
                orderId: String(row.razorpay_order_id),
                paymentId: String(captured.id),
                source: "retry_job",
              });
            } else {
              await settleCustomerRidePaymentByOrder({
                orderId: String(row.razorpay_order_id),
                paymentId: String(captured.id),
                source: "retry_job",
              });
            }
            const tripState = await rawDb.execute(rawSql`
              SELECT current_status
              FROM trip_requests
              WHERE id=${row.trip_id}::uuid
              LIMIT 1
            `);
            const currentTripStatus = String((tripState.rows[0] as any)?.current_status || "");
            if (currentTripStatus !== "completed") {
              const { transitionRideState } = await import("./ride-state");
              await transitionRideState(String(row.trip_id), "completed", {
                actorType: "system",
                event: "COMPLETED",
                data: { source: "payment_retry_job", paymentId: captured.id, orderId: row.razorpay_order_id },
                extraSetters: [rawSql`payment_status='paid'`],
              }).catch(() => null);
            }
            socketIo.to(`user:${row.customer_id}`).emit("trip:completed", { tripId: row.trip_id, message: "Payment confirmed. Trip complete." });
            log(`[PaymentRetry] Trip ${row.trip_id} resolved — payment ${captured.id} captured`);
          }
        } catch (_) { }
      }
    } catch (e: any) {
      log(`[PaymentRetry] Error: ${e.message}`);
    }
  }, 5 * 60 * 1000); // every 5 minutes

  // Orphan payment recovery: every 5 minutes, recover paid rides with no linked trip
  setInterval(async () => {
    try {
      const { runOrphanRecoveryWorker } = await import("./payment-orphan-recovery");
      const stats = await runOrphanRecoveryWorker();
      if (stats.detected > 0) {
        log(`[OrphanRecovery] detected=${stats.detected} recovered=${stats.recovered} failed=${stats.failed} skipped=${stats.skipped}`);
      }
    } catch (e: any) {
      log(`[OrphanRecovery] Error: ${e.message}`);
    }
  }, 5 * 60 * 1000);

  // Ghost driver auto-offline: every 60 seconds, mark drivers with no location ping > 5min as offline
  setInterval(async () => {
    try {
      const { autoOfflineInactiveDrivers } = await import("./ai");
      await autoOfflineInactiveDrivers();
    } catch (_) { }
  }, 60 * 1000); // every 60 seconds

})();
