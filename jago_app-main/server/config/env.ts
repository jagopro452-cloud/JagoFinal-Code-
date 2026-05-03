import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.string().optional(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_NAME: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_PHONE: z.string().optional(),
  ADMIN_SESSION_TTL_HOURS: z.string().optional(),
  ADMIN_2FA_REQUIRED: z.string().optional(),

  GOOGLE_MAPS_API_KEY: z.string().optional(),
  SOCKET_ALLOWED_ORIGINS: z.string().optional(),
  OPS_API_KEY: z.string().optional(),
  ALERT_WEBHOOK_URL: z.string().optional(),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  FIREBASE_SERVICE_ACCOUNT_KEY: z.string().optional(),
  FIREBASE_WEB_API_KEY: z.string().optional(),

  REDIS_URL: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function parseEnv(): AppEnv {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

export function isTrue(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function isFalse(value: string | undefined): boolean {
  if (!value) return false;
  return ["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function validateProductionReadiness(env: AppEnv): void {
  if (env.NODE_ENV !== "production") return;

  // Hard block: these env vars must never exist in production
  const forbidden = ["ENABLE_DEV_OTP_RESPONSES"];
  for (const key of forbidden) {
    if (isTrue(process.env[key])) {
      throw new Error(`FATAL: ${key} must not be set to a truthy value in production — remove it or set it to false`);
    }
  }

  const critical: string[] = [];
  const warnings: string[] = [];

  if (!env.ADMIN_PASSWORD) critical.push("ADMIN_PASSWORD");

  const twoFaOn = !isFalse(env.ADMIN_2FA_REQUIRED);
  if (twoFaOn && !env.ADMIN_PHONE) {
    warnings.push("ADMIN_PHONE not set - admin 2FA is enabled but OTP has no delivery target; set ADMIN_PHONE=+91xxxxxxxxxx");
  }
  if (!twoFaOn) {
    warnings.push("ADMIN_2FA_REQUIRED=false - admin logins have no second factor; set ADMIN_2FA_REQUIRED=true and ADMIN_PHONE for security");
  }

  if (!env.GOOGLE_MAPS_API_KEY) warnings.push("GOOGLE_MAPS_API_KEY");
  if (!env.OPS_API_KEY) warnings.push("OPS_API_KEY");
  if (!env.RAZORPAY_KEY_ID) warnings.push("RAZORPAY_KEY_ID");
  if (!env.RAZORPAY_KEY_SECRET) warnings.push("RAZORPAY_KEY_SECRET");
  if (!env.RAZORPAY_WEBHOOK_SECRET) warnings.push("RAZORPAY_WEBHOOK_SECRET");
  if (!env.ALLOWED_ORIGINS) critical.push("ALLOWED_ORIGINS");
  if (!env.SOCKET_ALLOWED_ORIGINS) critical.push("SOCKET_ALLOWED_ORIGINS");
  if (env.ALLOWED_ORIGINS?.split(",").map((v) => v.trim()).includes("*")) {
    critical.push("ALLOWED_ORIGINS must not contain * in production");
  }
  if (env.SOCKET_ALLOWED_ORIGINS?.split(",").map((v) => v.trim()).includes("*")) {
    critical.push("SOCKET_ALLOWED_ORIGINS must not contain * in production");
  }
  if (!env.REDIS_URL) {
    warnings.push("REDIS_URL not set - driver presence cache and Socket.IO multi-server sync will be disabled (in-memory fallback only)");
  }

  if (critical.length) {
    throw new Error(`[config] FATAL: Critical production env vars not set: ${critical.join(", ")} - cannot start in production without these.`);
  }
  if (warnings.length) {
    console.warn(`[config] WARNING: Production env vars not set: ${warnings.join(", ")} - some features will be unavailable.`);
  }
}
