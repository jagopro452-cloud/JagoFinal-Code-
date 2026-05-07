// Register crash handlers FIRST — before any imports or async code runs
process.on("uncaughtException", (err: any) => {
  console.error("[FATAL uncaughtException]", err?.stack || err);
  // Don't exit — keep server alive for health checks
});
process.on("unhandledRejection", (reason: any) => {
  console.error("[FATAL unhandledRejection]", reason?.stack || reason);
});

console.log("BOOT START");

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
import path from "path";
import fs from "node:fs/promises";

try {
  const env = parseEnv();
  validateProductionReadiness(env);
} catch (startupErr: any) {
  console.error("[startup] Config warning (non-fatal):", startupErr.message);
}

const app = express();
app.set("trust proxy", 1);
const httpServer = createServer(app);
let bootstrapReady = false;
let bootstrapError: string | null = null;

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
    limit: "20mb",
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
      "fast2sms_api_key",
      "two_factor_api_key",
      "google_maps_key",
      "twilio_account_sid",
      "twilio_auth_token",
      "twilio_phone_number",
      "anthropic_api_key",
    ]]
  );

  const ENV_MAP: Record<string, string> = {
    razorpay_key_id: "RAZORPAY_KEY_ID",
    razorpay_key_secret: "RAZORPAY_KEY_SECRET",
    razorpay_webhook_secret: "RAZORPAY_WEBHOOK_SECRET",
    fast2sms_api_key: "FAST2SMS_API_KEY",
    two_factor_api_key: "TWO_FACTOR_API_KEY",
    google_maps_key: "GOOGLE_MAPS_API_KEY",
    twilio_account_sid: "TWILIO_ACCOUNT_SID",
    twilio_auth_token: "TWILIO_AUTH_TOKEN",
    twilio_phone_number: "TWILIO_PHONE_NUMBER",
    anthropic_api_key: "ANTHROPIC_API_KEY",
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

async function setupSocketRedisAdapter() {
  try {
    const { createAdapter } = await import("@socket.io/redis-adapter");
    const { default: IORedis } = await import("ioredis");
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    const pubClient = new IORedis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    const subClient = pubClient.duplicate();
    pubClient.on("error", () => { });
    subClient.on("error", () => { });
    const { io: socketIo } = await import("./socket");

    await Promise.all([
      new Promise<void>((resolve, reject) => { pubClient.once("ready", resolve); pubClient.once("error", reject); pubClient.connect().catch(reject); }),
      new Promise<void>((resolve, reject) => { subClient.once("ready", resolve); subClient.once("error", reject); subClient.connect().catch(reject); }),
    ]);

    socketIo.adapter(createAdapter(pubClient, subClient));
    log("[Socket.IO] Redis adapter connected");
  } catch (error: any) {
    log(`[Socket.IO] Redis unavailable, using in-memory adapter: ${error.message}`);
  }
}

async function applyProductionHardeningMigration() {
  const migrationName = "0001_operational_schema_hardening.sql";
  const migrationCandidates = [
    path.join(__dirname, "migrations", migrationName),
    path.join(process.cwd(), "server", "migrations", migrationName),
    path.join(process.cwd(), "migrations", migrationName),
  ];

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const existing = await dbPool.query("SELECT 1 FROM migrations WHERE name = $1 LIMIT 1", [migrationName]);
  if (existing.rowCount) {
    log(`[migration] ${migrationName} already marked applied`);
    return;
  }

  let migrationSql: string | null = null;
  for (const candidate of migrationCandidates) {
    try {
      migrationSql = await fs.readFile(candidate, "utf8");
      break;
    } catch {
      // Try next candidate path.
    }
  }

  if (!migrationSql) {
    throw new Error(`Missing migration file: ${migrationName}`);
  }

  await dbPool.query(migrationSql);
  await dbPool.query(
    "INSERT INTO migrations (name, applied_at) VALUES ($1, NOW()) ON CONFLICT (name) DO NOTHING",
    [migrationName]
  );
  log(`[migration] ${migrationName} applied`);
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
  const defaultOrigins = "https://jagopro.org,https://www.jagopro.org,http://localhost:5173,http://localhost:5000,http://127.0.0.1:5173,http://127.0.0.1:5000";
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
      if (capturedJsonResponse) {
        const sanitized = { ...capturedJsonResponse };
        if (sanitized.otp !== undefined) sanitized.otp = "[REDACTED]";
        if (sanitized.password !== undefined) sanitized.password = "[REDACTED]";
        if (sanitized.token !== undefined) sanitized.token = "[REDACTED]";
        if (sanitized.sessionToken !== undefined) sanitized.sessionToken = "[REDACTED]";
        logLine += ` :: ${JSON.stringify(sanitized)}`;
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

  // ─── STEP 2: Register routes (non-fatal if fails) ───
  try {
    log("[server] Registering API routes...");
    await registerRoutes(httpServer, app);
    log("[server] API routes registered OK");
  } catch (e: any) {
    bootstrapError = `route_registration_failed:${e.message}`;
    console.error("[routes] Failed to register routes (server stays alive):", e.message);
    sendAlert({ level: "critical", source: "routes", message: "Failed to register API routes", details: String(e.message || e) }).catch(() => { });
  }

  // ─── STEP 3: Static files ───
  if (process.env.NODE_ENV === "production") {
    try { 
      serveStatic(app); 
      log("[static] Frontend assets configured");
    } catch (e: any) { 
      bootstrapError = `static_files_failed:${e.message}`;
      console.error("[static] Failed to configure frontend assets:", e.message);
      sendAlert({ level: "error", source: "static", message: "Failed to configure frontend assets", details: e.message }).catch(() => {});
    }
  }

  // ─── STEP 4: Drizzle migrations (MUST happen before ready flag) ───
  try {
    const migrationsFolder = path.join(process.cwd(), "migrations");
    await migrate(drizzleDb, { migrationsFolder });
    log("[db] Drizzle migrations applied OK");
  } catch (e: any) {
    bootstrapError = `migration_failed:${e.message}`;
    console.error("[db] Drizzle migration failed:", e.message);
    sendAlert({ level: "critical", source: "migrations", message: "Drizzle migrations failed", details: e.message }).catch(() => {});
  }

  // ─── STEP 5: Apply custom hardening migration ───
  try {
    await applyProductionHardeningMigration();
  } catch (e: any) {
    // Log but don't block if this specific migration fails
    log(`[migration] 0001_operational_schema_hardening failed (non-fatal): ${e.message}`);
  }

  // ─── STEP 6: Mark server ready — health probe passes from here ───
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

  // ─── BACKGROUND INITIALIZATION (non-blocking) ───
  setupSocket(httpServer);

  (async () => {
    try {
      await loadRuntimeConfigFromDb();
    } catch (e: any) {
      log(`[config] Could not load DB settings (non-fatal): ${e.message}`);
    }
  })();

  (async () => {
    try {
      await setupSocketRedisAdapter();
    } catch (err: any) {
      log(`[Socket.IO] Redis adapter initialization failed: ${err.message}`);
    }
  })();

  // ─── DB MIGRATION: production_hardening indexes + constraints ───
  (async () => {
    try {
      await applyProductionHardeningMigration();
    } catch (e: any) {
      log(`[migration] 001_production_hardening failed (non-fatal): ${e.message}`);
    }
  })();

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
              await rawDb.execute(rawSql`
                UPDATE driver_payments SET status='completed', razorpay_payment_id=${captured.id}, verified_at=NOW()
                WHERE id=${row.payment_id}::uuid
              `);
            } else {
              await rawDb.execute(rawSql`
                UPDATE customer_payments SET status='completed', razorpay_payment_id=${captured.id}, verified_at=NOW()
                WHERE id=${row.payment_id}::uuid
              `);
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

  // Ghost driver auto-offline: every 60 seconds, mark drivers with no location ping > 5min as offline
  setInterval(async () => {
    try {
      const { autoOfflineInactiveDrivers } = await import("./ai");
      await autoOfflineInactiveDrivers();
    } catch (_) { }
  }, 60 * 1000); // every 60 seconds

  // Setup Vite in development (after server is listening)
  if (process.env.NODE_ENV !== "production") {
    try {
      const { setupVite } = await import("./vite");
      await setupVite(httpServer, app);
    } catch (e: any) {
      console.error("[vite] Failed to setup Vite:", e.message);
    }
  }

})();
