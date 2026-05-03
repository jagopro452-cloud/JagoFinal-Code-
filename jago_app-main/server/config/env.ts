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

  // Log warnings for forbidden vars that are set to truthy — never crash
  const forbidden = ["ENABLE_DEV_OTP_RESPONSES"];
  for (const key of forbidden) {
    if (isTrue(process.env[key])) {
      console.warn(`[config] WARNING: ${key} is set to a truthy value in production — this should be removed`);
    }
  }

  const warnings: string[] = [];

  if (!env.ADMIN_PASSWORD) warnings.push("ADMIN_PASSWORD not set - admin panel login will be unavailable");
  if (!env.GOOGLE_MAPS_API_KEY) warnings.push("GOOGLE_MAPS_API_KEY not set");
  if (!env.OPS_API_KEY) warnings.push("OPS_API_KEY not set");
  if (!env.RAZORPAY_KEY_ID) warnings.push("RAZORPAY_KEY_ID not set");
  if (!env.RAZORPAY_KEY_SECRET) warnings.push("RAZORPAY_KEY_SECRET not set");
  if (!env.RAZORPAY_WEBHOOK_SECRET) warnings.push("RAZORPAY_WEBHOOK_SECRET not set");
  if (!env.ALLOWED_ORIGINS) warnings.push("ALLOWED_ORIGINS not set - using default localhost origins");
  if (!env.SOCKET_ALLOWED_ORIGINS) warnings.push("SOCKET_ALLOWED_ORIGINS not set - using default");
  if (!env.REDIS_URL) warnings.push("REDIS_URL not set - in-memory fallback only");

  const twoFaOn = !isFalse(env.ADMIN_2FA_REQUIRED);
  if (!twoFaOn) warnings.push("ADMIN_2FA_REQUIRED=false - admin has no second factor");
  if (twoFaOn && !env.ADMIN_PHONE) warnings.push("ADMIN_PHONE not set but 2FA is enabled");

  if (warnings.length) {
    console.warn(`[config] Production warnings: ${warnings.join(" | ")}`);
  }
}
