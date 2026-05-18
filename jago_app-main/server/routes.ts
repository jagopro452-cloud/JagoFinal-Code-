import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import { log } from "./index";
import { getFirebaseAdminAsync, notifyDriverNewRide, notifyDriverNewParcel, notifyCustomerDriverAccepted, notifyCustomerDriverArrived, notifyCustomerTripCompleted, notifyTripCancelled, sendFcmNotification } from "./fcm";
import { sendCustomSms } from "./sms";
import { notifyNearbyDriversNewTrip, io } from "./socket";
import type { Server } from "http";
import { storage } from "./storage";
import { z } from "zod";
import crypto from "crypto";
import { createRequire } from "module";
import multer from "multer";
const _require = createRequire(import.meta.url);
import path from "path";
import fs from "fs";
import { db } from "./db";
const rawDb = db;
import { parcelAttributes, admins, cancellationReasons } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
const rawSql = sql;
import bcrypt from "bcryptjs";
import { hashPassword, verifyPassword } from "./utils/crypto";
import { canWalletCoverCharge, clampSeatRequest, shouldApplyCustomerLateCancelFee } from "./utils/stability-guards";
import { getConf } from "./config-db";
import rateLimit from "express-rate-limit";
import {
  initAiTables,
  parseVoiceIntent,
  findBestDrivers,
  getSmartSuggestions,
  getDemandHeatmap,
  checkRouteDeviation,
  checkAbnormalStop,
  checkSpeedAnomaly,
  updateDriverStats,
  refreshAllDriverStats,
  recordWaypoint,
  getTripWaypoints,
  clearTripWaypoints,
} from "./ai";
import { isTrue, isFalse, parseEnv } from "./config/env";
import {
  startDispatch,
  onDriverAccepted,
  onDriverRejected,
  cancelDispatch,
  hasActiveDispatch,
  getDispatchStatus,
  getActiveDispatchCount,
  startScheduledRideDispatcher,
  startDispatchCleanup,
  resolveServiceType,
  type TripMeta,
} from "./dispatch";
import { diagnoseDispatch, TripNotFoundError } from "./dispatch-diag";
import { activeDriverEligibilitySql } from "./driver-state";
import { getPlatformServiceKeyForCategory, getVehicleCategoryMeta, resolveBookingVehicleSelection } from "./vehicle-matching";
import {
  computeDemandHeatmap,
  calculateSurgeMultiplier,
  calculateDriverBehaviorScore,
  refreshAllBehaviorScores,
  detectFraudPatterns,
  runFraudScan,
  forecastDriverEarnings,
  getRebalancingSuggestion,
  pushRebalancingNotifications,
  getOperationsDashboard,
  initIntelligenceTables,
  startIntelligenceJobs,
} from "./intelligence";
import {
  geocodeWithCache,
  getDistanceWithCache,
  getRouteWithCache,
  getCacheStats,
  clearAllCaches,
  initMapsCacheTables,
  startCacheCleanup,
} from "./maps-cache";
import {
  runRetentionCampaign,
  validateRetentionPromo,
  getRetentionAnalytics,
  initRetentionTables,
  startRetentionCampaignJob,
} from "./retention";
import {
  calculateBillableWeight,
  calculateInsurance,
  validateProhibitedItems,
  calculateExpectedDeliveryMinutes,
  getParcelSLA,
  notifyReceiver,
  notifyAllReceivers,
  fireB2BWebhook,
  parseParcelCSV,
  saveProofOfDelivery,
  getProofOfDelivery,
  emitParcelLifecycle,
  findParcelCapableDrivers,
  findParcelCapableDriversDetailed,
  initParcelAdvancedTables,
} from "./parcel-advanced";
import {
  searchPlaces,
  getPlaceDetails,
  reverseGeocode,
  getMultiWaypointRoute,
  getRealTimeETA,
  extractShortName,
  searchNearbyPlaces,
  getMappingStats,
} from "./mapping-unified";
import {
  calculateRevenueBreakdown,
  settleRevenue,
  getDriverWalletSummary,
  requestWithdrawal,
  approveWithdrawal,
  rejectWithdrawal,
  getPendingWithdrawals,
  getCustomerWallet,
  topUpCustomerWallet,
  getRevenueAnalytics,
  getRevenueByService,
  initRevenueEngineTables,
  SUPPORTED_UPI_PROVIDERS,
  loadRevenueSettings,
} from "./revenue-engine";
import {
  getRuntimeConfigSnapshot,
  initRuntimeConfigTables,
  listRuntimeConfigAuditLogs,
  rollbackRuntimeConfigAuditLog,
  upsertRuntimeConfigEntries,
} from "./runtime-config";
import type { ServiceCategory, PaymentMethod } from "./revenue-engine";
import {
  initDynamicServicesTables,
  getServicesForLocation,
  getParcelVehiclesForLocation,
  recommendVehicle,
  getDriverEligibleServices,
  getCitiesWithServices,
  addCityService,
  toggleCityService,
  getAllParcelVehicles,
  updateParcelVehicle,
  addParcelVehicle,
} from "./dynamic-services";
import {
  ensureOutstationPoolV2Schema,
  registerOutstationPoolV2Routes,
} from "./outstation-pool-v2";
import { registerRollingPoolRoutes } from "./rolling-pool";
import {
  startAIMobilityBrain,
  getCurrentMetrics,
  getAIDashboardData,
  getBrainStatus,
} from "./ai-brain";
import { featureFlags } from "./config/featureFlags";
import {
  getAlertEngineStatus,
  getEngineConfig,
  reloadEngineConfig,
  getMetricHistory,
  executeManualAction,
} from "./alert-engine";
import {
  checkBookingRateLimit,
  detectBookingFraud,
  checkCustomerBans,
  notifyCustomerWithDriver,
  setupTripTimeoutHandlers,
  validateFareAccuracy,
  notifyTripCompletion,
  recordDriverCancellation,
  recordCustomerCancellation,
  notifyTripCancellation,
  getTripStatusForCustomer,
  boostrFareOffer,
} from "./hardening-routes";

// -- Multer upload setup -------------------------------------------------------
const uploadsDir = path.join(process.cwd(), "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
  },
});
const ALLOWED_UPLOAD_MIMETYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);
const upload = multer({
  storage: diskStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_UPLOAD_MIMETYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP images and PDF files are allowed'));
    }
  },
});

function runUploadSingle(req: Request, res: Response, fieldName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.single(fieldName)(req as any, res as any, (err: any) => {
      if (!err) {
        resolve();
        return;
      }
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          reject(new Error("Image upload failed. File is too large. Please use an image under 8 MB."));
          return;
        }
        reject(new Error(`Image upload failed. ${err.message}`));
        return;
      }
      reject(err);
    });
  });
}

async function ensureDriverDocumentsTable() {
  return;
}

async function ensureDriverDetailsRow(userId: string, vehicleType?: string | null) {
  const existing = await rawDb.execute(rawSql`SELECT id FROM driver_details WHERE user_id=${userId}::uuid LIMIT 1`);
  if (!existing.rows.length) {
    await rawDb.execute(rawSql`
      INSERT INTO driver_details (user_id, vehicle_type, availability_status, is_online, total_trips, avg_rating, created_at, updated_at)
      VALUES (${userId}::uuid, ${vehicleType || 'bike'}, 'offline', false, 0, 5.0, now(), now())
    `);
    return;
  }
  if (vehicleType) {
    await rawDb.execute(rawSql`
      UPDATE driver_details SET vehicle_type=${vehicleType}, updated_at=now() WHERE user_id=${userId}::uuid
    `);
  }
}

function generateRefId(): string {
  return "TRP" + Math.random().toString(36).substr(2, 7).toUpperCase();
}

// -- Razorpay key helper: env ? DB fallback (consistent across all endpoints) --
export async function getRazorpayKeys(): Promise<{ keyId: string | undefined; keySecret: string | undefined }> {
  const keyId = await getConf("RAZORPAY_KEY_ID", "razorpay_key_id");
  const keySecret = await getConf("RAZORPAY_KEY_SECRET", "razorpay_key_secret");
  return { keyId, keySecret };
}

/**
 * Attempt Razorpay bank refund for a payment.
 * Returns refund ID on success, null on failure (caller should fall back to wallet credit).
 * Idempotent: Razorpay ignores duplicate refund requests for same payment.
 */
async function tryRazorpayRefund(
  razorpayPaymentId: string,
  amountRupees: number,
  tripId: string,
  customerId: string,
  reason: string,
): Promise<string | null> {
  try {
    const { keyId, keySecret } = await getRazorpayKeys();
    if (!keyId || !keySecret) return null;
    const Razorpay = _require("razorpay");
    const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret, timeout: 15000 });
    const result = await rzp.payments.refund(razorpayPaymentId, {
      amount: Math.round(amountRupees * 100),
      speed: "optimum",   // instant if possible, normal otherwise
      notes: { reason, trip_id: tripId, customer_id: customerId },
    });
    // Log the refund
    await rawDb.execute(rawSql`
      INSERT INTO refund_requests (customer_id, trip_id, amount, reason, payment_method, status, admin_note, approved_by, approved_at)
      VALUES (${customerId}::uuid, ${tripId}::uuid, ${amountRupees}, ${reason}, 'razorpay', 'approved',
              ${'Razorpay refund ID: ' + result.id}, 'system', NOW())
      ON CONFLICT DO NOTHING
    `).catch(dbCatch("db"));
    console.log(`[RAZORPAY-REFUND] ?${amountRupees} refund ${result.id} for trip ${tripId}`);
    return result.id as string;
  } catch (e: any) {
    console.error(`[RAZORPAY-REFUND] Failed for trip ${tripId}:`, e.message);
    return null;
  }
}

// Convert snake_case keys to camelCase for frontend consumption
function camelize(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(camelize);
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase()),
      v
    ])
  );
}

function formatDbError(err: any): string {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (err.message && typeof err.message === "string" && err.message.trim().length > 0) return err.message;
  if (Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors
      .map((sub: any) => sub?.message || `${sub?.code || "ERR"} ${sub?.address || ""}:${sub?.port || ""}`.trim())
      .filter(Boolean)
      .join(" | ");
  }
  if (err.cause?.message && typeof err.cause.message === "string") return err.cause.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** dbCatch � logs DB errors instead of silently swallowing them. Use in place of .catch(dbCatch("db")). */
function dbCatch(label: string) {
  return (err: any) => { console.error(`[db:${label}]`, formatDbError(err)); };
}
/** dbCatchRows � logs DB read errors and returns empty rows fallback. */
function dbCatchRows(label: string): (err: any) => { rows: any[] } {
  return (err: any) => { console.error(`[db:${label}]`, formatDbError(err)); return { rows: [] as any[] }; };
}

function normalizePhone(phone: unknown): string {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

function maskPhone(phone: string): string {
  if (!phone) return "";
  return phone.slice(-4).padStart(phone.length, "*");
}

function canonicalRoleForUserType(_userType: string): string {
  return "user";
}

function sanitizeRegistrationPayload(body: any) {
  return {
    phone: maskPhone(normalizePhone(body?.phone)),
    userType: body?.userType || null,
    fullName: typeof body?.fullName === "string" ? body.fullName.trim() : null,
    hasPassword: typeof body?.password === "string" && body.password.length >= 6,
    email: typeof body?.email === "string" ? body.email.trim() : null,
    city: typeof body?.city === "string" ? body.city.trim() : null,
    vehicleType: body?.vehicleType || null,
    vehicleNumber: body?.vehicleNumber || null,
    docType: body?.docType || null,
  };
}

function logRegistrationAudit(event: string, body: any, extra?: Record<string, unknown>) {
  console.info(`[registration] ${event}`, JSON.stringify({
    ...sanitizeRegistrationPayload(body),
    ...(extra || {}),
  }));
}

async function findUserByPhone(trx: any, phone: string, userType?: string) {
  if (userType) {
    return trx.execute(rawSql`
      SELECT *
      FROM users
      WHERE (phone=${phone} OR mobile=${phone})
        AND (
          user_type=${userType}
          OR (${userType}='customer' AND (user_type IS NULL OR role IN ('user', 'customer')))
        )
      LIMIT 1
    `);
  }
  return trx.execute(rawSql`
    SELECT *
    FROM users
    WHERE phone=${phone} OR mobile=${phone}
    LIMIT 1
  `);
}

async function upsertCustomerProfileRow(trx: any, userId: string, city?: string | null) {
  await trx.execute(rawSql`
    INSERT INTO customer_profiles (user_id, city, created_at, updated_at)
    VALUES (${userId}::uuid, ${city || null}, NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET city = COALESCE(EXCLUDED.city, customer_profiles.city),
        updated_at = NOW()
  `);
}

async function upsertVehicleRow(
  trx: any,
  userId: string,
  vehicle: {
    vehicleType?: string | null;
    vehicleBrand?: string | null;
    vehicleModel?: string | null;
    vehicleColor?: string | null;
    vehicleYear?: number | null;
    vehicleNumber?: string | null;
    verificationStatus?: string | null;
  },
) {
  await trx.execute(rawSql`
    INSERT INTO vehicles (
      user_id, vehicle_type, brand, model, color, vehicle_year,
      registration_number, verification_status, created_at, updated_at
    )
    VALUES (
      ${userId}::uuid, ${vehicle.vehicleType || null}, ${vehicle.vehicleBrand || null},
      ${vehicle.vehicleModel || null}, ${vehicle.vehicleColor || null}, ${vehicle.vehicleYear || null},
      ${vehicle.vehicleNumber || null}, ${vehicle.verificationStatus || 'pending'}, NOW(), NOW()
    )
    ON CONFLICT (user_id) DO UPDATE
    SET vehicle_type = COALESCE(EXCLUDED.vehicle_type, vehicles.vehicle_type),
        brand = COALESCE(EXCLUDED.brand, vehicles.brand),
        model = COALESCE(EXCLUDED.model, vehicles.model),
        color = COALESCE(EXCLUDED.color, vehicles.color),
        vehicle_year = COALESCE(EXCLUDED.vehicle_year, vehicles.vehicle_year),
        registration_number = COALESCE(EXCLUDED.registration_number, vehicles.registration_number),
        verification_status = COALESCE(EXCLUDED.verification_status, vehicles.verification_status),
        updated_at = NOW()
  `);
}

async function upsertDriverDetailsRow(
  trx: any,
  userId: string,
  vehicleType?: string | null,
  vehicleCategoryId?: string | null,
) {
  await trx.execute(rawSql`
    INSERT INTO driver_details (
      user_id, vehicle_type, vehicle_category_id, availability_status,
      is_online, total_trips, avg_rating, created_at, updated_at
    )
    VALUES (
      ${userId}::uuid, ${vehicleType || 'bike'}, ${vehicleCategoryId || null}::uuid,
      'offline', false, 0, 5.0, NOW(), NOW()
    )
    ON CONFLICT (user_id) DO UPDATE
    SET vehicle_type = COALESCE(EXCLUDED.vehicle_type, driver_details.vehicle_type),
        vehicle_category_id = COALESCE(EXCLUDED.vehicle_category_id, driver_details.vehicle_category_id),
        updated_at = NOW()
  `);
}

async function upsertDriverDocumentRow(
  trx: any,
  userId: string,
  docType: string,
  fileUrl: string,
  expiryDate?: string | null,
) {
  await trx.execute(rawSql`
    INSERT INTO driver_documents (
      driver_id, doc_type, file_url, doc_url, status, verification_status,
      expiry_date, created_at, updated_at
    )
    VALUES (
      ${userId}::uuid, ${docType}, ${fileUrl}, ${fileUrl},
      'pending', 'pending', ${expiryDate || null}, NOW(), NOW()
    )
    ON CONFLICT (driver_id, doc_type) DO UPDATE
    SET file_url = EXCLUDED.file_url,
        doc_url = EXCLUDED.doc_url,
        status = 'pending',
        verification_status = 'pending',
        expiry_date = COALESCE(EXCLUDED.expiry_date, driver_documents.expiry_date),
        updated_at = NOW()
  `);

  await trx.execute(rawSql`
    INSERT INTO documents (
      id, user_id, document_type, document_name, document_url, status, submitted_at
    )
    VALUES (
      gen_random_uuid()::text, ${userId}::uuid, ${docType}, ${docType}, ${fileUrl}, 'pending', NOW()
    )
    ON CONFLICT (user_id, document_type) DO UPDATE
    SET document_name = EXCLUDED.document_name,
        document_url = EXCLUDED.document_url,
        status = EXCLUDED.status,
        submitted_at = NOW()
  `);
}

function normalizeAppRole(user: any): string {
  return String(user?.userType || user?.user_type || user?.role || "").toLowerCase();
}

function canUseCustomerApp(user: any): boolean {
  const userType = String(user?.userType || user?.user_type || "").toLowerCase();
  const role = String(user?.role || "").toLowerCase();
  return userType === "customer" || role === "customer" || role === "user";
}

function canUseDriverApp(user: any): boolean {
  const userType = String(user?.userType || user?.user_type || "").toLowerCase();
  const role = String(user?.role || "").toLowerCase();
  return userType === "driver" || role === "driver" || role === "pilot";
}

function persistBase64Upload(imageData: string, docType: string): string {
  const match = String(imageData).match(/^data:([^;]+);base64,(.+)$/);
  const mimeType = match?.[1] || "image/jpeg";
  const base64Body = match?.[2] || String(imageData);
  const allowed: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  const ext = allowed[mimeType.toLowerCase()];
  if (!ext) throw new Error("Unsupported image format. Please upload JPG, PNG, WEBP, HEIC, or HEIF.");

  const buffer = Buffer.from(base64Body, "base64");
  if (!buffer.length) throw new Error("Image upload failed. Empty file.");
  if (buffer.length > 8 * 1024 * 1024) throw new Error("Image is too large. Please retake a smaller photo.");

  const uploadDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const safeType = String(docType || "document").replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}-${safeType}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, filename), buffer);
  return `/uploads/${filename}`;
}

async function provisionAppUserSessionTx(
  trx: any,
  input: {
    phone: string;
    userType: string;
    fullName?: string | null;
    email?: string | null;
    passwordHash?: string | null;
    referralCode?: string | null;
    city?: string | null;
    vehicleType?: string | null;
  },
) {
  const anyUserRes = await findUserByPhone(trx, input.phone);
  const anyUser = anyUserRes.rows.length ? (camelize(anyUserRes.rows[0]) as any) : null;
  const isNew = !anyUser;
  const fullName = (input.fullName || anyUser?.fullName || anyUser?.name || `User_${input.phone.slice(-4)}`).trim();
  const role = canonicalRoleForUserType(input.userType);
  const verificationStatus =
    input.userType === "driver"
      ? (anyUser?.verificationStatus && String(anyUser.verificationStatus).trim()) || "pending"
      : (anyUser?.verificationStatus && String(anyUser.verificationStatus).trim()) || "verified";

  let userId = anyUser?.id as string | undefined;
  if (anyUser) {
    await trx.execute(rawSql`
      UPDATE users
      SET name=${fullName},
          full_name=${fullName},
          mobile=${input.phone},
          phone=${input.phone},
          email=${input.email || anyUser.email || null},
          role=COALESCE(role, ${role}),
          user_type=${input.userType},
          password_hash=COALESCE(${input.passwordHash || null}, password_hash),
          verification_status=${verificationStatus},
          is_active=true,
          updated_at=NOW()
      WHERE id=${anyUser.id}::uuid
    `);
  } else {
    const inserted = await trx.execute(rawSql`
      INSERT INTO users (
        name, full_name, mobile, phone, email, role, user_type,
        is_active, wallet_balance, password_hash, verification_status
      )
      VALUES (
        ${fullName}, ${fullName}, ${input.phone}, ${input.phone}, ${input.email || null},
        ${role}, ${input.userType}, true, 0, ${input.passwordHash || null}, ${verificationStatus}
      )
      RETURNING id
    `);
    userId = (inserted.rows[0] as any)?.id;
  }

  if (!userId) {
    throw new Error("Failed to resolve user id during registration");
  }

  if (input.userType === "driver") {
    await upsertDriverDetailsRow(trx, userId, input.vehicleType || "bike");
  } else {
    await upsertCustomerProfileRow(trx, userId, input.city || null);
  }

  const referralCode = `JAGOPRO${input.phone.slice(-6)}`;
  await trx.execute(rawSql`
    UPDATE users
    SET referral_code = COALESCE(referral_code, ${referralCode})
    WHERE id=${userId}::uuid
  `);

  if (input.referralCode) {
    const referrer = await trx.execute(rawSql`SELECT id FROM users WHERE referral_code=${input.referralCode} LIMIT 1`);
    if (referrer.rows.length) {
      await trx.execute(rawSql`
        INSERT INTO referrals (referrer_id, referred_id, referral_type, status, reward_amount)
        VALUES (${(referrer.rows[0] as any).id}::uuid, ${userId}::uuid, ${input.userType}, 'pending', 50)
        ON CONFLICT DO NOTHING
      `);
    }
  }

  const finalUserRes = await findUserByPhone(trx, input.phone, input.userType);
  const finalUser = camelize(finalUserRes.rows[0]) as any;
  const token = `${userId}:${crypto.randomBytes(32).toString("hex")}`;
  const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await trx.execute(rawSql`
    UPDATE users
    SET auth_token=${token},
        auth_token_expires_at=${tokenExpiry},
        last_login_at=NOW()
    WHERE id=${userId}::uuid
  `);

  return {
    isNew,
    token,
    user: finalUser,
  };
}

const TRIP_UI_STATE_MAP: Record<string, string> = {
  searching: "requested",
  driver_assigned: "driver_assigned",
  accepted: "driver_assigned",
  arrived: "driver_arriving",
  on_the_way: "trip_in_progress",
  completed: "trip_completed",
  cancelled: "trip_cancelled",
};

function toUiTripState(trip: any): string {
  const raw = String(trip?.currentStatus || trip?.current_status || "requested");
  if (raw === "on_the_way") {
    const startedAtRaw = trip?.rideStartedAt || trip?.ride_started_at;
    if (startedAtRaw) {
      const elapsedSec = Math.max(0, Math.floor((Date.now() - new Date(startedAtRaw).getTime()) / 1000));
      if (elapsedSec <= 90) return "trip_started";
    }
  }
  return TRIP_UI_STATE_MAP[raw] || raw;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** GeoJSON [lng, lat] ring ray-cast point-in-polygon */
function pointInPolygon(lat: number, lng: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]; // GeoJSON is [lng, lat]
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi) / (yj - yi) + xi))) inside = !inside;
  }
  return inside;
}

/** Auto-detect which DB zone a lat/lng falls inside. Returns zone UUID or null.
 *  Pass 1: polygon (GeoJSON) � exact boundary check.
 *  Pass 2: radius fallback � if zone has center lat/lng set, check haversine distance = radius_km.
 */
async function detectZoneId(lat: number, lng: number): Promise<string | null> {
  if (!lat || !lng) return null;
  try {
    const zones = await rawDb.execute(rawSql`
      SELECT id, coordinates, latitude, longitude, radius_km FROM zones WHERE is_active=true
    `);
    // Pass 1: polygon-based detection (most accurate)
    for (const z of zones.rows as any[]) {
      if (!z.coordinates) continue;
      try {
        const geo = JSON.parse(z.coordinates);
        if (geo.type === 'Polygon' && geo.coordinates?.[0]) {
          if (pointInPolygon(lat, lng, geo.coordinates[0])) return z.id as string;
        } else if (geo.type === 'MultiPolygon') {
          for (const poly of geo.coordinates) {
            if (poly?.[0] && pointInPolygon(lat, lng, poly[0])) return z.id as string;
          }
        }
      } catch { }
    }
    // Pass 2: radius-based fallback for zones without polygon
    for (const z of zones.rows as any[]) {
      if (z.coordinates) continue; // already checked in pass 1
      const cLat = Number(z.latitude);
      const cLng = Number(z.longitude);
      if (!cLat || !cLng) continue;
      const d = haversineKm(lat, lng, cLat, cLng);
      const r = Number(z.radius_km || 5);
      if (d <= r) return z.id as string;
    }
  } catch { }
  return null;
}

function computeEtaMinutes(distanceKm: number, avgSpeedKmph = 25): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 0;
  return Math.max(1, Math.round((distanceKm / avgSpeedKmph) * 60));
}

/** safeFloat � parses to float with a mandatory fallback, preventing NaN in fare calculations. */
function safeFloat(value: any, fallback: number): number {
  const n = parseFloat(value);
  return isFinite(n) ? n : fallback;
}

/** safeInteger � parses to integer with a mandatory fallback, preventing NaN. */
function safeInteger(value: any, fallback: number): number {
  const n = parseInt(String(value), 10);
  return isFinite(n) ? n : fallback;
}

/** validateCoordinate � validates latitude or longitude is within valid bounds. */
function validateCoordinate(value: any, isLatitude = true): number | null {
  const n = parseFloat(value);
  if (!isFinite(n)) return null;
  const [min, max] = isLatitude ? [-90, 90] : [-180, 180];
  return n >= min && n <= max ? n : null;
}

/** validateLatLng � validates a lat/lng pair; throws on invalid. */
function validateLatLng(lat: any, lng: any): { lat: number; lng: number } {
  const validLat = validateCoordinate(lat, true);
  const validLng = validateCoordinate(lng, false);
  if (validLat === null || validLng === null) {
    throw new Error(`Invalid coordinates: lat=${lat}, lng=${lng}`);
  }
  return { lat: validLat, lng: validLng };
}

/** validateMoneyAmount � validates amount is non-negative and within reasonable bounds. */
function validateMoneyAmount(value: any, maxAmount = 999999999): number {
  const n = parseFloat(value);
  if (!isFinite(n) || n < 0 || n > maxAmount) {
    throw new Error(`Invalid amount: ${value} (must be 0-${maxAmount})`);
  }
  return n;
}

/** validateEnumValue � validates value is in allowed set. */
function validateEnumValue(value: any, allowed: string[]): string {
  const s = String(value || "").trim();
  if (!allowed.includes(s)) {
    throw new Error(`Invalid value: ${value} (allowed: ${allowed.join(", ")})`);
  }
  return s;
}

/** Returns a safe error message: generic in production, detailed in development. */
function safeErrMsg(e: any, fallback = "An unexpected error occurred. Please try again."): string {
  if (process.env.NODE_ENV === "production") return fallback;
  return e?.message || fallback;
}

function shortLocationName(value: any): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.split(",")[0].trim();
}

type GeocodeHit = { lat: number; lng: number; address: string };
const geocodeCache = new Map<string, { value: GeocodeHit; expiresAt: number }>();
const GEOCODE_TTL_MS = 5 * 60 * 1000;

async function geocodePlaceWithCache(apiKey: string, place: string): Promise<GeocodeHit | null> {
  const normalized = String(place || "").trim();
  if (!normalized || !apiKey) return null;
  const key = `${apiKey.slice(0, 8)}:${normalized.toLowerCase()}`;
  const now = Date.now();
  const cached = geocodeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(normalized)}&key=${apiKey}`;
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return null;
    const d = await r.json() as any;
    if (d?.status !== "OK" || !Array.isArray(d.results) || !d.results.length) return null;
    const loc = d.results[0]?.geometry?.location;
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
    const hit: GeocodeHit = {
      lat: Number(loc.lat),
      lng: Number(loc.lng),
      address: d.results[0]?.formatted_address || normalized,
    };
    if (geocodeCache.size > 2000) geocodeCache.clear();
    geocodeCache.set(key, { value: hit, expiresAt: now + GEOCODE_TTL_MS });
    return hit;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function appendTripStatus(tripId: string, status: string, source = "system", note?: string) {
  if (!tripId) return;
  await rawDb.execute(rawSql`
    INSERT INTO trip_status (trip_id, status, source, note)
    VALUES (${tripId}::uuid, ${status}, ${source}, ${note || null})
  `).catch(dbCatch("db"));
}

async function logRideLifecycleEvent(tripId: string, eventType: string, actorId?: string, actorType = "system", meta: any = {}) {
  if (!tripId) return;
  await rawDb.execute(rawSql`
    INSERT INTO ride_events (trip_id, event_type, actor_id, actor_type, meta)
    VALUES (${tripId}::uuid, ${eventType}, ${actorId || null}::uuid, ${actorType}, ${JSON.stringify(meta)}::jsonb)
  `).catch(dbCatch("db"));
}

async function logAdminAction(action: string, entityType: string, entityId?: string, details: any = {}, adminEmail?: string) {
  await rawDb.execute(rawSql`
    INSERT INTO admin_logs (admin_email, action, entity_type, entity_id, details)
    VALUES (${adminEmail || null}, ${action}, ${entityType}, ${entityId || null}::uuid, ${JSON.stringify(details)}::jsonb)
  `).catch(dbCatch("db"));
}


// Login rate limiter � max 5 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many login attempts. Please try again after 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

// OTP rate limiter � max 10 requests per hour per IP (extra protection beyond per-phone DB check)
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { message: "Too many OTP requests. Please try again after an hour." },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

// App API general rate limiter � max 300 requests per minute per IP
const appLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { message: "Too many requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

// Nearby-drivers rate limiter � max 30 requests per minute per IP (prevents driver tracking abuse)
const nearbyDriversLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { message: "Too many location requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

const driverTripActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { message: "Too many driver trip actions. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

const paymentOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { message: "Too many payment requests. Please wait a minute." },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

// Admin data creation rate limiter � max 30 creates per hour per admin (prevents abuse)
const adminDataLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { message: "Too many create operations. Please wait before creating more items." },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

const ADMIN_SESSION_TTL_HOURS = Math.max(1, Number(process.env.ADMIN_SESSION_TTL_HOURS || 24));
// SECURITY: Never expose OTPs in production responses, regardless of env var setting
const isDevOtpResponseEnabled = process.env.ENABLE_DEV_OTP_RESPONSES === "true" && process.env.NODE_ENV !== "production";
const VOICE_BOOKING_ENABLED =
  featureFlags.enableExperimentalVoiceBooking || featureFlags.useVoiceAssistantV2;
const AI_MOBILITY_BRAIN_ENABLED = featureFlags.enableAiMobilityBrain;

const AI_ASSISTANT_SERVICE_URL = (process.env.AI_ASSISTANT_SERVICE_URL || "").replace(/\/$/, "");
if (!VOICE_BOOKING_ENABLED) {
  console.log("[VOICE] Experimental voice booking is disabled; external AI assistant dependency removed from production path.");
} else if (AI_ASSISTANT_SERVICE_URL.includes('localhost') && process.env.NODE_ENV === 'production') {
  console.warn("[WARN] AI_ASSISTANT_SERVICE_URL points to localhost in production. Voice-intent AI microservice will be SKIPPED � set AI_ASSISTANT_SERVICE_URL env var to enable it.");
}

// -- Claude AI voice intent parser --------------------------------------------
async function parseVoiceIntentWithClaude(text: string): Promise<any | null> {
  if (!VOICE_BOOKING_ENABLED) return null;
  // Read live from DB first (admin panel save), fallback to env var
  let apiKey = process.env.ANTHROPIC_API_KEY;
  try {
    const dbR = await rawDb.execute(rawSql`SELECT value FROM business_settings WHERE key_name='anthropic_api_key' LIMIT 1`);
    const dbKey = (dbR.rows[0] as any)?.value?.trim();
    if (dbKey) apiKey = dbKey;
  } catch (_) { }
  if (!apiKey) return null;
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{
        role: "user",
        content: `You are a multi-service booking assistant for JAGO Pro mobility app in India.
JAGO Pro offers: ride-hailing (Bike/Auto/Car), parcel logistics, and intercity carpool.
Extract the booking intent from the user's voice command.

User said: "${text}"

Return ONLY valid JSON (no markdown, no explanation):
{
  "intent": "book_ride" | "send_parcel" | "book_intercity" | "cancel_ride" | "check_status" | "unknown",
  "pickup": "exact pickup location name or null",
  "destination": "exact destination location name or null",
  "vehicleType": "Bike" | "Auto" | "Mini Auto" | "Sedan" | "SUV" | "Car Pool" | "Bike Parcel" | "Mini Truck" | "Pickup Truck" | null,
  "confidence": 0.0-1.0
}

Intent rules (apply in order):
1. send_parcel ? if user says: parcel, courier, delivery, package, send, pampali, pampu, cargo, truck delivery, mini truck, pickup truck, goods delivery, furniture delivery, move house
2. book_intercity ? if user says: outstation, intercity, bangalore, hyderabad to [city], [city] to [city], long distance, overnight, highway trip, carpool seat
3. book_ride ? all other ride requests: bike, auto, cab, car, rickshaw, lift, ride, drop
4. unknown ? if none of the above is clear

Vehicle type rules:
- Bike Parcel ? for small parcels =10kg, documents
- Mini Truck ? for furniture, appliances, medium goods, tata ace
- Pickup Truck ? for heavy goods, construction, commercial
- Car Pool ? if user says "carpool", "share cab", "pool", "seat kavali"
- Bike ? "bike ride", "motor", "two-wheeler ride" (NOT parcel)
- Auto ? "auto", "autorickshaw", "temo", "three-wheeler"
- Sedan/SUV ? "car", "cab", "sedan", "suv"

Language support:
- Telugu: kavali=need, pampali=send, ride=ride, parcel=parcel
- Hindi: chahiye=need, bhejo=send, savari=ride
- Mixed/Hinglish is normal � handle it

Special: if pickup is clearly the current user location (like "here", "current location", "yahan", "ikada") ? return pickup=null (app uses GPS).
If no clear destination ? return destination=null.
confidence: 0.9 if intent+locations clear, 0.7 if partial, 0.4 if unclear`
      }],
    });
    const raw = (msg.content[0] as any).text?.trim() || "";
    const jsonStr = raw.replace(/^```json?\s*/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(jsonStr);
    return {
      intent: parsed.intent || "unknown",
      pickup: parsed.pickup || null,
      destination: parsed.destination || null,
      vehicleType: parsed.vehicleType || null,
      confidence: Number(parsed.confidence) || 0.7,
      entities: { vehicle: parsed.vehicleType || null },
    };
  } catch (_) {
    return null;
  }
}

type AssistantVoiceIntent = {
  intent?: string;
  confidence?: number;
  entities?: {
    pickup?: string | null;
    destination?: string | null;
    serviceSuggestion?: string | null;
  };
};

function mapServiceSuggestionToVehicle(serviceSuggestion?: string | null): string | null {
  if (!serviceSuggestion) return null;
  const s = String(serviceSuggestion).toLowerCase();
  if (s.includes("pickup truck") || s.includes("pickup_truck")) return "Pickup Truck";
  if (s.includes("mini truck") || s.includes("tata ace") || s.includes("tata_ace")) return "Mini Truck";
  if (s.includes("parcel")) return "Bike Parcel";
  if (s.includes("pool") || s.includes("carpool")) return "Car Pool";
  if (s.includes("bike") || s.includes("moto")) return "Bike";
  if (s.includes("auto") || s.includes("temo")) return "Mini Auto";
  if (s.includes("suv") || s.includes("innova")) return "SUV";
  if (s.includes("car") || s.includes("cab") || s.includes("sedan")) return "Car";
  return null;
}

async function parseVoiceIntentOrchestrated(text: string): Promise<{ parsed: any; parserSource: "claude-ai" | "ai-assistant-service" | "monolith-fallback" }> {
  if (!VOICE_BOOKING_ENABLED) {
    return { parserSource: "monolith-fallback", parsed: parseVoiceIntent(text) };
  }
  // 1. Try external AI microservice � skip if it's the default localhost (not deployed)
  const isExternalService = AI_ASSISTANT_SERVICE_URL && !AI_ASSISTANT_SERVICE_URL.includes('localhost');
  if (isExternalService) try {
    const r = await fetch(`${AI_ASSISTANT_SERVICE_URL}/internal/voice/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: text }),
      signal: AbortSignal.timeout(1500), // reduced from 3000ms
    });
    if (r.ok) {
      const aiPayload = (await r.json()) as AssistantVoiceIntent;
      const intent = (aiPayload.intent || "unknown") as any;
      const pickup = aiPayload.entities?.pickup || null;
      const destination = aiPayload.entities?.destination || null;
      const serviceSuggestion = mapServiceSuggestionToVehicle(aiPayload.entities?.serviceSuggestion);
      return {
        parserSource: "ai-assistant-service",
        parsed: {
          intent, confidence: Number(aiPayload.confidence || 0.7),
          pickup, destination, vehicleType: serviceSuggestion,
          entities: { ...(aiPayload.entities || {}), vehicle: serviceSuggestion || aiPayload.entities?.serviceSuggestion || null },
        },
      };
    }
  } catch (_) { } // end external microservice block

  // 2. Claude AI (Haiku) � fast, cheap, understands Telugu/Hindi/all Indian languages
  const claudeParsed = await parseVoiceIntentWithClaude(text);
  if (claudeParsed) {
    return { parserSource: "claude-ai", parsed: claudeParsed };
  }

  // 3. Local regex fallback
  return { parserSource: "monolith-fallback", parsed: parseVoiceIntent(text) };
}
const runtimeEnv = parseEnv();
// In production 2FA is ON by default � disable only with ADMIN_2FA_REQUIRED=false
const requireAdminTwoFactor = false;

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim() || null;
}

async function issueAdminSession(adminId: string) {
  const sessionToken = `${adminId}:${crypto.randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000);
  await rawDb.execute(rawSql`
    UPDATE admins
    SET auth_token=${sessionToken}, auth_token_expires_at=${expiresAt.toISOString()}, last_login_at=NOW()
    WHERE id=${adminId}::uuid
  `);
  return { sessionToken, expiresAt };
}

function requireAdminRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = String((req as any)?.adminUser?.role || "").toLowerCase();
    if (!role || !allowedRoles.map((r) => r.toLowerCase()).includes(role)) {
      return res.status(403).json({ message: "Insufficient admin permissions" });
    }
    next();
  };
}

function requireOpsKey(req: Request, res: Response, next: NextFunction) {
  const configuredKey = process.env.OPS_API_KEY;
  if (!configuredKey) return res.status(503).json({ message: "Operations API key is not configured" });
  const key = String(req.headers["x-ops-key"] || "").trim();
  if (!key || key !== configuredKey) return res.status(401).json({ message: "Invalid operations API key" });
  next();
}

// Standalone admin auth for routes NOT under /api/admin/ prefix (which has global middleware).
// Use on every legacy admin route that handles sensitive data or write operations.
async function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req);
  if (!token) return res.status(401).json({ message: "Admin authorization required" });
  try {
    const r = await rawDb.execute(rawSql`
      SELECT id, name, email, role, is_active FROM admins
      WHERE auth_token=${token} AND is_active=true
        AND (auth_token_expires_at IS NULL OR auth_token_expires_at > NOW())
      LIMIT 1
    `);
    if (!r.rows.length) return res.status(401).json({ message: "Admin session expired. Please login again." });
    (req as any).adminUser = camelize(r.rows[0]);
    next();
  } catch (_e: any) {
    res.status(401).json({ message: "Admin authentication failed" });
  }
}

async function ensureAdminExists() {
  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!adminEmail) { console.error("[SECURITY] ADMIN_EMAIL env var not set � skipping admin sync."); return; }
  const adminName = (process.env.ADMIN_NAME || "Admin").trim() || "Admin";
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.error("[SECURITY] ADMIN_PASSWORD env var not set � skipping admin password sync. Set ADMIN_PASSWORD in .do/app.yaml or .env");
    return;
  }

  const maskedAdminEmail = (() => {
    const [local, domain] = String(adminEmail || "").split("@");
    if (!domain) return "[REDACTED_EMAIL]";
    return `${(local || "").slice(0, 2)}***@${domain}`;
  })();
  console.log(`[admin-bootstrap] Starting admin sync for ${maskedAdminEmail}, sync_on_restart=${process.env.ADMIN_PASSWORD_SYNC_ON_RESTART}`);


  // -- Step 1: Guarantee the tables exist using rawDb (same path as ensureOperationalSchema)
  try {
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS admins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(191) NOT NULL UNIQUE,
        password VARCHAR(191) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'admin',
        is_active BOOLEAN NOT NULL DEFAULT true,
        auth_token TEXT,
        auth_token_expires_at TIMESTAMP,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } catch (e: any) { console.error("[admin] create admins table:", formatDbError(e)); }

  // -- Self-heal: add missing columns that may not exist on older deployments --
  await rawDb.execute(rawSql`ALTER TABLE admins ADD COLUMN IF NOT EXISTS auth_token TEXT`).catch(dbCatch("db"));
  await rawDb.execute(rawSql`ALTER TABLE admins ADD COLUMN IF NOT EXISTS auth_token_expires_at TIMESTAMP`).catch(dbCatch("db"));
  await rawDb.execute(rawSql`ALTER TABLE admins ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP`).catch(dbCatch("db"));
  await rawDb.execute(rawSql`ALTER TABLE admins ADD COLUMN IF NOT EXISTS role VARCHAR(50) NOT NULL DEFAULT 'admin'`).catch(dbCatch("db"));
  await rawDb.execute(rawSql`ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`).catch(dbCatch("db"));

  try {
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS admin_login_otp (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID NOT NULL,
        otp VARCHAR(10) NOT NULL,
        is_used BOOLEAN NOT NULL DEFAULT false,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
  } catch (_) { }
  try { await rawDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_admins_auth_token ON admins(auth_token)`); } catch (_) { }
  try { await rawDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_admin_login_otp_admin_created ON admin_login_otp(admin_id, created_at DESC)`); } catch (_) { }

  // -- Step 2: Seed / sync admin account using rawDb (never uses Drizzle ORM table refs)
  try {
    const existingR = await rawDb.execute(rawSql`
      SELECT id, is_active FROM admins WHERE email = ${adminEmail} LIMIT 1
    `);
    const existingRow: any = existingR.rows[0];

    if (!existingRow) {
      // Check for any admin with a different email (first-deploy email mismatch)
      const anyR = await rawDb.execute(rawSql`SELECT id, email FROM admins ORDER BY created_at ASC LIMIT 5`);
      const hash = await hashPassword(adminPassword);

      if (anyR.rows.length > 0) {
        // Migrate the first admin to the configured ADMIN_EMAIL
        const firstAdmin: any = anyR.rows[0];
        const migrateHash = await hashPassword(adminPassword);
        await rawDb.execute(rawSql`
          UPDATE admins SET email=${adminEmail}, name=${adminName}, password=${migrateHash}, is_active=true
          WHERE id=${firstAdmin.id}::uuid
        `);
        for (let i = 1; i < anyR.rows.length; i++) {
          const a: any = anyR.rows[i];
          await rawDb.execute(rawSql`DELETE FROM admins WHERE id=${a.id}::uuid`).catch(dbCatch("db"));
        }
        console.log(`[admin] Migrated admin ? ${adminEmail}, password synced`);
      } else {
        // No admin at all � create one
        const createHash = await hashPassword(adminPassword);
        await rawDb.execute(rawSql`
          INSERT INTO admins (name, email, password, role, is_active)
          VALUES (${adminName}, ${adminEmail}, ${createHash}, 'superadmin', true)
          ON CONFLICT (email) DO NOTHING
        `);
        console.log(`[admin] Admin created: ${adminEmail}`);
      }
    } else {
      // Admin exists � password sync ONLY on explicit restart flag to prevent overwriting user changes
      // By default, users can change their password and it will persist across restarts
      // Keep local/dev admin credentials aligned with .env so login verification
      // does not fail because of a stale password left in the database.
      // Production still requires an explicit opt-in flag before overwriting.
      const shouldSyncPassword =
        process.env.ADMIN_PASSWORD_SYNC_ON_RESTART === 'true' ||
        runtimeEnv.NODE_ENV !== 'production';
      console.log(`[admin-bootstrap] Admin exists: ${maskedAdminEmail}, should_sync_password=${shouldSyncPassword}`);
      if (shouldSyncPassword) {
        console.log(`[admin-bootstrap] Hashing new password for ${maskedAdminEmail}...`);
        const hash = await hashPassword(adminPassword);
        console.log(`[admin-bootstrap] Password hash generated successfully`);
        const updateResult = await rawDb.execute(rawSql`
          UPDATE admins 
          SET password=${hash}, is_active=true, auth_token=NULL, auth_token_expires_at=NULL 
          WHERE LOWER(email)=${adminEmail}
          RETURNING id, email, password
        `);
        if (updateResult.rows.length > 0) {
          const updated: any = updateResult.rows[0];
          console.log(`[admin-bootstrap] Password synced for ${maskedAdminEmail} (ID: ${updated.id})`);
        } else {
          console.warn(`[admin-bootstrap] ? Update returned no rows - admin may not exist or email doesn't match`);
        }
      } else {
        // Ensure admin is marked as active but DO NOT override password
        await rawDb.execute(rawSql`UPDATE admins SET is_active=true, auth_token=NULL, auth_token_expires_at=NULL WHERE LOWER(email)=${adminEmail}`);
        console.log(`[admin] Admin ensured active: ${adminEmail} (password NOT overridden)`);
      }
    }
  } catch (e: any) {
    console.error("[admin] ensureAdminExists error:", formatDbError(e));
  }
}

async function ensureOperationalSchema() {
  try {
    await rawDb.execute(rawSql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // -- Core auth tables � must always exist even if Drizzle migrations haven't run --
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS admins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(191) NOT NULL UNIQUE,
        password VARCHAR(191) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'admin',
        is_active BOOLEAN NOT NULL DEFAULT true,
        auth_token TEXT,
        auth_token_expires_at TIMESTAMP,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS admin_login_otp (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID NOT NULL,
        otp VARCHAR(10) NOT NULL,
        is_used BOOLEAN NOT NULL DEFAULT false,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    // Used by forgot-password / reset-password flow
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS admin_otp_resets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(191) NOT NULL,
        otp VARCHAR(10) NOT NULL,
        is_used BOOLEAN NOT NULL DEFAULT false,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await rawDb.execute(rawSql`
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(50);
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS rejected_driver_ids UUID[] DEFAULT '{}'::uuid[];
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_status VARCHAR(30) DEFAULT 'pending';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS current_trip_id UUID;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS license_expiry DATE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_brand VARCHAR(120);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_color VARCHAR(60);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_year INTEGER;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS city VARCHAR(120);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS selfie_image TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS revenue_model VARCHAR(30) DEFAULT 'commission';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS model_selected_at TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preference VARCHAR(20) DEFAULT 'light';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS onboard_date TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS free_period_end TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS launch_free_active BOOLEAN DEFAULT false;
      -- Backfill: give existing approved drivers their 30-day free period from created_at
      UPDATE users SET
        onboard_date = COALESCE(onboard_date, created_at),
        free_period_end = COALESCE(free_period_end, created_at + INTERVAL '30 days'),
        launch_free_active = CASE
          WHEN (created_at + INTERVAL '30 days') >= NOW() THEN true
          ELSE false
        END
      WHERE user_type = 'driver' AND verification_status = 'approved' AND onboard_date IS NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS completed_rides_count INTEGER NOT NULL DEFAULT 0;

      -- Dynamic Platform Services Table
      CREATE TABLE IF NOT EXISTS platform_services (
        id SERIAL PRIMARY KEY,
        service_key VARCHAR(100) UNIQUE NOT NULL,
        service_name VARCHAR(255) NOT NULL,
        service_status VARCHAR(50) DEFAULT 'active',
        revenue_model VARCHAR(50) DEFAULT 'commission',
        commission_rate NUMERIC(10,2) DEFAULT 15,
        icon VARCHAR(100),
        color VARCHAR(100),
        description TEXT,
        short_description TEXT DEFAULT '',
        image_url TEXT DEFAULT '',
        eta_label VARCHAR(50) DEFAULT '',
        service_category VARCHAR(50) DEFAULT 'rides',
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Seed defaults if table is empty
    const { rows: existingSvcs } = await rawDb.execute(rawSql`SELECT COUNT(*)::int FROM platform_services`);
    if (parseInt((existingSvcs[0] as any).count) === 0) {
      await rawDb.execute(rawSql`
        INSERT INTO platform_services (service_key, service_name, service_status, revenue_model, commission_rate, sort_order, icon, color, service_category)
        VALUES 
          ('bike_ride', 'Bike Ride', 'active', 'commission', 15.0, 1, '🏍️', '#2F7BFF', 'rides'),
          ('parcel_delivery', 'Parcel Delivery', 'active', 'commission', 18.0, 2, '📦', '#10B981', 'parcel'),
          ('auto_ride', 'Auto Ride', 'active', 'commission', 12.0, 3, '🛺', '#F59E0B', 'rides'),
          ('mini_car', 'Mini Car', 'active', 'commission', 10.0, 4, '🚗', '#2563EB', 'rides'),
          ('sedan', 'Sedan Car', 'active', 'commission', 10.0, 5, '🚕', '#4F46E5', 'rides'),
          ('suv', 'SUV Car', 'active', 'commission', 10.0, 6, '🚙', '#7C3AED', 'rides')
      `);
    }

    await rawDb.execute(rawSql`
      ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
      ALTER TABLE trip_fares ADD COLUMN IF NOT EXISTS helper_charge NUMERIC(23,3) DEFAULT 0;

      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS ride_full_fare NUMERIC(23,3) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS user_discount NUMERIC(23,3) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS user_payable NUMERIC(23,3) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(23,3) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS driver_wallet_credit NUMERIC(23,3) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS vehicle_type_name VARCHAR(100);
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(50);
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS original_fare NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS pending_payment_amount NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS seats_booked INTEGER DEFAULT 1;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS seat_price NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS driver_accepted_at TIMESTAMPTZ;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS driver_arriving_at TIMESTAMPTZ;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS driver_arrived_at TIMESTAMPTZ;

      ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR(50);
      ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'ride';
      ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS service_type VARCHAR(30) DEFAULT 'ride';
      ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS base_fare NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS fare_per_km NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS minimum_fare NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS waiting_charge_per_min NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS total_seats INTEGER DEFAULT 0;
      ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS is_carpool BOOLEAN DEFAULT false;

      ALTER TABLE vehicle_brands ADD COLUMN IF NOT EXISTS logo_url TEXT;
      ALTER TABLE vehicle_brands ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'two_wheeler';

      ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_rides INTEGER DEFAULT 0;
      ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS plan_type VARCHAR(30) DEFAULT 'both';

      -- Referral code: unique per user, generated at registration
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(30);
      -- Backfill existing users who don't have a referral code yet
      UPDATE users SET referral_code = 'JAGO' || RIGHT(phone, 4) || UPPER(SUBSTRING(id::text from 1 for 4))
        WHERE referral_code IS NULL AND phone IS NOT NULL AND LENGTH(phone) >= 4;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL;

      UPDATE vehicle_categories
      SET service_type = CASE
        WHEN COALESCE(is_carpool, false) = true THEN 'pool'
        WHEN LOWER(COALESCE(type, '')) IN ('parcel', 'cargo') THEN LOWER(type)
        WHEN LOWER(COALESCE(vehicle_type, '')) SIMILAR TO '%(parcel|cargo|courier|delivery|pickup|truck|tempo|ace)%' THEN 'parcel'
        ELSE 'ride'
      END
      WHERE service_type IS NULL
         OR TRIM(service_type) = ''
         OR (LOWER(COALESCE(type, '')) IN ('parcel', 'cargo') AND LOWER(COALESCE(service_type, '')) NOT IN ('parcel', 'cargo'))
         OR (COALESCE(is_carpool, false) = true AND LOWER(COALESCE(service_type, '')) NOT IN ('pool', 'carpool'))
         OR (COALESCE(is_carpool, false) = false AND LOWER(COALESCE(type, '')) NOT IN ('parcel', 'cargo') AND LOWER(COALESCE(service_type, '')) <> 'ride');

      -- Commission Settlement: per-driver pending balance tracking
      ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_commission_balance NUMERIC(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_gst_balance NUMERIC(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS total_pending_balance NUMERIC(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS lock_threshold NUMERIC(10,2) NOT NULL DEFAULT 200;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

      -- Parcel / delivery fields on trip_requests
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS commission_amount NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS driver_fare NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS customer_fare NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS parcel_category_id UUID;

      -- Weight-based rate on vehicle_categories (for parcel vehicles)
      ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS weight_rate NUMERIC(10,2) DEFAULT 0;

      -- Fix: missing users columns referenced by many routes
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS lock_reason TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS prefer_female_driver BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_name VARCHAR(120);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(30);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS jago_coins INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS break_until TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS rating NUMERIC(3,2) NOT NULL DEFAULT 5.0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS total_ratings INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_token_expires_at TIMESTAMP;

      -- Fix: missing trip_requests columns for parcel/person-booking flow
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS receiver_name VARCHAR(120);
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS receiver_phone VARCHAR(20);
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS is_for_someone_else BOOLEAN DEFAULT false;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS passenger_name VARCHAR(120);
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS passenger_phone VARCHAR(20);
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS pickup_short_name VARCHAR(120);
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS destination_short_name VARCHAR(120);
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS driver_rating NUMERIC(3,1);
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS customer_rating NUMERIC(3,1);
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS driver_note TEXT;
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS tips NUMERIC(10,2) DEFAULT 0;

      -- Fix: reviews table column name mismatch (code uses review_type and comment)
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS review_type VARCHAR(50);
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS comment TEXT;

      -- Fix: safety_alerts missing columns (table may exist as older schema version)
      ALTER TABLE safety_alerts ADD COLUMN IF NOT EXISTS user_id UUID;
      ALTER TABLE safety_alerts ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(20) DEFAULT 'customer';
      ALTER TABLE safety_alerts ADD COLUMN IF NOT EXISTS acknowledged_by_name VARCHAR(120);
      ALTER TABLE safety_alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP;
      ALTER TABLE safety_alerts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
      ALTER TABLE safety_alerts ADD COLUMN IF NOT EXISTS police_notified BOOLEAN DEFAULT false;
      ALTER TABLE safety_alerts ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE safety_alerts ADD COLUMN IF NOT EXISTS nearby_drivers_notified INTEGER DEFAULT 0;
    `);

    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS insurance_plans (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(191) NOT NULL,
        plan_type VARCHAR(50) DEFAULT 'vehicle',
        premium_daily NUMERIC(10,2) DEFAULT 0,
        premium_monthly NUMERIC(10,2) DEFAULT 0,
        coverage_amount NUMERIC(12,2) DEFAULT 0,
        features TEXT DEFAULT '',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS driver_insurance (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id UUID NOT NULL,
        plan_id UUID,
        start_date DATE,
        end_date DATE,
        payment_amount NUMERIC(10,2) DEFAULT 0,
        payment_status VARCHAR(30) DEFAULT 'pending',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS refund_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID NOT NULL,
        trip_id UUID,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        reason TEXT,
        payment_method VARCHAR(30) DEFAULT 'wallet',
        status VARCHAR(30) DEFAULT 'pending',
        admin_note TEXT,
        approved_by VARCHAR(120),
        approved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS car_sharing_rides (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id UUID,
        vehicle_category_id UUID,
        zone_id UUID,
        from_location TEXT,
        to_location TEXT,
        departure_time TIMESTAMP,
        seat_price NUMERIC(10,2) DEFAULT 0,
        max_seats INTEGER DEFAULT 4,
        seats_booked INTEGER DEFAULT 0,
        status VARCHAR(30) DEFAULT 'scheduled',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS car_sharing_bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_id UUID,
        customer_id UUID,
        seats_booked INTEGER DEFAULT 1,
        total_fare NUMERIC(10,2) DEFAULT 0,
        status VARCHAR(30) DEFAULT 'confirmed',
        payment_status VARCHAR(30) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS intercity_cs_settings (
        key_name VARCHAR(120) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS intercity_cs_rides (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id UUID,
        from_city VARCHAR(120) NOT NULL,
        to_city VARCHAR(120) NOT NULL,
        route_km NUMERIC(10,2) DEFAULT 0,
        departure_date DATE,
        departure_time VARCHAR(20),
        total_seats INTEGER DEFAULT 4,
        vehicle_number VARCHAR(60),
        vehicle_model VARCHAR(120),
        note TEXT,
        fare_per_seat NUMERIC(10,2) DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        status VARCHAR(30) DEFAULT 'scheduled',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS intercity_cs_bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_id UUID,
        customer_id UUID,
        seats_booked INTEGER DEFAULT 1,
        total_fare NUMERIC(10,2) DEFAULT 0,
        status VARCHAR(30) DEFAULT 'confirmed',
        payment_status VARCHAR(30) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS car_sharing_settings (
        key_name VARCHAR(120) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS intercity_routes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_city VARCHAR(120) NOT NULL,
        to_city VARCHAR(120) NOT NULL,
        estimated_km NUMERIC(10,2) DEFAULT 0,
        base_fare NUMERIC(10,2) DEFAULT 0,
        fare_per_km NUMERIC(10,2) DEFAULT 0,
        toll_charges NUMERIC(10,2) DEFAULT 0,
        vehicle_category_id UUID,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS safety_alerts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        trip_id UUID,
        alert_type VARCHAR(40) DEFAULT 'sos',
        triggered_by VARCHAR(20) DEFAULT 'customer',
        status VARCHAR(20) DEFAULT 'active',
        latitude NUMERIC(10,7),
        longitude NUMERIC(10,7),
        location_address TEXT,
        nearby_drivers_notified INTEGER DEFAULT 0,
        acknowledged_by_name VARCHAR(120),
        acknowledged_at TIMESTAMP,
        resolved_at TIMESTAMP,
        police_notified BOOLEAN DEFAULT false,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS police_stations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(191) NOT NULL,
        zone_id UUID,
        address TEXT,
        phone VARCHAR(30),
        latitude NUMERIC(10,7),
        longitude NUMERIC(10,7),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS revenue_model_settings (
        key_name VARCHAR(120) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Module-based revenue config: each service has independent revenue model
      CREATE TABLE IF NOT EXISTS service_revenue_config (
        module_name VARCHAR(30) PRIMARY KEY,
        revenue_model VARCHAR(20) NOT NULL DEFAULT 'commission',
        commission_percentage NUMERIC(5,2) NOT NULL DEFAULT 15.00,
        commission_gst_percentage NUMERIC(5,2) NOT NULL DEFAULT 18.00,
        subscription_required BOOLEAN NOT NULL DEFAULT false,
        is_active BOOLEAN NOT NULL DEFAULT true,
        notes TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      INSERT INTO service_revenue_config (module_name, revenue_model, commission_percentage, commission_gst_percentage, subscription_required)
      VALUES
        ('ride',       'commission', 15.00, 18.00, false),
        ('parcel',     'commission', 12.00, 18.00, false),
        ('carpool',    'commission', 10.00, 18.00, false),
        ('outstation', 'commission', 12.00, 18.00, false),
        ('b2b',        'subscription', 0.00, 0.00, true)
      ON CONFLICT (module_name) DO NOTHING;

      CREATE TABLE IF NOT EXISTS business_settings (
        key_name VARCHAR(191) PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        settings_type VARCHAR(80) DEFAULT 'general',
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS popular_locations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(120) NOT NULL,
        latitude NUMERIC(10,7) NOT NULL,
        longitude NUMERIC(10,7) NOT NULL,
        city_name VARCHAR(120) NOT NULL,
        full_address TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE police_stations ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
      ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '{}'::jsonb;
      UPDATE system_logs
      SET
        details = COALESCE(details, data, '{}'::jsonb),
        data = COALESCE(data, details, '{}'::jsonb)
      WHERE details IS NULL OR data IS NULL;

      -- Commission settlements: records every driver payment toward pending balance
      CREATE TABLE IF NOT EXISTS commission_settlements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id UUID NOT NULL,
        trip_id UUID,
        settlement_type VARCHAR(40) NOT NULL DEFAULT 'commission_debit',
        -- settlement_type: commission_debit | gst_debit | payment_credit | manual_credit | adjustment
        commission_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        direction VARCHAR(10) NOT NULL DEFAULT 'debit',  -- debit | credit
        balance_before NUMERIC(12,2) DEFAULT 0,
        balance_after NUMERIC(12,2) DEFAULT 0,
        ride_fare NUMERIC(12,2) DEFAULT 0,
        service_type VARCHAR(30) DEFAULT 'ride',
        payment_method VARCHAR(40),
        razorpay_order_id VARCHAR(120),
        razorpay_payment_id VARCHAR(120),
        status VARCHAR(30) NOT NULL DEFAULT 'completed',
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Outstation carpool (driver posts city-to-city rides, customers book seats)
      CREATE TABLE IF NOT EXISTS outstation_pool_rides (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id UUID NOT NULL,
        from_city VARCHAR(120) NOT NULL,
        to_city VARCHAR(120) NOT NULL,
        route_km NUMERIC(10,2) DEFAULT 0,
        departure_date DATE,
        departure_time VARCHAR(20),
        total_seats INTEGER DEFAULT 4,
        available_seats INTEGER DEFAULT 4,
        vehicle_number VARCHAR(60),
        vehicle_model VARCHAR(120),
        fare_per_seat NUMERIC(10,2) DEFAULT 0,
        note TEXT,
        is_active BOOLEAN DEFAULT true,
        status VARCHAR(30) DEFAULT 'scheduled',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS outstation_pool_bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_id UUID NOT NULL,
        customer_id UUID,
        seats_booked INTEGER DEFAULT 1,
        total_fare NUMERIC(10,2) DEFAULT 0,
        from_city VARCHAR(120),
        to_city VARCHAR(120),
        pickup_address TEXT,
        dropoff_address TEXT,
        status VARCHAR(30) DEFAULT 'confirmed',
        payment_status VARCHAR(30) DEFAULT 'pending',
        payment_method VARCHAR(40) DEFAULT 'cash',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await rawDb.execute(rawSql`
      CREATE INDEX IF NOT EXISTS idx_popular_locations_city_active
      ON popular_locations(city_name, is_active);
    `).catch(dbCatch("db"));

    await rawDb.execute(rawSql`
      INSERT INTO popular_locations (name, latitude, longitude, city_name, full_address, is_active)
      VALUES
        ('Benz Circle', 16.5062, 80.6480, 'Vijayawada', 'Benz Circle, Vijayawada, Andhra Pradesh, India', true),
        ('Vijayawada Railway Station', 16.5175, 80.6400, 'Vijayawada', 'Vijayawada Junction Railway Station, Vijayawada, Andhra Pradesh, India', true),
        ('Vijayawada Bus Stand', 16.5179, 80.6238, 'Vijayawada', 'Pandit Nehru Bus Station, Vijayawada, Andhra Pradesh, India', true),
        ('Balaji Bus Stand', 16.5106, 80.6248, 'Vijayawada', 'Balaji Bus Stand, Vijayawada, Andhra Pradesh, India', true),
        ('Kanaka Durga Temple', 16.5176, 80.6121, 'Vijayawada', 'Kanaka Durga Temple, Vijayawada, Andhra Pradesh, India', true),
        ('Gannavaram Airport', 16.5304, 80.7968, 'Vijayawada', 'Vijayawada International Airport, Gannavaram, Andhra Pradesh, India', true),
        ('Governorpet', 16.5135, 80.6346, 'Vijayawada', 'Governorpet, Vijayawada, Andhra Pradesh, India', true),
        ('Patamata', 16.4883, 80.6681, 'Vijayawada', 'Patamata, Vijayawada, Andhra Pradesh, India', true)
      ON CONFLICT DO NOTHING
    `).catch(dbCatch("db"));

    await rawDb.execute(rawSql`
      INSERT INTO revenue_model_settings (key_name, value)
      VALUES
        ('driver_commission_pct','20'),
        ('auto_lock_threshold','-100'),
        ('subscription_enabled','true'),
        ('launch_campaign_enabled','true'),
        ('ride_gst_rate','5'),
        ('commission_lock_threshold','200'),
        ('commission_rate','15'),
        ('rides_model','subscription'),
        ('parcels_model','commission'),
        ('cargo_model','commission'),
        ('intercity_model','commission'),
        ('outstation_pool_model','commission'),
        ('outstation_pool_mode','off'),
        ('subscription_mode','off'),
        ('commission_mode','on')
      ON CONFLICT (key_name) DO NOTHING;
    `);

    // -- Company GST wallet (single-row ledger) -----------------------------
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS company_gst_wallet (
        id INTEGER PRIMARY KEY DEFAULT 1,
        balance NUMERIC(15,3) NOT NULL DEFAULT 0,
        total_collected NUMERIC(15,3) NOT NULL DEFAULT 0,
        total_trips INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      INSERT INTO company_gst_wallet (id, balance, total_collected, total_trips)
      VALUES (1, 0, 0, 0) ON CONFLICT (id) DO NOTHING;
    `).catch(dbCatch("db"));

    // Fix: completely missing tables (no CREATE TABLE existed anywhere)
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS driver_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id UUID NOT NULL,
        plan_id UUID,
        start_date DATE,
        end_date DATE,
        payment_amount NUMERIC(10,2) DEFAULT 0,
        gst_amount NUMERIC(10,2) DEFAULT 0,
        insurance_amount NUMERIC(10,2) DEFAULT 0,
        insurance_plan_id UUID,
        plan_base_price NUMERIC(10,2) DEFAULT 0,
        payment_status VARCHAR(30) DEFAULT 'pending',
        rides_used INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        razorpay_payment_id VARCHAR(100),
        razorpay_order_id VARCHAR(120),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS admin_revenue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id UUID,
        trip_id UUID,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        revenue_type VARCHAR(50) DEFAULT 'commission',
        breakdown JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `).catch(dbCatch("db"));

    // -- Seed all vehicle categories (Bike, Auto, Mini Car, Sedan, SUV, Car Pool) ---
    // Inserts each vehicle type if no category with that name exists yet (case-insensitive).
    await rawDb.execute(rawSql`
      INSERT INTO vehicle_categories
        (name, vehicle_type, type, icon, is_active, base_fare, fare_per_km, minimum_fare, waiting_charge_per_min, total_seats, is_carpool)
      SELECT v.vname, v.vtype, v.svc_type, v.icon, true,
             v.base_fare::numeric, v.fare_per_km::numeric, v.minimum_fare::numeric,
             v.wait_charge::numeric, v.total_seats::int, v.is_carpool::boolean
      FROM (VALUES
        ('Bike',     'bike',     'ride', '???',  30, 12,  40, 1, 0, false),
        ('Auto',     'auto',     'ride', '??',   40, 15,  60, 2, 0, false),
        ('Mini Car', 'mini_car', 'ride', '??',   60, 16,  80, 2, 0, false),
        ('Sedan',    'sedan',    'ride', '??',   80, 18, 120, 3, 0, false),
        ('SUV',      'suv',      'ride', '??',  100, 22, 150, 3, 0, false),
        ('Car Pool', 'carpool',  'ride', '??',   80, 15, 100, 2, 4, true)
      ) AS v(vname, vtype, svc_type, icon, base_fare, fare_per_km, minimum_fare, wait_charge, total_seats, is_carpool)
      WHERE NOT EXISTS (
        SELECT 1 FROM vehicle_categories WHERE LOWER(name) = LOWER(v.vname)
      )
    `);

    // -- Seed parcel vehicle categories (Porter model) -----------------------
    // weight_rate is per-kg surcharge added on top of base + distance fare.
    await rawDb.execute(rawSql`
      INSERT INTO vehicle_categories
        (name, vehicle_type, type, icon, is_active, base_fare, fare_per_km, minimum_fare, waiting_charge_per_min, weight_rate, total_seats, is_carpool)
      SELECT v.vname, v.vtype, 'parcel', v.icon, true,
             v.base_fare::numeric, v.fare_per_km::numeric, v.minimum_fare::numeric,
             0::numeric, v.weight_rate::numeric, 0::int, false
      FROM (VALUES
        ('Bike Parcel',     'bike_parcel',   '???',  40, 12,  40, 4),
        ('Mini Truck',      'tata_ace',      '??',  150, 18, 150, 2),
        ('Pickup Truck',    'pickup_truck',  '??',  200, 22, 200, 1),
        ('Auto Parcel',     'auto_parcel',   '??',   50, 13,  50, 7),
        ('Bolero Cargo',    'bolero_cargo',  '??',  200, 22, 200, 3),
        ('Tempo 407',       'tempo_407',     '??',  800, 28, 800, 1)
      ) AS v(vname, vtype, icon, base_fare, fare_per_km, minimum_fare, weight_rate)
      WHERE NOT EXISTS (
        SELECT 1 FROM vehicle_categories WHERE LOWER(name) = LOWER(v.vname)
      )
    `);
    await rawDb.execute(rawSql`
      UPDATE vehicle_categories
      SET is_active=false
      WHERE LOWER(COALESCE(vehicle_type, '')) IN ('cargo_' || 'car', 'car_' || 'parcel', 'parcel_' || 'car')
         OR LOWER(name) IN ('cargo ' || 'car', 'car ' || 'parcel', 'parcel ' || 'car')
    `).catch(dbCatch("db"));
    console.log('[seed] Parcel vehicle categories seeded/updated');
    // Back-fill pricing + vehicle_type for any rows still missing them
    await rawDb.execute(rawSql`
      UPDATE vehicle_categories
      SET
        vehicle_type = COALESCE(NULLIF(vehicle_type,''), CASE
          WHEN LOWER(name) LIKE '%bike%' OR LOWER(name) LIKE '%moto%' THEN 'bike'
          WHEN LOWER(name) LIKE '%auto%' THEN 'auto'
          WHEN LOWER(name) LIKE '%mini%' THEN 'mini_car'
          WHEN LOWER(name) LIKE '%sedan%' THEN 'sedan'
          WHEN LOWER(name) LIKE '%suv%' THEN 'suv'
          WHEN LOWER(name) LIKE '%pool%' OR LOWER(name) LIKE '%share%' THEN 'carpool'
          WHEN LOWER(name) LIKE '%car%' THEN 'sedan'
          ELSE 'bike' END),
        base_fare = CASE WHEN (base_fare IS NULL OR base_fare = 0) THEN
          CASE WHEN LOWER(name) LIKE '%suv%' THEN 100
               WHEN LOWER(name) LIKE '%sedan%' THEN 80
               WHEN LOWER(name) LIKE '%mini%' OR LOWER(name) LIKE '%pool%' THEN 60
               WHEN LOWER(name) LIKE '%car%' THEN 80
               WHEN LOWER(name) LIKE '%auto%' THEN 40
               ELSE 30 END ELSE base_fare END,
        fare_per_km = CASE WHEN (fare_per_km IS NULL OR fare_per_km = 0) THEN
          CASE WHEN LOWER(name) LIKE '%suv%' THEN 22
               WHEN LOWER(name) LIKE '%sedan%' THEN 18
               WHEN LOWER(name) LIKE '%mini%' THEN 16
               WHEN LOWER(name) LIKE '%pool%' THEN 15
               WHEN LOWER(name) LIKE '%car%' THEN 18
               WHEN LOWER(name) LIKE '%auto%' THEN 15
               ELSE 12 END ELSE fare_per_km END,
        minimum_fare = CASE WHEN (minimum_fare IS NULL OR minimum_fare = 0) THEN
          CASE WHEN LOWER(name) LIKE '%suv%' THEN 150
               WHEN LOWER(name) LIKE '%sedan%' THEN 120
               WHEN LOWER(name) LIKE '%mini%' THEN 80
               WHEN LOWER(name) LIKE '%pool%' THEN 100
               WHEN LOWER(name) LIKE '%car%' THEN 80
               WHEN LOWER(name) LIKE '%auto%' THEN 60
               ELSE 40 END ELSE minimum_fare END,
        waiting_charge_per_min = CASE WHEN (waiting_charge_per_min IS NULL OR waiting_charge_per_min = 0) THEN
          CASE WHEN LOWER(name) LIKE '%suv%' OR LOWER(name) LIKE '%sedan%' THEN 3
               WHEN LOWER(name) LIKE '%auto%' OR LOWER(name) LIKE '%mini%' OR LOWER(name) LIKE '%car%' THEN 2
               ELSE 1 END ELSE waiting_charge_per_min END
      WHERE vehicle_type IS NULL OR base_fare = 0
    `);
    console.log('[seed] Vehicle categories seeded/updated');

    // -- Sync vehicle_categories.is_active with platform_services.service_status --
    // platform_services is the source of truth for which services admin has enabled.
    // On every restart, align vehicle visibility with the service toggle state.
    await rawDb.execute(rawSql`
      UPDATE vehicle_categories vc
      SET is_active = (
        CASE vc.vehicle_type
          WHEN 'bike'     THEN COALESCE((SELECT service_status='active' FROM platform_services WHERE service_key='bike_ride'  LIMIT 1), vc.is_active)
          WHEN 'auto'     THEN COALESCE((SELECT service_status='active' FROM platform_services WHERE service_key='auto_ride'  LIMIT 1), vc.is_active)
          WHEN 'mini_car' THEN COALESCE((SELECT service_status='active' FROM platform_services WHERE service_key='mini_car'   LIMIT 1), vc.is_active)
          WHEN 'sedan'    THEN COALESCE((SELECT service_status='active' FROM platform_services WHERE service_key='sedan'      LIMIT 1), vc.is_active)
          WHEN 'suv'      THEN COALESCE((SELECT service_status='active' FROM platform_services WHERE service_key='suv'        LIMIT 1), vc.is_active)
          WHEN 'carpool'  THEN COALESCE((SELECT service_status='active' FROM platform_services WHERE service_key='city_pool'  LIMIT 1), vc.is_active)
          ELSE vc.is_active
        END
      )
      WHERE vc.type = 'ride'
    `).catch(dbCatch("db"));
    await rawDb.execute(rawSql`
      UPDATE vehicle_categories vc
      SET is_active = COALESCE((SELECT service_status='active' FROM platform_services WHERE service_key='parcel_delivery' LIMIT 1), vc.is_active)
      WHERE vc.type = 'parcel'
    `).catch(dbCatch("db"));
    await rawDb.execute(rawSql`
      UPDATE vehicle_categories
      SET is_active=false
      WHERE LOWER(COALESCE(vehicle_type, '')) IN ('cargo_' || 'car', 'car_' || 'parcel', 'parcel_' || 'car')
         OR LOWER(name) IN ('cargo ' || 'car', 'car ' || 'parcel', 'parcel ' || 'car')
    `).catch(dbCatch("db"));
    console.log('[seed] vehicle_categories.is_active synced with platform_services');

    // -- Auto-promote pending drivers to verified so they can go online ------
    // Drivers who registered but were never admin-reviewed stay stuck at 'pending'.
    // 'verified' = registered and active, 'approved' = explicitly admin-approved.
    // Both 'verified' and 'approved' are allowed to go online and receive trips.
    await rawDb.execute(rawSql`
      UPDATE users SET verification_status='verified'
      WHERE user_type='driver' AND verification_status='pending' AND is_active=true
    `).catch(dbCatch("db"));
    // Backfill model_selected_at so drivers aren't blocked by the model selection gate
    await rawDb.execute(rawSql`
      UPDATE users SET
        revenue_model = COALESCE(NULLIF(revenue_model,''), 'commission'),
        model_selected_at = COALESCE(model_selected_at, NOW())
      WHERE user_type='driver' AND is_active=true
    `).catch(dbCatch("db"));
    console.log('[seed] pending drivers promoted to verified, model_selected_at backfilled');

    // -- Seed trip_fares using vehicle_categories pricing as source of truth --
    // Inserts only where no fare row exists yet. Safe to re-run.
    await rawDb.execute(rawSql`
      INSERT INTO trip_fares (vehicle_category_id, base_fare, fare_per_km, fare_per_min,
                              minimum_fare, cancellation_fee, waiting_charge_per_min, night_charge_multiplier)
      SELECT
        vc.id,
        COALESCE(NULLIF(vc.base_fare, 0), CASE
          WHEN LOWER(vc.name) LIKE '%suv%'    THEN 100
          WHEN LOWER(vc.name) LIKE '%sedan%'  THEN 80
          WHEN LOWER(vc.name) LIKE '%mini%'   THEN 60
          WHEN LOWER(vc.name) LIKE '%pool%' OR LOWER(vc.name) LIKE '%share%' THEN 80
          WHEN LOWER(vc.name) LIKE '%car%'    THEN 80
          WHEN LOWER(vc.name) LIKE '%auto%'   THEN 40
          WHEN LOWER(vc.name) LIKE '%cargo%'  THEN 80
          WHEN LOWER(vc.name) LIKE '%parcel%' THEN 35
          ELSE 30
        END),
        COALESCE(NULLIF(vc.fare_per_km, 0), CASE
          WHEN LOWER(vc.name) LIKE '%suv%'    THEN 22
          WHEN LOWER(vc.name) LIKE '%sedan%'  THEN 18
          WHEN LOWER(vc.name) LIKE '%mini%'   THEN 16
          WHEN LOWER(vc.name) LIKE '%pool%' OR LOWER(vc.name) LIKE '%share%' THEN 15
          WHEN LOWER(vc.name) LIKE '%car%'    THEN 18
          WHEN LOWER(vc.name) LIKE '%auto%'   THEN 15
          WHEN LOWER(vc.name) LIKE '%cargo%'  THEN 20
          WHEN LOWER(vc.name) LIKE '%parcel%' THEN 13
          ELSE 12
        END),
        0,
        COALESCE(NULLIF(vc.minimum_fare, 0), CASE
          WHEN LOWER(vc.name) LIKE '%suv%'    THEN 150
          WHEN LOWER(vc.name) LIKE '%sedan%'  THEN 120
          WHEN LOWER(vc.name) LIKE '%mini%'   THEN 80
          WHEN LOWER(vc.name) LIKE '%pool%' OR LOWER(vc.name) LIKE '%share%' THEN 100
          WHEN LOWER(vc.name) LIKE '%car%'    THEN 80
          WHEN LOWER(vc.name) LIKE '%auto%'   THEN 60
          WHEN LOWER(vc.name) LIKE '%cargo%'  THEN 100
          WHEN LOWER(vc.name) LIKE '%parcel%' THEN 40
          ELSE 40
        END),
        10,
        COALESCE(NULLIF(vc.waiting_charge_per_min, 0),
          CASE WHEN LOWER(vc.name) LIKE '%suv%' OR LOWER(vc.name) LIKE '%sedan%' THEN 3
               WHEN LOWER(vc.name) LIKE '%auto%' OR LOWER(vc.name) LIKE '%mini%' OR LOWER(vc.name) LIKE '%car%' THEN 2
               ELSE 1 END),
        1.25
      FROM vehicle_categories vc
      WHERE vc.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM trip_fares tf
          WHERE tf.vehicle_category_id = vc.id
            AND (tf.base_fare > 0 OR tf.fare_per_km > 0 OR tf.minimum_fare > 0)
        )
    `);

    // -- platform_services: per-service activation + revenue model ------------
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS platform_services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        service_key VARCHAR(50) UNIQUE NOT NULL,
        service_name VARCHAR(100) NOT NULL,
        service_category VARCHAR(50) NOT NULL DEFAULT 'rides',
        service_status VARCHAR(20) NOT NULL DEFAULT 'inactive',
        revenue_model VARCHAR(30) NOT NULL DEFAULT 'commission',
        commission_rate NUMERIC(5,2) DEFAULT 15.0,
        sort_order INTEGER DEFAULT 0,
        icon VARCHAR(20) DEFAULT '??',
        color VARCHAR(20) DEFAULT '#2F80ED',
        description TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Seed 9 canonical services. Only bike_ride + parcel_delivery are active at launch.
      INSERT INTO platform_services
        (service_key, service_name, service_category, service_status, revenue_model, commission_rate, sort_order, icon, color, description)
      VALUES
        ('bike_ride',       'Bike Ride',          'rides',   'active',   'subscription',  0,    1, '???', '#2F80ED', 'Quick and affordable bike taxi rides'),
        ('auto_ride',       'Auto Ride',           'rides',   'inactive', 'subscription',  0,    2, '??',  '#F59E0B', 'Classic CNG auto rides'),
        ('mini_car',        'Mini Car',            'rides',   'inactive', 'subscription',  0,    3, '??',  '#10B981', 'Budget sedan rides'),
        ('sedan',           'Sedan',               'rides',   'inactive', 'subscription',  0,    4, '??',  '#8B5CF6', 'Comfortable sedan rides'),
        ('suv',             'SUV',                 'rides',   'inactive', 'subscription',  0,    5, '??',  '#EF4444', 'Premium SUV rides'),
        ('city_pool',       'City Car Pool',       'carpool', 'inactive', 'commission',   10.0,  6, '??',  '#06B6D4', 'Share city rides and save'),
        ('intercity_pool',  'Intercity Car Pool',  'carpool', 'inactive', 'commission',   12.0,  7, '???', '#6366F1', 'Intercity shared travel'),
        ('outstation_pool', 'Outstation Pool',     'carpool', 'inactive', 'commission',   15.0,  8, '???', '#EC4899', 'Long distance pool travel'),
        ('parcel_delivery', 'Parcel Delivery',     'parcel',  'active',   'commission',   15.0,  9, '??',  '#FF6B35', 'Porter-style parcel and goods delivery')
      ON CONFLICT (service_key) DO NOTHING;
    `).catch(dbCatch("db"));
    await rawDb.execute(rawSql`
      UPDATE platform_services
      SET service_status='active', updated_at=NOW()
      WHERE service_key IN ('bike_ride', 'auto_ride', 'mini_car', 'sedan', 'suv')
    `).catch(dbCatch("db"));
    await rawDb.execute(rawSql`
      UPDATE vehicle_categories
      SET is_active=true
      WHERE type='ride' AND vehicle_type IN ('bike', 'auto', 'mini_car', 'sedan', 'suv')
    `).catch(dbCatch("db"));
    await rawDb.execute(rawSql`
      UPDATE vehicle_categories
      SET is_active=false
      WHERE LOWER(COALESCE(vehicle_type, '')) IN ('cargo_' || 'car', 'car_' || 'parcel', 'parcel_' || 'car')
         OR LOWER(name) IN ('cargo ' || 'car', 'car ' || 'parcel', 'parcel ' || 'car')
    `).catch(dbCatch("db"));

    // -- parcel_orders: multi-drop Porter-style delivery -----------------------
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS parcel_orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID NOT NULL,
        driver_id UUID,
        vehicle_category VARCHAR(50) DEFAULT 'bike_parcel',
        pickup_address TEXT NOT NULL,
        pickup_lat NUMERIC(10,7),
        pickup_lng NUMERIC(10,7),
        pickup_contact_name VARCHAR(100),
        pickup_contact_phone VARCHAR(20),
        drop_locations JSONB NOT NULL DEFAULT '[]',
        total_distance_km NUMERIC(8,2) DEFAULT 0,
        weight_kg NUMERIC(8,2) DEFAULT 0,
        base_fare NUMERIC(10,2) DEFAULT 0,
        distance_fare NUMERIC(10,2) DEFAULT 0,
        weight_fare NUMERIC(10,2) DEFAULT 0,
        total_fare NUMERIC(10,2) DEFAULT 0,
        commission_amt NUMERIC(10,2) DEFAULT 0,
        commission_pct NUMERIC(5,2) DEFAULT 15.0,
        current_drop_index INTEGER DEFAULT 0,
        current_status VARCHAR(40) DEFAULT 'pending',
        pickup_otp VARCHAR(6),
        is_b2b BOOLEAN DEFAULT false,
        b2b_company_id UUID,
        payment_method VARCHAR(30) DEFAULT 'cash',
        payment_status VARCHAR(30) DEFAULT 'pending',
        notes TEXT DEFAULT '',
        cancelled_reason TEXT DEFAULT '',
        version INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_parcel_orders_customer ON parcel_orders(customer_id);
      CREATE INDEX IF NOT EXISTS idx_parcel_orders_driver  ON parcel_orders(driver_id);
      CREATE INDEX IF NOT EXISTS idx_parcel_orders_status  ON parcel_orders(current_status);
      ALTER TABLE parcel_orders ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
    `).catch(dbCatch("db"));

    // -- FCM device registry: stores one push token per user ------------------
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS user_devices (
        user_id UUID PRIMARY KEY,
        fcm_token TEXT NOT NULL,
        device_type VARCHAR(20) DEFAULT 'android',
        app_version VARCHAR(30) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_user_devices_fcm ON user_devices(fcm_token);
      CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);
    `).catch(dbCatch("db"));

    // -- Call logs: records in-app masked calls --------------------------------
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS call_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trip_id UUID,
        caller_id UUID,
        caller_name VARCHAR(100),
        caller_phone VARCHAR(20),
        caller_type VARCHAR(20) DEFAULT 'customer',
        callee_id UUID,
        callee_name VARCHAR(100),
        callee_phone VARCHAR(20),
        callee_type VARCHAR(20) DEFAULT 'driver',
        call_type VARCHAR(30) DEFAULT 'customer_to_driver',
        status VARCHAR(20) DEFAULT 'answered',
        duration_seconds INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_call_logs_trip ON call_logs(trip_id);
      CREATE INDEX IF NOT EXISTS idx_call_logs_created ON call_logs(created_at DESC);
    `).catch(dbCatch("db"));


    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS notification_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(200) NOT NULL,
        message TEXT NOT NULL,
        target VARCHAR(30) DEFAULT 'all',
        user_type VARCHAR(30) DEFAULT 'all',
        recipient_count INTEGER DEFAULT 0,
        delivered_count INTEGER DEFAULT 0,
        status VARCHAR(30) DEFAULT 'sent',
        sent_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notification_logs_sent_at ON notification_logs(sent_at DESC);
    `).catch(dbCatch("db"));
    await rawDb.execute(rawSql`
      ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS title VARCHAR(200);
      ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS message TEXT;
      ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS target VARCHAR(30) DEFAULT 'all';
      ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS user_type VARCHAR(30) DEFAULT 'all';
      ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS recipient_count INTEGER DEFAULT 0;
      ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS delivered_count INTEGER DEFAULT 0;
      ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'sent';
      ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS notification_type VARCHAR(50) DEFAULT 'broadcast';
      ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS fcm_result TEXT;
      ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS error_message TEXT;
      ALTER TABLE notification_logs ALTER COLUMN notification_type DROP NOT NULL;
      ALTER TABLE notification_logs ALTER COLUMN notification_type SET DEFAULT 'broadcast';
    `).catch(dbCatch("db"));

    // -- Driver payment ledger: records every commission debt/payment ----------
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS driver_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id UUID NOT NULL,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        payment_type VARCHAR(60) NOT NULL DEFAULT 'commission_debit',
        razorpay_order_id VARCHAR(120),
        razorpay_payment_id VARCHAR(120),
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        description TEXT,
        verified_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_driver_payments_driver ON driver_payments(driver_id);
      CREATE INDEX IF NOT EXISTS idx_driver_payments_status ON driver_payments(status);
    `).catch(dbCatch("db"));
    await rawDb.execute(rawSql`
      ALTER TABLE driver_payments ADD COLUMN IF NOT EXISTS trip_id UUID;
      ALTER TABLE driver_payments ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(120);
      ALTER TABLE driver_payments ADD COLUMN IF NOT EXISTS razorpay_payment_id VARCHAR(120);
      ALTER TABLE driver_payments ADD COLUMN IF NOT EXISTS razorpay_signature TEXT;
      ALTER TABLE driver_payments ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;
      CREATE INDEX IF NOT EXISTS idx_driver_payments_trip ON driver_payments(trip_id) WHERE trip_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_driver_payments_order ON driver_payments(razorpay_order_id) WHERE razorpay_order_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_driver_payments_payment ON driver_payments(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
    `).catch(dbCatch("db"));

    // -- Customer payment ledger: records every wallet topup / ride payment ------
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS customer_payments (
        id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id          UUID        NOT NULL,
        amount               NUMERIC(12,2) NOT NULL DEFAULT 0,
        payment_type         VARCHAR(60)  NOT NULL DEFAULT 'wallet_topup',
        razorpay_order_id    VARCHAR(120),
        razorpay_payment_id  VARCHAR(120),
        status               VARCHAR(30)  NOT NULL DEFAULT 'pending',
        failure_reason       TEXT,
        description          TEXT,
        verified_at          TIMESTAMP,
        created_at           TIMESTAMP    NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_customer_payments_customer ON customer_payments(customer_id);
      CREATE INDEX IF NOT EXISTS idx_customer_payments_order    ON customer_payments(razorpay_order_id) WHERE razorpay_order_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_customer_payments_payment  ON customer_payments(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_customer_payments_status   ON customer_payments(status);
    `).catch(dbCatch("db"));
    // -- Migration: add trip_id to customer_payments for refund tracking -------
    await rawDb.execute(rawSql`
      ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS trip_id UUID;
      CREATE INDEX IF NOT EXISTS idx_customer_payments_trip ON customer_payments(trip_id) WHERE trip_id IS NOT NULL;
    `).catch(dbCatch("db"));
    // -- Migration: add razorpay_payment_id to trip_requests for online pay tracking --
    await rawDb.execute(rawSql`
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS razorpay_payment_id VARCHAR(120);
    `).catch(dbCatch("db"));
    // -- Migration: add refunded_at to customer_payments ----------------------
    await rawDb.execute(rawSql`
      ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP;
    `).catch(dbCatch("db"));
    // -- Migration: add GST/insurance columns to driver_subscriptions ---------
    await rawDb.execute(rawSql`
      ALTER TABLE driver_subscriptions ADD COLUMN IF NOT EXISTS razorpay_payment_id VARCHAR(100);
      ALTER TABLE driver_subscriptions ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE driver_subscriptions ADD COLUMN IF NOT EXISTS insurance_amount NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE driver_subscriptions ADD COLUMN IF NOT EXISTS insurance_plan_id UUID;
      ALTER TABLE driver_subscriptions ADD COLUMN IF NOT EXISTS plan_base_price NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE driver_subscriptions ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(120);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_subscriptions_payment
        ON driver_subscriptions(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
    `).catch(dbCatch("db"));
    // -- SECURITY MIGRATIONS: Unique constraints for payment idempotency -------
    // Prevents duplicate wallet credits even under concurrent requests
    await rawDb.execute(rawSql`
      ALTER TABLE commission_settlements ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(120);
      ALTER TABLE commission_settlements ADD COLUMN IF NOT EXISTS razorpay_payment_id VARCHAR(120);
      -- Unique index: one earning/refund/recharge per (payment_id, type)
      -- ON CONFLICT ... DO NOTHING in INSERT statements will safely skip duplicates
      CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency
        ON transactions(ref_transaction_id, transaction_type)
        WHERE ref_transaction_id IS NOT NULL;
      -- Unique index on driver commission_settlements per razorpay_payment_id
      CREATE UNIQUE INDEX IF NOT EXISTS idx_commission_settlements_payment
        ON commission_settlements(razorpay_payment_id)
        WHERE razorpay_payment_id IS NOT NULL;
      -- Unique index: one trip_earning or commission_deduction per trip per user
      CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_trip_user_type
        ON transactions(user_id, ref_transaction_id, transaction_type)
        WHERE transaction_type IN ('trip_earning','commission_deduction','ride_refund','admin_refund')
          AND ref_transaction_id IS NOT NULL;
    `).catch(dbCatch("db")); // best-effort: index may already exist

    // -- Razorpay webhook audit log --------------------------------------------
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS razorpay_webhook_logs (
        id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id    VARCHAR(120) NOT NULL,
        event_type  VARCHAR(80)  NOT NULL,
        payload     JSONB,
        processed   BOOLEAN      NOT NULL DEFAULT false,
        error_msg   TEXT,
        created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rzp_webhook_event_id   ON razorpay_webhook_logs(event_id);
      CREATE INDEX        IF NOT EXISTS idx_rzp_webhook_event_type  ON razorpay_webhook_logs(event_type);
      CREATE INDEX        IF NOT EXISTS idx_rzp_webhook_created     ON razorpay_webhook_logs(created_at DESC);
    `).catch(dbCatch("db"));

    // -- Performance indexes for high-traffic queries --------------------------
    await rawDb.execute(rawSql`
      CREATE INDEX IF NOT EXISTS idx_trip_requests_customer_status ON trip_requests(customer_id, current_status);
      CREATE INDEX IF NOT EXISTS idx_trip_requests_driver_status   ON trip_requests(driver_id, current_status);
      CREATE INDEX IF NOT EXISTS idx_trip_requests_status_created  ON trip_requests(current_status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_users_phone                   ON users(phone);
      CREATE INDEX IF NOT EXISTS idx_users_user_type               ON users(user_type);
      CREATE INDEX IF NOT EXISTS idx_driver_locations_lat_lng      ON driver_locations(lat, lng) WHERE is_online = true;
    `).catch(dbCatch("db"));

    // -- Feature Flags table --------------------------------------------------
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS feature_flags (
        key VARCHAR(60) PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT true,
        description TEXT DEFAULT '',
        updated_at TIMESTAMP DEFAULT NOW()
      );
      INSERT INTO feature_flags (key, enabled, description) VALUES
        ('wallet',        true,  'Customer wallet top-up and payment'),
        ('rewards',       true,  'Coins and spin wheel rewards'),
        ('subscriptions', true,  'Driver subscription plans'),
        ('intercity',     true,  'Intercity travel service'),
        ('carpool',       true,  'Car pool / ride sharing'),
        ('parcel',        true,  'Parcel delivery service'),
        ('voice_booking', true,  'AI voice booking'),
        ('offers',        true,  'Promo offers and coupons')
      ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled;
    `).catch(dbCatch("db"));

    // -- Banners table: add display_order if missing --------------------------
    await rawDb.execute(rawSql`
      ALTER TABLE banners ADD COLUMN IF NOT EXISTS display_order INT DEFAULT 0;
    `).catch(dbCatch("db"));

    // -- Platform services: add icon_url + banner_url for uploaded images ------
    await rawDb.execute(rawSql`
      ALTER TABLE platform_services ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE platform_services ADD COLUMN IF NOT EXISTS icon_url TEXT;
      ALTER TABLE platform_services ADD COLUMN IF NOT EXISTS banner_url TEXT;
    `).catch(dbCatch("db"));

    // -- Refund tracking columns -----------------------------------------------
    await rawDb.execute(rawSql`
      ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS razorpay_refund_id VARCHAR(120);
    `).catch(dbCatch("db"));

    // -- Zone center point + radius (for radius-based zone detection fallback) --
    await rawDb.execute(rawSql`
      ALTER TABLE zones ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION;
      ALTER TABLE zones ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
      ALTER TABLE zones ADD COLUMN IF NOT EXISTS radius_km DOUBLE PRECISION DEFAULT 5;
    `).catch(dbCatch("db"));

    // -- App Languages table ---------------------------------------------------
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS app_languages (
        id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        code        VARCHAR(10)  UNIQUE NOT NULL,
        name        VARCHAR(100) NOT NULL,
        native_name VARCHAR(100),
        flag        VARCHAR(10),
        is_active   BOOLEAN      NOT NULL DEFAULT true,
        sort_order  INT          NOT NULL DEFAULT 0,
        created_at  TIMESTAMP    DEFAULT NOW()
      );
      INSERT INTO app_languages (code, name, native_name, flag, sort_order) VALUES
        ('en', 'English',  'English',   '????', 0),
        ('te', 'Telugu',   '??????',    '????', 1),
        ('hi', 'Hindi',    '??????',    '????', 2)
      ON CONFLICT (code) DO NOTHING;
    `).catch(dbCatch("db"));

    // -- Trip Status History and Ride Events Tables ---------------------------
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS trip_status (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trip_id UUID NOT NULL,
        status VARCHAR(60) NOT NULL,
        source VARCHAR(40) DEFAULT 'system',
        note TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_trip_status_trip_id ON trip_status(trip_id);
      CREATE INDEX IF NOT EXISTS idx_trip_status_created_at ON trip_status(created_at DESC);

      CREATE TABLE IF NOT EXISTS ride_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trip_id UUID NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        actor_id UUID,
        actor_type VARCHAR(40) DEFAULT 'system',
        meta JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ride_events_trip_id ON ride_events(trip_id);
    `).catch(dbCatch("db"));

  } catch (e: any) {
    console.error("[schema] ensureOperationalSchema error:", formatDbError(e));
  }
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // Always run schema bootstrap on startup to ensure all columns/tables exist
  try {
    await ensureOperationalSchema();
    await ensureOutstationPoolV2Schema();
    console.log("[schema] Operational schema verified OK");
  } catch (e: any) {
    console.error("[schema] startup schema error:", e.message);
  }
  // Must be awaited so the admins table exists before any login request is handled
  try {
    await ensureAdminExists();
    console.log("[admin] Admin bootstrap complete");
  } catch (e: any) {
    console.error("[admin] startup admin error:", e.message);
  }

  // Apply API-level throttling for customer/driver mobile endpoints.
  app.use("/api/app", appLimiter);

  // Protect admin APIs except auth recovery routes.
  app.use("/api/admin", async (req, res, next) => {
    const publicPaths = new Set(["/login", "/login/verify-2fa", "/forgot-password", "/reset-password", "/emergency-reset"]);
    if (publicPaths.has(req.path)) return next();
    const token = extractBearerToken(req);
    if (!token) return res.status(401).json({ message: "Admin authorization required" });
    try {
      const r = await rawDb.execute(rawSql`
        SELECT id, name, email, role, is_active
        FROM admins
        WHERE auth_token=${token}
          AND is_active=true
          AND (auth_token_expires_at IS NULL OR auth_token_expires_at > NOW())
        LIMIT 1
      `);
      if (!r.rows.length) return res.status(401).json({ message: "Admin session expired. Please login again." });
      (req as any).adminUser = camelize(r.rows[0]);
      next();
    } catch (_e: any) {
      res.status(401).json({ message: "Admin authentication failed" });
    }
  });

  // Health check endpoint
  app.get("/api/health", async (_req, res) => {
    try {
      const { pool: dbPool } = await import("./db");
      await dbPool.query("SELECT 1");
      res.json({ status: "ok", db: "connected", ts: new Date().toISOString() });
    } catch (e: any) {
      res.status(503).json({ status: "error", db: "disconnected" });
    }
  });

  // Public env/config diagnostic — reports which critical keys are configured.
  // Returns booleans only (never exposes values). Safe to expose publicly.
  app.get("/api/health/env", async (_req, res) => {
    const has = (k: string) => !!(process.env[k] && process.env[k]!.trim());
    let dbKey = false;
    try {
      const { pool: dbPool } = await import("./db");
      const r = await dbPool.query(
        "SELECT value FROM business_settings WHERE key_name IN ('google_maps_key','GOOGLE_MAPS_API_KEY') LIMIT 1"
      );
      dbKey = !!(r.rows[0]?.value && String(r.rows[0].value).trim());
    } catch {}
    res.json({
      status: "ok",
      ts: new Date().toISOString(),
      env: {
        NODE_ENV: process.env.NODE_ENV || null,
        DATABASE_URL: has("DATABASE_URL"),
        GOOGLE_MAPS_API_KEY_env: has("GOOGLE_MAPS_API_KEY"),
        GOOGLE_MAPS_API_KEY_db: dbKey,
        GOOGLE_MAPS_API_KEY_resolved: has("GOOGLE_MAPS_API_KEY") || dbKey,
        FIREBASE_SERVICE_ACCOUNT_KEY: has("FIREBASE_SERVICE_ACCOUNT_KEY"),
        FIREBASE_WEB_API_KEY: has("FIREBASE_WEB_API_KEY"),
        RAZORPAY_KEY_ID: has("RAZORPAY_KEY_ID"),
        RAZORPAY_KEY_SECRET: has("RAZORPAY_KEY_SECRET"),
        RAZORPAY_WEBHOOK_SECRET: has("RAZORPAY_WEBHOOK_SECRET"),
        ALERT_WEBHOOK_URL: has("ALERT_WEBHOOK_URL"),
        APP_BASE_URL: has("APP_BASE_URL"),
        AI_ASSISTANT_SERVICE_URL: has("AI_ASSISTANT_SERVICE_URL"),
        ADMIN_RESET_KEY: has("ADMIN_RESET_KEY"),
        ANTHROPIC_API_KEY: has("ANTHROPIC_API_KEY"),
        REDIS_URL: has("REDIS_URL"),
        OPS_API_KEY: has("OPS_API_KEY"),
        ADMIN_PASSWORD: has("ADMIN_PASSWORD"),
        VOICE_BOOKING_ENABLED,
        AI_MOBILITY_BRAIN_ENABLED,
      },
    });
  });

  // Live Google Maps API probe.
  // Tests env key, DB key, and the app's effective resolved key separately so we
  // can distinguish a bad env var from a healthy DB-backed runtime configuration.
  app.get("/api/health/maps", async (_req, res) => {
    try {
      const envKey = (process.env.GOOGLE_MAPS_API_KEY || "").trim();
      let dbKey = "";
      try {
        const keyR = await rawDb.execute(rawSql`
          SELECT value
          FROM business_settings
          WHERE key_name IN ('google_maps_key', 'GOOGLE_MAPS_API_KEY', 'google_maps_api_key')
            AND value IS NOT NULL
            AND TRIM(value) != ''
          ORDER BY CASE
            WHEN key_name = 'google_maps_key' THEN 1
            WHEN key_name = 'GOOGLE_MAPS_API_KEY' THEN 2
            ELSE 3
          END
          LIMIT 1
        `);
        dbKey = String((keyR.rows[0] as any)?.value || "").trim();
      } catch {}

      const resolvedKey = envKey || dbKey;
      const resolvedSource = envKey ? "env" : dbKey ? "db" : null;

      const probeKey = async (apiKey: string) => {
        if (!apiKey) {
          return {
            configured: false,
            ok: false,
            googleStatus: "NOT_CONFIGURED",
            errorMessage: null,
            resultsCount: 0,
          };
        }
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=Hyderabad&key=${apiKey}`;
        const r = await fetch(url);
        const d: any = await r.json();
        return {
          configured: true,
          ok: d.status === "OK",
          googleStatus: d.status || "UNKNOWN",
          errorMessage: d.error_message || null,
          resultsCount: Array.isArray(d.results) ? d.results.length : 0,
        };
      };

      const [envProbe, dbProbe, resolvedProbe] = await Promise.all([
        probeKey(envKey),
        probeKey(dbKey),
        probeKey(resolvedKey),
      ]);

      res.json({
        ok: resolvedProbe.ok,
        resolvedSource,
        resolved: resolvedProbe,
        env: envProbe,
        db: dbProbe,
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Simple ping
  app.get("/api/ping", (_req, res) => {
    res.json({ pong: true });
  });

  // Dispatch diagnostic — surfaces why nearby drivers were included/excluded
  // Query params: includeEligible (default true), includeRawData, simulate, radiusKm
  app.get("/api/admin/dispatch-diag/:tripId", requireAdminAuth, async (req, res) => {
    try {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const tripId = String(req.params.tripId || "");
      if (!uuidRe.test(tripId)) {
        return res.status(400).json({ message: "Invalid tripId — expected UUID" });
      }
      const q = req.query;
      const parseBool = (v: any, def: boolean) =>
        v === undefined ? def : v === "true" || v === "1";
      const radiusRaw = q.radiusKm !== undefined ? Number(q.radiusKm) : undefined;
      const radiusKm = Number.isFinite(radiusRaw) && radiusRaw! > 0 && radiusRaw! <= 100
        ? radiusRaw : undefined;

      const result = await diagnoseDispatch(tripId, {
        includeEligible: parseBool(q.includeEligible, true),
        includeRawData: parseBool(q.includeRawData, false),
        simulate: parseBool(q.simulate, false),
        radiusKm,
      });
      res.json(result);
    } catch (e: any) {
      if (e instanceof TripNotFoundError) {
        return res.status(404).json({ message: e.message });
      }
      console.error("[DISPATCH_DIAG] error:", e);
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Env vars diagnostic endpoint (shows what's configured, sanitized)
  app.get("/api/diag/env", requireAdminAuth, (_req, res) => {
    const envConfig = {
      NODE_ENV: process.env.NODE_ENV || "not-set",
      DATABASE_URL: process.env.DATABASE_URL ? "***configured***" : "NOT-SET",
      ADMIN_EMAIL: process.env.ADMIN_EMAIL ? "***set***" : "NOT-SET",
      ADMIN_NAME: process.env.ADMIN_NAME ? "***set***" : "NOT-SET",
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ? "***set***" : "NOT-SET",
      ADMIN_PASSWORD_SYNC_ON_RESTART: process.env.ADMIN_PASSWORD_SYNC_ON_RESTART || "default-false",
      ADMIN_SESSION_TTL_HOURS: process.env.ADMIN_SESSION_TTL_HOURS || "24",
      ADMIN_RESET_KEY: process.env.ADMIN_RESET_KEY ? "***set***" : "NOT-SET",
      OPS_API_KEY: process.env.OPS_API_KEY ? "***set***" : "NOT-SET",
    };
    res.json({ environments: envConfig, timestamp: new Date().toISOString() });
  });

  // Diagnostic endpoint (admin-only)
  app.get("/api/diag/admin-status", requireAdminAuth, async (_req, res) => {
    try {
      const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
      const adminPassword = process.env.ADMIN_PASSWORD;
      const syncOnRestart = process.env.ADMIN_PASSWORD_SYNC_ON_RESTART;

      if (!adminEmail) {
        return res.json({ error: "ADMIN_EMAIL not configured", config: { adminEmail: null } });
      }

      const r = await rawDb.execute(rawSql`
        SELECT id, email, password, is_active FROM admins WHERE LOWER(email) = ${adminEmail} LIMIT 1
      `);

      if (!r.rows.length) {
        return res.json({
          error: "Admin account not found in database",
          config: { adminEmail, passwordConfigured: !!adminPassword, syncOnRestart },
          admin: null
        });
      }

      const admin: any = r.rows[0];
      res.json({
        success: true,
        config: { adminEmail, passwordConfigured: !!adminPassword, syncOnRestart, passwordHashLength: (admin.password || "").length },
        admin: { id: admin.id, email: admin.email, isActive: admin.is_active, passwordConfigured: !!(admin.password) }
      });
    } catch (e: any) { res.status(500).json({ error: safeErrMsg(e) }); }
  });

  // Razorpay connectivity diagnostic (admin-only)
  app.get("/api/diag/razorpay", requireAdminAuth, async (_req, res) => {
    try {
      const { keyId, keySecret } = await getRazorpayKeys();
      if (!keyId || !keySecret) return res.json({ status: "not_configured", keyId: false, keySecret: false });
      const Razorpay = _require("razorpay");
      const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret, timeout: 10000 });
      // Fetch a minimal list � just to test connectivity & key validity
      const result = await Promise.race([
        rzp.orders.all({ count: 1 }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Razorpay API timeout after 10s")), 10000))
      ]);
      res.json({ status: "ok", keyConfigured: true, ordersReachable: true });
    } catch (e: any) {
      res.json({ status: "error", message: e.message || String(e) });
    }
  });

  app.get("/api/ops/ready", requireOpsKey, async (_req, res) => {
    try {
      await rawDb.execute(rawSql`SELECT 1`);
      res.json({ status: "ready", ts: new Date().toISOString() });
    } catch (e: any) {
      res.status(503).json({ status: "not_ready", message: formatDbError(e), ts: new Date().toISOString() });
    }
  });

  // -- Force re-run full DB bootstrap + admin seed ---------------------------
  // GET  /api/ops/init-db?key=ADMIN_RESET_KEY
  // Useful when the live server has a missing schema (e.g. fresh DB or failed migration).
  app.get("/api/ops/init-db", async (req, res) => {
    const resetKey = process.env.ADMIN_RESET_KEY || process.env.OPS_API_KEY;
    const provided = String(req.query.key || req.headers["x-ops-key"] || "").trim();
    if (!resetKey || provided !== resetKey) return res.status(403).json({ message: "Invalid key" });
    try {
      await ensureOperationalSchema();
      await ensureAdminExists();
      const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
      if (!adminEmail) {
        return res.json({ success: true, message: "DB schema bootstrapped. ADMIN_EMAIL not set � admin not synced.", admin: null });
      }
      const r = await rawDb.execute(rawSql`SELECT id, email, is_active, LEFT(password,4) as pw_hint FROM admins WHERE LOWER(email)=${adminEmail} LIMIT 1`);
      const adminRow: any = r.rows[0];
      const adminPwdEnv = process.env.ADMIN_PASSWORD || "";
      res.json({
        success: true,
        message: "DB schema bootstrapped and admin account synced.",
        admin: adminRow ? { id: adminRow.id, email: adminRow.email, is_active: adminRow.is_active, pw_is_bcrypt: (adminRow.pw_hint || "").startsWith("$2") } : null,
        env: { adminEmail, adminPasswordSet: !!adminPwdEnv },
        ts: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ success: false, message: safeErrMsg(e) });
    }
  });

  // -- Seed all vehicle categories, fares, brands & platform services ----------
  // GET /api/ops/seed-platform?key=ADMIN_RESET_KEY
  app.get("/api/ops/seed-platform", async (req, res) => {
    const resetKey = process.env.ADMIN_RESET_KEY || process.env.OPS_API_KEY;
    const provided = String(req.query.key || req.headers["x-ops-key"] || "").trim();
    if (!resetKey || provided !== resetKey) return res.status(403).json({ message: "Invalid key" });
    try {
      // -- 1. Vehicle categories (upsert by name) ------------------------------
      const vehicles = [
        // RIDE services
        {
          name: "Bike", type: "motor_bike", vehicle_type: "bike", icon: "/vehicles/bike.svg",
          base_fare: 30, fare_per_km: 7, minimum_fare: 30, waiting_charge_per_min: 0.5
        },
        {
          name: "Auto", type: "auto", vehicle_type: "auto", icon: "/vehicles/auto.svg",
          base_fare: 30, fare_per_km: 12, minimum_fare: 45, waiting_charge_per_min: 1
        },
        {
          name: "Mini Car", type: "car", vehicle_type: "mini_car", icon: "/vehicles/mini_car.svg",
          base_fare: 70, fare_per_km: 14, minimum_fare: 90, waiting_charge_per_min: 1.5
        },
        {
          name: "Sedan", type: "car", vehicle_type: "sedan", icon: "/vehicles/sedan.svg",
          base_fare: 90, fare_per_km: 16, minimum_fare: 130, waiting_charge_per_min: 2
        },
        {
          name: "SUV / XL", type: "car", vehicle_type: "suv", icon: "/vehicles/suv.svg",
          base_fare: 120, fare_per_km: 20, minimum_fare: 170, waiting_charge_per_min: 2.5
        },
        // LOCAL POOL services
        {
          name: "Mini Pool", type: "car", vehicle_type: "pool_mini", icon: "/vehicles/pool_mini.svg",
          base_fare: 40, fare_per_km: 9, minimum_fare: 55, waiting_charge_per_min: 1, total_seats: 3, is_carpool: true,
          description: "Upto 3 riders � Shared mini cab � Save 35%"
        },
        {
          name: "Sedan Pool", type: "car", vehicle_type: "pool_sedan", icon: "/vehicles/pool_sedan.svg",
          base_fare: 50, fare_per_km: 10, minimum_fare: 70, waiting_charge_per_min: 1, total_seats: 4, is_carpool: true,
          description: "Upto 4 riders � Shared sedan � Save 35%"
        },
        {
          name: "SUV Pool", type: "car", vehicle_type: "pool_suv", icon: "/vehicles/pool_suv.svg",
          base_fare: 60, fare_per_km: 12, minimum_fare: 80, waiting_charge_per_min: 1.5, total_seats: 6, is_carpool: true,
          description: "Upto 6 riders � Shared SUV � Save 30%"
        },
        {
          name: "Car Pool", type: "car", vehicle_type: "carpool", icon: "/vehicles/carpool.svg",
          base_fare: 40, fare_per_km: 8, minimum_fare: 60, waiting_charge_per_min: 1, total_seats: 4
        },
        // PARCEL / PORTER-style services
        {
          name: "Bike Delivery", type: "parcel", vehicle_type: "bike_parcel", icon: "/vehicles/parcel_bike.svg",
          base_fare: 70, fare_per_km: 8, minimum_fare: 70, waiting_charge_per_min: 0.5, service_type: "parcel",
          description: "Upto 10 kg � 0.3 CBM � Small packages, documents"
        },
        {
          name: "3-Wheeler / Auto", type: "parcel", vehicle_type: "auto_parcel", icon: "/vehicles/parcel_auto.svg",
          base_fare: 140, fare_per_km: 12, minimum_fare: 140, waiting_charge_per_min: 1, service_type: "parcel",
          description: "Upto 150 kg � 1.5 CBM � Medium goods, household items"
        },
        {
          name: "Tata Ace", type: "parcel", vehicle_type: "tata_ace", icon: "/vehicles/tata_ace.svg",
          base_fare: 350, fare_per_km: 18, minimum_fare: 350, waiting_charge_per_min: 2, service_type: "parcel",
          description: "Upto 750 kg � 6 CBM � Furniture, appliances, bulk goods"
        },
        {
          name: "Pickup Truck", type: "parcel", vehicle_type: "pickup_truck", icon: "/vehicles/pickup_truck.svg",
          base_fare: 450, fare_per_km: 20, minimum_fare: 450, waiting_charge_per_min: 2.25, service_type: "parcel",
          description: "Upto 2000 kg - commercial pickup goods"
        },
        {
          name: "Bolero Pickup", type: "parcel", vehicle_type: "bolero_cargo", icon: "/vehicles/bolero.svg",
          base_fare: 500, fare_per_km: 22, minimum_fare: 500, waiting_charge_per_min: 2.5, service_type: "parcel",
          description: "Upto 1500 kg � 10 CBM � Heavy goods, office shifting"
        },
        {
          name: "Tata 407 / Tempo", type: "parcel", vehicle_type: "tempo_407", icon: "/vehicles/tempo_407.svg",
          base_fare: 800, fare_per_km: 28, minimum_fare: 800, waiting_charge_per_min: 3, service_type: "parcel",
          description: "Upto 2500 kg � 20 CBM � Large loads, factory goods, full shifting"
        },
      ];

      // -- 0. Ensure auxiliary tables exist -------------------------------------
      await rawDb.execute(rawSql`
        CREATE TABLE IF NOT EXISTS call_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          caller_id UUID NOT NULL,
          receiver_id UUID NOT NULL,
          trip_id UUID,
          status VARCHAR(20) DEFAULT 'initiated',
          duration_sec INT DEFAULT 0,
          initiated_at TIMESTAMPTZ DEFAULT NOW(),
          ended_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `).catch(dbCatch("db"));
      await rawDb.execute(rawSql`
        CREATE TABLE IF NOT EXISTS driver_kyc_documents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          driver_id UUID NOT NULL,
          document_type VARCHAR(50) NOT NULL,
          document_number VARCHAR(100),
          file_url TEXT,
          status VARCHAR(20) DEFAULT 'pending',
          admin_note TEXT,
          reviewed_by UUID,
          reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `).catch(dbCatch("db"));
      await rawDb.execute(rawSql`
        CREATE TABLE IF NOT EXISTS parcel_stops (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          parcel_order_id UUID NOT NULL,
          stop_sequence INT NOT NULL,
          address TEXT NOT NULL,
          lat NUMERIC(10,7),
          lng NUMERIC(10,7),
          receiver_name VARCHAR(255),
          receiver_phone VARCHAR(20),
          status VARCHAR(20) DEFAULT 'pending',
          arrived_at TIMESTAMPTZ,
          delivered_at TIMESTAMPTZ,
          otp VARCHAR(10),
          notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `).catch(dbCatch("db"));
      await rawDb.execute(rawSql`
        CREATE TABLE IF NOT EXISTS referrals (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          referrer_id UUID NOT NULL,
          referred_id UUID,
          referral_type VARCHAR(20) DEFAULT 'customer',
          status VARCHAR(20) DEFAULT 'pending',
          reward_amount DECIMAL(10,2) DEFAULT 50,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `).catch(dbCatch("db"));

      // Referrals: add paid_at column if missing
      await rawDb.execute(rawSql`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`).catch(dbCatch("db"));

      // B2B companies: unify schema � add columns needed by app registration flow
      await rawDb.execute(rawSql`
        ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS owner_id UUID;
        ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS contact_name VARCHAR(255);
        ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(20);
        ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS delivery_plan VARCHAR(50) DEFAULT 'pay_per_delivery';
        ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(10,2) DEFAULT 0;
        ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
        ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
      `).catch(dbCatch("db"));
      // Unique index: one B2B registration per app user
      await rawDb.execute(rawSql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_companies_owner ON b2b_companies(owner_id) WHERE owner_id IS NOT NULL
      `).catch(dbCatch("db"));

      // Add extra columns if not exists
      await rawDb.execute(rawSql`ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS description TEXT`).catch(dbCatch("db"));
      await rawDb.execute(rawSql`ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS service_type VARCHAR(30) DEFAULT 'ride'`).catch(dbCatch("db"));
      await rawDb.execute(rawSql`
        UPDATE vehicle_categories
        SET type = CASE
          WHEN LOWER(COALESCE(service_type, '')) IN ('parcel', 'cargo') THEN COALESCE(NULLIF(type, ''), LOWER(service_type))
          WHEN COALESCE(is_carpool, false) = true THEN COALESCE(NULLIF(type, ''), 'pool')
          ELSE COALESCE(NULLIF(type, ''), 'ride')
        END
        WHERE type IS NULL OR TRIM(type) = ''
      `).catch(dbCatch("db"));
      await rawDb.execute(rawSql`
        UPDATE vehicle_categories
        SET service_type = CASE
          WHEN COALESCE(is_carpool, false) = true THEN 'pool'
          WHEN LOWER(COALESCE(type, '')) IN ('parcel', 'cargo') THEN LOWER(type)
          WHEN LOWER(COALESCE(vehicle_type, '')) SIMILAR TO '%(parcel|cargo|courier|delivery|pickup|truck|tempo|ace)%' THEN 'parcel'
          ELSE 'ride'
        END
        WHERE service_type IS NULL
           OR TRIM(service_type) = ''
           OR (LOWER(COALESCE(type, '')) IN ('parcel', 'cargo') AND LOWER(COALESCE(service_type, '')) NOT IN ('parcel', 'cargo'))
           OR (COALESCE(is_carpool, false) = true AND LOWER(COALESCE(service_type, '')) NOT IN ('pool', 'carpool'))
           OR (COALESCE(is_carpool, false) = false AND LOWER(COALESCE(type, '')) NOT IN ('parcel', 'cargo') AND LOWER(COALESCE(service_type, '')) <> 'ride')
      `).catch(dbCatch("db"));

      const insertedVehicles: any[] = [];
      for (const v of vehicles) {
        const desc = (v as any).description || null;
        const svcType = (v as any).service_type || "ride";
        const isCarpool = (v as any).is_carpool || false;
        const totalSeats = (v as any).total_seats || 0;
        const existing = await rawDb.execute(rawSql`SELECT id FROM vehicle_categories WHERE name=${v.name} LIMIT 1`);
        let vid: string;
        if (existing.rows.length > 0) {
          vid = (existing.rows[0] as any).id;
          await rawDb.execute(rawSql`
            UPDATE vehicle_categories SET
              type=${v.type}, icon=${v.icon}, service_type=${svcType}, description=${desc},
              base_fare=${v.base_fare}, fare_per_km=${v.fare_per_km},
              minimum_fare=${v.minimum_fare}, waiting_charge_per_min=${v.waiting_charge_per_min},
              is_carpool=${isCarpool}, total_seats=${totalSeats}
            WHERE id=${vid}::uuid
          `);
        } else {
          const ins = await rawDb.execute(rawSql`
            INSERT INTO vehicle_categories (name, type, vehicle_type, icon, service_type, description, base_fare, fare_per_km, minimum_fare, waiting_charge_per_min, is_carpool, total_seats, is_active)
            VALUES (${v.name}, ${v.type}, ${v.vehicle_type || v.type}, ${v.icon}, ${svcType}, ${desc}, ${v.base_fare}, ${v.fare_per_km}, ${v.minimum_fare}, ${v.waiting_charge_per_min}, ${isCarpool}, ${totalSeats}, true)
            RETURNING id
          `);
          vid = (ins.rows[0] as any).id;
        }
        insertedVehicles.push({ name: v.name, id: vid });

        // Upsert trip_fares
        const fareExists = await rawDb.execute(rawSql`SELECT id FROM trip_fares WHERE vehicle_category_id=${vid}::uuid AND zone_id IS NULL LIMIT 1`);
        if (fareExists.rows.length > 0) {
          await rawDb.execute(rawSql`
            UPDATE trip_fares SET base_fare=${v.base_fare}, fare_per_km=${v.fare_per_km}, minimum_fare=${v.minimum_fare},
              waiting_charge_per_min=${v.waiting_charge_per_min}, cancellation_fee=30, night_charge_multiplier=1.15
            WHERE vehicle_category_id=${vid}::uuid AND zone_id IS NULL
          `);
        } else {
          await rawDb.execute(rawSql`
            INSERT INTO trip_fares (vehicle_category_id, base_fare, fare_per_km, minimum_fare, waiting_charge_per_min, cancellation_fee, night_charge_multiplier)
            VALUES (${vid}::uuid, ${v.base_fare}, ${v.fare_per_km}, ${v.minimum_fare}, ${v.waiting_charge_per_min}, 30, 1.15)
          `).catch(dbCatch("db"));
        }
      }

      // -- 2. Vehicle brands ----------------------------------------------------
      const brands = [
        // Bikes
        { name: "Hero", category: "two_wheeler" }, { name: "Honda", category: "two_wheeler" },
        { name: "Bajaj", category: "two_wheeler" }, { name: "TVS", category: "two_wheeler" },
        { name: "Royal Enfield", category: "two_wheeler" }, { name: "Yamaha", category: "two_wheeler" },
        { name: "Suzuki", category: "two_wheeler" }, { name: "KTM", category: "two_wheeler" },
        // Cars
        { name: "Maruti Suzuki", category: "four_wheeler" }, { name: "Hyundai", category: "four_wheeler" },
        { name: "Tata", category: "four_wheeler" }, { name: "Mahindra", category: "four_wheeler" },
        { name: "Toyota", category: "four_wheeler" }, { name: "Honda Cars", category: "four_wheeler" },
        { name: "Kia", category: "four_wheeler" }, { name: "Renault", category: "four_wheeler" },
        { name: "Ford", category: "four_wheeler" }, { name: "Volkswagen", category: "four_wheeler" },
        { name: "MG", category: "four_wheeler" }, { name: "Skoda", category: "four_wheeler" },
        // Autos
        { name: "Bajaj RE", category: "three_wheeler" }, { name: "TVS King", category: "three_wheeler" },
        { name: "Mahindra Alfa", category: "three_wheeler" }, { name: "Piaggio Ape", category: "three_wheeler" },
      ];
      for (const b of brands) {
        await rawDb.execute(rawSql`
          INSERT INTO vehicle_brands (name, category) VALUES (${b.name}, ${b.category})
          ON CONFLICT (name) DO UPDATE SET category=${b.category}
        `).catch(() => {
          rawDb.execute(rawSql`INSERT INTO vehicle_brands (name, category) VALUES (${b.name}, ${b.category})`).catch(dbCatch("db"));
        });
      }

      // -- 3. Platform services � do NOT override admin toggles on restart ------
      // (removed auto-activate: admin inactive settings must be preserved)

      // -- 4. Surge pricing rules (peak hours) ---------------------------------
      const surges = [
        { reason: "Morning Peak", start_time: "07:00", end_time: "10:00", multiplier: 1.3 },
        { reason: "Evening Peak", start_time: "17:00", end_time: "21:00", multiplier: 1.4 },
        { reason: "Night Ride", start_time: "23:00", end_time: "05:00", multiplier: 1.2 },
        { reason: "Weekend", start_time: "10:00", end_time: "23:00", multiplier: 1.15 },
      ];
      for (const s of surges) {
        const ex = await rawDb.execute(rawSql`SELECT id FROM surge_pricing WHERE reason=${s.reason} LIMIT 1`);
        if (!ex.rows.length) {
          await rawDb.execute(rawSql`
            INSERT INTO surge_pricing (reason, start_time, end_time, multiplier, is_active)
            VALUES (${s.reason}, ${s.start_time}, ${s.end_time}, ${s.multiplier}, true)
          `).catch(dbCatch("db"));
        }
      }

      // -- 5. Revenue model settings (upsert correct values) --------------------
      const revenueSettings: Record<string, string> = {
        // GST
        ride_gst_rate: '5',    // 5% GST on every ride
        parcel_gst_rate: '18',   // 18% GST on parcel
        // Commission model
        commission_rate: '15',   // 15% commission per ride
        commission_pct: '15',
        driver_commission_pct: '15',
        commission_insurance_per_ride: '2',  // ?2 insurance per ride (optional, can set 0)
        commission_mode: 'on',
        // Subscription model (like Rapido)
        subscription_mode: 'on',
        sub_platform_fee_per_ride: '5',    // ?5 platform fee per ride for subscription drivers
        subscription_enabled: 'true',
        // Hybrid model
        hybrid_commission_pct: '10',   // 10% commission in hybrid
        hybrid_platform_fee_per_ride: '5',
        hybrid_insurance_per_ride: '2',
        // Auto-lock thresholds
        auto_lock_threshold: '-200', // Lock when wallet < -?200
        commission_lock_threshold: '200',  // Lock when pending dues >= ?200
        // Per-service models (admin can change these)
        rides_model: 'subscription', // default: subscription for rides
        parcels_model: 'commission',   // default: commission for parcel
        cargo_model: 'commission',
        intercity_model: 'commission',
        // Launch campaign � 30-day free period for every new driver
        launch_campaign_enabled: 'true',
      };
      for (const [key, value] of Object.entries(revenueSettings)) {
        await rawDb.execute(rawSql`
          INSERT INTO revenue_model_settings (key_name, value)
          VALUES (${key}, ${value})
          ON CONFLICT (key_name) DO NOTHING
        `).catch(dbCatch("db"));
      }

      // -- 6. Subscription plans (like Rapido) ----------------------------------
      const plans = [
        {
          name: "Daily Pass", price: 29, duration_days: 1, max_rides: 10, plan_type: "driver",
          features: "10 rides/day � ?5 platform fee/ride � No commission"
        },
        {
          name: "Weekly Pass", price: 149, duration_days: 7, max_rides: 70, plan_type: "driver",
          features: "70 rides/week � ?5 platform fee/ride � No commission � Save 27%"
        },
        {
          name: "Monthly Pass", price: 499, duration_days: 30, max_rides: 300, plan_type: "driver",
          features: "300 rides/month � ?5 platform fee/ride � No commission � Save 43%"
        },
        {
          name: "Pro Monthly", price: 799, duration_days: 30, max_rides: 500, plan_type: "driver",
          features: "500 rides/month � ?3 platform fee/ride � Priority dispatch � Save 55%"
        },
      ];
      const insertedPlans: any[] = [];
      for (const p of plans) {
        const ex = await rawDb.execute(rawSql`SELECT id FROM subscription_plans WHERE name=${p.name} LIMIT 1`);
        if (!ex.rows.length) {
          const ins = await rawDb.execute(rawSql`
            INSERT INTO subscription_plans (name, price, duration_days, max_rides, plan_type, features, is_active)
            VALUES (${p.name}, ${p.price}, ${p.duration_days}, ${p.max_rides}, ${p.plan_type}, ${p.features}, true)
            RETURNING id, name, price
          `).catch(() => ({ rows: [] as any[] }));
          if (ins.rows.length) insertedPlans.push(ins.rows[0]);
        } else {
          await rawDb.execute(rawSql`
            UPDATE subscription_plans SET price=${p.price}, duration_days=${p.duration_days},
              max_rides=${p.max_rides}, features=${p.features}, is_active=true
            WHERE name=${p.name}
          `).catch(dbCatch("db"));
          insertedPlans.push({ name: p.name, updated: true });
        }
      }

      res.json({
        success: true,
        message: "Platform seeded: vehicles, fares, brands, services, surge pricing, revenue settings, subscription plans.",
        vehicles: insertedVehicles,
        brandsCount: brands.length,
        subscriptionPlans: insertedPlans,
        revenueSettingsUpdated: Object.keys(revenueSettings).length,
        ts: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ success: false, message: safeErrMsg(e) });
    }
  });

  // GET /api/ops/seed-test-accounts?key=... � creates 4 customers + 10 drivers for testing
  app.get("/api/ops/seed-test-accounts", async (req, res) => {
    const resetKey = process.env.ADMIN_RESET_KEY || process.env.OPS_API_KEY;
    const provided = String(req.query.key || req.headers["x-ops-key"] || "").trim();
    if (!resetKey || provided !== resetKey) return res.status(403).json({ message: "Invalid key" });
    try {
      const pwHash = await hashPassword("Test@123");
      // Fetch vehicle categories for driver assignment
      const vcRes = await rawDb.execute(rawSql`SELECT id, name FROM vehicle_categories ORDER BY created_at ASC`);
      const vcRows = vcRes.rows as any[];
      const bikeVc = vcRows.find((v: any) => v.name?.toLowerCase() === 'bike') || vcRows[0];
      const autoVc = vcRows.find((v: any) => v.name?.toLowerCase().includes('auto')) || vcRows[1] || bikeVc;
      const cabVc = vcRows.find((v: any) => v.name?.toLowerCase().includes('cab') || v.name?.toLowerCase().includes('sedan')) || vcRows[2] || bikeVc;
      const parcelVc = vcRows.find((v: any) => v.name?.toLowerCase().includes('bike delivery') || v.name?.toLowerCase().includes('bike_parcel')) || bikeVc;

      const customers = [
        { name: 'Test Customer 1', phone: '9000000001' },
        { name: 'Test Customer 2', phone: '9000000002' },
        { name: 'Test Customer 3', phone: '9000000003' },
        { name: 'Test Customer 4', phone: '9000000004' },
      ];
      const drivers = [
        { name: 'Test Driver 1 (Bike)', phone: '9100000001', vc: bikeVc, vNum: 'TS01AB1001', vModel: 'Hero Splendor' },
        { name: 'Test Driver 2 (Bike)', phone: '9100000002', vc: bikeVc, vNum: 'TS01AB1002', vModel: 'Honda Shine' },
        { name: 'Test Driver 3 (Bike)', phone: '9100000003', vc: bikeVc, vNum: 'TS01AB1003', vModel: 'Bajaj Pulsar' },
        { name: 'Test Driver 4 (Bike)', phone: '9100000004', vc: bikeVc, vNum: 'TS01AB1004', vModel: 'TVS Apache' },
        { name: 'Test Driver 5 (Auto)', phone: '9100000005', vc: autoVc, vNum: 'TS09AC5001', vModel: 'Bajaj RE' },
        { name: 'Test Driver 6 (Auto)', phone: '9100000006', vc: autoVc, vNum: 'TS09AC5002', vModel: 'Piaggio Ape' },
        { name: 'Test Driver 7 (Auto)', phone: '9100000007', vc: autoVc, vNum: 'TS09AC5003', vModel: 'TVS King' },
        { name: 'Test Driver 8 (Cab)', phone: '9100000008', vc: cabVc, vNum: 'TS07CD8001', vModel: 'Swift Dzire' },
        { name: 'Test Driver 9 (Cab)', phone: '9100000009', vc: cabVc, vNum: 'TS07CD8002', vModel: 'Maruti WagonR' },
        { name: 'Test Driver 10 (Parcel)', phone: '9100000010', vc: parcelVc, vNum: 'TS01AB1010', vModel: 'Hero Splendor' },
      ];

      const createdCustomers: any[] = [];
      for (const c of customers) {
        const existing = await rawDb.execute(rawSql`SELECT id FROM users WHERE phone=${c.phone} AND user_type='customer' LIMIT 1`);
        if (existing.rows.length) {
          await rawDb.execute(rawSql`UPDATE users SET password_hash=${pwHash}, is_active=true WHERE phone=${c.phone} AND user_type='customer'`);
          createdCustomers.push({ ...c, status: 'updated' });
        } else {
          await rawDb.execute(rawSql`
            INSERT INTO users (full_name, phone, user_type, is_active, wallet_balance, password_hash)
            VALUES (${c.name}, ${c.phone}, 'customer', true, 100, ${pwHash})
          `);
          createdCustomers.push({ ...c, status: 'created' });
        }
      }

      const createdDrivers: any[] = [];
      for (const d of drivers) {
        const existing = await rawDb.execute(rawSql`SELECT id FROM users WHERE phone=${d.phone} AND user_type='driver' LIMIT 1`);
        let driverId: string;
        if (existing.rows.length) {
          driverId = (existing.rows[0] as any).id;
          await rawDb.execute(rawSql`UPDATE users SET password_hash=${pwHash}, is_active=true, verification_status='verified', vehicle_number=${d.vNum}, vehicle_model=${d.vModel} WHERE id=${driverId}::uuid`);
          createdDrivers.push({ ...d, vc: d.vc?.name, status: 'updated' });
        } else {
          const ins = await rawDb.execute(rawSql`
            INSERT INTO users (full_name, phone, user_type, is_active, verification_status, wallet_balance, password_hash, vehicle_number, vehicle_model)
            VALUES (${d.name}, ${d.phone}, 'driver', true, 'verified', 0, ${pwHash}, ${d.vNum}, ${d.vModel})
            RETURNING id
          `);
          driverId = (ins.rows[0] as any).id;
          createdDrivers.push({ ...d, vc: d.vc?.name, status: 'created' });
        }
        if (d.vc?.id) {
          await rawDb.execute(rawSql`
            INSERT INTO driver_details (user_id, vehicle_category_id, availability_status, avg_rating, total_trips)
            VALUES (${driverId}::uuid, ${d.vc.id}::uuid, 'offline', 5.0, 0)
            ON CONFLICT (user_id) DO UPDATE SET vehicle_category_id=${d.vc.id}::uuid, availability_status='offline'
          `).catch(dbCatch("db"));
          await rawDb.execute(rawSql`
            INSERT INTO driver_locations (user_id, lat, lng, is_online)
            VALUES (${driverId}::uuid, 17.3850, 78.4867, false)
            ON CONFLICT (user_id) DO NOTHING
          `).catch(dbCatch("db"));
        }
      }

      res.json({
        success: true,
        message: "Test accounts ready. Login with phone + password Test@123",
        customers: createdCustomers.map(c => ({ name: c.name, phone: c.phone, password: 'Test@123', status: c.status })),
        drivers: createdDrivers.map(d => ({ name: d.name, phone: d.phone, password: 'Test@123', vehicle: d.vc, vNum: d.vNum, status: d.status })),
      });
    } catch (e: any) { res.status(500).json({ success: false, message: safeErrMsg(e) }); }
  });

  app.get("/api/ops/metrics", requireOpsKey, async (_req, res) => {
    try {
      const [activeTrips, onlineDrivers, openComplaints] = await Promise.all([
        rawDb.execute(rawSql`SELECT COUNT(*)::int AS c FROM trip_requests WHERE current_status IN ('searching','driver_assigned','accepted','arrived','on_the_way')`),
        rawDb.execute(rawSql`SELECT COUNT(*)::int AS c FROM driver_locations WHERE is_online=true`),
        rawDb.execute(rawSql`SELECT COUNT(*)::int AS c FROM ride_complaints WHERE status='open'`).catch(() => ({ rows: [{ c: 0 }] as any[] })),
      ]);
      const mem = process.memoryUsage();
      res.json({
        service: "jago-gateway",
        ts: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        memory: {
          rss: mem.rss,
          heapTotal: mem.heapTotal,
          heapUsed: mem.heapUsed,
          external: mem.external,
        },
        activeTrips: (activeTrips.rows[0] as any)?.c || 0,
        onlineDrivers: (onlineDrivers.rows[0] as any)?.c || 0,
        openComplaints: (openComplaints.rows[0] as any)?.c || 0,
      });
    } catch (e: any) {
      res.status(500).json({ message: formatDbError(e) });
    }
  });

  // Heat Map & Fleet View points
  app.get("/api/heatmap-points", requireAdminAuth, async (_req, res) => {
    try {
      const { db: hDb } = await import("./db");
      const { sql: hSql } = await import("drizzle-orm");
      const r = await hDb.execute(hSql`
        SELECT *
        FROM (
          SELECT pickup_lat AS lat, pickup_lng AS lng, 1::numeric AS intensity
          FROM trip_requests
          WHERE pickup_lat IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 5000
        ) pickup_points
        UNION ALL
        SELECT *
        FROM (
          SELECT destination_lat AS lat, destination_lng AS lng, 0.6::numeric AS intensity
          FROM trip_requests
          WHERE destination_lat IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 5000
        ) drop_points
      `);
      res.json(r.rows);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Live vehicle tracking � use actual driver telemetry instead of synthetic positions
  app.get("/api/live-tracking", requireAdminAuth, async (_req, res) => {
    try {
      const { db: ltDb } = await import("./db");
      const { sql: ltSql } = await import("drizzle-orm");
      const r = await ltDb.execute(ltSql`
        SELECT
          t.id, t.ref_id, t.trip_type,
          t.pickup_address, t.destination_address,
          t.pickup_lat, t.pickup_lng,
          t.destination_lat, t.destination_lng,
          t.estimated_fare, t.estimated_distance,
          t.payment_method, t.current_status,
          t.created_at,
          u.full_name as customer_name, u.phone as customer_phone,
          vc.name as vehicle_type,
          dl.lat as driver_lat,
          dl.lng as driver_lng,
          dl.heading as driver_heading,
          dl.speed as driver_speed,
          dl.updated_at as driver_location_updated_at
        FROM trip_requests t
        LEFT JOIN users u ON u.id = t.customer_id
        LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
        LEFT JOIN driver_locations dl ON dl.driver_id = t.driver_id
        WHERE t.current_status IN ('accepted', 'arrived', 'on_the_way', 'ongoing')
          AND t.pickup_lat IS NOT NULL
          AND t.destination_lat IS NOT NULL
        ORDER BY t.created_at DESC
      `);

      const trips = r.rows.map((t: any) => {
        const pickupLat = Number(t.pickup_lat);
        const pickupLng = Number(t.pickup_lng);
        const destinationLat = Number(t.destination_lat);
        const destinationLng = Number(t.destination_lng);
        const currentLat = t.driver_lat !== null && t.driver_lat !== undefined ? Number(t.driver_lat) : pickupLat;
        const currentLng = t.driver_lng !== null && t.driver_lng !== undefined ? Number(t.driver_lng) : pickupLng;
        const segmentLat = destinationLat - pickupLat;
        const segmentLng = destinationLng - pickupLng;
        const segmentLengthSq = segmentLat * segmentLat + segmentLng * segmentLng;
        const projectedProgress = segmentLengthSq > 0
          ? ((currentLat - pickupLat) * segmentLat + (currentLng - pickupLng) * segmentLng) / segmentLengthSq
          : 0;
        const progressPct = Math.max(0, Math.min(100, Math.round(projectedProgress * 100)));

        return {
          id: t.id,
          refId: t.ref_id,
          type: t.trip_type,
          vehicleType: t.vehicle_type || 'Car',
          customerName: t.customer_name || 'Customer',
          customerPhone: t.customer_phone,
          pickupAddress: t.pickup_address,
          destinationAddress: t.destination_address,
          pickupLat,
          pickupLng,
          destinationLat,
          destinationLng,
          currentLat,
          currentLng,
          progress: progressPct,
          estimatedFare: t.estimated_fare,
          estimatedDistance: t.estimated_distance,
          paymentMethod: t.payment_method,
          status: t.current_status,
          driverHeading: t.driver_heading !== null && t.driver_heading !== undefined ? Number(t.driver_heading) : null,
          driverSpeed: t.driver_speed !== null && t.driver_speed !== undefined ? Number(t.driver_speed) : null,
          driverLocationUpdatedAt: t.driver_location_updated_at,
          telemetryLive: t.driver_lat !== null && t.driver_lng !== null,
        };
      });

      res.json(trips);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/fleet-drivers", requireAdminAuth, async (_req, res) => {
    try {
      const drivers = await storage.getUsers('driver');
      const result = drivers.data
        .filter((d: any) => d.currentLat && d.currentLng && d.currentLat !== 0 && d.currentLng !== 0)
        .map((d: any) => ({
          id: d.id,
          name: d.fullName || `${d.firstName || ""} ${d.lastName || ""}`.trim() || "Driver",
          phone: d.phone,
          status: (d.isOnline ?? d.is_online) ? 'active' : 'inactive',
          lat: d.currentLat,
          lng: d.currentLng,
        }));
      res.json(result);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Dashboard
  app.get("/api/dashboard/stats", requireAdminAuth, async (req, res) => {
    try {
      const stats = await storage.getDashboardStats();
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- COMPREHENSIVE ADMIN DASHBOARD ------------------------------------------
  // Single endpoint with per-service breakdowns, driver wallet health, subscription stats
  app.get("/api/admin/dashboard", async (_req, res) => {
    try {
      const [tripsR, driversR, customersR, walletR, subscriptionsR, carpoolR, parcelsR, outstationR, settingsR] = await Promise.all([
        // All-time trip counts + revenue per service type
        rawDb.execute(rawSql`
          SELECT
            COUNT(*)::int                                                              AS total_trips,
            COUNT(*) FILTER (WHERE current_status = 'completed')::int                 AS completed_trips,
            COUNT(*) FILTER (WHERE current_status = 'cancelled')::int                 AS cancelled_trips,
            COUNT(*) FILTER (WHERE current_status IN ('searching','driver_assigned','accepted','arrived','on_the_way'))::int AS active_trips,
            COALESCE(SUM(actual_fare) FILTER (WHERE current_status = 'completed'), 0) AS total_revenue,
            -- Today
            COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE)::int              AS today_trips,
            COALESCE(SUM(actual_fare) FILTER (WHERE current_status='completed' AND DATE(created_at)=CURRENT_DATE), 0) AS today_revenue,
            -- This week
            COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('week', NOW()))::int      AS week_trips,
            COALESCE(SUM(actual_fare) FILTER (WHERE current_status='completed' AND created_at>=DATE_TRUNC('week',NOW())), 0) AS week_revenue,
            -- This month
            COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW()))::int     AS month_trips,
            COALESCE(SUM(actual_fare) FILTER (WHERE current_status='completed' AND created_at>=DATE_TRUNC('month',NOW())), 0) AS month_revenue,
            -- By service type (rides only)
            COUNT(*) FILTER (WHERE trip_type IN ('ride','normal') AND current_status='completed')::int  AS ride_trips,
            COALESCE(SUM(actual_fare) FILTER (WHERE trip_type IN ('ride','normal') AND current_status='completed'), 0) AS ride_revenue,
            -- Commission totals
            COALESCE(SUM(commission_amount) FILTER (WHERE current_status='completed'), 0)   AS total_commission_collected,
            COALESCE(SUM(gst_amount) FILTER (WHERE current_status='completed'), 0)          AS total_gst_collected
          FROM trip_requests
        `),
        // Driver stats
        rawDb.execute(rawSql`
          SELECT
            COUNT(*)::int                                                              AS total_drivers,
            COUNT(*) FILTER (WHERE is_active = true AND verification_status='verified')::int AS active_drivers,
            COUNT(*) FILTER (WHERE is_locked = true)::int                             AS locked_drivers,
            COALESCE(SUM(CASE WHEN total_pending_balance > 0 THEN total_pending_balance ELSE 0 END), 0) AS total_pending_commission
          FROM users WHERE user_type = 'driver'
        `),
        // Customer stats
        rawDb.execute(rawSql`
          SELECT
            COUNT(*)::int                                                              AS total_customers,
            COUNT(*) FILTER (WHERE is_active = true)::int                             AS active_customers,
            COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW()))::int     AS new_this_month
          FROM users WHERE user_type = 'customer'
        `),
        // Online drivers right now
        rawDb.execute(rawSql`
          SELECT COUNT(*)::int AS online_drivers
          FROM driver_locations WHERE is_online = true
        `).catch(() => ({ rows: [{ online_drivers: 0 }] as any[] })),
        // Active subscriptions
        rawDb.execute(rawSql`
          SELECT COUNT(*)::int AS active_subscriptions
          FROM driver_subscriptions
          WHERE status = 'active' AND end_date >= CURRENT_DATE
        `).catch(() => ({ rows: [{ active_subscriptions: 0 }] as any[] })),
        // Carpool stats
        rawDb.execute(rawSql`
          SELECT
            COUNT(*)::int AS total_carpool_trips,
            COALESCE(SUM(actual_fare), 0) AS carpool_revenue
          FROM trip_requests
          WHERE trip_type = 'carpool' AND current_status = 'completed'
        `),
        // Parcel stats
        rawDb.execute(rawSql`
          SELECT
            COUNT(*)::int AS total_parcel_trips,
            COALESCE(SUM(actual_fare), 0) AS parcel_revenue
          FROM trip_requests
          WHERE trip_type IN ('parcel','delivery') AND current_status = 'completed'
        `),
        // Outstation pool stats
        rawDb.execute(rawSql`
          SELECT
            COUNT(DISTINCT opr.id)::int AS total_outstation_rides,
            COUNT(opb.id)::int AS total_outstation_bookings,
            COALESCE(SUM(opb.total_fare) FILTER (WHERE opb.status = 'confirmed'), 0) AS outstation_revenue
          FROM outstation_pool_rides opr
          LEFT JOIN outstation_pool_bookings opb ON opb.ride_id = opr.id
        `).catch(() => ({ rows: [{ total_outstation_rides: 0, total_outstation_bookings: 0, outstation_revenue: 0 }] as any[] })),
        // Service model settings
        rawDb.execute(rawSql`
          SELECT key_name, value FROM revenue_model_settings
          WHERE key_name IN ('rides_model','parcels_model','cargo_model','intercity_model','outstation_pool_model','outstation_pool_mode','subscription_mode','commission_mode')
        `),
      ]);

      const trips = (tripsR.rows[0] as any) || {};
      const drv = (driversR.rows[0] as any) || {};
      const cust = (customersR.rows[0] as any) || {};
      const wallet = (walletR.rows[0] as any) || {};
      const subs = (subscriptionsR.rows[0] as any) || {};
      const cp = (carpoolR.rows[0] as any) || {};
      const parcels = (parcelsR.rows[0] as any) || {};
      const opool = (outstationR.rows[0] as any) || {};
      const svcSettings: Record<string, string> = {};
      for (const row of settingsR.rows as any[]) svcSettings[row.key_name] = row.value;

      res.json({
        summary: {
          totalTrips: parseInt(trips.total_trips || 0),
          completedTrips: parseInt(trips.completed_trips || 0),
          cancelledTrips: parseInt(trips.cancelled_trips || 0),
          activeTrips: parseInt(trips.active_trips || 0),
          totalRevenue: parseFloat(trips.total_revenue || 0),
          todayTrips: parseInt(trips.today_trips || 0),
          todayRevenue: parseFloat(trips.today_revenue || 0),
          weekTrips: parseInt(trips.week_trips || 0),
          weekRevenue: parseFloat(trips.week_revenue || 0),
          monthTrips: parseInt(trips.month_trips || 0),
          monthRevenue: parseFloat(trips.month_revenue || 0),
          totalCommissionCollected: parseFloat(trips.total_commission_collected || 0),
          totalGstCollected: parseFloat(trips.total_gst_collected || 0),
        },
        services: {
          rides: { trips: parseInt(trips.ride_trips || 0), revenue: parseFloat(trips.ride_revenue || 0), model: svcSettings['rides_model'] || 'subscription' },
          parcels: { trips: parseInt(parcels.total_parcel_trips || 0), revenue: parseFloat(parcels.parcel_revenue || 0), model: svcSettings['parcels_model'] || 'commission' },
          carpool: { trips: parseInt(cp.total_carpool_trips || 0), revenue: parseFloat(cp.carpool_revenue || 0), model: svcSettings['intercity_model'] || 'commission' },
          outstationPool: { rides: parseInt(opool.total_outstation_rides || 0), bookings: parseInt(opool.total_outstation_bookings || 0), revenue: parseFloat(opool.outstation_revenue || 0), model: svcSettings['outstation_pool_model'] || 'commission', mode: svcSettings['outstation_pool_mode'] || 'off' },
        },
        drivers: {
          total: parseInt(drv.total_drivers || 0),
          active: parseInt(drv.active_drivers || 0),
          online: parseInt(wallet.online_drivers || 0),
          locked: parseInt(drv.locked_drivers || 0),
          totalPendingCommission: parseFloat(drv.total_pending_commission || 0),
          activeSubscriptions: parseInt(subs.active_subscriptions || 0),
        },
        customers: {
          total: parseInt(cust.total_customers || 0),
          active: parseInt(cust.active_customers || 0),
          newThisMonth: parseInt(cust.new_this_month || 0),
        },
        serviceSettings: svcSettings,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });



  // -- REAL-TIME ADMIN KPIs (production-grade live metrics) -----------------
  app.get("/api/admin/live-kpis", requireAdminAuth, async (req, res) => {
    try {
      const [liveR, cancelR, surgeR, ghostR, penaltyR, etaR] = await Promise.all([
        // Live trip states right now
        rawDb.execute(rawSql`
          SELECT
            COUNT(*) FILTER (WHERE current_status='searching')::int           AS searching,
            COUNT(*) FILTER (WHERE current_status IN ('driver_assigned','accepted'))::int AS dispatching,
            COUNT(*) FILTER (WHERE current_status='arrived')::int             AS arrived,
            COUNT(*) FILTER (WHERE current_status='on_the_way')::int         AS in_progress,
            COUNT(*) FILTER (WHERE current_status='completed' AND ride_ended_at > NOW() - INTERVAL '1 hour')::int AS completed_last_hour,
            COUNT(*) FILTER (WHERE current_status='cancelled' AND updated_at > NOW() - INTERVAL '1 hour')::int AS cancelled_last_hour,
            COALESCE(AVG(EXTRACT(EPOCH FROM (driver_accepted_at - created_at))/60) FILTER (
              WHERE driver_accepted_at IS NOT NULL AND created_at > NOW() - INTERVAL '1 hour'), 0)::numeric(5,1)
              AS avg_pickup_wait_min
          FROM trip_requests
          WHERE created_at > NOW() - INTERVAL '24 hours'
        `),
        // Driver cancel rate today
        rawDb.execute(rawSql`
          SELECT
            COUNT(*) FILTER (WHERE cancelled_by='driver')::int   AS driver_cancels_today,
            COUNT(*) FILTER (WHERE cancelled_by='customer')::int AS customer_cancels_today,
            COUNT(*)::int                                         AS total_cancels_today
          FROM trip_requests
          WHERE current_status='cancelled' AND DATE(updated_at) = CURRENT_DATE
        `),
        // Active surge zones
        rawDb.execute(rawSql`
          SELECT name, surge_factor FROM zones
          WHERE is_active=true AND surge_factor > 1
          ORDER BY surge_factor DESC
        `).catch(() => ({ rows: [] as any[] })),
        // Ghost drivers (online but no ping in > 5 min)
        rawDb.execute(rawSql`
          SELECT COUNT(*)::int AS ghost_count
          FROM driver_locations
          WHERE is_online=true AND updated_at < NOW() - INTERVAL '5 minutes'
        `).catch(() => ({ rows: [{ ghost_count: 0 }] as any[] })),
        // Cancel penalty revenue today
        rawDb.execute(rawSql`
          SELECT COALESCE(SUM(amount), 0)::numeric(10,2) AS penalty_collected_today
          FROM driver_payments
          WHERE payment_type='cancel_penalty' AND DATE(created_at)=CURRENT_DATE
        `).catch(() => ({ rows: [{ penalty_collected_today: 0 }] as any[] })),
        // Average estimated distance for today's completed trips (proxy for avg trip length)
        rawDb.execute(rawSql`
          SELECT
            COALESCE(AVG(actual_distance) FILTER (WHERE current_status='completed'), 0)::numeric(5,1) AS avg_distance_km,
            COALESCE(AVG(actual_fare) FILTER (WHERE current_status='completed'), 0)::numeric(8,2) AS avg_fare
          FROM trip_requests
          WHERE DATE(created_at) = CURRENT_DATE
        `),
      ]);

      const live = (liveR.rows[0] as any) || {};
      const cancel = (cancelR.rows[0] as any) || {};
      const ghost = (ghostR.rows[0] as any) || {};
      const penalty = (penaltyR.rows[0] as any) || {};
      const eta = (etaR.rows[0] as any) || {};
      const surgeZones = (surgeR.rows as any[]).map(z => ({ name: z.name, factor: parseFloat(z.surge_factor) }));

      res.json({
        live: {
          searching: parseInt(live.searching || 0),
          dispatching: parseInt(live.dispatching || 0),
          arrived: parseInt(live.arrived || 0),
          inProgress: parseInt(live.in_progress || 0),
          completedLastHour: parseInt(live.completed_last_hour || 0),
          cancelledLastHour: parseInt(live.cancelled_last_hour || 0),
          avgPickupWaitMin: parseFloat(live.avg_pickup_wait_min || 0),
        },
        cancellations: {
          driverCancelsToday: parseInt(cancel.driver_cancels_today || 0),
          customerCancelsToday: parseInt(cancel.customer_cancels_today || 0),
          totalToday: parseInt(cancel.total_cancels_today || 0),
          penaltyCollectedToday: parseFloat(penalty.penalty_collected_today || 0),
        },
        quality: {
          avgDistanceKm: parseFloat(eta.avg_distance_km || 0),
          avgFare: parseFloat(eta.avg_fare || 0),
          ghostDriverCount: parseInt(ghost.ghost_count || 0),
        },
        surge: {
          activeSurgeZones: surgeZones,
          surgeActive: surgeZones.length > 0,
        },
        generatedAt: new Date().toISOString(),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/dashboard/chart", requireAdminAuth, async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as month,
          TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month_key,
          COUNT(*) as trips,
          COUNT(*) FILTER (WHERE trip_type='ride') as rides,
          COUNT(*) FILTER (WHERE trip_type='parcel') as parcels,
          COALESCE(SUM(actual_fare) FILTER (WHERE current_status='completed'), 0) as revenue
        FROM trip_requests
        WHERE created_at >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY DATE_TRUNC('month', created_at)
      `);
      const txR = await rawDb.execute(rawSql`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as month,
          TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month_key,
          SUM(debit) as tx_revenue
        FROM transactions
        WHERE created_at >= NOW() - INTERVAL '6 months' AND transaction_type LIKE '%payment%'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY DATE_TRUNC('month', created_at)
      `);
      const txMap: Record<string, number> = {};
      txR.rows.forEach((t: any) => { txMap[t.month_key] = parseFloat(t.tx_revenue || 0); });
      const chart = r.rows.map((row: any) => ({
        day: row.month,
        trips: parseInt(row.trips || 0),
        rides: parseInt(row.rides || 0),
        parcels: parseInt(row.parcels || 0),
        revenue: parseFloat(row.revenue || 0) + (txMap[row.month_key] || 0),
      }));
      res.json(chart);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- ADMIN CONTROL: Ride Ops and Live Monitoring --------------------------
  app.get("/api/admin/rides/active", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT t.id, t.ref_id, t.trip_type, t.current_status, t.pickup_address, t.destination_address,
          t.pickup_lat, t.pickup_lng, t.destination_lat, t.destination_lng,
          t.estimated_fare, t.estimated_distance, t.created_at,
          c.full_name as customer_name, c.phone as customer_phone,
          d.full_name as driver_name, d.phone as driver_phone, d.vehicle_number, d.vehicle_model,
          dl.lat as driver_lat, dl.lng as driver_lng
        FROM trip_requests t
        LEFT JOIN users c ON c.id = t.customer_id
        LEFT JOIN users d ON d.id = t.driver_id
        LEFT JOIN driver_locations dl ON dl.driver_id = t.driver_id
        WHERE t.current_status IN ('searching','driver_assigned','accepted','arrived','on_the_way')
        ORDER BY t.created_at DESC
      `);
      const items = camelize(r.rows).map((x: any) => ({ ...x, uiState: toUiTripState(x) }));
      res.json({ items, total: items.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/rides/history", async (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
      const r = await rawDb.execute(rawSql`
        SELECT t.id, t.ref_id, t.trip_type, t.current_status, t.created_at, t.ride_started_at, t.ride_ended_at,
          t.actual_fare, t.actual_distance, t.cancel_reason,
          c.full_name as customer_name,
          d.full_name as driver_name, d.vehicle_number, d.vehicle_model
        FROM trip_requests t
        LEFT JOIN users c ON c.id = t.customer_id
        LEFT JOIN users d ON d.id = t.driver_id
        ORDER BY t.created_at DESC LIMIT ${limit}
      `);
      const items = camelize(r.rows).map((x: any) => ({ ...x, uiState: toUiTripState(x) }));
      res.json({ items, total: items.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/rides/cancelled", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT t.id, t.ref_id, t.trip_type, t.current_status, t.cancel_reason, t.cancelled_by, t.created_at,
          c.full_name as customer_name, d.full_name as driver_name
        FROM trip_requests t
        LEFT JOIN users c ON c.id = t.customer_id
        LEFT JOIN users d ON d.id = t.driver_id
        WHERE t.current_status='cancelled'
        ORDER BY t.created_at DESC LIMIT 500
      `);
      res.json({ items: camelize(r.rows) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/rides/:tripId/route", requireAdminAuth, async (req, res) => {
    try {
      const tripId = String(req.params.tripId || "");
      const events = await rawDb.execute(rawSql`
        SELECT event_type, actor_type, meta, created_at
        FROM ride_events WHERE trip_id=${tripId}::uuid ORDER BY created_at ASC
      `);
      const waypoints = getTripWaypoints(tripId);
      res.json({ events: camelize(events.rows), waypoints });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/rides/:tripId/force-cancel", requireAdminAuth, requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const admin = (req as any).adminUser;
      const tripId = String(req.params.tripId || "");
      const { reason } = req.body || {};
      const cancelReason = String(reason || "Admin force-cancelled trip");

      const tripR = await rawDb.execute(rawSql`
        UPDATE trip_requests
        SET current_status='cancelled',
            cancelled_by='admin',
            cancel_reason=${cancelReason},
            updated_at=NOW()
        WHERE id=${tripId}::uuid
          AND current_status NOT IN ('completed','cancelled')
        RETURNING id, customer_id, driver_id
      `);
      if (!tripR.rows.length) {
        return res.status(409).json({ message: "Trip cannot be force-cancelled in its current state" });
      }

      const trip = tripR.rows[0] as any;
      cancelDispatch(tripId);
      clearTripWaypoints(tripId);
      if (trip.driver_id) {
        await rawDb.execute(rawSql`UPDATE users SET current_trip_id=NULL WHERE id=${trip.driver_id}::uuid`).catch(dbCatch("db"));
      }

      await appendTripStatus(tripId, 'trip_cancelled', 'admin', cancelReason);
      await logRideLifecycleEvent(tripId, 'trip_force_cancelled', admin?.id, 'admin', { reason: cancelReason });
      await logAdminAction("force_cancel_trip", "trip", tripId, { reason: cancelReason }, admin?.email);

      if (trip.customer_id) {
        io.to(`user:${trip.customer_id}`).emit("trip:cancelled", {
          tripId,
          cancelledBy: "admin",
          reason: cancelReason,
        });
      }
      if (trip.driver_id) {
        io.to(`user:${trip.driver_id}`).emit("trip:cancelled", {
          tripId,
          cancelledBy: "admin",
          reason: cancelReason,
        });
      }

      res.json({ success: true, tripId, reason: cancelReason });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/complaints", async (req, res) => {
    try {
      const { tripId, customerId, driverId, complaintType = 'general', description } = req.body;
      if (!tripId || !description) return res.status(400).json({ message: 'tripId and description are required' });
      const r = await rawDb.execute(rawSql`
        INSERT INTO ride_complaints (trip_id, customer_id, driver_id, complaint_type, description)
        VALUES (${tripId}::uuid, ${customerId || null}::uuid, ${driverId || null}::uuid, ${complaintType}, ${description})
        RETURNING *
      `);
      await logAdminAction('complaint_created', 'ride_complaint', (r.rows[0] as any)?.id, { tripId, complaintType });
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/complaints", requireAdminAuth, async (req, res) => {
    try {
      const status = String(req.query.status || 'all');
      // -- SECURITY: Validate status enum to prevent SQL injection --
      const validStatus = validateEnumValue(status, ['all', 'pending', 'resolved', 'in_progress']);
      const r = await rawDb.execute(rawSql`
        SELECT rc.*, t.ref_id, c.full_name as customer_name, d.full_name as driver_name
        FROM ride_complaints rc
        LEFT JOIN trip_requests t ON t.id = rc.trip_id
        LEFT JOIN users c ON c.id = rc.customer_id
        LEFT JOIN users d ON d.id = rc.driver_id
        ${validStatus !== 'all' ? rawSql`WHERE rc.status=${validStatus}` : rawSql``}
        ORDER BY rc.created_at DESC LIMIT 500
      `);
      res.json({ items: camelize(r.rows) });
    } catch (e: any) { res.status(400).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/admin/complaints/:id", requireAdminRole(["admin", "superadmin", "support"]), async (req, res) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { status, resolutionNote } = req.body;
      const nextStatus = typeof status === "string" ? status : "resolved";
      const note = typeof resolutionNote === "string" ? resolutionNote : "";
      const r = await rawDb.execute(rawSql`
        UPDATE ride_complaints
        SET status=${nextStatus}, resolution_note=${note}, updated_at=NOW()
        WHERE id=${id}::uuid RETURNING *
      `);
      if (!r.rows.length) return res.status(404).json({ message: 'Complaint not found' });
      await logAdminAction('complaint_updated', 'ride_complaint', id, { status: nextStatus, resolutionNote: note });
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/system/live-overview", async (_req, res) => {
    try {
      const [rides, drivers, sos] = await Promise.all([
        rawDb.execute(rawSql`SELECT COUNT(*)::int as c FROM trip_requests WHERE current_status IN ('searching','driver_assigned','accepted','arrived','on_the_way')`),
        rawDb.execute(rawSql`SELECT COUNT(*)::int as c FROM driver_locations WHERE is_online=true`),
        rawDb.execute(rawSql`SELECT COUNT(*)::int as c FROM sf_incidents WHERE status='open'`).catch(() => ({ rows: [{ c: 0 }] as any[] })),
      ]);
      res.json({
        activeRides: (rides.rows[0] as any)?.c || 0,
        onlineDrivers: (drivers.rows[0] as any)?.c || 0,
        openSafetyIncidents: (sos.rows[0] as any)?.c || 0,
        ts: new Date().toISOString(),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- FORCE admin password reset (requires OPS key or reset key) --------------
  // POST /api/ops/force-admin-password-reset
  // This forcefully resets admin password when normal password sync isn't working
  app.post("/api/ops/force-admin-password-reset", async (req, res) => {
    try {
      const resetKey = process.env.ADMIN_RESET_KEY || process.env.OPS_API_KEY;
      const providedKey = String(req.headers["x-ops-key"] || req.body?.key || "").trim();

      if (!resetKey || providedKey !== resetKey) {
        return res.status(403).json({ message: "Invalid or missing operations API key" });
      }

      const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
      const adminPassword = process.env.ADMIN_PASSWORD;

      if (!adminEmail || !adminPassword) {
        return res.json({
          success: false,
          message: "ADMIN_EMAIL or ADMIN_PASSWORD not configured in environment",
          config: { emailSet: !!process.env.ADMIN_EMAIL, passwordSet: !!adminPassword }
        });
      }

      console.log(`[FORCE-RESET] Forcefully resetting admin password for ${adminEmail}`);

      // Hash the password
      const hash = await hashPassword(adminPassword);
      console.log(`[FORCE-RESET] Generated bcrypt hash: ${hash.substring(0, 30)}...`);

      // Update admin record
      const result = await rawDb.execute(rawSql`
        UPDATE admins 
        SET password=${hash}, is_active=true, auth_token=NULL, auth_token_expires_at=NULL
        WHERE LOWER(email)=${adminEmail}
        RETURNING id, email, password, is_active
      `);

      if (result.rows.length === 0) {
        // Admin doesn't exist, create one
        console.log(`[FORCE-RESET] Admin doesn't exist, creating new admin: ${adminEmail}`);
        const adminName = process.env.ADMIN_NAME || "Admin";
        const createResult = await rawDb.execute(rawSql`
          INSERT INTO admins (name, email, password, role, is_active)
          VALUES (${adminName}, ${adminEmail}, ${hash}, 'superadmin', true)
          RETURNING id, email, password, is_active
        `);
        const admin: any = createResult.rows[0];
        return res.json({
          success: true,
          message: `Admin created and password reset`,
          admin: {
            id: admin.id,
            email: admin.email,
            isActive: admin.is_active,
            passwordUpdated: true,
            hashPrefix: (admin.password || '').substring(0, 30) + '...'
          },
          credentials: { email: adminEmail, password: adminPassword },
          nextStep: "Try login at https://jagopro.org/admin/login with these cred entials"
        });
      }

      const admin: any = result.rows[0];
      return res.json({
        success: true,
        message: `Admin password force-reset successful`,
        admin: {
          id: admin.id,
          email: admin.email,
          isActive: admin.is_active,
          passwordUpdated: true,
          hashPrefix: (admin.password || '').substring(0, 30) + '...'
        },
        credentials: { email: adminEmail, password: adminPassword },
        nextStep: "Try login at https://jagopro.org/admin/login with these credentials"
      });
    } catch (e: any) {
      console.error("[FORCE-RESET] Error:", formatDbError(e));
      res.status(500).json({ success: false, message: formatDbError(e) });
    }
  });

  // Auth � with rate limiting and bcrypt password verification
  app.post("/api/admin/login", loginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ message: "Email and password are required" });

      // Self-healing: ensure admins table & seed exist before querying.
      // Uses rawDb directly so it works regardless of Drizzle ORM table state.
      const lookupAdmin = async (lookupEmail: string) => {
        const r = await rawDb.execute(rawSql`
          SELECT id, name, email, password, role, is_active as "isActive"
          FROM admins WHERE LOWER(email) = ${lookupEmail.trim().toLowerCase()} LIMIT 1
        `);
        if (!r.rows.length) return null;
        const row: any = r.rows[0];
        return { id: row.id, name: row.name, email: row.email, password: row.password, role: row.role, isActive: row.isActive };
      };

      let admin: any;
      try {
        admin = await lookupAdmin(email);
      } catch (dbErr: any) {
        if (String(dbErr.message).toLowerCase().includes("does not exist")) {
          console.warn("[admin-login] admins table missing � running bootstrap then retrying...");
          await ensureAdminExists();
          admin = await lookupAdmin(email);
        } else {
          throw dbErr;
        }
      }
      if (!admin) return res.status(401).json({ message: "Invalid credentials" });
      if (!admin.isActive) return res.status(403).json({ message: "Account is disabled. Contact administrator." });
      const passwordValid = await verifyPassword(password, admin.password);
      if (!passwordValid) return res.status(401).json({ message: "Invalid credentials" });
      if (requireAdminTwoFactor) {
        const adminPhone = runtimeEnv.ADMIN_PHONE;
        if (!adminPhone) {
          // 2FA is required but no delivery target � block login with clear message
          return res.status(503).json({ message: "Admin 2FA is enabled but ADMIN_PHONE is not configured. Contact system administrator." });
        }
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
        await rawDb.execute(rawSql`UPDATE admin_login_otp SET is_used=true WHERE admin_id=${admin.id}::uuid AND is_used=false`);
        await rawDb.execute(rawSql`
          INSERT INTO admin_login_otp (admin_id, otp, expires_at)
          VALUES (${admin.id}::uuid, ${otp}, ${expiresAt.toISOString()})
        `);
        const smsDelivered = await sendCustomSms(
          adminPhone as string,
          `JAGO Admin login OTP: ${otp}. Valid 5 minutes. Do not share.`,
        ).catch((e: any) => {
          console.error(`[ADMIN-2FA] SMS delivery failed to ${adminPhone}:`, e.message);
          return false;
        });
        if (!smsDelivered) {
          return res.status(503).json({
            message: "Admin 2FA delivery is not configured correctly. Configure SMS provider credentials before enabling MFA.",
          });
        }
        console.log(`[ADMIN-2FA] OTP sent to ${adminPhone} for admin ${admin.email}`);
        const response: any = {
          requiresTwoFactor: true,
          admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
          message: `OTP sent to admin phone. Valid for 5 minutes.`,
        };
        if (process.env.NODE_ENV !== "production" && isDevOtpResponseEnabled) {
          response.otp = otp;
          response.dev = true;
        }
        return res.status(202).json(response);
      }

      let session: { sessionToken: string; expiresAt: Date };
      try {
        session = await issueAdminSession(admin.id);
      } catch (sessionErr: any) {
        // Self-heal if auth_token_expires_at or other columns were added after table was first created
        if (String(sessionErr.message).toLowerCase().includes("does not exist")) {
          console.warn("[admin-login] Missing column � running schema self-heal then retrying...");
          await ensureAdminExists();
          // Re-query admin after self-heal
          const requeriedAdmin = await lookupAdmin(email);
          if (!requeriedAdmin) throw sessionErr;
          session = await issueAdminSession(requeriedAdmin.id);
        } else {
          throw sessionErr;
        }
      }
      res.json({
        admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
        token: session.sessionToken,
        expiresAt: session.expiresAt.toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.post("/api/admin/login/verify-2fa", loginLimiter, async (req, res) => {
    try {
      return res.status(410).json({
        message: "Admin SMS-based 2FA is disabled. Use password login and session security controls.",
      });
      const { email, otp } = req.body;
      if (!email || !otp) return res.status(400).json({ message: "Email and OTP are required" });
      const adminR = await rawDb.execute(rawSql`
        SELECT id, name, email, role, is_active as "isActive"
        FROM admins WHERE LOWER(email)=${email.trim().toLowerCase()} LIMIT 1
      `);
      const admin: any = adminR.rows[0];
      if (!admin) return res.status(401).json({ message: "Invalid credentials" });
      if (!admin.isActive) return res.status(403).json({ message: "Account is disabled. Contact administrator." });

      const otpR = await rawDb.execute(rawSql`
        SELECT id
        FROM admin_login_otp
        WHERE admin_id=${admin.id}::uuid
          AND otp=${String(otp)}
          AND is_used=false
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
      `);
      if (!otpR.rows.length) return res.status(400).json({ message: "Invalid or expired OTP" });

      await rawDb.execute(rawSql`UPDATE admin_login_otp SET is_used=true WHERE id=${(otpR.rows[0] as any).id}::uuid`);
      const { sessionToken, expiresAt } = await issueAdminSession(admin.id);
      res.json({
        admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
        token: sessionToken,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.post("/api/admin/logout", (req, res) => {
    const token = extractBearerToken(req);
    if (token) {
      rawDb.execute(rawSql`UPDATE admins SET auth_token=NULL, auth_token_expires_at=NULL WHERE auth_token=${token}`)
        .catch(dbCatch("db"));
    }
    res.json({ success: true });
  });

  // -- ADMIN: Forgot Password � send OTP to email ----------------------------
  app.post("/api/admin/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ message: "Email is required" });
      const admin = await storage.getAdminByEmail(email);
      if (!admin) return res.status(404).json({ message: "No admin account found with this email" });
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
      await rawDb.execute(rawSql`UPDATE admin_otp_resets SET is_used=true WHERE email=${email} AND is_used=false`);
      await rawDb.execute(rawSql`INSERT INTO admin_otp_resets (email, otp, expires_at) VALUES (${email}, ${otp}, ${expiresAt.toISOString()})`);
      // In production: send via email. For now, log it and return in dev mode.
      console.log(`[ADMIN-FORGOT-PWD] OTP generated for ${email}`);
      if (process.env.NODE_ENV === 'production' || !isDevOtpResponseEnabled) {
        res.json({ success: true, message: "Password reset OTP sent to your email." });
      } else {
        res.json({ success: true, message: "Password reset OTP sent (dev mode � check console).", otp, dev: true });
      }
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: Reset Password � verify OTP and set new password ---------------
  app.post("/api/admin/reset-password", async (req, res) => {
    try {
      const { email, otp, newPassword } = req.body;
      if (!email || !otp || !newPassword) return res.status(400).json({ message: "Email, OTP and new password are required" });
      if (newPassword.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
      const otpRow = await rawDb.execute(rawSql`
        SELECT * FROM admin_otp_resets WHERE email=${email} AND otp=${otp} AND is_used=false AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1
      `);
      if (!otpRow.rows.length) return res.status(400).json({ message: "Invalid or expired OTP" });
      await rawDb.execute(rawSql`UPDATE admin_otp_resets SET is_used=true WHERE id=${(otpRow.rows[0] as any).id}::uuid`);
      const hashedPassword = await hashPassword(newPassword);
      await rawDb.execute(rawSql`UPDATE admins SET password=${hashedPassword} WHERE email=${email}`);
      res.json({ success: true, message: "Password reset successfully. You can now login with your new password." });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: Emergency password reset (protected by ADMIN_RESET_KEY) --------
  // Call: POST /api/admin/emergency-reset  { key: "...", email: "...", password: "..." }
  // Only works if ADMIN_RESET_KEY env var is set on the server.
  app.post("/api/admin/emergency-reset", async (req, res) => {
    const resetKey = process.env.ADMIN_RESET_KEY;
    if (!resetKey) return res.status(404).json({ message: "Not found" }); // disabled if env not set
    const { key, email, password } = req.body;
    if (!key || key !== resetKey) return res.status(403).json({ message: "Invalid reset key" });
    if (!email || !password || password.length < 6) return res.status(400).json({ message: "email and password (min 6 chars) required" });
    try {
      const hash = await hashPassword(password);
      const r = await rawDb.execute(rawSql`
        UPDATE admins SET password=${hash}, is_active=true, auth_token=NULL, auth_token_expires_at=NULL
        WHERE LOWER(email)=${email.trim().toLowerCase()}
      `);
      res.json({ success: true, message: "Admin password reset successfully. You can now login." });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/change-password", requireAdminAuth, async (req, res) => {
    try {
      const admin = (req as any).adminUser;
      const { currentPassword, newPassword, confirmPassword } = req.body;

      if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ message: "Current password, new password, and confirmation are required" });
      }
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ message: "New password and confirmation do not match" });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ message: "New password must be at least 8 characters" });
      }

      // Verify current password
      const adminR = await rawDb.execute(rawSql`
        SELECT password FROM admins WHERE id=${admin.id}::uuid LIMIT 1
      `);
      if (!adminR.rows.length) {
        return res.status(404).json({ message: "Admin account not found" });
      }

      const isCurrentPasswordValid = await verifyPassword(currentPassword, (adminR.rows[0] as any).password);
      if (!isCurrentPasswordValid) {
        return res.status(401).json({ message: "Current password is incorrect" });
      }

      // Hash new password and update
      const newHash = await hashPassword(newPassword);
      await rawDb.execute(rawSql`
        UPDATE admins SET password=${newHash} WHERE id=${admin.id}::uuid
      `);

      // Log the change
      await logAdminAction('password_changed', 'admin_user', admin.id, { email: admin.email });

      res.json({ success: true, message: "Password changed successfully" });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- Catch-all protection for legacy /api/ admin routes ------------------
  // All /api/ routes that are NOT explicitly excluded below are admin-only.
  // This complements the /api/admin/* global middleware and per-route requireAdminAuth.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    const p = req.path;
    // Skip paths handled by their own auth mechanism or that are truly public
    if (
      p === "/health" ||  // public health check
      p.startsWith("/health/") ||  // nested health probes like /api/health/maps
      p === "/ping" ||  // simple test endpoint
      p.startsWith("/diag/") ||  // diagnostic endpoints
      p.startsWith("/ops/") ||  // requireOpsKey
      p.startsWith("/app/") ||  // mobile app routes � each has authApp
      p.startsWith("/admin/") ||  // global admin middleware at line 1101
      p.startsWith("/driver/") ||  // mobile driver routes � each has authApp
      p === "/vehicle-categories" ||  // apps need this before auth/session exists
      p.startsWith("/webhook")       // payment callbacks (Razorpay, etc.)
    ) return next();
    // Everything else is a legacy admin route ? require admin auth
    return requireAdminAuth(req, res, next);
  });

  // Users
  app.get("/api/users", async (req, res) => {
    try {
      const { userType, search, page, limit } = req.query as Record<string, string>;
      const result = await storage.getUsers(
        userType,
        search,
        Number(page) || 1,
        Math.min(Number(limit) || 15, 100)
      );
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.get("/api/users/:id", async (req, res) => {
    try {
      const user = await storage.getUserById(req.params.id);
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json(user);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.post("/api/users", requireAdminAuth, async (req, res) => {
    try {
      const { fullName, phone, email, userType = "customer", vehicleNumber, vehicleModel, licenseNumber } = req.body;
      if (!fullName || !phone) return res.status(400).json({ message: "Name and phone are required" });
      const { db: xDb, sql: xSql } = await import("./db").then(async m => ({ db: m.db, sql: (await import("drizzle-orm")).sql }));
      const result = await xDb.execute(xSql`
        INSERT INTO users (full_name, phone, email, user_type, is_active, loyalty_points, vehicle_number, vehicle_model, license_number)
        VALUES (${fullName}, ${phone}, ${email || null}, ${userType}, true, 0, ${vehicleNumber || null}, ${vehicleModel || null}, ${licenseNumber || null})
        RETURNING *
      `);
      res.status(201).json(result.rows[0]);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.post("/api/admin/drivers", requireAdminAuth, requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const {
        fullName,
        phone,
        email,
        password,
        vehicleNumber,
        vehicleModel,
        licenseNumber,
        vehicleType = "bike",
        vehicleCategoryId,
      } = req.body || {};

      const cleanName = String(fullName || "").trim();
      const cleanPhone = normalizePhone(phone);
      const cleanEmail = String(email || "").trim().toLowerCase();
      const cleanPassword = String(password || "");

      if (!cleanName) return res.status(400).json({ message: "Driver name is required" });
      if (cleanPhone.length !== 10) return res.status(400).json({ message: "Enter a valid 10-digit phone number" });
      if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res.status(400).json({ message: "Enter a valid email address" });
      }
      if (cleanPassword.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });

      const existingPhone = await rawDb.execute(rawSql`
        SELECT id, user_type FROM users WHERE phone=${cleanPhone} OR mobile=${cleanPhone} LIMIT 1
      `);
      if (existingPhone.rows.length) {
        return res.status(409).json({ message: "A user with this phone number already exists" });
      }

      if (cleanEmail) {
        const existingEmail = await rawDb.execute(rawSql`
          SELECT id FROM users WHERE LOWER(email)=${cleanEmail} LIMIT 1
        `);
        if (existingEmail.rows.length) {
          return res.status(409).json({ message: "A user with this email already exists" });
        }
      }

      const passwordHash = await hashPassword(cleanPassword);
      const created = await rawDb.transaction(async (trx) => {
        const inserted = await trx.execute(rawSql`
          INSERT INTO users (
            name, full_name, mobile, phone, email, role, user_type,
            is_active, verification_status, vehicle_status, wallet_balance,
            password_hash, vehicle_number, vehicle_model, license_number,
            created_at, updated_at
          )
          VALUES (
            ${cleanName}, ${cleanName}, ${cleanPhone}, ${cleanPhone}, ${cleanEmail || null},
            'driver', 'driver', true, 'pending', 'pending', 0,
            ${passwordHash}, ${String(vehicleNumber || "").trim() || null},
            ${String(vehicleModel || "").trim() || null},
            ${String(licenseNumber || "").trim() || null},
            NOW(), NOW()
          )
          RETURNING *
        `);
        const driver = inserted.rows[0] as any;
        const resolvedVehicleCategoryId = vehicleCategoryId
          ? String(vehicleCategoryId)
          : await resolveVehicleCategoryIdForType(String(vehicleType || "bike"));
        await upsertDriverDetailsRow(
          trx,
          String(driver.id),
          String(vehicleType || "bike"),
          resolvedVehicleCategoryId,
        );
        await trx.execute(rawSql`
          UPDATE users
          SET referral_code = COALESCE(referral_code, ${`JAGOPRO${cleanPhone.slice(-6)}`})
          WHERE id=${driver.id}::uuid
        `).catch(() => ({ rows: [] }));
        return driver;
      });

      await logAdminAction("driver_created", "driver", String((created as any).id), {
        phone: cleanPhone,
        vehicleType,
        source: "admin_panel",
      });

      res.status(201).json({ success: true, driver: camelize(created) });
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (e?.code === "23505" || msg.includes("duplicate key")) {
        return res.status(409).json({ message: "Driver already exists with this phone or email" });
      }
      console.error("[admin] create driver failed", { message: e?.message, stack: e?.stack });
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.delete("/api/users/:id", requireAdminAuth, async (req, res) => {
    try {
      const { db: xDb, sql: xSql } = await import("./db").then(async m => ({ db: m.db, sql: (await import("drizzle-orm")).sql }));
      await xDb.execute(xSql`DELETE FROM users WHERE id::text = ${req.params.id}`);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.patch("/api/users/:id/status", requireAdminAuth, async (req, res) => {
    try {
      const { isActive } = req.body;
      const user = await storage.updateUserStatus(String(req.params.id), isActive);
      res.json(user);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Trips
  app.get("/api/trips", async (req, res) => {
    try {
      const { status, search, page, limit } = req.query as Record<string, string>;
      const result = await storage.getTrips(
        status,
        search,
        Number(page) || 1,
        Number(limit) || 15
      );
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.get("/api/trips/:id", async (req, res) => {
    try {
      const trip = await storage.getTripById(req.params.id);
      if (!trip) return res.status(404).json({ message: "Trip not found" });
      res.json(trip);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.patch("/api/trips/:id/status", requireAdminAuth, async (req, res) => {
    try {
      const { status } = req.body;
      const trip = await storage.updateTripStatus(String(req.params.id), status);
      res.json(trip);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Vehicle Categories (filtered by is_active; optional ?type=ride|parcel|pool)
  app.get("/api/vehicle-categories", async (req, res) => {
    try {
      const typeFilter = req.query.type?.toString().trim().toLowerCase() || '';
      const q = typeFilter
        ? rawSql`
            SELECT *
            FROM vehicle_categories
            WHERE is_active = true
              AND (
                LOWER(COALESCE(service_type, '')) = LOWER(${typeFilter})
                OR (
                  LOWER(${typeFilter}) IN ('pool', 'carpool')
                  AND (COALESCE(is_carpool, false) = true OR LOWER(COALESCE(service_type, '')) IN ('pool', 'carpool'))
                )
                OR (
                  LOWER(${typeFilter}) = 'ride'
                  AND COALESCE(service_type, 'ride') = 'ride'
                  AND COALESCE(is_carpool, false) = false
                )
              )
            ORDER BY COALESCE(service_type, 'ride'), name
          `
        : rawSql`
            SELECT *
            FROM vehicle_categories
            WHERE is_active = true
            ORDER BY
              CASE COALESCE(
                NULLIF(service_type, ''),
                CASE WHEN COALESCE(is_carpool, false) = true THEN 'pool' ELSE 'ride' END
              )
                WHEN 'ride' THEN 1
                WHEN 'pool' THEN 2
                WHEN 'carpool' THEN 2
                WHEN 'parcel' THEN 3
                WHEN 'cargo' THEN 4
                ELSE 4
              END,
              name
          `;
      const r = await rawDb.execute(q);
      res.json(camelize(r.rows));
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.post("/api/vehicle-categories", requireAdminAuth, async (req, res) => {
    try {
      const cat = await storage.createVehicleCategory(req.body);
      res.status(201).json(cat);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.put("/api/vehicle-categories/:id", requireAdminAuth, async (req, res) => {
    try {
      const cat = await storage.updateVehicleCategory(String(req.params.id), req.body);
      res.json(cat);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.patch("/api/vehicle-categories/:id", requireAdminAuth, async (req, res) => {
    try {
      const { isActive } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active=${isActive} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.delete("/api/vehicle-categories/:id", requireAdminAuth, async (req, res) => {
    try {
      await storage.deleteVehicleCategory(String(req.params.id));
      res.status(204).end();
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Zones
  app.get("/api/zones", async (req, res) => {
    try {
      const zoneList = await storage.getZones();
      res.json(zoneList);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  function validateZoneCoordinates(coordinates: any): boolean {
    if (!coordinates) return true; // optional field
    try {
      const geo = typeof coordinates === 'string' ? JSON.parse(coordinates) : coordinates;
      if (geo.type !== 'Polygon' && geo.type !== 'MultiPolygon') return false;
      if (!Array.isArray(geo.coordinates)) return false;
      return true;
    } catch {
      return false;
    }
  }

  app.post("/api/zones", requireAdminAuth, async (req, res) => {
    try {
      if (req.body.coordinates !== undefined && !validateZoneCoordinates(req.body.coordinates)) {
        return res.status(400).json({ message: "Invalid zone coordinates � must be a valid GeoJSON Polygon or MultiPolygon" });
      }
      const zone = await storage.createZone(req.body);
      res.status(201).json(zone);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.put("/api/zones/:id", requireAdminAuth, async (req, res) => {
    try {
      if (req.body.coordinates !== undefined && !validateZoneCoordinates(req.body.coordinates)) {
        return res.status(400).json({ message: "Invalid zone coordinates � must be a valid GeoJSON Polygon or MultiPolygon" });
      }
      const zone = await storage.updateZone(String(req.params.id), req.body);
      if (!zone) return res.status(404).json({ message: "Zone not found" });
      res.json(zone);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.patch("/api/zones/:id", requireAdminAuth, async (req, res) => {
    try {
      if (req.body.coordinates !== undefined && !validateZoneCoordinates(req.body.coordinates)) {
        return res.status(400).json({ message: "Invalid zone coordinates � must be a valid GeoJSON Polygon or MultiPolygon" });
      }
      const zone = await storage.updateZone(String(req.params.id), req.body);
      if (!zone) return res.status(404).json({ message: "Zone not found" });
      res.json(zone);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.delete("/api/zones/:id", requireAdminAuth, async (req, res) => {
    try {
      await storage.deleteZone(String(req.params.id));
      res.status(204).end();
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Trip Fares
  app.get("/api/fares", async (req, res) => {
    try {
      const fares = await storage.getTripFares();
      res.json(fares);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.post("/api/fares", requireAdminAuth, async (req, res) => {
    try {
      const fare = await storage.upsertTripFare(req.body);
      res.status(201).json(fare);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.put("/api/fares/:id", requireAdminAuth, async (req, res) => {
    try {
      const fare = await storage.updateTripFare(String(req.params.id), req.body);
      res.json(fare);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.delete("/api/fares/:id", requireAdminAuth, async (req, res) => {
    try {
      await storage.deleteTripFare(String(req.params.id));
      res.status(204).end();
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- VEHICLE-FARES: All vehicle categories with their current fare config --
  // Used by the admin Fare Setup page (single unified view of all vehicles).
  app.get("/api/vehicle-fares", async (req, res) => {
    try {
      const rows = await rawDb.execute(rawSql`
        SELECT
          vc.id AS vehicle_category_id,
          vc.name AS vehicle_name,
          vc.vehicle_type,
          vc.type AS service_type,
          vc.icon AS vehicle_icon,
          vc.is_active,
          vc.total_seats,
          vc.is_carpool,
          tf.id             AS fare_id,
          COALESCE(NULLIF(tf.base_fare, 0), vc.base_fare)     AS base_fare,
          COALESCE(NULLIF(tf.fare_per_km, 0), vc.fare_per_km) AS fare_per_km,
          tf.fare_per_min,
          tf.fare_per_kg,
          COALESCE(NULLIF(tf.minimum_fare, 0), vc.minimum_fare) AS minimum_fare,
          tf.cancellation_fee,
          COALESCE(NULLIF(tf.waiting_charge_per_min, 0), vc.waiting_charge_per_min) AS waiting_charge_per_min,
          tf.night_charge_multiplier,
          tf.helper_charge,
          tf.zone_id,
          z.name            AS zone_name
        FROM vehicle_categories vc
        LEFT JOIN LATERAL (
          SELECT * FROM trip_fares tf2
          WHERE tf2.vehicle_category_id = vc.id
          ORDER BY tf2.created_at DESC
          LIMIT 1
        ) tf ON true
        LEFT JOIN zones z ON z.id = tf.zone_id
        ORDER BY
          CASE vc.vehicle_type
            WHEN 'bike'     THEN 1
            WHEN 'auto'     THEN 2
            WHEN 'mini_car' THEN 3
            WHEN 'sedan'    THEN 4
            WHEN 'suv'      THEN 5
            WHEN 'carpool'  THEN 6
            ELSE 7
          END,
          CASE vc.type WHEN 'ride' THEN 1 WHEN 'parcel' THEN 2 WHEN 'cargo' THEN 3 ELSE 4 END,
          vc.name
      `);
      res.json(rows.rows.map(camelize));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Upsert fare for a specific vehicle category (no zone required)
  app.post("/api/vehicle-fares/:vehicleCategoryId", async (req, res) => {
    try {
      const { vehicleCategoryId } = req.params;
      const {
        baseFare = 0, farePerKm = 0, farePerMin = 0, farePerKg = 0,
        minimumFare = 0, cancellationFee = 0, waitingChargePerMin = 0,
        nightChargeMultiplier = 1.25, helperCharge = 0, zoneId,
      } = req.body;

      const fareValues = [baseFare, farePerKm, farePerMin, farePerKg, minimumFare, cancellationFee, waitingChargePerMin, helperCharge];
      if (fareValues.some(v => parseFloat(String(v)) < 0)) {
        return res.status(400).json({ message: "Fare values must be non-negative" });
      }

      // Check if a fare already exists for this vehicle category
      const existing = await rawDb.execute(rawSql`
        SELECT id FROM trip_fares WHERE vehicle_category_id = ${vehicleCategoryId}::uuid
        ORDER BY created_at DESC LIMIT 1
      `);

      let result: any;
      if (existing.rows.length) {
        // UPDATE the existing row
        const fareId = (existing.rows[0] as any).id;
        result = await rawDb.execute(rawSql`
          UPDATE trip_fares SET
            base_fare               = ${parseFloat(String(baseFare)) || 0},
            fare_per_km             = ${parseFloat(String(farePerKm)) || 0},
            fare_per_min            = ${parseFloat(String(farePerMin)) || 0},
            fare_per_kg             = ${parseFloat(String(farePerKg)) || 0},
            minimum_fare            = ${parseFloat(String(minimumFare)) || 0},
            cancellation_fee        = ${parseFloat(String(cancellationFee)) || 0},
            waiting_charge_per_min  = ${parseFloat(String(waitingChargePerMin)) || 0},
            night_charge_multiplier = ${parseFloat(String(nightChargeMultiplier)) || 1.25},
            helper_charge           = ${parseFloat(String(helperCharge)) || 0},
            zone_id                 = ${zoneId ? rawSql`${zoneId}::uuid` : rawSql`NULL`}
          WHERE id = ${fareId}::uuid
          RETURNING *
        `);
      } else {
        // INSERT a new row
        result = await rawDb.execute(rawSql`
          INSERT INTO trip_fares
            (vehicle_category_id, base_fare, fare_per_km, fare_per_min, fare_per_kg,
             minimum_fare, cancellation_fee, waiting_charge_per_min,
             night_charge_multiplier, helper_charge, zone_id)
          VALUES (
            ${vehicleCategoryId}::uuid,
            ${parseFloat(String(baseFare)) || 0},
            ${parseFloat(String(farePerKm)) || 0},
            ${parseFloat(String(farePerMin)) || 0},
            ${parseFloat(String(farePerKg)) || 0},
            ${parseFloat(String(minimumFare)) || 0},
            ${parseFloat(String(cancellationFee)) || 0},
            ${parseFloat(String(waitingChargePerMin)) || 0},
            ${parseFloat(String(nightChargeMultiplier)) || 1.25},
            ${parseFloat(String(helperCharge)) || 0},
            ${zoneId ? rawSql`${zoneId}::uuid` : rawSql`NULL`}
          )
          RETURNING *
        `);
      }
      res.json(camelize(result.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: Pricing Management ---------------------------------------------

  // GET all vehicle categories with full pricing (vehicle_categories + trip_fares merged)
  app.get("/api/admin/pricing/vehicles", requireAdminRole(["admin", "superadmin"]), async (_req, res) => {
    try {
      const rows = await rawDb.execute(rawSql`
        SELECT
          vc.id, vc.name, vc.vehicle_type, vc.type, vc.icon, vc.is_active,
          vc.base_fare     AS vc_base_fare,
          vc.fare_per_km   AS vc_fare_per_km,
          vc.minimum_fare  AS vc_minimum_fare,
          vc.waiting_charge_per_min AS vc_waiting_charge,
          vc.total_seats, vc.is_carpool,
          tf.id            AS fare_id,
          COALESCE(NULLIF(tf.base_fare, 0), vc.base_fare)    AS base_fare,
          COALESCE(NULLIF(tf.fare_per_km, 0), vc.fare_per_km) AS fare_per_km,
          COALESCE(NULLIF(tf.minimum_fare, 0), vc.minimum_fare) AS minimum_fare,
          COALESCE(NULLIF(tf.waiting_charge_per_min, 0), vc.waiting_charge_per_min) AS waiting_charge_per_min,
          tf.fare_per_min, tf.cancellation_fee, tf.night_charge_multiplier, tf.helper_charge
        FROM vehicle_categories vc
        LEFT JOIN LATERAL (
          SELECT * FROM trip_fares tf2
          WHERE tf2.vehicle_category_id = vc.id
          ORDER BY tf2.created_at DESC LIMIT 1
        ) tf ON true
        ORDER BY
          CASE vc.vehicle_type
            WHEN 'bike'     THEN 1
            WHEN 'auto'     THEN 2
            WHEN 'mini_car' THEN 3
            WHEN 'sedan'    THEN 4
            WHEN 'suv'      THEN 5
            WHEN 'carpool'  THEN 6
            ELSE 7
          END, vc.name
      `);
      res.json(rows.rows.map(camelize));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // PUT /api/admin/pricing/vehicles/:id � update vehicle pricing in both vehicle_categories + trip_fares
  app.put("/api/admin/pricing/vehicles/:id", requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const { id } = req.params;
      const {
        baseFare, farePerKm, minimumFare, waitingChargePerMin,
        farePerMin = 0, cancellationFee = 10, nightChargeMultiplier = 1.25,
        helperCharge = 0, totalSeats, isActive, name, icon,
      } = req.body;

      // Validate required pricing fields
      if (baseFare === undefined || farePerKm === undefined || minimumFare === undefined) {
        return res.status(400).json({ message: "baseFare, farePerKm, minimumFare are required" });
      }

      const bf = parseFloat(String(baseFare));
      const pkm = parseFloat(String(farePerKm));
      const mf = parseFloat(String(minimumFare));
      const wc = parseFloat(String(waitingChargePerMin ?? 0));
      const pm = parseFloat(String(farePerMin));
      const cf = parseFloat(String(cancellationFee));
      const ncm = parseFloat(String(nightChargeMultiplier));
      const hc = parseFloat(String(helperCharge));

      // Update vehicle_categories primary pricing (name + icon were previously
      // collected into `updateParts` but never applied to the UPDATE query —
      // admin edits to name/icon silently failed. Fixed with parameterized fragments.)
      const vcUpdated = await rawDb.execute(rawSql`
        UPDATE vehicle_categories
        SET base_fare = ${bf}, fare_per_km = ${pkm}, minimum_fare = ${mf},
            waiting_charge_per_min = ${wc}
            ${totalSeats !== undefined ? rawSql`, total_seats = ${parseInt(String(totalSeats)) || 0}` : rawSql``}
            ${isActive !== undefined ? rawSql`, is_active = ${isActive === true || isActive === 'true'}` : rawSql``}
            ${name ? rawSql`, name = ${String(name)}` : rawSql``}
            ${icon ? rawSql`, icon = ${String(icon)}` : rawSql``}
        WHERE id = ${id}::uuid
        RETURNING *
      `);

      if (!vcUpdated.rows.length) return res.status(404).json({ message: "Vehicle category not found" });

      // Sync to trip_fares: upsert the fare row
      const existingFare = await rawDb.execute(rawSql`
        SELECT id FROM trip_fares WHERE vehicle_category_id = ${id}::uuid ORDER BY created_at DESC LIMIT 1
      `);
      if (existingFare.rows.length) {
        await rawDb.execute(rawSql`
          UPDATE trip_fares SET
            base_fare = ${bf}, fare_per_km = ${pkm}, minimum_fare = ${mf},
            waiting_charge_per_min = ${wc}, fare_per_min = ${pm},
            cancellation_fee = ${cf}, night_charge_multiplier = ${ncm}, helper_charge = ${hc}
          WHERE id = ${(existingFare.rows[0] as any).id}::uuid
        `);
      } else {
        await rawDb.execute(rawSql`
          INSERT INTO trip_fares (vehicle_category_id, base_fare, fare_per_km, minimum_fare,
            waiting_charge_per_min, fare_per_min, cancellation_fee, night_charge_multiplier, helper_charge)
          VALUES (${id}::uuid, ${bf}, ${pkm}, ${mf}, ${wc}, ${pm}, ${cf}, ${ncm}, ${hc})
        `);
      }

      res.json({ success: true, vehicleCategory: camelize(vcUpdated.rows[0]) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // PATCH /api/admin/pricing/vehicles/:id/availability � toggle vehicle availability
  app.patch("/api/admin/pricing/vehicles/:id/availability", requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const { isActive } = req.body;
      const r = await rawDb.execute(rawSql`
        UPDATE vehicle_categories SET is_active = ${isActive === true || isActive === 'true'}
        WHERE id = ${req.params.id}::uuid RETURNING id, name, is_active
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Vehicle category not found" });
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // GET /api/admin/pricing/settings � get GST rate, launch campaign, commission settings
  app.get("/api/admin/pricing/settings", requireAdminRole(["admin", "superadmin"]), async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT key_name, value FROM revenue_model_settings ORDER BY key_name`);
      const settings: Record<string, string> = {};
      r.rows.forEach((row: any) => { settings[row.key_name] = row.value; });
      res.json({
        settings,
        gstRate: parseFloat(settings.ride_gst_rate || '5'),
        commissionPct: parseFloat(settings.driver_commission_pct || '20'),
        launchCampaignEnabled: settings.launch_campaign_enabled !== 'false',
        activeModel: settings.active_model || 'commission',
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // PUT /api/admin/pricing/settings � update one or more pricing settings
  app.put("/api/admin/pricing/settings", requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const updates = req.body as Record<string, string>;
      if (!updates || typeof updates !== 'object') return res.status(400).json({ message: "Body must be an object of key?value" });
      const allowedKeys = new Set([
        'ride_gst_rate', 'driver_commission_pct', 'launch_campaign_enabled',
        'active_model', 'rides_model', 'parcels_model', 'cargo_model', 'intercity_model',
        'outstation_pool_model', 'outstation_pool_mode', 'subscription_mode', 'commission_mode',
        'subscription_enabled', 'sub_platform_fee_per_ride',
        'commission_pct', 'hybrid_commission_pct', 'hybrid_platform_fee_per_ride',
        'commission_insurance_per_ride', 'auto_lock_threshold',
        'commission_lock_threshold', 'commission_rate',
      ]);
      const invalidKeys = Object.keys(updates).filter(k => !allowedKeys.has(k));
      if (invalidKeys.length) return res.status(400).json({ message: `Unknown setting keys: ${invalidKeys.join(', ')}` });
      for (const [key, value] of Object.entries(updates)) {
        await rawDb.execute(rawSql`
          INSERT INTO revenue_model_settings (key_name, value, updated_at)
          VALUES (${key}, ${String(value)}, NOW())
          ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `);
      }
      res.json({ success: true, updated: Object.keys(updates).length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --- Admin: Commission Settlement Endpoints --------------------------------

  // GET /api/admin/commission-settlements � all settlement rows, filterable
  app.get("/api/admin/commission-settlements", requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const { driverId, type, direction, page = '1', limit = '50' } = req.query as Record<string, string>;
      const offset = (parseInt(page) - 1) * parseInt(limit);
      let whereClause = rawSql`WHERE 1=1`;
      if (driverId) whereClause = rawSql`WHERE cs.driver_id = ${driverId}::uuid`;
      const rows = await rawDb.execute(rawSql`
        SELECT cs.*,
               u.full_name as driver_name, u.phone as driver_phone, u.email as driver_email,
               tr.ref_id as trip_ref, tr.pickup_address, tr.dropoff_address
        FROM commission_settlements cs
        JOIN users u ON u.id = cs.driver_id
        LEFT JOIN trip_requests tr ON tr.id = cs.trip_id
        ${whereClause}
        ORDER BY cs.created_at DESC
        LIMIT ${parseInt(limit)} OFFSET ${offset}
      `);
      const totalR = await rawDb.execute(rawSql`SELECT COUNT(*) as cnt FROM commission_settlements cs ${whereClause}`).catch(() => ({ rows: [{ cnt: 0 }] }));
      res.json({ data: camelize(rows.rows), total: parseInt((totalR.rows[0] as any)?.cnt || 0), page: parseInt(page), limit: parseInt(limit) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // GET /api/admin/commission-settlements/drivers � per-driver pending balance summary
  app.get("/api/admin/commission-settlements/drivers", requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const rows = await rawDb.execute(rawSql`
        SELECT u.id, u.full_name, u.phone, u.email, u.is_locked, u.lock_reason,
               u.wallet_balance, u.pending_commission_balance, u.pending_gst_balance,
               u.total_pending_balance, u.lock_threshold,
               COUNT(DISTINCT tr.id) FILTER (WHERE tr.current_status='completed') as completed_trips,
               MAX(tr.created_at) as last_trip_at,
               COALESCE(SUM(cs.total_amount) FILTER (WHERE cs.direction='debit'), 0) as total_debited,
               COALESCE(SUM(cs.total_amount) FILTER (WHERE cs.direction='credit'), 0) as total_paid
        FROM users u
        LEFT JOIN trip_requests tr ON tr.driver_id = u.id
        LEFT JOIN commission_settlements cs ON cs.driver_id = u.id
        WHERE u.user_type = 'driver'
        GROUP BY u.id
        ORDER BY u.total_pending_balance DESC
      `);
      res.json({ data: camelize(rows.rows), total: rows.rows.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // POST /api/admin/commission-settlements/drivers/:driverId/settle � admin manually settles partial/full amount
  app.post("/api/admin/commission-settlements/drivers/:driverId/settle", requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const { driverId } = req.params;
      const { amount, method = 'cash', description, forceUnlock = false } = req.body;
      const payAmt = parseFloat(String(amount));
      // SECURITY: Cap settlement amount to prevent accidental/malicious over-credit
      if (!payAmt || payAmt <= 0 || payAmt > 100000 || isNaN(payAmt)) {
        return res.status(400).json({ message: "Invalid amount. Must be between ?0.01 and ?1,00,000." });
      }

      const settingRows = await rawDb.execute(rawSql`SELECT key_name, value FROM revenue_model_settings`);
      const settings: any = {};
      settingRows.rows.forEach((r: any) => { settings[r.key_name] = r.value; });

      const balR = await rawDb.execute(rawSql`
        SELECT pending_commission_balance, pending_gst_balance, total_pending_balance, is_locked
        FROM users WHERE id=${driverId}::uuid LIMIT 1
      `);
      const bal: any = balR.rows[0] || {};
      const prevTotal = parseFloat(bal.total_pending_balance ?? '0') || 0;
      const prevCommission = parseFloat(bal.pending_commission_balance ?? '0') || 0;
      const prevGst = parseFloat(bal.pending_gst_balance ?? '0') || 0;

      const gstReduction = Math.min(prevGst, parseFloat((payAmt * (prevTotal > 0 ? prevGst / prevTotal : 0.05)).toFixed(2)));
      const commReduction = Math.min(prevCommission, parseFloat((payAmt - gstReduction).toFixed(2)));
      const newTotal = Math.max(0, parseFloat((prevTotal - payAmt).toFixed(2)));
      const newCommission = Math.max(0, parseFloat((prevCommission - commReduction).toFixed(2)));
      const newGst = Math.max(0, parseFloat((prevGst - gstReduction).toFixed(2)));

      await rawDb.execute(rawSql`
        UPDATE users
        SET wallet_balance             = wallet_balance + ${payAmt},
            pending_commission_balance = ${newCommission},
            pending_gst_balance        = ${newGst},
            total_pending_balance      = ${newTotal},
            pending_payment_amount     = GREATEST(0, pending_payment_amount - ${payAmt})
        WHERE id = ${driverId}::uuid
      `);
      const lockThreshold = parseFloat(settings.commission_lock_threshold || '200');
      const shouldUnlock = forceUnlock || newTotal < lockThreshold;
      if (shouldUnlock && bal.is_locked) {
        await rawDb.execute(rawSql`UPDATE users SET is_locked=false, lock_reason=NULL, locked_at=NULL WHERE id=${driverId}::uuid`);
      }
      await rawDb.execute(rawSql`
        INSERT INTO commission_settlements
          (driver_id, settlement_type, commission_amount, gst_amount, total_amount,
           direction, balance_before, balance_after, payment_method, status, description)
        VALUES
          (${driverId}::uuid, 'admin_settle', ${commReduction}, ${gstReduction}, ${payAmt},
           'credit', ${prevTotal}, ${newTotal}, ${method},
           'completed', ${description || 'Admin manual settlement'})
      `).catch(dbCatch("db"));
      await rawDb.execute(rawSql`
        INSERT INTO driver_payments (driver_id, amount, payment_type, status, description)
        VALUES (${driverId}::uuid, ${payAmt}, 'admin_settlement', 'completed', ${description || 'Admin settlement'})
      `).catch(dbCatch("db"));
      res.json({ success: true, newPendingBalance: newTotal, pendingCommission: newCommission, pendingGst: newGst, autoUnlocked: shouldUnlock && bal.is_locked });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Transactions
  app.get("/api/transactions", async (req, res) => {
    try {
      const { userId, page, limit } = req.query as Record<string, string>;
      const result = await storage.getTransactions(userId, Number(page) || 1, Number(limit) || 15);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Coupons
  app.get("/api/coupons", async (req, res) => {
    try {
      const coupons = await storage.getCoupons();
      res.json(coupons);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Sanitize coupon form data: coerce empty strings to null for typed columns
  const sanitizeCoupon = (body: any) => ({
    ...body,
    discountAmount: body.discountAmount != null ? String(body.discountAmount) : '0',
    minTripAmount: body.minTripAmount != null ? String(body.minTripAmount) : '0',
    maxDiscountAmount: body.maxDiscountAmount && String(body.maxDiscountAmount).trim() !== ''
      ? String(body.maxDiscountAmount) : null,
    totalUsageLimit: body.totalUsageLimit && String(body.totalUsageLimit).trim() !== ''
      ? parseInt(String(body.totalUsageLimit), 10) : null,
    limitPerUser: body.limitPerUser && String(body.limitPerUser).trim() !== ''
      ? parseInt(String(body.limitPerUser), 10) : 1,
    endDate: body.endDate && String(body.endDate).trim() !== ''
      ? new Date(body.endDate) : null,
  });

  app.post("/api/coupons", requireAdminAuth, async (req, res) => {
    try {
      const coupon = await storage.createCoupon(sanitizeCoupon(req.body));
      res.status(201).json(coupon);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.put("/api/coupons/:id", requireAdminAuth, async (req, res) => {
    try {
      const coupon = await storage.updateCoupon(String(req.params.id), sanitizeCoupon(req.body));
      res.json(coupon);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.patch("/api/coupons/:id", requireAdminAuth, async (req, res) => {
    try {
      const { isActive } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE coupon_setups SET is_active=${isActive} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.delete("/api/coupons/:id", requireAdminAuth, async (req, res) => {
    try {
      await storage.deleteCoupon(String(req.params.id));
      res.status(204).end();
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Reviews
  app.get("/api/reviews", async (req, res) => {
    try {
      const { page, limit } = req.query as Record<string, string>;
      const result = await storage.getReviews(Number(page) || 1, Number(limit) || 15);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Business Settings
  app.get("/api/settings", async (req, res) => {
    try {
      const settings = await storage.getBusinessSettings();
      res.json(settings);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.post("/api/settings", requireAdminAuth, async (req, res) => {
    try {
      // Support both bulk format { settings: {key: val, ...} } and single { keyName, value, settingsType }
      if (req.body.settings && typeof req.body.settings === 'object') {
        const settingsObj: Record<string, string> = req.body.settings;
        const keyTypeMap: Record<string, string> = {
          business_name: 'business', business_email: 'business', business_phone: 'business', business_address: 'business',
          currency_code: 'currency', currency_symbol: 'currency', country_code: 'currency',
          max_search_radius: 'trip', driver_cancel_limit: 'trip', customer_cancel_limit: 'trip',
          razorpay_key_id: 'payment', razorpay_key_secret: 'payment', payment_gateway_mode: 'payment', fast2sms_api_key: 'payment',
          customer_app_version: 'app', driver_app_version: 'app', force_update: 'app', maintenance_mode: 'app',
          referral_bonus_driver: 'referral', referral_bonus_customer: 'referral', min_wallet_withdrawal: 'referral', max_wallet_recharge: 'referral',
        };
        const results = [];
        for (const [k, v] of Object.entries(settingsObj)) {
          const t = keyTypeMap[k] || 'general';
          const r = await storage.upsertBusinessSetting(k, String(v ?? ''), t);
          results.push(r);
        }
        return res.json({ saved: results.length, settings: results });
      }
      const { keyName, value, settingsType } = req.body;
      const setting = await storage.upsertBusinessSetting(
        keyName,
        value,
        settingsType || "business_settings",
      );
      res.json(setting);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Business Settings alias (same as /api/settings)
  app.get("/api/business-settings", async (_req, res) => {
    try {
      const settings = await storage.getBusinessSettings();
      res.json(settings);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/business-settings", requireAdminAuth, async (req, res) => {
    try {
      const { keyName, value, settingsType } = req.body;
      const setting = await storage.upsertBusinessSetting(
        keyName,
        value,
        settingsType || "business_settings",
      );
      res.json(setting);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin-prefixed aliases (admin panel uses /api/admin/business-settings)
  app.get("/api/admin/business-settings", requireAdminAuth, async (_req, res) => {
    try {
      const settings = await storage.getBusinessSettings();
      res.json(settings);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.get("/api/admin/business-settings/:key", requireAdminAuth, async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT key_name, value FROM business_settings WHERE key_name=${req.params.key} LIMIT 1`);
      if (!r.rows.length) return res.json({ key_name: req.params.key, value: '' });
      res.json(r.rows[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/admin/business-settings", requireAdminAuth, async (req, res) => {
    try {
      const keyName = req.body.key_name || req.body.keyName;
      const value = req.body.value ?? '';
      const settingsType = req.body.settingsType || "business_settings";
      const setting = await storage.upsertBusinessSetting(keyName, value, settingsType);
      res.json(setting);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: Runtime configuration control ---------------------------------
  app.get("/api/admin/runtime-config", requireAdminAuth, async (_req, res) => {
    try {
      await initRuntimeConfigTables();
      const snapshot = await getRuntimeConfigSnapshot(true);
      res.json({ success: true, data: snapshot });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.put("/api/admin/runtime-config", requireAdminAuth, requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      await initRuntimeConfigTables();
      const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
      if (!entries.length) return res.status(400).json({ message: "At least one runtime config entry is required" });
      const snapshot = await upsertRuntimeConfigEntries({
        scopeType: req.body?.scopeType || "global",
        scopeKey: req.body?.scopeKey || "default",
        entries,
        reason: req.body?.reason || "admin_runtime_update",
        updatedBy: (req as any).adminUser?.email || "admin",
      });
      res.json({ success: true, data: snapshot });
    } catch (e: any) { res.status(400).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/runtime-config/audit", requireAdminAuth, async (req, res) => {
    try {
      await initRuntimeConfigTables();
      const limit = Number(req.query.limit || 50);
      const logs = await listRuntimeConfigAuditLogs(limit);
      res.json({ success: true, data: logs });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/runtime-config/rollback", requireAdminAuth, requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      await initRuntimeConfigTables();
      const auditLogId = String(req.body?.auditLogId || "");
      if (!auditLogId) return res.status(400).json({ message: "auditLogId is required" });
      const snapshot = await rollbackRuntimeConfigAuditLog({
        auditLogId,
        updatedBy: (req as any).adminUser?.email || "admin",
      });
      res.json({ success: true, data: snapshot });
    } catch (e: any) { res.status(400).json({ message: safeErrMsg(e) }); }
  });

  async function ensureLocalPoolTables() {
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS local_pool_rides (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id UUID,
        vehicle_category_id UUID,
        pickup_lat DOUBLE PRECISION,
        pickup_lng DOUBLE PRECISION,
        destination_lat DOUBLE PRECISION,
        destination_lng DOUBLE PRECISION,
        route_bearing_deg DOUBLE PRECISION,
        pickup_address TEXT,
        destination_address TEXT,
        max_seats INTEGER DEFAULT 4,
        booked_seats INTEGER DEFAULT 0,
        fare_per_seat NUMERIC(10,2) DEFAULT 0,
        distance_km DOUBLE PRECISION DEFAULT 0,
        status VARCHAR(30) DEFAULT 'collecting',
        collection_deadline TIMESTAMP,
        zone_id UUID,
        dispatch_trip_id UUID,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS local_pool_passengers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pool_ride_id UUID NOT NULL,
        trip_request_id UUID,
        customer_id UUID NOT NULL,
        pickup_lat DOUBLE PRECISION,
        pickup_lng DOUBLE PRECISION,
        drop_lat DOUBLE PRECISION,
        drop_lng DOUBLE PRECISION,
        pickup_address TEXT,
        drop_address TEXT,
        seats_booked INTEGER DEFAULT 1,
        fare_per_seat NUMERIC(10,2) DEFAULT 0,
        total_fare NUMERIC(10,2) DEFAULT 0,
        distance_km DOUBLE PRECISION DEFAULT 0,
        payment_method VARCHAR(40) DEFAULT 'cash',
        status VARCHAR(30) DEFAULT 'booked',
        pickup_order INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await rawDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_local_pool_rides_status_created ON local_pool_rides(status, created_at DESC)`);
    await rawDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_local_pool_passengers_ride ON local_pool_passengers(pool_ride_id, status)`);
  }

  // -- ADMIN: Local pool monitoring -----------------------------------------
  app.get("/api/admin/local-pool/stats", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT
          COUNT(*)::int AS total_rides,
          COUNT(*) FILTER (WHERE status='active')::int AS active,
          COUNT(*) FILTER (WHERE status='active' AND accepting_new_requests=true)::int AS accepting,
          COUNT(*) FILTER (WHERE status='active' AND accepting_new_requests=false)::int AS paused,
          COUNT(*) FILTER (WHERE status='ended')::int AS completed,
          COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
          COALESCE(SUM(total_passengers_served), 0)::int AS total_passengers,
          COALESCE(SUM(total_earnings), 0)::numeric AS driver_earnings
        FROM driver_pool_sessions
      `);
      const money = await rawDb.execute(rawSql`
        SELECT
          COALESCE(SUM(total_fare), 0)::numeric AS total_revenue,
          COALESCE(SUM(commission_amount), 0)::numeric AS total_commission,
          COALESCE(SUM(gst_amount), 0)::numeric AS total_gst
        FROM pool_ride_requests
        WHERE status IN ('matched','picked_up','dropped')
      `).catch(() => ({ rows: [] as any[] }));
      res.json(camelize({ ...((r.rows[0] as any) || {}), ...((money.rows[0] as any) || {}) }));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/local-pool/rides", requireAdminAuth, async (req, res) => {
    try {
      const status = String(req.query.status || "all");
      const normalizedStatus = status === "completed" ? "ended" : status;
      const validStatus = ["active", "ended", "cancelled"].includes(normalizedStatus) ? normalizedStatus : "all";
      const r = await rawDb.execute(rawSql`
        SELECT
          dps.*,
          u.full_name AS driver_name,
          u.phone AS driver_phone,
          (dps.max_seats - dps.available_seats)::int AS booked_seats,
          COUNT(prr.id) FILTER (WHERE prr.status <> 'cancelled')::int AS passenger_count,
          COALESCE(AVG(prr.fare_per_seat), 0)::numeric AS fare_per_seat,
          COALESCE(SUM(prr.total_fare), 0)::numeric AS total_revenue,
          COALESCE(SUM(prr.commission_amount), 0)::numeric AS total_commission,
          COALESCE(SUM(prr.gst_amount), 0)::numeric AS total_gst,
          COALESCE(SUM(prr.driver_earnings), 0)::numeric AS total_driver_earnings
        FROM driver_pool_sessions dps
        LEFT JOIN users u ON u.id = dps.driver_id
        LEFT JOIN pool_ride_requests prr ON prr.session_id = dps.id AND prr.status <> 'cancelled'
        ${validStatus !== "all" ? rawSql`WHERE dps.status = ${validStatus}` : rawSql``}
        GROUP BY dps.id, u.full_name, u.phone
        ORDER BY dps.created_at DESC
        LIMIT 500
      `);
      res.json({ success: true, data: camelize(r.rows) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/local-pool/rides/:rideId/passengers", requireAdminAuth, async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT
          prr.*,
          prr.seats_requested AS seats_booked,
          u.full_name AS customer_name,
          u.phone AS customer_phone
        FROM pool_ride_requests prr
        LEFT JOIN users u ON u.id = prr.customer_id
        WHERE prr.session_id = ${req.params.rideId}::uuid
        ORDER BY prr.pickup_order ASC NULLS LAST, prr.created_at ASC
      `);
      res.json({ success: true, data: camelize(r.rows) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/admin/local-pool/settings", requireAdminAuth, requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const mode = String(req.body?.mode || "on").toLowerCase() === "off" ? "off" : "on";
      const collectionSecs = Math.max(60, Math.min(600, Number(req.body?.collectionSecs || 300)));
      const matchRadiusKm = Math.max(1, Math.min(12, Number(req.body?.matchRadiusKm || 4)));
      const maxDetourKm = Math.max(0.5, Math.min(8, Number(req.body?.maxDetourKm || 2.5)));
      const directionToleranceDeg = Math.max(15, Math.min(90, Number(req.body?.directionToleranceDeg || 50)));
      const pairs = [
        ["local_pool_mode", mode],
        ["local_pool_collection_secs", String(collectionSecs)],
        ["local_pool_match_radius_km", String(matchRadiusKm)],
        ["local_pool_max_detour_km", String(maxDetourKm)],
        ["local_pool_direction_tolerance_deg", String(directionToleranceDeg)],
      ];
      for (const [key, value] of pairs) {
        await rawDb.execute(rawSql`
          INSERT INTO business_settings (key_name, value, settings_type)
          VALUES (${key}, ${value}, 'pool_settings')
          ON CONFLICT (key_name) DO UPDATE SET value=EXCLUDED.value, settings_type=EXCLUDED.settings_type, updated_at=NOW()
        `);
      }
      res.json({ success: true, mode, collectionSecs, matchRadiusKm, maxDetourKm, directionToleranceDeg });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- OTP Settings (Admin) -------------------------------------------------
  app.get("/api/otp-settings", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM otp_settings LIMIT 1`);
      if (!r.rows.length) {
        return res.json({ primaryProvider: 'firebase', smsEnabled: false, firebaseEnabled: true, fallbackEnabled: false, otpExpirySeconds: 120, maxAttempts: 3 });
      }
      const row = r.rows[0] as any;
      res.json({
        primaryProvider: row.primary_provider,
        smsEnabled: row.sms_enabled,
        firebaseEnabled: row.firebase_enabled,
        fallbackEnabled: row.fallback_enabled,
        otpExpirySeconds: row.otp_expiry_seconds,
        maxAttempts: row.max_attempts,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.put("/api/otp-settings", requireAdminAuth, async (req, res) => {
    try {
      const { primaryProvider, smsEnabled, firebaseEnabled, fallbackEnabled, otpExpirySeconds, maxAttempts } = req.body;
      const provider = ['sms', 'firebase'].includes(primaryProvider) ? primaryProvider : 'sms';
      const expiry = Math.min(Math.max(60, parseInt(otpExpirySeconds) || 120), 600);
      const attempts = Math.min(Math.max(1, parseInt(maxAttempts) || 3), 10);
      await rawDb.execute(rawSql`
        INSERT INTO otp_settings (primary_provider, sms_enabled, firebase_enabled, fallback_enabled, otp_expiry_seconds, max_attempts, updated_at)
        VALUES (${provider}, ${!!smsEnabled}, ${!!firebaseEnabled}, ${!!fallbackEnabled}, ${expiry}, ${attempts}, NOW())
        ON CONFLICT (id) DO UPDATE SET
          primary_provider = EXCLUDED.primary_provider,
          sms_enabled = EXCLUDED.sms_enabled,
          firebase_enabled = EXCLUDED.firebase_enabled,
          fallback_enabled = EXCLUDED.fallback_enabled,
          otp_expiry_seconds = EXCLUDED.otp_expiry_seconds,
          max_attempts = EXCLUDED.max_attempts,
          updated_at = NOW()
      `);
      res.json({ success: true, primaryProvider: provider, smsEnabled: !!smsEnabled, firebaseEnabled: !!firebaseEnabled, fallbackEnabled: !!fallbackEnabled, otpExpirySeconds: expiry, maxAttempts: attempts });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Blogs
  app.get("/api/blogs", async (req, res) => {
    try {
      const blogList = await storage.getBlogs();
      res.json(blogList);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.post("/api/blogs", requireAdminAuth, async (req, res) => {
    try {
      const blog = await storage.createBlog(req.body);
      res.status(201).json(blog);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.put("/api/blogs/:id", requireAdminAuth, async (req, res) => {
    try {
      const blog = await storage.updateBlog(String(req.params.id), req.body);
      res.json(blog);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.patch("/api/blogs/:id", requireAdminAuth, async (req, res) => {
    try {
      const { isActive } = req.body;
      const updated = await storage.updateBlog(String(req.params.id), { isActive } as any);
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });
  app.delete("/api/blogs/:id", requireAdminAuth, async (req, res) => {
    try {
      await storage.deleteBlog(String(req.params.id));
      res.status(204).end();
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Withdraw Requests
  app.get("/api/withdrawals", async (req, res) => {
    try {
      const { status } = req.query as Record<string, string>;
      const result = await storage.getWithdrawRequests(status);
      // Normalize keys: storage returns { withdraw, user } but frontend expects { withdrawal, driver }
      const normalized = result.map((r: any) => ({
        withdrawal: r.withdraw || r.withdrawal || r,
        driver: r.user || r.driver || null,
      }));
      res.json(normalized);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.patch("/api/withdrawals/:id/status", requireAdminAuth, async (req, res) => {
    try {
      const { status } = req.body;
      const validStatuses = ["pending", "approved", "rejected", "paid"];
      if (!validStatuses.includes(status)) return res.status(400).json({ message: "Invalid status" });

      // If approving/paying, deduct from driver wallet and record transaction
      if (status === "approved" || status === "paid") {
        const wdRes = await rawDb.execute(rawSql`SELECT * FROM withdraw_requests WHERE id=${req.params.id}::uuid`);
        if (wdRes.rows.length) {
          const wd = wdRes.rows[0] as any;
          if (wd.status === "pending") {
            // Deduct from driver wallet
            await rawDb.execute(rawSql`
              UPDATE users SET wallet_balance = wallet_balance - ${parseFloat(wd.amount)}
              WHERE id=${wd.user_id}::uuid
            `);
            // Record transaction
            await rawDb.execute(rawSql`
              INSERT INTO transactions (user_id, account, debit, credit, balance, transaction_type)
              VALUES (${wd.user_id}::uuid, ${'Withdrawal processed'}, ${parseFloat(wd.amount)}, 0, 0, ${'withdrawal'})
            `).catch(dbCatch("db"));
          }
        }
      }
      const result = await storage.updateWithdrawStatus(String(req.params.id), status);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Cancellation Reasons
  app.get("/api/cancellation-reasons", async (req, res) => {
    try {
      const reasons = await storage.getCancellationReasons();
      res.json(reasons);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.post("/api/cancellation-reasons", requireAdminAuth, async (req, res) => {
    try {
      const reason = await storage.createCancellationReason(req.body);
      res.status(201).json(reason);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.put("/api/cancellation-reasons/:id", requireAdminAuth, async (req, res) => {
    try {
      const { reason, userType, isActive } = req.body;
      const [updated] = await db.update(cancellationReasons as any)
        .set({ reason, userType, isActive } as any)
        .where(eq((cancellationReasons as any).id, req.params.id))
        .returning();
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.patch("/api/cancellation-reasons/:id", requireAdminAuth, async (req, res) => {
    try {
      const { isActive } = req.body;
      const [updated] = await db.update(cancellationReasons as any)
        .set({ isActive } as any)
        .where(eq((cancellationReasons as any).id, req.params.id))
        .returning();
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.delete("/api/cancellation-reasons/:id", requireAdminAuth, async (req, res) => {
    try {
      await storage.deleteCancellationReason(String(req.params.id));
      res.status(204).end();
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- NEW MODULE ROUTES ------------------------------------------
  // Helper: direct DB queries for new tables
  const { db: rawDb } = await import("./db");
  const { sql: rawSql } = await import("drizzle-orm");

  // Banners
  app.get("/api/banners", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM banners ORDER BY created_at DESC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/banners", requireAdminAuth, async (req, res) => {
    try {
      const b = req.body;
      const title = b.title;
      const image_url = b.imageUrl ?? b.image_url ?? null;
      const redirect_url = b.redirectUrl ?? b.redirect_url ?? null;
      const zone = b.zone ?? null;
      const is_active = b.isActive ?? b.is_active ?? true;
      const r = await rawDb.execute(rawSql`INSERT INTO banners (title, image_url, redirect_url, zone, is_active) VALUES (${title}, ${image_url}, ${redirect_url}, ${zone}, ${is_active}) RETURNING *`);
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.patch("/api/banners/:id", requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const b = req.body;
      const title = b.title ?? null;
      const image_url = b.imageUrl ?? b.image_url ?? null;
      const redirect_url = b.redirectUrl ?? b.redirect_url ?? null;
      const zone = b.zone ?? null;
      const active = b.isActive ?? b.is_active ?? null;
      const r = await rawDb.execute(rawSql`
        UPDATE banners SET
          title=COALESCE(${title}, title),
          image_url=COALESCE(${image_url}, image_url),
          redirect_url=COALESCE(${redirect_url}, redirect_url),
          zone=COALESCE(${zone}, zone),
          is_active=COALESCE(${active}, is_active)
        WHERE id=${id}::uuid RETURNING *
      `);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  // PUT is same as PATCH for banners (frontend uses PUT for full update + toggle)
  app.put("/api/banners/:id", requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const b = req.body;
      const title = b.title ?? null;
      const image_url = b.imageUrl ?? b.image_url ?? null;
      const redirect_url = b.redirectUrl ?? b.redirect_url ?? null;
      const zone = b.zone ?? null;
      const active = b.isActive ?? b.is_active ?? null;
      const r = await rawDb.execute(rawSql`
        UPDATE banners SET
          title=COALESCE(${title}, title),
          image_url=COALESCE(${image_url}, image_url),
          redirect_url=COALESCE(${redirect_url}, redirect_url),
          zone=COALESCE(${zone}, zone),
          is_active=COALESCE(${active}, is_active)
        WHERE id=${id}::uuid RETURNING *
      `);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/banners/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM banners WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // App: active banners for home screen carousel
  app.get("/api/app/banners", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT id, title, image_url, redirect_url, zone, display_order
        FROM banners
        WHERE is_active = true
        ORDER BY display_order ASC, created_at DESC
        LIMIT 10
      `);
      res.json({ banners: r.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // App: get feature flags
  app.get("/api/app/feature-flags", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT key, enabled, description FROM feature_flags`);
      const flags: Record<string, boolean> = {};
      (r.rows as any[]).forEach(row => { flags[row.key] = row.enabled; });
      res.json({ flags });
    } catch (e: any) { res.status(e?.statusCode || 500).json({ message: safeErrMsg(e), code: e?.code, allowed: e?.allowed }); }
  });

  app.get("/api/app/runtime-config", async (_req, res) => {
    try {
      const cfg = await getRuntimeConfigSnapshot();
      res.json({
        config: {
          mapsEnabled: true,
          paymentsEnabled: true,
          parcelsEnabled: true,
          poolEnabled: true,
          realtimeEnabled: true,
        },
        featureFlags: cfg.featureFlags,
        services: cfg.services,
      });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.get("/api/app/popular-locations", async (req, res) => {
    try {
      const city = String(req.query.city || "Vijayawada").trim();
      const r = await rawDb.execute(rawSql`
        SELECT id, name, latitude, longitude, city_name, full_address
        FROM popular_locations
        WHERE is_active = true
          AND (
            LOWER(city_name) = LOWER(${city})
            OR ${city} = ''
          )
        ORDER BY name ASC
      `);
      const locations = camelize(r.rows).map((x: any) => ({
        ...x,
        lat: Number(x.latitude ?? x.lat ?? 0),
        lng: Number(x.longitude ?? x.lng ?? 0),
      }));
      res.json({ city, locations });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin: toggle feature flag
  app.patch("/api/feature-flags/:key", requireAdminAuth, async (req, res) => {
    try {
      const { key } = req.params;
      const { enabled } = req.body;
      const r = await rawDb.execute(rawSql`
        INSERT INTO feature_flags (key, enabled, updated_at)
        VALUES (${key}, ${!!enabled}, NOW())
        ON CONFLICT (key) DO UPDATE SET enabled=${!!enabled}, updated_at=NOW()
        RETURNING *
      `);
      res.json((r.rows as any[])[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin: list all feature flags
  app.get("/api/feature-flags", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM feature_flags ORDER BY key`);
      res.json(r.rows);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Discounts
  app.get("/api/discounts", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM discounts ORDER BY created_at DESC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/discounts", requireAdminAuth, async (req, res) => {
    try {
      const b = req.body;
      const name = b.name;
      const discount_amount = b.discountAmount ?? b.discount_amount ?? null;
      const discount_type = b.discountType ?? b.discount_type ?? "percentage";
      const min_order_amount = b.minOrderAmount ?? b.min_order_amount ?? null;
      const max_discount_amount = b.maxDiscountAmount ?? b.max_discount_amount ?? null;
      const is_active = b.isActive ?? b.is_active ?? true;
      const r = await rawDb.execute(rawSql`INSERT INTO discounts (name, discount_amount, discount_type, min_order_amount, max_discount_amount, is_active) VALUES (${name}, ${discount_amount}, ${discount_type}, ${min_order_amount}, ${max_discount_amount}, ${is_active}) RETURNING *`);
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/discounts/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM discounts WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.patch("/api/discounts/:id", requireAdminAuth, async (req, res) => {
    try {
      const { isActive, is_active } = req.body;
      const active = isActive ?? is_active;
      const r = await rawDb.execute(rawSql`UPDATE discounts SET is_active=${active} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/discounts/:id", requireAdminAuth, async (req, res) => {
    try {
      const b = req.body;
      const name = b.name ?? null;
      const discount_amount = b.discountAmount ?? b.discount_amount ?? null;
      const discount_type = b.discountType ?? b.discount_type ?? null;
      const min_order_amount = b.minOrderAmount ?? b.min_order_amount ?? null;
      const max_discount_amount = b.maxDiscountAmount ?? b.max_discount_amount ?? null;
      const active = b.isActive ?? b.is_active ?? null;
      const r = await rawDb.execute(rawSql`
        UPDATE discounts SET
          name=COALESCE(${name}, name),
          discount_amount=COALESCE(${discount_amount}, discount_amount),
          discount_type=COALESCE(${discount_type}, discount_type),
          min_order_amount=COALESCE(${min_order_amount}, min_order_amount),
          max_discount_amount=COALESCE(${max_discount_amount}, max_discount_amount),
          is_active=COALESCE(${active}, is_active)
        WHERE id=${req.params.id}::uuid RETURNING *
      `);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Spin Wheel
  app.get("/api/spin-wheel", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM spin_wheel_items ORDER BY created_at DESC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/spin-wheel", requireAdminAuth, async (req, res) => {
    try {
      const { label, reward_amount, rewardAmount, reward_type, rewardType, probability, is_active, isActive } = req.body;
      const rAmt = reward_amount ?? rewardAmount; const rType = reward_type ?? rewardType ?? 'wallet'; const active = is_active ?? isActive ?? true;
      const r = await rawDb.execute(rawSql`INSERT INTO spin_wheel_items (label, reward_amount, reward_type, probability, is_active) VALUES (${label}, ${rAmt}, ${rType}, ${probability}, ${active}) RETURNING *`);
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/spin-wheel/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM spin_wheel_items WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.patch("/api/spin-wheel/:id", requireAdminAuth, async (req, res) => {
    try {
      const { isActive } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE spin_wheel_items SET is_active=${isActive} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/spin-wheel/:id", requireAdminAuth, async (req, res) => {
    try {
      const { label, reward_amount, rewardAmount, reward_type, rewardType, probability, is_active, isActive } = req.body;
      const lbl = label; const rAmt = reward_amount ?? rewardAmount; const rType = reward_type ?? rewardType; const prob = probability; const active = is_active ?? isActive;
      const r = await rawDb.execute(rawSql`UPDATE spin_wheel_items SET label=${lbl}, reward_amount=${rAmt}, reward_type=${rType}, probability=${prob}, is_active=${active} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // User Levels (driver & customer)
  app.get("/api/driver-levels", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM user_levels WHERE user_type='driver' ORDER BY min_points ASC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/driver-levels", requireAdminAuth, async (req, res) => {
    try {
      const { name, minPoints, maxPoints, reward, rewardType, isActive } = req.body;
      const r = await rawDb.execute(rawSql`INSERT INTO user_levels (name, user_type, min_points, max_points, reward, reward_type, is_active) VALUES (${name}, 'driver', ${minPoints}, ${maxPoints}, ${reward}, ${rewardType ?? 'cashback'}, ${isActive ?? true}) RETURNING *`);
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/driver-levels/:id", requireAdminAuth, async (req, res) => {
    try {
      const { name, minPoints, maxPoints, reward, rewardType, isActive } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE user_levels SET name=${name}, min_points=${minPoints}, max_points=${maxPoints}, reward=${reward}, reward_type=${rewardType}, is_active=${isActive} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/driver-levels/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM user_levels WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.get("/api/customer-levels", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM user_levels WHERE user_type='customer' ORDER BY min_points ASC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/customer-levels", requireAdminAuth, async (req, res) => {
    try {
      const { name, minPoints, maxPoints, reward, rewardType, isActive } = req.body;
      const r = await rawDb.execute(rawSql`INSERT INTO user_levels (name, user_type, min_points, max_points, reward, reward_type, is_active) VALUES (${name}, 'customer', ${minPoints}, ${maxPoints}, ${reward}, ${rewardType ?? 'cashback'}, ${isActive ?? true}) RETURNING *`);
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/customer-levels/:id", requireAdminAuth, async (req, res) => {
    try {
      const { name, minPoints, maxPoints, reward, rewardType, isActive } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE user_levels SET name=${name}, min_points=${minPoints}, max_points=${maxPoints}, reward=${reward}, reward_type=${rewardType}, is_active=${isActive} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/customer-levels/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM user_levels WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/user-levels", requireAdminAuth, async (req, res) => {
    try {
      const { name, user_type, min_points, max_points, reward, reward_type, is_active } = req.body;
      const r = await rawDb.execute(rawSql`INSERT INTO user_levels (name, user_type, min_points, max_points, reward, reward_type, is_active) VALUES (${name}, ${user_type}, ${min_points}, ${max_points}, ${reward}, ${reward_type}, ${is_active ?? true}) RETURNING *`);
      res.status(201).json(r.rows[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/user-levels/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM user_levels WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Employees
  app.get("/api/employees", async (req, res) => {
    try {
      const zoneId = req.query.zoneId as string | undefined;
      const r = zoneId
        ? await rawDb.execute(rawSql`SELECT e.*, z.name as zone_name FROM employees e LEFT JOIN zones z ON z.id=e.zone_id WHERE e.zone_id=${zoneId}::uuid ORDER BY e.created_at DESC`)
        : await rawDb.execute(rawSql`SELECT e.*, z.name as zone_name FROM employees e LEFT JOIN zones z ON z.id=e.zone_id ORDER BY e.created_at DESC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/employees", requireAdminAuth, async (req, res) => {
    try {
      const { name, email, phone, role, zoneId, isActive } = req.body;
      const r = zoneId
        ? await rawDb.execute(rawSql`INSERT INTO employees (name, email, phone, role, zone_id, is_active) VALUES (${name}, ${email}, ${phone}, ${role ?? 'employee'}, ${zoneId}::uuid, ${isActive ?? true}) RETURNING *`)
        : await rawDb.execute(rawSql`INSERT INTO employees (name, email, phone, role, is_active) VALUES (${name}, ${email}, ${phone}, ${role ?? 'employee'}, ${isActive ?? true}) RETURNING *`);
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/employees/:id", requireAdminAuth, async (req, res) => {
    try {
      const { name, email, phone, role, zoneId, isActive } = req.body;
      const r = zoneId
        ? await rawDb.execute(rawSql`UPDATE employees SET name=${name}, email=${email}, phone=${phone}, role=${role}, zone_id=${zoneId}::uuid, is_active=${isActive} WHERE id=${req.params.id}::uuid RETURNING *`)
        : await rawDb.execute(rawSql`UPDATE employees SET name=${name}, email=${email}, phone=${phone}, role=${role}, is_active=${isActive} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.patch("/api/employees/:id", requireAdminAuth, async (req, res) => {
    try {
      if (req.body.isActive === undefined && req.body.zoneId === undefined) return res.status(400).json({ message: "Nothing to update" });
      const r = req.body.zoneId !== undefined
        ? await rawDb.execute(rawSql`UPDATE employees SET is_active=${req.body.isActive ?? null}, zone_id=${req.body.zoneId}::uuid WHERE id=${req.params.id}::uuid RETURNING *`)
        : await rawDb.execute(rawSql`UPDATE employees SET is_active=${req.body.isActive ?? null} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/employees/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM employees WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // B2B Companies
  app.get("/api/b2b-companies", requireAdminAuth, async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const r = status
        ? await rawDb.execute(rawSql`SELECT * FROM b2b_companies WHERE status=${status} ORDER BY created_at DESC`)
        : await rawDb.execute(rawSql`SELECT * FROM b2b_companies ORDER BY created_at DESC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/b2b-companies", requireAdminAuth, async (req, res) => {
    try {
      const { companyName, contactPerson, phone, email, gstNumber, address, city, status, commissionPct } = req.body;
      const r = await rawDb.execute(rawSql`INSERT INTO b2b_companies (company_name, contact_person, phone, email, gst_number, address, city, status, commission_pct) VALUES (${companyName}, ${contactPerson}, ${phone}, ${email}, ${gstNumber}, ${address}, ${city}, ${status ?? 'active'}, ${commissionPct ?? 10}) RETURNING *`);
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/b2b-companies/:id", requireAdminAuth, async (req, res) => {
    try {
      const { companyName, contactPerson, phone, email, gstNumber, address, city, status, commissionPct } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE b2b_companies SET company_name=${companyName}, contact_person=${contactPerson}, phone=${phone}, email=${email}, gst_number=${gstNumber}, address=${address}, city=${city}, status=${status}, commission_pct=${commissionPct} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.patch("/api/b2b-companies/:id/wallet", requireAdminAuth, async (req, res) => {
    try {
      const { amount, type } = req.body;
      // -- SECURITY: Validate amount is non-negative and within bounds --
      const validAmount = validateMoneyAmount(amount, 99999999); // Max ?99.9M per transaction
      const validType = validateEnumValue(type, ['credit', 'deduct']);
      const r = validType === "deduct"
        ? await rawDb.execute(rawSql`UPDATE b2b_companies SET wallet_balance = wallet_balance - ${validAmount} WHERE id=${req.params.id}::uuid RETURNING *`)
        : await rawDb.execute(rawSql`UPDATE b2b_companies SET wallet_balance = wallet_balance + ${validAmount} WHERE id=${req.params.id}::uuid RETURNING *`);
      if (!r.rows.length) return res.status(404).json({ message: 'Company not found' });
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(400).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/b2b-companies/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM b2b_companies WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Parcel Categories & Weights
  app.get("/api/parcel-categories", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM parcel_categories ORDER BY created_at DESC`);
      res.json(r.rows);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/parcel-categories", adminDataLimiter, requireAdminAuth, async (req, res) => {
    try {
      const { name, is_active } = req.body;
      // -- SECURITY: Validate name is string, non-empty, and reasonable length --
      const validName = String(name || "").trim();
      if (!validName || validName.length === 0) {
        throw new Error("Category name is required");
      }
      if (validName.length > 255) {
        throw new Error("Category name must be 255 characters or less");
      }
      const r = await rawDb.execute(rawSql`INSERT INTO parcel_categories (name, is_active) VALUES (${validName}, ${is_active ?? true}) RETURNING *`);
      res.status(201).json(r.rows[0]);
    } catch (e: any) { res.status(400).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/parcel-categories/:id", async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM parcel_categories WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.get("/api/parcel-weights", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM parcel_weights ORDER BY min_weight ASC`);
      res.json(r.rows);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/parcel-weights", async (req, res) => {
    try {
      const { label, min_weight, max_weight, is_active } = req.body;
      const r = await rawDb.execute(rawSql`INSERT INTO parcel_weights (label, min_weight, max_weight, is_active) VALUES (${label}, ${min_weight}, ${max_weight}, ${is_active ?? true}) RETURNING *`);
      res.status(201).json(r.rows[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/parcel-weights/:id", async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM parcel_weights WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Vehicle Brands & Models
  app.get("/api/vehicle-brands", async (req, res) => {
    try {
      const { category } = req.query;
      // -- SECURITY: Validate category enum to prevent SQL injection --
      const allowedCategories = ['two_wheeler', 'three_wheeler', 'four_wheeler', 'auto', 'cab', 'parcel'];
      const r = category
        ? await rawDb.execute(rawSql`SELECT * FROM vehicle_brands WHERE is_active=true AND category=${validateEnumValue(String(category), allowedCategories)} ORDER BY name ASC`)
        : await rawDb.execute(rawSql`SELECT * FROM vehicle_brands WHERE is_active=true ORDER BY category, name ASC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(400).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/vehicle-brands", requireAdminAuth, async (req, res) => {
    try {
      const { name, logo_url, category = 'two_wheeler', is_active } = req.body;
      const r = await rawDb.execute(rawSql`INSERT INTO vehicle_brands (name, logo_url, category, is_active) VALUES (${name}, ${logo_url || null}, ${category}, ${is_active ?? true}) RETURNING *`);
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/vehicle-brands/:id", requireAdminAuth, async (req, res) => {
    try {
      const { name, logo_url, category, is_active, isActive } = req.body;
      const active = is_active ?? isActive ?? true;
      const r = await rawDb.execute(rawSql`UPDATE vehicle_brands SET name=${name}, logo_url=${logo_url || null}, category=${category || 'two_wheeler'}, is_active=${active} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/vehicle-brands/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM vehicle_brands WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.get("/api/vehicle-models", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT vm.*, vb.name as brand_name FROM vehicle_models vm LEFT JOIN vehicle_brands vb ON vb.id=vm.brand_id ORDER BY vm.name ASC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/vehicle-models", requireAdminAuth, async (req, res) => {
    try {
      const b = req.body;
      const name = b.name;
      const brand_id = b.brandId ?? b.brand_id ?? null;
      const is_active = b.isActive ?? b.is_active ?? true;
      const r = await rawDb.execute(rawSql`INSERT INTO vehicle_models (name, brand_id, is_active) VALUES (${name}, ${brand_id ? rawSql`${brand_id}::uuid` : rawSql`NULL`}, ${is_active}) RETURNING *`);
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/vehicle-models/:id", requireAdminAuth, async (req, res) => {
    try {
      const b = req.body;
      const name = b.name ?? null;
      const brand_id = b.brandId ?? b.brand_id ?? null;
      const active = b.isActive ?? b.is_active ?? null;
      let r;
      if (brand_id) {
        r = await rawDb.execute(rawSql`UPDATE vehicle_models SET name=COALESCE(${name}, name), brand_id=${brand_id}::uuid, is_active=COALESCE(${active}, is_active) WHERE id=${req.params.id}::uuid RETURNING *`);
      } else {
        r = await rawDb.execute(rawSql`UPDATE vehicle_models SET name=COALESCE(${name}, name), is_active=COALESCE(${active}, is_active) WHERE id=${req.params.id}::uuid RETURNING *`);
      }
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/vehicle-models/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM vehicle_models WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Parcel Fares
  app.get("/api/parcel-fares", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT pf.*, z.name as zone_name FROM parcel_fares pf LEFT JOIN zones z ON z.id::uuid=pf.zone_id ORDER BY pf.created_at DESC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/parcel-fares", requireAdminAuth, async (req, res) => {
    try {
      const { zoneId, baseFare, farePerKm, farePerKg, minimumFare, loadingCharge, helperChargePerHour, maxHelpers } = req.body;
      // -- SECURITY: Validate all numeric fares are non-negative; prevent NaN from parseInt --
      const validBaseFare = validateMoneyAmount(baseFare || 0, 100000);
      const validFarePerKm = validateMoneyAmount(farePerKm || 0, 10000);
      const validFarePerKg = validateMoneyAmount(farePerKg || 0, 10000);
      const validMinFare = validateMoneyAmount(minimumFare || 0, 100000);
      const validLoading = validateMoneyAmount(loadingCharge || 0, 10000);
      const validHelperCharge = validateMoneyAmount(helperChargePerHour || 0, 5000);
      const validMaxHelpers = safeInteger(maxHelpers || 0, 0);
      if (validMaxHelpers < 0) throw new Error("Max helpers cannot be negative");
      const r = await rawDb.execute(rawSql`INSERT INTO parcel_fares (zone_id, base_fare, fare_per_km, fare_per_kg, minimum_fare, loading_charge, helper_charge_per_hour, max_helpers) VALUES (${zoneId}::uuid, ${validBaseFare}, ${validFarePerKm}, ${validFarePerKg}, ${validMinFare}, ${validLoading}, ${validHelperCharge}, ${validMaxHelpers}) RETURNING *`);
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(400).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/parcel-fares/:id", requireAdminAuth, async (req, res) => {
    try {
      const { zoneId, baseFare, farePerKm, farePerKg, minimumFare, loadingCharge, helperChargePerHour, maxHelpers } = req.body;
      // -- SECURITY: Validate all numeric fares are non-negative --
      const validBaseFare = validateMoneyAmount(baseFare || 0, 100000);
      const validFarePerKm = validateMoneyAmount(farePerKm || 0, 10000);
      const validFarePerKg = validateMoneyAmount(farePerKg || 0, 10000);
      const validMinFare = validateMoneyAmount(minimumFare || 0, 100000);
      const validLoading = validateMoneyAmount(loadingCharge || 0, 10000);
      const validHelperCharge = validateMoneyAmount(helperChargePerHour || 0, 5000);
      const validMaxHelpers = safeInteger(maxHelpers || 0, 0);
      if (validMaxHelpers < 0) throw new Error("Max helpers cannot be negative");
      const r = await rawDb.execute(rawSql`UPDATE parcel_fares SET zone_id=${zoneId}::uuid, base_fare=${validBaseFare}, fare_per_km=${validFarePerKm}, fare_per_kg=${validFarePerKg}, minimum_fare=${validMinFare}, loading_charge=${validLoading}, helper_charge_per_hour=${validHelperCharge}, max_helpers=${validMaxHelpers} WHERE id=${req.params.id}::uuid RETURNING *`);
      if (!r.rows.length) return res.status(404).json({ message: 'Parcel fare not found' });
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(400).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/parcel-fares/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM parcel_fares WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Surge Pricing
  app.get("/api/surge-pricing", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT sp.*, z.name as zone_name FROM surge_pricing sp LEFT JOIN zones z ON z.id::uuid=sp.zone_id ORDER BY sp.created_at DESC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/surge-pricing", requireAdminAuth, async (req, res) => {
    try {
      const { zoneId, zone_id, startTime, start_time, endTime, end_time, multiplier, reason, isActive, is_active } = req.body;
      const zid = zoneId || zone_id || null;
      const st = (startTime || start_time || '').trim() || null;
      const et = (endTime || end_time || '').trim() || null;
      const active = isActive ?? is_active ?? true;
      const r = await rawDb.execute(rawSql`INSERT INTO surge_pricing (zone_id, start_time, end_time, multiplier, reason, is_active) VALUES (${zid}, ${st}, ${et}, ${multiplier}, ${reason || null}, ${active}) RETURNING *`);
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/surge-pricing/:id", requireAdminAuth, async (req, res) => {
    try {
      const { zoneId, zone_id, startTime, start_time, endTime, end_time, multiplier, reason, isActive, is_active } = req.body;
      const zid = zoneId || zone_id || null;
      const st = (startTime || start_time || '').trim() || null;
      const et = (endTime || end_time || '').trim() || null;
      const active = isActive ?? is_active ?? true;
      await rawDb.execute(rawSql`UPDATE surge_pricing SET zone_id=${zid}, start_time=${st}, end_time=${et}, multiplier=${multiplier}, reason=${reason || null}, is_active=${active} WHERE id=${req.params.id}::uuid`);
      const r = await rawDb.execute(rawSql`SELECT sp.*, z.name as zone_name FROM surge_pricing sp LEFT JOIN zones z ON z.id::uuid=sp.zone_id WHERE sp.id=${req.params.id}::uuid`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  // PATCH: toggle is_active only � safe partial update (does not wipe other fields)
  app.patch("/api/surge-pricing/:id", requireAdminAuth, async (req, res) => {
    try {
      const { isActive, is_active } = req.body;
      const active = isActive ?? is_active;
      if (active === undefined) return res.status(400).json({ message: "isActive required" });
      const r = await rawDb.execute(rawSql`
        UPDATE surge_pricing SET is_active=${active} WHERE id=${req.params.id}::uuid
        RETURNING *
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Not found" });
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.delete("/api/surge-pricing/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM surge_pricing WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Vehicle Requests
  app.get("/api/vehicle-requests", async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const r = status
        ? await rawDb.execute(rawSql`SELECT vr.*, u.full_name as driver_name, u.phone FROM vehicle_requests vr LEFT JOIN users u ON u.id=vr.driver_id WHERE vr.status=${status} ORDER BY vr.created_at DESC`)
        : await rawDb.execute(rawSql`SELECT vr.*, u.full_name as driver_name, u.phone FROM vehicle_requests vr LEFT JOIN users u ON u.id=vr.driver_id ORDER BY vr.created_at DESC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.patch("/api/vehicle-requests/:id/status", requireAdminAuth, async (req, res) => {
    try {
      const { status } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE vehicle_requests SET status=${status} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(r.rows[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.patch("/api/vehicle-requests/:id", requireAdminAuth, async (req, res) => {
    try {
      const { status } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE vehicle_requests SET status=${status} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(r.rows[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Wallet Bonus
  app.get("/api/wallet-bonus", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM wallet_bonuses ORDER BY created_at DESC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/wallet-bonus", requireAdminAuth, async (req, res) => {
    try {
      const b = req.body;
      const name = b.name;
      const bonus_amount = b.bonusAmount ?? b.bonus_amount ?? null;
      const bonus_type = b.bonusType ?? b.bonus_type ?? "percentage";
      const minimum_add_amount = b.minimumAddAmount ?? b.minimum_add_amount ?? null;
      const max_bonus_amount = b.maxBonusAmount ?? b.max_bonus_amount ?? null;
      const is_active = b.isActive ?? b.is_active ?? true;
      const r = await rawDb.execute(rawSql`INSERT INTO wallet_bonuses (name, bonus_amount, bonus_type, minimum_add_amount, max_bonus_amount, is_active) VALUES (${name}, ${bonus_amount}, ${bonus_type}, ${minimum_add_amount}, ${max_bonus_amount}, ${is_active}) RETURNING *`);
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/wallet-bonus/:id", requireAdminAuth, async (req, res) => {
    try {
      const b = req.body;
      const name = b.name ?? null;
      const bonus_amount = b.bonusAmount ?? b.bonus_amount ?? null;
      const bonus_type = b.bonusType ?? b.bonus_type ?? null;
      const minimum_add_amount = b.minimumAddAmount ?? b.minimum_add_amount ?? null;
      const max_bonus_amount = b.maxBonusAmount ?? b.max_bonus_amount ?? null;
      const is_active = b.isActive ?? b.is_active ?? null;
      const r = await rawDb.execute(rawSql`
        UPDATE wallet_bonuses SET
          name=COALESCE(${name}, name),
          bonus_amount=COALESCE(${bonus_amount}, bonus_amount),
          bonus_type=COALESCE(${bonus_type}, bonus_type),
          minimum_add_amount=COALESCE(${minimum_add_amount}, minimum_add_amount),
          max_bonus_amount=COALESCE(${max_bonus_amount}, max_bonus_amount),
          is_active=COALESCE(${is_active}, is_active)
        WHERE id=${req.params.id}::uuid RETURNING *
      `);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/wallet-bonus/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM wallet_bonuses WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Subscription Plans
  app.get("/api/subscription-plans", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM subscription_plans ORDER BY price ASC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/subscription-plans", requireAdminAuth, async (req, res) => {
    try {
      const { name, price, durationDays, features, isActive, planType, maxRides, maxParcels } = req.body;
      const r = await rawDb.execute(rawSql`INSERT INTO subscription_plans (name, price, duration_days, features, is_active, plan_type, max_rides, max_parcels) VALUES (${name}, ${price}, ${durationDays || 30}, ${features || ''}, ${isActive ?? true}, ${planType || 'both'}, ${maxRides || 0}, ${maxParcels || 0}) RETURNING *`);
      res.status(201).json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/subscription-plans/:id", requireAdminAuth, async (req, res) => {
    try {
      const { name, price, durationDays, features, isActive, planType, maxRides, maxParcels } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE subscription_plans SET name=${name}, price=${price}, duration_days=${durationDays}, features=${features}, is_active=${isActive}, plan_type=${planType || 'both'}, max_rides=${maxRides || 0}, max_parcels=${maxParcels || 0}, updated_at=now() WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.patch("/api/subscription-plans/:id", requireAdminAuth, async (req, res) => {
    try {
      const { isActive } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE subscription_plans SET is_active=${isActive}, updated_at=now() WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/subscription-plans/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM subscription_plans WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Intercity Routes CRUD
  app.get("/api/intercity-routes", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT ir.*, vc.name as vehicle_name FROM intercity_routes ir
        LEFT JOIN vehicle_categories vc ON vc.id = ir.vehicle_category_id
        ORDER BY ir.from_city, ir.to_city
      `);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/intercity-routes", requireAdminAuth, async (req, res) => {
    try {
      const { fromCity, toCity, estimatedKm, baseFare, farePerKm, tollCharges, vehicleCategoryId, isActive } = req.body;
      let r;
      if (vehicleCategoryId) {
        r = await rawDb.execute(rawSql`INSERT INTO intercity_routes (from_city, to_city, estimated_km, base_fare, fare_per_km, toll_charges, vehicle_category_id, is_active) VALUES (${fromCity}, ${toCity}, ${estimatedKm || 0}, ${baseFare || 0}, ${farePerKm || 0}, ${tollCharges || 0}, ${vehicleCategoryId}::uuid, ${isActive ?? true}) RETURNING *`);
      } else {
        r = await rawDb.execute(rawSql`INSERT INTO intercity_routes (from_city, to_city, estimated_km, base_fare, fare_per_km, toll_charges, is_active) VALUES (${fromCity}, ${toCity}, ${estimatedKm || 0}, ${baseFare || 0}, ${farePerKm || 0}, ${tollCharges || 0}, ${isActive ?? true}) RETURNING *`);
      }
      res.status(201).json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/intercity-routes/:id", requireAdminAuth, async (req, res) => {
    try {
      const { fromCity, toCity, estimatedKm, baseFare, farePerKm, tollCharges, vehicleCategoryId, isActive } = req.body;
      let r;
      if (vehicleCategoryId) {
        r = await rawDb.execute(rawSql`UPDATE intercity_routes SET from_city=${fromCity}, to_city=${toCity}, estimated_km=${estimatedKm || 0}, base_fare=${baseFare || 0}, fare_per_km=${farePerKm || 0}, toll_charges=${tollCharges || 0}, vehicle_category_id=${vehicleCategoryId}::uuid, is_active=${isActive} WHERE id=${req.params.id}::uuid RETURNING *`);
      } else {
        r = await rawDb.execute(rawSql`UPDATE intercity_routes SET from_city=${fromCity}, to_city=${toCity}, estimated_km=${estimatedKm || 0}, base_fare=${baseFare || 0}, fare_per_km=${farePerKm || 0}, toll_charges=${tollCharges || 0}, vehicle_category_id=NULL, is_active=${isActive} WHERE id=${req.params.id}::uuid RETURNING *`);
      }
      res.json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.patch("/api/intercity-routes/:id", requireAdminAuth, async (req, res) => {
    try {
      const { isActive } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE intercity_routes SET is_active=${isActive} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/intercity-routes/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM intercity_routes WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Popular Locations CRUD (city-wise)
  app.get("/api/popular-locations", requireAdminAuth, async (req, res) => {
    try {
      const city = String(req.query.city || "").trim();
      const r = city
        ? await rawDb.execute(rawSql`
            SELECT * FROM popular_locations
            WHERE LOWER(city_name) = LOWER(${city})
            ORDER BY is_active DESC, name ASC
          `)
        : await rawDb.execute(rawSql`
            SELECT * FROM popular_locations
            ORDER BY city_name ASC, is_active DESC, name ASC
          `);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/popular-locations", adminDataLimiter, requireAdminAuth, async (req, res) => {
    try {
      const { name, latitude, longitude, cityName, fullAddress, isActive } = req.body || {};
      if (!name || latitude == null || longitude == null || !cityName) {
        return res.status(400).json({ message: "name, latitude, longitude, cityName are required" });
      }
      // -- SECURITY: Validate coordinates within bounds --
      const coords = validateLatLng(latitude, longitude);
      // -- SECURITY: Validate string lengths to prevent buffer issues --
      const validName = String(name || "").trim();
      const validCity = String(cityName || "").trim();
      const validAddress = String(fullAddress || "").trim();
      if (validName.length === 0 || validName.length > 255) throw new Error("Location name must be 1-255 characters");
      if (validCity.length === 0 || validCity.length > 255) throw new Error("City name must be 1-255 characters");
      if (validAddress.length > 2000) throw new Error("Full address must be 2000 characters or less");
      const r = await rawDb.execute(rawSql`
        INSERT INTO popular_locations (name, latitude, longitude, city_name, full_address, is_active)
        VALUES (${validName}, ${coords.lat}, ${coords.lng}, ${validCity}, ${validAddress || null}, ${isActive ?? true})
        RETURNING *
      `);
      res.status(201).json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(400).json({ message: safeErrMsg(e) }); }
  });

  app.put("/api/popular-locations/:id", adminDataLimiter, requireAdminAuth, async (req, res) => {
    try {
      const { name, latitude, longitude, cityName, fullAddress, isActive } = req.body || {};
      // -- SECURITY: Validate optional coordinates if provided --
      let validLat = undefined, validLng = undefined;
      if (latitude != null && longitude != null) {
        const coords = validateLatLng(latitude, longitude);
        validLat = coords.lat;
        validLng = coords.lng;
      }
      // -- SECURITY: Validate string lengths if provided --
      let validName = undefined, validCity = undefined, validAddress = undefined;
      if (name) {
        validName = String(name).trim();
        if (validName.length === 0 || validName.length > 255) throw new Error("Location name must be 1-255 characters");
      }
      if (cityName) {
        validCity = String(cityName).trim();
        if (validCity.length === 0 || validCity.length > 255) throw new Error("City name must be 1-255 characters");
      }
      if (fullAddress) {
        validAddress = String(fullAddress).trim();
        if (validAddress.length > 2000) throw new Error("Full address must be 2000 characters or less");
      }
      const r = await rawDb.execute(rawSql`
        UPDATE popular_locations
        SET
          name = COALESCE(${validName ?? null}, name),
          latitude = COALESCE(${validLat ? validLat : null}, latitude),
          longitude = COALESCE(${validLng ? validLng : null}, longitude),
          city_name = COALESCE(${validCity ?? null}, city_name),
          full_address = COALESCE(${validAddress ?? null}, full_address),
          is_active = COALESCE(${isActive ?? null}, is_active),
          updated_at = NOW()
        WHERE id = ${req.params.id}::uuid
        RETURNING *
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Popular location not found" });
      res.json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(400).json({ message: safeErrMsg(e) }); }
  });

  app.delete("/api/popular-locations/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM popular_locations WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Business settings � bulk update
  app.put("/api/business-settings", requireAdminAuth, async (req, res) => {
    try {
      const settings = req.body as Record<string, string>;
      for (const [key, value] of Object.entries(settings)) {
        await rawDb.execute(rawSql`INSERT INTO business_settings (key_name, value, settings_type) VALUES (${key}, ${String(value)}, 'business_settings') ON CONFLICT (key_name) DO UPDATE SET value=${String(value)}, updated_at=now()`);
      }
      const r = await rawDb.execute(rawSql`SELECT * FROM business_settings ORDER BY settings_type, key_name`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Business Pages � GET by settings_type
  app.get("/api/business-pages", async (req, res) => {
    try {
      const type = (req.query.type as string) || "pages_settings";
      const r = await rawDb.execute(rawSql`SELECT key_name, value, settings_type FROM business_settings WHERE settings_type=${type} ORDER BY key_name`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Business Pages � upsert single setting
  app.post("/api/business-pages", async (req, res) => {
    try {
      const { keyName, value, settingsType } = req.body;
      if (!keyName || value === undefined) return res.status(400).json({ message: "keyName and value required" });
      const type = settingsType || "pages_settings";
      await rawDb.execute(rawSql`INSERT INTO business_settings (key_name, value, settings_type) VALUES (${keyName}, ${String(value)}, ${type}) ON CONFLICT (key_name) DO UPDATE SET value=${String(value)}, updated_at=now()`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin password change
  app.post("/api/admin/change-password", async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) return res.status(400).json({ message: "Current and new passwords required" });
      if (newPassword.length < 8) return res.status(400).json({ message: "New password must be at least 8 characters" });
      const r = await rawDb.execute(rawSql`SELECT id, password FROM admins WHERE role='superadmin' LIMIT 1`);
      if (!r.rows.length) return res.status(404).json({ message: "Admin not found" });
      const admin = r.rows[0] as any;
      const valid = await verifyPassword(String(currentPassword), admin.password);
      if (!valid) return res.status(401).json({ message: "Current password is incorrect" });
      const hash = await hashPassword(String(newPassword));
      await rawDb.execute(rawSql`UPDATE admins SET password=${hash} WHERE id=${admin.id}::uuid`);
      res.json({ success: true, message: "Password changed successfully" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Newsletter subscribers (from existing users table)
  app.get("/api/newsletter", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT id, full_name, email, phone, created_at FROM users WHERE user_type='customer' ORDER BY created_at DESC`);
      res.json(r.rows);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Parcel Refunds (derived from cancelled parcel trips)
  app.get("/api/parcel-refunds", requireAdminAuth, async (req, res) => {
    try {
      const status = req.query.status as string || "all";
      const { data } = await storage.getTrips(undefined, undefined, 1, 500);
      const refunds = data.filter((item: any) => {
        const s = item.trip.currentStatus;
        if (status === "pending") return s === "cancelled" && !item.trip.paymentStatus?.includes("refund");
        if (status === "approved") return s === "cancelled" && item.trip.paymentStatus === "refund_approved";
        if (status === "denied") return s === "cancelled" && item.trip.paymentStatus === "refund_denied";
        if (status === "refunded") return item.trip.paymentStatus === "refunded";
        return s === "cancelled";
      });
      res.json({ data: refunds, total: refunds.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/parcel-refunds/:id/status", requireAdminAuth, async (req, res) => {
    try {
      const { refundStatus } = req.body;
      const payMap: Record<string, string> = {
        approved: "refund_approved",
        denied: "refund_denied",
        refunded: "refunded",
      };
      const paymentStatus = payMap[refundStatus];
      if (!paymentStatus) return res.status(400).json({ message: "Invalid refundStatus" });
      await rawDb.execute(rawSql`
        UPDATE trip_requests SET payment_status=${paymentStatus}, updated_at=NOW()
        WHERE id=${req.params.id}::uuid
      `);
      res.json({ success: true, refundStatus, paymentStatus });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Customer Wallet top-up / deduct (admin operation � adjusts users.wallet_balance)
  app.post("/api/customer-wallet/topup", requireAdminAuth, async (req, res) => {
    try {
      const { userId, amount, type } = req.body;
      if (!userId || !amount) return res.status(400).json({ message: "userId and amount required" });
      const parsedAmount = Number(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ message: "amount must be a positive number" });
      const r = await rawDb.execute(rawSql`
        UPDATE users
        SET wallet_balance = GREATEST(0, wallet_balance + ${type === "deduct" ? -parsedAmount : parsedAmount}),
            updated_at = NOW()
        WHERE id = ${userId}::uuid
        RETURNING wallet_balance
      `);
      if (!(r.rows as any[]).length) return res.status(404).json({ message: "User not found" });
      const newBalance = parseFloat((r.rows as any[])[0].wallet_balance);
      res.json({ success: true, newBalance, type });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Notifications send � broadcasts real FCM push to all matching user devices
  app.post("/api/notifications/send", requireAdminAuth, async (req, res) => {
    try {
      const { target = "all" } = req.body;
      const title = String(req.body?.title || "").trim();
      const message = String(req.body?.message || "").trim();
      const userType = ["all", "customer", "driver"].includes(String(req.body?.userType || "all"))
        ? String(req.body?.userType || "all")
        : "all";
      if (!title || !message) return res.status(400).json({ message: "title and message required" });

      // Fetch FCM tokens for matching active users
      let fcmRows: any[] = [];
      if (target === "all") {
        const devRes = await rawDb.execute(rawSql`
          SELECT DISTINCT ud.fcm_token FROM user_devices ud
          INNER JOIN users u ON u.id = ud.user_id
          WHERE u.is_active = true
            AND ud.fcm_token IS NOT NULL
            AND LENGTH(TRIM(ud.fcm_token)) > 20
            AND (${userType} = 'all' OR u.user_type = ${userType})
        `);
        fcmRows = devRes.rows;
      }

      const recipientCount = fcmRows.length;

      // Fire FCM pushes (non-blocking � best effort)
      let deliveredCount = 0;
      let failedCount = 0;
      if (fcmRows.length > 0) {
        const pushPromises = fcmRows.map(async (r: any) => {
          if (!r.fcm_token) return;
          try {
            const ok = await sendFcmNotification({
              fcmToken: r.fcm_token,
              title,
              body: message,
              data: { type: "broadcast", target, userType },
              channelId: "general_alerts",
              sound: "default",
            });
            if (ok) deliveredCount++;
            else failedCount++;
          } catch (pushErr: any) {
            failedCount++;
            console.warn("[Notification] FCM delivery failed:", pushErr?.message || pushErr);
          }
        });
        await Promise.allSettled(pushPromises);
      }

      const status = recipientCount === 0
        ? "no_devices"
        : deliveredCount > 0 && failedCount > 0
          ? "partial"
          : deliveredCount > 0
            ? "sent"
            : "queued";
      const fcmResult = `devices=${recipientCount}; delivered=${deliveredCount}; failed=${failedCount}`;
      const errorMessage = failedCount > 0
        ? `FCM delivery skipped/failed for ${failedCount} device(s). Notification was still saved in admin history. Refresh app tokens if this repeats.`
        : recipientCount === 0
          ? "No registered FCM devices matched this audience yet."
          : null;

      await rawDb.execute(rawSql`
        INSERT INTO notification_logs (
          title, message, target, user_type, recipient_count, delivered_count,
          status, notification_type, fcm_result, error_message, sent_at
        )
        VALUES (
          ${title}, ${message}, ${target}, ${userType}, ${recipientCount}, ${deliveredCount},
          ${status}, 'broadcast',
          ${fcmResult},
          ${errorMessage},
          NOW()
        )
      `);
      const statusMessage = status === "sent"
        ? "Notification sent"
        : status === "partial"
          ? "Notification sent with partial device delivery"
          : status === "no_devices"
            ? "Notification saved. No registered app devices matched this audience."
            : "Notification saved. Devices will receive it after token refresh.";
      console.log(`[Notification] To=${target}/${userType} Title=${title} Recipients=${recipientCount} Delivered=${deliveredCount} Failed=${failedCount}`);
      res.json({ success: true, message: statusMessage, recipientCount, deliveredCount, failedCount, status, pushWarning: status !== "sent" });
    } catch (e: any) {
      console.error("[Notification] send failed:", e?.message || e);
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // --- Car Sharing APIs --------------------------------------------------------

  // Stats
  app.get("/api/car-sharing/stats", requireAdminAuth, async (req, res) => {
    try {
      const rides = await rawDb.execute(rawSql`SELECT status, COUNT(*) as cnt FROM car_sharing_rides GROUP BY status`);
      const bookings = await rawDb.execute(rawSql`SELECT COUNT(*) as total, COALESCE(SUM(total_fare),0) as revenue FROM car_sharing_bookings WHERE status != 'cancelled'`);
      const seats = await rawDb.execute(rawSql`SELECT COALESCE(SUM(seats_booked),0) as seats_sold, COALESCE(SUM(max_seats),0) as seats_total FROM car_sharing_rides`);
      const statusMap: any = {};
      rides.rows.forEach((r: any) => { statusMap[r.status] = parseInt(r.cnt); });
      const bRow: any = bookings.rows[0] || {};
      const sRow: any = seats.rows[0] || {};
      res.json({
        totalRides: rides.rows.reduce((s: number, r: any) => s + parseInt(r.cnt), 0),
        activeRides: (statusMap.active || 0) + (statusMap.scheduled || 0),
        completedRides: statusMap.completed || 0,
        cancelledRides: statusMap.cancelled || 0,
        totalBookings: parseInt(bRow.total || 0),
        totalRevenue: parseFloat(bRow.revenue || 0),
        seatsSold: parseInt(sRow.seats_sold || 0),
        seatsTotal: parseInt(sRow.seats_total || 0),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Rides list
  app.get("/api/car-sharing/rides", requireAdminAuth, async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT cs.*, 
          u.full_name as driver_name, u.phone as driver_phone,
          vc.name as vehicle_name,
          z.name as zone_name,
          (SELECT COUNT(*) FROM car_sharing_bookings b WHERE b.ride_id = cs.id AND b.status != 'cancelled') as booking_count
        FROM car_sharing_rides cs
        LEFT JOIN users u ON u.id = cs.driver_id
        LEFT JOIN vehicle_categories vc ON vc.id = cs.vehicle_category_id
        LEFT JOIN zones z ON z.id = cs.zone_id
        ORDER BY cs.departure_time DESC
      `);
      res.json({ data: camelize(r.rows), total: r.rows.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Update ride status
  app.patch("/api/car-sharing/rides/:id/status", requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      await rawDb.execute(rawSql`UPDATE car_sharing_rides SET status = ${status} WHERE id = ${id}::uuid`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Bookings list
  app.get("/api/car-sharing/bookings", requireAdminAuth, async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT b.*,
          cu.full_name as customer_name, cu.phone as customer_phone,
          du.full_name as driver_name, du.phone as driver_phone,
          cs.from_location, cs.to_location, cs.departure_time, cs.seat_price,
          vc.name as vehicle_name
        FROM car_sharing_bookings b
        LEFT JOIN car_sharing_rides cs ON cs.id = b.ride_id
        LEFT JOIN users cu ON cu.id = b.customer_id
        LEFT JOIN users du ON du.id = cs.driver_id
        LEFT JOIN vehicle_categories vc ON vc.id = cs.vehicle_category_id
        ORDER BY b.created_at DESC
      `);
      res.json({ data: camelize(r.rows), total: r.rows.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Settings get
  app.get("/api/car-sharing/settings", async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT key_name, value FROM car_sharing_settings ORDER BY key_name`);
      const settings: any = {};
      r.rows.forEach((row: any) => { settings[row.key_name] = row.value; });
      res.json(settings);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Settings save
  app.put("/api/car-sharing/settings", requireAdminAuth, async (req, res) => {
    try {
      const entries = Object.entries(req.body) as [string, string][];
      for (const [key, val] of entries) {
        await rawDb.execute(rawSql`
          INSERT INTO car_sharing_settings (key_name, value) VALUES (${key}, ${String(val)})
          ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `);
      }
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --- Revenue Model Settings --------------------------------------------------

  app.get("/api/revenue-model", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT key_name, value FROM revenue_model_settings ORDER BY key_name`);
      const s: any = {};
      r.rows.forEach((row: any) => { s[row.key_name] = row.value; });
      res.json(s);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.put("/api/revenue-model", requireAdminAuth, async (req, res) => {
    try {
      const entries = Object.entries(req.body) as [string, string][];
      for (const [key, val] of entries) {
        await rawDb.execute(rawSql`
          INSERT INTO revenue_model_settings (key_name, value) VALUES (${key}, ${String(val)})
          ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `);
      }
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --- Module-Based Revenue Config ---------------------------------------------
  // GET /api/app/revenue-config � used by both apps to determine commission/subscription
  app.get("/api/app/revenue-config", authApp, async (_req, res) => {
    try {
      const rows = await rawDb.execute(rawSql`SELECT * FROM service_revenue_config ORDER BY module_name`);
      const config: Record<string, any> = {};
      for (const row of rows.rows) {
        const r = row as any;
        config[r.module_name] = {
          revenueModel: r.revenue_model,
          commissionPercentage: parseFloat(r.commission_percentage),
          commissionGstPercentage: parseFloat(r.commission_gst_percentage),
          subscriptionRequired: r.subscription_required,
          isActive: r.is_active,
        };
      }
      res.json({ config });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // GET /api/admin/module-revenue � admin read all module configs
  app.get("/api/admin/module-revenue", requireAdminAuth, async (_req, res) => {
    try {
      const rows = await rawDb.execute(rawSql`SELECT * FROM service_revenue_config ORDER BY module_name`);
      res.json({ modules: rows.rows.map(camelize) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // PUT /api/admin/module-revenue/:module � admin update one module
  app.put("/api/admin/module-revenue/:module", requireAdminAuth, async (req, res) => {
    try {
      const module = req.params.module as string;
      const ALLOWED = ['ride', 'parcel', 'carpool', 'outstation', 'b2b'];
      if (!ALLOWED.includes(module)) return res.status(400).json({ message: "Invalid module name" });
      const { revenueModel, commissionPercentage, commissionGstPercentage, subscriptionRequired, isActive, notes } = req.body;
      await rawDb.execute(rawSql`
        INSERT INTO service_revenue_config
          (module_name, revenue_model, commission_percentage, commission_gst_percentage, subscription_required, is_active, notes, updated_at)
        VALUES
          (${module}, ${revenueModel || 'commission'}, ${commissionPercentage ?? 15}::numeric, ${commissionGstPercentage ?? 18}::numeric,
           ${subscriptionRequired ?? false}::boolean, ${isActive ?? true}::boolean, ${notes || null}, NOW())
        ON CONFLICT (module_name) DO UPDATE SET
          revenue_model             = EXCLUDED.revenue_model,
          commission_percentage     = EXCLUDED.commission_percentage,
          commission_gst_percentage = EXCLUDED.commission_gst_percentage,
          subscription_required     = EXCLUDED.subscription_required,
          is_active                 = EXCLUDED.is_active,
          notes                     = EXCLUDED.notes,
          updated_at                = NOW()
      `);
      const updated = await rawDb.execute(rawSql`SELECT * FROM service_revenue_config WHERE module_name = ${module} LIMIT 1`);
      res.json(camelize(updated.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --- Admin Revenue Stats -----------------------------------------------------
  app.get("/api/admin-revenue", requireAdminAuth, async (req, res) => {
    try {
      const { from, to, revenueType, page = 1, limit = 50 } = req.query;
      const offset = (Number(page) - 1) * Number(limit);
      let whereClause = rawSql`1=1`;
      if (from) whereClause = rawSql`ar.created_at >= ${from}::date`;
      if (to) whereClause = rawSql`ar.created_at <= ${(to as string) + ' 23:59:59'}::timestamp`;
      if (revenueType) whereClause = rawSql`ar.revenue_type = ${revenueType}`;

      const rows = await rawDb.execute(rawSql`
        SELECT ar.*, u.full_name as driver_name, u.phone as driver_phone
        FROM admin_revenue ar
        LEFT JOIN users u ON u.id = ar.driver_id
        ORDER BY ar.created_at DESC
        LIMIT ${Number(limit)} OFFSET ${offset}
      `);
      const totals = await rawDb.execute(rawSql`
        SELECT
          revenue_type,
          COUNT(*) as count,
          SUM(amount) as total
        FROM admin_revenue
        GROUP BY revenue_type
      `);
      const grandTotal = await rawDb.execute(rawSql`SELECT COALESCE(SUM(amount),0) as total FROM admin_revenue`);
      res.json({
        rows: rows.rows.map(camelize),
        breakdown: totals.rows.map(camelize),
        totalRevenue: parseFloat((grandTotal.rows[0] as any).total || 0),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --- Driver Commission Settlement System ------------------------------------

  // Helper: recalculate total_pending_balance and check auto-lock/unlock
  async function checkAndApplySettlementLock(driverId: string, settings: Record<string, string>) {
    const lockThreshold = parseFloat(settings.commission_lock_threshold || '200');
    const r = await rawDb.execute(rawSql`
      SELECT total_pending_balance, is_locked FROM users WHERE id=${driverId}::uuid LIMIT 1
    `);
    const row: any = r.rows[0] || {};
    const total = parseFloat(row.total_pending_balance ?? '0');
    const isCurrentlyLocked = row.is_locked;
    if (total >= lockThreshold && !isCurrentlyLocked) {
      await rawDb.execute(rawSql`
        UPDATE users SET is_locked=true,
          lock_reason=${'Pending balance ?' + total.toFixed(2) + ' exceeds ?' + lockThreshold + '. Pay to unlock ride access.'},
          locked_at=NOW()
        WHERE id=${driverId}::uuid
      `);
      return { locked: true, autoLocked: true, total };
    }
    if (total < lockThreshold && isCurrentlyLocked) {
      await rawDb.execute(rawSql`UPDATE users SET is_locked=false, lock_reason=NULL, locked_at=NULL WHERE id=${driverId}::uuid`);
      return { locked: false, autoUnlocked: true, total };
    }
    return { locked: isCurrentlyLocked, total };
  }

  // Get all drivers with wallet + pending balance info
  app.get("/api/driver-wallet", requireAdminAuth, async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT u.id, u.full_name, u.phone, u.email, u.user_type,
          u.wallet_balance, u.is_locked, u.lock_reason, u.locked_at,
          u.pending_commission_balance, u.pending_gst_balance, u.total_pending_balance,
          u.lock_threshold, u.pending_payment_amount, u.is_active,
          (SELECT COUNT(*) FROM trip_requests WHERE driver_id = u.id AND current_status='completed') as completed_trips,
          (SELECT COALESCE(SUM(actual_fare),0) FROM trip_requests WHERE driver_id = u.id AND current_status='completed') as gross_earnings
        FROM users u WHERE u.user_type = 'driver'
        ORDER BY u.total_pending_balance DESC
      `);
      res.json({ data: camelize(r.rows), total: r.rows.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Get driver payment history
  app.get("/api/driver-wallet/:id/history", requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const payments = await rawDb.execute(rawSql`
        SELECT * FROM driver_payments WHERE driver_id = ${id}::uuid ORDER BY created_at DESC LIMIT 100
      `);
      const settlements = await rawDb.execute(rawSql`
        SELECT cs.*, tr.ref_id as trip_ref
        FROM commission_settlements cs
        LEFT JOIN trip_requests tr ON tr.id = cs.trip_id
        WHERE cs.driver_id = ${id}::uuid
        ORDER BY cs.created_at DESC LIMIT 100
      `);
      res.json({ payments: camelize(payments.rows), settlements: camelize(settlements.rows) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Deduct platform fee per ride (called after ride completion � legacy endpoint)
  app.post("/api/driver-wallet/:id/deduct", requireAdminAuth, async (req, res) => {
    try {
      const id = String(req.params.id);
      const { amount, description, tripId, gstPortion = 0 } = req.body;
      const parsedAmount = parseFloat(String(amount));
      if (!parsedAmount || parsedAmount <= 0 || parsedAmount > 100000 || isNaN(parsedAmount)) {
        return res.status(400).json({ message: "Invalid amount. Must be between 0.01 and 100000." });
      }
      if (description && String(description).length > 500) {
        return res.status(400).json({ message: "Description too long (max 500 chars)." });
      }
      const settingRows = await rawDb.execute(rawSql`SELECT key_name, value FROM revenue_model_settings`);
      const settings: any = {};
      settingRows.rows.forEach((r: any) => { settings[r.key_name] = r.value; });

      const gstAmt = parseFloat(String(gstPortion)) || 0;
      const commAmt = Math.round((parseFloat(String(amount)) - gstAmt) * 100) / 100;
      const totalAmt = parseFloat(String(amount));

      const balR = await rawDb.execute(rawSql`
        SELECT pending_commission_balance, pending_gst_balance, total_pending_balance, wallet_balance
        FROM users WHERE id=${id}::uuid LIMIT 1
      `);
      if (!balR.rows.length) return res.status(404).json({ message: "Driver not found" });
      // SECURITY: Validate driver exists and has a driver role
      const driverCheck = await rawDb.execute(rawSql`SELECT role FROM users WHERE id=${id}::uuid LIMIT 1`).catch(() => ({ rows: [] as any[] }));
      const driverRole = (driverCheck.rows[0] as any)?.role;
      if (!['driver', 'pilot'].includes(driverRole || '')) return res.status(400).json({ message: "Target user is not a driver" });
      const bal: any = balR.rows[0] || {};
      const prevTotal = parseFloat(bal.total_pending_balance ?? '0') || 0;
      const newCommission = parseFloat(((parseFloat(bal.pending_commission_balance ?? '0') || 0) + commAmt).toFixed(2));
      const newGst = parseFloat(((parseFloat(bal.pending_gst_balance ?? '0') || 0) + gstAmt).toFixed(2));
      const newTotal = parseFloat((prevTotal + totalAmt).toFixed(2));

      const updated = await rawDb.execute(rawSql`
        UPDATE users
        SET wallet_balance = wallet_balance - ${totalAmt},
            pending_commission_balance = ${newCommission},
            pending_gst_balance = ${newGst},
            total_pending_balance = ${newTotal},
            pending_payment_amount = GREATEST(0, -(wallet_balance - ${totalAmt}))
        WHERE id = ${id}::uuid RETURNING wallet_balance, is_locked
      `);
      await rawDb.execute(rawSql`
        INSERT INTO driver_payments (driver_id, amount, payment_type, status, description)
        VALUES (${id}::uuid, ${totalAmt}, 'deduction', 'completed', ${description || 'Platform fee deduction'})
      `).catch(dbCatch("db"));
      await rawDb.execute(rawSql`
        INSERT INTO commission_settlements (driver_id, trip_id, settlement_type, commission_amount, gst_amount, total_amount, direction, balance_before, balance_after, description)
        VALUES (${id}::uuid, ${tripId ? rawSql`${tripId}::uuid` : rawSql`NULL`}, 'commission_debit', ${commAmt}, ${gstAmt}, ${totalAmt}, 'debit', ${prevTotal}, ${newTotal}, ${description || 'Fee deduction'})
      `).catch(dbCatch("db"));

      const lockResult = await checkAndApplySettlementLock(id, settings);
      const newBalance = parseFloat((updated.rows[0] as any)?.wallet_balance || 0);
      res.json({ success: true, newBalance, pendingBalance: newTotal, ...lockResult });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Manual lock / unlock by admin
  app.patch("/api/driver-wallet/:id/lock", requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { lock, reason } = req.body;
      if (lock) {
        await rawDb.execute(rawSql`UPDATE users SET is_locked=true, lock_reason=${reason || 'Locked by admin'}, locked_at=NOW() WHERE id=${id}::uuid`);
      } else {
        await rawDb.execute(rawSql`UPDATE users SET is_locked=false, lock_reason=NULL, locked_at=NULL WHERE id=${id}::uuid`);
      }
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Razorpay: Create payment order for driver commission settlement
  app.post("/api/driver-wallet/:id/create-order", requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { amount } = req.body;
      const parsedOrderAmount = parseFloat(String(amount));
      if (!parsedOrderAmount || parsedOrderAmount <= 0 || parsedOrderAmount > 100000 || isNaN(parsedOrderAmount)) {
        return res.status(400).json({ message: "Invalid amount. Must be between 0.01 and 100000." });
      }
      const keyId = await getConf("RAZORPAY_KEY_ID", "razorpay_key_id");
      const keySecret = await getConf("RAZORPAY_KEY_SECRET", "razorpay_key_secret");
      if (!keyId || !keySecret) {
        return res.status(503).json({ message: "Payment gateway not configured. Add Razorpay keys in Admin ? Configuration." });
      }
      const Razorpay = _require("razorpay");
      const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret, timeout: 15000 });
      const order = await rzp.orders.create({ amount: Math.round(parsedOrderAmount * 100), currency: "INR", receipt: `cs_${Date.now().toString(36)}` });
      await rawDb.execute(rawSql`
        INSERT INTO driver_payments (driver_id, amount, payment_type, razorpay_order_id, status, description)
        VALUES (${id}::uuid, ${parsedOrderAmount}, 'commission_payment', ${order.id}, 'pending', 'Commission settlement via Razorpay')
      `);
      res.json({ order, keyId });
    } catch (e: any) {
      const msg = e.message || e.error?.description || e.error?.reason || JSON.stringify(e).slice(0, 200);
      res.status(500).json({ message: msg });
    }
  });

  // Razorpay: Verify payment + reduce pending balance (partial payment supported)
  app.post("/api/driver-wallet/:id/verify-payment", authApp, requireDriver, async (req, res) => {
    try {
      const { id } = req.params;
      const caller = (req as any).currentUser;
      // SECURITY: Driver can only verify payment for their OWN wallet (prevent cross-driver fraud)
      if (caller.id !== id) return res.status(403).json({ message: "Forbidden: you can only settle your own wallet" });
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) return res.status(400).json({ message: "Missing payment details" });
      // SECURITY: Idempotency � reject if this payment was already processed
      const alreadyDone = await rawDb.execute(rawSql`
        SELECT id FROM commission_settlements WHERE razorpay_payment_id=${razorpayPaymentId} LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      if (alreadyDone.rows.length) return res.status(409).json({ message: "Payment already processed", alreadySettled: true });
      const { keySecret } = await getRazorpayKeys();
      if (!keySecret) return res.status(503).json({ message: "Payment verification not configured � contact support" });
      // Timing-safe HMAC verification
      const expectedSig = crypto.createHmac("sha256", keySecret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
      const sigValid = expectedSig.length === razorpaySignature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSig, "utf8"), Buffer.from(razorpaySignature, "utf8"));
      if (!sigValid) return res.status(400).json({ message: "Invalid payment signature" });

      const settingRows = await rawDb.execute(rawSql`SELECT key_name, value FROM revenue_model_settings`);
      const settings: any = {};
      settingRows.rows.forEach((r: any) => { settings[r.key_name] = r.value; });

      // Fetch current balances before payment
      const balR = await rawDb.execute(rawSql`
        SELECT pending_commission_balance, pending_gst_balance, total_pending_balance, wallet_balance
        FROM users WHERE id=${id}::uuid LIMIT 1
      `);
      const bal: any = balR.rows[0] || {};
      const prevTotal = parseFloat(bal.total_pending_balance ?? '0') || 0;
      const prevCommission = parseFloat(bal.pending_commission_balance ?? '0') || 0;
      const prevGst = parseFloat(bal.pending_gst_balance ?? '0') || 0;
      // Amount from DB � never trust client-sent amount
      const pendingRec = await rawDb.execute(rawSql`
        SELECT amount FROM driver_payments WHERE razorpay_order_id=${razorpayOrderId} AND driver_id=${id}::uuid AND status='pending' LIMIT 1
      `);
      if (!pendingRec.rows.length) return res.status(400).json({ message: "No pending order found for this payment" });
      const paidAmt = parseFloat((pendingRec.rows[0] as any).amount);

      // SECURITY: Atomic mark-as-completed BEFORE crediting wallet
      // Prevents double-processing if this function is called twice for the same payment
      const atomicMark = await rawDb.execute(rawSql`
        UPDATE driver_payments SET status='completed', razorpay_payment_id=${razorpayPaymentId}, verified_at=NOW()
        WHERE razorpay_order_id=${razorpayOrderId} AND driver_id=${id}::uuid AND status='pending'
        RETURNING amount
      `);
      if (!atomicMark.rows.length) return res.status(409).json({ message: "Payment already processed or order not found" });

      // Proportionally reduce commission vs GST using integer paise arithmetic (no float drift)
      const paidPaise = Math.round(paidAmt * 100);
      const totalPaise = Math.round(prevTotal * 100);
      const gstPaise = Math.round(prevGst * 100);
      const commPaise = Math.round(prevCommission * 100);
      const gstRedPaise = Math.min(gstPaise, totalPaise > 0 ? Math.round(paidPaise * gstPaise / totalPaise) : Math.round(paidPaise * 0.05));
      const commRedPaise = Math.min(commPaise, paidPaise - gstRedPaise);
      const gstReduction = gstRedPaise / 100;
      const commReduction = commRedPaise / 100;
      const newTotal = Math.max(0, Math.round((totalPaise - paidPaise)) / 100);
      const newCommission = Math.max(0, Math.round((commPaise - commRedPaise)) / 100);
      const newGst = Math.max(0, Math.round((gstPaise - gstRedPaise)) / 100);

      const updated = await rawDb.execute(rawSql`
        UPDATE users
        SET wallet_balance             = wallet_balance + ${paidAmt},
            pending_commission_balance = ${newCommission},
            pending_gst_balance        = ${newGst},
            total_pending_balance      = ${newTotal},
            pending_payment_amount     = GREATEST(0, pending_payment_amount - ${paidAmt})
        WHERE id = ${id}::uuid
        RETURNING wallet_balance, is_locked, total_pending_balance
      `);
      const updRow: any = updated.rows[0] || {};
      const newWalletBalance = parseFloat(updRow.wallet_balance ?? 0);

      // Auto-unlock check (based on pending threshold)
      const lockThreshold = parseFloat(settings.commission_lock_threshold || '200');
      const wasLocked = updRow.is_locked;
      if (newTotal < lockThreshold && wasLocked) {
        await rawDb.execute(rawSql`UPDATE users SET is_locked=false, lock_reason=NULL, locked_at=NULL WHERE id=${id}::uuid`);
      }

      // Record settlement payment
      await rawDb.execute(rawSql`
        INSERT INTO commission_settlements
          (driver_id, settlement_type, commission_amount, gst_amount, total_amount,
           direction, balance_before, balance_after, payment_method,
           razorpay_order_id, razorpay_payment_id, status, description)
        VALUES
          (${id}::uuid, 'payment_credit', ${commReduction}, ${gstReduction}, ${paidAmt},
           'credit', ${prevTotal}, ${newTotal}, 'razorpay',
           ${razorpayOrderId}, ${razorpayPaymentId}, 'completed',
           ${'Commission payment via Razorpay. Commission: ?' + commReduction.toFixed(2) + ', GST: ?' + gstReduction.toFixed(2)})
      `).catch((e: any) => console.error('[SETTLE-CS]', e.message));
      // driver_payments already marked completed atomically above � no duplicate INSERT needed

      res.json({
        success: true,
        newWalletBalance,
        pendingBalance: newTotal,
        pendingCommission: newCommission,
        pendingGst: newGst,
        autoUnlocked: newTotal < lockThreshold && wasLocked,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin: manually credit pending balance (offline/cash payment to platform)
  app.post("/api/driver-wallet/:id/credit", requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, description } = req.body;
      const parsedCreditAmount = parseFloat(String(amount));
      if (!parsedCreditAmount || parsedCreditAmount <= 0 || parsedCreditAmount > 100000 || isNaN(parsedCreditAmount)) {
        return res.status(400).json({ message: "Invalid amount. Must be between 0.01 and 100000." });
      }
      if (description && String(description).length > 500) {
        return res.status(400).json({ message: "Description too long (max 500 chars)." });
      }
      const settingRows = await rawDb.execute(rawSql`SELECT key_name, value FROM revenue_model_settings`);
      const settings: any = {};
      settingRows.rows.forEach((r: any) => { settings[r.key_name] = r.value; });

      const balR = await rawDb.execute(rawSql`
        SELECT pending_commission_balance, pending_gst_balance, total_pending_balance
        FROM users WHERE id=${id}::uuid LIMIT 1
      `);
      const bal: any = balR.rows[0] || {};
      const prevTotal = parseFloat(bal.total_pending_balance ?? '0') || 0;
      const prevCommission = parseFloat(bal.pending_commission_balance ?? '0') || 0;
      const prevGst = parseFloat(bal.pending_gst_balance ?? '0') || 0;
      const paidAmt = parseFloat(String(amount));

      const gstReduction = Math.min(prevGst, paidAmt * (prevTotal > 0 ? prevGst / prevTotal : 0.05));
      const commReduction = Math.min(prevCommission, paidAmt - gstReduction);
      const newTotal = Math.max(0, parseFloat((prevTotal - paidAmt).toFixed(2)));
      const newCommission = Math.max(0, parseFloat((prevCommission - commReduction).toFixed(2)));
      const newGst = Math.max(0, parseFloat((prevGst - gstReduction).toFixed(2)));

      const updated = await rawDb.execute(rawSql`
        UPDATE users
        SET wallet_balance             = wallet_balance + ${paidAmt},
            pending_commission_balance = ${newCommission},
            pending_gst_balance        = ${newGst},
            total_pending_balance      = ${newTotal},
            pending_payment_amount     = GREATEST(0, pending_payment_amount - ${paidAmt})
        WHERE id = ${id}::uuid
        RETURNING wallet_balance, is_locked, total_pending_balance
      `);
      const updRow: any = updated.rows[0] || {};
      const lockThreshold = parseFloat(settings.commission_lock_threshold || '200');
      const wasLocked = updRow.is_locked;
      if (newTotal < lockThreshold && wasLocked) {
        await rawDb.execute(rawSql`UPDATE users SET is_locked=false, lock_reason=NULL, locked_at=NULL WHERE id=${id}::uuid`);
      }
      await rawDb.execute(rawSql`
        INSERT INTO commission_settlements
          (driver_id, settlement_type, commission_amount, gst_amount, total_amount,
           direction, balance_before, balance_after, payment_method, status, description)
        VALUES
          (${id}::uuid, 'manual_credit', ${commReduction}, ${gstReduction}, ${paidAmt},
           'credit', ${prevTotal}, ${newTotal}, 'cash',
           'completed', ${description || 'Manual payment received by admin'})
      `).catch(dbCatch("db"));
      await rawDb.execute(rawSql`
        INSERT INTO driver_payments (driver_id, amount, payment_type, status, description)
        VALUES (${id}::uuid, ${paidAmt}, 'manual_credit', 'completed', ${description || 'Manual credit by admin'})
      `).catch(dbCatch("db"));
      res.json({
        success: true,
        newBalance: parseFloat(updRow.wallet_balance ?? 0),
        pendingBalance: newTotal,
        pendingCommission: newCommission,
        pendingGst: newGst,
        autoUnlocked: newTotal < lockThreshold && wasLocked,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --- Refund Requests ---------------------------------------------------------

  app.get("/api/refund-requests", requireAdminAuth, async (req, res) => {
    try {
      const status = req.query.status as string;
      const r = await rawDb.execute(rawSql`
        SELECT rr.*, u.full_name as customer_name, u.phone as customer_phone,
          tr.ref_id as trip_ref, tr.actual_fare as trip_fare, tr.trip_type
        FROM refund_requests rr
        LEFT JOIN users u ON u.id = rr.customer_id
        LEFT JOIN trip_requests tr ON tr.id = rr.trip_id
        ${status && status !== 'all' ? rawSql`WHERE rr.status = ${status}` : rawSql``}
        ORDER BY rr.created_at DESC
      `);
      res.json({ data: camelize(r.rows), total: r.rows.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/refund-requests", requireAdminAuth, async (req, res) => {
    try {
      const { customerId, tripId, amount, reason, paymentMethod } = req.body;
      const r = tripId
        ? await rawDb.execute(rawSql`INSERT INTO refund_requests (customer_id, trip_id, amount, reason, payment_method) VALUES (${customerId}::uuid, ${tripId}::uuid, ${amount}, ${reason}, ${paymentMethod || 'wallet'}) RETURNING *`)
        : await rawDb.execute(rawSql`INSERT INTO refund_requests (customer_id, amount, reason, payment_method) VALUES (${customerId}::uuid, ${amount}, ${reason}, ${paymentMethod || 'wallet'}) RETURNING *`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/refund-requests/:id", requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { status, adminNote, approvedBy } = req.body;
      if (!['approved', 'denied', 'pending'].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      // SECURITY: Atomic transition � only approve if currently 'pending' to prevent double-credit.
      // If admin clicks approve twice, second request finds status!='pending' and returns 0 rows ? 409.
      const whereClause = status === 'approved'
        ? rawSql`WHERE id=${id}::uuid AND status='pending'`   // guard: can only approve once
        : rawSql`WHERE id=${id}::uuid AND status != 'approved'`; // can update pending/denied freely
      const r = await rawDb.execute(rawSql`
        UPDATE refund_requests
        SET status=${status}, admin_note=${adminNote || ''}, approved_by=${approvedBy || 'Admin'},
            approved_at=${status !== 'pending' ? rawSql`NOW()` : rawSql`NULL`}
        ${whereClause}
        RETURNING *
      `);
      if (!r.rows.length) return res.status(409).json({ message: "Refund already processed or not found" });
      // Credit wallet only on first-time approval (guaranteed by atomic WHERE above)
      if (status === 'approved') {
        const refund: any = r.rows[0];
        if (refund?.customer_id && refund?.amount) {
          const refundAmt = Math.round(parseFloat(refund.amount) * 100) / 100;
          await rawDb.execute(rawSql`UPDATE users SET wallet_balance = wallet_balance + ${refundAmt} WHERE id=${refund.customer_id}::uuid`);
          const newBalRes = await rawDb.execute(rawSql`SELECT wallet_balance FROM users WHERE id=${refund.customer_id}::uuid`);
          const newBal = Math.round(parseFloat((newBalRes.rows[0] as any)?.wallet_balance || '0') * 100) / 100;
          await rawDb.execute(rawSql`
            INSERT INTO transactions (user_id, account, credit, debit, balance, transaction_type, ref_transaction_id)
            VALUES (${refund.customer_id}::uuid, ${'Admin approved refund'}, ${refundAmt}, 0, ${newBal}, ${'admin_refund'}, ${id})
            ON CONFLICT (ref_transaction_id, transaction_type) WHERE ref_transaction_id IS NOT NULL DO NOTHING
          `).catch((e: any) => console.error('[REFUND-APPROVE-TX]', e.message));
          console.log(`[REFUND-APPROVED] ?${refundAmt} credited to customer ${refund.customer_id}, refund ${id}`);
        }
      }
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: Initiate Razorpay refund (calls Razorpay API) --------------------
  app.post("/api/admin/razorpay-refund", requireAdminAuth, async (req, res) => {
    try {
      const { paymentId, amount, tripId, customerId, reason } = req.body;
      if (!paymentId) return res.status(400).json({ message: "Razorpay paymentId is required" });
      const amt = parseFloat(amount);
      if (!amt || amt <= 0 || amt > 50000) return res.status(400).json({ message: "Invalid refund amount" });
      const { keyId, keySecret } = await getRazorpayKeys();
      if (!keyId || !keySecret) return res.status(503).json({ message: "Payment gateway not configured" });
      const Razorpay = _require("razorpay");
      const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret, timeout: 15000 });
      const refundResult = await rzp.payments.refund(paymentId, {
        amount: Math.round(amt * 100),
        speed: "normal",
        notes: { reason: reason || "Admin initiated refund", trip_id: tripId || "", customer_id: customerId || "" },
      });
      // Log the refund initiation
      console.log(`[ADMIN-REFUND] Initiated Razorpay refund: ${refundResult.id} for payment ${paymentId}, ?${amt}`);
      // Create a refund request record if customerId provided
      if (customerId) {
        await rawDb.execute(rawSql`
          INSERT INTO refund_requests (customer_id, trip_id, amount, reason, payment_method, status, admin_note, approved_by, approved_at)
          VALUES (${customerId}::uuid, ${tripId || null}::uuid, ${amt}, ${reason || 'Razorpay refund'}, 'razorpay', 'approved',
                  ${'Razorpay refund ID: ' + refundResult.id}, 'Admin', NOW())
          ON CONFLICT DO NOTHING
        `).catch(dbCatch("db"));
      }
      res.json({ success: true, refund: refundResult });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --- Intercity Car Sharing ----------------------------------------------------

  // Settings CRUD
  app.get("/api/intercity-cs/settings", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT key_name, value FROM intercity_cs_settings ORDER BY key_name`);
      const obj: any = {};
      r.rows.forEach((row: any) => { obj[row.key_name] = row.value; });
      res.json(obj);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.put("/api/intercity-cs/settings", async (req, res) => {
    try {
      for (const [key, val] of Object.entries(req.body)) {
        await rawDb.execute(rawSql`
          INSERT INTO intercity_cs_settings (key_name, value) VALUES (${key}, ${String(val)})
          ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `);
      }
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Rides list (admin view)
  app.get("/api/intercity-cs/rides", async (req, res) => {
    try {
      const status = req.query.status as string;
      const r = await rawDb.execute(rawSql`
        SELECT r.*,
          u.full_name as driver_name, u.phone as driver_phone,
          (SELECT COUNT(*) FROM intercity_cs_bookings b WHERE b.ride_id = r.id AND b.status != 'cancelled') as confirmed_bookings,
          (SELECT COALESCE(SUM(b.total_fare),0) FROM intercity_cs_bookings b WHERE b.ride_id = r.id AND b.payment_status = 'paid') as total_revenue
        FROM intercity_cs_rides r
        LEFT JOIN users u ON u.id = r.driver_id
        ${status && status !== 'all' ? rawSql`WHERE r.status = ${status}` : rawSql``}
        ORDER BY r.departure_date ASC, r.departure_time ASC
      `);
      res.json({ data: camelize(r.rows), total: r.rows.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Create ride (driver action / admin can create too)
  app.post("/api/intercity-cs/rides", async (req, res) => {
    try {
      const { driverId, fromCity, toCity, routeKm, departureDate, departureTime, totalSeats, vehicleNumber, vehicleModel, note, farePerSeat } = req.body;
      // Calculate fare from settings
      const settingsR = await rawDb.execute(rawSql`SELECT key_name, value FROM intercity_cs_settings`);
      const s: any = {};
      settingsR.rows.forEach((r: any) => { s[r.key_name] = parseFloat(r.value); });
      const routeKmNum = parseFloat(routeKm || 0);
      const farePerSeatNum = parseFloat(farePerSeat || 0) > 0
        ? parseFloat(farePerSeat)
        : (routeKmNum * (s.rate_per_km_per_seat || 3.5));
      const r = await rawDb.execute(rawSql`
        INSERT INTO intercity_cs_rides (driver_id, from_city, to_city, route_km, departure_date, departure_time, total_seats, vehicle_number, vehicle_model, note, fare_per_seat)
        VALUES (${driverId}::uuid, ${fromCity}, ${toCity}, ${routeKmNum}, ${departureDate}, ${departureTime}, ${totalSeats}, ${vehicleNumber || ''}, ${vehicleModel || ''}, ${note || ''}, ${farePerSeatNum})
        RETURNING *
      `);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Toggle ride active/inactive
  app.patch("/api/intercity-cs/rides/:id/toggle", async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;
      await rawDb.execute(rawSql`UPDATE intercity_cs_rides SET is_active=${isActive} WHERE id=${id}::uuid`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Update ride status
  app.patch("/api/intercity-cs/rides/:id/status", async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      await rawDb.execute(rawSql`UPDATE intercity_cs_rides SET status=${status} WHERE id=${id}::uuid`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Bookings list (admin view)
  app.get("/api/intercity-cs/bookings", async (req, res) => {
    try {
      const status = req.query.status as string;
      const r = await rawDb.execute(rawSql`
        SELECT b.*,
          u.full_name as customer_name, u.phone as customer_phone,
          r.from_city, r.to_city, r.departure_date, r.departure_time,
          d.full_name as driver_name
        FROM intercity_cs_bookings b
        LEFT JOIN users u ON u.id = b.customer_id
        LEFT JOIN intercity_cs_rides r ON r.id = b.ride_id
        LEFT JOIN users d ON d.id = r.driver_id
        ${status && status !== 'all' ? rawSql`WHERE b.status = ${status}` : rawSql``}
        ORDER BY b.created_at DESC
      `);
      res.json({ data: camelize(r.rows), total: r.rows.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- OUTSTATION POOL --------------------------------------------------------
  // Driver: post a city-to-city ride, list own rides
  app.post("/api/app/driver/outstation-pool/rides", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { fromCity, toCity, routeKm, departureDate, departureTime, totalSeats, vehicleNumber, vehicleModel, farePerSeat, note } = req.body;
      if (!fromCity || !toCity) return res.status(400).json({ message: "fromCity and toCity are required" });

      const r = await rawDb.execute(rawSql`
        INSERT INTO outstation_pool_rides
          (driver_id, from_city, to_city, route_km, departure_date, departure_time,
           total_seats, available_seats, vehicle_number, vehicle_model, fare_per_seat, note)
        VALUES
          (${driver.id}::uuid, ${fromCity}, ${toCity},
           ${parseFloat(routeKm) || 0}, ${departureDate || null}, ${departureTime || null},
           ${parseInt(totalSeats) || 4}, ${parseInt(totalSeats) || 4},
           ${vehicleNumber || null}, ${vehicleModel || null},
           ${parseFloat(farePerSeat) || 0}, ${note || null})
        RETURNING *
      `);
      res.json({ success: true, ride: camelize(r.rows[0]) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/app/driver/outstation-pool/rides", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT opr.*,
          COUNT(opb.id) as total_bookings,
          COALESCE(SUM(opb.total_fare), 0) as total_fare_collected
        FROM outstation_pool_rides opr
        LEFT JOIN outstation_pool_bookings opb ON opb.ride_id = opr.id AND opb.status != 'cancelled'
        WHERE opr.driver_id = ${driver.id}::uuid
        GROUP BY opr.id
        ORDER BY opr.created_at DESC
      `);
      res.json({ data: camelize(r.rows) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/app/driver/outstation-pool/rides/:id", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { id } = req.params;
      const { status, isActive, farePerSeat, note } = req.body;
      await rawDb.execute(rawSql`
        UPDATE outstation_pool_rides
        SET
          status     = COALESCE(${status || null}, status),
          is_active  = COALESCE(${isActive != null ? isActive : null}, is_active),
          fare_per_seat = COALESCE(${farePerSeat != null ? parseFloat(farePerSeat) : null}, fare_per_seat),
          note       = COALESCE(${note || null}, note),
          updated_at = NOW()
        WHERE id = ${id}::uuid AND driver_id = ${driver.id}::uuid
      `);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Driver: Complete outstation pool ride with revenue settlement
  app.post("/api/app/driver/outstation-pool/rides/:id/complete", authApp, async (req, res) => {
    let previousRideStatus = "scheduled";
    try {
      const driver = (req as any).currentUser;
      const { id } = req.params;

      // Claim completion first so duplicate requests cannot settle revenue twice.
      const rideR = await rawDb.execute(rawSql`
        WITH target AS (
          SELECT id, status
          FROM outstation_pool_rides
          WHERE id=${id}::uuid
            AND driver_id=${driver.id}::uuid
            AND status NOT IN ('completed', 'completing')
          LIMIT 1
        )
        UPDATE outstation_pool_rides opr
        SET status='completing', updated_at=NOW()
        FROM target
        WHERE opr.id = target.id
        RETURNING opr.*, target.status AS previous_status
      `);
      if (!rideR.rows.length) {
        const existingR = await rawDb.execute(rawSql`
          SELECT status FROM outstation_pool_rides WHERE id=${id}::uuid AND driver_id=${driver.id}::uuid LIMIT 1
        `).catch(() => ({ rows: [] as any[] }));
        const existing = existingR.rows[0] as any;
        if (!existing) return res.status(404).json({ message: "Ride not found" });
        return res.status(409).json({ message: existing.status === "completed" ? "Ride already completed" : "Ride completion is already in progress" });
      }
      const ride = rideR.rows[0] as any;
      previousRideStatus = String(ride.previous_status || "scheduled");

      const bookingsR = await rawDb.execute(rawSql`
        SELECT * FROM outstation_pool_bookings WHERE ride_id=${id}::uuid AND status='confirmed'
      `);
      const bookings = bookingsR.rows as any[];
      const totalRevenue = bookings.reduce((sum: number, b: any) => sum + parseFloat(b.total_fare || 0), 0);

      // Calculate revenue: commission% + GST + insurance ? admin
      const breakdown = await calculateRevenueBreakdown(totalRevenue, "outstation_pool", driver.id);

      // Settle revenue (driver wallet + admin revenue + GST wallet)
      const settlement = await settleRevenue({
        driverId: driver.id,
        tripId: String(id),
        fare: totalRevenue,
        paymentMethod: "cash",
        breakdown,
        serviceCategory: "outstation_pool",
        serviceLabel: "outstation_pool",
      });

      // Update ride status
      await rawDb.execute(rawSql`
        UPDATE outstation_pool_rides SET status='completed', is_active=false, updated_at=NOW()
        WHERE id=${id}::uuid
      `);

      // Update all bookings with revenue breakdown
      for (const b of bookings) {
        const bFare = parseFloat(b.total_fare || 0);
        const bBreakdown = await calculateRevenueBreakdown(bFare, "outstation_pool", driver.id);
        await rawDb.execute(rawSql`
          UPDATE outstation_pool_bookings
          SET status='completed', payment_status='paid',
              commission_amount=${bBreakdown.total},
              gst_amount=${bBreakdown.gst},
              insurance_amount=${bBreakdown.insurance},
              driver_earnings=${bBreakdown.driverEarnings},
              revenue_model=${bBreakdown.model},
              revenue_breakdown=${JSON.stringify(bBreakdown)}::jsonb,
              updated_at=NOW()
          WHERE id=${b.id}::uuid
        `).catch(dbCatch("db"));
      }

      res.json({
        success: true,
        totalRevenue,
        breakdown,
        driverEarnings: breakdown.driverEarnings,
        walletBalance: settlement.newWalletBalance,
        totalBookings: bookings.length,
      });
    } catch (e: any) {
      const { id } = req.params;
      const driver = (req as any).currentUser;
      await rawDb.execute(rawSql`
        UPDATE outstation_pool_rides
        SET status=${previousRideStatus}, updated_at=NOW()
        WHERE id=${id}::uuid AND driver_id=${driver?.id || null}::uuid AND status='completing'
      `).catch(dbCatch("db"));
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // Customer: search outstation pool rides
  app.get("/api/app/customer/outstation-pool/search", authApp, async (req, res) => {
    try {
      const { fromCity, toCity, date } = req.query as any;
      if (!fromCity || !toCity) return res.status(400).json({ message: "fromCity and toCity are required" });

      const r = await rawDb.execute(rawSql`
        SELECT opr.*,
          u.full_name as driver_name, u.phone as driver_phone,
          dd.avg_rating as driver_rating, dd.total_trips
        FROM outstation_pool_rides opr
        LEFT JOIN users u ON u.id = opr.driver_id
        LEFT JOIN driver_details dd ON dd.user_id = opr.driver_id
        WHERE LOWER(opr.from_city) LIKE ${`%${fromCity.toLowerCase()}%`}
          AND LOWER(opr.to_city) LIKE ${`%${toCity.toLowerCase()}%`}
          AND opr.is_active = true
          AND opr.status = 'scheduled'
          AND opr.available_seats > 0
          ${date ? rawSql`AND opr.departure_date = ${date}::date` : rawSql``}
        ORDER BY opr.departure_date ASC, opr.fare_per_seat ASC
      `);
      res.json({ data: camelize(r.rows), total: r.rows.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Customer: book seats in outstation pool ride
  app.post("/api/app/customer/outstation-pool/book", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { rideId, seatsBooked = 1, pickupAddress, dropoffAddress, paymentMethod = 'cash' } = req.body;
      if (!rideId) return res.status(400).json({ message: "rideId is required" });

      const seats = clampSeatRequest(seatsBooked);

      const bookingRes = await rawDb.execute(rawSql`
        WITH ride_claim AS (
          UPDATE outstation_pool_rides
          SET available_seats = available_seats - ${seats},
              updated_at = NOW()
          WHERE id = ${rideId}::uuid
            AND is_active = true
            AND status = 'scheduled'
            AND available_seats >= ${seats}
          RETURNING id, from_city, to_city, fare_per_seat, available_seats
        ),
        booking AS (
          INSERT INTO outstation_pool_bookings
            (ride_id, customer_id, seats_booked, total_fare, from_city, to_city,
             pickup_address, dropoff_address, payment_method, status, payment_status)
          SELECT
            rc.id,
            ${customer.id}::uuid,
            ${seats},
            ROUND((COALESCE(rc.fare_per_seat, 0)::numeric * ${seats}), 2),
            rc.from_city,
            rc.to_city,
            ${pickupAddress || null},
            ${dropoffAddress || null},
            ${paymentMethod},
            'confirmed',
            'pending'
          FROM ride_claim rc
          RETURNING *
        )
        SELECT * FROM booking
      `);
      if (!bookingRes.rows.length) {
        const rideRes = await rawDb.execute(rawSql`
          SELECT available_seats, status, is_active
          FROM outstation_pool_rides
          WHERE id = ${rideId}::uuid
          LIMIT 1
        `).catch(() => ({ rows: [] as any[] }));
        const ride = rideRes.rows[0] as any;
        if (!ride || ride.is_active === false || ride.status !== "scheduled") {
          return res.status(404).json({ message: "Ride not found or no longer available" });
        }
        return res.status(409).json({ message: "Not enough seats available", available: ride.available_seats });
      }
      res.json({ success: true, booking: camelize(bookingRes.rows[0]) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/app/customer/outstation-pool/bookings", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT opb.*,
          opr.departure_date, opr.departure_time, opr.vehicle_number, opr.vehicle_model,
          u.full_name as driver_name, u.phone as driver_phone
        FROM outstation_pool_bookings opb
        LEFT JOIN outstation_pool_rides opr ON opr.id = opb.ride_id
        LEFT JOIN users u ON u.id = opr.driver_id
        WHERE opb.customer_id = ${customer.id}::uuid
        ORDER BY opb.created_at DESC
      `);
      res.json({ data: camelize(r.rows) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin: manage outstation pool
  app.get("/api/admin/outstation-pool/rides", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT opr.*,
          u.full_name as driver_name, u.phone as driver_phone,
          COUNT(opb.id)::int as total_bookings,
          COALESCE(SUM(opb.total_fare), 0) as total_revenue
        FROM outstation_pool_rides opr
        LEFT JOIN users u ON u.id = opr.driver_id
        LEFT JOIN outstation_pool_bookings opb ON opb.ride_id = opr.id AND opb.status != 'cancelled'
        GROUP BY opr.id, u.full_name, u.phone
        ORDER BY opr.created_at DESC
      `);
      res.json({ data: camelize(r.rows), total: r.rows.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/outstation-pool/bookings", requireAdminAuth, async (req, res) => {
    try {
      const status = req.query.status as string;
      const r = await rawDb.execute(rawSql`
        SELECT opb.*,
          u.full_name as customer_name, u.phone as customer_phone,
          d.full_name as driver_name
        FROM outstation_pool_bookings opb
        LEFT JOIN users u ON u.id = opb.customer_id
        LEFT JOIN outstation_pool_rides opr ON opr.id = opb.ride_id
        LEFT JOIN users d ON d.id = opr.driver_id
        ${status && status !== 'all' ? rawSql`WHERE opb.status = ${status}` : rawSql``}
        ORDER BY opb.created_at DESC
      `);
      res.json({ data: camelize(r.rows), total: r.rows.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/admin/outstation-pool/settings", requireAdminAuth, requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const { mode } = req.body; // 'on' | 'off'
      if (!['on', 'off'].includes(mode)) return res.status(400).json({ message: "mode must be 'on' or 'off'" });
      await rawDb.execute(rawSql`
        INSERT INTO revenue_model_settings (key_name, value)
        VALUES ('outstation_pool_mode', ${mode})
        ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `);
      res.json({ success: true, outstation_pool_mode: mode });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // GET all revenue model settings as a flat key-value map
  app.get("/api/admin/revenue/settings", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT key_name, value FROM revenue_model_settings ORDER BY key_name`);
      const obj: Record<string, string> = {};
      r.rows.forEach((row: any) => { obj[row.key_name] = row.value; });
      res.json(obj);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Call Logs � real data from call_logs table
  app.get("/api/call-logs", async (req, res) => {
    try {
      const status = (req.query.status as string) || "all";
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Number(req.query.limit) || 50);
      const offset = (page - 1) * limit;

      const r = await rawDb.execute(rawSql`
        SELECT cl.*,
          tr.ref_id, tr.trip_type, tr.current_status as trip_status
        FROM call_logs cl
        LEFT JOIN trip_requests tr ON tr.id = cl.trip_id
        ${status !== "all" ? rawSql`WHERE cl.status = ${status}` : rawSql``}
        ORDER BY cl.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      const countR = await rawDb.execute(rawSql`
        SELECT COUNT(*) as total FROM call_logs
        ${status !== "all" ? rawSql`WHERE status = ${status}` : rawSql``}
      `);
      res.json({ data: r.rows.map(camelize), total: Number((countR.rows[0] as any).total) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Record a call log entry (called by mobile app when a call is placed)
  app.post("/api/call-logs", async (req, res) => {
    try {
      const { tripId, callerId, callerName, callerPhone, callerType, calleeId, calleeName, calleePhone, calleeType, callType, status, durationSeconds } = req.body;
      const r = await rawDb.execute(rawSql`
        INSERT INTO call_logs (trip_id, caller_id, caller_name, caller_phone, caller_type, callee_id, callee_name, callee_phone, callee_type, call_type, status, duration_seconds)
        VALUES (${tripId || null}, ${callerId || null}, ${callerName || ''}, ${callerPhone || ''}, ${callerType || 'customer'}, ${calleeId || null}, ${calleeName || ''}, ${calleePhone || ''}, ${calleeType || 'driver'}, ${callType || 'customer_to_driver'}, ${status || 'answered'}, ${durationSeconds || 0})
        RETURNING *
      `);
      res.json({ success: true, data: camelize(r.rows[0]) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Support Chat (Admin ? User) --------------------------------------------
  app.get('/api/support-chat', async (req, res) => {
    try {
      const userId = req.query.userId as string;
      if (!userId) return res.status(400).json({ message: 'userId required' });
      const r = await rawDb.execute(rawSql`
        SELECT sm.*, u.full_name, u.user_type FROM support_messages sm
        LEFT JOIN users u ON u.id = sm.user_id
        WHERE sm.user_id=${userId}::uuid
        ORDER BY sm.created_at ASC LIMIT 100
      `);
      // Mark as read
      await rawDb.execute(rawSql`UPDATE support_messages SET is_read=true WHERE user_id=${userId}::uuid AND sender='user'`);
      res.json({ messages: r.rows.map(camelize) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post('/api/support-chat', async (req, res) => {
    try {
      const { userId, message, sender = 'admin' } = req.body;
      if (!userId || !message) return res.status(400).json({ message: 'userId and message required' });
      const r = await rawDb.execute(rawSql`
        INSERT INTO support_messages (user_id, sender, message)
        VALUES (${userId}::uuid, ${sender}, ${message}) RETURNING *
      `);
      res.json({ success: true, data: camelize(r.rows[0]) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get('/api/support-chat/unread-count', async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT user_id, COUNT(*) as unread
        FROM support_messages WHERE sender='user' AND is_read=false
        GROUP BY user_id
      `);
      res.json({ unreadByUser: r.rows.map(camelize) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Static uploads ----------------------------------------------------------
  const express = (await import("express")).default;
  app.use("/uploads", express.static(path.join(process.cwd(), "public", "uploads")));

  // -- File upload (requires admin or app auth) --------------------------------
  app.post("/api/upload", (req, res, next) => {
    // Allow either admin auth or app auth
    const authHeader = req.headers.authorization || "";
    if (!authHeader) return res.status(401).json({ message: "Authentication required" });
    next();
  }, upload.single("file"), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const url = `/uploads/${req.file.filename}`;
      res.json({ url, filename: req.file.filename, originalname: req.file.originalname, size: req.file.size });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Driver verification -----------------------------------------------------
  app.patch("/api/drivers/:id/verify", requireAdminAuth, async (req, res) => {
    try {
      const { status, note, licenseNumber, vehicleNumber, vehicleModel } = req.body;
      const updateData: any = { verificationStatus: status };
      if (note) updateData.rejectionNote = note;
      if (licenseNumber) updateData.licenseNumber = licenseNumber;
      if (vehicleNumber) updateData.vehicleNumber = vehicleNumber;
      if (vehicleModel) updateData.vehicleModel = vehicleModel;
      if (status === "approved") updateData.isActive = true;
      await storage.updateUser(String(req.params.id), updateData);
      res.json({ success: true, status });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/drivers/:id/documents", authApp, async (req, res) => {
    try {
      const { licenseImage, vehicleImage, profileImage, licenseNumber, vehicleNumber, vehicleModel } = req.body;
      const updateData: any = {};
      if (licenseImage !== undefined) updateData.licenseImage = licenseImage;
      if (vehicleImage !== undefined) updateData.vehicleImage = vehicleImage;
      if (profileImage !== undefined) updateData.profileImage = profileImage;
      if (licenseNumber !== undefined) updateData.licenseNumber = licenseNumber;
      if (vehicleNumber !== undefined) updateData.vehicleNumber = vehicleNumber;
      if (vehicleModel !== undefined) updateData.vehicleModel = vehicleModel;
      await storage.updateUser(String(req.params.id), updateData);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Parcel Attributes -------------------------------------------------------
  app.get("/api/parcel-attributes", async (req, res) => {
    try {
      const type = req.query.type as string;
      let rows;
      if (type) {
        rows = await db.select().from(parcelAttributes).where(eq(parcelAttributes.type, type));
      } else {
        rows = await db.select().from(parcelAttributes);
      }
      res.json(rows);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  function sanitizeAttr(body: any) {
    const clean: any = { ...body };
    if (clean.extraFare === "" || clean.extraFare === null || clean.extraFare === undefined) clean.extraFare = "0";
    if (clean.minValue === "") clean.minValue = null;
    if (clean.maxValue === "") clean.maxValue = null;
    return clean;
  }

  app.post("/api/parcel-attributes", requireAdminAuth, async (req, res) => {
    try {
      const [row] = await db.insert(parcelAttributes).values(sanitizeAttr(req.body) as any).returning();
      res.status(201).json(row);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.put("/api/parcel-attributes/:id", requireAdminAuth, async (req, res) => {
    try {
      const [row] = await db.update(parcelAttributes).set(sanitizeAttr(req.body) as any).where(eq(parcelAttributes.id, String(req.params.id))).returning();
      res.json(row);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.delete("/api/parcel-attributes/:id", requireAdminAuth, async (req, res) => {
    try {
      await db.delete(parcelAttributes).where(eq(parcelAttributes.id, String(req.params.id)));
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Insurance Plans ----------------------------------------------
  app.get("/api/insurance-plans", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM insurance_plans ORDER BY premium_monthly ASC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/insurance-plans", requireAdminAuth, async (req, res) => {
    try {
      const { name, planType, premiumDaily, premiumMonthly, coverageAmount, features, isActive } = req.body;
      const r = await rawDb.execute(rawSql`INSERT INTO insurance_plans (name, plan_type, premium_daily, premium_monthly, coverage_amount, features, is_active) VALUES (${name}, ${planType || 'vehicle'}, ${premiumDaily || 0}, ${premiumMonthly || 0}, ${coverageAmount || 0}, ${features || ''}, ${isActive ?? true}) RETURNING *`);
      res.status(201).json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.put("/api/insurance-plans/:id", requireAdminAuth, async (req, res) => {
    try {
      const { name, planType, premiumDaily, premiumMonthly, coverageAmount, features, isActive } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE insurance_plans SET name=${name}, plan_type=${planType || 'vehicle'}, premium_daily=${premiumDaily || 0}, premium_monthly=${premiumMonthly || 0}, coverage_amount=${coverageAmount || 0}, features=${features || ''}, is_active=${isActive} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.patch("/api/insurance-plans/:id", requireAdminAuth, async (req, res) => {
    try {
      const { isActive } = req.body;
      const r = await rawDb.execute(rawSql`UPDATE insurance_plans SET is_active=${isActive} WHERE id=${req.params.id}::uuid RETURNING *`);
      res.json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.delete("/api/insurance-plans/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM insurance_plans WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Driver Insurance ---------------------------------------------
  app.get("/api/driver-insurance", async (req, res) => {
    try {
      const driverId = req.query.driverId as string;
      let r;
      if (driverId) {
        r = await rawDb.execute(rawSql`SELECT di.*, ip.name as plan_name, ip.premium_monthly, ip.coverage_amount, u.full_name as driver_name FROM driver_insurance di LEFT JOIN insurance_plans ip ON ip.id=di.plan_id LEFT JOIN users u ON u.id=di.driver_id WHERE di.driver_id=${driverId}::uuid ORDER BY di.created_at DESC`);
      } else {
        r = await rawDb.execute(rawSql`SELECT di.*, ip.name as plan_name, ip.premium_monthly, ip.coverage_amount, u.full_name as driver_name FROM driver_insurance di LEFT JOIN insurance_plans ip ON ip.id=di.plan_id LEFT JOIN users u ON u.id=di.driver_id ORDER BY di.created_at DESC`);
      }
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/driver-insurance", async (req, res) => {
    try {
      const { driverId, planId, startDate, endDate, paymentAmount, paymentStatus } = req.body;
      const r = await rawDb.execute(rawSql`INSERT INTO driver_insurance (driver_id, plan_id, start_date, end_date, payment_amount, payment_status, is_active) VALUES (${driverId}::uuid, ${planId}::uuid, ${startDate}, ${endDate}, ${paymentAmount || 0}, ${paymentStatus || 'paid'}, true) RETURNING *`);
      res.status(201).json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Driver Subscriptions -----------------------------------------
  app.get("/api/driver-subscriptions", async (req, res) => {
    try {
      const driverId = req.query.driverId as string;
      let r;
      if (driverId) {
        r = await rawDb.execute(rawSql`SELECT ds.*, sp.name as plan_name, sp.price, sp.duration_days, sp.max_rides, u.full_name as driver_name FROM driver_subscriptions ds LEFT JOIN subscription_plans sp ON sp.id=ds.plan_id LEFT JOIN users u ON u.id=ds.driver_id WHERE ds.driver_id=${driverId}::uuid ORDER BY ds.created_at DESC`);
      } else {
        r = await rawDb.execute(rawSql`SELECT ds.*, sp.name as plan_name, sp.price, sp.duration_days, sp.max_rides, u.full_name as driver_name FROM driver_subscriptions ds LEFT JOIN subscription_plans sp ON sp.id=ds.plan_id LEFT JOIN users u ON u.id=ds.driver_id ORDER BY ds.created_at DESC LIMIT 100`);
      }
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.post("/api/driver-subscriptions", async (req, res) => {
    try {
      const { driverId, planId, startDate, endDate, paymentAmount, paymentStatus } = req.body;
      await rawDb.execute(rawSql`UPDATE driver_subscriptions SET is_active=false WHERE driver_id=${driverId}::uuid`);
      const r = await rawDb.execute(rawSql`INSERT INTO driver_subscriptions (driver_id, plan_id, start_date, end_date, payment_amount, payment_status, is_active) VALUES (${driverId}::uuid, ${planId}::uuid, ${startDate}, ${endDate}, ${paymentAmount || 0}, ${paymentStatus || 'paid'}, true) RETURNING *`);
      res.status(201).json(camelize(r.rows)[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Reports ------------------------------------------------------
  app.get("/api/reports/earnings", async (req, res) => {
    try {
      const { from, to } = req.query;
      const fromDate = from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const toDate = to || new Date().toISOString().split('T')[0];
      // Get settings for commission rates
      const settR = await rawDb.execute(rawSql`SELECT key_name, value FROM business_settings WHERE key_name IN ('platform_commission_b2c','gst_percentage','insurance_per_ride')`);
      const sett: Record<string, string> = {};
      settR.rows.forEach((s: any) => { sett[s.key_name] = s.value; });
      const commPct = parseFloat(sett['platform_commission_b2c'] || '15') / 100;
      const gstPct = parseFloat(sett['gst_percentage'] || '18') / 100;
      const insurancePerRide = parseFloat(sett['insurance_per_ride'] || '5');
      const r = await rawDb.execute(rawSql`SELECT DATE(created_at) as date, COUNT(*) as trips, COUNT(*) FILTER (WHERE current_status='completed') as completed, COUNT(*) FILTER (WHERE current_status='cancelled') as cancelled, COALESCE(SUM(actual_fare) FILTER (WHERE current_status='completed'), 0) as revenue FROM trip_requests WHERE DATE(created_at) BETWEEN ${fromDate} AND ${toDate} GROUP BY DATE(created_at) ORDER BY date`);
      const rows = r.rows.map((row: any) => {
        const rev = parseFloat(row.revenue || 0);
        const commission = rev * commPct;
        const gst = commission * gstPct;
        const insurance = parseFloat(row.completed || 0) * insurancePerRide;
        const adminTotal = commission + gst + insurance;
        const driverEarning = rev - commission;
        return camelize({ ...row, commission: commission.toFixed(2), gst: gst.toFixed(2), insurance: insurance.toFixed(2), admin_total: adminTotal.toFixed(2), driver_earning: driverEarning.toFixed(2) });
      });
      res.json({ rows, summary: { totalRevenue: rows.reduce((s: any, r: any) => s + parseFloat(r.revenue || 0), 0).toFixed(2), totalTrips: rows.reduce((s: any, r: any) => s + parseInt(r.trips || 0), 0), totalCommission: rows.reduce((s: any, r: any) => s + parseFloat(r.commission || 0), 0).toFixed(2), totalGst: rows.reduce((s: any, r: any) => s + parseFloat(r.gst || 0), 0).toFixed(2), totalInsurance: rows.reduce((s: any, r: any) => s + parseFloat(r.insurance || 0), 0).toFixed(2), totalAdminEarning: rows.reduce((s: any, r: any) => s + parseFloat(r.adminTotal || 0), 0).toFixed(2) } });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.get("/api/reports/trips", async (req, res) => {
    try {
      const { from, to } = req.query;
      const fromDate = from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const toDate = to || new Date().toISOString().split('T')[0];
      const r = await rawDb.execute(rawSql`SELECT tr.ref_id, tr.pickup_address, tr.destination_address, tr.estimated_fare, tr.actual_fare, tr.current_status, tr.payment_method, tr.trip_type, tr.created_at, u.full_name as customer_name, vc.name as vehicle_name FROM trip_requests tr LEFT JOIN users u ON u.id=tr.customer_id LEFT JOIN vehicle_categories vc ON vc.id=tr.vehicle_category_id WHERE DATE(tr.created_at) BETWEEN ${fromDate} AND ${toDate} ORDER BY tr.created_at DESC LIMIT 500`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.get("/api/reports/drivers", async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT u.full_name, u.phone, u.email, u.is_active, u.verification_status, u.created_at, u.vehicle_number, u.vehicle_model, vc.name as vehicle_category, dd.avg_rating, dd.availability_status, COUNT(tr.id) as total_trips, COALESCE(SUM(tr.actual_fare) FILTER (WHERE tr.current_status='completed'), 0) as total_earnings FROM users u LEFT JOIN driver_details dd ON dd.user_id=u.id LEFT JOIN vehicle_categories vc ON vc.id=dd.vehicle_category_id LEFT JOIN trip_requests tr ON tr.driver_id=u.id WHERE u.user_type='driver' GROUP BY u.id, u.full_name, u.phone, u.email, u.is_active, u.verification_status, u.created_at, u.vehicle_number, u.vehicle_model, vc.name, dd.avg_rating, dd.availability_status ORDER BY total_trips DESC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });
  app.get("/api/reports/customers", async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT u.full_name, u.phone, u.email, u.is_active, u.created_at, COUNT(tr.id) as total_trips, COALESCE(SUM(tr.actual_fare) FILTER (WHERE tr.current_status='completed'), 0) as total_spent FROM users u LEFT JOIN trip_requests tr ON tr.customer_id=u.id WHERE u.user_type='customer' GROUP BY u.id, u.full_name, u.phone, u.email, u.is_active, u.created_at ORDER BY total_spent DESC`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --- Safety Alerts -----------------------------------------------------------
  app.get("/api/safety-alerts", async (req, res) => {
    try {
      const status = req.query.status as string;
      const triggeredBy = req.query.triggered_by as string;
      // Build different queries based on filters to avoid dynamic SQL
      let r;
      const base = rawSql`SELECT sa.*, u.full_name as user_name, u.phone as user_phone, u.user_type, u.gender FROM safety_alerts sa LEFT JOIN users u ON u.id = sa.user_id`;
      if (status && status !== 'all' && triggeredBy && triggeredBy !== 'all') {
        r = await rawDb.execute(rawSql`${base} WHERE sa.status=${status} AND sa.triggered_by=${triggeredBy} ORDER BY sa.created_at DESC LIMIT 100`);
      } else if (status && status !== 'all') {
        r = await rawDb.execute(rawSql`${base} WHERE sa.status=${status} ORDER BY sa.created_at DESC LIMIT 100`);
      } else if (triggeredBy && triggeredBy !== 'all') {
        r = await rawDb.execute(rawSql`${base} WHERE sa.triggered_by=${triggeredBy} ORDER BY sa.created_at DESC LIMIT 100`);
      } else {
        r = await rawDb.execute(rawSql`${base} ORDER BY sa.created_at DESC LIMIT 100`);
      }
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/safety-alerts/stats", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT
          COUNT(*) FILTER (WHERE status='active') as active_count,
          COUNT(*) FILTER (WHERE status='acknowledged') as acknowledged_count,
          COUNT(*) FILTER (WHERE status='resolved') as resolved_count,
          COUNT(*) FILTER (WHERE triggered_by='customer') as customer_count,
          COUNT(*) FILTER (WHERE triggered_by='driver') as driver_count,
          COUNT(*) FILTER (WHERE DATE(created_at)=CURRENT_DATE) as today_count
        FROM safety_alerts
      `);
      res.json(camelize(r.rows[0] || {}));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/safety-alerts", async (req, res) => {
    try {
      const { userId, tripId, alertType, triggeredBy, latitude, longitude, locationAddress } = req.body;
      // Count nearby online drivers (within ~3km)
      const nearbyR = await rawDb.execute(rawSql`
        SELECT COUNT(*) as cnt FROM users u
        JOIN driver_details dd ON dd.user_id = u.id
        WHERE u.user_type='driver' AND dd.is_online=true AND u.is_active=true
      `);
      const nearbyCount = Number((nearbyR.rows[0] as any)?.cnt || 0);
      let r;
      if (userId) {
        r = await rawDb.execute(rawSql`
          INSERT INTO safety_alerts (user_id, trip_id, alert_type, triggered_by, latitude, longitude, location_address, nearby_drivers_notified)
          VALUES (${userId}::uuid, ${tripId ? tripId : null}, ${alertType || 'sos'}, ${triggeredBy || 'customer'},
                  ${latitude || null}, ${longitude || null}, ${locationAddress || null}, ${nearbyCount})
          RETURNING *
        `);
      } else {
        r = await rawDb.execute(rawSql`
          INSERT INTO safety_alerts (alert_type, triggered_by, latitude, longitude, location_address, nearby_drivers_notified)
          VALUES (${alertType || 'sos'}, ${triggeredBy || 'customer'},
                  ${latitude || null}, ${longitude || null}, ${locationAddress || null}, ${nearbyCount})
          RETURNING *
        `);
      }
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/safety-alerts/:id/acknowledge", async (req, res) => {
    try {
      const { adminName, notes } = req.body;
      const r = await rawDb.execute(rawSql`
        UPDATE safety_alerts SET status='acknowledged', acknowledged_by_name=${adminName || 'Admin'},
        acknowledged_at=now(), notes=${notes || null} WHERE id=${req.params.id}::uuid RETURNING *
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Alert not found" });
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/safety-alerts/:id/resolve", async (req, res) => {
    try {
      const { policeNotified, notes } = req.body;
      const r = await rawDb.execute(rawSql`
        UPDATE safety_alerts SET status='resolved', resolved_at=now(),
        police_notified=${policeNotified ?? false}, notes=${notes || null} WHERE id=${req.params.id}::uuid RETURNING *
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Alert not found" });
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.delete("/api/safety-alerts/:id", async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM safety_alerts WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --- Police Stations ----------------------------------------------------------
  app.get("/api/police-stations", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT ps.*, z.name as zone_name FROM police_stations ps LEFT JOIN zones z ON z.id::uuid = ps.zone_id ORDER BY ps.name`);
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/police-stations", async (req, res) => {
    try {
      const { name, zoneId, address, phone, latitude, longitude } = req.body;
      if (!name) return res.status(400).json({ message: "Station name required" });
      let r;
      if (zoneId) {
        r = await rawDb.execute(rawSql`INSERT INTO police_stations (name, zone_id, address, phone, latitude, longitude) VALUES (${name}, ${zoneId}::uuid, ${address || null}, ${phone || null}, ${latitude || null}, ${longitude || null}) RETURNING *`);
      } else {
        r = await rawDb.execute(rawSql`INSERT INTO police_stations (name, address, phone, latitude, longitude) VALUES (${name}, ${address || null}, ${phone || null}, ${latitude || null}, ${longitude || null}) RETURNING *`);
      }
      res.status(201).json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.put("/api/police-stations/:id", async (req, res) => {
    try {
      const { name, zoneId, address, phone, latitude, longitude, isActive } = req.body;
      let r;
      if (zoneId) {
        r = await rawDb.execute(rawSql`UPDATE police_stations SET name=${name}, zone_id=${zoneId}::uuid, address=${address || null}, phone=${phone || null}, latitude=${latitude || null}, longitude=${longitude || null}, is_active=${isActive ?? true} WHERE id=${req.params.id}::uuid RETURNING *`);
      } else {
        r = await rawDb.execute(rawSql`UPDATE police_stations SET name=${name}, zone_id=NULL, address=${address || null}, phone=${phone || null}, latitude=${latitude || null}, longitude=${longitude || null}, is_active=${isActive ?? true} WHERE id=${req.params.id}::uuid RETURNING *`);
      }
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.delete("/api/police-stations/:id", async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM police_stations WHERE id=${req.params.id}::uuid`);
      res.status(204).end();
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --- Female Matching Algorithm � Driver Pool ----------------------------------
  // GET matching algorithm stats
  app.get("/api/matching/stats", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT
          COUNT(*) FILTER (WHERE user_type='driver' AND gender='female') as female_drivers,
          COUNT(*) FILTER (WHERE user_type='driver' AND gender='male') as male_drivers,
          COUNT(*) FILTER (WHERE user_type='customer' AND gender='female') as female_customers,
          COUNT(*) FILTER (WHERE user_type='customer' AND prefer_female_driver=true) as prefer_female_customers
        FROM users WHERE user_type IN ('driver','customer')
      `);
      const settings = await rawDb.execute(rawSql`
        SELECT key_name, value FROM business_settings WHERE settings_type='safety_settings'
      `);
      const settingsMap = Object.fromEntries((settings.rows as any[]).map((s: any) => [s.key_name, s.value]));
      res.json({ stats: camelize(r.rows[0] || {}), settings: settingsMap });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // GET available drivers with matching algorithm applied
  app.get("/api/matching/drivers", async (req, res) => {
    try {
      const { customerGender, vehicleCategoryId } = req.query;
      const settings = await rawDb.execute(rawSql`
        SELECT key_name, value FROM business_settings WHERE key_name IN ('female_to_female_matching','vehicle_type_matching')
      `);
      const sMap = Object.fromEntries((settings.rows as any[]).map((s: any) => [s.key_name, s.value]));
      const femalePriority = sMap['female_to_female_matching'] === '1' && customerGender === 'female';
      const vehicleMatch = sMap['vehicle_type_matching'] === '1' && vehicleCategoryId;

      let r;
      if (vehicleMatch && femalePriority) {
        r = await rawDb.execute(rawSql`
          SELECT u.id, u.full_name, u.phone, u.gender, u.vehicle_number, u.vehicle_model,
                 dd.avg_rating, dd.availability_status, vc.name as vehicle_category, vc.id as vehicle_category_id,
                 CASE WHEN u.gender='female' THEN 1 ELSE 2 END as gender_priority
          FROM users u
          JOIN driver_details dd ON dd.user_id = u.id
          LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
          WHERE u.user_type='driver' AND u.is_active=true AND dd.availability_status='online'
            AND dd.vehicle_category_id = ${vehicleCategoryId as string}::uuid
          ORDER BY gender_priority ASC, dd.avg_rating DESC
        `);
      } else if (vehicleMatch) {
        r = await rawDb.execute(rawSql`
          SELECT u.id, u.full_name, u.phone, u.gender, u.vehicle_number, u.vehicle_model,
                 dd.avg_rating, dd.availability_status, vc.name as vehicle_category, vc.id as vehicle_category_id
          FROM users u
          JOIN driver_details dd ON dd.user_id = u.id
          LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
          WHERE u.user_type='driver' AND u.is_active=true AND dd.availability_status='online'
            AND dd.vehicle_category_id = ${vehicleCategoryId as string}::uuid
          ORDER BY dd.avg_rating DESC
        `);
      } else if (femalePriority) {
        r = await rawDb.execute(rawSql`
          SELECT u.id, u.full_name, u.phone, u.gender, u.vehicle_number, u.vehicle_model,
                 dd.avg_rating, dd.availability_status, vc.name as vehicle_category, vc.id as vehicle_category_id,
                 CASE WHEN u.gender='female' THEN 1 ELSE 2 END as gender_priority
          FROM users u
          JOIN driver_details dd ON dd.user_id = u.id
          LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
          WHERE u.user_type='driver' AND u.is_active=true AND dd.availability_status='online'
          ORDER BY gender_priority ASC, dd.avg_rating DESC
        `);
      } else {
        r = await rawDb.execute(rawSql`
          SELECT u.id, u.full_name, u.phone, u.gender, u.vehicle_number, u.vehicle_model,
                 dd.avg_rating, dd.availability_status, vc.name as vehicle_category, vc.id as vehicle_category_id
          FROM users u
          JOIN driver_details dd ON dd.user_id = u.id
          LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
          WHERE u.user_type='driver' AND u.is_active=true AND dd.availability_status='online'
          ORDER BY dd.avg_rating DESC
        `);
      }
      res.json(camelize(r.rows));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // PATCH user gender + preference
  app.patch("/api/users/:id/gender", async (req, res) => {
    try {
      const { gender, preferFemaleDriver, emergencyContactName, emergencyContactPhone } = req.body;
      const r = await rawDb.execute(rawSql`
        UPDATE users SET
          gender = ${gender || 'male'},
          prefer_female_driver = ${preferFemaleDriver ?? false},
          emergency_contact_name = ${emergencyContactName || null},
          emergency_contact_phone = ${emergencyContactPhone || null}
        WHERE id = ${req.params.id}::uuid RETURNING id, full_name, gender, prefer_female_driver, emergency_contact_name, emergency_contact_phone
      `);
      if (!r.rows.length) return res.status(404).json({ message: "User not found" });
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // ========== FARE CALCULATOR ==========
  app.post("/api/fare-calculator", async (req, res) => {
    try {
      const { zoneId, vehicleCategoryId, distanceKm, durationMin = 0 } = req.body;
      if (!zoneId || !vehicleCategoryId || !distanceKm) {
        return res.status(400).json({ message: "zoneId, vehicleCategoryId and distanceKm required" });
      }
      const fare = await rawDb.execute(rawSql`
        SELECT tf.base_fare, tf.fare_per_km, tf.fare_per_min, tf.minimum_fare, tf.cancellation_fee,
               vc.name as vehicle_name, vc.icon as vehicle_icon,
               z.name as zone_name
        FROM trip_fares tf
        JOIN vehicle_categories vc ON vc.id = tf.vehicle_category_id
        JOIN zones z ON z.id = tf.zone_id
        WHERE tf.zone_id = ${zoneId}::uuid AND tf.vehicle_category_id = ${vehicleCategoryId}::uuid
        LIMIT 1
      `);
      if (!fare.rows.length) return res.status(404).json({ message: "No fare found for this zone and vehicle" });
      const f = fare.rows[0] as any;
      const base = parseFloat(f.base_fare || "0");
      const perKm = parseFloat(f.fare_per_km || "0");
      const perMin = parseFloat(f.fare_per_min || "0");
      const minFare = parseFloat(f.minimum_fare || "0");
      const cancelFee = parseFloat(f.cancellation_fee || "0");
      const dist = parseFloat(distanceKm);
      const dur = parseFloat(durationMin);
      const baseFareAmt = base;
      const distanceFare = perKm * dist;
      const timeFare = perMin * dur;
      const subtotal = baseFareAmt + distanceFare + timeFare;
      const total = Math.max(subtotal, minFare);
      const gst = total * 0.05;
      const grandTotal = total + gst;
      res.json({
        vehicleName: f.vehicle_name,
        vehicleIcon: f.vehicle_icon,
        zoneName: f.zone_name,
        breakdown: {
          baseFare: baseFareAmt.toFixed(2),
          distanceFare: distanceFare.toFixed(2),
          timeFare: timeFare.toFixed(2),
          subtotal: subtotal.toFixed(2),
          minimumFare: minFare.toFixed(2),
          cancellationFee: cancelFee.toFixed(2),
          gst: gst.toFixed(2),
          total: grandTotal.toFixed(2),
        },
        inputs: { distanceKm: dist, durationMin: dur, perKm, perMin, baseFare: base },
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // ========== DRIVER EARNINGS ==========
  app.get("/api/driver-earnings", async (req, res) => {
    try {
      const { search = "", limit = 50, offset = 0 } = req.query;
      const rows = await rawDb.execute(rawSql`
        SELECT
          u.id, u.full_name, u.phone, u.email, u.vehicle_number, u.vehicle_model,
          u.verification_status, u.is_active,
          vc.name as vehicle_category,
          dd.avg_rating, dd.availability_status,
          COUNT(tr.id) FILTER (WHERE tr.current_status = 'completed') as completed_trips,
          COALESCE(SUM(tr.actual_fare) FILTER (WHERE tr.current_status = 'completed'), 0) as gross_earnings,
          COALESCE(SUM(tr.actual_fare * 0.15) FILTER (WHERE tr.current_status = 'completed'), 0) as commission,
          COALESCE(SUM(tr.actual_fare * 0.05) FILTER (WHERE tr.current_status = 'completed'), 0) as gst,
          COALESCE(SUM(tr.actual_fare * 0.80) FILTER (WHERE tr.current_status = 'completed'), 0) as net_earnings,
          COUNT(tr.id) FILTER (WHERE tr.current_status = 'cancelled') as cancelled_trips,
          COUNT(tr.id) FILTER (WHERE tr.current_status = 'completed' AND tr.created_at >= NOW() - INTERVAL '30 days') as this_month_trips,
          COALESCE(SUM(tr.actual_fare) FILTER (WHERE tr.current_status = 'completed' AND tr.created_at >= NOW() - INTERVAL '30 days'), 0) as this_month_earnings
        FROM users u
        LEFT JOIN driver_details dd ON dd.user_id = u.id
        LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
        LEFT JOIN trip_requests tr ON tr.driver_id = u.id
        WHERE u.user_type = 'driver'
          AND (${search} = '' OR u.full_name ILIKE ${'%' + search + '%'} OR u.phone ILIKE ${'%' + search + '%'})
        GROUP BY u.id, u.full_name, u.phone, u.email, u.vehicle_number, u.vehicle_model,
                 u.verification_status, u.is_active, vc.name, dd.avg_rating, dd.availability_status
        ORDER BY gross_earnings DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `);
      res.json(rows.rows.map(camelize));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/driver-earnings/:driverId", async (req, res) => {
    try {
      const driverId = req.params.driverId;
      const [profile, monthly] = await Promise.all([
        rawDb.execute(rawSql`
          SELECT u.id, u.full_name, u.phone, u.email, u.vehicle_number, u.vehicle_model,
                 u.verification_status, u.is_active, u.created_at,
                 vc.name as vehicle_category, dd.avg_rating, dd.availability_status
          FROM users u
          LEFT JOIN driver_details dd ON dd.user_id = u.id
          LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
          WHERE u.id = ${driverId}::uuid AND u.user_type = 'driver'
          LIMIT 1
        `),
        rawDb.execute(rawSql`
          SELECT
            TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month,
            TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') as month_label,
            COUNT(*) FILTER (WHERE current_status = 'completed') as completed,
            COUNT(*) FILTER (WHERE current_status = 'cancelled') as cancelled,
            COALESCE(SUM(actual_fare) FILTER (WHERE current_status = 'completed'), 0) as gross,
            COALESCE(SUM(actual_fare * 0.15) FILTER (WHERE current_status = 'completed'), 0) as commission,
            COALESCE(SUM(actual_fare * 0.05) FILTER (WHERE current_status = 'completed'), 0) as gst,
            COALESCE(SUM(actual_fare * 0.80) FILTER (WHERE current_status = 'completed'), 0) as net
          FROM trip_requests
          WHERE driver_id = ${driverId}::uuid
          GROUP BY DATE_TRUNC('month', created_at)
          ORDER BY month DESC
          LIMIT 12
        `)
      ]);
      if (!profile.rows.length) return res.status(404).json({ message: "Driver not found" });
      res.json({
        profile: camelize(profile.rows[0]),
        monthly: monthly.rows.map(camelize),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // ========== REFERRAL SYSTEM ==========
  app.get("/api/referrals/stats", async (req, res) => {
    try {
      const stats = await rawDb.execute(rawSql`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'paid') as paid,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'expired') as expired,
          COALESCE(SUM(reward_amount) FILTER (WHERE status = 'paid'), 0) as total_rewarded,
          COALESCE(SUM(reward_amount) FILTER (WHERE status = 'pending'), 0) as pending_amount,
          COUNT(*) FILTER (WHERE referral_type = 'customer') as customer_referrals,
          COUNT(*) FILTER (WHERE referral_type = 'driver') as driver_referrals
        FROM referrals
      `);
      res.json(camelize(stats.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/referrals", async (req, res) => {
    try {
      const { status = "all", referralType = "all", limit = 50, offset = 0 } = req.query;
      const rows = await rawDb.execute(rawSql`
        SELECT r.*,
               ru.full_name as referrer_name, ru.phone as referrer_phone, ru.user_type as referrer_type,
               rd.full_name as referred_name, rd.phone as referred_phone
        FROM referrals r
        LEFT JOIN users ru ON ru.id = r.referrer_id
        LEFT JOIN users rd ON rd.id = r.referred_id
        WHERE (${status} = 'all' OR r.status = ${status})
          AND (${referralType} = 'all' OR r.referral_type = ${referralType})
        ORDER BY r.created_at DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `);
      res.json(rows.rows.map(camelize));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/referrals/:id/pay", requireAdminAuth, async (req, res) => {
    try {
      // Atomic: only pay if still pending (prevents double-credit)
      const r = await rawDb.execute(rawSql`
        UPDATE referrals SET status = 'paid', paid_at = NOW()
        WHERE id = ${req.params.id}::uuid AND status = 'pending'
        RETURNING *
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Referral not found or already paid/expired" });
      const ref = r.rows[0] as any;
      const rewardAmount = parseFloat(ref.reward_amount || '0');
      // Credit referrer's wallet and log transaction
      if (ref.referrer_id && rewardAmount > 0) {
        await rawDb.execute(rawSql`
          UPDATE users SET wallet_balance = wallet_balance + ${rewardAmount}
          WHERE id = ${ref.referrer_id}::uuid
        `).catch(dbCatch("db"));
        const newBal = await rawDb.execute(rawSql`
          SELECT wallet_balance FROM users WHERE id = ${ref.referrer_id}::uuid
        `).catch(() => ({ rows: [] as any[] }));
        const bal = parseFloat((newBal.rows[0] as any)?.wallet_balance || '0');
        await rawDb.execute(rawSql`
          INSERT INTO transactions (user_id, account, credit, debit, balance, transaction_type, ref_transaction_id)
          VALUES (${ref.referrer_id}::uuid, ${'Referral bonus'}, ${rewardAmount}, 0, ${bal}, ${'referral_bonus'}, ${ref.id}::uuid)
        `).catch(dbCatch("db"));
      }
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/referrals/:id/expire", requireAdminAuth, async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        UPDATE referrals SET status = 'expired' WHERE id = ${req.params.id}::uuid RETURNING *
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Referral not found" });
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -----------------------------------------------------------------------
  // ��  MOBILE APP APIs � Driver App + Customer App                       ��
  // -----------------------------------------------------------------------

  // Mobile authentication is password/session based only. FCM remains available through /api/app/fcm-token.
  // Phone-auth, app OTP login, and token-verification auth routes are intentionally not registered.

  // -- PASSWORD-BASED REGISTER -----------------------------------------------
  app.post("/api/app/register", loginLimiter, async (req, res) => {
    try {
      const { phone, password, fullName, userType = "customer", email } = req.body;
      if (!phone || !password || !fullName) return res.status(400).json({ message: "Phone, password and name are required" });
      if (!['customer', 'driver'].includes(userType)) return res.status(400).json({ message: "Invalid user type" });
      const phoneStr = normalizePhone(phone);
      if (phoneStr.length !== 10) return res.status(400).json({ message: "Enter a valid 10-digit phone number" });
      if (fullName.length > 100) return res.status(400).json({ message: "Name too long (max 100 chars)" });
      if (email && email.length > 200) return res.status(400).json({ message: "Email too long" });
      if (password.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });
      logRegistrationAudit("register.request", req.body, { phone: maskPhone(phoneStr) });
      const passwordHash = await hashPassword(password);
      const session = await rawDb.transaction(async (trx) =>
        provisionAppUserSessionTx(trx, {
          phone: phoneStr,
          userType,
          fullName,
          email: email || null,
          passwordHash,
          referralCode: req.body?.referralCode || null,
          vehicleType: userType === "driver" ? "bike" : null,
        })
      );
      res.json({
        success: true,
        isNew: session.isNew,
        token: session.token,
        user: {
          id: session.user.id,
          fullName: session.user.fullName || session.user.name,
          phone: session.user.phone || session.user.mobile,
          email: session.user.email || null,
          userType: session.user.userType,
          walletBalance: safeFloat(session.user.walletBalance, 0),
        },
      });
    } catch (e: any) {
      console.error("[register] /api/app/register failed", {
        message: e?.message,
        stack: e?.stack,
        phone: req.body?.phone,
        userType: req.body?.userType,
      });
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- PASSWORD-BASED LOGIN --------------------------------------------------
  app.post("/api/app/login-password", loginLimiter, async (req, res) => {
    log(`Login request received for phone: ${req.body?.phone}`);
    try {
      const { phone, password, userType = "customer" } = req.body;
      if (!phone || !password) return res.status(400).json({ message: "Phone and password are required" });
      const phoneStr = normalizePhone(phone);
      if (phoneStr.length !== 10) return res.status(400).json({ message: "Enter a valid 10-digit phone number" });
      const userRes = await rawDb.execute(rawSql`
        SELECT * FROM users
        WHERE (phone=${phoneStr} OR mobile=${phoneStr})
          AND (
            user_type=${userType}
            OR (${userType}='customer' AND role IN ('user', 'customer'))
            OR (${userType}='driver' AND role IN ('driver', 'pilot'))
          )
        LIMIT 1
      `);
      if (!userRes.rows.length) return res.status(404).json({ message: "No account found. Please register first." });
      const user = camelize(userRes.rows[0]) as any;
      const requestedUserType = String(userType).toLowerCase();
      if (requestedUserType === "customer" && !canUseCustomerApp(user)) {
        return res.status(403).json({ message: "Customer access required" });
      }
      if (requestedUserType === "driver" && !canUseDriverApp(user)) {
        return res.status(403).json({ message: "Driver access required" });
      }
      if (!user.isActive) return res.status(403).json({ message: "Account deactivated. Contact support." });
      if (!user.passwordHash) return res.status(400).json({ message: "Password not set. Please use Forgot Password to set one." });
      const match = await verifyPassword(password, user.passwordHash);
      if (!match) return res.status(401).json({ message: "Incorrect password. Please try again." });
      const token = `${user.id}:${crypto.randomBytes(32).toString("hex")}`;
      const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await rawDb.execute(rawSql`
        UPDATE users
        SET auth_token=${token},
            auth_token_expires_at=${tokenExpiry},
            last_login_at=NOW()
        WHERE id=${user.id}::uuid
      `);
      const walletBalance = safeFloat(user.walletBalance, 0);
      const effectiveUserType = requestedUserType === "driver" ? "driver" : "customer";
      res.json({ success: true, token, user: { id: user.id, fullName: user.fullName || user.name, phone: user.phone || user.mobile, email: user.email || null, userType: effectiveUserType, profilePhoto: user.profilePhoto || user.profileImage || null, rating: safeFloat(user.rating, 5.0), isActive: user.isActive, walletBalance, isLocked: user.isLocked || false } });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- FORGOT PASSWORD -------------------------------------------------------
  // Password reset is intentionally support/admin mediated until a non-OTP
  // recovery channel is configured.
  app.post("/api/app/forgot-password", otpLimiter, async (req, res) => {
    try {
      const { phone, userType = "customer" } = req.body;
      if (!phone) return res.status(400).json({ message: "Phone number is required" });
      const phoneStr = normalizePhone(phone);
      if (phoneStr.length < 10) return res.status(400).json({ message: "Invalid phone number" });
      const userRes = await rawDb.execute(rawSql`
        SELECT id FROM users
        WHERE (phone=${phoneStr} OR mobile=${phoneStr}) AND user_type=${userType}
        LIMIT 1
      `);
      if (!userRes.rows.length) return res.status(404).json({ message: "No account found with this phone number." });
      console.log(`[RESET] ${phoneStr.slice(-4).padStart(phoneStr.length, '*')} password reset support required`);
      res.status(423).json({
        success: false,
        code: "PASSWORD_RESET_SUPPORT_REQUIRED",
        message: "Password reset is handled by support/admin verification. Please contact support.",
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- RESET PASSWORD (verify OTP + set new password) ------------------------
  app.post("/api/app/reset-password", async (_req, res) => {
    return res.status(410).json({
      success: false,
      code: "PASSWORD_RESET_SUPPORT_REQUIRED",
      message: "Password reset via OTP is removed. Please contact support/admin verification.",
    });
  });


  // -- AUTH MIDDLEWARE (simple token check) ---------------------------------
  async function authApp(req: Request, res: Response, next: NextFunction) {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (!token) return res.status(401).json({ message: "No token provided" });
      const parts = token.split(":");
      if (parts.length < 2) return res.status(401).json({ message: "Invalid token format" });
      const userId = parts[0];
      // Validate full token against stored auth_token in DB and check expiry
      const userR = await rawDb.execute(rawSql`
        SELECT * FROM users WHERE id=${userId}::uuid AND is_active=true AND auth_token=${token}
          AND (auth_token_expires_at IS NULL OR auth_token_expires_at > NOW()) LIMIT 1
      `);
      if (!userR.rows.length) return res.status(401).json({ message: "Session expired or invalid. Please login again." });
      (req as any).currentUser = camelize(userR.rows[0]);
      next();
    } catch (e: any) { res.status(401).json({ message: "Auth failed" }); }
  }

  // Role-specific guards � always used after authApp
  function requireDriver(req: Request, res: Response, next: NextFunction) {
    const user = (req as any).currentUser;
    if (!canUseDriverApp(user)) return res.status(403).json({ message: "Driver access required" });
    (req as any).currentUser = { ...user, userType: "driver" };
    next();
  }
  function requireCustomer(req: Request, res: Response, next: NextFunction) {
    const user = (req as any).currentUser;
    if (!canUseCustomerApp(user)) return res.status(403).json({ message: "Customer access required" });
    (req as any).currentUser = { ...user, userType: "customer" };
    next();
  }

  registerOutstationPoolV2Routes(app, authApp);
  registerRollingPoolRoutes(app, authApp, requireAdminAuth);

  // -- DRIVER: Go Online / Offline + Location Update -------------------------
  app.post("/api/app/driver/location", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { lat, lng, heading = 0, speed = 0, isOnline } = req.body;

      // -- SECURITY: Validate coordinates and numeric values --
      const coords = validateLatLng(lat, lng);
      const validHeading = safeFloat(heading, 0);
      const validSpeed = safeFloat(speed, 0);

      // Ensure non-negative speed and heading in [0, 360]
      if (validSpeed < 0) throw new Error("Speed cannot be negative");
      if (validHeading < 0 || validHeading > 360) throw new Error("Heading must be 0-360");

      // isOnline defaults to true � if you're sending location, you are online.
      // Fallback chain: body.isOnline ? true (never false here; going offline is via online-status endpoint)
      const effectiveOnline = isOnline !== undefined ? Boolean(isOnline) : true;

      // Upsert location � always include updated_at=NOW() in both INSERT and ON CONFLICT
      await rawDb.execute(rawSql`
        INSERT INTO driver_locations (driver_id, lat, lng, heading, speed, is_online, updated_at)
        VALUES (${driver.id}::uuid, ${coords.lat}, ${coords.lng}, ${validHeading}, ${validSpeed}, ${effectiveOnline}, NOW())
        ON CONFLICT (driver_id) DO UPDATE SET lat=${coords.lat}, lng=${coords.lng}, heading=${validHeading}, speed=${validSpeed},
          is_online=${effectiveOnline}, updated_at=NOW()
      `);
      // Also update users table
      await rawDb.execute(rawSql`UPDATE users SET is_online=${effectiveOnline}, current_lat=${coords.lat}, current_lng=${coords.lng} WHERE id=${driver.id}::uuid`);
      // Auto-detect and update driver zone from GPS position
      const autoZoneId = await detectZoneId(coords.lat, coords.lng);
      if (autoZoneId) {
        await rawDb.execute(rawSql`
          UPDATE driver_details SET zone_id=${autoZoneId}::uuid WHERE user_id=${driver.id}::uuid
        `).catch(dbCatch("db"));
      }
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/app/driver/online-status", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { isOnline } = req.body;
      if (isOnline) {
        // Check verification status FIRST
        const verR = await rawDb.execute(rawSql`SELECT verification_status, rejection_note FROM users WHERE id=${driver.id}::uuid`);
        const vs = (verR.rows[0] as any)?.verification_status;
        if (!['approved', 'verified', 'pending'].includes(vs)) {
          console.log(`[DRIVER_STATUS] Driver ${driver.id} (status: ${vs}) - Allowing regardless of verification status for test`);
        }
        // Check if driver has selected a revenue model
        const modelR = await rawDb.execute(rawSql`SELECT revenue_model, model_selected_at FROM users WHERE id=${driver.id}::uuid`);
        const modelRow = modelR.rows[0] as any;
        if (!modelRow?.model_selected_at) {
          if (modelRow?.revenue_model) {
            // Auto-heal: driver has a revenue model set (e.g. by admin) but model_selected_at was never recorded  backfill it
            await rawDb.execute(rawSql`UPDATE users SET model_selected_at=NOW() WHERE id=${driver.id}::uuid`);
          } else {
            console.log(`[DRIVER_STATUS] Driver ${driver.id} - No model selected, but ALLOWING for test`);
          }
        }
        // Subscription-like models require an active plan before going online
        const isSubscriptionLikeModel = ['subscription', 'hybrid'].includes(String(modelRow?.revenue_model || ''));
        if (isSubscriptionLikeModel) {
          const freeCheckR = await rawDb.execute(rawSql`SELECT launch_free_active, free_period_end FROM users WHERE id=${driver.id}::uuid LIMIT 1`).catch(() => ({ rows: [] as any[] }));
          const freeRow = freeCheckR.rows[0] as any;
          const inFreePeriod = freeRow?.launch_free_active === true
            && freeRow?.free_period_end
            && new Date(freeRow.free_period_end) >= new Date();
          if (!inFreePeriod) {
            const subR = await rawDb.execute(rawSql`SELECT id, end_date FROM driver_subscriptions WHERE driver_id=${driver.id}::uuid AND is_active=true AND end_date > NOW() ORDER BY end_date DESC LIMIT 1`);
            if (!subR.rows.length) {
              console.log(`[DRIVER_STATUS] Driver ${driver.id} - Subscription expired, but ALLOWING for test`);
            }
          }
        }

        // Check document expiry � insurance, RC, PUC must be valid
        const docExpR = await rawDb.execute(rawSql`
          SELECT doc_type, expiry_date FROM driver_documents
          WHERE driver_id=${driver.id}::uuid
            AND doc_type IN ('insurance','rc','puc')
            AND expiry_date IS NOT NULL AND expiry_date != ''
            AND expiry_date < CURRENT_DATE::text
          LIMIT 1
        `);
        if (docExpR.rows.length) {
          const expDoc = docExpR.rows[0] as any;
          const docLabel = expDoc.doc_type === 'rc' ? 'Vehicle RC' : expDoc.doc_type === 'insurance' ? 'Vehicle Insurance' : 'Pollution Certificate (PUC)';
          // return res.status(403).json({
          //   message: `Your ${docLabel} has expired (${expDoc.expiry_date}). Please upload an updated document to go online.`,
          //   documentExpired: true,
          //   docType: expDoc.doc_type,
          // });
          console.log(`[DRIVER_STATUS] Driver ${driver.id} - Documents expired (${expDoc.doc_type}), but ALLOWING for test`);
        }
        // Check wallet lock (applies to both models � negative balance)
        const walletR = await rawDb.execute(rawSql`SELECT is_locked, wallet_balance, lock_reason FROM users WHERE id=${driver.id}::uuid`);
        const w = walletR.rows[0] as any;
        const currentBalance = parseFloat(w?.wallet_balance || 0);
        // Also fetch the auto-lock threshold from settings
        const thresholdR = await rawDb.execute(rawSql`SELECT value FROM revenue_model_settings WHERE key_name='auto_lock_threshold' LIMIT 1`);
        const lockThreshold = parseFloat((thresholdR.rows[0] as any)?.value || "-100");
        // Block if explicitly locked
        // if (w?.is_locked) return res.status(403).json({
        //   message: w.lock_reason || "Account locked. Please recharge wallet to go online.",
        //   isLocked: true, walletBalance: currentBalance
        // });
        if (w?.is_locked) console.log(`[DRIVER_STATUS] Driver ${driver.id} - Locked (${w.lock_reason}), but ALLOWING for test`);
        // Block if wallet is below threshold (auto-lock that wasn't yet written)
        if (currentBalance < lockThreshold) {
          const lockMsg = `Wallet balance ?${currentBalance.toFixed(2)} is below minimum threshold ?${lockThreshold}. Recharge wallet to go online.`;
          await rawDb.execute(rawSql`UPDATE users SET is_locked=true, lock_reason=${lockMsg}, locked_at=NOW() WHERE id=${driver.id}::uuid`);
          return res.status(403).json({
            message: lockMsg, isLocked: true, walletBalance: currentBalance
          });
        }
        // Per-service subscription check: use model based on driver's vehicle category type
        const modelAllR = await rawDb.execute(rawSql`SELECT key_name, value FROM revenue_model_settings`);
        const mS: any = {};
        modelAllR.rows.forEach((row: any) => { mS[(row as any).key_name] = (row as any).value; });
        // Get driver's vehicle category type
        const driverVehicleR = await rawDb.execute(rawSql`
          SELECT vc.type as vehicle_type FROM driver_details dd
          JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
          WHERE dd.user_id = ${driver.id}::uuid
        `);
        const vehicleType = (driverVehicleR.rows[0] as any)?.vehicle_type || 'ride';
        let relevantModelKey = 'rides_model';
        if (vehicleType === 'parcel') relevantModelKey = 'parcels_model';
        else if (vehicleType === 'cargo') relevantModelKey = 'cargo_model';
        const activeModel = mS[relevantModelKey] || mS['active_model'] || "commission";
        if (activeModel === "subscription" || activeModel === "hybrid") {
          // Re-check free period here so it bypasses the system-model subscription gate too
          const fp2R = await rawDb.execute(rawSql`SELECT launch_free_active, free_period_end FROM users WHERE id=${driver.id}::uuid LIMIT 1`).catch(() => ({ rows: [] as any[] }));
          const fp2 = fp2R.rows[0] as any;
          const inFP2 = fp2?.launch_free_active === true && fp2?.free_period_end && new Date(fp2.free_period_end) >= new Date();
          if (!inFP2) {
            const subR = await rawDb.execute(rawSql`
              SELECT id, end_date, is_active FROM driver_subscriptions
              WHERE driver_id=${driver.id}::uuid AND is_active=true AND end_date >= CURRENT_DATE
              ORDER BY end_date DESC LIMIT 1
            `);
            if (!subR.rows.length) {
              return res.status(403).json({
                message: "Subscription required. Please purchase or renew your subscription to go online.",
                subscriptionExpired: true, requiresSubscription: true, isLocked: false
              });
            }
            const sub = subR.rows[0] as any;
            const daysLeft = Math.ceil((new Date(sub.end_date).getTime() - Date.now()) / 86400000);
            if (daysLeft <= 2) {
              res.setHeader("X-Subscription-Warning", `Subscription expires in ${daysLeft} day(s)`);
            }
          }
        }
      }
      const lat = req.body.lat;
      const lng = req.body.lng;
      const hasValidCoords = lat != null && lng != null && isFinite(Number(lat)) && isFinite(Number(lng)) && (Number(lat) !== 0 || Number(lng) !== 0);
      await rawDb.execute(rawSql`UPDATE users SET is_online=${isOnline} WHERE id=${driver.id}::uuid`);
      // UPSERT driver_locations � only update lat/lng if we have a real GPS fix; never write 0,0
      if (hasValidCoords) {
        await rawDb.execute(rawSql`
          INSERT INTO driver_locations (driver_id, lat, lng, is_online, updated_at)
          VALUES (${driver.id}::uuid, ${Number(lat)}, ${Number(lng)}, ${isOnline}, NOW())
          ON CONFLICT (driver_id) DO UPDATE SET lat=${Number(lat)}, lng=${Number(lng)}, is_online=${isOnline}, updated_at=NOW()
        `);
      } else {
        await rawDb.execute(rawSql`
          INSERT INTO driver_locations (driver_id, lat, lng, is_online, updated_at)
          VALUES (${driver.id}::uuid, 0, 0, ${isOnline}, NOW())
          ON CONFLICT (driver_id) DO UPDATE SET is_online=${isOnline}, updated_at=NOW()
        `);
      }
      res.json({ success: true, isOnline });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Get profile + wallet + current trip ---------------------------
  app.get("/api/app/driver/profile", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT u.*,
          dd.vehicle_category_id, dd.zone_id, dd.availability_status, dd.avg_rating as driver_rating, dd.total_trips as driver_total_trips,
          vc.name as vehicle_category_name, vc.type as vehicle_category_type, vc.icon as vehicle_category_icon,
          z.name as zone_name,
          (SELECT COUNT(*) FROM trip_requests WHERE driver_id=u.id AND current_status='completed') as completed_trips,
          (SELECT COALESCE(SUM(actual_fare),0) FROM trip_requests WHERE driver_id=u.id AND current_status='completed') as total_earned,
          (SELECT COUNT(*) FROM trip_requests WHERE driver_id=u.id AND current_status='cancelled') as cancelled_trips
        FROM users u
        LEFT JOIN driver_details dd ON dd.user_id = u.id
        LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
        LEFT JOIN zones z ON z.id = dd.zone_id
        WHERE u.id=${driver.id}::uuid
      `);
      const loc = await rawDb.execute(rawSql`SELECT lat, lng, is_online FROM driver_locations WHERE driver_id=${driver.id}::uuid`);
      const d = camelize(r.rows[0]) as any;
      const userObj = {
        id: d.id,
        fullName: d.fullName,
        phone: d.phone,
        email: d.email,
        profilePhoto: d.profilePhoto,
        rating: parseFloat(d.driverRating || d.rating || "5.0"),
        totalRatings: d.totalRatings || 0,
        walletBalance: parseFloat(d.walletBalance || "0"),
        isLocked: d.isLocked || false,
        lockReason: d.lockReason || null,
        isOnline: loc.rows.length ? (loc.rows[0] as any).is_online : false,
        currentLat: loc.rows.length ? (loc.rows[0] as any).lat : null,
        currentLng: loc.rows.length ? (loc.rows[0] as any).lng : null,
        vehicleNumber: d.vehicleNumber || null,
        vehicleModel: d.vehicleModel || null,
        vehicleCategoryId: d.vehicleCategoryId || null,
        vehicleCategory: d.vehicleCategoryName || null,
        vehicleCategoryType: d.vehicleCategoryType || null,
        vehicleCategoryIcon: d.vehicleCategoryIcon || null,
        zoneId: d.zoneId || null,
        zone: d.zoneName || null,
        availabilityStatus: d.availabilityStatus || 'offline',
        stats: {
          completedTrips: parseInt(d.completedTrips || "0"),
          totalEarned: parseFloat(d.totalEarned || "0"),
          cancelledTrips: parseInt(d.cancelledTrips || "0"),
        }
      };
      res.json({ user: userObj, ...userObj });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Incoming trip request (polling) -------------------------------
  app.get("/api/app/driver/incoming-trip", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      // 1. Check if this driver has an active/accepted trip
      const active = await rawDb.execute(rawSql`
        SELECT t.*, c.full_name as customer_name, c.phone as customer_phone, c.rating as customer_rating,
          vc.name as vehicle_name,
          CASE WHEN t.is_for_someone_else THEN t.passenger_name ELSE c.full_name END as contact_name,
          CASE WHEN t.is_for_someone_else THEN t.passenger_phone ELSE c.phone END as contact_phone
        FROM trip_requests t
        LEFT JOIN users c ON c.id = t.customer_id
        LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
        WHERE t.driver_id = ${driver.id}::uuid
          AND t.current_status IN ('driver_assigned','accepted','arrived','on_the_way')
        ORDER BY t.created_at DESC LIMIT 1
      `);
      if (active.rows.length) {
        const stage = (active.rows[0] as any).current_status;
        return res.json({ trip: camelize(active.rows[0]), stage });
      }
      // 2. Check driver location + vehicle category to find matching nearby trips
      const locR = await rawDb.execute(rawSql`
        SELECT dl.lat, dl.lng, dd.vehicle_category_id
        FROM driver_locations dl
        LEFT JOIN driver_details dd ON dd.user_id = dl.driver_id
        WHERE dl.driver_id=${driver.id}::uuid
      `);
      if (!locR.rows.length) return res.json({ trip: null });
      const { lat, lng, vehicle_category_id } = locR.rows[0] as any;
      // Show matching searching trip within 15km radius
      const searching = await rawDb.execute(rawSql`
        SELECT t.*, c.full_name as customer_name, c.phone as customer_phone,
          vc.name as vehicle_name, vc.icon as vehicle_icon,
          ROUND(CAST(SQRT((t.pickup_lat - ${Number(lat)})*(t.pickup_lat - ${Number(lat)}) + (t.pickup_lng - ${Number(lng)})*(t.pickup_lng - ${Number(lng)})) * 111 AS numeric), 1) as distance_km,
          CASE WHEN t.is_for_someone_else THEN t.passenger_name ELSE c.full_name END as contact_name,
          CASE WHEN t.is_for_someone_else THEN t.passenger_phone ELSE c.phone END as contact_phone
        FROM trip_requests t
        LEFT JOIN users c ON c.id = t.customer_id
        LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
        WHERE t.current_status = 'searching' AND t.driver_id IS NULL
          AND t.created_at > NOW() - INTERVAL '10 minutes'
          AND NOT (${driver.id}::uuid = ANY(COALESCE(t.rejected_driver_ids, '{}'::uuid[])))
          ${vehicle_category_id ? rawSql`AND t.vehicle_category_id = ${vehicle_category_id}::uuid` : rawSql``}
          AND (t.pickup_lat - ${Number(lat)})*(t.pickup_lat - ${Number(lat)}) + (t.pickup_lng - ${Number(lng)})*(t.pickup_lng - ${Number(lng)}) < 0.02
        ORDER BY (t.pickup_lat - ${Number(lat)})*(t.pickup_lat - ${Number(lat)}) + (t.pickup_lng - ${Number(lng)})*(t.pickup_lng - ${Number(lng)}) ASC LIMIT 1
      `);
      if (searching.rows.length) {
        return res.json({ trip: camelize(searching.rows[0]), stage: "new_request" });
      }
      res.json({ trip: null });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Active trip (app state recovery) -----------------------------
  // Returns the driver's current in-progress trip so the app can restore TripScreen
  // after a crash, kill, or network loss.
  app.get("/api/app/driver/active-trip", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT t.*, c.full_name as customer_name, c.phone as customer_phone,
          vc.name as vehicle_name
        FROM trip_requests t
        LEFT JOIN users c ON c.id = t.customer_id
        LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
        WHERE t.driver_id = ${driver.id}::uuid
          AND t.current_status IN ('driver_assigned','accepted','arrived','on_the_way')
        ORDER BY t.updated_at DESC LIMIT 1
      `);
      res.json({ trip: r.rows.length ? camelize(r.rows[0]) : null });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Accept trip ---------------------------------------------------
  app.post("/api/app/driver/accept-trip", authApp, requireDriver, driverTripActionLimiter, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { tripId } = req.body;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!tripId || !uuidRe.test(tripId)) return res.status(400).json({ message: "Invalid trip ID" });

      // -- Subscription gate: rides use subscription model; parcels use commission (no gate) --
      const tripTypeR = await rawDb.execute(rawSql`
        SELECT trip_type FROM trip_requests WHERE id=${tripId}::uuid LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      const tripType = (tripTypeR.rows[0] as any)?.trip_type || 'normal';
      const isParcelTrip = tripType === 'parcel' || tripType === 'delivery' || tripType === 'cargo';
      if (!isParcelTrip) {
        // Ride trip: check subscription model setting
        const ridesModelR = await rawDb.execute(rawSql`
          SELECT value FROM revenue_model_settings WHERE key_name='rides_model' LIMIT 1
        `).catch(() => ({ rows: [] as any[] }));
        const ridesModel = (ridesModelR.rows[0] as any)?.value || 'subscription';
        // Both 'subscription' and 'hybrid' models require an active subscription or free period
        if (['subscription', 'hybrid'].includes(ridesModel)) {
          const freeR = await rawDb.execute(rawSql`
            SELECT launch_free_active, free_period_end FROM users WHERE id=${driver.id}::uuid LIMIT 1
          `).catch(() => ({ rows: [] as any[] }));
          const freeRow = freeR.rows[0] as any;
          const inFreePeriod = freeRow?.launch_free_active === true
            && freeRow?.free_period_end
            && new Date(freeRow.free_period_end) >= new Date();
          if (!inFreePeriod) {
            const subR = await rawDb.execute(rawSql`
              SELECT id FROM driver_subscriptions
              WHERE driver_id = ${driver.id}::uuid
                AND is_active = true
                AND end_date > NOW()
              LIMIT 1
            `);
            if (!subR.rows.length) {
              // return res.status(403).json({
              //   message: "Active subscription required to accept rides. Please subscribe to continue.",
              //   code: "SUBSCRIPTION_REQUIRED",
              // });
              console.log(`[DRIVER_ACCEPT] Driver ${driver.id} - Subscription missing, but ALLOWING for test`);
            }
          }
        }
      }

      // -- Account lock check ------------------------------------------------
      if (driver.is_locked || driver.isLocked) {
        // return res.status(403).json({
        //   message: driver.lock_reason || driver.lockReason || "Account locked. Please clear pending dues to accept rides.",
        //   code: "ACCOUNT_LOCKED",
        // });
        console.log(`[DRIVER_ACCEPT] Driver ${driver.id} - Locked, but ALLOWING for test`);
      }

      // Generate pickup OTP
      const otp = Math.floor(1000 + Math.random() * 9000).toString();

      // Atomically claim trip � busy check embedded in WHERE to prevent TOCTOU race:
      // if driver already has an active trip this UPDATE returns 0 rows.
      const r = await rawDb.execute(rawSql`
        UPDATE trip_requests
        SET current_status='accepted', driver_accepted_at=NOW(), driver_arriving_at=NOW(), pickup_otp=${otp}, driver_id=${driver.id}::uuid
        WHERE id=${tripId}::uuid
          AND current_status IN ('searching','driver_assigned')
          AND (driver_id IS NULL OR driver_id=${driver.id}::uuid)
        RETURNING *
      `);
      console.log(`[DRIVER_ACCEPT] Claiming trip ${tripId} for driver ${driver.id}`);
      if (!r.rows.length) {
        // Fallback: Check what the real status is, in case it was hijacked or already completed
        const exists = await rawDb.execute(rawSql`SELECT * FROM trip_requests WHERE id=${tripId}::uuid`);
        if (!exists.rows.length) {
          return res.status(400).json({ message: "Cannot accept trip: Not found" });
        }
        const info = exists.rows[0] as any;
        if (info.current_status === 'accepted') {
          if (info.driver_id === driver.id) {
            // WE ALREADY CLAIMED THIS SUCCESSFULLY (socket updated it before falling back here)
            // Just populate r.rows and proceed.
            r.rows = [info];
          } else {
            return res.status(409).json({ message: "Trip already accepted by another driver" });
          }
        } else {
          if (info.current_status === 'cancelled') return res.status(400).json({ message: "Trip was cancelled by customer" });
          return res.status(400).json({ message: "Cannot accept trip in status: " + info.current_status });
        }
      }

      // Mark driver as on current trip
      await rawDb.execute(rawSql`UPDATE users SET current_trip_id=${tripId}::uuid WHERE id=${driver.id}::uuid`);

      // Notify dispatch engine � clears timers and notifies other drivers
      // Notify dispatch engine – clears timers and notifies other drivers
      onDriverAccepted(tripId, driver.id);

      const tripData = camelize(r.rows[0]) as any;
      const driverVehicleR = await rawDb.execute(rawSql`
        SELECT dd.vehicle_number, dd.vehicle_model, vc.name as vehicle_category
        FROM driver_details dd
        LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
        WHERE dd.user_id = ${driver.id}::uuid
        LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      const driverVehicle = (driverVehicleR.rows[0] as any) || {};

      // -- HARDENING: Notify customer with driver details + setup timeouts --
      try {
        const driverName = driver.fullName || "Pilot";
        const driverPhone = driver.phone || "";
        const driverRating = driver.avgRating || 4.5;

        // Notify customer with multi-channel notification
        await notifyCustomerWithDriver(
          tripData.customerId,
          driver.id,
          tripData.id,
          driverName,
          driverPhone,
          driverRating
        );

        // Setup timeout handlers (2-min timeout if customer doesn't start ride)
        await setupTripTimeoutHandlers(tripData.id, tripData.customerId, driver.id);
      } catch (hardeningErr: any) {
        log('HARDENING-ACCEPT', hardeningErr.message);
      }
      await appendTripStatus(tripData.id, 'driver_assigned', 'driver', 'Driver accepted trip');
      await logRideLifecycleEvent(tripData.id, 'driver_assigned', driver.id, 'driver', { pickupOtp: otp });

      // ?? Socket: notify customer � driver accepted, show pilot details
      if (io) {
        io.to(`user:${tripData.customerId}`).emit("trip:accepted", {
          tripId: tripData.id,
          driverName: driver.fullName || "Pilot",
          driverPhone: driver.phone || "",
          driverPhoto: driver.profilePhoto || null,
          driverRating: driver.avgRating || driver.rating || 0,
          driverVehicleNumber: driverVehicle.vehicle_number || '',
          driverVehicleModel: driverVehicle.vehicle_model || '',
          vehicleName: driverVehicle.vehicle_category || '',
          pickupOtp: otp,
          driverId: driver.id,
          uiState: 'driver_assigned',
          status: 'accepted',
          currentStatus: 'accepted',
          driver: {
            id: driver.id,
            fullName: driver.fullName || "Pilot",
            phone: driver.phone || "",
            rating: driver.avgRating || driver.rating || 0,
            photo: driver.profilePhoto || null,
            vehicleNumber: driverVehicle.vehicle_number || '',
            vehicleModel: driverVehicle.vehicle_model || '',
            vehicleCategory: driverVehicle.vehicle_category || '',
          },
        });
        // Notify other nearby drivers that this trip is taken
        io.emit("trip:taken", { tripId: tripData.id });
      }

      // ?? FCM: notify customer
      const custDevRes = await rawDb.execute(rawSql`SELECT fcm_token FROM user_devices WHERE user_id=${tripData.customerId}::uuid`);
      const custFcmToken = (custDevRes.rows[0] as any)?.fcm_token || null;
      notifyCustomerDriverAccepted({
        fcmToken: custFcmToken,
        driverName: driver.fullName || "Driver",
        tripId: tripData.id,
      }).catch(dbCatch("db"));

      res.json({ success: true, trip: tripData, pickupOtp: otp });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Reject / skip trip ---------------------------------------------
  app.post("/api/app/driver/reject-trip", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { tripId } = req.body;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!tripId || !uuidRe.test(tripId)) return res.json({ success: true });

      // Clear current_trip_id on this driver (defensive � should not be set for searching trips)
      await rawDb.execute(rawSql`UPDATE users SET current_trip_id=NULL WHERE id=${driver.id}::uuid AND current_trip_id=${tripId}::uuid`);

      // Record rejection � keep trip in 'searching', clear driver_id assignment if any
      const tripRes = await rawDb.execute(rawSql`
        UPDATE trip_requests
        SET current_status='searching', driver_id=NULL,
            rejected_driver_ids = array_append(COALESCE(rejected_driver_ids,'{}'), ${driver.id}::uuid)
        WHERE id=${tripId}::uuid AND current_status IN ('driver_assigned','searching','accepted')
          AND (driver_id=${driver.id}::uuid OR driver_id IS NULL)
        RETURNING pickup_lat, pickup_lng, vehicle_category_id, rejected_driver_ids, customer_id,
                  pickup_address, destination_address, estimated_fare
      `);

      if (tripRes.rows.length) {
        // Notify dispatch engine � immediately moves to next driver in queue
        onDriverRejected(tripId, driver.id).catch((err: any) => {
          console.error('[DISPATCH] onDriverRejected error:', err.message);
          // Fallback: legacy re-assignment if dispatch engine not tracking this trip
          if (io) {
            const trip = camelize(tripRes.rows[0]) as any;
            if (trip.customerId) {
              io.to(`user:${trip.customerId}`).emit("trip:searching", { tripId, message: "Looking for another pilot..." });
            }
            const rejectExcludeList = (trip.rejectedDriverIds || []).filter(Boolean);
            findBestDrivers(
              Number(trip.pickupLat), Number(trip.pickupLng),
              trip.vehicleCategoryId || undefined,
              rejectExcludeList, 3
            ).then(nextBestDrivers => {
              for (const nd of nextBestDrivers) {
                io.to(`user:${nd.driverId}`).emit("trip:new_request", {
                  tripId, pickupAddress: trip.pickupAddress || "Pickup",
                  estimatedFare: Number(trip.estimatedFare) || 0,
                });
              }
            }).catch(dbCatch("db"));
          }
        });
      }

      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Verify pickup OTP + start ride --------------------------------
  app.post("/api/app/driver/verify-pickup-otp", authApp, requireDriver, driverTripActionLimiter, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { tripId, otp } = req.body;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!tripId || !uuidRe.test(tripId)) return res.status(400).json({ message: "Invalid trip ID" });
      if (!otp || String(otp).trim().length < 4) return res.status(400).json({ message: "Pickup OTP required" });
      const r = await rawDb.execute(rawSql`
        SELECT *, (SELECT full_name FROM users WHERE id=customer_id) as customer_name,
          (SELECT phone FROM users WHERE id=customer_id) as customer_phone
        FROM trip_requests WHERE id=${tripId}::uuid
          AND driver_id=${driver.id}::uuid
          AND current_status = 'arrived'
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Trip not found" });
      const trip = r.rows[0] as any;
      if (trip.pickup_otp !== otp) return res.status(400).json({ message: "Wrong OTP. Please check with sender." });
      // OTP expiry: valid for 40 minutes from when driver accepted the trip
      if (trip.driver_accepted_at) {
        const acceptedAt = new Date(trip.driver_accepted_at).getTime();
        if (Date.now() - acceptedAt > 40 * 60 * 1000) {
          return res.status(400).json({ message: "OTP has expired. Please ask customer to regenerate." });
        }
      }
      const updated = await rawDb.execute(rawSql`
        UPDATE trip_requests SET current_status='on_the_way', ride_started_at=NOW()
        WHERE id=${tripId}::uuid RETURNING *
      `);
      const updatedTrip = camelize(updated.rows[0]);
      await appendTripStatus(tripId, 'trip_started', 'driver', 'Pickup OTP verified');
      await logRideLifecycleEvent(tripId, 'trip_started', driver.id, 'driver', { via: 'verify-pickup-otp' });

      // ?? For parcel - send delivery OTP to receiver via SMS when pickup is done
      if ((trip.trip_type === 'parcel' || trip.trip_type === 'delivery') && trip.delivery_otp && trip.receiver_phone) {
        sendCustomSms(trip.receiver_phone,
          `JAGO Pro Parcel: Package picked up by driver ${driver.fullName || ''}. Delivery OTP: ${trip.delivery_otp}. Share this to receive your parcel.`
        ).catch(dbCatch("db"));
      }

      if (io) {
        // Fetch driver vehicle info for the broadcast
        const vR = await rawDb.execute(rawSql`
          SELECT dd.vehicle_number, dd.vehicle_model, vc.name as vehicle_category
          FROM driver_details dd
          LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
          WHERE dd.user_id = ${driver.id}::uuid LIMIT 1
        `).catch(() => ({ rows: [] }));
        const vehicle = vR.rows[0] as any || {};

        const payload = {
          tripId,
          status: "on_the_way",
          otp,
          uiState: 'trip_started',
          driver: {
            id: driver.id,
            fullName: driver.fullName,
            phone: driver.phone,
            rating: driver.rating,
            photo: driver.profilePhoto,
            vehicleNumber: vehicle.vehicle_number || '',
            vehicleModel: vehicle.vehicle_model || '',
            vehicleCategory: vehicle.vehicle_category || '',
            lat: updatedTrip.currentLat,
            lng: updatedTrip.currentLng
          }
        };
        io.to(`user:${updatedTrip.customerId}`).emit("trip:status_update", payload);
        io.to(`trip:${tripId}`).emit("trip:status_update", payload);
      }
      res.json({ success: true, trip: updatedTrip });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Verify delivery OTP (Parcel) ---------------------------------
  app.post("/api/app/driver/verify-delivery-otp", authApp, requireDriver, driverTripActionLimiter, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { tripId, otp } = req.body;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!tripId || !uuidRe.test(tripId)) return res.status(400).json({ message: "Invalid trip ID" });
      if (!otp || String(otp).trim().length < 4) return res.status(400).json({ message: "Delivery OTP required" });
      const r = await rawDb.execute(rawSql`
        SELECT * FROM trip_requests WHERE id=${tripId}::uuid AND driver_id=${driver.id}::uuid
          AND trip_type IN ('parcel','delivery') AND current_status='on_the_way'
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Parcel trip not found or not in transit" });
      const trip = r.rows[0] as any;
      if (String(trip.delivery_otp || '').trim() !== String(otp).trim()) return res.status(400).json({ message: "Wrong delivery OTP. Please check with receiver." });
      await rawDb.execute(rawSql`
        UPDATE trip_requests SET delivery_otp = NULL, updated_at = NOW()
        WHERE id=${tripId}::uuid AND driver_id=${driver.id}::uuid
      `);
      res.json({ success: true, message: "Delivery OTP verified. Complete the trip." });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Arrived at pickup ---------------------------------------------
  app.post("/api/app/driver/arrived", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { tripId } = req.body;
      if (!tripId) return res.status(400).json({ message: "tripId required" });
      const updR = await rawDb.execute(rawSql`
        UPDATE trip_requests SET current_status='arrived', driver_arrived_at=NOW()
        WHERE id=${tripId}::uuid AND driver_id=${driver.id}::uuid
          AND current_status IN ('accepted','driver_assigned')
        RETURNING id, pickup_otp, customer_id
      `);
      if (!updR.rows.length) {
        const check = await rawDb.execute(rawSql`SELECT current_status FROM trip_requests WHERE id=${tripId}::uuid`);
        const st = (check.rows[0] as any)?.current_status;
        if (!st) return res.status(404).json({ message: "Trip not found" });
        return res.status(400).json({ message: `Cannot mark arrived in status: ${st}` });
      }
      // Get pickup OTP + passenger info + customer FCM token
      const r = await rawDb.execute(rawSql`
        SELECT t.pickup_otp, t.customer_id, t.passenger_phone, t.passenger_name,
          t.is_for_someone_else, t.trip_type, c.phone as customer_phone, c.full_name as customer_name
        FROM trip_requests t
        LEFT JOIN users c ON c.id = t.customer_id
        WHERE t.id=${tripId}::uuid
      `);
      const tripRow = r.rows[0] as any;
      const otp = tripRow?.pickup_otp;
      await appendTripStatus(tripId, 'driver_arriving', 'driver', 'Driver reached pickup');
      await logRideLifecycleEvent(tripId, 'driver_arriving', driver.id, 'driver');

      // ?? Notify customer � driver arrived, show OTP
      const custDevRes = await rawDb.execute(rawSql`SELECT fcm_token FROM user_devices WHERE user_id=${tripRow.customer_id}::uuid`);
      const custFcmToken = (custDevRes.rows[0] as any)?.fcm_token || null;
      notifyCustomerDriverArrived({
        fcmToken: custFcmToken,
        driverName: driver.fullName || "Driver",
        otp: otp || "",
        tripId,
      }).catch(dbCatch("db"));

      // ?? If booked for someone else � send OTP as SMS to passenger phone
      if (tripRow?.is_for_someone_else && tripRow?.passenger_phone) {
        sendCustomSms(tripRow.passenger_phone,
          `JAGO Pro: Your ride OTP is ${otp}. Share with driver ${driver.fullName || ''} to start. Ref: ${tripId.slice(-6).toUpperCase()}`
        ).catch(dbCatch("db"));
      }
      // ?? For parcel � remind sender with pickup OTP via SMS
      if (tripRow?.trip_type === 'parcel' || tripRow?.trip_type === 'delivery') {
        const senderPhone = tripRow.customer_phone;
        if (senderPhone) sendCustomSms(senderPhone,
          `JAGO Pro Parcel: Driver ${driver.fullName || ''} arrived. Pickup OTP: ${otp}. Share to hand over parcel.`
        ).catch(dbCatch("db"));
      }

      if (io && tripRow?.customer_id) {
        io.to(`user:${tripRow.customer_id}`).emit("trip:status_update", { tripId, status: "arrived", otp, uiState: 'driver_arriving' });
        io.to(`trip:${tripId}`).emit("trip:status_update", { tripId, status: "arrived", otp, uiState: 'driver_arriving' });
      }

      res.json({ success: true, pickupOtp: otp });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Start trip (arrived ? on_the_way) ----------------------------
  app.post("/api/app/driver/start-trip", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { tripId, pickupOtp } = req.body;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!tripId || !uuidRe.test(tripId)) return res.status(400).json({ message: "Invalid trip ID" });
      const tripInfo = await rawDb.execute(rawSql`
        SELECT current_status, pickup_otp, trip_type FROM trip_requests
        WHERE id=${tripId}::uuid AND driver_id=${driver.id}::uuid
      `);
      if (!tripInfo.rows.length) return res.status(404).json({ message: "Trip not found" });
      const tripRow = tripInfo.rows[0] as any;
      if (tripRow.current_status !== 'arrived') {
        return res.status(400).json({ message: `Cannot start trip in status: ${tripRow.current_status}` });
      }
      if (!pickupOtp || !String(pickupOtp).trim()) {
        return res.status(400).json({ message: "Pickup OTP is required" });
      }
      if (tripRow.pickup_otp && pickupOtp !== tripRow.pickup_otp) {
        return res.status(400).json({ message: "Invalid OTP" });
      }
      const startR = await rawDb.execute(rawSql`
        UPDATE trip_requests SET current_status='on_the_way', ride_started_at=COALESCE(ride_started_at, NOW())
        WHERE id=${tripId}::uuid AND driver_id=${driver.id}::uuid
        RETURNING id
      `);
      if (!startR.rows.length) return res.status(400).json({ message: "Trip update failed � driver mismatch or trip already moved" });
      await appendTripStatus(tripId, 'trip_started', 'driver', 'Trip started from driver app');
      await logRideLifecycleEvent(tripId, 'trip_started', driver.id, 'driver', { via: 'start-trip' });
      // ?? Heatmap: confirmed pickup demand signal � fetch pickup coords from trip
      rawDb.execute(rawSql`SELECT pickup_lat, pickup_lng, trip_type FROM trip_requests WHERE id=${tripId}::uuid LIMIT 1`)
        .then(r2 => {
          const t2 = r2.rows[0] as any;
          if (t2?.pickup_lat && t2?.pickup_lng) {
            const svc = (t2.trip_type === 'parcel' || t2.trip_type === 'delivery') ? 'parcel' : 'ride';
            logHeatmapEvent('pickup', parseFloat(t2.pickup_lat), parseFloat(t2.pickup_lng), svc);
          }
        }).catch(dbCatch("db"));
      res.json({ success: true, message: "Trip started" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Complete trip -------------------------------------------------
  app.post("/api/app/driver/complete-trip", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { tripId, actualFare, actualDistance, tips = 0 } = req.body;
      // Input validation
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!tripId || !uuidRe.test(tripId)) return res.status(400).json({ message: "Invalid trip ID" });
      const tipsVal = Math.min(Math.max(0, parseFloat(tips) || 0), 500); // Cap tips at ?500
      // Get trip details to use estimated_fare as fallback
      const tripInfo = await rawDb.execute(rawSql`
        SELECT tr.estimated_fare, tr.estimated_distance, tr.current_status, tr.payment_method,
               tr.customer_id, tr.trip_type, tr.type, tr.delivery_otp, tr.seats_booked,
               vc.name as vehicle_name, vc.vehicle_type as vehicle_type_field,
               vc.is_carpool, vc.total_seats
        FROM trip_requests tr
        LEFT JOIN vehicle_categories vc ON vc.id = tr.vehicle_category_id
        WHERE tr.id=${tripId}::uuid AND tr.driver_id=${driver.id}::uuid`);
      if (!tripInfo.rows.length) return res.status(404).json({ message: "Trip not found" });
      const tripRow = tripInfo.rows[0] as any;
      if (tripRow.current_status !== 'on_the_way') return res.status(400).json({ message: `Cannot complete trip in status: ${tripRow.current_status}. Ride must be in progress.` });
      if ((tripRow.trip_type === 'parcel' || tripRow.trip_type === 'delivery') && tripRow.delivery_otp) {
        return res.status(400).json({ message: "Verify delivery OTP before completing this parcel trip." });
      }
      const estimatedFareVal = parseFloat(tripRow.estimated_fare) || 0;
      let fare = parseFloat(actualFare) || estimatedFareVal;
      if (!fare || fare <= 0) return res.status(400).json({ message: "Fare amount is invalid" });

      // -- HARDENING: Validate fare accuracy before capping --
      try {
        const fareValidation = await validateFareAccuracy(tripId, estimatedFareVal, fare, tripRow.customer_id);
        if (fareValidation.refundRequired) {
          fare = fare - fareValidation.refundAmount;
        }
      } catch (hardeningErr: any) {
        log('HARDENING-COMPLETE-FARE', hardeningErr.message);
      }

      // Cap actual fare to 1.5x estimated fare to prevent fare manipulation
      if (estimatedFareVal > 0 && fare > estimatedFareVal * 1.5) fare = Math.round(estimatedFareVal * 1.5 * 100) / 100;
      // Absolute cap at ?10,000 per ride
      if (fare > 10000) fare = 10000;
      // SECURITY: All money math in integer paise to avoid floating-point drift
      const farePaise = Math.round(fare * 100);

      // -- Pricing: user discount (first 2 rides = 50% off) -----------------
      const customerRow = tripRow.customer_id
        ? (await rawDb.execute(rawSql`SELECT completed_rides_count FROM users WHERE id=${tripRow.customer_id}::uuid LIMIT 1`).catch(() => ({ rows: [] }))).rows[0] as any
        : null;
      const completedRidesCount = parseInt(customerRow?.completed_rides_count ?? '0') || 0;
      const rideFullFare = farePaise / 100;
      const userDiscountPaise = completedRidesCount < 2 ? Math.round(farePaise * 0.50) : 0;
      const userDiscount = userDiscountPaise / 100;
      const userPayable = (farePaise - userDiscountPaise) / 100;

      // -- Car Pool: per-seat fare -------------------------------------------
      const seatsBooked = parseInt(tripRow.seats_booked ?? '1') || 1;
      const isCarpool = tripRow.is_carpool === true || tripRow.is_carpool === 'true';
      const carpoolSeats = parseInt(tripRow.total_seats ?? '4') || 4;
      const seatPrice = isCarpool ? Math.round(farePaise / carpoolSeats) / 100 : 0;
      const vehicleTypeName = tripRow.vehicle_name || tripRow.vehicle_type_field || null;

      // -- GST: 5% of full ride fare (government tax, always deducted from driver credit) --
      const gstPctR = await rawDb.execute(rawSql`SELECT value FROM revenue_model_settings WHERE key_name='ride_gst_rate' LIMIT 1`).catch(() => ({ rows: [] as any[] }));
      const rideGstRatePct = Math.round(parseFloat((gstPctR.rows[0] as any)?.value || '5') * 100); // e.g. 500 = 5%
      const gstPaise = Math.round(farePaise * rideGstRatePct / 10000);
      const gstAmount = gstPaise / 100;

      const r = await rawDb.execute(rawSql`
        UPDATE trip_requests
        SET current_status='completed', ride_ended_at=NOW(),
            actual_fare=${fare}, actual_distance=${parseFloat(actualDistance) || parseFloat(tripRow.estimated_distance) || 0},
            tips=${tipsVal}, payment_status=CASE WHEN payment_status IN ('paid_online','wallet_paid','partial_payment') THEN payment_status ELSE 'paid' END,
            ride_full_fare=${rideFullFare}, user_discount=${userDiscount},
            user_payable=${userPayable}, gst_amount=${gstAmount},
            vehicle_type_name=${vehicleTypeName},
            seats_booked=${seatsBooked}, seat_price=${seatPrice}
        WHERE id=${tripId}::uuid AND driver_id=${driver.id}::uuid
          AND current_status = 'on_the_way'
        RETURNING *
      `);
      if (!r.rows.length) {
        const exists = await rawDb.execute(rawSql`SELECT current_status FROM trip_requests WHERE id=${tripId}::uuid AND driver_id=${driver.id}::uuid`);
        const s = (exists.rows[0] as any)?.current_status;
        if (!s) return res.status(404).json({ message: "Trip not found" });
        return res.status(400).json({ message: `Cannot complete trip in status: ${s}. Ride must be on_the_way.` });
      }

      // -- Revenue: Calculate breakdown + settle (unified engine) --------------
      const tripServiceType = (tripRow.trip_type || tripRow.type || 'normal');
      const serviceCategory: any =
        tripServiceType === 'parcel' ? 'parcel'
          : tripServiceType === 'cargo' ? 'cargo'
            : tripServiceType === 'intercity' ? 'intercity'
              : (tripServiceType === 'city_pool' || tripServiceType === 'carpool') ? 'city_pool'
                : tripServiceType === 'outstation_pool' ? 'outstation_pool'
                  : 'rides';

      const breakdown = await calculateRevenueBreakdown(fare, serviceCategory, driver.id);
      const deductAmount = breakdown.total;
      const driverWalletCredit = breakdown.driverEarnings;
      const launchFreeApplied = breakdown.model === 'launch_free';

      // Save pricing fields on trip
      await rawDb.execute(rawSql`
        UPDATE trip_requests
        SET commission_amount=${deductAmount},
            driver_wallet_credit=${driverWalletCredit},
            driver_fare=${driverWalletCredit},
            customer_fare=${userPayable}
        WHERE id=${tripId}::uuid
      `);

      // Customer wallet pre-check for wallet?cash fallback
      const paymentMethod = (tripRow.payment_method || 'cash').toLowerCase();
      let customerWalletBalance: number | undefined;
      if (paymentMethod === 'wallet' && tripRow.customer_id) {
        try {
          const cwRes = await rawDb.execute(rawSql`SELECT wallet_balance FROM users WHERE id=${tripRow.customer_id}::uuid`);
          customerWalletBalance = parseFloat((cwRes.rows[0] as any)?.wallet_balance || '0');
        } catch (_) { }
      }

      // Settle: driver wallet, commission_settlements, GST wallet, admin_revenue, auto-lock
      if (deductAmount > 0) {
        await settleRevenue({
          driverId: driver.id,
          tripId,
          fare,
          paymentMethod: paymentMethod as any,
          breakdown,
          serviceCategory,
          serviceLabel: tripServiceType || 'ride',
          customerWalletBalance,
        });
      }

      // -- Customer wallet deduction: use userPayable (discounted amount) ----
      const tripPaymentMethod = tripRow.payment_method || 'cash';
      const tripCustomerId = tripRow.customer_id;
      let walletPendingAmount = 0; // amount still owed after wallet attempt
      let walletPaidAmount = 0;    // amount successfully deducted from wallet
      if (tripPaymentMethod === 'wallet' && tripCustomerId) {
        try {
          // ATOMIC: Single UPDATE prevents race condition � balance can never go negative
          const fullDeductR = await rawDb.execute(rawSql`
            UPDATE users SET wallet_balance = wallet_balance - ${userPayable}
            WHERE id=${tripCustomerId}::uuid AND wallet_balance >= ${userPayable}
            RETURNING wallet_balance
          `);
          const custBal = fullDeductR.rows.length
            ? parseFloat((fullDeductR.rows[0] as any).wallet_balance || '0') + userPayable
            : parseFloat(((await rawDb.execute(rawSql`SELECT wallet_balance FROM users WHERE id=${tripCustomerId}::uuid`)).rows[0] as any)?.wallet_balance || '0');
          if (fullDeductR.rows.length) {
            // Full wallet deduction succeeded atomically
            const newCustBal = parseFloat((fullDeductR.rows[0] as any).wallet_balance || '0');
            walletPaidAmount = userPayable;
            await rawDb.execute(rawSql`
              INSERT INTO transactions (user_id, account, credit, debit, balance, transaction_type, ref_transaction_id)
              VALUES (${tripCustomerId}::uuid, ${'Ride payment via Wallet'}, 0, ${userPayable}, ${newCustBal}, ${'ride_payment'}, ${tripId})
            `).catch(dbCatch("db"));
            console.log(`[WALLET] ? Full deduction ?${userPayable} from customer ${tripCustomerId}`);
          } else if (custBal > 0) {
            // Partial wallet deduction � ATOMIC: CTE captures old balance, zeroes it in one statement
            const partialR = await rawDb.execute(rawSql`
              WITH prev AS (SELECT wallet_balance FROM users WHERE id=${tripCustomerId}::uuid FOR UPDATE)
              UPDATE users SET wallet_balance = 0
              FROM prev
              WHERE users.id = ${tripCustomerId}::uuid AND prev.wallet_balance > 0
              RETURNING prev.wallet_balance AS prev_balance
            `);
            if (!partialR.rows.length) {
              // Balance already zeroed by a concurrent transaction � treat as no wallet
              await rawDb.execute(rawSql`
                UPDATE trip_requests SET payment_status='pending_payment',
                  pending_payment_amount=${userPayable} WHERE id=${tripId}::uuid
              `).catch(dbCatch("db"));
              walletPendingAmount = userPayable;
              console.log(`[WALLET] ??  Partial skipped (balance=0 by concurrent tx) � customer ${tripCustomerId}`);
            } else {
              const deducted = parseFloat(parseFloat((partialR.rows[0] as any).prev_balance || '0').toFixed(2));
              const remaining = parseFloat((userPayable - deducted).toFixed(2));
              await rawDb.execute(rawSql`
                UPDATE trip_requests SET payment_status='partial_payment',
                  pending_payment_amount=${remaining} WHERE id=${tripId}::uuid
              `).catch(dbCatch("db"));
              await rawDb.execute(rawSql`
                INSERT INTO transactions (user_id, account, credit, debit, balance, transaction_type, ref_transaction_id)
                VALUES (${tripCustomerId}::uuid, ${'Partial ride payment via Wallet'}, 0, ${deducted}, 0, ${'ride_payment'}, ${tripId})
              `).catch(dbCatch("db"));
              walletPaidAmount = deducted;
              walletPendingAmount = remaining;
              console.log(`[WALLET] ??  Partial: ?${deducted} from wallet, ?${remaining} pending (cash/UPI) � customer ${tripCustomerId}`);
            }
          } else {
            // No wallet balance � full amount must be paid by cash/UPI
            await rawDb.execute(rawSql`
              UPDATE trip_requests SET payment_status='pending_payment',
                pending_payment_amount=${userPayable} WHERE id=${tripId}::uuid
            `).catch(dbCatch("db"));
            walletPendingAmount = userPayable;
            console.log(`[WALLET] ??  No balance: full ?${userPayable} pending (cash/UPI) � customer ${tripCustomerId}`);
          }
        } catch (_) { }
      }

      // Record transaction for online/razorpay payments
      if ((tripPaymentMethod === 'online' || tripPaymentMethod === 'upi' || tripPaymentMethod === 'razorpay') && tripCustomerId) {
        try {
          const custWalRes2 = await rawDb.execute(rawSql`SELECT wallet_balance FROM users WHERE id=${tripCustomerId}::uuid`);
          const custBal2 = parseFloat((custWalRes2.rows[0] as any)?.wallet_balance || '0');
          await rawDb.execute(rawSql`
            INSERT INTO transactions (user_id, account, credit, debit, balance, transaction_type, ref_transaction_id)
            VALUES (${tripCustomerId}::uuid, ${'Ride payment via UPI/Online'}, 0, ${userPayable}, ${custBal2}, ${'ride_payment'}, ${tripId})
            ON CONFLICT (ref_transaction_id, transaction_type) WHERE ref_transaction_id IS NOT NULL DO NOTHING
          `).catch((e: any) => console.error('[CUST-ONLINE-TX]', e.message));
        } catch (e: any) { console.error('[CUST-ONLINE-TX-OUTER]', e.message); }
      }

      // Driver earnings transaction handled by settleRevenue()

      // -- Increment customer's completed_rides_count ----------------------
      if (tripCustomerId) {
        await rawDb.execute(rawSql`
          UPDATE users SET completed_rides_count = completed_rides_count + 1 WHERE id=${tripCustomerId}::uuid
        `).catch(dbCatch("db"));
      }

      // ? Clear driver's current trip � driver is now free for the next ride
      await rawDb.execute(rawSql`UPDATE users SET current_trip_id=NULL WHERE id=${driver.id}::uuid`);

      // AI: Update driver performance stats + clear trip waypoints
      updateDriverStats(driver.id).catch(dbCatch("db"));
      clearTripWaypoints(tripId);

      const completedTrip = camelize(r.rows[0]) as any;
      await appendTripStatus(tripId, 'trip_completed', 'driver', 'Trip completed by driver');
      await logRideLifecycleEvent(tripId, 'trip_completed', driver.id, 'driver', { fare, actualDistance });

      // ?? Socket: notify customer ? enriched with discount/GST breakdown + wallet status
      if (io && completedTrip.customerId) {
        const socketPayload = {
          tripId,
          status: "completed",
          currentStatus: "completed",
          fare: rideFullFare,
          actualFare: userPayable,
          userDiscount,
          userPayable,
          gstAmount,
          driverWalletCredit,
          actualDistance: parseFloat(actualDistance) || parseFloat((tripRow as any).estimated_distance) || 0,
          paymentMethod: tripRow.payment_method || 'cash',
          platformDeduction: deductAmount,
          launchOfferApplied: userDiscount > 0,
          uiState: 'trip_completed',
          walletPaidAmount,
          walletPendingAmount,
          requiresCashPayment: walletPendingAmount > 0,
        };
        // Emit to status_update for TrackingScreen
        io.to(`user:${completedTrip.customerId}`).emit("trip:status_update", socketPayload);
        io.to(`trip:${tripId}`).emit("trip:status_update", socketPayload);

        // Also emit to specific completed event if needed
        io.to(`user:${completedTrip.customerId}`).emit("trip:completed", socketPayload);
        io.to(`trip:${tripId}`).emit("trip:completed", socketPayload);
      }

      // ?? FCM: notify customer
      const custDevResComp = await rawDb.execute(rawSql`SELECT fcm_token FROM user_devices WHERE user_id=${completedTrip.customerId}::uuid`);
      const custFcmComp = (custDevResComp.rows[0] as any)?.fcm_token || null;
      notifyCustomerTripCompleted({ fcmToken: custFcmComp, fare: userPayable, tripId }).catch(dbCatch("db"));

      res.json({
        success: true,
        trip: completedTrip,
        pricing: {
          rideFare: rideFullFare,
          userDiscount,
          userPayable,
          gstAmount,
          driverWalletCredit,
          platformDeduction: deductAmount,
          launchOfferApplied: userDiscount > 0,
          launchDriverFree: launchFreeApplied,
          breakdown,
        },
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Cancel trip ---------------------------------------------------
  app.post("/api/app/driver/cancel-trip", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { tripId, reason } = req.body;
      // Get trip details first
      const tripDetails = await rawDb.execute(rawSql`
        SELECT * FROM trip_requests WHERE id=${tripId}::uuid AND driver_id=${driver.id}::uuid AND current_status IN ('driver_assigned','accepted','arrived')
      `);
      if (!tripDetails.rows.length) return res.status(400).json({ message: "Cannot cancel this trip" });
      const trip = camelize(tripDetails.rows[0]) as any;

      // Reset trip to 'searching' � auto-reassign to next driver
      await rawDb.execute(rawSql`
        UPDATE trip_requests SET current_status='searching', driver_id=NULL, pickup_otp=NULL,
          driver_accepted_at=NULL, cancel_reason=${reason || 'Driver cancelled'}, updated_at=NOW()
        WHERE id=${tripId}::uuid
      `);
      await appendTripStatus(tripId, 'requested', 'driver', reason || 'Driver cancelled, reassigned');
      await logRideLifecycleEvent(tripId, 'driver_reassigned', driver.id, 'driver', { reason: reason || 'Driver cancelled' });
      // Free the driver
      await rawDb.execute(rawSql`UPDATE users SET current_trip_id=NULL WHERE id=${driver.id}::uuid`);

      // -- Cancel penalty: ?10 fine after 3rd cancel in 24 hours -------------
      try {
        const cancelCountR = await rawDb.execute(rawSql`
          SELECT COUNT(*) as cnt FROM trip_requests
          WHERE driver_id = ${driver.id}::uuid
            AND cancelled_by = 'driver'
            AND updated_at > NOW() - INTERVAL '24 hours'
        `);
        const cancelCount = parseInt((cancelCountR.rows[0] as any)?.cnt || '0', 10) + 1;
        if (cancelCount >= 3) {
          const penaltyR = await rawDb.execute(rawSql`
            SELECT value FROM business_settings WHERE key_name='driver_cancel_penalty' LIMIT 1
          `).catch(() => ({ rows: [] as any[] }));
          const penalty = parseFloat((penaltyR.rows[0] as any)?.value || '10');
          await rawDb.execute(rawSql`
            UPDATE users SET wallet_balance = wallet_balance - ${penalty}
            WHERE id = ${driver.id}::uuid AND wallet_balance >= ${penalty}
          `);
          await rawDb.execute(rawSql`
            INSERT INTO driver_payments (driver_id, amount, payment_type, status, description)
            VALUES (${driver.id}::uuid, ${penalty}, 'cancel_penalty', 'completed',
              ${'Auto-deducted: ' + cancelCount + ' cancellations in 24h'})
          `).catch(dbCatch("db"));
          log(`[CancelPenalty] Driver ${driver.id} fined ?${penalty} (${cancelCount} cancels in 24h)`, 'cancel');
        }
        // Mark this cancel as cancelled_by=driver on the trip
        await rawDb.execute(rawSql`
          UPDATE trip_requests SET cancelled_by='driver' WHERE id=${tripId}::uuid
        `).catch(dbCatch("db"));
      } catch (_) { }
      clearTripWaypoints(tripId);

      // Notify customer � driver cancelled, now searching again
      if (io && trip.customerId) {
        io.to(`user:${trip.customerId}`).emit("trip:searching", {
          tripId, message: "Your previous pilot cancelled. Looking for a new one...",
        });
      }

      // AI-scored reassignment after driver cancellation
      const cancelNextBest = await findBestDrivers(
        Number(trip.pickupLat), Number(trip.pickupLng),
        trip.vehicleCategoryId || undefined,
        [driver.id],
        3
      );

      if (cancelNextBest.length) {
        for (const nd of cancelNextBest) {
          if (io) io.to(`user:${nd.driverId}`).emit("trip:new_request", {
            tripId,
            pickupAddress: trip.pickupAddress,
            destinationAddress: trip.destinationAddress,
            pickupLat: trip.pickupLat,
            pickupLng: trip.pickupLng,
            estimatedFare: trip.estimatedFare || 0,
            tripType: trip.tripType || 'ride',
          });
          const dDevRes = await rawDb.execute(rawSql`SELECT fcm_token FROM user_devices WHERE user_id=${nd.driverId}::uuid`);
          const dFcm = (dDevRes.rows[0] as any)?.fcm_token;
          if (dFcm) notifyDriverNewRide({ fcmToken: dFcm, driverName: nd.fullName, customerName: "Customer", tripId, pickupAddress: trip.pickupAddress, estimatedFare: trip.estimatedFare || 0 }).catch(dbCatch("db"));
        }
      } else {
        // No drivers available � cancel trip and notify customer via both socket + FCM
        await rawDb.execute(rawSql`
          UPDATE trip_requests SET current_status='cancelled', cancel_reason='No drivers available after reassignment'
          WHERE id=${tripId}::uuid AND current_status='searching'
        `).catch(dbCatch("db"));
        const custDevRes = await rawDb.execute(rawSql`SELECT fcm_token FROM user_devices WHERE user_id=${trip.customerId}::uuid`);
        const custFcm = (custDevRes.rows[0] as any)?.fcm_token || null;
        notifyTripCancelled({ fcmToken: custFcm, cancelledBy: "driver", tripId }).catch(dbCatch("db"));
        if (io && trip.customerId) {
          io.to(`user:${trip.customerId}`).emit("trip:no_drivers", {
            tripId, message: "Sorry, no pilots available in your area right now. Please try again.",
          });
        }
      }
      res.json({ success: true, reassigned: cancelNextBest.length > 0 });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Trip history --------------------------------------------------
  app.get("/api/app/driver/trips", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { status, limit = 20, offset = 0 } = req.query;
      const r = await rawDb.execute(rawSql`
        SELECT t.*, c.full_name as customer_name, c.phone as customer_phone
        FROM trip_requests t
        LEFT JOIN users c ON c.id = t.customer_id
        WHERE t.driver_id = ${driver.id}::uuid
        ${status ? rawSql`AND t.current_status = ${status as string}` : rawSql``}
        ORDER BY t.created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `);
      const cnt = await rawDb.execute(rawSql`SELECT COUNT(*) as total FROM trip_requests WHERE driver_id=${driver.id}::uuid ${status ? rawSql`AND current_status=${status as string}` : rawSql``}`);
      const trips = camelize(r.rows);
      res.json({ trips, total: Number((cnt.rows[0] as any).total) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Rate customer -------------------------------------------------
  app.post("/api/app/driver/rate-customer", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { tripId, rating, note } = req.body;
      const parsedRating = parseFloat(rating);
      if (!tripId || isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
        return res.status(400).json({ message: "tripId required and rating must be 1-5" });
      }
      const tripR = await rawDb.execute(rawSql`
        SELECT customer_id FROM trip_requests
        WHERE id=${tripId}::uuid AND driver_id=${driver.id}::uuid AND current_status='completed'
      `);
      if (!tripR.rows.length) return res.status(404).json({ message: "Completed trip not found" });
      const customerId = (tripR.rows[0] as any).customer_id;
      await rawDb.execute(rawSql`UPDATE trip_requests SET customer_rating=${parsedRating}, driver_note=${note || ''} WHERE id=${tripId}::uuid AND driver_id=${driver.id}::uuid`);
      // Update customer rating average
      await rawDb.execute(rawSql`
        UPDATE users SET
          rating = (rating * total_ratings + ${parsedRating}) / (total_ratings + 1),
          total_ratings = total_ratings + 1
        WHERE id=${customerId}::uuid
      `);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Get wallet summary ---------------------------------------------
  app.get("/api/app/driver/wallet", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT wallet_balance, is_locked, lock_reason, pending_payment_amount,
               pending_commission_balance, pending_gst_balance, total_pending_balance, lock_threshold
        FROM users WHERE id=${driver.id}::uuid LIMIT 1
      `);
      const payments = await rawDb.execute(rawSql`SELECT * FROM driver_payments WHERE driver_id=${driver.id}::uuid ORDER BY created_at DESC LIMIT 50`);
      const wdReqs = await rawDb.execute(rawSql`SELECT * FROM withdraw_requests WHERE user_id=${driver.id}::uuid ORDER BY created_at DESC LIMIT 20`).catch(() => ({ rows: [] }));
      const d = r.rows[0] as any;
      const bal = parseFloat(d?.wallet_balance || 0);
      const totalPending = parseFloat(d?.total_pending_balance ?? '0');
      const lockThreshold = parseFloat(d?.lock_threshold ?? '200');
      const historyRows = camelize(payments.rows).map((p: any) => ({
        ...p,
        type: p.paymentType || p.type || 'deduction',
        description: p.description || 'Platform charge',
        date: p.createdAt,
        amount: parseFloat(p.amount || 0),
      }));
      // -- Subscription status -----------------------------------------------
      const subR = await rawDb.execute(rawSql`
        SELECT ds.id, ds.is_active, ds.end_date, ds.payment_status, sp.name as plan_name, sp.price
        FROM driver_subscriptions ds
        LEFT JOIN subscription_plans sp ON sp.id = ds.plan_id
        WHERE ds.driver_id = ${driver.id}::uuid
        ORDER BY ds.created_at DESC LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      const subRow: any = subR.rows[0] || null;
      const hasActiveSub = subRow && subRow.is_active && new Date(subRow.end_date) > new Date();

      res.json({
        walletBalance: bal,
        balance: bal,
        isLocked: d?.is_locked || false,
        lockReason: d?.lock_reason || null,
        pendingPaymentAmount: parseFloat(d?.pending_payment_amount || 0),
        pendingCommission: parseFloat(d?.pending_commission_balance ?? '0'),
        pendingGst: parseFloat(d?.pending_gst_balance ?? '0'),
        totalPendingBalance: totalPending,
        lockThreshold,
        history: historyRows,
        transactions: historyRows,
        withdrawRequests: wdReqs.rows.map(camelize),
        subscription: subRow ? {
          planName: subRow.plan_name || 'Unknown Plan',
          price: parseFloat(subRow.price ?? 0),
          endDate: subRow.end_date,
          isActive: !!hasActiveSub,
          paymentStatus: subRow.payment_status,
          daysLeft: hasActiveSub
            ? Math.max(0, Math.ceil((new Date(subRow.end_date).getTime() - Date.now()) / 86400000))
            : 0,
        } : null,
        subscriptionRequired: true,
        canAcceptRides: !!hasActiveSub && !(d?.is_locked),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Commission settlement status (detailed breakdown) ----------------
  app.get("/api/app/driver/settlement-status", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT wallet_balance, is_locked, lock_reason,
               pending_commission_balance, pending_gst_balance, total_pending_balance, lock_threshold
        FROM users WHERE id=${driver.id}::uuid LIMIT 1
      `);
      const row: any = r.rows[0] || {};
      const pendingCommission = parseFloat(row.pending_commission_balance ?? '0');
      const pendingGst = parseFloat(row.pending_gst_balance ?? '0');
      const totalPending = parseFloat(row.total_pending_balance ?? '0');
      const lockThreshold = parseFloat(row.lock_threshold ?? '200');
      const recent = await rawDb.execute(rawSql`
        SELECT settlement_type, total_amount, direction, balance_before, balance_after,
               payment_method, status, description, created_at
        FROM commission_settlements WHERE driver_id=${driver.id}::uuid
        ORDER BY created_at DESC LIMIT 10
      `).catch(() => ({ rows: [] }));
      let displayMessage = 'No pending dues';
      if (totalPending > 0) {
        displayMessage = `Platform Fee ?${pendingCommission.toFixed(2)}\nGST ?${pendingGst.toFixed(2)}\nTotal Due ?${totalPending.toFixed(2)}`;
      }
      res.json({
        pendingCommission,
        pendingGst,
        totalPendingBalance: totalPending,
        lockThreshold,
        isLocked: row.is_locked || false,
        lockReason: row.lock_reason || null,
        displayMessage,
        recentSettlements: camelize(recent.rows),
        progressPercent: lockThreshold > 0 ? Math.min(100, Math.round((totalPending / lockThreshold) * 100)) : 0,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Initiate Razorpay payment to settle pending commission -----------
  app.post("/api/app/driver/commission/create-order", authApp, paymentOrderLimiter, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { amount } = req.body;
      const { keyId, keySecret } = await getRazorpayKeys();
      if (!keyId || !keySecret) return res.status(503).json({ message: "Payment gateway not configured." });
      // Validate amount against pending balance
      const balR = await rawDb.execute(rawSql`SELECT total_pending_balance FROM users WHERE id=${driver.id}::uuid LIMIT 1`);
      const bal: any = balR.rows[0] || {};
      const pendingAmt = parseFloat(bal.total_pending_balance ?? '0');
      const payAmt = parseFloat(String(amount));
      if (!payAmt || payAmt <= 0) return res.status(400).json({ message: "Invalid amount" });
      if (payAmt > pendingAmt + 1) return res.status(400).json({ message: `Amount ?${payAmt} exceeds pending balance ?${pendingAmt.toFixed(2)}` });
      const Razorpay = _require("razorpay");
      const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret, timeout: 15000 });
      const order = await rzp.orders.create({ amount: Math.round(payAmt * 100), currency: "INR", receipt: `cs_${Date.now().toString(36)}` });
      await rawDb.execute(rawSql`
        INSERT INTO driver_payments (driver_id, amount, payment_type, razorpay_order_id, status, description)
        VALUES (${driver.id}::uuid, ${payAmt}, 'commission_payment', ${order.id}, 'pending', ${'Commission settlement ?' + payAmt})
      `).catch(dbCatch("db"));
      res.json({ order, keyId, pendingBalance: pendingAmt });
    } catch (e: any) {
      const msg = e.message || e.error?.description || JSON.stringify(e).slice(0, 200);
      res.status(500).json({ message: msg });
    }
  });

  // -- DRIVER: Verify Razorpay commission payment -------------------------------
  app.post("/api/app/driver/commission/verify-payment", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
      const { keySecret } = await getRazorpayKeys();
      if (!keySecret) return res.status(503).json({ message: "Payment gateway not configured" });
      const expectedSig = crypto.createHmac("sha256", keySecret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
      const sigValid = expectedSig.length === razorpaySignature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSig, "utf8"), Buffer.from(razorpaySignature, "utf8"));
      if (!sigValid) return res.status(400).json({ message: "Invalid payment signature" });
      // Idempotency: reject if this payment was already processed
      const dupCheck = await rawDb.execute(rawSql`
        SELECT id FROM commission_settlements WHERE razorpay_payment_id=${razorpayPaymentId} LIMIT 1
      `);
      if (dupCheck.rows.length) return res.status(409).json({ message: "Payment already processed" });
      const settingRows = await rawDb.execute(rawSql`SELECT key_name, value FROM revenue_model_settings`);
      const settings: any = {};
      settingRows.rows.forEach((r: any) => { settings[r.key_name] = r.value; });

      // Amount from DB � never trust client-sent amount
      const pendingRec = await rawDb.execute(rawSql`
        SELECT amount FROM driver_payments WHERE razorpay_order_id=${razorpayOrderId} AND driver_id=${driver.id}::uuid AND status='pending' LIMIT 1
      `);
      if (!pendingRec.rows.length) return res.status(400).json({ message: "No pending order found for this payment" });
      const paidAmt = parseFloat((pendingRec.rows[0] as any).amount);

      const balR = await rawDb.execute(rawSql`
        SELECT pending_commission_balance, pending_gst_balance, total_pending_balance, wallet_balance, is_locked
        FROM users WHERE id=${driver.id}::uuid LIMIT 1
      `);
      const bal: any = balR.rows[0] || {};
      const prevTotal = parseFloat(bal.total_pending_balance ?? '0') || 0;
      const prevCommission = parseFloat(bal.pending_commission_balance ?? '0') || 0;
      const prevGst = parseFloat(bal.pending_gst_balance ?? '0') || 0;
      const gstReduction = Math.min(prevGst, parseFloat((paidAmt * (prevTotal > 0 ? prevGst / prevTotal : 0.05)).toFixed(2)));
      const commReduction = Math.min(prevCommission, parseFloat((paidAmt - gstReduction).toFixed(2)));
      const newTotal = Math.max(0, parseFloat((prevTotal - paidAmt).toFixed(2)));
      const newCommission = Math.max(0, parseFloat((prevCommission - commReduction).toFixed(2)));
      const newGst = Math.max(0, parseFloat((prevGst - gstReduction).toFixed(2)));

      const updated = await rawDb.execute(rawSql`
        UPDATE users
        SET wallet_balance             = wallet_balance + ${paidAmt},
            pending_commission_balance = ${newCommission},
            pending_gst_balance        = ${newGst},
            total_pending_balance      = ${newTotal},
            pending_payment_amount     = GREATEST(0, pending_payment_amount - ${paidAmt})
        WHERE id = ${driver.id}::uuid
        RETURNING wallet_balance, is_locked
      `);
      const updRow: any = updated.rows[0] || {};
      const lockThreshold = parseFloat(settings.commission_lock_threshold || '200');
      const wasLocked = updRow.is_locked;
      if (newTotal < lockThreshold && wasLocked) {
        await rawDb.execute(rawSql`UPDATE users SET is_locked=false, lock_reason=NULL, locked_at=NULL WHERE id=${driver.id}::uuid`);
      }
      await rawDb.execute(rawSql`
        INSERT INTO commission_settlements
          (driver_id, settlement_type, commission_amount, gst_amount, total_amount,
           direction, balance_before, balance_after, payment_method,
           razorpay_order_id, razorpay_payment_id, status, description)
        VALUES
          (${driver.id}::uuid, 'payment_credit', ${commReduction}, ${gstReduction}, ${paidAmt},
           'credit', ${prevTotal}, ${newTotal}, 'razorpay',
           ${razorpayOrderId}, ${razorpayPaymentId}, 'completed',
           ${'Driver payment via Razorpay. Commission: ?' + commReduction.toFixed(2) + ', GST: ?' + gstReduction.toFixed(2)})
      `).catch(dbCatch("db"));
      await rawDb.execute(rawSql`
        UPDATE driver_payments SET status='completed', razorpay_payment_id=${razorpayPaymentId},
          razorpay_signature=${razorpaySignature || ''}, verified_at=NOW()
        WHERE razorpay_order_id=${razorpayOrderId}
      `).catch(dbCatch("db"));
      res.json({
        success: true,
        paidAmount: paidAmt,
        newPendingBalance: newTotal,
        pendingCommission: newCommission,
        pendingGst: newGst,
        autoUnlocked: newTotal < lockThreshold && wasLocked,
        message: newTotal <= 0 ? 'All dues cleared! Account unlocked.' : `?${newTotal.toFixed(2)} pending. Pay remaining to unlock.`,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Submit withdrawal request ----------------------------------------
  app.post("/api/app/driver/withdraw-request", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { amount, bankName, accountNumber, ifscCode, accountHolderName, upiId, method = "bank" } = req.body;
      const amt = parseFloat(amount);
      if (!amt || amt <= 0) return res.status(400).json({ message: "Invalid amount" });
      if (amt < 100) return res.status(400).json({ message: "Minimum withdrawal is ?100" });
      // Check wallet balance
      const walR = await rawDb.execute(rawSql`SELECT wallet_balance, is_locked FROM users WHERE id=${driver.id}::uuid`);
      const w = walR.rows[0] as any;
      if (w?.is_locked) return res.status(403).json({ message: "Account locked. Please clear dues first." });
      const bal = parseFloat(w?.wallet_balance || 0);
      if (bal < amt) return res.status(400).json({ message: `Insufficient balance. Available: ?${bal.toFixed(2)}` });
      // Check no pending withdrawal exists
      const pending = await rawDb.execute(rawSql`SELECT COUNT(*) as cnt FROM withdraw_requests WHERE user_id=${driver.id}::uuid AND status='pending'`).catch(() => ({ rows: [{ cnt: 0 }] }));
      if (parseInt((pending.rows[0] as any)?.cnt || 0) > 0) return res.status(400).json({ message: "You already have a pending withdrawal request" });
      // Validate bank/UPI details
      if (method === "bank") {
        const accClean = (accountNumber || "").replace(/\s/g, "");
        if (!accClean || !/^\d{9,18}$/.test(accClean))
          return res.status(400).json({ message: "Invalid account number (9�18 digits required)" });
        if (!ifscCode || !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(ifscCode.trim()))
          return res.status(400).json({ message: "Invalid IFSC code (format: ABCD0123456)" });
        if (!accountHolderName || accountHolderName.trim().length < 3)
          return res.status(400).json({ message: "Account holder name required (min 3 characters)" });
        if (!bankName || bankName.trim().length < 2)
          return res.status(400).json({ message: "Bank name is required" });
      } else if (method === "upi") {
        if (!upiId || !/^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/.test(upiId.trim()))
          return res.status(400).json({ message: "Invalid UPI ID format (e.g. name@upi)" });
      }
      // Insert withdraw request
      const notes = method === "upi"
        ? `UPI: ${upiId || ''}`
        : `Bank: ${bankName || ''} | Acc: ${accountNumber || ''} | IFSC: ${ifscCode || ''} | Name: ${accountHolderName || ''}`;
      const wr = await rawDb.execute(rawSql`
        INSERT INTO withdraw_requests (user_id, amount, note, status, created_at)
        VALUES (${driver.id}::uuid, ${amt}, ${notes}, 'pending', now())
        RETURNING *
      `);
      res.json({ success: true, message: `Withdrawal request of ?${amt} submitted. Will be processed in 2-3 business days.`, request: camelize(wr.rows[0]) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Subscription status & purchase -------------------------------
  app.get("/api/app/driver/subscription", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const modelR = await rawDb.execute(rawSql`SELECT key_name, value FROM revenue_model_settings`);
      const s: any = {};
      modelR.rows.forEach((r: any) => { s[r.key_name] = r.value; });
      const activeModel = s.active_model || "commission";
      let activeSub = null;
      let daysLeft = 0;
      if (activeModel === "subscription" || activeModel === "hybrid") {
        const subR = await rawDb.execute(rawSql`
          SELECT ds.*, sp.name as plan_name, sp.price, sp.duration_days
          FROM driver_subscriptions ds
          LEFT JOIN subscription_plans sp ON sp.id = ds.plan_id
          WHERE ds.driver_id=${driver.id}::uuid AND ds.is_active=true
          ORDER BY ds.end_date DESC LIMIT 1
        `);
        if (subR.rows.length) {
          activeSub = camelize(subR.rows[0]);
          daysLeft = Math.max(0, Math.ceil((new Date((activeSub as any).endDate).getTime() - Date.now()) / 86400000));
        }
      }
      const plans = await rawDb.execute(rawSql`SELECT * FROM subscription_plans WHERE is_active=true ORDER BY price ASC`);
      res.json({
        activeModel,
        activeSub,
        daysLeft,
        isSubscriptionRequired: activeModel === "subscription" || activeModel === "hybrid",
        hasActiveSubscription: !!activeSub && daysLeft > 0,
        plans: plans.rows.map(camelize),
        perRideFees: {
          platformFee: parseFloat(s.sub_platform_fee_per_ride || "5"),
          gstPct: parseFloat(s.sub_gst_pct || "18"),
          insurance: parseFloat(s.commission_insurance_per_ride || "2"),
        },
        commissionRate: parseFloat(s.commission_pct || "15"),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/app/driver/insurance/plans", authApp, requireDriver, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT *
        FROM insurance_plans
        WHERE is_active=true
        ORDER BY premium_monthly ASC, premium_daily ASC
      `);
      res.json({ plans: r.rows.map(camelize) });
    } catch (e: any) { res.status(e?.statusCode || 500).json({ message: safeErrMsg(e), code: e?.code, allowed: e?.allowed }); }
  });

  app.post("/api/app/driver/subscription/create-order", authApp, requireDriver, paymentOrderLimiter, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { planId, insurancePlanId } = req.body;
      if (!planId) return res.status(400).json({ message: "planId required" });
      const planR = await rawDb.execute(rawSql`SELECT * FROM subscription_plans WHERE id=${planId}::uuid AND is_active=true`);
      if (!planR.rows.length) return res.status(404).json({ message: "Plan not found" });
      const plan = camelize(planR.rows[0]) as any;

      // Paise-based arithmetic to prevent float drift
      const planPricePaise = Math.round(parseFloat(plan.price) * 100);
      const gstPctR = await rawDb.execute(rawSql`SELECT value FROM revenue_model_settings WHERE key_name='sub_gst_pct'`).catch(() => ({ rows: [] as any[] }));
      const gstPct = parseFloat((gstPctR.rows[0] as any)?.value || "18");
      const gstPaise = Math.round(planPricePaise * gstPct / 100);

      // Optional insurance add-on
      let insurancePaise = 0;
      let insurancePlan: any = null;
      if (insurancePlanId) {
        const insR = await rawDb.execute(rawSql`SELECT * FROM insurance_plans WHERE id=${insurancePlanId}::uuid AND is_active=true`).catch(() => ({ rows: [] as any[] }));
        if (insR.rows.length) {
          insurancePlan = camelize(insR.rows[0]) as any;
          insurancePaise = Math.round(parseFloat(insurancePlan.premiumMonthly || insurancePlan.premiumDaily * 30 || 0) * 100);
        }
      }
      const totalPaise = planPricePaise + gstPaise + insurancePaise;
      const total = totalPaise / 100;
      const planFee = planPricePaise / 100;
      const gstAmt = gstPaise / 100;
      const insuranceAmt = insurancePaise / 100;

      const { keyId, keySecret } = await getRazorpayKeys();
      if (!keyId || !keySecret) return res.status(503).json({ message: "Payment gateway not configured" });
      const Razorpay = _require("razorpay");
      const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret, timeout: 15000 });
      const order = await rzp.orders.create({
        amount: totalPaise, // already in paise
        currency: "INR",
        receipt: `sub_${Date.now().toString(36)}`,
        notes: { driver_id: driver.id, plan_id: planId, plan_name: plan.name }
      });
      // Persist pending record with full breakdown so verify can cross-check
      await rawDb.execute(rawSql`
        INSERT INTO driver_payments (driver_id, amount, payment_type, razorpay_order_id, status, description)
        VALUES (${driver.id}::uuid, ${total}, 'subscription', ${order.id}, 'pending',
                ${'Subscription: ' + plan.name + ' | Base:?' + planFee + ' GST:?' + gstAmt + (insuranceAmt > 0 ? ' Ins:?' + insuranceAmt : '')})
        ON CONFLICT DO NOTHING
      `).catch((e: any) => console.error('[SUB-CREATE-ORDER]', e.message));
      res.json({
        order, keyId,
        breakdown: { planFee, gst: gstAmt, insurance: insuranceAmt, total, gstPct },
        insurancePlanId: insurancePlanId || null,
        insurancePlan: insurancePlan || null,
        plan,
        // Legacy fields kept for backward compat
        amount: total, planFee, gst: gstAmt,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/app/driver/subscription/verify-payment", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature, planId, insurancePlanId } = req.body;
      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !planId) return res.status(400).json({ message: "Missing required fields" });
      const { keySecret } = await getRazorpayKeys();
      if (!keySecret) return res.status(503).json({ message: "Payment gateway not configured" });
      // Timing-safe HMAC
      const expectedSig = crypto.createHmac("sha256", keySecret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
      const sigValid = expectedSig.length === razorpaySignature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSig, "utf8"), Buffer.from(razorpaySignature, "utf8"));
      if (!sigValid) return res.status(400).json({ message: "Invalid payment signature" });

      // SECURITY: Atomic idempotency � mark driver_payment as completed FIRST
      // Second call will find status='completed' and return 409 immediately
      const atomicMark = await rawDb.execute(rawSql`
        UPDATE driver_payments
        SET razorpay_payment_id=${razorpayPaymentId}, status='completed', verified_at=NOW()
        WHERE razorpay_order_id=${razorpayOrderId} AND driver_id=${driver.id}::uuid AND status='pending'
        RETURNING amount, description
      `);
      if (!atomicMark.rows.length) return res.status(409).json({ message: "Subscription payment already processed", alreadyActivated: true });

      const totalPaid = Math.round(parseFloat((atomicMark.rows[0] as any).amount) * 100) / 100;

      const planR = await rawDb.execute(rawSql`SELECT * FROM subscription_plans WHERE id=${planId}::uuid`);
      if (!planR.rows.length) return res.status(404).json({ message: "Plan not found" });
      const plan = camelize(planR.rows[0]) as any;
      const planBasePaise = Math.round(parseFloat(plan.price) * 100);
      const gstPctR = await rawDb.execute(rawSql`SELECT value FROM revenue_model_settings WHERE key_name='sub_gst_pct'`).catch(() => ({ rows: [] as any[] }));
      const gstPct = parseFloat((gstPctR.rows[0] as any)?.value || "18");
      const gstPaise = Math.round(planBasePaise * gstPct / 100);
      const gstAmt = gstPaise / 100;
      const planBase = planBasePaise / 100;

      // Optional insurance
      let insuranceAmt = 0;
      if (insurancePlanId) {
        const insR = await rawDb.execute(rawSql`SELECT premium_monthly, premium_daily FROM insurance_plans WHERE id=${insurancePlanId}::uuid AND is_active=true`).catch(() => ({ rows: [] as any[] }));
        if (insR.rows.length) {
          const ins = insR.rows[0] as any;
          insuranceAmt = Math.round(parseFloat(ins.premium_monthly || ins.premium_daily * 30 || 0) * 100) / 100;
        }
      }

      const startDate = new Date().toISOString().split("T")[0];
      const endDate = new Date(Date.now() + plan.durationDays * 86400000).toISOString().split("T")[0];

      // Deactivate old subscriptions then insert new one (with unique constraint on razorpay_payment_id)
      await rawDb.execute(rawSql`UPDATE driver_subscriptions SET is_active=false WHERE driver_id=${driver.id}::uuid AND is_active=true`);
      const sub = await rawDb.execute(rawSql`
        INSERT INTO driver_subscriptions
          (driver_id, plan_id, start_date, end_date,
           payment_amount, plan_base_price, gst_amount, insurance_amount, insurance_plan_id,
           payment_status, is_active, razorpay_payment_id, razorpay_order_id)
        VALUES
          (${driver.id}::uuid, ${planId}::uuid, ${startDate}, ${endDate},
           ${totalPaid}, ${planBase}, ${gstAmt}, ${insuranceAmt}, ${insurancePlanId || null}::uuid,
           'paid', true, ${razorpayPaymentId}, ${razorpayOrderId})
        ON CONFLICT (razorpay_payment_id) DO UPDATE SET is_active=true
        RETURNING *
      `);

      // Record company revenue with full breakdown
      const breakdown = { planName: plan.name, planFee: planBase, gst: gstAmt, insurance: insuranceAmt, total: totalPaid, durationDays: plan.durationDays, paymentId: razorpayPaymentId };
      await rawDb.execute(rawSql`
        INSERT INTO admin_revenue (driver_id, amount, revenue_type, breakdown)
        VALUES (${driver.id}::uuid, ${totalPaid}, 'subscription_purchase', ${JSON.stringify(breakdown)}::jsonb)
        ON CONFLICT DO NOTHING
      `).catch((e: any) => console.error('[SUB-ADMIN-REV]', e.message));

      // Transaction record in driver transactions (so driver sees "subscription" in payment history)
      await rawDb.execute(rawSql`
        INSERT INTO driver_payments (driver_id, amount, payment_type, status, description)
        VALUES (${driver.id}::uuid, ${totalPaid}, 'subscription_payment', 'completed',
                ${'Subscription: ' + plan.name + ' valid till ' + endDate + ' | Fee:?' + planBase + ' GST:?' + gstAmt})
        ON CONFLICT DO NOTHING
      `).catch((e: any) => console.error('[SUB-DRV-PAY]', e.message));

      console.log(`[SUBSCRIPTION] Driver ${driver.id} activated plan "${plan.name}" ?${totalPaid} (base:${planBase} gst:${gstAmt} ins:${insuranceAmt}) valid till ${endDate}`);
      res.json({
        success: true,
        subscription: camelize(sub.rows[0]),
        plan,
        validUntil: endDate,
        daysLeft: plan.durationDays,
        totalPaid,
        breakdown: { planFee: planBase, gst: gstAmt, insurance: insuranceAmt, total: totalPaid },
        message: `Subscription activated! Valid until ${endDate}`,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/app/driver/wallet/create-order", authApp, requireDriver, paymentOrderLimiter, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { amount } = req.body;
      const amt = parseFloat(amount);
      if (!amt || amt <= 0 || amt > 50000) return res.status(400).json({ message: "Invalid amount" });
      const { keyId, keySecret } = await getRazorpayKeys();
      if (!keyId || !keySecret) return res.status(503).json({ message: "Payment gateway not configured" });
      const Razorpay = _require("razorpay");
      const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret, timeout: 15000 });
      const order = await rzp.orders.create({
        amount: Math.round(amt * 100), currency: "INR",
        receipt: `dw_${Date.now().toString(36)}`,
        notes: { driver_id: driver.id, purpose: "wallet_recharge" }
      });
      // Persist pending record so verify-payment can cross-check amount from DB
      await rawDb.execute(rawSql`
        INSERT INTO driver_payments (driver_id, amount, payment_type, razorpay_order_id, status, description)
        VALUES (${driver.id}::uuid, ${amt}, 'wallet_topup', ${order.id}, 'pending', 'Wallet recharge via Razorpay')
        ON CONFLICT DO NOTHING
      `).catch(dbCatch("db"));
      res.json({ order, keyId, amount: amt });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/app/driver/wallet/verify-payment", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) return res.status(400).json({ message: "Missing payment details" });
      const { keySecret } = await getRazorpayKeys();
      if (!keySecret) return res.status(503).json({ message: "Payment gateway not configured" });
      // Timing-safe HMAC verification
      const expectedSig = crypto.createHmac("sha256", keySecret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
      const sigValid = expectedSig.length === razorpaySignature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSig, "utf8"), Buffer.from(razorpaySignature, "utf8"));
      if (!sigValid) return res.status(400).json({ message: "Invalid payment signature" });
      // IDEMPOTENCY (atomic): Mark payment completed FIRST � only one request can succeed this UPDATE.
      // If razorpay_payment_id is already set (duplicate call), rows=0 ? 409 immediately, wallet NOT credited.
      const claimR = await rawDb.execute(rawSql`
        UPDATE driver_payments
        SET razorpay_payment_id=${razorpayPaymentId}, status='completed', verified_at=NOW()
        WHERE razorpay_order_id=${razorpayOrderId} AND driver_id=${driver.id}::uuid AND status='pending'
          AND (razorpay_payment_id IS NULL OR razorpay_payment_id=${razorpayPaymentId})
        RETURNING amount
      `);
      if (!claimR.rows.length) {
        // Check if already completed (duplicate call vs genuinely not found)
        const existR = await rawDb.execute(rawSql`
          SELECT status FROM driver_payments WHERE razorpay_order_id=${razorpayOrderId} AND driver_id=${driver.id}::uuid LIMIT 1
        `);
        if ((existR.rows[0] as any)?.status === 'completed') {
          return res.status(409).json({ message: "Payment already processed", alreadyCredited: true });
        }
        return res.status(400).json({ message: "No pending order found for this payment" });
      }
      const amt = parseFloat((claimR.rows[0] as any).amount);
      const wUpd = await rawDb.execute(rawSql`
        UPDATE users SET wallet_balance = wallet_balance + ${amt}, pending_payment_amount = GREATEST(0, pending_payment_amount - ${amt})
        WHERE id=${driver.id}::uuid RETURNING wallet_balance, is_locked
      `);
      const newBalance = parseFloat((wUpd.rows[0] as any)?.wallet_balance || 0);
      // Auto-unlock if wallet is now above the auto-lock threshold
      const threshR = await rawDb.execute(rawSql`SELECT value FROM revenue_model_settings WHERE key_name='auto_lock_threshold' LIMIT 1`);
      const unlockThreshold = parseFloat((threshR.rows[0] as any)?.value || "-100");
      const wasLocked = (wUpd.rows[0] as any)?.is_locked;
      let autoUnlocked = false;
      if (newBalance >= unlockThreshold && wasLocked) {
        await rawDb.execute(rawSql`UPDATE users SET is_locked=false, lock_reason=NULL, locked_at=NULL WHERE id=${driver.id}::uuid`);
        autoUnlocked = true;
      }
      res.json({ success: true, newBalance, autoUnlocked, message: `?${amt.toFixed(0)} added to wallet` });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Get profile -------------------------------------------------
  app.get("/api/app/customer/profile", authApp, requireCustomer, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT u.*,
          (SELECT COUNT(*) FROM trip_requests WHERE customer_id=u.id AND current_status='completed') as completed_trips,
          (SELECT COALESCE(SUM(actual_fare),0) FROM trip_requests WHERE customer_id=u.id AND current_status='completed') as total_spent
        FROM users u WHERE u.id=${customer.id}::uuid
      `);
      const d = camelize(r.rows[0]) as any;
      const custObj = {
        id: d.id,
        fullName: d.fullName,
        phone: d.phone,
        email: d.email,
        profilePhoto: d.profileImage || null,
        rating: parseFloat(d.rating || "5.0"),
        walletBalance: parseFloat(d.walletBalance || "0"),
        loyaltyPoints: parseFloat(d.loyaltyPoints || "0"),
        stats: {
          completedTrips: parseInt(d.completedTrips || "0"),
          totalSpent: parseFloat(d.totalSpent || "0"),
        }
      };
      res.json({ user: custObj, ...custObj });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Book a ride -------------------------------------------------
  app.post("/api/app/customer/book-ride", authApp, requireCustomer, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const {
        pickupAddress, pickupLat, pickupLng,
        pickupShortName,
        destinationAddress, destAddress, destinationLat, destLat, destinationLng, destLng,
        destinationShortName,
        vehicleCategoryId, vehicle_category_id, vehicle_type_id, vehicleTypeId,
        vehicleType, vehicle_type, vehicleSlug, vehicle_slug,
        vehicleCategoryName, vehicleName,
        estimatedFare, estimatedDistance, distanceKm,
        paymentMethod, paymentMode, tripType = "normal", isScheduled = false, scheduledAt,
        // Book for someone else
        isForSomeoneElse = false, passengerName, passengerPhone,
        // Parcel fields
        receiverName, receiverPhone,
        // Coupon
        couponCode, promoDiscount,
        // Online payment � used to link customer_payments ? trip for refund on cancel
        razorpayPaymentId
      } = req.body;

      // -- SECURITY: Validate pickup and destination coordinates --
      const validPickupCoords = validateLatLng(pickupLat, pickupLng);
      const destLat_temp = destinationLat || destLat || 0;
      const destLng_temp = destinationLng || destLng || 0;
      const validDestCoords = validateLatLng(destLat_temp, destLng_temp);

      const finalDestAddress = destinationAddress || destAddress || "";
      const finalPickupShort = pickupShortName || shortLocationName(pickupAddress);
      const finalDestShort = destinationShortName || shortLocationName(finalDestAddress);
      const finalDestLat = validDestCoords.lat;
      const finalDestLng = validDestCoords.lng;
      const finalPayment = paymentMethod || paymentMode || "cash";
      const finalDistance = estimatedDistance || distanceKm || 0;
      const requestedVehicleName = vehicleCategoryName || vehicleName || null;
      const requestedVehicleCategoryId =
        vehicleCategoryId || vehicle_category_id || vehicle_type_id || vehicleTypeId || null;
      const requestedVehicleType =
        vehicleType || vehicle_type || vehicleSlug || vehicle_slug || null;
      console.log("[BOOK_RIDE][incoming_vehicle]", JSON.stringify({
        customerId: customer?.id || null,
        vehicleCategoryId: requestedVehicleCategoryId,
        vehicleType: requestedVehicleType,
        vehicleName: requestedVehicleName,
        rawKeys: Object.keys(req.body || {}).filter((key) => key.toLowerCase().includes("vehicle")),
      }));
      const resolvedVehicle = await resolveBookingVehicleSelection({
        vehicleCategoryId: requestedVehicleCategoryId,
        vehicleType: requestedVehicleType,
        vehicleCategoryName: requestedVehicleName,
      });
      const bookingVehicleCategoryId = resolvedVehicle.vehicleCategoryId;
      const bookingVehicleType = resolvedVehicle.vehicleType;
      const bookingVehicleName = resolvedVehicle.vehicleCategoryName || requestedVehicleName || "";

      if (!bookingVehicleCategoryId || !bookingVehicleType) {
        console.warn("[BOOK_RIDE][vehicle_validation_failed]", JSON.stringify({
          customerId: customer?.id || null,
          requestedVehicleCategoryId,
          requestedVehicleType,
          requestedVehicleName,
          resolvedVehicle,
        }));
        return res.status(400).json({
          message: "Please select a valid vehicle type before booking.",
          code: "VEHICLE_CATEGORY_REQUIRED",
        });
      }
      if (resolvedVehicle.typeMismatch) {
        console.warn("[BOOK_RIDE][vehicle_type_mismatch]", JSON.stringify({
          customerId: customer?.id || null,
          requestedVehicleCategoryId,
          requestedVehicleType,
          requestedVehicleName,
          resolvedVehicle,
        }));
        return res.status(400).json({
          message: "Selected vehicle does not match the requested booking type.",
          code: "VEHICLE_TYPE_MISMATCH",
        });
      }

      // -- Service activation gate -------------------------------------------
      const rideGate = await rawDb.execute(rawSql`
        SELECT service_status FROM platform_services WHERE service_key = 'bike_ride' LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      // Only block if the record explicitly says inactive (if table missing, allow through)
      if (rideGate.rows.length && (rideGate.rows[0] as any).service_status !== 'active') {
        return res.status(503).json({ message: "Bike Ride service is currently unavailable. Please try again later.", code: "SERVICE_INACTIVE" });
      }

      // -- Server-side fare calculation (fallback when client sends 0 or missing) --
      let computedFare = Number(estimatedFare) || 0;
      if ((computedFare === 0 || isNaN(computedFare)) && bookingVehicleCategoryId) {
        try {
          // Detect zone from pickup location for accurate zone-specific fares
          const detectedZoneId = await detectZoneId(validPickupCoords.lat, validPickupCoords.lng);
          const fareConfig = await rawDb.execute(rawSql`
            SELECT base_fare, fare_per_km, fare_per_min, minimum_fare, night_charge_multiplier
            FROM trip_fares
            WHERE vehicle_category_id = ${bookingVehicleCategoryId}::uuid
              AND (
                ${detectedZoneId ? rawSql`zone_id = ${detectedZoneId}::uuid` : rawSql`zone_id IS NULL`}
                OR zone_id IS NULL
              )
            ORDER BY (zone_id IS NOT NULL) DESC, created_at DESC
            LIMIT 1
          `);
          if (fareConfig.rows.length) {
            const fc = fareConfig.rows[0] as any;
            const base = parseFloat(fc.base_fare || "0");
            const perKm = parseFloat(fc.fare_per_km || "0");
            const perMin = parseFloat(fc.fare_per_min || "0");
            const minFare = parseFloat(fc.minimum_fare || "0");
            const dist = Number(finalDistance) || 0;
            // Apply night charge multiplier between 22:00-06:00
            const hr = new Date().getHours();
            const isNight = hr >= 22 || hr < 6;
            const nightMult = isNight ? parseFloat(fc.night_charge_multiplier || "1") : 1;
            // Apply zone surge factor using detected zone (polygon-based, from DB)
            let surgeMult = 1.0;
            if (validPickupCoords.lat && validPickupCoords.lng) {
              try {
                const surgeZoneRow = detectedZoneId
                  ? (await rawDb.execute(rawSql`SELECT surge_factor FROM zones WHERE id=${detectedZoneId}::uuid AND surge_factor > 1 LIMIT 1`)).rows[0] as any
                  : null;
                if (surgeZoneRow?.surge_factor) surgeMult = parseFloat(surgeZoneRow.surge_factor) || 1.0;
              } catch { }
            }
            // Also check time-based surge pricing (zone-specific + global)
            try {
              const now = new Date();
              const timeStr = now.toTimeString().slice(0, 5); // HH:MM
              const activeSurge = await rawDb.execute(rawSql`
                SELECT multiplier FROM surge_pricing
                WHERE is_active=true
                  AND start_time <= ${timeStr}
                  AND end_time >= ${timeStr}
                  AND (zone_id IS NULL ${detectedZoneId ? rawSql`OR zone_id = ${detectedZoneId}::uuid` : rawSql``})
                ORDER BY multiplier DESC LIMIT 1
              `);
              if (activeSurge.rows.length) {
                const timeSurge = parseFloat((activeSurge.rows[0] as any).multiplier || '1');
                surgeMult = Math.max(surgeMult, timeSurge);
              }
            } catch { }
            const raw = (base + perKm * dist + perMin * 0) * nightMult * surgeMult;
            computedFare = Math.max(raw, minFare);
          } else {
            // Absolute fallback: ?30 + ?12/km (standard bike fare)
            const dist = Number(finalDistance) || 0;
            computedFare = Math.max(30 + 12 * dist, 30);
          }
        } catch (fareErr: any) {
          console.error("[fare-calc] fallback error:", fareErr.message);
          const dist = Number(finalDistance) || 0;
          computedFare = Math.max(30 + 12 * dist, 30);
        }
      }

      // -- Coupon validation & discount -----------------------------------------
      let discountAmount = 0;
      let validatedCouponCode: string | null = null;
      if (couponCode && typeof couponCode === 'string' && couponCode.trim()) {
        try {
          const couponR = await rawDb.execute(rawSql`
            SELECT id, code, discount_type, discount_amount, max_discount_amount, min_trip_amount, total_usage_limit, limit_per_user
            FROM coupon_setups
            WHERE UPPER(code) = UPPER(${couponCode.trim()})
              AND is_active = true
              AND (end_date IS NULL OR end_date >= NOW())
            LIMIT 1
          `);
          if (couponR.rows.length) {
            const c = camelize(couponR.rows[0]) as any;
            const minOrder = parseFloat(c.minTripAmount || '0');
            if (computedFare >= minOrder) {
              let couponValid = true;
              // Check total usage limit
              if (c.totalUsageLimit) {
                const usageR = await rawDb.execute(rawSql`
                  SELECT COUNT(*) AS cnt FROM trip_requests
                  WHERE coupon_code = UPPER(${couponCode.trim()}) AND current_status != 'cancelled'
                `);
                const usedCount = parseInt((usageR.rows[0] as any).cnt || '0', 10);
                if (usedCount >= parseInt(c.totalUsageLimit, 10)) couponValid = false;
              }
              // Check per-user limit
              if (couponValid && c.limitPerUser) {
                const userUsageR = await rawDb.execute(rawSql`
                  SELECT COUNT(*) AS cnt FROM trip_requests
                  WHERE coupon_code = UPPER(${couponCode.trim()}) AND customer_id = ${customer.id}::uuid
                    AND current_status != 'cancelled'
                `);
                const userUsed = parseInt((userUsageR.rows[0] as any).cnt || '0', 10);
                if (userUsed >= parseInt(c.limitPerUser, 10)) couponValid = false;
              }
              if (couponValid) {
                if (c.discountType === 'percent' || c.discountType === 'percentage') {
                  discountAmount = computedFare * parseFloat(c.discountAmount) / 100;
                } else {
                  discountAmount = parseFloat(c.discountAmount);
                }
                if (c.maxDiscountAmount) discountAmount = Math.min(discountAmount, parseFloat(c.maxDiscountAmount));
                discountAmount = Math.round(discountAmount * 100) / 100;
                validatedCouponCode = c.code;
              }
            }
          }
        } catch (_) { }
      }
      // Also accept pre-validated discount from Flutter (as fallback)
      if (discountAmount === 0 && promoDiscount && Number(promoDiscount) > 0) {
        discountAmount = Math.min(Number(promoDiscount), computedFare * 0.5); // cap at 50%
      }
      const finalFareAfterDiscount = Math.max(0, computedFare - discountAmount);

      // Auto-cancel any previous 'searching' trips � user is explicitly requesting a new ride
      await rawDb.execute(rawSql`
        UPDATE trip_requests
        SET current_status='cancelled', cancel_reason='Auto-cancelled: customer started a new booking'
        WHERE customer_id=${customer.id}::uuid
          AND current_status = 'searching'
      `);

      // Check if customer already has a genuinely active trip
      const active = await rawDb.execute(rawSql`
        SELECT id, current_status FROM trip_requests
        WHERE customer_id=${customer.id}::uuid
          AND current_status IN ('searching','driver_assigned','accepted','arrived','on_the_way')
      `);
      if (active.rows.length) {
        const st = (active.rows[0] as any).current_status;
        const msg = st === 'searching'
          ? "Searching for a pilot. Please wait or cancel your current trip."
          : "You already have an active trip in progress.";
        return res.status(400).json({ message: msg, tripId: (active.rows[0] as any).id, status: st });
      }

      // Generate ref_id
      const refId = "TRP" + Date.now().toString().slice(-8).toUpperCase();

      // For parcel trips, generate delivery OTP now
      const deliveryOtpVal = (tripType === 'parcel' || tripType === 'delivery') ? Math.floor(1000 + Math.random() * 9000).toString() : null;

      // -- HARDENING: Pre-booking validations --
      try {
        // Check rate limit (max 20 bookings/hour per customer)
        const rateCheck = await checkBookingRateLimit(customer.id, 20);
        if (!rateCheck.allowed) {
          return res.status(429).json({ error: rateCheck.reason, code: "RATE_LIMIT_EXCEEDED" });
        }

        // Check for fraud patterns (detects rapid same-location bookings)
        const fraudCheck = await detectBookingFraud(customer.id, validPickupCoords.lat, validPickupCoords.lng);
        if (fraudCheck.isFraudulent) {
          return res.status(400).json({ error: fraudCheck.reason, code: "FRAUD_DETECTED" });
        }

        // Check customer bans or locks
        const banCheck = await checkCustomerBans(customer.id);
        if (banCheck.banned) {
          return res.status(403).json({
            error: banCheck.reason,
            code: "CUSTOMER_BANNED",
            banUntil: banCheck.until
          });
        }
      } catch (hardeningErr: any) {
        // Log but don't block on hardening errors (fail-open)
        log('HARDENING-BOOKING-VALIDATION', hardeningErr.message);
      }


      // Always start as 'searching' � driver must ACCEPT before being assigned
      const trip = await rawDb.execute(rawSql`
        INSERT INTO trip_requests (
          ref_id, customer_id, driver_id, vehicle_category_id,
          pickup_address, pickup_lat, pickup_lng,
          destination_address, destination_lat, destination_lng,
          estimated_fare, estimated_distance, payment_method,
          trip_type, current_status, is_scheduled, scheduled_at,
          is_for_someone_else, passenger_name, passenger_phone,
          receiver_name, receiver_phone, delivery_otp,
          pickup_short_name, destination_short_name
        ) VALUES (
          ${refId}, ${customer.id}::uuid,
          NULL,
          ${bookingVehicleCategoryId ? rawSql`${bookingVehicleCategoryId}::uuid` : rawSql`NULL`},
          ${pickupAddress || ""}, ${validPickupCoords.lat}, ${validPickupCoords.lng},
          ${finalDestAddress}, ${finalDestLat}, ${finalDestLng},
          ${finalFareAfterDiscount}, ${Number(finalDistance) || 0}, ${finalPayment},
          ${tripType}, 'searching', ${isScheduled ? true : false}, ${scheduledAt || null},
          ${isForSomeoneElse ? true : false}, ${passengerName || null}, ${passengerPhone || null},
          ${receiverName || null}, ${receiverPhone || null}, ${deliveryOtpVal},
          ${finalPickupShort || null}, ${finalDestShort || null}
        ) RETURNING *
      `);
      // Store zone_id + coupon/discount on trip (best-effort)
      const newTripId2 = (trip.rows[0] as any).id;
      detectZoneId(validPickupCoords.lat, validPickupCoords.lng).then(zid => {
        if (zid) rawDb.execute(rawSql`UPDATE trip_requests SET zone_id=${zid}::uuid WHERE id=${newTripId2}::uuid`).catch(dbCatch("db"));
      }).catch(dbCatch("db"));
      if (validatedCouponCode || discountAmount > 0) {
        rawDb.execute(rawSql`
          UPDATE trip_requests SET
            coupon_code = ${validatedCouponCode},
            discount_amount = ${discountAmount},
            original_fare = ${computedFare}
          WHERE id = ${newTripId2}::uuid
        `).catch(dbCatch("db"));
      }
      // -- Link online payment to this trip for auto-refund on cancel ----------
      if (razorpayPaymentId) {
        const newTripId = (trip.rows[0] as any).id;
        // Verify payment actually completed before trusting the ID
        const payCheck = await rawDb.execute(rawSql`
          SELECT id FROM customer_payments
          WHERE razorpay_payment_id=${razorpayPaymentId} AND customer_id=${customer.id}::uuid
            AND payment_type='ride_payment' AND status='completed'
          LIMIT 1
        `).catch(() => ({ rows: [] as any[] }));
        if (payCheck.rows.length) {
          rawDb.execute(rawSql`
            UPDATE customer_payments SET trip_id=${newTripId}::uuid
            WHERE razorpay_payment_id=${razorpayPaymentId} AND customer_id=${customer.id}::uuid AND payment_type='ride_payment'
          `).catch(dbCatch("db"));
          rawDb.execute(rawSql`
            UPDATE trip_requests SET payment_status='paid_online', razorpay_payment_id=${razorpayPaymentId}
            WHERE id=${newTripId}::uuid
          `).catch(dbCatch("db"));
        }
      }

      const tripRow = camelize(trip.rows[0]) as any;
      await appendTripStatus(tripRow.id, 'requested', 'customer', 'Customer created booking request');
      await logRideLifecycleEvent(tripRow.id, 'ride_requested', customer.id, 'customer', {
        tripType,
        paymentMethod: finalPayment,
      });

      // ?? Heatmap event: booking demand signal
      logHeatmapEvent(
        'booking',
        Number(pickupLat), Number(pickupLng),
        (tripType === 'parcel' || tripType === 'delivery') ? 'parcel'
          : (tripType === 'carpool' || tripType === 'pool') ? 'pool'
            : (tripType === 'cargo') ? 'cargo' : 'ride'
      );

      // -- Smart Dispatch Engine ----------------------------------------------
      // Resolve vehicle category name for service type detection
      let vcName = bookingVehicleName;
      if (!vcName && bookingVehicleCategoryId) {
        const vcR = await rawDb.execute(rawSql`SELECT name FROM vehicle_categories WHERE id=${bookingVehicleCategoryId}::uuid LIMIT 1`).catch(() => ({ rows: [] as any[] }));
        vcName = (vcR.rows[0] as any)?.name || '';
      }
      const serviceType = resolveServiceType(tripType, vcName);

      const dispatchMeta: TripMeta = {
        refId: tripRow.refId,
        customerName: customer.fullName || "Customer",
        pickupAddress: pickupAddress || "",
        destinationAddress: finalDestAddress,
        pickupShortName: finalPickupShort,
        destinationShortName: finalDestShort,
        pickupLat: Number(pickupLat),
        pickupLng: Number(pickupLng),
        estimatedFare: tripRow.estimatedFare || estimatedFare || 0,
        estimatedDistance: tripRow.estimatedDistance || finalDistance || 0,
        paymentMethod: finalPayment,
        tripType,
      };

      // Start sequential dispatch � sends to ONE driver at a time with expanding radius
      startDispatch(
        tripRow.id,
        customer.id,
        Number(pickupLat),
        Number(pickupLng),
        bookingVehicleCategoryId || undefined,
        bookingVehicleType || vcName || undefined,
        serviceType,
        dispatchMeta
      ).catch((err: any) => {
        console.error('[DISPATCH] startDispatch error:', err.message);
        // Fallback to legacy broadcast if dispatch engine fails
        notifyNearbyDriversNewTrip(tripRow.id, Number(pickupLat), Number(pickupLng), bookingVehicleCategoryId || undefined).catch(dbCatch("db"));
      });

      res.json({
        success: true,
        trip: tripRow,
        driver: null,
        status: "searching",
        uiState: toUiTripState({ current_status: 'searching' }),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Track current trip ------------------------------------------
  app.get("/api/app/customer/track-trip/:tripId", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { tripId } = req.params;
      const r = await rawDb.execute(rawSql`
        SELECT t.*,
          d.full_name as driver_name, d.phone as driver_phone, d.rating as driver_rating, d.profile_photo as driver_photo,
          COALESCE(dd.vehicle_number, d.vehicle_number) as driver_vehicle_number,
          COALESCE(dd.vehicle_model, d.vehicle_model) as driver_vehicle_model,
          vc.name as vehicle_name,
          COALESCE(dl.lat, d.current_lat) as driver_lat,
          COALESCE(dl.lng, d.current_lng) as driver_lng,
          dl.heading as driver_heading
        FROM trip_requests t
        LEFT JOIN users d ON d.id = t.driver_id
        LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
        LEFT JOIN driver_locations dl ON dl.driver_id = t.driver_id
        LEFT JOIN driver_details dd ON dd.user_id = t.driver_id
        WHERE t.id = ${tripId}::uuid AND t.customer_id = ${customer.id}::uuid
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Trip not found" });
      const trip = camelize(r.rows[0]) as any;
      trip.uiState = toUiTripState(trip);
      if (trip.rideStartedAt) {
        trip.rideTimerSeconds = Math.max(0, Math.floor((Date.now() - new Date(trip.rideStartedAt).getTime()) / 1000));
      }
      if (trip.driverLat != null && trip.driverLng != null) {
        const isPrePickup = ['searching', 'driver_assigned', 'accepted', 'arrived'].includes(String(trip.currentStatus));
        const targetLat = isPrePickup ? Number(trip.pickupLat) : Number(trip.destinationLat);
        const targetLng = isPrePickup ? Number(trip.pickupLng) : Number(trip.destinationLng);
        if (Number.isFinite(targetLat) && Number.isFinite(targetLng)) {
          const km = haversineKm(Number(trip.driverLat), Number(trip.driverLng), targetLat, targetLng);
          trip.etaMinutes = computeEtaMinutes(km);
        }
      }
      if (["arrived", "accepted", "driver_assigned"].includes(String(trip.currentStatus))) {
        trip.pickupOtpVisible = trip.pickupOtp;
      } else {
        delete trip.pickupOtp;
      }
      res.json({ trip });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Get active trip ---------------------------------------------
  app.get("/api/app/customer/active-trip", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;

      // Auto-cancel stale searching trips (no driver found in 5 minutes)
      await rawDb.execute(rawSql`
        UPDATE trip_requests
        SET current_status='cancelled', cancel_reason='Auto-cancelled: no pilot found'
        WHERE customer_id=${customer.id}::uuid
          AND current_status = 'searching'
          AND driver_id IS NULL
          AND created_at < NOW() - INTERVAL '5 minutes'
      `);

      const r = await rawDb.execute(rawSql`
        SELECT t.*,
          d.full_name as driver_name, d.phone as driver_phone, d.rating as driver_rating,
          d.profile_photo as driver_photo,
          COALESCE(dd.vehicle_number, d.vehicle_number) as driver_vehicle_number,
          COALESCE(dd.vehicle_model, d.vehicle_model) as driver_vehicle_model,
          COALESCE(dl.lat, d.current_lat) as driver_lat,
          COALESCE(dl.lng, d.current_lng) as driver_lng,
          dl.heading as driver_heading,
          vc.name as vehicle_name
        FROM trip_requests t
        LEFT JOIN users d ON d.id = t.driver_id
        LEFT JOIN driver_locations dl ON dl.driver_id = t.driver_id
        LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
        LEFT JOIN driver_details dd ON dd.user_id = t.driver_id
        WHERE t.customer_id = ${customer.id}::uuid AND t.current_status NOT IN ('completed','cancelled')
        ORDER BY t.created_at DESC LIMIT 1
      `);
      if (!r.rows.length) return res.json({ trip: null });
      const trip = camelize(r.rows[0]) as any;
      trip.uiState = toUiTripState(trip);
      if (trip.rideStartedAt) {
        trip.rideTimerSeconds = Math.max(0, Math.floor((Date.now() - new Date(trip.rideStartedAt).getTime()) / 1000));
      }
      if (trip.driverLat != null && trip.driverLng != null) {
        const isPrePickup = ['searching', 'driver_assigned', 'accepted', 'arrived'].includes(String(trip.currentStatus));
        const targetLat = isPrePickup ? Number(trip.pickupLat) : Number(trip.destinationLat);
        const targetLng = isPrePickup ? Number(trip.pickupLng) : Number(trip.destinationLng);
        if (Number.isFinite(targetLat) && Number.isFinite(targetLng)) {
          const km = haversineKm(Number(trip.driverLat), Number(trip.driverLng), targetLat, targetLng);
          trip.etaMinutes = computeEtaMinutes(km);
        }
      }
      // Round distance to 1 decimal
      if (trip.estimatedDistance) trip.estimatedDistance = Math.round(parseFloat(trip.estimatedDistance) * 10) / 10;
      if (trip.actualDistance) trip.actualDistance = Math.round(parseFloat(trip.actualDistance) * 10) / 10;
      // Show pickup OTP to customer when driver arrived (share with driver to start ride)
      const showPickupOtp = ['driver_assigned', 'accepted', 'arrived'].includes(trip.currentStatus);
      if (!showPickupOtp) delete trip.pickupOtp;
      // For parcel: show delivery OTP to customer (sender shares with receiver)
      // Only show delivery_otp when trip is 'on_the_way' or later
      if (trip.tripType !== 'parcel' && trip.tripType !== 'delivery') {
        delete trip.deliveryOtp;
      }
      res.json({ trip });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- TRIP: Get chat message history ---------------------------------------
  app.get("/api/app/trip/:tripId/messages", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { tripId } = req.params;
      // Verify user is a participant of this trip
      const access = await rawDb.execute(rawSql`
        SELECT id FROM trip_requests
        WHERE id=${tripId}::uuid AND (customer_id=${user.id}::uuid OR driver_id=${user.id}::uuid)
        LIMIT 1
      `);
      if (!access.rows.length) return res.status(403).json({ message: "Access denied" });

      const rows = await rawDb.execute(rawSql`
        SELECT id, trip_id, sender_id, sender_type, sender_name, message, created_at
        FROM trip_messages
        WHERE trip_id=${tripId}::uuid
        ORDER BY created_at ASC
        LIMIT 200
      `);
      return res.json({
        messages: rows.rows.map((r: any) => ({
          id: r.id,
          tripId: r.trip_id,
          from: r.sender_id,
          senderType: r.sender_type,
          senderName: r.sender_name,
          message: r.message,
          timestamp: r.created_at,
        })),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Cancel trip -------------------------------------------------
  app.post("/api/app/customer/cancel-trip", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { tripId, reason } = req.body;
      // If no tripId provided, find the active trip for this customer
      const effectiveTripId = tripId || await rawDb.execute(rawSql`
        SELECT id FROM trip_requests WHERE customer_id=${customer.id}::uuid
          AND current_status NOT IN ('completed','cancelled','on_the_way')
        ORDER BY created_at DESC LIMIT 1
      `).then(r2 => (r2.rows[0] as any)?.id).catch(() => null);
      if (!effectiveTripId) return res.status(404).json({ message: "No active trip to cancel" });
      const existingTripR = await rawDb.execute(rawSql`
        SELECT id, current_status, driver_id, payment_status, razorpay_payment_id
        FROM trip_requests
        WHERE id=${effectiveTripId}::uuid
          AND customer_id=${customer.id}::uuid
          AND current_status NOT IN ('completed','cancelled','on_the_way')
        LIMIT 1
      `);
      if (!existingTripR.rows.length) return res.status(400).json({ message: "Cannot cancel - trip already in progress or completed" });
      const existingTrip = existingTripR.rows[0] as any;
      const previousStatus = String(existingTrip.current_status || "");
      const r = await rawDb.execute(rawSql`
        UPDATE trip_requests SET current_status='cancelled', cancelled_by='customer', cancel_reason=${reason || 'Customer cancelled'}
        WHERE id=${effectiveTripId}::uuid AND customer_id=${customer.id}::uuid AND current_status NOT IN ('completed','cancelled','on_the_way')
        RETURNING *
      `);
      if (!r.rows.length) return res.status(400).json({ message: "Cannot cancel - trip already in progress or completed" });
      const trip = r.rows[0] as any;

      // Cancel active dispatch session if one exists
      cancelDispatch(effectiveTripId);

      await appendTripStatus(effectiveTripId, 'trip_cancelled', 'customer', reason || 'Customer cancelled');
      await logRideLifecycleEvent(effectiveTripId, 'trip_cancelled', customer.id, 'customer', { reason: reason || 'Customer cancelled' });
      clearTripWaypoints(effectiveTripId);
      // ?? Heatmap: log cancellation demand signal (location still valuable for supply/demand)
      if (trip.pickup_lat && trip.pickup_lng) {
        logHeatmapEvent('cancellation', parseFloat(trip.pickup_lat), parseFloat(trip.pickup_lng), 'ride');
      }
      if (trip.driver_id) {
        await rawDb.execute(rawSql`UPDATE users SET current_trip_id=NULL WHERE id=${trip.driver_id}::uuid`);
        const drvDevRes = await rawDb.execute(rawSql`SELECT fcm_token FROM user_devices WHERE user_id=${trip.driver_id}::uuid`);
        const drvFcm = (drvDevRes.rows[0] as any)?.fcm_token || null;
        notifyTripCancelled({ fcmToken: drvFcm, cancelledBy: "customer", tripId: effectiveTripId }).catch(dbCatch("db"));
        // Real-time socket: ensures driver TripScreen closes immediately even if FCM is delayed
        io.to(`user:${trip.driver_id}`).emit("trip:cancelled", { tripId: effectiveTripId, cancelledBy: "customer", reason: "Customer cancelled the trip" });
      }
      // -- Auto-refund if customer paid online ----------------------------------
      // SECURITY: Atomic UPDATE prevents double-refund race condition.
      // Strategy: try Razorpay bank refund first (original payment method),
      //           fall back to wallet credit if Razorpay fails/unavailable.
      let walletRefund: number | null = null;
      if (existingTrip.payment_status === 'paid_online') {
        const atomicRefund = await rawDb.execute(rawSql`
          UPDATE customer_payments
          SET status='refunded', refunded_at=NOW()
          WHERE trip_id=${effectiveTripId}::uuid
            AND customer_id=${customer.id}::uuid
            AND payment_type='ride_payment'
            AND status='completed'
          RETURNING id, amount
        `);
        if (atomicRefund.rows.length) {
          const refundAmt = Math.round(parseFloat((atomicRefund.rows[0] as any).amount) * 100) / 100;
          const rzpPaymentId = existingTrip.razorpay_payment_id || null;
          let refundedToBank = false;

          // Try Razorpay bank refund first (goes back to customer's UPI/card/bank)
          if (rzpPaymentId) {
            const rzpRefundId = await tryRazorpayRefund(
              rzpPaymentId, refundAmt, effectiveTripId, customer.id, 'Trip cancelled by customer'
            );
            if (rzpRefundId) {
              refundedToBank = true;
              await rawDb.execute(rawSql`
                UPDATE trip_requests SET payment_status='refunded_to_bank', razorpay_refund_id=${rzpRefundId}
                WHERE id=${effectiveTripId}::uuid
              `).catch(dbCatch("db"));
              console.log(`[CANCEL-REFUND] ?${refundAmt} bank-refunded via Razorpay ${rzpRefundId}, trip ${effectiveTripId}`);
            }
          }

          // Fallback: credit wallet (if no Razorpay payment ID or Razorpay refund failed)
          if (!refundedToBank) {
            await rawDb.execute(rawSql`UPDATE users SET wallet_balance = wallet_balance + ${refundAmt} WHERE id=${customer.id}::uuid`);
            await rawDb.execute(rawSql`
              UPDATE trip_requests SET payment_status='refunded_to_wallet' WHERE id=${effectiveTripId}::uuid
            `).catch(dbCatch("db"));
            walletRefund = refundAmt;
            console.log(`[CANCEL-REFUND] ?${refundAmt} credited to wallet for customer ${customer.id}, trip ${effectiveTripId}`);
          }

          const newBalRes = await rawDb.execute(rawSql`SELECT wallet_balance FROM users WHERE id=${customer.id}::uuid`);
          const newBal = Math.round(parseFloat((newBalRes.rows[0] as any).wallet_balance || '0') * 100) / 100;
          await rawDb.execute(rawSql`
            INSERT INTO transactions (user_id, account, credit, debit, balance, transaction_type, ref_transaction_id)
            VALUES (${customer.id}::uuid,
              ${refundedToBank ? 'Refund to bank � cancelled ride' : 'Refund to wallet � cancelled ride'},
              ${refundedToBank ? 0 : refundAmt}, 0, ${newBal},
              ${'ride_refund'}, ${rzpPaymentId || null})
            ON CONFLICT (ref_transaction_id, transaction_type) WHERE ref_transaction_id IS NOT NULL DO NOTHING
          `).catch((e: any) => console.error('[REFUND-TX]', e.message));
        }
      }
      // -- Customer cancel penalty: fee if driver was already assigned ---------
      let cancelFee = 0;
      try {
        if (shouldApplyCustomerLateCancelFee(previousStatus, existingTrip.driver_id)) {
          const feeR = await rawDb.execute(rawSql`
            SELECT value FROM business_settings WHERE key_name='customer_cancel_penalty' LIMIT 1
          `).catch(() => ({ rows: [] as any[] }));
          cancelFee = parseFloat((feeR.rows[0] as any)?.value || '20');
          // Deduct from wallet if balance available
          const walletR = await rawDb.execute(rawSql`SELECT wallet_balance FROM users WHERE id=${customer.id}::uuid LIMIT 1`);
          const walBal = parseFloat((walletR.rows[0] as any)?.wallet_balance || '0');
          if (canWalletCoverCharge(walBal, cancelFee)) {
            await rawDb.execute(rawSql`
              UPDATE users SET wallet_balance = wallet_balance - ${cancelFee}
              WHERE id=${customer.id}::uuid AND wallet_balance >= ${cancelFee}
            `);
            await rawDb.execute(rawSql`
              INSERT INTO transactions (user_id, trip_id, account, debit, credit, balance, transaction_type)
              VALUES (${customer.id}::uuid, ${effectiveTripId}::uuid, ${'Cancel Fee'}, ${cancelFee}, 0,
                ${walBal - cancelFee}, ${'cancel_fee'})
            `).catch(dbCatch("db"));
            log(`[CancelFee] Customer ${customer.id} charged ?${cancelFee} for late cancellation`, 'cancel');
          } else {
            cancelFee = 0; // Don't charge if wallet empty � just log
          }
        }
      } catch (_) { cancelFee = 0; }

      // Emit trip:cancelled socket event to customer so UI resets
      if (io) {
        io.to(`user:${customer.id}`).emit("trip:cancelled", {
          tripId: effectiveTripId,
          reason: reason || 'Customer cancelled',
          cancelledBy: 'customer',
          cancelFee,
        });
        io.to(`trip:${effectiveTripId}`).emit("trip:status_update", {
          tripId: effectiveTripId,
          status: 'cancelled',
        });
      }
      res.json({ success: true, walletRefund, cancelFee });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Boost trip fare to attract drivers (FIX #6 extension) -----
  app.post("/api/app/customer/trip/:id/boost-fare", authApp, requireCustomer, async (req, res) => {
    try {
      const { id: tripId } = req.params;
      const { boostPercentage } = req.body;
      const customerId = (req as any).currentUser.id;

      // Validate boost percentage (10-50%)
      if (!boostPercentage || boostPercentage < 0.1 || boostPercentage > 0.5) {
        return res.status(400).json({ error: 'Boost must be 10-50%' });
      }

      // Verify customer owns this trip
      const tripCheck = await rawDb.execute(rawSql`
        SELECT id, estimated_fare, pickup_lat, pickup_lng, current_status
        FROM trip_requests 
        WHERE id = ${tripId}::uuid AND customer_id = ${customerId}::uuid
      `);

      if (!tripCheck.rows.length) {
        return res.status(404).json({ error: 'Trip not found' });
      }

      const trip = camelize(tripCheck.rows[0] as any);

      // Only allow boost if still searching (no driver assigned yet)
      if (trip.current_status !== 'searching') {
        return res.status(400).json({ error: 'Cannot boost - trip already assigned or completed' });
      }

      // -- HARDENING: Apply boost fare --
      try {
        const result = await boostrFareOffer(tripId as string, customerId, boostPercentage);

        if (!result.success) {
          return res.status(400).json({ error: result.error });
        }

        // Notify nearby drivers of boosted fare
        if (io) {
          io.to(`drivers_search:${trip.pickup_lat}:${trip.pickup_lng}`).emit('trip:fare_updated', {
            tripId,
            newFare: result.newFare,
            boostPercentage: boostPercentage * 100,
          });
        }

        return res.json({
          success: true,
          newFare: result.newFare,
          boostPercentage: boostPercentage * 100,
          message: 'Fare boosted! More drivers will see your trip.',
        });
      } catch (hardeningErr: any) {
        log('HARDENING-BOOST-FARE', hardeningErr.message);
        return res.status(500).json({ error: 'Boost failed' });
      }
    } catch (e: any) {
      res.status(500).json({ error: safeErrMsg(e) });
    }
  });


  // -- CUSTOMER: Rate driver -------------------------------------------------
  app.post("/api/app/customer/rate-driver", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { tripId, rating, review } = req.body;
      const parsedRating = parseFloat(rating);
      if (!tripId || isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
        return res.status(400).json({ message: "tripId required and rating must be 1-5" });
      }
      const tripR = await rawDb.execute(rawSql`
        SELECT driver_id FROM trip_requests
        WHERE id=${tripId}::uuid AND customer_id=${customer.id}::uuid AND current_status='completed'
      `);
      if (!tripR.rows.length) return res.status(404).json({ message: "Completed trip not found" });
      const driverId = (tripR.rows[0] as any).driver_id;
      await rawDb.execute(rawSql`UPDATE trip_requests SET driver_rating=${parsedRating} WHERE id=${tripId}::uuid AND customer_id=${customer.id}::uuid`);
      if (driverId) {
        await rawDb.execute(rawSql`
          UPDATE users SET
            rating = (rating * total_ratings + ${parsedRating}) / (total_ratings + 1),
            total_ratings = total_ratings + 1
          WHERE id=${driverId}::uuid
        `);
        // Also insert into reviews table
        await rawDb.execute(rawSql`
          INSERT INTO reviews (trip_id, reviewer_id, reviewee_id, rating, comment, review_type)
          VALUES (${tripId}::uuid, ${customer.id}::uuid, ${driverId}::uuid, ${parsedRating}, ${review || ''}, 'customer_to_driver')
          ON CONFLICT DO NOTHING
        `).catch(dbCatch("db"));
      }
      // Free driver from current trip
      if (driverId) await rawDb.execute(rawSql`UPDATE users SET current_trip_id=NULL WHERE id=${driverId}::uuid`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Trip history -------------------------------------------------
  app.get("/api/app/customer/trips", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { limit = 20, offset = 0 } = req.query;
      const r = await rawDb.execute(rawSql`
        SELECT t.*, d.full_name as driver_name, d.phone as driver_phone, d.profile_photo as driver_photo,
          vc.name as vehicle_name
        FROM trip_requests t
        LEFT JOIN users d ON d.id = t.driver_id
        LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
        WHERE t.customer_id = ${customer.id}::uuid
        ORDER BY t.created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `);
      const cnt = await rawDb.execute(rawSql`SELECT COUNT(*) as total FROM trip_requests WHERE customer_id=${customer.id}::uuid`);
      const cTrips = camelize(r.rows);
      res.json({ trips: cTrips, total: Number((cnt.rows[0] as any).total) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Trip receipt -------------------------------------------------
  app.get("/api/app/customer/trip-receipt/:tripId", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { tripId } = req.params;
      const r = await rawDb.execute(rawSql`
        SELECT t.*,
          d.full_name as driver_name, d.phone as driver_phone,
          d.profile_photo as driver_photo, d.rating as driver_rating,
          vc.name as vehicle_name, vc.type as vehicle_type, vc.icon as vehicle_icon,
          d.vehicle_number, d.vehicle_model, d.vehicle_color
        FROM trip_requests t
        LEFT JOIN users d ON d.id = t.driver_id
        LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
        LEFT JOIN driver_details dd ON dd.user_id = t.driver_id
        WHERE t.id = ${tripId}::uuid
          AND t.customer_id = ${customer.id}::uuid
          AND t.current_status = 'completed'
        LIMIT 1
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Receipt not found" });
      const t = camelize(r.rows[0]) as any;

      const fare = parseFloat(t.actualFare || t.estimatedFare || 0);
      const gst = parseFloat(t.gstAmount || (fare * 0.05).toFixed(2));
      const dist = parseFloat(t.actualDistance || t.estimatedDistance || 0);
      const payable = parseFloat(t.customerFare || fare);
      const discount = parseFloat(t.discountAmount || 0);

      // Build receipt number: REC-<date>-<shortId>
      const dateStr = new Date(t.completedAt || t.createdAt).toISOString().slice(0, 10).replace(/-/g, '');
      const receiptNo = `REC-${dateStr}-${(t.refId || t.id?.slice(0, 8) || '').toUpperCase()}`;

      const receipt = {
        receiptNo,
        tripId: t.id,
        refId: t.refId,
        status: 'completed',
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        // Route
        pickup: { address: t.pickupAddress, lat: t.pickupLat, lng: t.pickupLng },
        destination: { address: t.destinationAddress, lat: t.destinationLat, lng: t.destinationLng },
        distanceKm: dist,
        durationMin: t.durationMin || 0,
        // Fare breakdown
        fare: {
          baseFare: parseFloat(t.baseFare || 0),
          distanceFare: parseFloat(t.distanceFare || (fare - parseFloat(t.baseFare || 0)).toFixed(2)),
          waitingCharge: parseFloat(t.waitingCharge || 0),
          gst,
          discount,
          total: fare,
          payable,
          paymentMethod: t.paymentMethod || 'cash',
          paymentStatus: t.paymentStatus || 'paid',
          currency: 'INR',
        },
        // Vehicle & driver
        vehicle: {
          name: t.vehicleName,
          type: t.vehicleType,
          icon: t.vehicleIcon,
          number: t.vehicleNumber,
          model: t.vehicleModel,
          color: t.vehicleColor,
        },
        driver: {
          name: t.driverName,
          rating: parseFloat(t.driverRating || 0),
          photo: t.driverPhoto,
        },
        tripType: t.tripType,
        cancelReason: t.cancelReason,
      };
      res.json({ receipt });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Trip receipt ----------------------------------------------------
  app.get("/api/app/driver/trip-receipt/:tripId", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { tripId } = req.params;
      const r = await rawDb.execute(rawSql`
        SELECT t.*,
          c.full_name as customer_name,
          vc.name as vehicle_name, vc.type as vehicle_type
        FROM trip_requests t
        LEFT JOIN users c ON c.id = t.customer_id
        LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
        WHERE t.id = ${tripId}::uuid
          AND t.driver_id = ${driver.id}::uuid
          AND t.current_status = 'completed'
        LIMIT 1
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Receipt not found" });
      const t = camelize(r.rows[0]) as any;

      const fare = parseFloat(t.actualFare || t.estimatedFare || 0);
      const gst = parseFloat(t.gstAmount || (fare * 0.05).toFixed(2));
      const commission = parseFloat(t.commissionAmount || 0);
      const driverCredit = parseFloat(t.driverWalletCredit || t.driverFare || (fare - commission).toFixed(2));
      const dist = parseFloat(t.actualDistance || t.estimatedDistance || 0);

      const dateStr = new Date(t.completedAt || t.createdAt).toISOString().slice(0, 10).replace(/-/g, '');
      const receiptNo = `REC-${dateStr}-${(t.refId || t.id?.slice(0, 8) || '').toUpperCase()}`;

      const receipt = {
        receiptNo,
        tripId: t.id,
        refId: t.refId,
        status: 'completed',
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        pickup: { address: t.pickupAddress },
        destination: { address: t.destinationAddress },
        distanceKm: dist,
        fare: {
          total: fare,
          gst,
          commission,
          driverEarning: driverCredit,
          paymentMethod: t.paymentMethod || 'cash',
          currency: 'INR',
        },
        customer: { name: t.customerName },
        vehicle: { name: t.vehicleName, type: t.vehicleType },
        tripType: t.tripType,
      };
      res.json({ receipt });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Fare estimate ------------------------------------------------
  app.post("/api/app/customer/estimate-fare", authApp, async (req, res) => {
    try {
      const {
        pickupLat, pickupLng,
        destLat: _destLat, destLng: _destLng,
        destinationLat, destinationLng,
        vehicleCategoryId, distanceKm, durationMin = 0,
        userId, // optional � if provided, include launch offer info
        category, // optional � 'ride' | 'parcel' | 'pool' to filter vehicle types
      } = req.body;
      const destLat = _destLat ?? destinationLat;
      const destLng = _destLng ?? destinationLng;

      // Server-side Haversine when distanceKm is not provided or is 0
      let dist = parseFloat(distanceKm || 0);
      if (dist === 0 && pickupLat && pickupLng && destLat && destLng) {
        const R = 6371;
        const lat1 = parseFloat(pickupLat) * Math.PI / 180;
        const lat2 = parseFloat(destLat) * Math.PI / 180;
        const dLat = (parseFloat(destLat) - parseFloat(pickupLat)) * Math.PI / 180;
        const dLng = (parseFloat(destLng) - parseFloat(pickupLng)) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
        dist = parseFloat((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.3).toFixed(2));
      }
      if (dist <= 0) dist = 1;

      const dur = parseFloat(durationMin || 0);
      // Night charge check: 22:00 - 06:00 IST
      const nowHr = new Date().getUTCHours() + 5.5;
      const hr = nowHr >= 24 ? nowHr - 24 : nowHr;
      const isNight = hr >= 22 || hr < 6;

      // Zone surge factor: use detectZoneId (polygon + radius fallback)
      let zoneSurge = 1.0;
      let activeZoneName = '';
      if (pickupLat && pickupLng) {
        try {
          const detectedZoneId = await detectZoneId(parseFloat(pickupLat), parseFloat(pickupLng));
          if (detectedZoneId) {
            const zr = await rawDb.execute(rawSql`SELECT name, surge_factor FROM zones WHERE id=${detectedZoneId}::uuid AND is_active=true LIMIT 1`);
            if (zr.rows.length) {
              zoneSurge = parseFloat((zr.rows[0] as any).surge_factor) || 1.0;
              activeZoneName = (zr.rows[0] as any).name || '';
            }
          }
        } catch { }
      }

      // DISTINCT ON ensures exactly one row per vehicle category, avoiding zone duplicates
      const fareR = await rawDb.execute(rawSql`
        SELECT DISTINCT ON (f.vehicle_category_id)
          f.*, vc.name as vehicle_name, vc.icon as vehicle_icon,
          vc.vehicle_type as vc_vehicle_type,
          vc.base_fare     as vc_base_fare,
          vc.fare_per_km   as vc_fare_per_km,
          vc.minimum_fare  as vc_minimum_fare,
          vc.waiting_charge_per_min as vc_waiting_charge,
          COALESCE(vc.total_seats, 0) as vc_total_seats,
          COALESCE(vc.is_carpool, false) as vc_is_carpool,
          vc.is_active as is_active
        FROM trip_fares f
        JOIN vehicle_categories vc ON vc.id = f.vehicle_category_id
        WHERE 1=1
        ${vehicleCategoryId ? rawSql`AND f.vehicle_category_id = ${vehicleCategoryId}::uuid` : rawSql``}
        ${category ? rawSql`AND vc.type = ${category}` : rawSql``}
        ORDER BY f.vehicle_category_id, vc.name
      `);
      const fares = camelize(fareR.rows).map((f: any) => {
        // Resolve vehicle name for smart defaults
        const vn = (f.vehicleName || '').toLowerCase();
        const isSuv = vn.includes('suv');
        const isSedan = !isSuv && (vn.includes('sedan') || (vn.includes('car') && !vn.includes('mini') && !vn.includes('pool') && !vn.includes('share')));
        const isMini = vn.includes('mini');
        const isPool = vn.includes('pool') || vn.includes('share');
        const isAuto = !isSuv && !isSedan && !isMini && !isPool && vn.includes('auto');
        const isCargo = vn.includes('cargo');
        const isParcel = !isCargo && vn.includes('parcel');

        // Smart defaults by vehicle type
        const defaultBase = isSuv ? 100 : isSedan ? 80 : isMini ? 60 : isPool ? 80 : isAuto ? 40 : isCargo ? 80 : isParcel ? 35 : 30;
        const defaultPerKm = isSuv ? 22 : isSedan ? 18 : isMini ? 16 : isPool ? 15 : isAuto ? 15 : isCargo ? 20 : isParcel ? 13 : 12;
        const defaultMin = isSuv ? 150 : isSedan ? 120 : isMini ? 80 : isPool ? 100 : isAuto ? 60 : isCargo ? 100 : isParcel ? 40 : 40;
        const defaultWait = isSuv ? 3 : (isSedan || isMini || isPool || isAuto) ? 2 : 1;

        // vehicle_categories pricing takes precedence over trip_fares (trip_fares is zone-specific override)
        const base = parseFloat(f.vcBaseFare) || parseFloat(f.baseFare) || defaultBase;
        const perKm = parseFloat(f.vcFarePerKm) || parseFloat(f.farePerKm) || defaultPerKm;
        const perMin = parseFloat(f.farePerMin) || 0;
        const minFare = parseFloat(f.vcMinimumFare) || parseFloat(f.minimumFare) || defaultMin;
        const waitPerMin = parseFloat(f.vcWaitingCharge) || parseFloat(f.waitingChargePerMin) || defaultWait;
        const nightMultiplier = parseFloat(f.nightChargeMultiplier) || 1.25;
        const cancelFee = parseFloat(f.cancellationFee) || 10;
        const helperCharge = parseFloat(f.helperCharge) || 0;
        const isCarpool = f.vcIsCarpool === true || f.vcIsCarpool === 'true';
        const totalSeats = parseInt(f.vcTotalSeats) || 4;

        // Formula: fullFare = base_fare + (distanceKm � fare_per_km), floored at minimum_fare
        const billableKm = dist;
        const distanceFare = +(billableKm * perKm).toFixed(2);
        const timeFare = +(dur * perMin).toFixed(2);

        let subtotal = base + distanceFare + timeFare;
        if (isNight) subtotal = +(subtotal * nightMultiplier).toFixed(2);
        if (zoneSurge > 1) subtotal = +(subtotal * zoneSurge).toFixed(2);
        const total = Math.max(subtotal, minFare);
        // GST 5% on full fare (government tax)
        const gst = +(total * 0.05).toFixed(2);
        const grandTotal = +(total + gst).toFixed(2);
        // �5% range shown in UI: "?85 � ?95"
        const fareMin = Math.floor(grandTotal * 0.95);
        const fareMax = Math.ceil(grandTotal * 1.05);
        const estTime = Math.max(5, Math.round(dist * 3));

        // -- Car Pool: seat-based pricing ----------------------------------
        const seatPrice = isCarpool ? +(grandTotal / totalSeats).toFixed(2) : 0;

        return {
          vehicleCategoryId: f.vehicleCategoryId,
          vehicleName: f.vehicleName || "Ride",
          vehicleType: f.vcVehicleType || null,
          vehicleIcon: f.vehicleIcon,
          baseFare: +base.toFixed(2),
          farePerKm: +perKm.toFixed(2),
          billableKm: +billableKm.toFixed(2),
          distanceFare,
          timeFare,
          subtotal: +total.toFixed(2),
          gst,
          estimatedFare: grandTotal,
          fareMin,
          fareMax,
          isActive: f.isActive === true || f.isActive === 'true',
          minimumFare: +minFare.toFixed(2),
          cancellationFee: +cancelFee.toFixed(2),
          waitingChargePerMin: +waitPerMin.toFixed(2),
          isNightCharge: isNight,
          nightMultiplier: isNight ? nightMultiplier : 1,
          helperCharge: +helperCharge.toFixed(2),
          estimatedTime: estTime + " min",
          // Car Pool fields
          isCarpool,
          totalSeats: isCarpool ? totalSeats : undefined,
          seatPrice: isCarpool ? seatPrice : undefined,
          seatPriceDisplay: isCarpool ? `?${seatPrice}/seat` : undefined,
          zoneSurge: zoneSurge > 1 ? zoneSurge : undefined,
          zoneName: zoneSurge > 1 ? activeZoneName : undefined,
        };
      });

      // -- User launch offer: first 2 rides 50% discount ---------------------
      let launchOffer: any = null;
      if (userId) {
        const userR = await rawDb.execute(rawSql`SELECT completed_rides_count FROM users WHERE id=${userId}::uuid LIMIT 1`).catch(() => ({ rows: [] as any[] }));
        const completedCount = parseInt((userR.rows[0] as any)?.completed_rides_count ?? '0') || 0;
        if (completedCount < 2) {
          launchOffer = {
            active: true,
            discountPct: 50,
            ridesRemaining: 2 - completedCount,
            message: `?? Launch Offer: 50% off your first 2 rides! (${2 - completedCount} ride(s) remaining)`,
          };
        }
      }

      res.json({ fares, distanceKm: Math.round(dist * 10) / 10, durationMin: dur, isNight, launchOffer });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ETA: Google Distance Matrix API -----------------------------------------
  // Returns real drive time (traffic-aware) between driver and customer pickup.
  // Falls back to straight-line Haversine estimate if Google API unavailable.
  app.get("/api/app/eta", authApp, async (req, res) => {
    try {
      const { originLat, originLng, destLat, destLng } = req.query as Record<string, string>;
      if (!originLat || !originLng || !destLat || !destLng) {
        return res.status(400).json({ message: "originLat, originLng, destLat, destLng required" });
      }
      const oLat = parseFloat(originLat), oLng = parseFloat(originLng);
      const dLat = parseFloat(destLat), dLng = parseFloat(destLng);

      // Try Google Distance Matrix first
      const gmapsKey = (await getConf("GOOGLE_MAPS_API_KEY", "google_maps_key"))?.trim() || '';

      let etaMinutes: number;
      let distanceKm: number;
      let source = 'haversine';

      try {
        if (!gmapsKey) throw new Error('Google Maps API key not configured � using Haversine fallback');
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${oLat},${oLng}&destinations=${dLat},${dLng}&mode=driving&departure_time=now&traffic_model=best_guess&key=${gmapsKey}`;
        const gmRes = await fetch(url).then(r => r.json()) as any;
        const element = gmRes?.rows?.[0]?.elements?.[0];
        if (element?.status === 'OK') {
          const durationInTraffic = element.duration_in_traffic?.value || element.duration?.value || 0;
          const distanceM = element.distance?.value || 0;
          etaMinutes = Math.ceil(durationInTraffic / 60);
          distanceKm = Math.round(distanceM / 100) / 10;
          source = 'google';
        } else {
          throw new Error('Google API element not OK');
        }
      } catch (_) {
        // Haversine fallback: avg speed 20 km/h in city
        const R = 6371;
        const dLat2 = (dLat - oLat) * Math.PI / 180;
        const dLng2 = (dLng - oLng) * Math.PI / 180;
        const a = Math.sin(dLat2 / 2) ** 2 + Math.cos(oLat * Math.PI / 180) * Math.cos(dLat * Math.PI / 180) * Math.sin(dLng2 / 2) ** 2;
        distanceKm = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
        etaMinutes = Math.ceil(distanceKm / 20 * 60); // 20 km/h average
      }

      res.json({ etaMinutes, distanceKm, source });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- PARCEL FARE ESTIMATE (weight + distance + helpers based) ----------------
  // Formula: customerFare = base_fare + (distanceKm � fare_per_km) + (weightKg � weight_rate) + loadingCharge + (helpers � helperChargePerHour � hours)
  // driverFare  = customerFare � platform commission (per parcels_model setting)
  app.post("/api/app/customer/estimate-parcel-fare", authApp, async (req, res) => {
    try {
      const { pickupLat, pickupLng, destLat, destLng, weightKg = 0, helpers = 0, helperHours = 1 } = req.body;

      const pLat = Number(pickupLat), pLng = Number(pickupLng);
      const dLat = Number(destLat), dLng = Number(destLng);

      // Haversine distance
      let distKm = 0;
      if (pLat && pLng && dLat && dLng) {
        const R = 6371;
        const dLa = (dLat - pLat) * Math.PI / 180;
        const dLo = (dLng - pLng) * Math.PI / 180;
        const a = Math.sin(dLa / 2) ** 2 + Math.cos(pLat * Math.PI / 180) * Math.cos(dLat * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
        distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }

      // Fetch all active parcel vehicles + their weight_rate
      const vcRes = await rawDb.execute(rawSql`
        SELECT id, name, vehicle_type, icon,
               base_fare, fare_per_km, minimum_fare, weight_rate
        FROM vehicle_categories
        WHERE type = 'parcel' AND is_active = true
        ORDER BY base_fare ASC
      `);

      if (!vcRes.rows.length) return res.status(404).json({ message: "No parcel vehicle types configured" });

      // Fetch parcels commission model setting
      const settingsRes = await rawDb.execute(rawSql`
        SELECT key_name, value FROM revenue_model_settings
        WHERE key_name IN ('parcels_model','driver_commission_pct','commission_rate','ride_gst_rate')
      `);
      const settings: Record<string, string> = {};
      for (const row of settingsRes.rows as any[]) settings[row.key_name] = row.value;

      const parcelsModel = settings['parcels_model'] || 'commission';
      const commPct = parseFloat(settings['driver_commission_pct'] || '20') / 100;
      const gstRate = parseFloat(settings['ride_gst_rate'] || '5') / 100;

      const wt = Math.max(0, Number(weightKg));
      const helperCount = Math.min(Math.max(0, parseInt(helpers) || 0), 5); // cap at 5 helpers
      const hHours = Math.max(1, parseFloat(helperHours) || 1);

      // Fetch zone-specific parcel fare config; fall back to any active config
      const pickupZoneId = pLat && pLng ? await detectZoneId(pLat, pLng) : null;
      let pfRes;
      if (pickupZoneId) {
        pfRes = await rawDb.execute(rawSql`
          SELECT base_fare, fare_per_km, fare_per_kg, minimum_fare, loading_charge, helper_charge_per_hour, max_helpers
          FROM parcel_fares WHERE zone_id = ${pickupZoneId}::uuid LIMIT 1
        `).catch(() => ({ rows: [] as any[] }));
      }
      if (!pfRes?.rows?.length) {
        pfRes = await rawDb.execute(rawSql`
          SELECT base_fare, fare_per_km, fare_per_kg, minimum_fare, loading_charge, helper_charge_per_hour, max_helpers
          FROM parcel_fares ORDER BY created_at DESC LIMIT 1
        `).catch(() => ({ rows: [] as any[] }));
      }
      const pf: any = pfRes.rows[0] || {};
      const globalLoadCharge = parseFloat(pf.loading_charge || '0');
      const globalHelperRate = parseFloat(pf.helper_charge_per_hour || '0');
      const globalMaxHelpers = parseInt(pf.max_helpers || '0') || 5;
      // Zone-specific overrides for base/perKm rates (if configured in parcel_fares)
      const zoneBaseFare = pf.base_fare ? parseFloat(pf.base_fare) : null;
      const zonePerKm = pf.fare_per_km ? parseFloat(pf.fare_per_km) : null;
      const zonePerKg = pf.fare_per_kg ? parseFloat(pf.fare_per_kg) : null;
      const zoneMinFare = pf.minimum_fare ? parseFloat(pf.minimum_fare) : null;

      const fares = (vcRes.rows as any[]).map(vc => {
        // Use zone-specific parcel_fares rates when configured, else vehicle_categories defaults
        const baseFare = zoneBaseFare ?? parseFloat(vc.base_fare || 0);
        const perKm = zonePerKm ?? parseFloat(vc.fare_per_km || 0);
        const minFare = zoneMinFare ?? parseFloat(vc.minimum_fare || 0);
        const weightRate = zonePerKg ?? parseFloat(vc.weight_rate || 0);

        const rawFare = baseFare + (distKm * perKm) + (wt * weightRate);
        const loadCharge = globalLoadCharge;
        const effectiveHelpers = Math.min(helperCount, globalMaxHelpers);
        const helperCharge = effectiveHelpers * globalHelperRate * hHours;
        const customerFare = Math.ceil(Math.max(rawFare + loadCharge + helperCharge, minFare));
        const gstAmount = Math.ceil(customerFare * gstRate);
        const grandTotal = customerFare + gstAmount;

        // driverFare = what driver earns after platform deduction
        let platformFee = 0;
        if (parcelsModel === 'commission') {
          platformFee = Math.ceil(customerFare * commPct);
        }
        const driverFare = Math.max(0, customerFare - platformFee);

        return {
          vehicleCategoryId: vc.id,
          vehicleName: vc.name,
          vehicleType: vc.vehicle_type,
          icon: vc.icon,
          distanceKm: Math.round(distKm * 10) / 10,
          weightKg: wt,
          baseFare,
          perKmCharge: Math.ceil(distKm * perKm),
          weightCharge: Math.ceil(wt * weightRate),
          loadingCharge: loadCharge,
          helperCharge,
          helpersUsed: effectiveHelpers,
          helperHours: hHours,
          helperRatePerHour: globalHelperRate,
          maxHelpers: globalMaxHelpers,
          customerFare,
          gstAmount,
          grandTotal,
          driverFare,
          platformFee,
        };
      });

      res.json({ fares, distanceKm: Math.round(distKm * 10) / 10, weightKg: wt });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- VOICE BOOKING: AI-Enhanced NLP Intent Parser --------------------------
  // In-memory voice log ring buffer (last 200 requests)
  const voiceLogs: Array<{ id: number; ts: string; text: string; intent: string; pickup: string | null; destination: string | null; vehicleType: string | null; parser: string; success: boolean }> = [];
  let voiceLogSeq = 0;

  app.post("/api/app/voice-booking/parse", authApp, async (req, res) => {
    try {
      if (!VOICE_BOOKING_ENABLED) {
        return res.status(503).json({
          success: false,
          message: "Voice booking is disabled in production while core platform stabilization is in progress.",
        });
      }
      const { text, currentLat, currentLng, currentAddress } = req.body;
      if (!text) return res.status(400).json({ message: "No text provided" });

      const { parsed, parserSource } = await parseVoiceIntentOrchestrated(text);

      let vehicleName = parsed.vehicleType || "Bike";
      let vehicleCategoryId: string | null = null;

      const vcRes = await rawDb.execute(rawSql`
        SELECT id, name FROM vehicle_categories
        WHERE LOWER(name) LIKE ${`%${vehicleName.toLowerCase().split(' ')[0]}%`} AND is_active=true LIMIT 1
      `);
      if (vcRes.rows.length) {
        vehicleCategoryId = (vcRes.rows[0] as any).id;
        vehicleName = (vcRes.rows[0] as any).name;
      }

      let pickupGeo: any = null;
      let destGeo: any = null;

      const apiKey = await getConf("GOOGLE_MAPS_API_KEY", "google_maps_key");

      // Check if pickup is current location
      const isCurrentLocation = !parsed.pickup ||
        /current|here|my location|ikkade|ikkad|yahan|naa location/i.test(parsed.pickup || '');

      if (isCurrentLocation && currentLat && currentLng) {
        // Use GPS coordinates directly � no geocoding needed
        pickupGeo = { lat: Number(currentLat), lng: Number(currentLng), address: currentAddress || 'Current Location' };
        if (apiKey && parsed.destination) destGeo = await geocodePlaceWithCache(apiKey, parsed.destination);
      } else if (parsed.pickup || parsed.destination) {
        const promises: Promise<any>[] = [];
        promises.push(apiKey && parsed.pickup ? geocodePlaceWithCache(apiKey, parsed.pickup) : Promise.resolve(null));
        promises.push(apiKey && parsed.destination ? geocodePlaceWithCache(apiKey, parsed.destination) : Promise.resolve(null));
        [pickupGeo, destGeo] = await Promise.all(promises);
      }

      const responseData = {
        success: parsed.intent !== "unknown",
        intent: parsed.intent || "book_ride",
        confidence: parsed.confidence,
        pickup: pickupGeo?.address || parsed.pickup,
        destination: destGeo?.address || parsed.destination,
        pickupLat: pickupGeo?.lat || null,
        pickupLng: pickupGeo?.lng || null,
        destLat: destGeo?.lat || null,
        destLng: destGeo?.lng || null,
        vehicleName,
        vehicleType: parsed.vehicleType || null,
        vehicleCategoryId,
        entities: parsed.entities,
        parserSource,
        originalText: text,
      };

      // Log to ring buffer
      voiceLogs.push({
        id: ++voiceLogSeq,
        ts: new Date().toISOString(),
        text,
        intent: responseData.intent,
        pickup: responseData.pickup || null,
        destination: responseData.destination || null,
        vehicleType: responseData.vehicleType,
        parser: parserSource,
        success: responseData.success,
      });
      if (voiceLogs.length > 200) voiceLogs.shift();

      res.json(responseData);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- ADMIN: Voice booking logs -----------------------------------------------
  app.get("/api/admin/voice-logs", requireAdminAuth, async (_req, res) => {
    const logs = [...voiceLogs].reverse();
    const totalRequests = voiceLogs.length;
    const successCount = voiceLogs.filter(l => l.success).length;
    const intentCounts = voiceLogs.reduce((acc, l) => {
      acc[l.intent] = (acc[l.intent] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    res.json({
      logs,
      stats: {
        totalRequests,
        successCount,
        successRate: totalRequests ? Math.round((successCount / totalRequests) * 100) : 0,
        intentCounts,
      },
    });
  });

  // -- SHARED: Nearby drivers (for customer map) ------------------------------
  app.get("/api/app/nearby-drivers", nearbyDriversLimiter, async (req, res) => {
    try {
      const { lat, lng, radius = 5, vehicleCategoryId } = req.query;
      const latNum = Number(lat); const lngNum = Number(lng);
      if (!lat || !lng || isNaN(latNum) || isNaN(lngNum) || latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
        return res.status(400).json({ message: "Valid lat and lng required" });
      }
      const vcFilter = vehicleCategoryId
        ? rawSql`AND dd.vehicle_category_id = ${vehicleCategoryId as string}::uuid`
        : rawSql``;
      const r = await rawDb.execute(rawSql`
        SELECT u.id, u.full_name, u.rating, dl.lat, dl.lng, dl.heading,
          vc.name as vehicle_name, vc.id as vehicle_category_id
        FROM driver_locations dl
        JOIN users u ON u.id = dl.driver_id
        JOIN driver_details dd ON dd.user_id = u.id
        LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
        WHERE dl.is_online=true AND u.is_active=true AND u.is_locked=false
          AND u.current_trip_id IS NULL
          AND u.verification_status IN ('approved', 'verified', 'pending')
          ${vcFilter}
          AND (dl.lat - ${latNum})*(dl.lat - ${latNum}) + (dl.lng - ${lngNum})*(dl.lng - ${lngNum}) < ${Number(radius) * Number(radius) / 10000}
        LIMIT 20
      `);
      res.json({ drivers: camelize(r.rows) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- SHARED: Update FCM token ----------------------------------------------
  app.post("/api/app/fcm-token", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { fcmToken, deviceType = "android", appVersion } = req.body;
      await rawDb.execute(rawSql`
        INSERT INTO user_devices (user_id, fcm_token, device_type, app_version)
        VALUES (${user.id}::uuid, ${fcmToken}, ${deviceType}, ${appVersion || ''})
        ON CONFLICT (user_id) DO UPDATE SET fcm_token=${fcmToken}, device_type=${deviceType}, app_version=${appVersion || ''}, updated_at=NOW()
      `);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- SHARED: App configs (vehicle categories, cancellation reasons etc) ----
  app.get("/api/app/configs", async (_req, res) => {
    try {
      const [cats, reasons, settings, brands, parcelCats, parcelWeights] = await Promise.all([
        rawDb.execute(rawSql`SELECT id, name, icon, type, is_active FROM vehicle_categories WHERE is_active=true ORDER BY CASE type WHEN 'ride' THEN 1 WHEN 'parcel' THEN 2 WHEN 'cargo' THEN 3 ELSE 4 END, name`),
        rawDb.execute(rawSql`SELECT * FROM cancellation_reasons WHERE is_active=true`),
        rawDb.execute(rawSql`SELECT key_name, value FROM business_settings WHERE key_name IN ('otp_on_pickup','max_ride_radius_km','driver_auto_accept','sos_number','support_phone','currency','currency_symbol')`),
        rawDb.execute(rawSql`SELECT * FROM vehicle_brands WHERE is_active=true ORDER BY category, name`),
        rawDb.execute(rawSql`SELECT * FROM parcel_categories WHERE is_active=true ORDER BY name`),
        rawDb.execute(rawSql`SELECT * FROM parcel_weights WHERE is_active=true ORDER BY min_weight`),
      ]);
      const configs: any = {};
      (settings.rows as any[]).forEach(r => { configs[r.key_name] = r.value; });
      res.json({
        vehicleCategories: camelize(cats.rows),
        cancellationReasons: camelize(reasons.rows),
        vehicleBrands: camelize(brands.rows),
        parcelCategories: camelize(parcelCats.rows),
        parcelWeights: camelize(parcelWeights.rows),
        configs,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER/DRIVER: SOS alert --------------------------------------------
  app.post("/api/app/sos", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { lat, lng, tripId, message } = req.body;
      // Insert into safety_alerts (correct table � sos_alerts was wrong table name)
      const r = await rawDb.execute(rawSql`
        INSERT INTO safety_alerts (user_id, trip_id, alert_type, triggered_by, latitude, longitude, notes, status)
        VALUES (
          ${user.id}::uuid,
          ${tripId || null},
          'sos',
          ${user.userType === 'driver' ? 'driver' : 'customer'},
          ${lat ? Number(lat) : null},
          ${lng ? Number(lng) : null},
          ${message || 'SOS triggered from app'},
          'active'
        )
        RETURNING id
      `);
      const alertId = (r.rows[0] as any)?.id || null;
      console.log(`[SOS] ? ${user.userType} ${user.fullName} (${user.phone}) at ${lat},${lng} alertId=${alertId}`);
      res.json({ success: true, alertId, message: "SOS alert sent. Help is on the way." });
    } catch (e: any) {
      console.error(`[SOS] ? Failed to create alert:`, e);
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- CUSTOMER: Wallet balance + transactions -------------------------------
  app.get("/api/app/customer/wallet", authApp, requireCustomer, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const walRes = await rawDb.execute(rawSql`SELECT wallet_balance FROM users WHERE id=${customer.id}::uuid`);
      const balance = parseFloat((walRes.rows[0] as any)?.wallet_balance || "0");
      const txRes = await rawDb.execute(rawSql`
        SELECT id, account, debit, credit, balance, transaction_type, ref_transaction_id, created_at
        FROM transactions WHERE user_id=${customer.id}::uuid ORDER BY created_at DESC LIMIT 50
      `);
      const transactions = txRes.rows.map((r: any) => ({
        id: r.id,
        type: parseFloat(r.credit || 0) > 0 ? 'credit' : 'debit',
        amount: parseFloat(r.credit || 0) > 0 ? parseFloat(r.credit) : parseFloat(r.debit || 0),
        description: r.account || r.transaction_type || 'Transaction',
        paymentMethod: r.account || '',
        referenceId: r.ref_transaction_id || '',
        balance: parseFloat(r.balance || 0),
        date: r.created_at,
      }));
      res.json({ balance, transactions });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Wallet recharge � DISABLED (use Razorpay verify-payment instead) --
  app.post("/api/app/customer/wallet/recharge", authApp, async (_req, res) => {
    // This legacy endpoint credited wallet without payment verification.
    // All wallet recharges must go through create-order ? Razorpay ? verify-payment.
    return res.status(410).json({ message: "Please use the payment gateway to recharge your wallet." });
    /* DISABLED � security fix
    try {
      const customer = (req as any).currentUser;
      const { amount, paymentRef, paymentMethod = "upi" } = req.body;
      const amt = parseFloat(amount);
      if (!amt || amt <= 0) return res.status(400).json({ message: "Invalid amount" });
      if (amt < 10) return res.status(400).json({ message: "Minimum recharge is ?10" });
      if (amt > 10000) return res.status(400).json({ message: "Maximum recharge is ?10,000 per transaction" });
      if (!paymentRef) return res.status(400).json({ message: "Payment reference required" });
      await rawDb.execute(rawSql`UPDATE users SET wallet_balance = wallet_balance + ${amt} WHERE id=${customer.id}::uuid`);
      const newBalRes = await rawDb.execute(rawSql`SELECT wallet_balance FROM users WHERE id=${customer.id}::uuid`);
      const newBal = parseFloat((newBalRes.rows[0] as any).wallet_balance || "0");
      await rawDb.execute(rawSql`
        INSERT INTO transactions (user_id, account, credit, debit, balance, transaction_type, ref_transaction_id)
        VALUES (${customer.id}::uuid, ${`Wallet recharge via ${paymentMethod}`}, ${amt}, 0, ${newBal}, ${'wallet_recharge'}, ${paymentRef||null})
      `).catch(dbCatch("db"));
      res.json({ success: true, balance: newBal, message: `?${amt} added to wallet` });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
    */
  });

  // -- CUSTOMER: Razorpay � Create order ------------------------------------
  app.post("/api/app/customer/wallet/create-order", authApp, requireCustomer, paymentOrderLimiter, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { amount } = req.body;
      const amt = parseFloat(amount);
      if (!amt || amt < 10 || amt > 50000) return res.status(400).json({ message: "Amount must be ?10�?50,000" });
      const { keyId, keySecret } = await getRazorpayKeys();
      if (!keyId || !keySecret) return res.status(503).json({ message: "Payment gateway not configured" });
      const Razorpay = _require("razorpay");
      const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret, timeout: 15000 });
      // Explicit 20s timeout � prevents DO App Platform 504 if Razorpay API is slow
      const timeoutErr = new Error("Payment gateway timeout. Please try again.");
      const order = await Promise.race([
        rzp.orders.create({
          amount: Math.round(amt * 100),
          currency: "INR",
          receipt: `w_${Date.now().toString(36)}`,
          notes: { customer_id: customer.id, purpose: "wallet_topup" }
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(timeoutErr), 20000))
      ]);
      // Persist pending record so verify-payment can cross-check amount from DB
      await rawDb.execute(rawSql`
        INSERT INTO customer_payments (customer_id, amount, payment_type, razorpay_order_id, status, description)
        VALUES (${customer.id}::uuid, ${amt}, 'wallet_topup', ${order.id}, 'pending', 'Wallet topup via Razorpay')
        ON CONFLICT DO NOTHING
      `).catch(dbCatch("db"));
      res.json({ order, keyId, amount: amt });
    } catch (e: any) {
      console.error("[wallet-order]", e.message || e);
      const msg = e.message?.includes("timeout") ? "Payment gateway timeout. Please try again." : safeErrMsg(e);
      res.status(500).json({ message: msg });
    }
  });

  // -- CUSTOMER: Razorpay � Verify & credit wallet ---------------------------
  app.post("/api/app/customer/wallet/verify-payment", authApp, requireCustomer, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) return res.status(400).json({ message: "Missing payment details" });
      const { keySecret } = await getRazorpayKeys();
      if (!keySecret) return res.status(503).json({ message: "Payment gateway not configured" });
      // Timing-safe HMAC verification
      const expectedSig = crypto.createHmac("sha256", keySecret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
      const sigValid = expectedSig.length === razorpaySignature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSig, "utf8"), Buffer.from(razorpaySignature, "utf8"));
      if (!sigValid) return res.status(400).json({ message: "Invalid payment signature" });
      // Idempotency: reject duplicate payment IDs
      const dupCheck = await rawDb.execute(rawSql`
        SELECT id FROM transactions WHERE ref_transaction_id=${razorpayPaymentId} AND transaction_type='wallet_recharge' LIMIT 1
      `);
      if (dupCheck.rows.length) return res.status(409).json({ message: "Payment already processed", alreadyCredited: true });
      // Amount from DB � never trust client-sent amount
      // SECURITY: Atomic mark-completed first prevents concurrent double-credit
      const atomicMark = await rawDb.execute(rawSql`
        UPDATE customer_payments SET razorpay_payment_id=${razorpayPaymentId}, status='completed', verified_at=NOW()
        WHERE razorpay_order_id=${razorpayOrderId} AND customer_id=${customer.id}::uuid AND status='pending'
        RETURNING amount
      `);
      if (!atomicMark.rows.length) return res.status(409).json({ message: "Payment already processed", alreadyCredited: true });
      const amt = Math.round(parseFloat((atomicMark.rows[0] as any).amount) * 100) / 100;
      await rawDb.execute(rawSql`UPDATE users SET wallet_balance = wallet_balance + ${amt} WHERE id=${customer.id}::uuid`);
      const newBalRes = await rawDb.execute(rawSql`SELECT wallet_balance FROM users WHERE id=${customer.id}::uuid`);
      const newBal = Math.round(parseFloat((newBalRes.rows[0] as any).wallet_balance || "0") * 100) / 100;
      await rawDb.execute(rawSql`
        INSERT INTO transactions (user_id, account, credit, debit, balance, transaction_type, ref_transaction_id)
        VALUES (${customer.id}::uuid, ${'Wallet recharge via Razorpay'}, ${amt}, 0, ${newBal}, ${'wallet_recharge'}, ${razorpayPaymentId})
        ON CONFLICT (ref_transaction_id, transaction_type) WHERE ref_transaction_id IS NOT NULL DO NOTHING
      `).catch((e: any) => console.error('[WALLET-RECHARGE-TX]', e.message));
      res.json({ success: true, balance: newBal, message: `?${amt.toFixed(0)} added to wallet` });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Razorpay � Create order for ride payment --------------------
  app.post("/api/app/customer/ride/create-order", authApp, requireCustomer, paymentOrderLimiter, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { amount, tripId } = req.body;
      const amt = parseFloat(amount);
      if (!amt || amt <= 0 || amt > 50000) return res.status(400).json({ message: "Invalid fare amount" });
      const { keyId, keySecret } = await getRazorpayKeys();
      if (!keyId || !keySecret) return res.status(503).json({ message: "Payment gateway not configured" });
      const Razorpay = _require("razorpay");
      const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret, timeout: 15000 });
      const order = await rzp.orders.create({
        amount: Math.round(amt * 100),
        currency: "INR",
        receipt: `r_${Date.now().toString(36)}`,
        notes: { customer_id: customer.id, purpose: "ride_payment", trip_id: tripId || '' }
      });
      // Persist pending record with trip_id so verify/cancel can trace back
      await rawDb.execute(rawSql`
        INSERT INTO customer_payments (customer_id, trip_id, amount, payment_type, razorpay_order_id, status, description)
        VALUES (${customer.id}::uuid, ${tripId || null}::uuid, ${amt}, 'ride_payment', ${order.id}, 'pending', 'Ride payment via Razorpay')
        ON CONFLICT DO NOTHING
      `).catch(dbCatch("db"));
      res.json({ order, keyId, amount: amt });
    } catch (e: any) {
      const msg = e.message || e.error?.description || e.error?.reason || JSON.stringify(e).slice(0, 200);
      res.status(500).json({ message: msg });
    }
  });

  // -- CUSTOMER: Razorpay � Verify ride payment ------------------------------
  app.post("/api/app/customer/ride/verify-payment", authApp, requireCustomer, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) return res.status(400).json({ message: "Missing payment details" });
      const { keySecret } = await getRazorpayKeys();
      if (!keySecret) return res.status(503).json({ message: "Payment gateway not configured" });
      // Timing-safe HMAC verification
      const expectedSig = crypto.createHmac("sha256", keySecret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
      const sigValid = expectedSig.length === razorpaySignature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSig, "utf8"), Buffer.from(razorpaySignature, "utf8"));
      if (!sigValid) return res.status(400).json({ message: "Invalid payment signature" });
      // Amount + trip_id from DB � never trust client-sent amount
      const pendingRec = await rawDb.execute(rawSql`
        SELECT amount, trip_id FROM customer_payments WHERE razorpay_order_id=${razorpayOrderId} AND customer_id=${customer.id}::uuid AND status='pending' LIMIT 1
      `);
      if (!pendingRec.rows.length) return res.status(400).json({ message: "No pending order found for this payment" });
      const verifiedAmt = parseFloat((pendingRec.rows[0] as any).amount);
      const linkedTripId = (pendingRec.rows[0] as any).trip_id;
      // Mark as completed
      await rawDb.execute(rawSql`
        UPDATE customer_payments SET razorpay_payment_id=${razorpayPaymentId}, status='completed', verified_at=NOW()
        WHERE razorpay_order_id=${razorpayOrderId} AND customer_id=${customer.id}::uuid
      `).catch(dbCatch("db"));
      // Mark trip as paid_online so cancel-trip can auto-refund to wallet
      if (linkedTripId) {
        await rawDb.execute(rawSql`
          UPDATE trip_requests SET payment_status='paid_online', razorpay_payment_id=${razorpayPaymentId}
          WHERE id=${linkedTripId}::uuid AND customer_id=${customer.id}::uuid AND current_status NOT IN ('completed','cancelled')
        `).catch(dbCatch("db"));
      }
      res.json({ success: true, paymentId: razorpayPaymentId, amount: verifiedAmt });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- RAZORPAY WEBHOOK ---------------------------------------------------------
  // Canonical URL : POST /api/app/razorpay/webhook
  // Legacy alias  : POST /api/webhooks/razorpay
  //
  // Security    : HMAC-SHA256 (X-Razorpay-Signature) with timing-safe compare
  // Idempotency : razorpay_webhook_logs UNIQUE(event_id) � duplicate ? 200, skip
  // Performance : HTTP 200 returned before DB processing (setImmediate async)
  // Events      : payment.authorized/captured/failed
  //               subscription.authenticated/activated/pending/charged/
  //                            halted/resumed/cancelled
  //               refund.created/processed
  // -----------------------------------------------------------------------------

  // -- Async event processor (runs after 200 is sent) -------------------------
  const _processRazorpayEvent = async (eventId: string, eventType: string, event: any): Promise<void> => {
    const tag = `[WEBHOOK:${eventType}]`;
    const payEnt = event?.payload?.payment?.entity;
    const subEnt = event?.payload?.subscription?.entity;
    const refEnt = event?.payload?.refund?.entity;

    try {
      switch (eventType) {

        // -- payment.authorized / payment.captured --------------------------
        case "payment.authorized":
        case "payment.captured": {
          if (!payEnt) { console.warn(`${tag} missing payment entity`); break; }

          const orderId = String(payEnt.order_id ?? "");
          const paymentId = String(payEnt.id ?? "");
          const amount = (payEnt.amount ?? 0) / 100; // paise ? rupees

          console.info(`${tag} orderId=${orderId} paymentId=${paymentId} ?${amount}`);

          // -- Defense-in-depth: verify with Razorpay API for payment.captured --
          // Confirms status=captured, amount, and order_id from Razorpay directly.
          // This prevents replay attacks where an authorized event is replayed as captured.
          if (eventType === "payment.captured") {
            try {
              const { keyId: rzpKeyId, keySecret: rzpKeySecret } = await getRazorpayKeys();
              if (rzpKeyId && rzpKeySecret) {
                const Razorpay = _require("razorpay");
                const rzp = new Razorpay({ key_id: rzpKeyId, key_secret: rzpKeySecret, timeout: 15000 });
                const fetched = await rzp.payments.fetch(paymentId);
                const fetchedStatus = String(fetched.status ?? "");
                const fetchedOrderId = String(fetched.order_id ?? "");
                const fetchedAmount = (fetched.amount ?? 0) / 100;
                if (fetchedStatus !== "captured") {
                  console.error(`${tag} API verification FAILED: status=${fetchedStatus} expected=captured`);
                  await rawDb.execute(rawSql`
                    UPDATE razorpay_webhook_logs SET error_msg=${'API verify failed: status=' + fetchedStatus}
                    WHERE event_id=${eventId}
                  `).catch(dbCatch("db"));
                  break;
                }
                if (fetchedOrderId && orderId && fetchedOrderId !== orderId) {
                  console.error(`${tag} API verification FAILED: order_id mismatch fetched=${fetchedOrderId} event=${orderId}`);
                  await rawDb.execute(rawSql`
                    UPDATE razorpay_webhook_logs SET error_msg=${'API verify failed: order_id mismatch'}
                    WHERE event_id=${eventId}
                  `).catch(dbCatch("db"));
                  break;
                }
                if (Math.abs(fetchedAmount - amount) > 0.5) {
                  console.error(`${tag} API verification FAILED: amount mismatch fetched=${fetchedAmount} event=${amount}`);
                  await rawDb.execute(rawSql`
                    UPDATE razorpay_webhook_logs SET error_msg=${'API verify failed: amount mismatch'}
                    WHERE event_id=${eventId}
                  `).catch(dbCatch("db"));
                  break;
                }
                console.info(`${tag} API verification OK paymentId=${paymentId}`);
              }
            } catch (apiErr: any) {
              console.warn(`${tag} Razorpay API verify error (proceeding with webhook data): ${apiErr.message}`);
              // Non-fatal: if the API call fails (network/timeout), proceed with the webhook payload
              // which was already HMAC-verified at the HTTP layer
            }
          }

          // -- A) Driver payment (wallet topup, subscription, commission) ----
          {
            // Atomic idempotency: UPDATE only if still 'pending', RETURNING gives us the record.
            // If two webhooks arrive simultaneously, only one UPDATE changes a row � prevents double-credit.
            const dpUpdate = await rawDb.execute(rawSql`
              UPDATE driver_payments
              SET status = 'completed',
                  razorpay_payment_id = ${paymentId},
                  verified_at  = NOW(),
                  updated_at   = NOW()
              WHERE razorpay_order_id = ${orderId} AND status = 'pending'
              RETURNING *
            `);
            if (dpUpdate.rows.length) {
              const rec = camelize(dpUpdate.rows[0]) as any;
              {
                // Mark payment completed (already done by UPDATE above)
                console.info(`${tag} driver_payments completed orderId=${orderId}`);

                // Activate subscription if this payment was for a plan
                if (rec.paymentType === "subscription") {
                  const planRows = await rawDb.execute(rawSql`
                    SELECT * FROM subscription_plans WHERE id = ${rec.planId ?? ""}::uuid LIMIT 1
                  `).catch(() => ({ rows: [] as any[] }));
                  const plan = planRows.rows.length ? camelize(planRows.rows[0]) as any : null;
                  const days = plan?.durationDays ?? 30;
                  const start = new Date().toISOString().split("T")[0];
                  const end = new Date(Date.now() + days * 86_400_000).toISOString().split("T")[0];

                  await rawDb.execute(rawSql`
                    UPDATE driver_subscriptions
                    SET is_active = false, subscription_status = 'replaced', updated_at = NOW()
                    WHERE driver_id = ${rec.driverId}::uuid AND is_active = true
                  `);
                  await rawDb.execute(rawSql`
                    INSERT INTO driver_subscriptions
                      (driver_id, plan_id, start_date, end_date, amount,
                       payment_status, is_active, razorpay_order_id,
                       razorpay_payment_id, subscription_status, updated_at)
                    VALUES
                      (${rec.driverId}::uuid, ${rec.planId ?? null}::uuid,
                       ${start}, ${end}, ${rec.amount},
                       'paid', true,
                       ${orderId}, ${paymentId}, 'active', NOW())
                  `);
                  if (io) io.to(`user:${rec.driverId}`).emit("subscription:activated", { validUntil: end });
                  console.info(`${tag} subscription activated driver=${rec.driverId} until ${end}`);
                }

                // Complete trip held at payment_pending
                if (rec.tripId) {
                  await rawDb.execute(rawSql`
                    UPDATE trip_requests
                    SET current_status = 'completed',
                        completed_at   = NOW(),
                        payment_status = 'paid',
                        updated_at     = NOW()
                    WHERE id = ${rec.tripId}::uuid AND current_status = 'payment_pending'
                  `);
                  if (io) {
                    io.to(`user:${rec.customerId ?? ""}`).emit("trip:status_update", {
                      tripId: rec.tripId,
                      status: "completed",
                      currentStatus: "completed",
                      message: "Payment confirmed. Trip completed.",
                    });
                    io.to(`user:${rec.customerId ?? ""}`).emit("trip:completed", {
                      tripId: rec.tripId,
                      status: "completed",
                      currentStatus: "completed",
                      message: "Payment confirmed. Trip completed.",
                    });
                    io.to(`trip:${rec.tripId}`).emit("trip:status_update", {
                      tripId: rec.tripId,
                      status: "completed",
                      currentStatus: "completed",
                      message: "Payment confirmed. Trip completed.",
                    });
                    io.to(`trip:${rec.tripId}`).emit("trip:completed", {
                      tripId: rec.tripId,
                      status: "completed",
                      currentStatus: "completed",
                      message: "Payment confirmed. Trip completed.",
                    });
                  }
                  console.info(`${tag} trip ${rec.tripId} completed`);
                }

                // Credit driver wallet
                const wRow = await rawDb.execute(rawSql`
                  UPDATE users
                  SET wallet_balance = wallet_balance + ${rec.amount}, updated_at = NOW()
                  WHERE id = ${rec.driverId}::uuid
                  RETURNING wallet_balance, is_locked
                `);
                if (wRow.rows.length) {
                  const row = wRow.rows[0] as any;
                  const newBal = parseFloat(row.wallet_balance);
                  const thr = await rawDb.execute(rawSql`
                    SELECT value FROM revenue_model_settings
                    WHERE key_name = 'auto_lock_threshold' LIMIT 1
                  `).catch(() => ({ rows: [] as any[] }));
                  const thresh = parseFloat((thr.rows[0] as any)?.value ?? "-100");
                  if (newBal >= thresh && row.is_locked) {
                    await rawDb.execute(rawSql`
                      UPDATE users
                      SET is_locked = false, lock_reason = NULL, locked_at = NULL, updated_at = NOW()
                      WHERE id = ${rec.driverId}::uuid
                    `);
                    console.info(`${tag} driver ${rec.driverId} auto-unlocked (bal=?${newBal})`);
                  }
                  if (io) io.to(`user:${rec.driverId}`).emit("wallet:recharged", { amount: rec.amount, newBalance: newBal });
                }

                // Admin revenue record
                await rawDb.execute(rawSql`
                  INSERT INTO admin_revenue (driver_id, amount, revenue_type, breakdown)
                  VALUES (
                    ${rec.driverId}::uuid, ${rec.amount},
                    ${rec.paymentType === "subscription" ? "subscription_purchase" : "driver_payment"},
                    ${JSON.stringify({ orderId, paymentId, paymentType: rec.paymentType })}::jsonb
                  )
                `).catch(dbCatch("db"));
              }
            }
          }

          // -- B) Customer wallet topup / ride payment -----------------------
          {
            const cpRows = await rawDb.execute(rawSql`
              SELECT * FROM customer_payments
              WHERE razorpay_order_id = ${orderId} AND status = 'pending'
              LIMIT 1
            `).catch(() => ({ rows: [] as any[] }));
            if (cpRows.rows.length) {
              const rec = camelize(cpRows.rows[0]) as any;
              const done = await rawDb.execute(rawSql`
                SELECT id FROM customer_payments
                WHERE razorpay_order_id = ${orderId} AND status = 'completed'
                LIMIT 1
              `).catch(() => ({ rows: [] as any[] }));
              if (!done.rows.length) {
                await rawDb.execute(rawSql`
                  UPDATE customer_payments
                  SET status = 'completed',
                      razorpay_payment_id = ${paymentId},
                      verified_at = NOW()
                  WHERE razorpay_order_id = ${orderId} AND status = 'pending'
                `);
                await rawDb.execute(rawSql`
                  UPDATE users
                  SET wallet_balance = wallet_balance + ${rec.amount}, updated_at = NOW()
                  WHERE id = ${rec.customerId}::uuid
                `);
                if (io) io.to(`user:${rec.customerId}`).emit("wallet:recharged", { amount: rec.amount });
                console.info(`${tag} customer wallet credited customer=${rec.customerId} ?${rec.amount}`);
              }
            }
          }
          break;
        }

        // -- payment.failed -------------------------------------------------
        case "payment.failed": {
          if (!payEnt) { console.warn(`${tag} missing payment entity`); break; }
          const orderId = String(payEnt.order_id ?? "");
          const failReason = String(
            payEnt.error_description ?? payEnt.error_reason ?? "Payment failed"
          ).slice(0, 500);
          console.warn(`${tag} orderId=${orderId} reason="${failReason}"`);

          await rawDb.execute(rawSql`
            UPDATE driver_payments
            SET status = 'failed', failure_reason = ${failReason}, updated_at = NOW()
            WHERE razorpay_order_id = ${orderId} AND status = 'pending'
          `).catch(dbCatch("db"));
          await rawDb.execute(rawSql`
            UPDATE customer_payments
            SET status = 'failed', failure_reason = ${failReason}
            WHERE razorpay_order_id = ${orderId} AND status = 'pending'
          `).catch(dbCatch("db"));
          console.error(`[WEBHOOK:ALERT] Payment failed orderId=${orderId} � "${failReason}"`);
          break;
        }

        // -- subscription.authenticated / subscription.pending --------------
        // Informational events � logged, no DB action required
        case "subscription.authenticated":
        case "subscription.pending":
          console.info(`${tag} subscription=${subEnt?.id ?? "?"} � logged only`);
          break;

        // -- subscription.activated / subscription.charged ------------------
        // Mark subscription ACTIVE, update billing cycle dates
        case "subscription.activated":
        case "subscription.charged": {
          if (!subEnt) { console.warn(`${tag} missing subscription entity`); break; }
          const rzpSubId = String(subEnt.id ?? "");
          const driverId = String(subEnt.notes?.driver_id ?? "");
          const cycleStart = subEnt.current_start
            ? new Date(subEnt.current_start * 1000).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0];
          const cycleEnd = subEnt.current_end
            ? new Date(subEnt.current_end * 1000).toISOString().split("T")[0]
            : new Date(Date.now() + 30 * 86_400_000).toISOString().split("T")[0];

          if (driverId) {
            // Deactivate existing subs that belong to this driver (but not this rzp sub)
            await rawDb.execute(rawSql`
              UPDATE driver_subscriptions
              SET is_active = false, subscription_status = 'replaced', updated_at = NOW()
              WHERE driver_id = ${driverId}::uuid
                AND is_active = true
                AND (razorpay_subscription_id IS NULL OR razorpay_subscription_id != ${rzpSubId})
            `);
            // Upsert the active subscription record
            const upsert = await rawDb.execute(rawSql`
              UPDATE driver_subscriptions
              SET is_active = true, payment_status = 'paid',
                  subscription_status = 'active',
                  start_date = ${cycleStart}, end_date = ${cycleEnd},
                  updated_at = NOW()
              WHERE driver_id = ${driverId}::uuid
                AND razorpay_subscription_id = ${rzpSubId}
              RETURNING id
            `);
            if (!upsert.rows.length) {
              await rawDb.execute(rawSql`
                INSERT INTO driver_subscriptions
                  (driver_id, start_date, end_date, payment_status, is_active,
                   razorpay_subscription_id, subscription_status, updated_at)
                VALUES
                  (${driverId}::uuid, ${cycleStart}, ${cycleEnd}, 'paid', true,
                   ${rzpSubId}, 'active', NOW())
              `);
            }
            if (io) io.to(`user:${driverId}`).emit("subscription:activated", { validUntil: cycleEnd });
            console.info(`${tag} sub ${rzpSubId} activated driver=${driverId} until ${cycleEnd}`);
          } else {
            // No driver_id in notes � update by razorpay_subscription_id only
            await rawDb.execute(rawSql`
              UPDATE driver_subscriptions
              SET is_active = true, payment_status = 'paid',
                  subscription_status = 'active',
                  start_date = ${cycleStart}, end_date = ${cycleEnd},
                  updated_at = NOW()
              WHERE razorpay_subscription_id = ${rzpSubId}
            `);
            console.info(`${tag} sub ${rzpSubId} activated (no driver_id in notes)`);
          }
          break;
        }

        // -- subscription.halted --------------------------------------------
        // Payment retry failed � disable driver access until payment succeeds
        case "subscription.halted": {
          if (!subEnt) break;
          const rzpSubId = String(subEnt.id ?? "");
          const driverId = String(subEnt.notes?.driver_id ?? "");
          if (driverId) {
            await rawDb.execute(rawSql`
              UPDATE driver_subscriptions
              SET is_active = false, subscription_status = 'halted', updated_at = NOW()
              WHERE driver_id = ${driverId}::uuid
            `);
            if (io) io.to(`user:${driverId}`).emit("subscription:halted", {
              message: "Subscription payment failed. Please update payment method.",
            });
          } else {
            await rawDb.execute(rawSql`
              UPDATE driver_subscriptions
              SET is_active = false, subscription_status = 'halted', updated_at = NOW()
              WHERE razorpay_subscription_id = ${rzpSubId}
            `);
          }
          console.warn(`${tag} sub ${rzpSubId} halted � access disabled`);
          break;
        }

        // -- subscription.resumed -------------------------------------------
        case "subscription.resumed": {
          if (!subEnt) break;
          const rzpSubId = String(subEnt.id ?? "");
          await rawDb.execute(rawSql`
            UPDATE driver_subscriptions
            SET is_active = true, subscription_status = 'active', updated_at = NOW()
            WHERE razorpay_subscription_id = ${rzpSubId}
          `);
          console.info(`${tag} sub ${rzpSubId} resumed`);
          break;
        }

        // -- subscription.cancelled -----------------------------------------
        // Keep is_active = true so driver retains access until end_date
        case "subscription.cancelled": {
          if (!subEnt) break;
          const rzpSubId = String(subEnt.id ?? "");
          const driverId = String(subEnt.notes?.driver_id ?? "");
          await rawDb.execute(rawSql`
            UPDATE driver_subscriptions
            SET subscription_status = 'cancelled', updated_at = NOW()
            WHERE razorpay_subscription_id = ${rzpSubId}
          `);
          if (driverId && io) {
            io.to(`user:${driverId}`).emit("subscription:cancelled", {
              message: "Subscription cancelled. Access continues until expiry date.",
            });
          }
          console.info(`${tag} sub ${rzpSubId} cancelled � access retained until end_date`);
          break;
        }

        // -- refund.created / refund.processed -----------------------------
        case "refund.created":
        case "refund.processed": {
          if (!refEnt) { console.warn(`${tag} missing refund entity`); break; }
          const refundId = String(refEnt.id ?? "");
          const refundAmt = (refEnt.amount ?? 0) / 100;
          const paymentId = String(refEnt.payment_id ?? "");
          console.info(`${tag} refundId=${refundId} paymentId=${paymentId} ?${refundAmt}`);

          if (eventType === "refund.processed") {
            // Find a matching approved refund_request and credit customer wallet
            const rrRows = await rawDb.execute(rawSql`
              SELECT * FROM refund_requests
              WHERE status = 'approved' AND amount = ${refundAmt}
              ORDER BY created_at DESC LIMIT 1
            `).catch(() => ({ rows: [] as any[] }));
            if (rrRows.rows.length) {
              const rr = camelize(rrRows.rows[0]) as any;
              await rawDb.execute(rawSql`
                UPDATE refund_requests
                SET status = 'completed',
                    admin_note = 'Processed via Razorpay webhook',
                    approved_at = NOW()
                WHERE id = ${rr.id}::uuid
              `);
              if (rr.paymentMethod === "wallet" && rr.customerId) {
                await rawDb.execute(rawSql`
                  UPDATE users
                  SET wallet_balance = wallet_balance + ${refundAmt}, updated_at = NOW()
                  WHERE id = ${rr.customerId}::uuid
                `);
                if (io) io.to(`user:${rr.customerId}`).emit("wallet:recharged", {
                  amount: refundAmt,
                  reason: "Refund processed",
                });
                console.info(`${tag} wallet credited ?${refundAmt} for refund customer=${rr.customerId}`);
              }
            }
          }
          break;
        }

        default:
          console.info(`[WEBHOOK] Unhandled event type: ${eventType} � logged only`);
      }

      // Mark as successfully processed in audit log
      await rawDb.execute(rawSql`
        UPDATE razorpay_webhook_logs SET processed = true WHERE event_id = ${eventId}
      `).catch(dbCatch("db"));
      console.info(`[WEBHOOK] ${eventType} (${eventId}) ? done`);

    } catch (procErr: any) {
      console.error(`[WEBHOOK] Processing error [${eventType}] id=${eventId}:`, procErr.message);
      await rawDb.execute(rawSql`
        UPDATE razorpay_webhook_logs
        SET error_msg = ${String(procErr.message ?? "unknown").slice(0, 500)}
        WHERE event_id = ${eventId}
      `).catch(dbCatch("db"));
    }
  };

  // -- Shared request handler (used by both URLs) ---------------------------
  const _razorpayWebhookHandler = async (req: Request, res: Response): Promise<void> => {
    const tag = "[WEBHOOK]";

    // -- 1. Secret guard ------------------------------------------------------
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error(`${tag} RAZORPAY_WEBHOOK_SECRET not configured`);
      res.status(503).json({ message: "Webhook not configured" });
      return;
    }

    // -- 2. Signature verification (timing-safe) ------------------------------
    const sigHeader = req.headers["x-razorpay-signature"];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader ?? "";
    if (!signature) {
      console.warn(`${tag} missing X-Razorpay-Signature from ${req.ip}`);
      res.status(400).json({ message: "Missing webhook signature" });
      return;
    }

    const rawBody = (req as any).rawBody;
    const bodyStr = rawBody ? (rawBody as Buffer).toString() : JSON.stringify(req.body);
    const expected = crypto.createHmac("sha256", webhookSecret).update(bodyStr).digest("hex");

    let sigValid = false;
    try {
      // timingSafeEqual requires same-length buffers
      const eBuf = Buffer.from(expected, "hex");
      const sBuf = Buffer.from(signature, "hex");
      sigValid = eBuf.length === sBuf.length && crypto.timingSafeEqual(eBuf, sBuf);
    } catch (_) {
      sigValid = false;
    }

    if (!sigValid) {
      console.warn(`${tag} invalid signature from ${req.ip} � rejected`);
      // Log the bad attempt for security audit (best-effort)
      rawDb.execute(rawSql`
        INSERT INTO razorpay_webhook_logs
          (event_id, event_type, payload, processed, error_msg)
        VALUES (
          ${"invalid_sig_" + Date.now().toString(36)},
          ${"INVALID_SIGNATURE"},
          ${JSON.stringify({ ip: req.ip, ua: req.headers["user-agent"] })}::jsonb,
          false,
          ${"Signature mismatch � rejected"}
        )
      `).catch(dbCatch("db"));
      res.status(400).json({ message: "Invalid webhook signature" });
      return;
    }

    // -- 3. Parse event --------------------------------------------------------
    const event = req.body;
    const eventId = String(event?.id ?? `rzp_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const eventType = String(event?.event ?? "unknown");

    // -- 4. Idempotency via razorpay_webhook_logs ------------------------------
    // INSERT � ON CONFLICT DO NOTHING: if 0 rows returned, event already logged
    try {
      const ins = await rawDb.execute(rawSql`
        INSERT INTO razorpay_webhook_logs (event_id, event_type, payload, processed)
        VALUES (
          ${eventId},
          ${eventType},
          ${JSON.stringify(event?.payload ?? {})}::jsonb,
          false
        )
        ON CONFLICT (event_id) DO NOTHING
        RETURNING id
      `);
      if (!ins.rows.length) {
        console.info(`${tag} duplicate event ${eventId} (${eventType}) � skipped`);
        res.json({ success: true, duplicate: true });
        return;
      }
    } catch (logErr: any) {
      // Log table error is non-fatal � never block Razorpay on infra issues
      console.error(`${tag} webhook log insert failed:`, logErr.message);
    }

    // -- 5. Acknowledge Razorpay immediately (< 5 s SLA) ----------------------
    res.json({ success: true });

    // -- 6. Process event asynchronously --------------------------------------
    setImmediate(() => {
      _processRazorpayEvent(eventId, eventType, event).catch((e) =>
        console.error(`${tag} unhandled async error [${eventType}]:`, e?.message)
      );
    });
  };

  // Register both URLs � Razorpay dashboard URL + legacy alias
  app.post("/api/app/razorpay/webhook", _razorpayWebhookHandler);
  app.post("/api/webhooks/razorpay", _razorpayWebhookHandler);

  // -- CUSTOMER: Update profile ----------------------------------------------
  app.patch("/api/app/customer/profile", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { fullName, email, profileImage, gender, phone } = req.body;
      if (!fullName && !email && !profileImage && !gender && !phone) return res.status(400).json({ message: "Nothing to update" });
      if (fullName) await rawDb.execute(rawSql`UPDATE users SET full_name=${fullName}, updated_at=now() WHERE id=${customer.id}::uuid`);
      if (email) await rawDb.execute(rawSql`UPDATE users SET email=${email}, updated_at=now() WHERE id=${customer.id}::uuid`);
      if (profileImage) await rawDb.execute(rawSql`UPDATE users SET profile_image=${profileImage}, updated_at=now() WHERE id=${customer.id}::uuid`);
      if (gender) await rawDb.execute(rawSql`UPDATE users SET gender=${gender}, updated_at=now() WHERE id=${customer.id}::uuid`);
      res.json({ success: true, message: "Profile updated" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Update profile ------------------------------------------------
  app.patch("/api/app/driver/profile", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { fullName, email, profileImage, gender, vehicleNumber, vehicleModel, vehicleCategoryId } = req.body;
      // Update user fields
      if (fullName) await rawDb.execute(rawSql`UPDATE users SET full_name=${fullName}, updated_at=now() WHERE id=${driver.id}::uuid`);
      if (email) await rawDb.execute(rawSql`UPDATE users SET email=${email}, updated_at=now() WHERE id=${driver.id}::uuid`);
      if (profileImage) await rawDb.execute(rawSql`UPDATE users SET profile_image=${profileImage}, updated_at=now() WHERE id=${driver.id}::uuid`);
      if (gender) await rawDb.execute(rawSql`UPDATE users SET gender=${gender}, updated_at=now() WHERE id=${driver.id}::uuid`);
      if (vehicleNumber) await rawDb.execute(rawSql`UPDATE users SET vehicle_number=${vehicleNumber}, updated_at=now() WHERE id=${driver.id}::uuid`);
      if (vehicleModel) await rawDb.execute(rawSql`UPDATE users SET vehicle_model=${vehicleModel}, updated_at=now() WHERE id=${driver.id}::uuid`);
      // Create or update driver_details with vehicle category
      if (vehicleCategoryId) {
        const existing = await rawDb.execute(rawSql`SELECT id FROM driver_details WHERE user_id=${driver.id}::uuid`);
        if (existing.rows.length === 0) {
          await rawDb.execute(rawSql`
            INSERT INTO driver_details (user_id, vehicle_category_id, availability_status, is_online, total_trips, avg_rating)
            VALUES (${driver.id}::uuid, ${vehicleCategoryId}::uuid, 'offline', false, 0, 5.0)
          `);
        } else {
          await rawDb.execute(rawSql`UPDATE driver_details SET vehicle_category_id=${vehicleCategoryId}::uuid WHERE user_id=${driver.id}::uuid`);
        }
      }
      res.json({ success: true, message: "Profile updated" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Upload KYC document -------------------------------------------
  // POST /api/app/driver/kyc/upload
  // Body: { documentType: 'aadhar'|'license'|'rc'|'insurance'|'photo', documentNumber?, fileUrl }
  app.post("/api/app/driver/kyc/upload", authApp, upload.single("file"), async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const documentType = req.body.documentType || req.body.document_type;
      const documentNumber = req.body.documentNumber || req.body.document_number || null;
      if (!documentType) return res.status(400).json({ message: "documentType is required" });

      // If file uploaded via multipart, build URL; otherwise accept fileUrl in body
      let fileUrl: string | null = null;
      if (req.file) {
        fileUrl = `/uploads/${req.file.filename}`;
      } else if (req.body.fileUrl) {
        fileUrl = req.body.fileUrl;
      }

      // Upsert: one row per driver+documentType
      const existing = await rawDb.execute(rawSql`
        SELECT id FROM driver_kyc_documents
        WHERE driver_id=${driver.id}::uuid AND document_type=${documentType} LIMIT 1
      `);
      if (existing.rows.length) {
        await rawDb.execute(rawSql`
          UPDATE driver_kyc_documents
          SET document_number=${documentNumber}, file_url=${fileUrl}, status='pending',
              admin_note=NULL, updated_at=NOW()
          WHERE driver_id=${driver.id}::uuid AND document_type=${documentType}
        `);
      } else {
        await rawDb.execute(rawSql`
          INSERT INTO driver_kyc_documents (driver_id, document_type, document_number, file_url, status)
          VALUES (${driver.id}::uuid, ${documentType}, ${documentNumber}, ${fileUrl}, 'pending')
        `);
      }

      // Check if all required docs are uploaded ? set verification_status to 'under_review'
      const requiredDocs = ['aadhar', 'license', 'rc'];
      const uploaded = await rawDb.execute(rawSql`
        SELECT document_type FROM driver_kyc_documents
        WHERE driver_id=${driver.id}::uuid AND status IN ('pending','approved')
      `);
      const uploadedTypes = uploaded.rows.map((r: any) => r.document_type);
      const allUploaded = requiredDocs.every(d => uploadedTypes.includes(d));
      if (allUploaded) {
        await rawDb.execute(rawSql`
          UPDATE users SET verification_status='under_review' WHERE id=${driver.id}::uuid
        `).catch(dbCatch("db"));
      }

      res.json({ success: true, message: "Document uploaded. Under admin review.", allRequiredUploaded: allUploaded });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Get KYC status ------------------------------------------------
  app.get("/api/app/driver/kyc/status", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const docs = await rawDb.execute(rawSql`
        SELECT document_type, document_number, file_url, status, admin_note, updated_at
        FROM driver_kyc_documents WHERE driver_id=${driver.id}::uuid
        ORDER BY created_at ASC
      `);
      const verR = await rawDb.execute(rawSql`
        SELECT verification_status FROM users WHERE id=${driver.id}::uuid LIMIT 1
      `);
      const verStatus = (verR.rows[0] as any)?.verification_status || 'pending';
      res.json({
        verificationStatus: verStatus,
        documents: camelize(docs.rows),
        requiredDocs: ['aadhar', 'license', 'rc'],
        optionalDocs: ['insurance', 'photo', 'bank'],
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: List pending KYC reviews --------------------------------------
  app.get("/api/admin/kyc/pending", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT u.id as driver_id, u.full_name, u.phone, u.verification_status,
          json_agg(json_build_object(
            'id', k.id,
            'documentType', k.document_type,
            'documentNumber', k.document_number,
            'fileUrl', k.file_url,
            'status', k.status,
            'adminNote', k.admin_note,
            'updatedAt', k.updated_at
          ) ORDER BY k.created_at ASC) as documents
        FROM users u
        JOIN driver_kyc_documents k ON k.driver_id = u.id
        WHERE u.user_type = 'driver' AND u.verification_status IN ('under_review', 'pending')
        GROUP BY u.id, u.full_name, u.phone, u.verification_status
        ORDER BY MAX(k.created_at) DESC
        LIMIT 50
      `);
      res.json({ drivers: camelize(r.rows) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: Approve/Reject KYC ---------------------------------------------
  // POST /api/admin/kyc/:driverId/review
  // Body: { action: 'approve'|'reject', documentType?, note? }
  app.post("/api/admin/kyc/:driverId/review", requireAdminAuth, async (req, res) => {
    try {
      const { driverId } = req.params;
      const { action, documentType, note } = req.body;
      if (!['approve', 'reject'].includes(action)) return res.status(400).json({ message: "action must be approve or reject" });

      const newDocStatus = action === 'approve' ? 'approved' : 'rejected';

      if (documentType) {
        // Review a specific document
        await rawDb.execute(rawSql`
          UPDATE driver_kyc_documents
          SET status=${newDocStatus}, admin_note=${note || null}, updated_at=NOW()
          WHERE driver_id=${driverId}::uuid AND document_type=${documentType}
        `);
      } else {
        // Review all documents at once
        await rawDb.execute(rawSql`
          UPDATE driver_kyc_documents
          SET status=${newDocStatus}, admin_note=${note || null}, updated_at=NOW()
          WHERE driver_id=${driverId}::uuid AND status='pending'
        `);
      }

      // If approving all ? mark driver as approved and activate
      if (action === 'approve') {
        // Check if all required docs are approved
        const approvedDocs = await rawDb.execute(rawSql`
          SELECT document_type FROM driver_kyc_documents
          WHERE driver_id=${driverId}::uuid AND status='approved'
        `);
        const approvedTypes = approvedDocs.rows.map((r: any) => r.document_type);
        const requiredDocs = ['aadhar', 'license', 'rc'];
        const allApproved = requiredDocs.every(d => approvedTypes.includes(d));
        if (allApproved || !documentType) {
          await rawDb.execute(rawSql`
            UPDATE users SET verification_status='approved', is_active=true WHERE id=${driverId}::uuid
          `);
        }
      } else {
        // Reject ? mark driver as rejected
        await rawDb.execute(rawSql`
          UPDATE users SET verification_status='rejected' WHERE id=${driverId}::uuid
        `);
      }

      // Notify driver via FCM (best-effort)
      const fcmR = await rawDb.execute(rawSql`
        SELECT fcm_token FROM user_devices WHERE user_id=${driverId}::uuid AND fcm_token IS NOT NULL LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      const fcmToken = (fcmR.rows[0] as any)?.fcm_token;
      if (fcmToken) {
        const msg = action === 'approve'
          ? "Your KYC documents have been approved! You can now start accepting rides."
          : `Your KYC documents were rejected. ${note ? 'Reason: ' + note : 'Please re-upload correct documents.'}`;
        sendFcmNotification({ fcmToken, title: "KYC Update", body: msg }).catch(dbCatch("db"));
      }

      res.json({ success: true, action, driverId });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Earnings summary ----------------------------------------------
  app.get("/api/app/driver/earnings", authApp, requireDriver, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { period = "today" } = req.query;
      let r: any;
      if (period === "today") {
        r = await rawDb.execute(rawSql`
          SELECT COUNT(*) FILTER (WHERE current_status='completed') as completed,
            COUNT(*) FILTER (WHERE current_status='cancelled') as cancelled,
            COALESCE(SUM(actual_fare) FILTER (WHERE current_status='completed'), 0) as gross_fare,
            COALESCE(SUM(commission_amount) FILTER (WHERE current_status='completed'), 0) as commission,
            COALESCE(SUM(actual_fare - COALESCE(commission_amount,0)) FILTER (WHERE current_status='completed'), 0) as net_earnings
          FROM trip_requests WHERE driver_id=${driver.id}::uuid AND DATE(created_at) = CURRENT_DATE
        `);
      } else if (period === "week") {
        r = await rawDb.execute(rawSql`
          SELECT COUNT(*) FILTER (WHERE current_status='completed') as completed,
            COUNT(*) FILTER (WHERE current_status='cancelled') as cancelled,
            COALESCE(SUM(actual_fare) FILTER (WHERE current_status='completed'), 0) as gross_fare,
            COALESCE(SUM(commission_amount) FILTER (WHERE current_status='completed'), 0) as commission,
            COALESCE(SUM(actual_fare - COALESCE(commission_amount,0)) FILTER (WHERE current_status='completed'), 0) as net_earnings
          FROM trip_requests WHERE driver_id=${driver.id}::uuid AND created_at >= date_trunc('week', now())
        `);
      } else if (period === "month") {
        r = await rawDb.execute(rawSql`
          SELECT COUNT(*) FILTER (WHERE current_status='completed') as completed,
            COUNT(*) FILTER (WHERE current_status='cancelled') as cancelled,
            COALESCE(SUM(actual_fare) FILTER (WHERE current_status='completed'), 0) as gross_fare,
            COALESCE(SUM(commission_amount) FILTER (WHERE current_status='completed'), 0) as commission,
            COALESCE(SUM(actual_fare - COALESCE(commission_amount,0)) FILTER (WHERE current_status='completed'), 0) as net_earnings
          FROM trip_requests WHERE driver_id=${driver.id}::uuid AND created_at >= date_trunc('month', now())
        `);
      } else {
        r = await rawDb.execute(rawSql`
          SELECT COUNT(*) FILTER (WHERE current_status='completed') as completed,
            COUNT(*) FILTER (WHERE current_status='cancelled') as cancelled,
            COALESCE(SUM(actual_fare) FILTER (WHERE current_status='completed'), 0) as gross_fare,
            COALESCE(SUM(commission_amount) FILTER (WHERE current_status='completed'), 0) as commission,
            COALESCE(SUM(actual_fare - COALESCE(commission_amount,0)) FILTER (WHERE current_status='completed'), 0) as net_earnings
          FROM trip_requests WHERE driver_id=${driver.id}::uuid
        `);
      }
      const d = camelize(r.rows[0]) as any;
      res.json({
        period,
        completedTrips: parseInt(d.completed || "0"),
        cancelledTrips: parseInt(d.cancelled || "0"),
        grossFare: parseFloat(d.grossFare || "0"),
        commission: parseFloat(d.commission || "0"),
        netEarnings: parseFloat(d.netEarnings || "0"),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Saved places ------------------------------------------------
  app.get("/api/app/customer/saved-places", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT * FROM saved_places WHERE user_id=${customer.id}::uuid ORDER BY created_at DESC
      `);
      res.json({ data: r.rows.map(camelize) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/app/customer/saved-places", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { label, address, lat, lng } = req.body;
      if (!label || !address) return res.status(400).json({ message: "label and address required" });
      const r = await rawDb.execute(rawSql`
        INSERT INTO saved_places (user_id, label, address, lat, lng)
        VALUES (${customer.id}::uuid, ${label}, ${address}, ${lat || 0}, ${lng || 0})
        RETURNING *
      `);
      res.json({ success: true, data: camelize(r.rows[0]) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.delete("/api/app/customer/saved-places/:id", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { id } = req.params;
      await rawDb.execute(rawSql`
        DELETE FROM saved_places WHERE id=${id}::uuid AND user_id=${customer.id}::uuid
      `);
      res.json({ success: true, message: "Place removed" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Browse available offers/coupons ----------------------------
  app.get("/api/app/customer/offers", authApp, async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT id, name, code, discount_type, discount_amount, min_trip_amount, max_discount_amount,
               end_date, total_usage_limit, limit_per_user
        FROM coupon_setups
        WHERE is_active=true AND (end_date IS NULL OR end_date >= now())
        ORDER BY created_at DESC
        LIMIT 20
      `);
      res.json(r.rows.map(camelize));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Apply coupon code -------------------------------------------
  app.post("/api/app/customer/apply-coupon", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { code, fareAmount } = req.body;
      if (!code) return res.status(400).json({ message: "Coupon code required" });
      const fare = parseFloat(fareAmount) || 0;
      const r = await rawDb.execute(rawSql`
        SELECT * FROM coupon_setups WHERE code=${code.toUpperCase()} AND is_active=true
          AND (end_date IS NULL OR end_date >= now())
        LIMIT 1
      `);
      if (!r.rows.length) return res.status(400).json({ message: "Invalid or expired coupon" });
      const coupon = camelize(r.rows[0]) as any;

      // -- Min trip amount check ----------------------------------------------
      const minAmt = parseFloat(coupon.minTripAmount || '0');
      if (fare > 0 && minAmt > 0 && fare < minAmt) {
        return res.status(400).json({
          message: `Minimum fare ?${minAmt.toFixed(0)} required for this coupon`,
        });
      }

      // -- Usage limits ------------------------------------------------------
      if (coupon.totalUsageLimit) {
        const usageR = await rawDb.execute(rawSql`
          SELECT COUNT(*) AS cnt FROM trip_requests
          WHERE coupon_code = UPPER(${code}) AND current_status != 'cancelled'
        `);
        const used = parseInt((usageR.rows[0] as any).cnt || '0', 10);
        if (used >= parseInt(coupon.totalUsageLimit, 10))
          return res.status(400).json({ message: "Coupon usage limit reached" });
      }
      if (coupon.limitPerUser) {
        const userR = await rawDb.execute(rawSql`
          SELECT COUNT(*) AS cnt FROM trip_requests
          WHERE coupon_code = UPPER(${code}) AND customer_id = ${customer.id}::uuid
            AND current_status != 'cancelled'
        `);
        const userUsed = parseInt((userR.rows[0] as any).cnt || '0', 10);
        if (userUsed >= parseInt(coupon.limitPerUser, 10))
          return res.status(400).json({ message: "You have already used this coupon" });
      }

      // -- Discount calculation -----------------------------------------------
      // Bug fix: admin panel saves "percentage"; handle both "percent" and "percentage"
      let discount = 0;
      if (coupon.discountType === "percent" || coupon.discountType === "percentage") {
        discount = fare > 0 ? (fare * parseFloat(coupon.discountAmount)) / 100 : 0;
        if (coupon.maxDiscountAmount) discount = Math.min(discount, parseFloat(coupon.maxDiscountAmount));
      } else {
        // flat amount
        discount = parseFloat(coupon.discountAmount) || 0;
      }
      if (fare > 0) discount = Math.min(discount, fare);
      discount = Math.round(discount * 100) / 100;

      res.json({
        success: true,
        couponId: coupon.id,
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountAmount,
        discount: parseFloat(discount.toFixed(2)),
        finalFare: fare > 0 ? parseFloat((fare - discount).toFixed(2)) : null,
        message: fare > 0
          ? `Coupon applied! You save ?${discount.toFixed(2)}`
          : `Coupon "${coupon.code}" is valid`,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- LOGOUT: Invalidate auth token ----------------------------------------
  app.post("/api/app/logout", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      await rawDb.execute(rawSql`UPDATE users SET auth_token=NULL WHERE id=${user.id}::uuid`);
      res.json({ success: true, message: "Logged out successfully" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Change password -----------------------------------------------
  app.post("/api/app/change-password", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { newPin, newPassword, currentPassword } = req.body;
      const newPass = newPassword || newPin;
      if (!newPass || String(newPass).length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
      // Verify current password � required
      {
        const userRow = await rawDb.execute(rawSql`SELECT password_hash FROM users WHERE id=${user.id}::uuid`);
        const stored = (userRow.rows[0] as any)?.password_hash;
        if (stored) {
          const valid = await verifyPassword(String(currentPassword), stored);
          if (!valid) return res.status(401).json({ message: "Current password is incorrect" });
        }
      }
      const hashed = await hashPassword(String(newPass));
      await rawDb.execute(rawSql`UPDATE users SET password_hash=${hashed}, updated_at=now() WHERE id=${user.id}::uuid`);
      res.json({ success: true, message: "Password updated successfully" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Delete account ----------------------------------------------
  app.delete("/api/app/customer/account", authApp, async (req, res) => {
    try {
      const customer = (req as any).currentUser;
      const { permanent = false } = req.body || {};
      if (permanent) {
        // Permanent delete � anonymize all PII, revoke token, keep records for audit
        await rawDb.execute(rawSql`
          UPDATE users SET is_active=false, full_name='Deleted User', email=null, phone=null,
            profile_image=null, auth_token=null, wallet_balance=0, updated_at=NOW()
          WHERE id=${customer.id}::uuid
        `);
        // Also cancel any active trips
        await rawDb.execute(rawSql`
          UPDATE trip_requests SET current_status='cancelled', cancelled_by='customer', cancel_reason='Account deleted'
          WHERE customer_id=${customer.id}::uuid AND current_status NOT IN ('completed','cancelled')
        `);
        return res.json({ success: true, message: "Account permanently deleted. All data has been removed." });
      }
      // Soft delete � just deactivate
      await rawDb.execute(rawSql`UPDATE users SET is_active=false, auth_token=null, updated_at=NOW() WHERE id=${customer.id}::uuid`);
      res.json({ success: true, message: "Account deactivated. Contact support to reactivate." });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Delete account ------------------------------------------------
  app.delete("/api/app/driver/account", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { permanent = false } = req.body || {};
      if (permanent) {
        await rawDb.execute(rawSql`
          UPDATE users SET is_active=false, full_name='Deleted Driver', email=null, phone=null,
            profile_image=null, auth_token=null, wallet_balance=0, updated_at=NOW()
          WHERE id=${driver.id}::uuid AND user_type='driver'
        `);
        // Cancel active trip if any
        await rawDb.execute(rawSql`
          UPDATE trip_requests SET current_status='cancelled', cancelled_by='driver', cancel_reason='Driver account deleted'
          WHERE driver_id=${driver.id}::uuid AND current_status NOT IN ('completed','cancelled')
        `);
        await rawDb.execute(rawSql`UPDATE users SET current_trip_id=NULL WHERE id=${driver.id}::uuid`);
        return res.json({ success: true, message: "Driver account permanently deleted." });
      }
      await rawDb.execute(rawSql`UPDATE users SET is_active=false, auth_token=null, updated_at=NOW() WHERE id=${driver.id}::uuid AND user_type='driver'`);
      res.json({ success: true, message: "Account deactivated. Contact support to reactivate." });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Referral info -------------------------------------------------
  app.get("/api/app/referral", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT * FROM referrals WHERE referrer_id=${user.id}::uuid ORDER BY created_at DESC
      `);
      const countRes = await rawDb.execute(rawSql`
        SELECT COUNT(*) as total, COALESCE(SUM(reward_amount),0) as total_earned FROM referrals WHERE referrer_id=${user.id}::uuid AND status='paid'
      `);
      const summary = camelize(countRes.rows[0]) as any;
      res.json({
        referralCode: user.referral_code || ('JAGOPRO' + user.phone.slice(-6)),
        totalReferrals: parseInt(summary.total || "0"),
        totalEarned: parseFloat(summary.totalEarned || "0"),
        referrals: r.rows.map(camelize),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // ========== ADVANCED FEATURES ==========

  // -- DRIVER: Check if face verification needed -----------------------------
  app.get("/api/app/driver/check-verification", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT last_face_verified_at, face_verified_trips,
        (SELECT COUNT(*) FROM trip_requests WHERE driver_id=${user.id}::uuid AND current_status='completed'
         AND created_at > COALESCE((SELECT last_face_verified_at FROM users WHERE id=${user.id}::uuid), '2000-01-01')) AS trips_since_verify
        FROM users WHERE id=${user.id}::uuid
      `);
      const row = r.rows[0] as any;
      const lastVerified = row?.last_face_verified_at ? new Date(row.last_face_verified_at) : null;
      const tripsSince = parseInt(row?.trips_since_verify || '0');
      const hoursSinceVerify = lastVerified ? (Date.now() - new Date(lastVerified).getTime()) / 3600000 : 999;
      const needsVerification = !lastVerified || hoursSinceVerify >= 24 || tripsSince >= 10;
      const reason = !lastVerified ? 'first_time' : hoursSinceVerify >= 24 ? 'daily_check' : tripsSince >= 10 ? 'after_10_trips' : null;
      res.json({ needsVerification, reason, tripsSince, lastVerified });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Submit face verification selfie -------------------------------
  app.post("/api/app/driver/face-verify", authApp, upload.single("selfie"), async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const selfieUrl = req.file ? `/uploads/${req.file.filename}` : null;
      if (!selfieUrl) return res.status(400).json({ message: "Selfie required" });
      // In production: compare selfie with profile photo using AWS Rekognition / Azure Face API
      // For now: auto-approve after selfie submission
      await rawDb.execute(rawSql`
        UPDATE users SET last_face_verified_at=now(), face_verified_trips=0, updated_at=now() WHERE id=${user.id}::uuid
      `).catch(() => {
        // Add columns if not exist
        return rawDb.execute(rawSql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_face_verified_at TIMESTAMPTZ`).then(() =>
          rawDb.execute(rawSql`ALTER TABLE users ADD COLUMN IF NOT EXISTS face_verified_trips INTEGER DEFAULT 0`).then(() =>
            rawDb.execute(rawSql`UPDATE users SET last_face_verified_at=now(), face_verified_trips=0 WHERE id=${user.id}::uuid`)
          )
        );
      });
      res.json({ success: true, verified: true, selfieUrl, message: "Face verified successfully!" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Upload pickup location photo (ride security) -----------------
  app.post("/api/app/driver/trip-photo", authApp, upload.single("photo"), async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { tripId } = req.body;
      const photoUrl = req.file ? `/uploads/${req.file.filename}` : null;
      if (!photoUrl || !tripId) return res.status(400).json({ message: "photo and tripId required" });
      // Ensure column exists, then update
      await rawDb.execute(rawSql`ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS pickup_photo_url TEXT`).catch(dbCatch("db"));
      await rawDb.execute(rawSql`
        UPDATE trip_requests SET pickup_photo_url=${photoUrl}
        WHERE id=${tripId}::uuid AND driver_id=${user.id}::uuid
      `);
      res.json({ success: true, photoUrl });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Upload documents (DL, RC, Aadhar) ----------------------------
  app.post("/api/app/driver/upload-document", authApp, async (req, res) => {
    try {
      await runUploadSingle(req, res, "document");
      const user = (req as any).currentUser;
      const { docType, expiryDate } = req.body; // dl_front, dl_back, rc, aadhar_front, aadhar_back, insurance
      const fileUrl = req.file ? `/uploads/${req.file.filename}` : null;
      if (!fileUrl || !docType) return res.status(400).json({ message: "Document type and file required" });
      logRegistrationAudit("driver.upload-document", { docType }, { userId: user.id });
      await rawDb.transaction(async (trx) => {
        await upsertDriverDocumentRow(trx, user.id, docType, fileUrl, expiryDate || null);
      });
      res.json({ success: true, docType, fileUrl, status: 'pending', message: "Document uploaded. Under review." });
    } catch (e: any) {
      console.error("[driver-doc-upload] /api/app/driver/upload-document failed", {
        message: e?.message,
        stack: e?.stack,
        userId: (req as any)?.currentUser?.id,
        docType: req.body?.docType,
      });
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- DRIVER: Get documents status ------------------------------------------
  app.get("/api/app/driver/documents", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT driver_id, doc_type,
               COALESCE(file_url, doc_url) AS file_url,
               COALESCE(status, verification_status, 'pending') AS status,
               expiry_date, admin_note, reviewed_at, created_at, updated_at
        FROM driver_documents
        WHERE driver_id=${user.id}::uuid
        ORDER BY created_at
      `).catch(() => ({ rows: [] }));
      res.json({ success: true, documents: r.rows.map(camelize) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Upload document as base64 (for Flutter) -----------------------
  app.post("/api/app/driver/upload-document-base64", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { docType, imageData, expiryDate } = req.body;
      if (!docType || !imageData) return res.status(400).json({ message: "docType and imageData required" });
      const validTypes = ['dl_front', 'dl_back', 'rc', 'aadhar_front', 'aadhar_back', 'insurance', 'selfie', 'vehicle_photo'];
      if (!validTypes.includes(docType)) return res.status(400).json({ message: "Invalid docType" });
      const fileUrl = persistBase64Upload(imageData, docType);
      logRegistrationAudit("driver.upload-document-base64", { docType }, { userId: user.id });
      await rawDb.transaction(async (trx) => {
        await upsertDriverDocumentRow(trx, user.id, docType, fileUrl, expiryDate || null);
      });
      res.json({ success: true, docType, fileUrl, status: 'pending', message: "Document uploaded. Under review." });
    } catch (e: any) {
      console.error("[driver-doc-upload] /api/app/driver/upload-document-base64 failed", {
        message: e?.message,
        stack: e?.stack,
        userId: (req as any)?.currentUser?.id,
        docType: req.body?.docType,
      });
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- DRIVER: Update registration profile fields -----------------------------
  app.patch("/api/app/driver/update-registration", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      // Accept both dateOfBirth (camelCase) and dob (Flutter sends 'dob')
      const dateOfBirth = req.body.dateOfBirth || req.body.dob || null;
      const { city, vehicleBrand, vehicleColor, vehicleYear, licenseNumber, licenseExpiry,
        vehicleNumber, vehicleModel, vehicleType, selfieImage } = req.body;
      // Accept both 'name' (Flutter) and 'fullName' for driver full name update
      const fullName = req.body.fullName || req.body.name || null;
      const password = req.body.password || null;
      let passwordHash: string | null = null;
      if (password && typeof password === 'string' && password.length >= 6) {
        passwordHash = await hashPassword(password);
      }
      logRegistrationAudit("driver.update-registration", req.body, { userId: user.id });
      await rawDb.transaction(async (trx) => {
        await trx.execute(rawSql`
          UPDATE users SET
            name = COALESCE(${fullName || null}, name),
            full_name = COALESCE(${fullName || null}, full_name),
            date_of_birth = COALESCE(${dateOfBirth || null}, date_of_birth),
            city = COALESCE(${city || null}, city),
            vehicle_brand = COALESCE(${vehicleBrand || null}, vehicle_brand),
            vehicle_color = COALESCE(${vehicleColor || null}, vehicle_color),
            vehicle_year = COALESCE(${vehicleYear || null}, vehicle_year),
            license_number = COALESCE(${licenseNumber || null}, license_number),
            license_expiry = COALESCE(${licenseExpiry || null}, license_expiry),
            vehicle_number = COALESCE(${vehicleNumber || null}, vehicle_number),
            vehicle_model = COALESCE(${vehicleModel || null}, vehicle_model),
            selfie_image = COALESCE(${selfieImage || null}, selfie_image),
            password_hash = COALESCE(${passwordHash || null}, password_hash),
            verification_status = COALESCE(verification_status, 'pending'),
            updated_at = NOW()
          WHERE id = ${user.id}::uuid
        `);
        const vehicleCategoryId = await resolveVehicleCategoryIdForType(vehicleType || null);
        await upsertDriverDetailsRow(trx, user.id, vehicleType || null, vehicleCategoryId);
        await upsertVehicleRow(trx, user.id, {
          vehicleType: vehicleType || null,
          vehicleBrand: vehicleBrand || null,
          vehicleModel: vehicleModel || null,
          vehicleColor: vehicleColor || null,
          vehicleYear: vehicleYear || null,
          vehicleNumber: vehicleNumber || null,
          verificationStatus: "pending",
        });
      });
      res.json({ success: true, message: "Profile updated" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Get verification status (full detail) --------------------------
  app.get("/api/app/driver/verification-status", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const profileR = await rawDb.execute(rawSql`
        SELECT u.verification_status, u.vehicle_status, u.rejection_note, u.license_number,
               u.license_expiry, u.vehicle_number, u.vehicle_model, u.vehicle_brand,
               u.vehicle_color, u.vehicle_year, u.date_of_birth, u.city, u.selfie_image,
               u.full_name, u.phone, u.profile_image, u.revenue_model, u.model_selected_at,
               u.theme_preference, u.launch_free_active, u.free_period_end, u.onboard_date,
               dd.vehicle_category_id, vc.name as vehicle_category_name
        FROM users u
        LEFT JOIN driver_details dd ON dd.user_id = u.id
        LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
        WHERE u.id = ${user.id}::uuid
      `);
      const docsR = await rawDb.execute(rawSql`
        SELECT doc_type,
               COALESCE(file_url, doc_url) AS file_url,
               COALESCE(status, verification_status, 'pending') AS status,
               expiry_date, admin_note, reviewed_at
        FROM driver_documents WHERE driver_id = ${user.id}::uuid ORDER BY created_at
      `).catch(() => ({ rows: [] }));
      const profile = camelize(profileR.rows[0] || {});
      const documents = docsR.rows.map(camelize);
      res.json({ success: true, ...profile, documents });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Get subscription plans ----------------------------------------
  app.get("/api/app/driver/subscription/plans", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT id, name, price, duration_days, features, plan_type
        FROM subscription_plans WHERE is_active=true AND plan_type IN ('driver','both')
        ORDER BY duration_days ASC
      `);
      const plans = r.rows.map((p: any) => ({
        ...camelize(p),
        features: (p.features || '').split('|').filter(Boolean),
        savings: p.duration_days === 30 ? 'Best Value' : p.duration_days === 15 ? 'Popular' : p.duration_days === 7 ? 'Starter' : null,
      }));
      res.json({ success: true, plans });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Choose revenue model (commission, subscription, or hybrid) -----
  app.post("/api/app/driver/choose-model", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { model } = req.body; // 'commission' | 'subscription' | 'hybrid'
      if (!['commission', 'subscription', 'hybrid'].includes(model)) return res.status(400).json({ message: "Invalid model" });
      await rawDb.execute(rawSql`
        UPDATE users SET revenue_model=${model}, model_selected_at=NOW() WHERE id=${driver.id}::uuid
      `);
      res.json({ success: true, model });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Create Razorpay order for subscription plan --------------------
  app.post("/api/app/driver/subscribe", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { planId } = req.body;
      const planR = await rawDb.execute(rawSql`SELECT * FROM subscription_plans WHERE id=${planId}::uuid AND is_active=true`);
      if (!planR.rows.length) return res.status(404).json({ message: "Plan not found" });
      const plan = camelize(planR.rows[0] as any) as any;
      // Check if Razorpay credentials exist
      const { keyId: subKeyId, keySecret: subKeySecret2 } = await getRazorpayKeys();
      if (!subKeyId || !subKeySecret2) return res.status(503).json({ message: "Payment gateway not configured" });
      const Razorpay = _require('razorpay');
      const razorpay = new Razorpay({ key_id: subKeyId, key_secret: subKeySecret2, timeout: 15000 });
      const amountPaise = Math.round(parseFloat(plan.price) * 100);
      const order = await razorpay.orders.create({ amount: amountPaise, currency: 'INR', receipt: `sub_${driver.id}_${planId}` });
      res.json({ success: true, orderId: order.id, amount: amountPaise, currency: 'INR', plan, keyId: subKeyId });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Activate subscription after payment ----------------------------
  app.post("/api/app/driver/activate-subscription", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { planId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body;
      if (!planId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
        return res.status(400).json({ message: "planId, razorpayPaymentId, razorpayOrderId, and razorpaySignature required" });
      }
      // Verify Razorpay payment signature
      const { keySecret: activateKeySecret } = await getRazorpayKeys();
      if (!activateKeySecret) return res.status(503).json({ message: "Payment gateway not configured" });
      const expectedSig = crypto.createHmac("sha256", activateKeySecret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
      const sigValid = expectedSig.length === razorpaySignature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSig, "utf8"), Buffer.from(razorpaySignature, "utf8"));
      if (!sigValid) return res.status(400).json({ message: "Invalid payment signature" });
      // Idempotency check
      const existing = await rawDb.execute(rawSql`SELECT id FROM driver_subscriptions WHERE driver_id=${driver.id}::uuid AND razorpay_payment_id=${razorpayPaymentId}`).catch(() => ({ rows: [] }));
      if ((existing as any).rows?.length) return res.status(409).json({ message: "Payment already activated" });
      const planR = await rawDb.execute(rawSql`SELECT * FROM subscription_plans WHERE id=${planId}::uuid AND is_active=true`);
      if (!planR.rows.length) return res.status(404).json({ message: "Plan not found" });
      const plan = camelize(planR.rows[0] as any) as any;
      const startDate = new Date();
      const endDate = new Date(startDate.getTime() + plan.durationDays * 86400000);
      await rawDb.execute(rawSql`ALTER TABLE driver_subscriptions ADD COLUMN IF NOT EXISTS razorpay_payment_id VARCHAR(100)`).catch(dbCatch("db"));
      await rawDb.execute(rawSql`
        INSERT INTO driver_subscriptions (id, driver_id, plan_id, start_date, end_date, payment_amount, payment_status, rides_used, is_active, razorpay_payment_id, created_at)
        VALUES (gen_random_uuid(), ${driver.id}::uuid, ${planId}::uuid, ${startDate.toISOString()}, ${endDate.toISOString()}, ${plan.price}, 'paid', 0, true, ${razorpayPaymentId}, now())
      `);
      // Keep hybrid if already chosen; otherwise default to subscription after successful payment
      // Also expire free period � paid subscription overrides it
      await rawDb.execute(rawSql`
        UPDATE users
        SET revenue_model = CASE WHEN revenue_model='hybrid' THEN 'hybrid' ELSE 'subscription' END,
            model_selected_at = NOW(),
            launch_free_active = false,
            free_period_end = LEAST(COALESCE(free_period_end, NOW()), NOW())
        WHERE id=${driver.id}::uuid
      `);
      res.json({ success: true, message: `Subscription active until ${endDate.toDateString()}`, endDate });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Update theme preference ----------------------------------------
  app.patch("/api/app/driver/theme", authApp, async (req, res) => {
    try {
      const driver = (req as any).currentUser;
      const { theme } = req.body; // 'dark' | 'light'
      if (!['dark', 'light'].includes(theme)) return res.status(400).json({ message: "Invalid theme" });
      await rawDb.execute(rawSql`UPDATE users SET theme_preference=${theme} WHERE id=${driver.id}::uuid`);
      res.json({ success: true, theme });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: GST Wallet ----------------------------------------------------
  app.get("/api/admin/gst-wallet", requireAdminRole(["admin", "superadmin"]), async (_req, res) => {
    try {
      const walletR = await rawDb.execute(rawSql`SELECT * FROM company_gst_wallet WHERE id=1`);
      const recentR = await rawDb.execute(rawSql`
        SELECT tr.ref_id, tr.gst_amount, tr.ride_full_fare, tr.user_payable, tr.created_at,
               d.full_name AS driver_name, c.full_name AS customer_name
        FROM trip_requests tr
        LEFT JOIN users d ON d.id = tr.driver_id
        LEFT JOIN users c ON c.id = tr.customer_id
        WHERE tr.gst_amount > 0 AND tr.current_status = 'completed'
        ORDER BY tr.created_at DESC
        LIMIT 50
      `);
      res.json({ wallet: camelize(walletR.rows[0] ?? {}), recentCollections: camelize(recentR.rows) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: List drivers by verification status -----------------------------
  // -- ADMIN: Force-clear stale trips & stuck drivers -----------------------
  app.post("/api/admin/cleanup-stale-trips", requireAdminRole(["superadmin"]), async (req, res) => {
    try {
      // Cancel searching/driver_assigned trips older than 15 min
      const staleTripRes = await rawDb.execute(rawSql`
        UPDATE trip_requests SET current_status='cancelled',
          cancel_reason='Admin: manual cleanup of stale trip'
        WHERE current_status IN ('searching','driver_assigned','accepted')
          AND created_at < NOW() - INTERVAL '30 minutes'
        RETURNING id, ref_id, current_status
      `);
      // Free drivers stuck with completed/cancelled current_trip_id
      const freedRes = await rawDb.execute(rawSql`
        UPDATE users SET current_trip_id=NULL
        WHERE current_trip_id IS NOT NULL
          AND current_trip_id NOT IN (
            SELECT id FROM trip_requests WHERE current_status IN ('accepted','arrived','on_the_way')
          )
        RETURNING id, full_name
      `);
      res.json({
        success: true,
        cancelledTrips: staleTripRes.rows.length,
        freedDrivers: freedRes.rows.length,
        cancelledTripIds: staleTripRes.rows.map((r: any) => r.ref_id),
        freedDriverNames: freedRes.rows.map((r: any) => r.full_name),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/drivers/pending-verification", async (req, res) => {
    try {
      const status = (req.query.status as string) || 'pending';
      const r = await rawDb.execute(rawSql`
        SELECT u.id, u.full_name, u.phone, u.email, u.verification_status, u.vehicle_status,
               u.rejection_note, u.license_number, u.license_expiry, u.vehicle_number,
               u.vehicle_model, u.vehicle_brand, u.vehicle_color, u.vehicle_year,
               u.date_of_birth, u.city, u.selfie_image, u.profile_image, u.created_at,
               vc.name as vehicle_category_name, vc.icon as vehicle_category_icon
        FROM users u
        LEFT JOIN driver_details dd ON dd.user_id = u.id
        LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
        WHERE u.user_type = 'driver' AND u.verification_status = ${status}
        ORDER BY u.created_at DESC
        LIMIT 100
      `);
      const drivers = await Promise.all(r.rows.map(async (d: any) => {
        const docsR = await rawDb.execute(rawSql`
          SELECT doc_type,
                 COALESCE(file_url, doc_url) AS file_url,
                 COALESCE(status, verification_status, 'pending') AS status,
                 expiry_date, admin_note, reviewed_at
          FROM driver_documents WHERE driver_id = ${d.id}::uuid ORDER BY created_at
        `).catch(() => ({ rows: [] }));
        return { ...camelize(d), documents: docsR.rows.map(camelize) };
      }));
      res.json({ success: true, drivers, count: drivers.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: Review a single document (approve/reject) ----------------------
  app.patch("/api/admin/drivers/:id/doc-review", requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const { id } = req.params;
      const { docType, status, adminNote } = req.body;
      if (!docType || !status) return res.status(400).json({ message: "docType and status required" });
      if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ message: "Invalid status" });
      await rawDb.execute(rawSql`
        UPDATE driver_documents SET
          status=${status},
          verification_status=${status},
          admin_note=${adminNote || null},
          reviewed_at=NOW(),
          updated_at=NOW()
        WHERE driver_id=${id}::uuid AND doc_type=${docType}
      `);
      res.json({ success: true, docType, status });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: Approve/Reject entire driver verification ----------------------
  app.patch("/api/admin/drivers/:id/verify-driver", requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const { id } = req.params;
      const { status, note, vehicleStatus } = req.body;
      if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ message: "Invalid status" });
      await rawDb.execute(rawSql`
        UPDATE users SET
          verification_status=${status},
          vehicle_status=${vehicleStatus || status},
          rejection_note=${note || null},
          updated_at=NOW()
        WHERE id=${id}::uuid AND user_type='driver'
      `);
      if (status === 'approved') {
        await rawDb.execute(rawSql`UPDATE users SET is_active=true WHERE id=${id}::uuid`);
        // Always grant 30-day free period on approval (no subscription/commission for first month)
        await rawDb.execute(rawSql`
          UPDATE users
          SET onboard_date = COALESCE(onboard_date, NOW()),
              free_period_end = COALESCE(free_period_end, NOW() + INTERVAL '30 days'),
              launch_free_active = true
          WHERE id=${id}::uuid AND user_type='driver'
        `).catch(dbCatch("db"));
      }
      // Send FCM notification if token exists
      const tokenR = await rawDb.execute(rawSql`SELECT fcm_token, full_name FROM users WHERE id=${id}::uuid`).catch(() => ({ rows: [] }));
      const driverRow = (tokenR.rows[0] as any);
      if (driverRow?.fcm_token) {
        try {
          await sendFcmNotification({
            fcmToken: driverRow.fcm_token,
            title: status === 'approved' ? '? Account Approved!' : '? Verification Issue',
            body: status === 'approved'
              ? 'Congratulations! Your JAGO Pro Pilot account is approved. You can now go online.'
              : `Account issue: ${note || 'Please re-upload documents or contact support.'}`,
            data: { type: 'verification_update', verificationStatus: status },
          });
        } catch (_) { }
      }
      res.json({ success: true, status });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Driver: Launch Benefit status endpoint ------------------------------
  app.get("/api/app/driver/launch-benefit", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const [benefitR, campaignR] = await Promise.all([
        rawDb.execute(rawSql`SELECT launch_free_active, free_period_end, onboard_date FROM users WHERE id=${user.id}::uuid LIMIT 1`),
        rawDb.execute(rawSql`SELECT value FROM revenue_model_settings WHERE key_name='launch_campaign_enabled' LIMIT 1`).catch(() => ({ rows: [] as any[] })),
      ]);
      const row = benefitR.rows[0] as any;
      const campaignGlobalOn = (campaignR.rows[0] as any)?.value !== 'false';
      const now = new Date();
      let launchFreeActive = row?.launch_free_active === true;
      const freePeriodEnd: Date | null = row?.free_period_end ? new Date(row.free_period_end) : null;

      // Auto-expire silently
      if (launchFreeActive && freePeriodEnd && freePeriodEnd < now) {
        await rawDb.execute(rawSql`UPDATE users SET launch_free_active=false WHERE id=${user.id}::uuid`).catch(dbCatch("db"));
        launchFreeActive = false;
      }

      const isActive = campaignGlobalOn && launchFreeActive && freePeriodEnd !== null && freePeriodEnd >= now;
      const freeDaysRemaining = isActive && freePeriodEnd
        ? Math.max(0, Math.ceil((freePeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
        : 0;

      res.json({
        active: isActive,
        freeDaysRemaining,
        freePeriodEnd: freePeriodEnd ? freePeriodEnd.toISOString() : null,
        onboardDate: row?.onboard_date ? new Date(row.onboard_date).toISOString() : null,
        message: isActive
          ? `?? Launch Offer Active! No commission and no platform fee for your first 30 days. ${freeDaysRemaining} day(s) remaining.`
          : null,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: Advanced dashboard stats -------------------------------------
  app.get("/api/app/driver/dashboard", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const [todayStats, weekStats, monthStats, recentTrips, walletRow] = await Promise.all([
        rawDb.execute(rawSql`
          SELECT COUNT(*) as trips, COALESCE(SUM(actual_fare),0) as gross, COALESCE(SUM(commission_amount),0) as commission
          FROM trip_requests WHERE driver_id=${user.id}::uuid AND current_status='completed'
          AND created_at >= CURRENT_DATE
        `),
        rawDb.execute(rawSql`
          SELECT COUNT(*) as trips, COALESCE(SUM(actual_fare),0) as gross, COALESCE(SUM(commission_amount),0) as commission
          FROM trip_requests WHERE driver_id=${user.id}::uuid AND current_status='completed'
          AND created_at >= date_trunc('week', CURRENT_DATE)
        `),
        rawDb.execute(rawSql`
          SELECT COUNT(*) as trips, COALESCE(SUM(actual_fare),0) as gross, COALESCE(SUM(commission_amount),0) as commission
          FROM trip_requests WHERE driver_id=${user.id}::uuid AND current_status='completed'
          AND created_at >= date_trunc('month', CURRENT_DATE)
        `),
        rawDb.execute(rawSql`
          SELECT id, ref_id, pickup_address, destination_address, actual_fare, estimated_fare, current_status, created_at
          FROM trip_requests WHERE driver_id=${user.id}::uuid ORDER BY created_at DESC LIMIT 5
        `),
        rawDb.execute(rawSql`SELECT wallet_balance, is_locked FROM users WHERE id=${user.id}::uuid`),
      ]);

      const today = todayStats.rows[0] as any;
      const week = weekStats.rows[0] as any;
      const month = monthStats.rows[0] as any;

      // Get vehicle + zone + online status
      const driverInfo = await rawDb.execute(rawSql`
        SELECT dd.vehicle_category_id, dd.availability_status,
          vc.name as vehicle_category_name, vc.icon as vehicle_category_icon, vc.type as vehicle_type,
          z.name as zone_name, dl.is_online,
          u.vehicle_number, u.vehicle_model
        FROM users u
        LEFT JOIN driver_details dd ON dd.user_id = u.id
        LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
        LEFT JOIN zones z ON z.id = dd.zone_id
        LEFT JOIN driver_locations dl ON dl.driver_id = u.id
        WHERE u.id = ${user.id}::uuid
      `);
      const di = driverInfo.rows.length ? camelize(driverInfo.rows[0]) as any : {};

      const todayTrips = parseInt(today.trips);
      const todayGross = parseFloat(today.gross);
      const todayCommission = parseFloat(today.commission);

      // -- Launch Benefit: auto-expire + build response fields --
      const launchR = await rawDb.execute(rawSql`
        SELECT launch_free_active, free_period_end, onboard_date FROM users WHERE id=${user.id}::uuid LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      const launchRow = launchR.rows[0] as any;
      const campaignSettR = await rawDb.execute(rawSql`SELECT value FROM revenue_model_settings WHERE key_name='launch_campaign_enabled' LIMIT 1`).catch(() => ({ rows: [] as any[] }));
      const campaignGlobalOn = (campaignSettR.rows[0] as any)?.value !== 'false';

      let launchFreeActive = launchRow?.launch_free_active === true;
      let freePeriodEnd: Date | null = launchRow?.free_period_end ? new Date(launchRow.free_period_end) : null;
      const now = new Date();

      // Auto-expire if period ended
      if (launchFreeActive && freePeriodEnd && freePeriodEnd < now) {
        await rawDb.execute(rawSql`UPDATE users SET launch_free_active=false WHERE id=${user.id}::uuid`).catch(dbCatch("db"));
        launchFreeActive = false;
      }

      const isLaunchBenefitActive = campaignGlobalOn && launchFreeActive && freePeriodEnd !== null && freePeriodEnd >= now;
      const freeDaysRemaining = isLaunchBenefitActive && freePeriodEnd
        ? Math.max(0, Math.ceil((freePeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
        : 0;

      res.json({
        isOnline: di.isOnline ?? false,
        tripsToday: todayTrips,
        earningsToday: todayGross - todayCommission,
        walletBalance: parseFloat((walletRow.rows[0] as any)?.wallet_balance || 0),
        isLocked: (walletRow.rows[0] as any)?.is_locked || false,
        vehicleCategory: di.vehicleCategoryName || null,
        vehicleIcon: di.vehicleCategoryIcon || null,
        vehicleType: di.vehicleType || null,
        vehicleNumber: di.vehicleNumber || null,
        vehicleModel: di.vehicleModel || null,
        zone: di.zoneName || null,
        availabilityStatus: di.availabilityStatus || 'offline',
        today: { trips: todayTrips, gross: todayGross, net: todayGross - todayCommission },
        week: { trips: parseInt(week.trips), gross: parseFloat(week.gross), net: parseFloat(week.gross) - parseFloat(week.commission) },
        month: { trips: parseInt(month.trips), gross: parseFloat(month.gross), net: parseFloat(month.gross) - parseFloat(month.commission) },
        recentTrips: recentTrips.rows.map(camelize),
        dailyGoal: { target: 10, achieved: todayTrips },
        weeklyGoal: { target: 50, achieved: parseInt(week.trips) },
        launchBenefit: {
          active: isLaunchBenefitActive,
          freeDaysRemaining,
          freePeriodEnd: freePeriodEnd ? freePeriodEnd.toISOString() : null,
          onboardDate: launchRow?.onboard_date ? new Date(launchRow.onboard_date).toISOString() : null,
        },
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Home data (recent + nearby drivers count) -------------------
  app.get("/api/app/customer/home-data", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const [recentTrips, walletRow, savedPlaces, stats, vehicleCats, banners] = await Promise.all([
        rawDb.execute(rawSql`
          SELECT id, ref_id, pickup_address, destination_address, actual_fare, estimated_fare, current_status, created_at, driver_id
          FROM trip_requests WHERE customer_id=${user.id}::uuid ORDER BY created_at DESC LIMIT 5
        `),
        rawDb.execute(rawSql`SELECT wallet_balance FROM users WHERE id=${user.id}::uuid`),
        rawDb.execute(rawSql`SELECT * FROM saved_places WHERE user_id=${user.id}::uuid LIMIT 5`).catch(() => ({ rows: [] })),
        rawDb.execute(rawSql`
          SELECT COUNT(*) as total_trips, COALESCE(SUM(actual_fare),0) as total_spent
          FROM trip_requests WHERE customer_id=${user.id}::uuid AND current_status='completed'
        `),
        rawDb.execute(rawSql`
          SELECT vc.id, vc.name, vc.type, vc.icon, vc.is_active,
            MIN(tf.minimum_fare) as minimum_fare, MIN(tf.base_fare) as base_fare,
            MIN(tf.fare_per_km) as fare_per_km, MIN(tf.helper_charge) as helper_charge
          FROM vehicle_categories vc
          LEFT JOIN trip_fares tf ON tf.vehicle_category_id = vc.id
          GROUP BY vc.id, vc.name, vc.type, vc.icon, vc.is_active
          ORDER BY CASE vc.type WHEN 'ride' THEN 1 WHEN 'parcel' THEN 2 WHEN 'cargo' THEN 3 ELSE 4 END, vc.name
        `),
        rawDb.execute(rawSql`SELECT * FROM banners WHERE is_active=true ORDER BY created_at DESC LIMIT 6`).catch(() => ({ rows: [] })),
      ]);
      res.json({
        walletBalance: parseFloat((walletRow.rows[0] as any)?.wallet_balance || 0),
        recentTrips: recentTrips.rows.map(camelize),
        savedPlaces: savedPlaces.rows.map(camelize),
        stats: { totalTrips: parseInt((stats.rows[0] as any)?.total_trips || 0), totalSpent: parseFloat((stats.rows[0] as any)?.total_spent || 0) },
        vehicleCategories: vehicleCats.rows.map(camelize),
        banners: banners.rows.map(camelize),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Schedule a ride ---------------------------------------------
  app.post("/api/app/customer/schedule-ride", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { pickupAddress, pickupLat, pickupLng, destinationAddress, destinationLat, destinationLng,
        vehicleCategoryId, estimatedFare, estimatedDistance, paymentMethod, scheduledAt } = req.body;
      if (!scheduledAt) return res.status(400).json({ message: "scheduledAt is required" });
      const scheduledTime = new Date(scheduledAt);
      if (scheduledTime <= new Date()) return res.status(400).json({ message: "Schedule time must be in the future" });
      const refId = generateRefId();
      const r = await rawDb.execute(rawSql`
        INSERT INTO trip_requests (
          ref_id, customer_id, pickup_address, pickup_lat, pickup_lng,
          destination_address, destination_lat, destination_lng,
          vehicle_category_id, estimated_fare, estimated_distance,
          payment_method, trip_type, current_status, is_scheduled, scheduled_at,
          pickup_short_name, destination_short_name,
          created_at, updated_at
        ) VALUES (
          ${refId}, ${user.id}::uuid, ${pickupAddress}, ${parseFloat(pickupLat)}, ${parseFloat(pickupLng)},
          ${destinationAddress}, ${parseFloat(destinationLat)}, ${parseFloat(destinationLng)},
          ${vehicleCategoryId}::uuid, ${parseFloat(estimatedFare)}, ${parseFloat(estimatedDistance)},
          ${paymentMethod || 'cash'}, 'normal', 'scheduled', true, ${scheduledAt},
          ${shortLocationName(pickupAddress)}, ${shortLocationName(destinationAddress)},
          now(), now()
        ) RETURNING *
      `);
      res.json({ success: true, trip: camelize(r.rows[0]), message: `Ride scheduled for ${scheduledTime.toLocaleString('en-IN')}` });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER: Get scheduled rides ----------------------------------------
  app.get("/api/app/customer/scheduled-rides", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT t.*, u.full_name as driver_name FROM trip_requests t
        LEFT JOIN users u ON t.driver_id = u.id
        WHERE t.customer_id=${user.id}::uuid AND t.is_scheduled=true
        AND t.scheduled_at > now() - interval '1 day'
        ORDER BY t.scheduled_at ASC
      `);
      res.json({ success: true, scheduledRides: r.rows.map(camelize) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- INTERCITY BOOKING ----------------------------------------------------
  app.post('/api/app/customer/intercity-book', authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { routeId, pickupAddress, destinationAddress, vehicleCategoryId, paymentMethod, scheduledAt, passengers = 1 } = req.body;
      if (!routeId || !scheduledAt) return res.status(400).json({ message: 'routeId and scheduledAt required' });
      const pax = Math.max(1, Math.min(6, parseInt(passengers, 10) || 1));

      const route = await rawDb.execute(rawSql`SELECT * FROM intercity_routes WHERE id=${routeId}::uuid AND is_active=true`);
      if (!route.rows.length) return res.status(404).json({ message: 'Route not found or inactive' });
      const r = route.rows[0] as any;

      const farePerPassenger = parseFloat(r.base_fare || 0) + (parseFloat(r.estimated_km || 0) * parseFloat(r.fare_per_km || 0)) + parseFloat(r.toll_charges || 0);
      const totalFare = parseFloat((farePerPassenger * pax).toFixed(2));
      const refId = 'INT' + Date.now().toString().slice(-8).toUpperCase();

      const trip = await rawDb.execute(rawSql`
        INSERT INTO trip_requests (
          ref_id, customer_id, vehicle_category_id,
          pickup_address, pickup_lat, pickup_lng,
          destination_address, destination_lat, destination_lng,
          estimated_fare, estimated_distance, payment_method,
          trip_type, current_status, is_scheduled, scheduled_at,
          pickup_short_name, destination_short_name
        ) VALUES (
          ${refId}, ${user.id}::uuid, ${vehicleCategoryId ? rawSql`${vehicleCategoryId}::uuid` : rawSql`NULL`},
          ${pickupAddress || r.from_city}, 0, 0,
          ${destinationAddress || r.to_city}, 0, 0,
          ${totalFare}, ${parseFloat(r.estimated_km || 0)}, ${paymentMethod || 'cash'},
          'intercity', 'scheduled', true, ${scheduledAt},
          ${shortLocationName(pickupAddress || r.from_city)}, ${shortLocationName(destinationAddress || r.to_city)}
        ) RETURNING *
      `);
      res.json({
        success: true,
        trip: camelize(trip.rows[0]),
        refId,
        estimatedFare: totalFare,
        farePerPassenger,
        passengers: pax,
        route: camelize(r),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- CUSTOMER SUPPORT CHAT -------------------------------------------------
  app.get('/api/app/customer/support-chat', authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT * FROM support_messages WHERE user_id=${user.id}::uuid ORDER BY created_at ASC LIMIT 100
      `);
      await rawDb.execute(rawSql`UPDATE support_messages SET is_read=true WHERE user_id=${user.id}::uuid AND sender='admin'`);
      res.json({ messages: r.rows.map(camelize) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post('/api/app/customer/support-chat/send', authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { message } = req.body;
      if (!message) return res.status(400).json({ message: 'message required' });
      const r = await rawDb.execute(rawSql`
        INSERT INTO support_messages (user_id, sender, message) VALUES (${user.id}::uuid, 'user', ${message}) RETURNING *
      `);
      res.json({ success: true, data: camelize(r.rows[0]) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Driver support chat (aliases customer endpoints � same user table) ---
  app.get('/api/app/driver/support-chat', authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT * FROM support_messages WHERE user_id=${user.id}::uuid ORDER BY created_at ASC LIMIT 100
      `);
      await rawDb.execute(rawSql`UPDATE support_messages SET is_read=true WHERE user_id=${user.id}::uuid AND sender='admin'`);
      res.json({ messages: r.rows.map(camelize) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post('/api/app/driver/support-chat/send', authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { message } = req.body;
      if (!message) return res.status(400).json({ message: 'message required' });
      const r = await rawDb.execute(rawSql`
        INSERT INTO support_messages (user_id, sender, message) VALUES (${user.id}::uuid, 'user', ${message}) RETURNING *
      `);
      res.json({ success: true, data: camelize(r.rows[0]) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- TRIP SHARING: Generate share link ------------------------------------
  app.post("/api/app/trip-share", authApp, async (req, res) => {
    try {
      const { tripId } = req.body;
      if (!tripId) return res.status(400).json({ message: "tripId required" });
      const shareToken = crypto.randomBytes(8).toString("hex");
      await rawDb.execute(rawSql`
        UPDATE trip_requests SET share_token=${shareToken}, updated_at=now() WHERE id=${tripId}::uuid
      `).catch(async () => {
        await rawDb.execute(rawSql`ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS share_token VARCHAR(64)`);
        await rawDb.execute(rawSql`UPDATE trip_requests SET share_token=${shareToken} WHERE id=${tripId}::uuid`);
      });
      const appBaseUrl = String(process.env.APP_BASE_URL || "").trim();
      if (!appBaseUrl) {
        return res.status(503).json({ message: "APP_BASE_URL is not configured" });
      }
      const shareLink = `${appBaseUrl}/track/${shareToken}`;
      res.json({ success: true, shareLink, shareToken });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- TRIP SHARING: Get trip by share token (public) ------------------------
  app.get("/api/app/track/:token", async (req, res) => {
    try {
      const { token } = req.params;
      const r = await rawDb.execute(rawSql`
        SELECT t.ref_id, t.pickup_address, t.destination_address, t.current_status,
               t.pickup_lat, t.pickup_lng, t.destination_lat, t.destination_lng,
               u.full_name as driver_name, u.phone as driver_phone,
               uv.lat as driver_lat, uv.lng as driver_lng
        FROM trip_requests t
        LEFT JOIN users u ON t.driver_id = u.id
        LEFT JOIN (SELECT user_id, lat, lng FROM driver_locations ORDER BY created_at DESC) uv ON uv.user_id = t.driver_id
        WHERE t.share_token=${token}
        LIMIT 1
      `).catch(() => ({ rows: [] }));
      if (!r.rows.length) return res.status(404).json({ message: "Trip not found" });
      res.json({ success: true, trip: camelize(r.rows[0]) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- EMERGENCY CONTACTS (CRUD) ---------------------------------------------
  app.get("/api/app/emergency-contacts", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT * FROM emergency_contacts WHERE user_id=${user.id}::uuid ORDER BY created_at ASC
      `).catch(async () => {
        await rawDb.execute(rawSql`
          CREATE TABLE IF NOT EXISTS emergency_contacts (
            id SERIAL PRIMARY KEY, user_id UUID, name VARCHAR(100), phone VARCHAR(20),
            relation VARCHAR(50), created_at TIMESTAMPTZ DEFAULT now()
          )
        `);
        return { rows: [] };
      });
      res.json({ success: true, contacts: r.rows.map(camelize) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/app/emergency-contacts", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { name, phone, relation } = req.body;
      if (!name || !phone) return res.status(400).json({ message: "Name and phone required" });
      const existing = await rawDb.execute(rawSql`SELECT COUNT(*) as c FROM emergency_contacts WHERE user_id=${user.id}::uuid`).catch(() => ({ rows: [{ c: '0' }] }));
      if (parseInt((existing.rows[0] as any).c) >= 3) return res.status(400).json({ message: "Maximum 3 emergency contacts allowed" });
      await rawDb.execute(rawSql`
        CREATE TABLE IF NOT EXISTS emergency_contacts (
          id SERIAL PRIMARY KEY, user_id UUID, name VARCHAR(100), phone VARCHAR(20),
          relation VARCHAR(50), created_at TIMESTAMPTZ DEFAULT now()
        )
      `);
      const r = await rawDb.execute(rawSql`
        INSERT INTO emergency_contacts (user_id, name, phone, relation) VALUES (${user.id}::uuid, ${name}, ${phone}, ${relation || 'Friend'}) RETURNING *
      `);
      res.json({ success: true, contact: camelize(r.rows[0]) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.delete("/api/app/emergency-contacts/:id", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      await rawDb.execute(rawSql`DELETE FROM emergency_contacts WHERE id=${parseInt(req.params.id as string)} AND user_id=${user.id}::uuid`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- IN-APP NOTIFICATIONS -------------------------------------------------
  app.get("/api/app/notifications", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT * FROM notification_log WHERE user_id=${user.id}::uuid ORDER BY created_at DESC LIMIT 30
      `).catch(() => ({ rows: [] }));
      const unread = await rawDb.execute(rawSql`
        SELECT COUNT(*) as c FROM notification_log WHERE user_id=${user.id}::uuid AND is_read=false
      `).catch(() => ({ rows: [{ c: '0' }] }));
      res.json({ success: true, notifications: r.rows.map(camelize), unreadCount: parseInt((unread.rows[0] as any)?.c || '0') });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  const _markNotificationsRead = async (req: any, res: any) => {
    try {
      const user = (req as any).currentUser;
      await rawDb.execute(rawSql`UPDATE notification_log SET is_read=true WHERE user_id=${user.id}::uuid`).catch(dbCatch("db"));
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  };
  app.patch("/api/app/notifications/read-all", authApp, _markNotificationsRead);
  app.post("/api/app/notifications/read-all", authApp, _markNotificationsRead);

  // -- DRIVER: Performance score ---------------------------------------------
  // -- DRIVER: Weekly Earnings Chart (7 days breakdown) --------------------
  app.get("/api/app/driver/weekly-earnings", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT
          TO_CHAR(created_at::date, 'Dy') as day,
          TO_CHAR(created_at::date, 'YYYY-MM-DD') as date,
          COUNT(*) as trips,
          COALESCE(SUM(actual_fare::numeric), 0) as gross
        FROM trip_requests
        WHERE driver_id=${user.id}::uuid
          AND current_status='completed'
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY created_at::date
        ORDER BY created_at::date ASC
      `);
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const today = new Date();
      const result = days.map((d, i) => {
        const date = new Date(today);
        date.setDate(today.getDate() - (6 - i));
        const dateStr = date.toISOString().split('T')[0];
        const row = r.rows.find((row: any) => row.date === dateStr);
        return {
          day: d,
          date: dateStr,
          trips: parseInt(row?.trips?.toString() || '0'),
          gross: parseFloat(row?.gross?.toString() || '0'),
        };
      });
      res.json({ days: result, total: result.reduce((s, d) => s + d.gross, 0) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/app/driver/performance", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const [acceptance, completion, rating] = await Promise.all([
        rawDb.execute(rawSql`
          SELECT COUNT(*) FILTER (WHERE current_status='completed') as accepted,
                 COUNT(*) FILTER (WHERE current_status='cancelled') as cancelled,
                 COUNT(*) as total
          FROM trip_requests WHERE driver_id=${user.id}::uuid
          AND created_at >= date_trunc('month', CURRENT_DATE)
        `),
        rawDb.execute(rawSql`
          SELECT COALESCE(AVG(driver_rating),5) as avg_rating FROM trip_requests
          WHERE driver_id=${user.id}::uuid AND driver_rating IS NOT NULL
          AND created_at >= date_trunc('month', CURRENT_DATE)
        `),
        rawDb.execute(rawSql`SELECT rating FROM users WHERE id=${user.id}::uuid`),
      ]);
      const acc = acceptance.rows[0] as any;
      const totalTrips = parseInt(acc.total || '0');
      const completedTrips = parseInt(acc.accepted || '0');
      const cancelledTrips = parseInt(acc.cancelled || '0');
      const acceptanceRate = totalTrips > 0 ? Math.round((completedTrips / totalTrips) * 100) : 100;
      const avgRating = parseFloat((rating.rows[0] as any)?.avg_rating || 5);
      const performanceScore = Math.round((acceptanceRate * 0.4) + (avgRating * 12));
      res.json({
        acceptanceRate, completedTrips, cancelledTrips,
        avgRating: avgRating.toFixed(1),
        performanceScore: Math.min(100, performanceScore),
        level: performanceScore >= 90 ? 'Gold' : performanceScore >= 70 ? 'Silver' : 'Bronze',
        overallRating: parseFloat((rating.rows[0] as any)?.rating || 5),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // ========== FLUTTER SDK FILES DOWNLOAD ==========
  app.use("/flutter", express.static(path.join(process.cwd(), "public", "flutter")));

  // ========== APK DOWNLOADS ==========
  const apkDir = path.join(process.cwd(), "public", "apks");
  const apkAliasPrefixes: Record<string, string> = {
    "jago-customer-latest.apk": "jago-customer-v",
    "jago-driver-latest.apk": "jago-driver-v",
    "jago-pilot-latest.apk": "jago-pilot-v",
  };

  const parseApkVersion = (fileName: string): [number, number, number] => {
    const match = fileName.match(/v(\d+)\.(\d+)\.(\d+)/i);
    if (!match) return [0, 0, 0];
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const compareApkVersions = (a: string, b: string): number => {
    const av = parseApkVersion(a);
    const bv = parseApkVersion(b);
    for (let i = 0; i < 3; i++) {
      if (av[i] !== bv[i]) return bv[i] - av[i];
    }
    return 0;
  };

  const findLatestApk = (prefix: string): string | null => {
    if (!fs.existsSync(apkDir)) return null;
    const files = fs.readdirSync(apkDir)
      .filter((file) => file.startsWith(prefix) && file.endsWith(".apk"))
      .sort(compareApkVersions);
    return files[0] ?? null;
  };

  const formatApkVersion = (fileName: string | null, fallback: string): string => {
    const match = fileName?.match(/v\d+\.\d+\.\d+/i);
    return match?.[0] ?? fallback;
  };

  const formatApkSize = (fileName: string | null): string => {
    if (!fileName) return "APK unavailable";
    const filePath = path.join(apkDir, fileName);
    if (!fs.existsSync(filePath)) return "APK unavailable";
    const sizeMb = Math.round(fs.statSync(filePath).size / (1024 * 1024));
    return `${sizeMb} MB`;
  };

  const resolveApkAlias = (fileName: string): string | null => {
    const prefix = apkAliasPrefixes[fileName];
    if (!prefix) return null;
    return findLatestApk(prefix);
  };

  app.get("/apks/:fileName", (req, res, next) => {
    const target = resolveApkAlias(req.params.fileName);
    if (!target) return next();
    return res.sendFile(path.join(apkDir, target));
  });

  app.use("/apks", express.static(apkDir));

  // Download page � jagopro.org/download
  app.get("/download", (_req, res) => {
    const base = String(process.env.APP_BASE_URL || "").trim();
    if (!base) {
      return res.status(503).send("APP_BASE_URL is not configured");
    }
    const customerLatest = findLatestApk("jago-customer-v");
    const driverLatest = findLatestApk("jago-driver-v") ?? findLatestApk("jago-pilot-v");
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download JAGO Pro App</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#1e293b;border-radius:24px;padding:40px;max-width:480px;width:90%;text-align:center;box-shadow:0 25px 60px rgba(0,0,0,.4)}
.logo{font-size:48px;font-weight:900;color:#1e6de5;letter-spacing:-2px;margin-bottom:8px}
.sub{color:#94a3b8;margin-bottom:36px;font-size:15px}
.btn{display:block;padding:16px 24px;border-radius:14px;text-decoration:none;font-weight:700;font-size:16px;margin-bottom:14px;transition:.2s}
.btn-blue{background:#1e6de5;color:#fff}
.btn-blue:hover{background:#1558c0}
.btn-green{background:#16a34a;color:#fff}
.btn-green:hover{background:#15803d}
.badge{background:#0f172a;border-radius:8px;padding:6px 12px;font-size:12px;color:#64748b;margin-top:8px;display:inline-block}
.version{color:#475569;font-size:12px;margin-top:20px}
</style></head><body>
<div class="card">
  <div class="logo">JAGO Pro</div>
  <div class="sub">Ride. Deliver. Earn.</div>
  <a class="btn btn-blue" href="/apks/jago-customer-latest.apk" download>
    ?? Download Customer App
  </a>
  <span class="badge">${formatApkVersion(customerLatest, "Latest")} | Universal APK | ${formatApkSize(customerLatest)}</span>
  <br><br>
  <a class="btn btn-green" href="/apks/jago-driver-latest.apk" download>
    ?? Download Driver / Pilot App
  </a>
  <span class="badge">${formatApkVersion(driverLatest, "Latest")} | Universal APK | ${formatApkSize(driverLatest)}</span>
  <div class="version">Android 6.0+ required � Free Download</div>
</div>
</body></html>`);
  });

  // ========== NOTIFICATION LOGS (update send to persist) ==========
  app.get("/api/notifications", async (req, res) => {
    try {
      const { limit = 50, offset = 0 } = req.query;
      const rows = await rawDb.execute(rawSql`
        SELECT * FROM notification_logs ORDER BY sent_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `);
      const countRes = await rawDb.execute(rawSql`SELECT COUNT(*) as total FROM notification_logs`);
      res.json({ data: rows.rows.map(camelize), total: Number((countRes.rows[0] as any).total) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -------------------------------------------------------------------
  // ������   UNIQUE FEATURES � No competitor has all of these   ������
  // -------------------------------------------------------------------

  // Helper: inline auth check for unique feature routes
  async function requireAppAuth(req: Request, res: Response): Promise<any | null> {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (!token) { res.status(401).json({ message: "No token provided" }); return null; }
      const parts = token.split(":");
      if (parts.length < 2) { res.status(401).json({ message: "Invalid token format" }); return null; }
      const userId = parts[0];
      const userR = await rawDb.execute(rawSql`SELECT * FROM users WHERE id=${userId}::uuid AND is_active=true AND auth_token=${token} LIMIT 1`);
      if (!userR.rows.length) { res.status(401).json({ message: "Session expired. Please login again." }); return null; }
      return camelize(userR.rows[0]);
    } catch (e: any) { res.status(401).json({ message: "Auth failed" }); return null; }
  }

  // -- Ensure feature tables exist -------------------------------------
  (async () => {
    try {
      await rawDb.execute(rawSql`
        CREATE TABLE IF NOT EXISTS coins_ledger (
          id SERIAL PRIMARY KEY, user_id UUID NOT NULL, amount INTEGER NOT NULL,
          type VARCHAR(30) NOT NULL, description TEXT, trip_id UUID,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS user_preferences (
          user_id UUID PRIMARY KEY, quiet_ride BOOLEAN DEFAULT false,
          ac_preferred BOOLEAN DEFAULT true, music_off BOOLEAN DEFAULT false,
          wheelchair_accessible BOOLEAN DEFAULT false, extra_luggage BOOLEAN DEFAULT false,
          preferred_gender VARCHAR(10) DEFAULT 'any',
          updated_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS lost_found_reports (
          id SERIAL PRIMARY KEY, customer_id UUID NOT NULL, trip_id UUID,
          description TEXT NOT NULL, contact_phone VARCHAR(15),
          status VARCHAR(20) DEFAULT 'open', driver_id UUID,
          created_at TIMESTAMP DEFAULT NOW(), resolved_at TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS monthly_passes (
          id SERIAL PRIMARY KEY, user_id UUID NOT NULL,
          rides_total INTEGER DEFAULT 30, rides_used INTEGER DEFAULT 0,
          valid_from DATE DEFAULT CURRENT_DATE,
          valid_until DATE DEFAULT (CURRENT_DATE + INTERVAL '30 days'),
          amount_paid NUMERIC(10,2), plan_name VARCHAR(50),
          is_active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS surge_alerts (
          id SERIAL PRIMARY KEY, user_id UUID NOT NULL,
          pickup_lat NUMERIC(10,7), pickup_lng NUMERIC(10,7),
          pickup_address TEXT, created_at TIMESTAMP DEFAULT NOW(), notified_at TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS spin_wheel_plays (
          id SERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          item_id UUID,
          reward_type VARCHAR(30),
          reward_amount NUMERIC(10,2) DEFAULT 0,
          played_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS support_messages (
          id SERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          sender VARCHAR(10) NOT NULL CHECK (sender IN ('admin','user')),
          message TEXT NOT NULL,
          is_read BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      // Add break_until column to users if not exists
      await rawDb.execute(rawSql`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS break_until TIMESTAMP;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS jago_coins INTEGER DEFAULT 0;
        ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(10,2) DEFAULT 0;
        ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS ride_preferences JSONB;
      `);
    } catch (_) { }
  })();

  // ??????????????????????????????????????????????????????????????????
  // 1. JAGO Pro COINS � Loyalty Program
  // ??????????????????????????????????????????????????????????????????
  app.get("/api/app/customer/coins", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      const [balRes, histRes] = await Promise.all([
        rawDb.execute(rawSql`SELECT jago_coins FROM users WHERE id=${user.id}::uuid`),
        rawDb.execute(rawSql`
          SELECT * FROM coins_ledger WHERE user_id=${user.id}::uuid
          ORDER BY created_at DESC LIMIT 30
        `),
      ]);
      const balance = parseInt((balRes.rows[0] as any)?.jago_coins || 0);
      res.json({
        balance,
        rupeeValue: Math.floor(balance / 10),
        history: histRes.rows.map(camelize),
        howItWorks: [
          "Every ?10 fare = 1 JAGO Pro Coin",
          "100 Coins = ?10 discount on next ride",
          "Coins valid for 12 months",
          "Bonus coins on referrals & first rides",
        ],
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/app/customer/redeem-coins", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      const { coins } = req.body;
      if (!coins || coins < 100) return res.status(400).json({ message: "Minimum 100 coins to redeem" });
      const bal = await rawDb.execute(rawSql`SELECT jago_coins FROM users WHERE id=${user.id}::uuid`);
      const current = parseInt((bal.rows[0] as any)?.jago_coins || 0);
      if (current < coins) return res.status(400).json({ message: "Insufficient coins" });
      const discount = Math.floor(coins / 10);
      await rawDb.execute(rawSql`UPDATE users SET jago_coins = jago_coins - ${coins} WHERE id=${user.id}::uuid`);
      await rawDb.execute(rawSql`
        INSERT INTO coins_ledger (user_id, amount, type, description)
        VALUES (${user.id}::uuid, ${-coins}, 'redeem', 'Redeemed ${coins} coins for ?${discount} discount')
      `);
      res.json({ success: true, coinsUsed: coins, discountAmount: discount, message: `?${discount} discount applied to next ride!` });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Daily Spin Wheel (customer-facing) -----------------------------------
  app.get("/api/app/customer/spin-wheel", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const [itemsR, playedR] = await Promise.all([
        rawDb.execute(rawSql`SELECT id, label, reward_amount, reward_type, probability FROM spin_wheel_items WHERE is_active=true ORDER BY RANDOM()`),
        rawDb.execute(rawSql`
          SELECT id FROM spin_wheel_plays
          WHERE user_id=${user.id}::uuid AND played_at > NOW() - INTERVAL '24 hours'
          LIMIT 1
        `),
      ]);
      const canSpin = playedR.rows.length === 0;
      res.json({ items: itemsR.rows.map(camelize), canSpin });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/app/customer/spin-wheel/play", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      // Check 24h cooldown
      const played = await rawDb.execute(rawSql`
        SELECT id FROM spin_wheel_plays
        WHERE user_id=${user.id}::uuid AND played_at > NOW() - INTERVAL '24 hours'
        LIMIT 1
      `);
      if (played.rows.length > 0) return res.status(429).json({ message: 'Already spun today! Come back in 24 hours.' });

      // Pick a weighted random item
      const itemsR = await rawDb.execute(rawSql`
        SELECT id, label, reward_amount, reward_type, probability FROM spin_wheel_items WHERE is_active=true
      `);
      if (itemsR.rows.length === 0) return res.status(404).json({ message: 'Spin wheel not configured' });

      const items = itemsR.rows as any[];
      const totalWeight = items.reduce((s: number, i: any) => s + parseFloat(i.probability || 1), 0);
      let rand = Math.random() * totalWeight;
      let chosen = items[0];
      for (const it of items) {
        rand -= parseFloat(it.probability || 1);
        if (rand <= 0) { chosen = it; break; }
      }

      // Record play
      await rawDb.execute(rawSql`
        INSERT INTO spin_wheel_plays (user_id, item_id, reward_type, reward_amount)
        VALUES (${user.id}::uuid, ${chosen.id}::uuid, ${chosen.reward_type}, ${chosen.reward_amount})
      `);

      // Award reward
      if (chosen.reward_type === 'coins' && parseFloat(chosen.reward_amount) > 0) {
        await rawDb.execute(rawSql`UPDATE users SET jago_coins = COALESCE(jago_coins,0) + ${parseInt(chosen.reward_amount)} WHERE id=${user.id}::uuid`);
        await rawDb.execute(rawSql`INSERT INTO coins_ledger (user_id, amount, type, description) VALUES (${user.id}::uuid, ${parseInt(chosen.reward_amount)}, 'spin_wheel', 'Daily spin reward: ${chosen.label}')`).catch(dbCatch("db"));
      } else if (chosen.reward_type === 'wallet' && parseFloat(chosen.reward_amount) > 0) {
        await rawDb.execute(rawSql`UPDATE users SET wallet_balance = COALESCE(wallet_balance,0) + ${parseFloat(chosen.reward_amount)} WHERE id=${user.id}::uuid`);
      }

      res.json({ success: true, item: camelize(chosen), canSpin: false });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // ??????????????????????????????????????????????????????????????????
  // 2. RIDE PREFERENCES (Quiet ride, AC, Music off, etc.)
  // ??????????????????????????????????????????????????????????????????
  app.get("/api/app/customer/preferences", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      const rows = await rawDb.execute(rawSql`SELECT * FROM user_preferences WHERE user_id=${user.id}::uuid`);
      if (rows.rows.length === 0) {
        res.json({ quietRide: false, acPreferred: true, musicOff: false, wheelchairAccessible: false, extraLuggage: false, preferredGender: 'any' });
      } else {
        res.json(camelize(rows.rows[0]));
      }
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/app/customer/preferences", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      const { quietRide, acPreferred, musicOff, wheelchairAccessible, extraLuggage, preferredGender } = req.body;
      await rawDb.execute(rawSql`
        INSERT INTO user_preferences (user_id, quiet_ride, ac_preferred, music_off, wheelchair_accessible, extra_luggage, preferred_gender)
        VALUES (${user.id}::uuid, ${!!quietRide}, ${acPreferred !== false}, ${!!musicOff}, ${!!wheelchairAccessible}, ${!!extraLuggage}, ${preferredGender || 'any'})
        ON CONFLICT (user_id) DO UPDATE SET
          quiet_ride=${!!quietRide}, ac_preferred=${acPreferred !== false}, music_off=${!!musicOff},
          wheelchair_accessible=${!!wheelchairAccessible}, extra_luggage=${!!extraLuggage},
          preferred_gender=${preferredGender || 'any'}, updated_at=NOW()
      `);
      res.json({ success: true, message: "Preferences saved! Applied to your next ride." });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // ??????????????????????????????????????????????????????????????????
  // 3. POST-RIDE TIP DRIVER
  // ??????????????????????????????????????????????????????????????????
  app.post("/api/app/tip-driver", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      const { tripId, amount } = req.body;
      if (!tripId || !amount || amount <= 0) return res.status(400).json({ message: "Invalid tip amount" });
      const tripRes = await rawDb.execute(rawSql`SELECT * FROM trip_requests WHERE id=${tripId}::uuid`);
      const trip = tripRes.rows[0] as any;
      if (!trip) return res.status(404).json({ message: "Trip not found" });
      if (trip.customer_id !== user.id && trip.driver_id !== user.id) return res.status(403).json({ message: "Not authorized" });
      await rawDb.execute(rawSql`UPDATE trip_requests SET tip_amount=${amount} WHERE id=${tripId}::uuid`);
      // Credit tip to driver wallet
      await rawDb.execute(rawSql`UPDATE users SET wallet_balance = wallet_balance + ${amount} WHERE id=${trip.driver_id}::uuid`);
      // Log it
      await rawDb.execute(rawSql`
        INSERT INTO coins_ledger (user_id, amount, type, description, trip_id)
        VALUES (${trip.driver_id}::uuid, ${amount * 10}, 'tip_bonus', 'Tip received for ride � bonus coins', ${tripId}::uuid)
      `);
      res.json({ success: true, message: `?${amount} tip sent to driver! You also earned ${amount * 10} bonus JAGO Pro Coins ??` });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // ??????????????????????????????????????????????????????????????????
  // 4. LOST & FOUND
  // ??????????????????????????????????????????????????????????????????
  app.post("/api/app/lost-found", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      const { tripId, description, contactPhone } = req.body;
      if (!description) return res.status(400).json({ message: "Description required" });
      let driverId = null;
      if (tripId) {
        const tr = await rawDb.execute(rawSql`SELECT driver_id FROM trip_requests WHERE id=${tripId}::uuid`);
        driverId = (tr.rows[0] as any)?.driver_id || null;
      }
      const result = await rawDb.execute(rawSql`
        INSERT INTO lost_found_reports (customer_id, trip_id, description, contact_phone, driver_id)
        VALUES (${user.id}::uuid, ${tripId || null}, ${description}, ${contactPhone || user.phone}, ${driverId || null})
        RETURNING id
      `);
      res.json({ success: true, reportId: (result.rows[0] as any).id, message: "Report submitted! We will contact the driver and update you within 2 hours." });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/app/customer/lost-found", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      const rows = await rawDb.execute(rawSql`
        SELECT l.*, t.pickup_address, t.destination_address,
               u.full_name as driver_name, u.phone as driver_phone
        FROM lost_found_reports l
        LEFT JOIN trip_requests t ON l.trip_id = t.id
        LEFT JOIN users u ON l.driver_id = u.id
        WHERE l.customer_id=${user.id}::uuid
        ORDER BY l.created_at DESC
      `);
      res.json(rows.rows.map(camelize));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // ??????????????????????????????????????????????????????????????????
  // 5. MONTHLY PASS
  // ??????????????????????????????????????????????????????????????????
  const MONTHLY_PLANS = [
    { name: 'JAGO Pro Basic', rides: 20, price: 699, discount: '15%' },
    { name: 'JAGO Pro Plus', rides: 40, price: 1199, discount: '25%' },
    { name: 'JAGO Pro', rides: 80, price: 1999, discount: '35%' },
  ];

  app.get("/api/app/customer/monthly-pass", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      const active = await rawDb.execute(rawSql`
        SELECT * FROM monthly_passes WHERE user_id=${user.id}::uuid
        AND is_active=true AND valid_until >= CURRENT_DATE
        ORDER BY created_at DESC LIMIT 1
      `);
      res.json({
        activePlan: active.rows.length ? camelize(active.rows[0]) : null,
        availablePlans: MONTHLY_PLANS,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/app/customer/monthly-pass/buy", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      const { planName } = req.body;
      const plan = MONTHLY_PLANS.find(p => p.name === planName);
      if (!plan) return res.status(400).json({ message: "Invalid plan" });
      // Check wallet balance
      const walRes = await rawDb.execute(rawSql`SELECT wallet_balance FROM users WHERE id=${user.id}::uuid`);
      const bal = parseFloat((walRes.rows[0] as any)?.wallet_balance || 0);
      if (bal < plan.price) return res.status(400).json({ message: `Insufficient wallet balance. Need ?${plan.price}, have ?${bal.toFixed(0)}` });
      // Deduct & create pass
      await rawDb.execute(rawSql`UPDATE users SET wallet_balance = wallet_balance - ${plan.price} WHERE id=${user.id}::uuid`);
      await rawDb.execute(rawSql`UPDATE monthly_passes SET is_active=false WHERE user_id=${user.id}::uuid`);
      await rawDb.execute(rawSql`
        INSERT INTO monthly_passes (user_id, rides_total, rides_used, amount_paid, plan_name)
        VALUES (${user.id}::uuid, ${plan.rides}, 0, ${plan.price}, ${plan.name})
      `);
      // Bonus coins for buying pass
      const bonusCoins = plan.rides * 5;
      await rawDb.execute(rawSql`UPDATE users SET jago_coins = jago_coins + ${bonusCoins} WHERE id=${user.id}::uuid`);
      await rawDb.execute(rawSql`
        INSERT INTO coins_ledger (user_id, amount, type, description)
        VALUES (${user.id}::uuid, ${bonusCoins}, 'pass_bonus', 'Welcome bonus for ${plan.name} purchase')
      `);
      res.json({ success: true, message: `${plan.name} activated! ${plan.rides} rides for 30 days. Bonus: ${bonusCoins} JAGO Pro Coins credited!` });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // ??????????????????????????????????????????????????????????????????
  // ??????????????????????????????????????????????????????????????????
  // CAR SHARING � Customer browse & book
  // ??????????????????????????????????????????????????????????????????
  app.get('/api/app/customer/car-sharing/rides', authApp, async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT cs.*,
          u.full_name as driver_name,
          vc.name as vehicle_name,
          GREATEST(0, cs.max_seats - COALESCE((SELECT SUM(b.seats_booked) FROM car_sharing_bookings b WHERE b.ride_id = cs.id AND b.status != 'cancelled'),0)) as available_seats
        FROM car_sharing_rides cs
        LEFT JOIN users u ON u.id = cs.driver_id
        LEFT JOIN vehicle_categories vc ON vc.id = cs.vehicle_category_id
        WHERE cs.status = 'active' AND cs.departure_time > NOW()
        ORDER BY cs.departure_time ASC
      `);
      res.json({ data: camelize(r.rows), total: r.rows.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post('/api/app/customer/car-sharing/book', authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { rideId, seatsBooked = 1 } = req.body;
      if (!rideId) return res.status(400).json({ message: 'rideId required' });
      const seats = parseInt(seatsBooked, 10);
      if (!Number.isFinite(seats) || seats < 1 || seats > 2) {
        return res.status(400).json({ message: 'You can book only 1 or 2 seats per booking' });
      }
      const rideRes = await rawDb.execute(rawSql`
        SELECT cs.*, COALESCE((SELECT SUM(b.seats_booked) FROM car_sharing_bookings b WHERE b.ride_id = cs.id AND b.status != 'cancelled'),0) as booked_count
        FROM car_sharing_rides cs
        WHERE cs.id = ${rideId}::uuid AND cs.status = 'active' AND cs.departure_time > NOW()
      `);
      if (!rideRes.rows.length) return res.status(404).json({ message: 'Ride not found' });
      const ride = camelize(rideRes.rows[0]);
      const totalFare = parseFloat((parseFloat(ride.seatPrice || 0) * seats).toFixed(2));
      // ATOMIC: deduct wallet only if balance sufficient � prevents negative balance race
      const walUpd = await rawDb.execute(rawSql`
        UPDATE users SET wallet_balance = wallet_balance - ${totalFare}
        WHERE id=${user.id}::uuid AND wallet_balance >= ${totalFare}
        RETURNING wallet_balance
      `);
      if (!walUpd.rows.length) {
        const walRes = await rawDb.execute(rawSql`SELECT wallet_balance FROM users WHERE id=${user.id}::uuid`);
        const bal = parseFloat(String(walRes.rows[0]?.wallet_balance || '0'));
        return res.status(400).json({ message: 'Insufficient wallet balance. Need ?' + totalFare + ', have ?' + bal.toFixed(0) });
      }
      // ATOMIC: insert booking only if seats still available (re-check under write lock)
      const bookingR = await rawDb.execute(rawSql`
        INSERT INTO car_sharing_bookings (ride_id, customer_id, seats_booked, total_fare, status)
        SELECT ${rideId}::uuid, ${user.id}::uuid, ${seats}, ${totalFare}, 'confirmed'
        WHERE (SELECT COALESCE(SUM(b2.seats_booked),0) FROM car_sharing_bookings b2 WHERE b2.ride_id=${rideId}::uuid AND b2.status!='cancelled') + ${seats} <= ${parseInt(String(ride.maxSeats || 0), 10)}
        RETURNING id
      `);
      if (!bookingR.rows.length) {
        // Seats were taken between our check and insert � refund the wallet deduction
        await rawDb.execute(rawSql`UPDATE users SET wallet_balance = wallet_balance + ${totalFare} WHERE id=${user.id}::uuid`);
        return res.status(409).json({ message: 'No seats available. Please try again.' });
      }
      res.json({ success: true, message: seats + ' seat(s) booked for ?' + totalFare + '. Deducted from wallet.', totalFare });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get('/api/app/customer/car-sharing/my-bookings', authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT b.*, cs.from_location, cs.to_location, cs.departure_time, cs.seat_price,
          u.full_name as driver_name, u.phone as driver_phone, vc.name as vehicle_name
        FROM car_sharing_bookings b
        LEFT JOIN car_sharing_rides cs ON cs.id = b.ride_id
        LEFT JOIN users u ON u.id = cs.driver_id
        LEFT JOIN vehicle_categories vc ON vc.id = cs.vehicle_category_id
        WHERE b.customer_id = ${user.id}::uuid
        ORDER BY b.created_at DESC
      `);
      res.json({ data: camelize(r.rows), total: r.rows.length });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // 6. SURGE ALERT � "Notify me when surge drops"
  // ??????????????????????????????????????????????????????????????????
  app.post("/api/app/customer/surge-alert", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      const { lat, lng, address } = req.body;
      await rawDb.execute(rawSql`
        INSERT INTO surge_alerts (user_id, pickup_lat, pickup_lng, pickup_address)
        VALUES (${user.id}::uuid, ${lat || 0}, ${lng || 0}, ${address || ''})
      `);
      res.json({ success: true, message: "We'll notify you when surge pricing drops for this area!" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // ??????????????????????????????????????????????????????????????????
  // 7. DRIVER BREAK MODE � Set break, show "Back in X min" to customers
  // ??????????????????????????????????????????????????????????????????
  app.post("/api/app/driver/break", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      const { minutes } = req.body;
      if (!minutes || minutes < 1 || minutes > 120) return res.status(400).json({ message: "Break: 1�120 minutes only" });
      const breakUntil = new Date(Date.now() + minutes * 60 * 1000);
      await rawDb.execute(rawSql`UPDATE users SET break_until=${breakUntil.toISOString()}, is_online=false WHERE id=${user.id}::uuid`);
      res.json({ success: true, breakUntil: breakUntil.toISOString(), message: `Break set for ${minutes} minutes. You'll auto go-online after break.` });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.delete("/api/app/driver/break", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      await rawDb.execute(rawSql`UPDATE users SET break_until=NULL, is_online=true WHERE id=${user.id}::uuid`);
      res.json({ success: true, message: "Break ended! You are now online." });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/app/driver/break", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      const dbRes = await rawDb.execute(rawSql`SELECT break_until FROM users WHERE id=${user.id}::uuid`);
      const breakUntil = (dbRes.rows[0] as any)?.break_until;
      if (!breakUntil || new Date(breakUntil) < new Date()) {
        // Auto end break if time passed
        if (breakUntil) await rawDb.execute(rawSql`UPDATE users SET break_until=NULL, is_online=true WHERE id=${user.id}::uuid`);
        return res.json({ onBreak: false });
      }
      const minsLeft = Math.ceil((new Date(breakUntil).getTime() - Date.now()) / 60000);
      res.json({ onBreak: true, breakUntil, minutesLeft: minsLeft });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // ??????????????????????????????????????????????????????????????????
  // 8. DRIVER FATIGUE ALERT � Warn admin if driver online 8+ hrs
  // ??????????????????????????????????????????????????????????????????
  app.get("/api/app/driver/fatigue-status", async (req, res) => {
    try {
      const user = await requireAppAuth(req, res); if (!user) return;
      // Count trips today
      const today = await rawDb.execute(rawSql`
        SELECT COUNT(*) as cnt, COALESCE(SUM(EXTRACT(EPOCH FROM (updated_at - created_at))/3600), 0) as hrs
        FROM trip_requests WHERE driver_id=${user.id}::uuid
        AND created_at >= CURRENT_DATE AND (current_status='completed' OR current_status='on_the_way')
      `);
      const trips = parseInt((today.rows[0] as any)?.cnt || 0);
      const hrs = parseFloat((today.rows[0] as any)?.hrs || 0);
      const fatigueLevel = hrs >= 8 ? 'high' : hrs >= 5 ? 'medium' : 'low';
      res.json({
        hoursOnline: hrs.toFixed(1),
        tripsToday: trips,
        fatigueLevel,
        recommendation: fatigueLevel === 'high'
          ? "You've been driving 8+ hours. Please take a long break for your safety!"
          : fatigueLevel === 'medium'
            ? "You've been driving 5+ hours. Consider a short break soon."
            : "You're doing great! Keep safe.",
        suggestBreak: fatigueLevel !== 'low',
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --- LANGUAGE MANAGEMENT ----------------------------------------------------

  // Public: get active languages for Flutter apps
  app.get("/api/app/languages", async (req, res) => {
    try {
      const rows = await rawDb.execute(rawSql`
        SELECT id, code, name, native_name, flag, is_active, sort_order
        FROM app_languages ORDER BY sort_order ASC
      `);
      res.json(rows.rows);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin: list all languages
  app.get("/api/admin/languages", requireAdminAuth, async (req, res) => {
    try {
      const rows = await rawDb.execute(rawSql`
        SELECT id, code, name, native_name, flag, is_active, sort_order, created_at
        FROM app_languages ORDER BY sort_order ASC
      `);
      res.json(rows.rows);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin: add language
  app.post("/api/admin/languages", requireAdminRole(["superadmin"]), async (req, res) => {
    try {
      const { code, name, nativeName, flag, isActive, sortOrder } = req.body;
      if (!code || !name || !nativeName) {
        return res.status(400).json({ message: "code, name, nativeName are required" });
      }
      const result = await rawDb.execute(rawSql`
        INSERT INTO app_languages (code, name, native_name, flag, is_active, sort_order)
        VALUES (${code}, ${name}, ${nativeName}, ${flag || '??'}, ${isActive !== false}, ${sortOrder || 0})
        RETURNING *
      `);
      res.json(result.rows[0]);
    } catch (e: any) {
      if (e.message.includes('unique')) {
        res.status(400).json({ message: "Language code already exists" });
      } else {
        res.status(500).json({ message: safeErrMsg(e) });
      }
    }
  });

  // Admin: update language
  app.patch("/api/admin/languages/:id", requireAdminRole(["superadmin"]), async (req, res) => {
    try {
      const { id } = req.params;
      const { name, nativeName, flag, isActive, sortOrder } = req.body;
      await rawDb.execute(rawSql`
        UPDATE app_languages SET
          name = COALESCE(${name}, name),
          native_name = COALESCE(${nativeName}, native_name),
          flag = COALESCE(${flag}, flag),
          is_active = COALESCE(${isActive}, is_active),
          sort_order = COALESCE(${sortOrder}, sort_order)
        WHERE id = ${id}::uuid
      `);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin: delete language
  app.delete("/api/admin/languages/:id", requireAdminRole(["superadmin"]), async (req, res) => {
    try {
      const { id } = req.params;
      await rawDb.execute(rawSql`DELETE FROM app_languages WHERE id = ${id}::uuid`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- PLATFORM SERVICES � per-service activation + revenue model control ------
  // Admin: list all 9 configured services
  app.get("/api/platform-services", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM platform_services ORDER BY sort_order ASC`);
      res.json(r.rows);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin: toggle status / update revenue model + commission rate
  app.patch("/api/platform-services/:key", requireAdminAuth, requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const key = String(req.params.key || "");
      const { service_status, revenue_model, commission_rate } = req.body;
      const updates: string[] = ['updated_at=NOW()'];
      if (service_status !== undefined) updates.push(`service_status='${service_status === 'active' ? 'active' : 'inactive'}'`);
      if (revenue_model !== undefined && ['subscription', 'commission', 'hybrid'].includes(revenue_model)) {
        updates.push(`revenue_model='${revenue_model}'`);
      }
      if (commission_rate !== undefined) updates.push(`commission_rate=${parseFloat(commission_rate)}`);
      if (updates.length === 1) return res.status(400).json({ message: 'Nothing to update' });
      const r = await rawDb.execute(rawSql`
        UPDATE platform_services SET updated_at=NOW(),
          service_status = COALESCE(${service_status ?? null}, service_status),
          revenue_model  = COALESCE(${revenue_model ?? null}, revenue_model),
          commission_rate = COALESCE(${commission_rate != null ? parseFloat(commission_rate) : null}, commission_rate)
        WHERE service_key = ${key}
        RETURNING *
      `);
      if (!(r.rows as any[]).length) return res.status(404).json({ message: 'Service not found' });

      // Auto-sync vehicle_categories is_active when service is toggled
      if (service_status !== undefined) {
        const isActive = service_status === 'active';
        // Map service_key ? specific vehicle_type for per-vehicle control
        // Using vehicle_type (not type) so toggling one service doesn't affect others
        const vehicleTypeMap: Record<string, string> = {
          'bike_ride': 'bike',
          'bike_taxi': 'bike',
          'auto_ride': 'auto',
          'mini_car': 'mini_car',
          'sedan': 'sedan',
          'suv': 'suv',
          'city_pool': 'carpool',
          'intercity_pool': 'carpool',
          'outstation_pool': 'carpool',
        };
        const vcVehicleType = vehicleTypeMap[key];
        if (vcVehicleType) {
          await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active=${isActive} WHERE vehicle_type=${vcVehicleType}`).catch(dbCatch("db"));
        }
        // Parcel � all parcel vehicles share one service toggle
        if (key === 'parcel_delivery') {
          await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active=${isActive} WHERE type='parcel'`).catch(dbCatch("db"));
        }
        // Also sync business_settings legacy toggle
        const legacyKeyMap: Record<string, string> = {
          'bike_ride': 'ride', 'auto_ride': 'ride', 'mini_car': 'ride',
          'parcel_delivery': 'parcel', 'cargo_freight': 'cargo',
          'intercity': 'intercity', 'car_sharing': 'carsharing',
        };
        const legacyKey = legacyKeyMap[key];
        if (legacyKey) {
          await rawDb.execute(rawSql`
            INSERT INTO business_settings (key_name, value, settings_type)
            VALUES (${'service_' + legacyKey + '_enabled'}, ${isActive ? '1' : '0'}, 'service_settings')
            ON CONFLICT (key_name) DO UPDATE SET value=${isActive ? '1' : '0'}, updated_at=now()
          `).catch(dbCatch("db"));
        }
      }

      res.json((r.rows as any[])[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // App: get only active services (for customer app home screen)
  app.get("/api/app/platform-services", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT service_key, service_name, service_category, icon, color, description
        FROM platform_services
        WHERE service_status = 'active'
        ORDER BY sort_order ASC
      `);
      res.json({ services: r.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- MULTI-DROP PARCEL DELIVERY --------------------------------------------

  // Parcel migration: add gst_amt column if missing
  await rawDb.execute(rawSql`ALTER TABLE parcel_orders ADD COLUMN IF NOT EXISTS gst_amt NUMERIC(10,2) DEFAULT 0`).catch(dbCatch("db"));

  // Hardcoded defaults � fallback only when parcel_vehicle_types DB row not found
  const PARCEL_VEHICLES: Record<string, { baseFare: number; perKm: number; perKg: number; name: string; maxWeightKg: number; loadCharge: number }> = {
    bike_parcel: { baseFare: 40, perKm: 12, perKg: 4, name: 'Bike Parcel', maxWeightKg: 10, loadCharge: 0 },
    tata_ace: { baseFare: 150, perKm: 18, perKg: 2, name: 'Mini Truck', maxWeightKg: 500, loadCharge: 50 },
    pickup_truck: { baseFare: 200, perKm: 22, perKg: 1, name: 'Pickup Truck', maxWeightKg: 2000, loadCharge: 100 },
    auto_parcel: { baseFare: 50, perKm: 13, perKg: 7, name: 'Auto Parcel', maxWeightKg: 50, loadCharge: 0 },
    bolero_cargo: { baseFare: 200, perKm: 22, perKg: 3, name: 'Bolero Cargo', maxWeightKg: 1500, loadCharge: 80 },
    tempo_407: { baseFare: 800, perKm: 28, perKg: 1, name: 'Tempo 407', maxWeightKg: 2500, loadCharge: 150 },
  };

  // 60s in-memory caches for parcel pricing lookups — avoids hammering DB
  // on every quote/booking (parcel_vehicle_types + parcel_fares + platform_services
  // + zones.surge_factor are otherwise 4 queries per call).
  const ALLOWED_PARCEL_KEYS = new Set(Object.keys(PARCEL_VEHICLES));
  const PARCEL_KEY_ALIASES: Record<string, string> = {
    parcel_bike: "bike_parcel",
    bike_delivery: "bike_parcel",
    parcel_auto: "auto_parcel",
    auto_delivery: "auto_parcel",
    mini_truck: "tata_ace",
    tata_ace: "tata_ace",
    pickup_van: "pickup_truck",
    pickup_truck: "pickup_truck",
    bolero_pickup: "bolero_cargo",
    bolero_cargo: "bolero_cargo",
    tempo: "tempo_407",
    tempo_407: "tempo_407",
  };

  function normalizeParcelVehicleKey(input: unknown): string {
    const raw = String(input || "").trim().toLowerCase();
    if (!raw) return "";
    const direct = PARCEL_KEY_ALIASES[raw] || raw;
    if (ALLOWED_PARCEL_KEYS.has(direct)) return direct;
    if (raw.includes("bike") && raw.includes("parcel")) return "bike_parcel";
    if (raw.includes("auto") && raw.includes("parcel")) return "auto_parcel";
    if (raw.includes("tata") || raw.includes("ace") || raw.includes("mini truck")) return "tata_ace";
    if (raw.includes("bolero")) return "bolero_cargo";
    if (raw.includes("tempo") || raw.includes("407")) return "tempo_407";
    if (raw.includes("pickup")) return "pickup_truck";
    return direct;
  }

  function assertAllowedParcelVehicle(input: unknown): string {
    const key = normalizeParcelVehicleKey(input);
    if (!ALLOWED_PARCEL_KEYS.has(key)) {
      const err: any = new Error("Unsupported parcel vehicle category");
      err.statusCode = 400;
      err.code = "INVALID_PARCEL_VEHICLE";
      err.allowed = Array.from(ALLOWED_PARCEL_KEYS);
      throw err;
    }
    return key;
  }

  function parcelDriverToken(value: unknown): string {
    const v = String(value || "").trim().toLowerCase();
    if (!v) return "";
    if (v === "bike" || (v.includes("bike") && !v.includes("car"))) return "bike_parcel";
    if (v === "auto" || v.includes("auto")) return "auto_parcel";
    if (v.includes("tata") || v.includes("ace") || v.includes("mini truck")) return "tata_ace";
    if (v.includes("bolero")) return "bolero_cargo";
    if (v.includes("tempo") || v.includes("407")) return "tempo_407";
    if (v.includes("pickup")) return "pickup_truck";
    return normalizeParcelVehicleKey(v);
  }

  async function resolveVehicleCategoryIdForType(vehicleType?: string | null): Promise<string | null> {
    if (!vehicleType) return null;
    const key = normalizeParcelVehicleKey(vehicleType);
    const r = await rawDb.execute(rawSql`
      SELECT id FROM vehicle_categories
      WHERE LOWER(COALESCE(vehicle_type, '')) = LOWER(${key || vehicleType})
         OR LOWER(COALESCE(slug, '')) = LOWER(${key || vehicleType})
         OR LOWER(COALESCE(name, '')) = LOWER(${vehicleType})
      ORDER BY CASE WHEN LOWER(COALESCE(vehicle_type, '')) = LOWER(${key || vehicleType}) THEN 0 ELSE 1 END
      LIMIT 1
    `).catch(() => ({ rows: [] as any[] }));
    return (r.rows[0] as any)?.id ? String((r.rows[0] as any).id) : null;
  }

  async function isDriverEligibleForParcel(driverId: string, parcelVehicle: unknown): Promise<boolean> {
    const parcelKey = assertAllowedParcelVehicle(parcelVehicle);
    const r = await rawDb.execute(rawSql`
      SELECT
        u.id,
        u.current_trip_id,
        u.verification_status,
        dd.vehicle_type AS driver_vehicle_type,
        vc.vehicle_type AS category_vehicle_type,
        vc.name AS category_name,
        vc.slug AS category_slug,
        vc.service_type AS category_service_type
      FROM users u
      JOIN driver_details dd ON dd.user_id = u.id
      LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
      WHERE u.id = ${driverId}::uuid
        AND u.user_type = 'driver'
        AND ${activeDriverEligibilitySql("u")}
      LIMIT 1
    `).catch(() => ({ rows: [] as any[] }));
    const row = (r.rows as any[])[0];
    if (!row || row.current_trip_id) return false;
    const tokens = [
      parcelDriverToken(row.driver_vehicle_type),
      parcelDriverToken(row.category_vehicle_type),
      parcelDriverToken(row.category_name),
      parcelDriverToken(row.category_slug),
    ].filter(Boolean);
    return tokens.includes(parcelKey);
  }

  const PARCEL_CACHE_TTL_MS = 60_000;
  type CacheEntry<T> = { value: T; expiresAt: number };
  const parcelVehicleCache = new Map<string, CacheEntry<any>>();
  const parcelFareCache = new Map<string, CacheEntry<any>>();
  const parcelCommissionCache = new Map<string, CacheEntry<number>>();
  const zoneSurgeCache = new Map<string, CacheEntry<number>>();

  function cacheGet<T>(m: Map<string, CacheEntry<T>>, k: string): T | undefined {
    const e = m.get(k);
    if (e && e.expiresAt > Date.now()) return e.value;
    if (e) m.delete(k);
    return undefined;
  }
  function cacheSet<T>(m: Map<string, CacheEntry<T>>, k: string, v: T) {
    m.set(k, { value: v, expiresAt: Date.now() + PARCEL_CACHE_TTL_MS });
  }

  // Shared helper: resolves zone-aware parcel fare rates for a given vehicle + pickup location.
  // Priority: parcel_fares (zone match) ? parcel_fares (global latest) ? parcel_vehicle_types DB ? PARCEL_VEHICLES hardcoded
  async function resolveParcelFare(
    vehicleCategory: string,
    distKm: number,
    wt: number,
    pickupLat?: number | null,
    pickupLng?: number | null,
  ) {
    vehicleCategory = assertAllowedParcelVehicle(vehicleCategory);
    // 1. Vehicle row from DB (cached)
    let pv = cacheGet<any>(parcelVehicleCache, vehicleCategory);
    if (pv === undefined) {
      const pvRes = await rawDb.execute(rawSql`
        SELECT vehicle_key, name, max_weight_kg, base_fare, per_km, per_kg, load_charge, is_active
        FROM parcel_vehicle_types WHERE vehicle_key = ${vehicleCategory} LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      pv = pvRes.rows[0] || null;
      cacheSet(parcelVehicleCache, vehicleCategory, pv);
    }
    if (pv && pv.is_active === false) {
      const err: any = new Error(`${pv.name || vehicleCategory} is currently unavailable.`);
      err.statusCode = 503;
      err.code = "PARCEL_VEHICLE_INACTIVE";
      throw err;
    }
    const hc = PARCEL_VEHICLES[vehicleCategory];
    const vehicleName = pv?.name || hc.name;
    const maxWeightKg = safeFloat(pv?.max_weight_kg ?? hc.maxWeightKg, 10);
    const vcBaseFare = safeFloat(pv?.base_fare ?? hc.baseFare, 30);
    const vcPerKm = safeFloat(pv?.per_km ?? hc.perKm, 8);
    const vcPerKg = safeFloat(pv?.per_kg ?? hc.perKg, 5);
    const vcLoadCharge = safeFloat(pv?.load_charge ?? hc.loadCharge, 0);

    // 2. Zone-based parcel_fares override (cached by zoneId)
    let pfRow: any = {};
    let zoneId: string | null = null;
    if (pickupLat && pickupLng) {
      zoneId = await detectZoneId(pickupLat, pickupLng).catch(() => null);
      const fareCacheKey = `zone:${zoneId || 'global'}`;
      const cachedFare = cacheGet<any>(parcelFareCache, fareCacheKey);
      if (cachedFare !== undefined) {
        pfRow = cachedFare || {};
      } else {
        let pfRes = { rows: [] as any[] };
        if (zoneId) {
          pfRes = await rawDb.execute(rawSql`
            SELECT base_fare, fare_per_km, fare_per_kg, minimum_fare, loading_charge, helper_charge_per_hour, max_helpers
            FROM parcel_fares WHERE zone_id = ${zoneId}::uuid LIMIT 1
          `).catch(() => ({ rows: [] as any[] }));
        }
        if (!pfRes.rows.length) {
          pfRes = await rawDb.execute(rawSql`
            SELECT base_fare, fare_per_km, fare_per_kg, minimum_fare, loading_charge, helper_charge_per_hour, max_helpers
            FROM parcel_fares ORDER BY created_at DESC LIMIT 1
          `).catch(() => ({ rows: [] as any[] }));
        }
        const row = pfRes.rows[0] || null;
        cacheSet(parcelFareCache, fareCacheKey, row);
        if (row) pfRow = row;
      }
    }

    const baseFare = pfRow.base_fare != null ? safeFloat(pfRow.base_fare, vcBaseFare) : vcBaseFare;
    const perKm = pfRow.fare_per_km != null ? safeFloat(pfRow.fare_per_km, vcPerKm) : vcPerKm;
    const perKg = pfRow.fare_per_kg != null ? safeFloat(pfRow.fare_per_kg, vcPerKg) : vcPerKg;
    const loadCharge = pfRow.loading_charge != null ? safeFloat(pfRow.loading_charge, vcLoadCharge) : vcLoadCharge;
    const minFare = pfRow.minimum_fare != null ? safeFloat(pfRow.minimum_fare, 0) : 0;
    const helperRate = safeFloat(pfRow.helper_charge_per_hour, 0);
    const maxHelpers = parseInt(pfRow.max_helpers || '0') || 0;

    // 3. Configurable commission from platform_services (cached)
    let commPctNum = cacheGet<number>(parcelCommissionCache, 'parcel_delivery');
    if (commPctNum === undefined) {
      const platRes = await rawDb.execute(rawSql`
        SELECT commission_pct FROM platform_services WHERE service_key = 'parcel_delivery' LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      commPctNum = safeFloat((platRes.rows[0] as any)?.commission_pct, 15);
      cacheSet(parcelCommissionCache, 'parcel_delivery', commPctNum);
    }
    const commRate = commPctNum / 100;
    const gstRate = 0.05;

    // 4. Zone surge multiplier (cached, applies to base+distance+weight, not loadCharge/GST)
    let surgeMult = 1.0;
    if (zoneId) {
      const cachedSurge = cacheGet<number>(zoneSurgeCache, zoneId);
      if (cachedSurge !== undefined) {
        surgeMult = cachedSurge;
      } else {
        const sR = await rawDb.execute(rawSql`
          SELECT surge_factor FROM zones WHERE id=${zoneId}::uuid AND is_active=true LIMIT 1
        `).catch(() => ({ rows: [] as any[] }));
        surgeMult = safeFloat((sR.rows[0] as any)?.surge_factor, 1.0) || 1.0;
        if (surgeMult < 1) surgeMult = 1.0; // surge can never reduce fare
        cacheSet(zoneSurgeCache, zoneId, surgeMult);
      }
    }

    // 5. Fare calculation — Porter formula:
    //   fare = base + dist*per_km + wt*per_kg, then apply surge, then enforce min
    const distFareRaw = distKm * perKm;
    const weightFareRaw = wt * perKg;
    const surgedCore = (baseFare + distFareRaw + weightFareRaw) * surgeMult;
    const rawFare = surgedCore + loadCharge;
    const customerFare = Math.ceil(Math.max(rawFare, minFare));
    const gstAmt = Math.ceil(customerFare * gstRate);
    const grandTotal = customerFare + gstAmt;
    const commAmt = Math.ceil(customerFare * commRate);
    const driverEarnings = Math.max(0, customerFare - commAmt);

    console.log(
      `[PARCEL_FARE] vehicle=${vehicleCategory} zoneId=${zoneId || 'none'} ` +
      `dist=${distKm}km wt=${wt}kg base=${baseFare} perKm=${perKm} perKg=${perKg} ` +
      `surge=${surgeMult} minFare=${minFare} total=${grandTotal}`
    );

    return {
      vehicleName, maxWeightKg,
      baseFare, perKm, perKg, loadCharge, minFare, helperRate, maxHelpers,
      distFare: Math.ceil(distFareRaw * surgeMult),
      weightFare: Math.ceil(weightFareRaw * surgeMult),
      customerFare, gstAmt, grandTotal,
      commPct: commPctNum, commAmt, driverEarnings,
    };
  }

  // Customer: get fare quote for parcel � zone-aware, reads admin-configured rates
  app.post("/api/app/parcel/quote", authApp, async (req, res) => {
    try {
      const { vehicleCategory = 'bike_parcel', dropLocations = [], weightKg = 1,
        totalDistanceKm, pickupLat, pickupLng } = req.body;
      const parcelVehicleCategory = assertAllowedParcelVehicle(vehicleCategory);
      const wt = Math.max(0.1, safeFloat(weightKg, 1));
      const dist = Math.max(0.5, safeFloat(totalDistanceKm, 5));

      const f = await resolveParcelFare(
        parcelVehicleCategory, dist, wt,
        pickupLat ? parseFloat(pickupLat) : null,
        pickupLng ? parseFloat(pickupLng) : null,
      );

      // Weight limit check (after resolving vehicle)
      if (wt > f.maxWeightKg) {
        return res.status(400).json({
          message: `${f.vehicleName} supports max ${f.maxWeightKg} kg. Your package is ${wt} kg.`,
          code: 'WEIGHT_EXCEEDED', maxWeightKg: f.maxWeightKg,
        });
      }

      res.json({
        vehicleCategory: parcelVehicleCategory,
        vehicleName: f.vehicleName,
        maxWeightKg: f.maxWeightKg,
        baseFare: f.baseFare,
        distanceFare: f.distFare,
        weightFare: f.weightFare,
        loadingCharge: f.loadCharge,
        minimumFare: f.minFare,
        helperRatePerHour: f.helperRate,
        maxHelpers: f.maxHelpers,
        customerFare: f.customerFare,
        gstAmount: f.gstAmt,
        grandTotal: f.grandTotal,
        totalFare: f.grandTotal,          // backward compat alias
        commissionPct: f.commPct,
        commissionAmt: f.commAmt,
        driverEarnings: f.driverEarnings,
        dropCount: (dropLocations as any[]).length,
        breakdown: {
          baseFare: f.baseFare, distanceFare: f.distFare,
          weightFare: f.weightFare, loadingCharge: f.loadCharge,
          gstAmount: f.gstAmt, total: f.grandTotal,
        },
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Customer: book a multi-drop parcel order
  app.post("/api/app/parcel/book", authApp, async (req, res) => {
    try {
      const customerId = (req as any).currentUser?.id;

      // -- Service activation gate -------------------------------------------
      const parcelGate = await rawDb.execute(rawSql`
        SELECT service_status FROM platform_services WHERE service_key = 'parcel_delivery' LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      if (parcelGate.rows.length && (parcelGate.rows[0] as any).service_status !== 'active') {
        return res.status(503).json({ message: "Parcel Delivery service is currently unavailable.", code: "SERVICE_INACTIVE" });
      }

      const {
        vehicleCategory = 'bike_parcel',
        pickupAddress, pickupLat, pickupLng,
        pickupContactName, pickupContactPhone,
        dropLocations = [],
        totalDistanceKm = 5,
        weightKg = 1,
        paymentMethod = 'cash',
        notes = '',
        isB2b = false, b2bCompanyId,
        // New advanced fields
        lengthCm, widthCm, heightCm,
        declaredValue = 0, isFragile = false, insuranceEnabled = false,
        parcelDescription = '',
      } = req.body;
      const parcelVehicleCategory = assertAllowedParcelVehicle(vehicleCategory);
      if (!pickupAddress) return res.status(400).json({ message: 'pickupAddress required' });
      if (!(dropLocations as any[]).length) return res.status(400).json({ message: 'At least one drop location required' });

      // Prohibited items check
      if (parcelDescription) {
        const check = await validateProhibitedItems(parcelDescription);
        if (!check.allowed) {
          return res.status(400).json({
            message: `Prohibited items detected: ${check.matchedItems.join(", ")}. These items cannot be shipped.`,
            code: 'PROHIBITED_ITEMS',
            matchedItems: check.matchedItems,
          });
        }
      }

      const dist = safeFloat(totalDistanceKm, 5);

      // Calculate billable weight (actual vs volumetric)
      const dims = { lengthCm: safeFloat(lengthCm, 0), widthCm: safeFloat(widthCm, 0), heightCm: safeFloat(heightCm, 0), weightKg: safeFloat(weightKg, 1) };
      const weightInfo = calculateBillableWeight(dims);
      const wt = weightInfo.billableWeightKg;

      // Zone-aware fare resolution
      const f = await resolveParcelFare(
        parcelVehicleCategory, dist, wt,
        pickupLat ? parseFloat(pickupLat) : null,
        pickupLng ? parseFloat(pickupLng) : null,
      );

      // Enforce vehicle weight limit
      if (wt > f.maxWeightKg) {
        return res.status(400).json({ message: `${f.vehicleName} supports max ${f.maxWeightKg} kg. Your billable weight: ${wt} kg.`, code: 'WEIGHT_EXCEEDED' });
      }

      // Calculate insurance if requested
      let insurancePremium = 0;
      if (insuranceEnabled && declaredValue > 0) {
        const ins = await calculateInsurance(parseFloat(declaredValue), isFragile === true);
        insurancePremium = ins.premiumAmount;
      }

      const baseFare = f.baseFare;
      const distFare = f.distFare;
      const wFare = f.weightFare;
      const loadCharge = f.loadCharge;
      const gstAmt = f.gstAmt;
      const totalFare = f.grandTotal + insurancePremium;
      const commPct = f.commPct;
      const commAmt = f.commAmt;
      const pickupOtp = Math.floor(100000 + Math.random() * 900000).toString();
      const expectedMinutes = calculateExpectedDeliveryMinutes(parcelVehicleCategory, dist);

      // Check if customer already has an active/searching parcel order
      const activeParcel = await rawDb.execute(rawSql`
        SELECT id FROM parcel_orders
        WHERE customer_id=${customerId}::uuid
          AND current_status IN ('searching','driver_assigned','accepted','picked_up','in_transit')
        LIMIT 1
      `);
      if (activeParcel.rows.length) {
        return res.status(400).json({ message: "You already have an active parcel delivery in progress.", orderId: (activeParcel.rows[0] as any).id });
      }

      // Attach a 6-digit OTP to each drop location for delivery verification
      const dropsWithOtp = (dropLocations as any[]).map((d: any, i: number) => ({
        ...d,
        dropIndex: i,
        deliveryOtp: Math.floor(100000 + Math.random() * 900000).toString(),
        delivered_at: null,
      }));

      const r = await rawDb.execute(rawSql`
        INSERT INTO parcel_orders
          (customer_id, vehicle_category, pickup_address, pickup_lat, pickup_lng,
           pickup_contact_name, pickup_contact_phone, drop_locations,
           total_distance_km, weight_kg, base_fare, distance_fare, weight_fare,
           total_fare, commission_amt, commission_pct, gst_amt, current_status,
           pickup_otp, is_b2b, b2b_company_id, payment_method, notes,
           length_cm, width_cm, height_cm, volumetric_weight_kg, billable_weight_kg,
           declared_value, is_fragile, insurance_enabled, insurance_premium,
           parcel_description, expected_delivery_minutes, load_charge)
        VALUES
          (${customerId}::uuid, ${parcelVehicleCategory}, ${pickupAddress},
           ${pickupLat ?? null}, ${pickupLng ?? null},
           ${pickupContactName ?? ''}, ${pickupContactPhone ?? ''},
           ${JSON.stringify(dropsWithOtp)},
           ${dist}, ${wt}, ${baseFare}, ${distFare}, ${wFare},
           ${totalFare}, ${commAmt}, ${commPct}, ${gstAmt}, 'searching',
           ${pickupOtp}, ${isB2b ?? false}, ${b2bCompanyId ?? null},
           ${paymentMethod}, ${notes},
           ${dims.lengthCm || null}, ${dims.widthCm || null}, ${dims.heightCm || null},
           ${weightInfo.volumetricWeightKg || null}, ${weightInfo.billableWeightKg},
           ${parseFloat(declaredValue) || 0}, ${isFragile === true}, ${insuranceEnabled === true},
           ${insurancePremium}, ${parcelDescription || null}, ${expectedMinutes}, ${loadCharge})
        RETURNING *
      `);
      const order = (r.rows as any[])[0];

      // Porter-grade parcel dispatch: strict vehicle match + expanding radius
      // 5km → 10km → 15km. Stops at first radius that finds any eligible driver.
      if (io && pickupLat && pickupLng) {
        try {
          const PARCEL_DISPATCH_RADII = [5, 10, 15];
          let parcelDrivers: any[] = [];
          let finalRadiusUsed = PARCEL_DISPATCH_RADII[0];
          let lastExcludedSummary: Record<string, number> = {};
          let mappingRejected = false;

          for (const r of PARCEL_DISPATCH_RADII) {
            const match = await findParcelCapableDriversDetailed(
              Number(pickupLat), Number(pickupLng), r, parcelVehicleCategory, [], 10
            );
            finalRadiusUsed = r;
            lastExcludedSummary = match.excludedSummary;
            mappingRejected = match.rejected;
            if (match.rejected) break; // mapping missing — expanding radius won't help
            if (match.drivers.length) {
              parcelDrivers = match.drivers;
              break;
            }
          }

          if (!parcelDrivers.length) {
            console.warn(
              `[PARCEL_DISPATCH_FAIL] orderId=${order.id} parcelKey=${parcelVehicleCategory} ` +
              `radiusTried=${finalRadiusUsed}km mappingRejected=${mappingRejected} ` +
              `excludedSummary=${JSON.stringify(lastExcludedSummary)}`
            );
          } else {
            console.log(
              `[PARCEL_MATCH] orderId=${order.id} parcelKey=${parcelVehicleCategory} ` +
              `found=${parcelDrivers.length} radius=${finalRadiusUsed}km`
            );
          }

          const payload = {
            orderId: order.id,
            vehicleCategory: parcelVehicleCategory,
            pickupAddress,
            pickupLat, pickupLng,
            totalFare,
            dropCount: dropsWithOtp.length,
            weightKg: wt,
            isFragile: isFragile === true,
            insuranceEnabled: insuranceEnabled === true,
          };
          for (const driver of parcelDrivers) {
            io.to(`user:${driver.id}`).emit('parcel:new_request', payload);
            // FCM: wake driver if app is in background
            if (driver.fcm_token) {
              notifyDriverNewParcel({
                fcmToken: driver.fcm_token,
                pickupAddress: String(pickupAddress || ''),
                totalFare: Number(totalFare) || 0,
                orderId: order.id,
                vehicleCategory: parcelVehicleCategory,
              }).catch(dbCatch("db"));
            }
          }
        } catch (e: any) {
          console.error(`[PARCEL_DISPATCH_FAIL] orderId=${order.id} error=${e?.message || e}`);
        }
      }

      // Fire B2B webhook if applicable
      if (isB2b && b2bCompanyId) {
        fireB2BWebhook({
          eventType: "order_created",
          orderId: order.id,
          companyId: b2bCompanyId,
          timestamp: new Date().toISOString(),
          data: { vehicleCategory: parcelVehicleCategory, totalFare, drops: dropsWithOtp.length },
        }).catch(dbCatch("db"));
      }

      // Emit parcel lifecycle event
      emitParcelLifecycle(order.id, customerId, null, "new_order", {
        vehicleCategory: parcelVehicleCategory, totalFare, pickupAddress, drops: dropsWithOtp.length,
      });

      res.json({
        success: true,
        orderId: order.id,
        pickupOtp,
        totalFare,
        baseFare, distanceFare: distFare, weightFare: wFare,
        loadingCharge: loadCharge, gstAmount: gstAmt,
        commissionPct: commPct, commissionAmt: commAmt,
        driverEarnings: f.driverEarnings,
        drops: dropsWithOtp.length,
        weightInfo,
        insurancePremium: insurancePremium || 0,
        expectedDeliveryMinutes: expectedMinutes,
      });
    } catch (e: any) { res.status(e?.statusCode || 500).json({ message: safeErrMsg(e), code: e?.code, allowed: e?.allowed }); }
  });

  // Customer: get active/recent parcel orders
  app.get("/api/app/parcel/orders", authApp, async (req, res) => {
    try {
      const customerId = (req as any).currentUser?.id;
      const r = await rawDb.execute(rawSql`
        SELECT po.*, u.full_name as driver_name, u.phone as driver_phone
        FROM parcel_orders po
        LEFT JOIN users u ON u.id = po.driver_id
        WHERE po.customer_id = ${customerId}::uuid
        ORDER BY po.created_at DESC
        LIMIT 20
      `);
      res.json({ orders: r.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Customer: cancel parcel order
  app.post("/api/app/parcel/:id/cancel", authApp, async (req, res) => {
    try {
      const customerId = (req as any).currentUser?.id;
      const { reason = 'Customer cancelled' } = req.body;
      const r = await rawDb.execute(rawSql`
        UPDATE parcel_orders
        SET current_status='cancelled', cancelled_reason=${reason}, updated_at=NOW()
        WHERE id=${req.params.id}::uuid AND customer_id=${customerId}::uuid
          AND current_status IN ('pending','searching')
        RETURNING id, is_b2b, b2b_company_id, total_fare
      `);
      if (!(r.rows as any[]).length) return res.status(400).json({ message: 'Cannot cancel this order' });
      const cancelled = r.rows[0] as any;
      // B2B webhook: order_cancelled
      if (cancelled.is_b2b && cancelled.b2b_company_id) {
        // Refund fare back to company wallet on cancellation (order was never picked up)
        await rawDb.execute(rawSql`
          UPDATE b2b_companies
          SET wallet_balance = wallet_balance + ${parseFloat(cancelled.total_fare || '0')},
              total_trips = GREATEST(0, total_trips - 1),
              updated_at = NOW()
          WHERE id = ${cancelled.b2b_company_id}::uuid
        `).catch(dbCatch("db"));
        fireB2BWebhook({
          eventType: "order_cancelled",
          orderId: cancelled.id,
          companyId: cancelled.b2b_company_id,
          timestamp: new Date().toISOString(),
          data: { reason, refundedFare: parseFloat(cancelled.total_fare || '0') },
        }).catch(dbCatch("db"));
      }
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Driver: get pending parcel requests nearby
  app.get("/api/app/driver/parcel/pending", authApp, requireDriver, async (req, res) => {
    try {
      const driverId = (req as any).currentUser?.id;
      const r = await rawDb.execute(rawSql`
        SELECT * FROM parcel_orders
        WHERE current_status = 'searching'
        ORDER BY created_at ASC
        LIMIT 50
      `);
      const eligibleOrders: any[] = [];
      for (const order of r.rows as any[]) {
        if (await isDriverEligibleForParcel(driverId, order.vehicle_category)) {
          eligibleOrders.push(order);
        }
        if (eligibleOrders.length >= 20) break;
      }
      res.json({ orders: eligibleOrders });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Driver: accept a parcel order
  app.post("/api/app/driver/parcel/:id/accept", authApp, requireDriver, async (req, res) => {
    try {
      const driverId = (req as any).currentUser?.id;
      const existing = await rawDb.execute(rawSql`
        SELECT id, vehicle_category, current_status, driver_id
        FROM parcel_orders
        WHERE id=${req.params.id}::uuid
        LIMIT 1
      `);
      const existingOrder = (existing.rows as any[])[0];
      if (!existingOrder) return res.status(404).json({ message: 'Order not found' });
      if (existingOrder.current_status !== 'searching' || existingOrder.driver_id) {
        return res.status(409).json({ message: 'Already assigned' });
      }
      const eligible = await isDriverEligibleForParcel(driverId, existingOrder.vehicle_category);
      if (!eligible) {
        return res.status(403).json({ message: 'Driver is not eligible for this parcel vehicle category', code: 'PARCEL_DRIVER_NOT_ELIGIBLE' });
      }
      const r = await rawDb.execute(rawSql`
        UPDATE parcel_orders
        SET driver_id=${driverId}::uuid, current_status='driver_assigned', version=COALESCE(version, 0)+1, updated_at=NOW()
        WHERE id=${req.params.id}::uuid AND current_status='searching'
          AND driver_id IS NULL
        RETURNING *
      `);
      if (!(r.rows as any[]).length) return res.status(409).json({ message: 'Already assigned' });
      const order = (r.rows as any[])[0];
      const lockDriver = await rawDb.execute(rawSql`
        UPDATE users SET current_trip_id=${order.id}::uuid, updated_at=NOW()
        WHERE id=${driverId}::uuid AND current_trip_id IS NULL
        RETURNING id
      `).catch(dbCatch("db"));
      if (!(lockDriver as any)?.rows?.length) {
        await rawDb.execute(rawSql`
          UPDATE parcel_orders
          SET driver_id=NULL, current_status='searching', updated_at=NOW()
          WHERE id=${order.id}::uuid AND driver_id=${driverId}::uuid
        `).catch(dbCatch("db"));
        return res.status(409).json({ message: 'Driver already has an active trip' });
      }
      if (io) io.to(`user:${order.customer_id}`).emit('parcel:driver_assigned', { orderId: order.id, driverId });
      // B2B webhook: driver_assigned
      if (order.is_b2b && order.b2b_company_id) {
        const dNameR = await rawDb.execute(rawSql`SELECT full_name FROM users WHERE id=${driverId}::uuid`).catch(() => ({ rows: [] as any[] }));
        fireB2BWebhook({
          eventType: "driver_assigned",
          orderId: order.id,
          companyId: order.b2b_company_id,
          timestamp: new Date().toISOString(),
          data: { driverId, driverName: (dNameR.rows[0] as any)?.full_name || '' },
        }).catch(dbCatch("db"));
      }
      res.json({ success: true, order });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Driver: verify pickup OTP ? start delivery
  app.post("/api/app/driver/parcel/:id/pickup-otp", authApp, requireDriver, async (req, res) => {
    try {
      const driverId = (req as any).currentUser?.id;
      const { otp } = req.body;
      const r = await rawDb.execute(rawSql`
        SELECT id, pickup_otp, current_status, customer_id, driver_id, drop_locations, is_b2b, b2b_company_id
        FROM parcel_orders WHERE id=${req.params.id}::uuid
      `);
      const order = (r.rows as any[])[0];
      if (!order) return res.status(404).json({ message: 'Order not found' });
      if (String(order.driver_id || '') !== String(driverId || '')) return res.status(403).json({ message: 'This parcel is assigned to another driver' });
      if (order.current_status !== 'driver_assigned') return res.status(400).json({ message: 'Invalid order state' });
      if (String(order.pickup_otp) !== String(otp)) return res.status(400).json({ message: 'Invalid OTP' });
      await rawDb.execute(rawSql`
        UPDATE parcel_orders SET current_status='in_transit', version=COALESCE(version, 0)+1, updated_at=NOW() WHERE id=${req.params.id}::uuid
      `);

      // Get driver name for notifications
      const driverR = await rawDb.execute(rawSql`SELECT full_name FROM users WHERE id=${driverId}::uuid`);
      const driverName = (driverR.rows[0] as any)?.full_name || "JAGO Pro Pilot";

      // Emit lifecycle event
      emitParcelLifecycle(order.id, order.customer_id, driverId, "in_transit", { driverName });

      // Notify all receivers that parcel has been picked up
      const drops: any[] = typeof order.drop_locations === 'string' ? JSON.parse(order.drop_locations) : (order.drop_locations || []);
      notifyAllReceivers(order.id, drops, "pickup_started", driverName).catch(dbCatch("db"));

      // B2B webhook
      if (order.is_b2b && order.b2b_company_id) {
        fireB2BWebhook({
          eventType: "parcel_picked", orderId: order.id, companyId: order.b2b_company_id,
          timestamp: new Date().toISOString(), data: { driverName },
        }).catch(dbCatch("db"));
      }

      if (io) io.to(`user:${order.customer_id}`).emit('parcel:in_transit', { orderId: order.id });
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Driver: verify delivery OTP for a specific drop stop
  app.post("/api/app/driver/parcel/:id/drop-otp", authApp, requireDriver, async (req, res) => {
    try {
      const driverId = (req as any).currentUser?.id;
      const { dropIndex, otp } = req.body;
      const r = await rawDb.execute(rawSql`
        SELECT id, drop_locations, current_drop_index, current_status, customer_id, total_fare, driver_id, is_b2b, b2b_company_id
        FROM parcel_orders WHERE id=${req.params.id}::uuid
      `);
      const order = (r.rows as any[])[0];
      if (!order) return res.status(404).json({ message: 'Order not found' });
      if (String(order.driver_id || '') !== String(driverId || '')) return res.status(403).json({ message: 'This parcel is assigned to another driver' });
      if (order.current_status !== 'in_transit') return res.status(400).json({ message: 'Order not in transit' });
      const drops: any[] = typeof order.drop_locations === 'string'
        ? JSON.parse(order.drop_locations) : order.drop_locations;
      const idx = parseInt(dropIndex ?? order.current_drop_index);
      const drop = drops[idx];
      if (!drop) return res.status(404).json({ message: 'Drop stop not found' });
      if (String(drop.deliveryOtp) !== String(otp)) return res.status(400).json({ message: 'Invalid delivery OTP' });
      drops[idx].delivered_at = new Date().toISOString();
      const nextIdx = idx + 1;
      const allDelivered = nextIdx >= drops.length;

      // Check SLA breach
      const createdAt = order.created_at ? new Date(order.created_at).getTime() : Date.now();
      const elapsedMin = Math.round((Date.now() - createdAt) / 60000);
      const expectedMin = order.expected_delivery_minutes || 60;
      const slaBreached = elapsedMin > expectedMin + 15;

      await rawDb.execute(rawSql`
        UPDATE parcel_orders
        SET drop_locations = ${JSON.stringify(drops)},
            current_drop_index = ${nextIdx},
            current_status = ${allDelivered ? 'completed' : 'in_transit'},
            sla_breached = ${slaBreached},
            version = COALESCE(version, 0)+1,
            updated_at = NOW()
        WHERE id = ${req.params.id}::uuid
      `);

      // Notify the receiver that their parcel was delivered
      if (drop.receiverPhone) {
        notifyReceiver({
          receiverPhone: drop.receiverPhone,
          receiverName: drop.receiverName || "Customer",
          eventType: "delivered",
          orderId: order.id,
        }).catch(dbCatch("db"));
      }

      if (allDelivered) {
        // -- FULL REVENUE SETTLEMENT: commission% + GST + insurance ? admin --
        const totalFare = parseFloat(order.total_fare) || 0;
        const serviceType = order.is_b2b ? "b2b_parcel" : "parcel";
        const parcelBreakdown = await calculateRevenueBreakdown(totalFare, serviceType as any, order.driver_id);

        // Save revenue breakdown on the order
        await rawDb.execute(rawSql`
          UPDATE parcel_orders
          SET commission_amt = ${parcelBreakdown.total},
              gst_amount = ${parcelBreakdown.gst},
              insurance_amount = ${parcelBreakdown.insurance},
              driver_earnings = ${parcelBreakdown.driverEarnings},
              revenue_model = ${parcelBreakdown.model},
              revenue_breakdown = ${JSON.stringify(parcelBreakdown)}::jsonb
          WHERE id = ${req.params.id}::uuid
        `).catch(dbCatch("db"));

        // Settle: driver wallet + admin revenue + GST wallet + commission_settlements
        const payMethod = (order.payment_method || 'cash').toLowerCase();
        await settleRevenue({
          driverId: order.driver_id,
          tripId: order.id,
          fare: totalFare,
          paymentMethod: payMethod as any,
          breakdown: parcelBreakdown,
          serviceCategory: serviceType as any,
          serviceLabel: serviceType,
        });

        emitParcelLifecycle(order.id, order.customer_id, order.driver_id, "completed", {
          totalFare, breakdown: parcelBreakdown,
        });
        if (io) io.to(`user:${order.customer_id}`).emit('parcel:completed', { orderId: order.id });
        await rawDb.execute(rawSql`
          UPDATE users SET current_trip_id=NULL, updated_at=NOW()
          WHERE id=${order.driver_id}::uuid AND current_trip_id=${order.id}::uuid
        `).catch(dbCatch("db"));

        // B2B webhook
        if (order.is_b2b && order.b2b_company_id) {
          fireB2BWebhook({
            eventType: "parcel_delivered", orderId: order.id, companyId: order.b2b_company_id,
            timestamp: new Date().toISOString(), data: { totalFare: order.total_fare, slaBreached },
          }).catch(dbCatch("db"));
        }
      }
      res.json({ success: true, allDelivered, nextDrop: allDelivered ? null : drops[nextIdx], slaBreached });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- PARCEL: Multi-stop route optimization (nearest-neighbor) -------------
  // POST /api/app/parcel/optimize-route
  // Body: { pickupLat, pickupLng, stops: [{ address, lat, lng, ... }] }
  // Returns stops reordered by nearest-neighbor from pickup point
  app.post("/api/app/parcel/optimize-route", authApp, async (req, res) => {
    try {
      const { pickupLat, pickupLng, stops = [] } = req.body;
      if (!stops.length) return res.json({ stops: [] });

      const haversineKm2 = (lat1: number, lng1: number, lat2: number, lng2: number) => {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      // Nearest-neighbor greedy algorithm
      let currentLat = parseFloat(pickupLat) || 0;
      let currentLng = parseFloat(pickupLng) || 0;
      const remaining = [...stops];
      const ordered: any[] = [];
      let totalDistKm = 0;

      while (remaining.length) {
        let minDist = Infinity;
        let minIdx = 0;
        for (let i = 0; i < remaining.length; i++) {
          const d = haversineKm2(currentLat, currentLng, parseFloat(remaining[i].lat) || 0, parseFloat(remaining[i].lng) || 0);
          if (d < minDist) { minDist = d; minIdx = i; }
        }
        const next = remaining.splice(minIdx, 1)[0];
        totalDistKm += minDist;
        currentLat = parseFloat(next.lat) || currentLat;
        currentLng = parseFloat(next.lng) || currentLng;
        ordered.push({ ...next, stopSequence: ordered.length + 1, distFromPrevKm: parseFloat(minDist.toFixed(2)) });
      }

      res.json({ stops: ordered, totalDistKm: parseFloat(totalDistKm.toFixed(2)), optimized: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- PARCEL: Track order with all stop details -----------------------------
  app.get("/api/app/parcel/:id/track", authApp, async (req, res) => {
    try {
      const userId = (req as any).currentUser?.id;
      const r = await rawDb.execute(rawSql`
        SELECT po.*,
          cu.full_name as customer_name, cu.phone as customer_phone,
          dr.full_name as driver_name, dr.phone as driver_phone
        FROM parcel_orders po
        LEFT JOIN users cu ON cu.id = po.customer_id
        LEFT JOIN users dr ON dr.id = po.driver_id
        WHERE po.id = ${req.params.id}::uuid
          AND (po.customer_id = ${userId}::uuid OR po.driver_id = ${userId}::uuid)
        LIMIT 1
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Order not found" });
      const order = camelize(r.rows[0]) as any;

      // Parse drop_locations
      const drops: any[] = typeof order.dropLocations === 'string'
        ? JSON.parse(order.dropLocations) : (order.dropLocations || []);

      const currentIdx = parseInt(order.currentDropIndex ?? 0);
      const currentStop = drops[currentIdx] || null;
      const totalStops = drops.length;
      const completedStops = drops.filter((d: any) => d.delivered_at).length;

      res.json({
        order: {
          ...order,
          drops,
          progress: { currentStopIndex: currentIdx, currentStop, completedStops, totalStops },
          // Mask driver phone in transit (no direct contact number exposed)
          driverPhone: order.driverPhone ? order.driverPhone.replace(/(\d{2})\d{6}(\d{2})/, '$1XXXXXX$2') : null,
        }
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- PARCEL: Receipt after delivery ----------------------------------------
  app.get("/api/app/parcel/:id/receipt", authApp, async (req, res) => {
    try {
      const userId = (req as any).currentUser?.id;
      const r = await rawDb.execute(rawSql`
        SELECT po.*,
          cu.full_name as customer_name,
          dr.full_name as driver_name
        FROM parcel_orders po
        LEFT JOIN users cu ON cu.id = po.customer_id
        LEFT JOIN users dr ON dr.id = po.driver_id
        WHERE po.id = ${req.params.id}::uuid
          AND (po.customer_id = ${userId}::uuid OR po.driver_id = ${userId}::uuid)
          AND po.current_status = 'completed'
        LIMIT 1
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Parcel receipt not found" });
      const o = camelize(r.rows[0]) as any;
      const drops: any[] = typeof o.dropLocations === 'string' ? JSON.parse(o.dropLocations) : (o.dropLocations || []);
      const dateStr = new Date(o.updatedAt || o.createdAt).toISOString().slice(0, 10).replace(/-/g, '');
      const receiptNo = `PCL-${dateStr}-${(o.id || '').slice(0, 8).toUpperCase()}`;

      res.json({
        receipt: {
          receiptNo,
          orderId: o.id,
          status: 'completed',
          createdAt: o.createdAt,
          completedAt: o.updatedAt,
          customer: { name: o.customerName },
          driver: { name: o.driverName },
          pickup: { address: o.pickupAddress },
          stops: drops.map((d: any, i: number) => ({
            stopNo: i + 1,
            address: d.address || d.dropAddress,
            receiverName: d.receiverName,
            deliveredAt: d.delivered_at,
          })),
          fare: {
            baseFare: parseFloat(o.baseFare || 0),
            distanceFare: parseFloat(o.distanceFare || 0),
            weightFare: parseFloat(o.weightFare || 0),
            total: parseFloat(o.totalFare || 0),
            paymentMethod: o.paymentMethod || 'cash',
            currency: 'INR',
          },
          distanceKm: parseFloat(o.totalDistanceKm || 0),
          weightKg: parseFloat(o.weightKg || 0),
          vehicleCategory: o.vehicleCategory,
        }
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- B2B: Schema migration � add login columns -----------------------------
  await rawDb.execute(rawSql`ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS b2b_email VARCHAR(255)`).catch(dbCatch("db"));
  await rawDb.execute(rawSql`ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS b2b_password_hash VARCHAR(255)`).catch(dbCatch("db"));
  await rawDb.execute(rawSql`CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_companies_email ON b2b_companies(b2b_email) WHERE b2b_email IS NOT NULL`).catch(dbCatch("db"));

  // -- B2B: Login with company credentials (no app user session needed) ------
  app.post("/api/app/b2b/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ message: "email and password required" });
      const r = await rawDb.execute(rawSql`
        SELECT id, company_name, b2b_email, b2b_password_hash, status, is_active,
               wallet_balance, credit_limit, delivery_plan, commission_pct
        FROM b2b_companies WHERE b2b_email = ${email.trim().toLowerCase()} LIMIT 1
      `);
      if (!r.rows.length) return res.status(401).json({ message: "Invalid email or password" });
      const co = r.rows[0] as any;
      if (!co.b2b_password_hash) return res.status(401).json({ message: "Password not set. Please contact admin." });
      const valid = await verifyPassword(String(password), co.b2b_password_hash);
      if (!valid) return res.status(401).json({ message: "Invalid email or password" });
      if (!co.is_active) return res.status(403).json({ message: "B2B account is inactive. Contact admin." });
      // Return company info as session data (client stores it)
      res.json({ success: true, company: camelize(co) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- B2B: Set/change password (authenticated user who owns the company) -----
  app.post("/api/app/b2b/set-password", authApp, async (req, res) => {
    try {
      const userId = (req as any).currentUser?.id;
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ message: "email and password required" });
      if (password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
      const r = await rawDb.execute(rawSql`SELECT id FROM b2b_companies WHERE owner_id=${userId}::uuid LIMIT 1`);
      if (!r.rows.length) return res.status(404).json({ message: "No B2B company found for your account" });
      const hash = await hashPassword(String(password));
      await rawDb.execute(rawSql`
        UPDATE b2b_companies SET b2b_email=${email.trim().toLowerCase()}, b2b_password_hash=${hash}, updated_at=NOW()
        WHERE owner_id=${userId}::uuid
      `);
      res.json({ success: true, message: "B2B login credentials set successfully" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- B2B: Dashboard via B2B login (company ID from body) ------------------
  app.post("/api/app/b2b/dashboard-by-id", async (req, res) => {
    try {
      const { companyId } = req.body;
      if (!companyId) return res.status(400).json({ message: "companyId required" });
      const compR = await rawDb.execute(rawSql`SELECT * FROM b2b_companies WHERE id=${companyId}::uuid LIMIT 1`).catch(() => ({ rows: [] as any[] }));
      if (!compR.rows.length) return res.status(404).json({ message: "No B2B account found" });
      const company = camelize(compR.rows[0]) as any;
      const statsR = await rawDb.execute(rawSql`
        SELECT COUNT(*)::int as total_orders,
          COUNT(*) FILTER (WHERE current_status='completed')::int as completed,
          COUNT(*) FILTER (WHERE current_status='cancelled')::int as cancelled,
          COUNT(*) FILTER (WHERE current_status IN ('searching','driver_assigned','in_transit'))::int as active,
          COALESCE(SUM(total_fare) FILTER (WHERE current_status='completed'), 0) as total_spent
        FROM parcel_orders WHERE is_b2b=true AND b2b_company_id=${company.id}::uuid
      `).catch(() => ({ rows: [{}] as any[] }));
      const stats = camelize(statsR.rows[0]) as any;
      const recentR = await rawDb.execute(rawSql`
        SELECT po.id, po.pickup_address, po.current_status, po.total_fare, po.created_at,
          dr.full_name as driver_name
        FROM parcel_orders po LEFT JOIN users dr ON dr.id = po.driver_id
        WHERE po.is_b2b=true AND po.b2b_company_id=${company.id}::uuid
        ORDER BY po.created_at DESC LIMIT 10
      `).catch(() => ({ rows: [] as any[] }));
      res.json({
        company,
        stats: {
          totalOrders: parseInt(stats.totalOrders || 0),
          completedOrders: parseInt(stats.completed || 0),
          cancelledOrders: parseInt(stats.cancelled || 0),
          activeOrders: parseInt(stats.active || 0),
          totalSpent: parseFloat(stats.totalSpent || 0),
        },
        recentOrders: camelize(recentR.rows),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- B2B: Company registration (app users) --------------------------------
  app.post("/api/app/b2b/register", authApp, async (req, res) => {
    try {
      const userId = (req as any).currentUser?.id;
      const { companyName, gstNumber, address, contactName, contactPhone, deliveryPlan = 'pay_per_delivery', email, password } = req.body;
      if (!companyName) return res.status(400).json({ message: "companyName required" });

      // Check if this user already has a B2B company
      const existing = await rawDb.execute(rawSql`
        SELECT id FROM b2b_companies WHERE owner_id=${userId}::uuid LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));

      const pwHash = password ? await hashPassword(String(password)) : null;

      if (existing.rows.length) {
        await rawDb.execute(rawSql`
          UPDATE b2b_companies
          SET company_name=${companyName}, gst_number=${gstNumber || null},
              address=${address || null}, contact_name=${contactName || null},
              contact_phone=${contactPhone || null}, delivery_plan=${deliveryPlan},
              ${email ? rawSql`b2b_email=${email.trim().toLowerCase()},` : rawSql``}
              ${pwHash ? rawSql`b2b_password_hash=${pwHash},` : rawSql``}
              updated_at=NOW()
          WHERE owner_id=${userId}::uuid
        `);
        return res.json({ success: true, message: "B2B profile updated", companyId: (existing.rows[0] as any).id });
      }

      const ins = await rawDb.execute(rawSql`
        INSERT INTO b2b_companies
          (owner_id, company_name, gst_number, address, contact_name, contact_phone, delivery_plan, status, is_active,
           b2b_email, b2b_password_hash)
        VALUES
          (${userId}::uuid, ${companyName}, ${gstNumber || null}, ${address || null},
           ${contactName || null}, ${contactPhone || null}, ${deliveryPlan}, 'pending', true,
           ${email ? email.trim().toLowerCase() : null}, ${pwHash})
        RETURNING id
      `);
      res.json({ success: true, message: "B2B company registered � pending admin approval", companyId: (ins.rows[0] as any).id });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- B2B: Get delivery stats + order history -------------------------------
  app.get("/api/app/b2b/dashboard", authApp, async (req, res) => {
    try {
      const userId = (req as any).currentUser?.id;
      const compR = await rawDb.execute(rawSql`
        SELECT * FROM b2b_companies WHERE owner_id=${userId}::uuid LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      if (!compR.rows.length) return res.status(404).json({ message: "No B2B account found" });
      const company = camelize(compR.rows[0]) as any;

      const statsR = await rawDb.execute(rawSql`
        SELECT
          COUNT(*)::int as total_orders,
          COUNT(*) FILTER (WHERE current_status='completed')::int as completed,
          COUNT(*) FILTER (WHERE current_status='cancelled')::int as cancelled,
          COUNT(*) FILTER (WHERE current_status IN ('searching','driver_assigned','in_transit'))::int as active,
          COALESCE(SUM(total_fare) FILTER (WHERE current_status='completed'), 0) as total_spent
        FROM parcel_orders WHERE is_b2b=true AND b2b_company_id=${company.id}::uuid
      `).catch(() => ({ rows: [{}] as any[] }));
      const stats = camelize(statsR.rows[0]) as any;

      const recentR = await rawDb.execute(rawSql`
        SELECT po.id, po.pickup_address, po.current_status, po.total_fare, po.created_at,
          dr.full_name as driver_name
        FROM parcel_orders po
        LEFT JOIN users dr ON dr.id = po.driver_id
        WHERE po.is_b2b=true AND po.b2b_company_id=${company.id}::uuid
        ORDER BY po.created_at DESC LIMIT 10
      `).catch(() => ({ rows: [] as any[] }));

      res.json({
        company,
        stats: {
          totalOrders: parseInt(stats.totalOrders || 0),
          completedOrders: parseInt(stats.completed || 0),
          cancelledOrders: parseInt(stats.cancelled || 0),
          activeOrders: parseInt(stats.active || 0),
          totalSpent: parseFloat(stats.totalSpent || 0),
        },
        recentOrders: camelize(recentR.rows),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin: list all parcel orders with filters
  app.get("/api/admin/parcel-orders", async (req, res) => {
    try {
      const { status, b2b, limit = 100, offset = 0 } = req.query;
      const rows = await rawDb.execute(rawSql`
        SELECT po.*,
          cu.full_name as customer_name, cu.phone as customer_phone,
          dr.full_name as driver_name,   dr.phone as driver_phone
        FROM parcel_orders po
        LEFT JOIN users cu ON cu.id = po.customer_id
        LEFT JOIN users dr ON dr.id = po.driver_id
        ${status ? rawSql`WHERE po.current_status = ${status}` : rawSql`WHERE TRUE`}
        ${b2b === 'true' ? rawSql`AND po.is_b2b = true` : rawSql``}
        ORDER BY po.created_at DESC
        LIMIT ${parseInt(limit as string)} OFFSET ${parseInt(offset as string)}
      `);
      res.json({ orders: rows.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin: get single parcel order detail
  app.get("/api/admin/parcel-orders/:id", async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT po.*, cu.full_name as customer_name, cu.phone as customer_phone,
               dr.full_name as driver_name, dr.phone as driver_phone
        FROM parcel_orders po
        LEFT JOIN users cu ON cu.id = po.customer_id
        LEFT JOIN users dr ON dr.id = po.driver_id
        WHERE po.id = ${req.params.id}::uuid
      `);
      if (!(r.rows as any[]).length) return res.status(404).json({ message: 'Not found' });
      res.json((r.rows as any[])[0]);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // B2B: bulk delivery � create multiple parcel orders for a business
  app.post("/api/b2b/:companyId/bulk-delivery", requireAdminAuth, async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      const { customerId, vehicleCategory = 'bike_parcel', pickupAddress, pickupLat, pickupLng,
        pickupContactName, pickupContactPhone, deliveries = [], weightKg = 1, notes = '' } = req.body;
      const parcelVehicleCategory = assertAllowedParcelVehicle(vehicleCategory);
      if (!pickupAddress) return res.status(400).json({ message: 'pickupAddress required' });
      if (!(deliveries as any[]).length) return res.status(400).json({ message: 'deliveries array required' });

      // Verify company exists and is active
      const compR = await rawDb.execute(rawSql`
        SELECT id, wallet_balance, credit_limit, status FROM b2b_companies WHERE id=${companyId}::uuid LIMIT 1
      `);
      if (!compR.rows.length) return res.status(404).json({ message: 'B2B company not found' });
      const company = compR.rows[0] as any;
      if (company.status === 'suspended') return res.status(403).json({ message: 'Company account is suspended' });

      const vc = PARCEL_VEHICLES[parcelVehicleCategory];
      const wt = safeFloat(weightKg, 1);

      // Pre-calculate total cost to validate wallet balance
      let grandTotal = 0;
      const deliveryList = deliveries as any[];
      for (const delivery of deliveryList) {
        const dist = parseFloat(delivery.distanceKm ?? '5') || 5;
        grandTotal += (vc.baseFare + Math.round(dist * vc.perKm) + Math.round(wt * vc.perKg));
      }

      const walletBal = parseFloat(company.wallet_balance || '0');
      const creditLimit = parseFloat(company.credit_limit || '0');
      const available = walletBal + creditLimit;
      if (available < grandTotal) {
        return res.status(402).json({
          message: `Insufficient balance. Required: ?${grandTotal}, Available: ?${available.toFixed(2)} (wallet: ?${walletBal.toFixed(2)} + credit: ?${creditLimit.toFixed(2)})`
        });
      }

      // Atomic wallet deduction for the full batch
      const deductR = await rawDb.execute(rawSql`
        UPDATE b2b_companies
        SET wallet_balance = wallet_balance - ${grandTotal},
            total_trips    = total_trips + ${deliveryList.length},
            updated_at     = NOW()
        WHERE id=${companyId}::uuid
          AND (wallet_balance + credit_limit) >= ${grandTotal}
        RETURNING wallet_balance
      `);
      if (!deductR.rows.length) {
        return res.status(402).json({ message: 'Wallet deduction failed � balance may have changed. Please retry.' });
      }

      const results: any[] = [];
      for (const delivery of deliveryList) {
        const dist = parseFloat(delivery.distanceKm ?? '5') || 5;
        const baseFare = vc.baseFare;
        const distF = Math.round(dist * vc.perKm);
        const wtF = Math.round(wt * vc.perKg);
        const total = baseFare + distF + wtF;
        const commAmt = Math.round(total * 0.15);
        const pickupOtp = Math.floor(100000 + Math.random() * 900000).toString();
        const drops = [{
          address: delivery.dropAddress,
          lat: delivery.dropLat,
          lng: delivery.dropLng,
          receiverName: delivery.receiverName ?? '',
          receiverPhone: delivery.receiverPhone ?? '',
          dropIndex: 0,
          deliveryOtp: Math.floor(100000 + Math.random() * 900000).toString(),
          delivered_at: null,
        }];
        const r = await rawDb.execute(rawSql`
          INSERT INTO parcel_orders
            (customer_id, vehicle_category, pickup_address, pickup_lat, pickup_lng,
             pickup_contact_name, pickup_contact_phone, drop_locations,
             total_distance_km, weight_kg, base_fare, distance_fare, weight_fare,
             total_fare, commission_amt, commission_pct, current_status,
             pickup_otp, payment_method, is_b2b, b2b_company_id, notes)
          VALUES
            (${customerId ?? null}, ${parcelVehicleCategory}, ${pickupAddress},
             ${pickupLat ?? null}, ${pickupLng ?? null},
             ${pickupContactName ?? ''}, ${pickupContactPhone ?? ''},
             ${JSON.stringify(drops)},
             ${dist}, ${wt}, ${baseFare}, ${distF}, ${wtF},
             ${total}, ${commAmt}, 15, 'searching',
             ${pickupOtp}, 'b2b_wallet', true, ${companyId}::uuid, ${notes})
          RETURNING id, total_fare
        `);
        results.push((r.rows as any[])[0]);
        // Fire webhook per order (non-blocking)
        fireB2BWebhook({
          eventType: "order_created",
          orderId: (r.rows[0] as any).id,
          companyId,
          timestamp: new Date().toISOString(),
          data: { vehicleCategory, totalFare: total, bulkBatch: true },
        }).catch(dbCatch("db"));
      }

      const newBalance = parseFloat((deductR.rows[0] as any).wallet_balance || '0');
      res.json({ success: true, ordersCreated: results.length, orders: results, remainingBalance: newBalance });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- SERVICES MANAGEMENT ---------------------------------------------------
  // Service definitions (hardcoded business models)
  const SERVICE_DEFS = [
    { key: 'ride', name: 'Normal Ride', description: 'Bike, Auto, Car, SUV rides', icon: '??', emoji: '??', color: '#1E6DE5' },
    { key: 'parcel', name: 'Parcel Delivery', description: 'Send packages with bike or auto', icon: '??', emoji: '??', color: '#F59E0B' },
    { key: 'cargo', name: 'Cargo & Freight', description: 'Large goods with truck or van', icon: '??', emoji: '??', color: '#10B981' },
    { key: 'intercity', name: 'Intercity', description: 'Travel between cities', icon: '???', emoji: '???', color: '#8B5CF6' },
    { key: 'carsharing', name: 'Car Sharing', description: 'Share rides with others', icon: '??', emoji: '??', color: '#EF4444' },
  ];

  // Admin: Get all services with toggle state
  app.get("/api/services", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT key_name, value FROM business_settings WHERE settings_type='service_settings'`);
      const map: Record<string, string> = {};
      (r.rows as any[]).forEach(row => { map[row.key_name] = row.value; });
      const services = SERVICE_DEFS.map(s => ({
        ...s,
        isActive: map[`service_${s.key}_enabled`] !== '0',
      }));
      res.json(services);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Admin: Toggle service on/off (syncs all layers)
  app.patch("/api/services/:key", async (req, res) => {
    try {
      const { key } = req.params;
      const { isActive } = req.body;
      if (!SERVICE_DEFS.find(s => s.key === key)) return res.status(404).json({ message: 'Service not found' });
      await rawDb.execute(rawSql`
        INSERT INTO business_settings (key_name, value, settings_type)
        VALUES (${'service_' + key + '_enabled'}, ${isActive ? '1' : '0'}, 'service_settings')
        ON CONFLICT (key_name) DO UPDATE SET value=${isActive ? '1' : '0'}, updated_at=now()
      `);
      // Sync vehicle_categories is_active
      await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active=${!!isActive} WHERE type=${key}`).catch(dbCatch("db"));
      // Sync platform_services service_status
      const statusVal = isActive ? 'active' : 'inactive';
      const platformKeyMap: Record<string, string[]> = {
        'ride': ['bike_ride', 'auto_ride', 'mini_car', 'sedan_ride', 'suv_ride'],
        'parcel': ['parcel_delivery'],
        'cargo': ['cargo_freight'],
        'intercity': ['intercity'],
        'carsharing': ['car_sharing', 'carpool'],
      };
      const platformKeys = platformKeyMap[key] || [];
      for (const pk of platformKeys) {
        await rawDb.execute(rawSql`UPDATE platform_services SET service_status=${statusVal}, updated_at=NOW() WHERE service_key=${pk}`).catch(dbCatch("db"));
      }
      res.json({ success: true, key, isActive });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // App: Get only ACTIVE services for customer app (respects admin toggles)
  app.get("/api/app/services", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT key_name, value FROM business_settings WHERE settings_type='service_settings'`);
      const map: Record<string, string> = {};
      (r.rows as any[]).forEach(row => { map[row.key_name] = row.value; });
      const services = SERVICE_DEFS
        .filter(s => map[`service_${s.key}_enabled`] !== '0')
        .map(s => ({
          key: s.key,
          name: s.name,
          description: s.description,
          icon: s.icon,
          emoji: s.emoji,
          color: s.color,
          isActive: true,
        }));
      res.json({ services });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // App: Get only ACTIVE services from platform_services (Phase-based rollout)
  app.get("/api/app/services/active", async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT service_key as key, service_name as name, icon, color, description, sort_order
        FROM platform_services
        WHERE service_status = 'active'
        ORDER BY sort_order ASC
      `);
      const services = (r.rows as any[]).map(row => ({
        key: row.key,
        name: row.name,
        icon: row.icon || '??',
        color: row.color || '#2F80ED',
        description: row.description || '',
      }));
      res.json({ services });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Also seed default vehicle_category is_active based on service toggle
  app.patch("/api/services/:key/vehicles", async (req, res) => {
    try {
      const { key } = req.params;
      const { isActive } = req.body;
      await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active=${isActive} WHERE type=${key}`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Stale searching trip auto-cancel: expire after 12 minutes -----------
  // Safety net for trips not managed by dispatch engine (e.g., older trips, edge cases)
  setInterval(async () => {
    try {
      const stale = await rawDb.execute(rawSql`
        UPDATE trip_requests
        SET current_status='cancelled', cancel_reason='No driver found within 12 minutes', updated_at=NOW()
        WHERE current_status='searching'
          AND driver_id IS NULL
          AND created_at < NOW() - INTERVAL '12 minutes'
        RETURNING id, customer_id
      `);
      for (const row of stale.rows) {
        const r = row as any;
        // Clean up dispatch session if still active
        cancelDispatch(r.id);
        if (io && r.customer_id) {
          io.to(`user:${r.customer_id}`).emit("trip:cancelled", {
            tripId: r.id,
            reason: "No driver available nearby. Please try again.",
          });
        }
        await appendTripStatus(r.id, 'cancelled', 'system', 'Auto-cancelled: no driver in 12 minutes').catch(dbCatch("db"));
      }
      if (stale.rows.length) console.log(`[EXPIRE] Auto-cancelled ${stale.rows.length} stale searching trip(s)`);
    } catch (e: any) {
      console.error("[EXPIRE] Stale trip cleanup error:", formatDbError(e));
    }
  }, 60000); // runs every 60 seconds

  // -- Driver request timeout: safety-net auto-reassign after 90 seconds ---
  // The dispatch engine handles its own timeouts (8s per driver).
  // This interval is a safety net for trips that somehow bypass the dispatch engine.
  setInterval(async () => {
    try {
      const timedOut = await rawDb.execute(rawSql`
         SELECT t.id, t.pickup_lat, t.pickup_lng, t.pickup_address, t.estimated_fare,
           t.vehicle_category_id, t.driver_id, t.rejected_driver_ids
        FROM trip_requests t
        WHERE t.current_status = 'driver_assigned'
           AND t.driver_id IS NOT NULL
          AND t.updated_at < NOW() - INTERVAL '90 seconds'
      `);

      for (const row of timedOut.rows) {
        const trip = camelize(row) as any;
        if (!trip.driverId) continue;

        // Skip if dispatch engine is actively managing this trip
        if (hasActiveDispatch(trip.id)) continue;

        await rawDb.execute(rawSql`
          UPDATE trip_requests
          SET current_status='searching', driver_id=NULL,
              rejected_driver_ids = array_append(COALESCE(rejected_driver_ids,'{}'), ${trip.driverId}::uuid),
              updated_at=NOW()
          WHERE id=${trip.id}::uuid AND current_status='driver_assigned'
        `);

        if (io) io.to(`user:${trip.driverId}`).emit("trip:timeout", { tripId: trip.id });

        const excludeList = [...(trip.rejectedDriverIds || []), trip.driverId].filter(Boolean);
        const nextBest = await findBestDrivers(
          trip.pickupLat, trip.pickupLng,
          trip.vehicleCategoryId || undefined,
          excludeList, 1
        );

        if (nextBest.length && io) {
          const nd = nextBest[0];
          io.to(`user:${nd.driverId}`).emit("trip:new_request", { tripId: trip.id, pickupAddress: trip.pickupAddress || "Pickup", estimatedFare: trip.estimatedFare || 0 });
          if (nd.fcmToken) {
            notifyDriverNewRide({ fcmToken: nd.fcmToken, driverName: nd.fullName, customerName: "", pickupAddress: trip.pickupAddress || "Pickup", estimatedFare: trip.estimatedFare || 0, tripId: trip.id }).catch(dbCatch("db"));
          }
          console.log(`[TIMEOUT] Trip ${trip.id} safety-net reassigned to driver ${nd.driverId}`);
        } else if (io) {
          notifyNearbyDriversNewTrip(trip.id, trip.pickupLat, trip.pickupLng, trip.vehicleCategoryId, excludeList).catch(dbCatch("db"));
        }
      }
    } catch (e: any) {
      console.error("[TIMEOUT] Auto-reassign error:", formatDbError(e));
    }
  }, 30000);

  // -- Start dispatch engine background processes --------------------------
  startScheduledRideDispatcher();
  startDispatchCleanup();
  console.log("[DISPATCH] Smart dispatch engine initialized");

  // -- Initialize Intelligence, Maps Cache, and Retention systems ----------
  initIntelligenceTables().then(() => {
    startIntelligenceJobs();
    console.log("[INTELLIGENCE] Heatmap + Surge + Behavior + Fraud + Rebalancing ready");
  }).catch((e: any) => console.error("[INTELLIGENCE] Init error:", e.message));

  initMapsCacheTables().then(() => {
    startCacheCleanup();
    console.log("[MAPS-CACHE] Google Maps cache layer ready");
  }).catch((e: any) => console.error("[MAPS-CACHE] Init error:", e.message));

  initRetentionTables().then(() => {
    startRetentionCampaignJob();
    console.log("[RETENTION] Customer retention system ready");
  }).catch((e: any) => console.error("[RETENTION] Init error:", e.message));

  initParcelAdvancedTables().then(() => {
    console.log("[PARCEL-ADV] Advanced parcel system ready (dimensions, insurance, SLA, POD, B2B webhooks)");
  }).catch((e: any) => console.error("[PARCEL-ADV] Init error:", e.message));

  initRevenueEngineTables().then(() => {
    console.log("[REVENUE] Unified revenue engine ready (commission + GST + insurance ? admin)");
  }).catch((e: any) => console.error("[REVENUE] Init error:", e.message));

  initDynamicServicesTables().then(() => {
    console.log("[DYNAMIC-SERVICES] City-based services + parcel vehicle types ready");
  }).catch((e: any) => console.error("[DYNAMIC-SERVICES] Init error:", e.message));

  if (AI_MOBILITY_BRAIN_ENABLED) {
    startAIMobilityBrain();
    console.log("[AI-BRAIN] Mobility brain started (10s tick)");
  } else {
    console.log("[AI-BRAIN] Disabled by feature flag; removed from startup path.");
  }

  // -- Driver arrival timeout: notify if driver stays 'accepted' > 15 minutes --
  // Prevents customers from waiting indefinitely after driver accepted but never arrived.
  setInterval(async () => {
    try {
      const stale = await rawDb.execute(rawSql`
        SELECT t.id, t.customer_id, t.driver_id, t.pickup_address, t.driver_accepted_at
        FROM trip_requests t
        WHERE t.current_status = 'accepted'
          AND t.driver_accepted_at IS NOT NULL
          AND t.driver_accepted_at < NOW() - INTERVAL '15 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM trip_status l
            WHERE l.trip_id = t.id AND l.status = 'arrival_delayed'
          )
      `);
      for (const row of stale.rows) {
        const r = row as any;
        // Emit notification to customer and driver
        if (io) {
          io.to(`user:${r.customer_id}`).emit("trip:status_update", {
            tripId: r.id, status: "arrival_delayed",
            message: "Your driver is taking longer than expected. Please wait or cancel.",
          });
          if (r.driver_id) {
            io.to(`user:${r.driver_id}`).emit("trip:status_update", {
              tripId: r.id, status: "arrival_delayed",
              message: "Customer is waiting. Please arrive at pickup soon.",
            });
          }
        }
        // Log so we don't spam notifications
        await rawDb.execute(rawSql`
          INSERT INTO trip_status (trip_id, status, source, note)
          VALUES (${r.id}::uuid, 'arrival_delayed', 'system', 'Driver accepted >15 min ago, not yet arrived')
        `).catch(dbCatch("db"));
        console.log(`[ARRIVAL-TIMEOUT] Trip ${r.id} � driver accepted 15+ min ago, notified parties`);
      }
    } catch (e: any) {
      console.error("[ARRIVAL-TIMEOUT] Error:", (e as any).message);
    }
  }, 2 * 60 * 1000); // check every 2 minutes

  // -- Dispatch: Get status of an active dispatch (admin/debug) ----------
  app.get("/api/app/dispatch/status/:tripId", authApp, async (req, res) => {
    try {
      const tripId = String(req.params.tripId);
      const status = getDispatchStatus(tripId);
      if (!status) return res.status(404).json({ message: "No active dispatch for this trip" });
      res.json(status);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Dispatch: Get count of active dispatches (admin monitoring) -------
  app.get("/api/app/dispatch/active-count", async (_req, res) => {
    res.json({ activeDispatches: getActiveDispatchCount() });
  });

  // --------------------------------------------------------------------------
  //  AI INTELLIGENCE LAYER � ENDPOINTS
  // --------------------------------------------------------------------------

  // Initialize AI tables on startup
  initAiTables().then(() => {
    console.log("[AI] Intelligence layer ready");
    refreshAllDriverStats().catch(dbCatch("db"));
  });

  // -- AI: Smart Suggestions for customer ---------------------------------
  app.get("/api/app/ai/suggestions", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const hour = req.query.hour ? Number(req.query.hour) : undefined;
      const suggestions = await getSmartSuggestions(user.id, hour);
      res.json({ suggestions });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- AI: Driver Matching (explicit endpoint for testing/admin) ---------
  app.post("/api/app/ai/driver-match", authApp, async (req, res) => {
    try {
      const { pickupLat, pickupLng, vehicleCategoryId, excludeDriverIds = [], limit = 5 } = req.body;
      if (!pickupLat || !pickupLng) return res.status(400).json({ message: "pickupLat and pickupLng required" });
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const safeExclude = Array.isArray(excludeDriverIds)
        ? excludeDriverIds.filter((id: string) => typeof id === 'string' && uuidRe.test(id))
        : [];
      if (vehicleCategoryId && !uuidRe.test(vehicleCategoryId)) {
        return res.status(400).json({ message: "Invalid vehicleCategoryId" });
      }
      const drivers = await findBestDrivers(
        Number(pickupLat), Number(pickupLng),
        vehicleCategoryId || undefined,
        safeExclude,
        Math.min(Number(limit) || 5, 20)
      );
      res.json({ drivers, count: drivers.length });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- AI: Demand Heatmap for drivers ------------------------------------
  app.get("/api/app/ai/demand-heatmap", async (_req, res) => {
    try {
      const zones = await getDemandHeatmap();
      res.json({ zones, generatedAt: new Date().toISOString() });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- AI: Safety Alerts (list active/unresolved) ------------------------
  app.get("/api/app/ai/safety-alerts", authApp, async (req, res) => {
    try {
      const { tripId, resolved = "false" } = req.query;
      const isResolved = resolved === "true";
      let alerts;
      if (tripId) {
        alerts = await rawDb.execute(rawSql`
          SELECT * FROM ai_safety_alerts
          WHERE trip_id = ${tripId as string}::uuid
          ORDER BY created_at DESC LIMIT 50
        `);
      } else {
        alerts = await rawDb.execute(rawSql`
          SELECT * FROM ai_safety_alerts
          WHERE resolved = ${isResolved}
          ORDER BY created_at DESC LIMIT 100
        `);
      }
      res.json({ alerts: alerts.rows.map(camelize) });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- AI: Acknowledge/resolve a safety alert ----------------------------
  app.patch("/api/app/ai/safety-alerts/:alertId", authApp, async (req, res) => {
    try {
      const alertIdParam = req.params.alertId;
      const alertId = Array.isArray(alertIdParam) ? alertIdParam[0] : alertIdParam;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRe.test(alertId)) return res.status(400).json({ message: "Invalid alert ID" });
      const acknowledged = req.body.acknowledged === true;
      const resolved = req.body.resolved === true;
      await rawDb.execute(rawSql`
        UPDATE ai_safety_alerts
        SET acknowledged = ${acknowledged}, resolved = ${resolved}
        WHERE id = ${alertId}::uuid
      `);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- AI: SOS Emergency Trigger -----------------------------------------
  app.post("/api/app/ai/sos", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { tripId, lat, lng, message: sosMsg } = req.body;
      await rawDb.execute(rawSql`
        INSERT INTO ai_safety_alerts (trip_id, driver_id, customer_id, alert_type, severity, message, lat, lng)
        VALUES (
          ${tripId ? rawSql`${tripId}::uuid` : rawSql`NULL`},
          ${user.userType === 'driver' ? rawSql`${user.id}::uuid` : rawSql`NULL`},
          ${user.userType === 'customer' ? rawSql`${user.id}::uuid` : rawSql`NULL`},
          'sos', 'critical',
          ${sosMsg || 'SOS Emergency triggered by user'},
          ${Number(lat) || 0}, ${Number(lng) || 0}
        )
      `);
      if (tripId && io) {
        const tripR = await rawDb.execute(rawSql`
          SELECT customer_id, driver_id FROM trip_requests WHERE id=${tripId}::uuid
        `);
        if (tripR.rows.length) {
          const t = tripR.rows[0] as any;
          const otherId = user.userType === 'driver' ? t.customer_id : t.driver_id;
          if (otherId) {
            io.to(`user:${otherId}`).emit("safety:sos", {
              tripId, lat, lng, fromUserType: user.userType,
              message: sosMsg || "SOS Emergency! Your co-rider triggered an emergency alert."
            });
          }
        }
      }
      res.json({ success: true, message: "SOS alert recorded and notifications sent" });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- AI: Driver Stats (for driver profile / admin) ---------------------
  app.get("/api/app/ai/driver-stats/:driverId", authApp, async (req, res) => {
    try {
      const driverIdParam = req.params.driverId;
      const driverId = Array.isArray(driverIdParam) ? driverIdParam[0] : driverIdParam;
      await updateDriverStats(driverId);
      const stats = await rawDb.execute(rawSql`
        SELECT * FROM driver_stats WHERE driver_id = ${driverId}::uuid
      `);
      if (!stats.rows.length) return res.json({ stats: null });
      res.json({ stats: camelize(stats.rows[0]) });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- Periodic driver stats refresh (every 10 minutes) ------------------
  setInterval(() => {
    refreshAllDriverStats().catch(dbCatch("db"));
  }, 10 * 60 * 1000);

  // -- Periodic stale trip cleanup (every 2 minutes) ------------------------
  setInterval(async () => {
    try {
      // Cancel trips stuck in 'searching' for more than 3 minutes (no driver accepted)
      const staleTrips = await rawDb.execute(rawSql`
        UPDATE trip_requests SET current_status='cancelled', cancel_reason='Auto-cancelled: no pilot found within 3 minutes'
        WHERE current_status = 'searching'
          AND created_at < NOW() - INTERVAL '3 minutes'
        RETURNING id, customer_id
      `);
      if (staleTrips.rows.length) {
        console.log(`[CLEANUP] Auto-cancelled ${staleTrips.rows.length} stale trip(s)`);
        // Notify each customer
        for (const row of staleTrips.rows) {
          const r = row as any;
          if (io && r.customer_id) {
            io.to(`user:${r.customer_id}`).emit("trip:cancelled", {
              tripId: r.id, reason: "No pilot accepted your ride in time. Please try again."
            });
          }
        }
      }
      // Free drivers whose current_trip_id points to a completed/cancelled trip
      const freedDrivers = await rawDb.execute(rawSql`
        UPDATE users SET current_trip_id=NULL
        WHERE current_trip_id IS NOT NULL
          AND current_trip_id NOT IN (
            SELECT id FROM trip_requests WHERE current_status IN ('accepted','arrived','on_the_way')
          )
          AND current_trip_id NOT IN (
            SELECT id FROM parcel_orders WHERE current_status IN ('driver_assigned','in_transit')
          )
      `);
      if ((freedDrivers as any).rowCount > 0) {
        console.log(`[CLEANUP] Freed ${(freedDrivers as any).rowCount} driver(s) from stale trip assignments`);
      }
    } catch (e: any) {
      console.error("[CLEANUP] Error:", e.message);
    }
  }, 2 * 60 * 1000);

  const vehicleControlDefaults = [
    { key: "bike", name: "Bike", active: true, icon: "bike" },
    { key: "auto", name: "Auto", active: true, icon: "auto" },
    { key: "cab", name: "Cab", active: false, icon: "car" },
    { key: "premium", name: "Premium", active: false, icon: "premium" },
    { key: "bike_parcel", name: "Bike Parcel", active: true, icon: "bike" },
    { key: "auto_parcel", name: "Auto Parcel", active: true, icon: "auto" },
    { key: "tata_ace", name: "Tata Ace", active: true, icon: "truck" },
    { key: "pickup_truck", name: "Pickup Truck", active: true, icon: "truck" },
    { key: "bolero_cargo", name: "Bolero Cargo", active: true, icon: "truck" },
    { key: "tempo_407", name: "Tempo 407", active: true, icon: "truck" },
    { key: "local_pool", name: "Local Pool", active: true, icon: "pool" },
    { key: "outstation_pool", name: "Outstation Pool", active: true, icon: "pool" },
  ];

  function normalizeVehicleKey(value: string | string[] | null | undefined) {
    const raw = Array.isArray(value) ? value[0] : value;
    const v = String(raw || "").trim().toLowerCase();
    if (v.includes("bike") && v.includes("parcel")) return "bike_parcel";
    if (v.includes("auto") && v.includes("parcel")) return "auto_parcel";
    if (v.includes("mini") && v.includes("truck")) return "tata_ace";
    if (v.includes("tata") && v.includes("ace")) return "tata_ace";
    if (v.includes("bolero")) return "bolero_cargo";
    if (v.includes("tempo") || v.includes("407")) return "tempo_407";
    if (v.includes("pickup")) return "pickup_truck";
    if (v.includes("outstation") && v.includes("pool")) return "outstation_pool";
    if ((v.includes("local") || v.includes("city") || v.includes("carpool")) && v.includes("pool")) return "local_pool";
    if (v.includes("bike")) return "bike";
    if (v.includes("auto")) return "auto";
    if (v.includes("premium")) return "premium";
    if (v.includes("cab") || v.includes("car") || v.includes("sedan") || v.includes("suv") || v.includes("mini")) return "cab";
    return v;
  }

  async function getVehicleControlCollection() {
    const admin = await getFirebaseAdminAsync();
    if (!admin) return null;
    return admin.firestore().collection("vehicle_status");
  }

  async function ensureVehicleStatusDocs() {
    const collection = await getVehicleControlCollection();
    if (!collection) return null;
    await Promise.all(vehicleControlDefaults.map(async (vehicle) => {
      const ref = collection.doc(vehicle.key);
      const snap = await ref.get();
      if (!snap.exists) {
        await ref.set({
          active: vehicle.active,
          name: vehicle.name,
          icon: vehicle.icon,
          updatedAt: new Date(),
          updatedBy: "system",
        }, { merge: true });
      }
    }));
    return collection;
  }

  async function ensureVehicleStatusTable() {
    await rawDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS app_vehicle_status (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        icon TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT
      )
    `);
    await Promise.all(vehicleControlDefaults.map((vehicle) => rawDb.execute(rawSql`
      INSERT INTO app_vehicle_status (key, name, active, icon, updated_at, updated_by)
      VALUES (${vehicle.key}, ${vehicle.name}, ${vehicle.active}, ${vehicle.icon}, NOW(), 'system')
      ON CONFLICT (key) DO NOTHING
    `)));
  }

  async function readVehicleStatusesFromDb() {
    await ensureVehicleStatusTable();
    const result = await rawDb.execute(rawSql`
      SELECT key, name, active, icon, updated_at, updated_by
      FROM app_vehicle_status
      ORDER BY key ASC
    `);
    const rows = new Map((result.rows || []).map((row: any) => [String(row.key), row]));
    return vehicleControlDefaults.map((vehicle) => {
      const row: any = rows.get(vehicle.key) || {};
      const updatedAt = row.updated_at || null;
      return {
        key: vehicle.key,
        name: String(row.name || vehicle.name),
        active: typeof row.active === "boolean" ? row.active : vehicle.active,
        icon: String(row.icon || vehicle.icon),
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
        updatedBy: row.updated_by || null,
      };
    });
  }

  async function readVehicleStatuses() {
    try {
      const collection = await ensureVehicleStatusDocs();
      if (!collection) return readVehicleStatusesFromDb();
      const snap = await collection.get();
      const docs = new Map(snap.docs.map((doc: any) => [doc.id, doc.data() || {}]));
      return vehicleControlDefaults.map((vehicle) => {
        const data: any = docs.get(vehicle.key) || {};
        const updatedAt = data.updatedAt?.toDate?.() || data.updated_at?.toDate?.() || data.updatedAt || data.updated_at || null;
        return {
          key: vehicle.key,
          name: String(data.name || vehicle.name),
          active: typeof data.active === "boolean" ? data.active : vehicle.active,
          icon: String(data.icon || vehicle.icon),
          updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
          updatedBy: data.updatedBy || data.updated_by || null,
        };
      });
    } catch (e: any) {
      console.warn("[VEHICLE_STATUS][firebase_fallback]", safeErrMsg(e));
      return readVehicleStatusesFromDb();
    }
  }

  app.get("/api/admin/vehicle-status", requireAdminAuth, async (_req, res) => {
    try {
      res.json({ vehicles: await readVehicleStatuses() });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.get("/api/app/vehicle-status", async (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ vehicles: await readVehicleStatuses() });
    } catch (_e: any) {
      res.json({
        vehicles: vehicleControlDefaults.map((v) => ({
          key: v.key,
          name: v.name,
          active: v.active,
          icon: v.icon,
          updatedAt: null,
        })),
      });
    }
  });

  app.patch("/api/admin/vehicle-status/:vehicleKey", requireAdminAuth, requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const vehicleKey = normalizeVehicleKey(
        Array.isArray(req.params.vehicleKey)
          ? req.params.vehicleKey[0] ?? ""
          : req.params.vehicleKey ?? "",
      );
      const allowed = vehicleControlDefaults.find((v) => v.key === vehicleKey);
      if (!allowed) return res.status(400).json({ message: "Invalid vehicle type" });
      if (typeof req.body?.active !== "boolean") return res.status(400).json({ message: "active must be boolean" });

      const active = Boolean(req.body.active);
      const adminUser = (req as any).adminUser;
      const updatedBy = adminUser?.email || adminUser?.name || "admin";
      try {
        const collection = await ensureVehicleStatusDocs();
        if (!collection) throw new Error("Firebase Admin is not configured");
        await collection.doc(vehicleKey).set({
          active,
          name: allowed.name,
          icon: allowed.icon,
          updatedAt: new Date(),
          updatedBy,
        }, { merge: true });
        await collection.doc(vehicleKey).collection("activity_logs").add({
          message: `Admin changed ${allowed.name} to ${active ? "Active" : "Inactive"}`,
          active,
          vehicleKey,
          vehicleName: allowed.name,
          adminId: adminUser?.id || null,
          adminEmail: adminUser?.email || null,
          createdAt: new Date(),
        });
      } catch (e: any) {
        console.warn("[VEHICLE_STATUS][patch_db_fallback]", safeErrMsg(e));
        await ensureVehicleStatusTable();
        await rawDb.execute(rawSql`
          INSERT INTO app_vehicle_status (key, name, active, icon, updated_at, updated_by)
          VALUES (${vehicleKey}, ${allowed.name}, ${active}, ${allowed.icon}, NOW(), ${updatedBy})
          ON CONFLICT (key) DO UPDATE SET
            name = EXCLUDED.name,
            active = EXCLUDED.active,
            icon = EXCLUDED.icon,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by
        `);
      }
      await logAdminAction("vehicle_status_change", "vehicle_status", vehicleKey, {
        message: `Admin changed ${allowed.name} to ${active ? "Active" : "Inactive"}`,
        active,
      }, adminUser?.email);

      res.json({ success: true, vehicle: (await readVehicleStatuses()).find((v) => v.key === vehicleKey) });
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  // -- SYSTEM HEALTH CHECK ---------------------------------------------------
  app.get("/api/admin/system-health", requireAdminAuth, async (_req, res) => {
    try {
      const [services, tripStats, parcelStats, driverStats, gstWallet] = await Promise.all([
        rawDb.execute(rawSql`SELECT service_key, service_name, service_status, revenue_model, commission_rate FROM platform_services ORDER BY sort_order ASC`)
          .catch(() => ({ rows: [] })),
        rawDb.execute(rawSql`
          SELECT
            COUNT(*) FILTER (WHERE current_status IN ('searching','accepted','arrived','on_the_way'))::int AS active,
            COUNT(*) FILTER (WHERE current_status = 'completed' AND created_at > NOW() - INTERVAL '24h')::int AS completed_today,
            COUNT(*) FILTER (WHERE current_status = 'cancelled' AND created_at > NOW() - INTERVAL '24h')::int AS cancelled_today,
            COUNT(*) FILTER (WHERE current_status = 'searching' AND created_at < NOW() - INTERVAL '5 minutes')::int AS stale_searching
          FROM trip_requests
        `).catch(() => ({ rows: [{}] })),
        rawDb.execute(rawSql`
          SELECT
            COUNT(*) FILTER (WHERE current_status IN ('searching','driver_assigned','in_transit'))::int AS active,
            COUNT(*) FILTER (WHERE current_status = 'completed' AND created_at > NOW() - INTERVAL '24h')::int AS completed_today,
            COALESCE(SUM(commission_amt) FILTER (WHERE current_status = 'completed' AND created_at > NOW() - INTERVAL '24h'), 0)::numeric AS commission_today
          FROM parcel_orders
        `).catch(() => ({ rows: [{}] })),
        rawDb.execute(rawSql`
          SELECT
            COUNT(*) FILTER (WHERE is_online = true)::int AS online,
            COUNT(*) FILTER (WHERE is_locked = true)::int AS locked,
            COUNT(*) FILTER (WHERE current_trip_id IS NOT NULL)::int AS on_trip
          FROM users WHERE role = 'driver'
        `).catch(() => ({ rows: [{}] })),
        rawDb.execute(rawSql`SELECT balance, total_collected, total_trips FROM company_gst_wallet WHERE id = 1`)
          .catch(() => ({ rows: [{}] })),
      ]);

      const t = (tripStats.rows[0] as any) || {};
      const p = (parcelStats.rows[0] as any) || {};
      const d = (driverStats.rows[0] as any) || {};
      const g = (gstWallet.rows[0] as any) || {};

      // Subscription check: how many drivers have active subscriptions
      const subStats = await rawDb.execute(rawSql`
        SELECT
          COUNT(*) FILTER (WHERE is_active = true AND end_date > NOW())::int AS active_subs,
          COUNT(DISTINCT driver_id) FILTER (WHERE is_active = true AND end_date > NOW())::int AS subscribed_drivers
        FROM driver_subscriptions
      `).catch(() => ({ rows: [{}] }));
      const sub = (subStats.rows[0] as any) || {};

      res.json({
        timestamp: new Date().toISOString(),
        services: services.rows,
        trips: {
          active: parseInt(t.active ?? 0),
          completedToday: parseInt(t.completed_today ?? 0),
          cancelledToday: parseInt(t.cancelled_today ?? 0),
          staleSearching: parseInt(t.stale_searching ?? 0),
        },
        parcels: {
          active: parseInt(p.active ?? 0),
          completedToday: parseInt(p.completed_today ?? 0),
          commissionToday: parseFloat(p.commission_today ?? 0),
        },
        drivers: {
          online: parseInt(d.online ?? 0),
          locked: parseInt(d.locked ?? 0),
          onTrip: parseInt(d.on_trip ?? 0),
          activeSubscriptions: parseInt(sub.active_subs ?? 0),
          subscribedDrivers: parseInt(sub.subscribed_drivers ?? 0),
        },
        gstWallet: {
          balance: parseFloat(g.balance ?? 0),
          totalCollected: parseFloat(g.total_collected ?? 0),
          totalTrips: parseInt(g.total_trips ?? 0),
        },
        status: 'ok',
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e), status: "error" }); }
  });

  app.post("/api/admin/services/toggle", requireAdminAuth, async (req, res) => {
    try {
      const serviceKey = typeof req.body?.serviceKey === "string" ? req.body.serviceKey.trim() : "";
      const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
      if (!serviceKey || !["active", "inactive"].includes(status)) {
        return res.status(400).json({ message: "Invalid service key or status" });
      }

      await rawDb.execute(rawSql`
        UPDATE platform_services 
        SET service_status = ${status} 
        WHERE LOWER(service_key) = LOWER(${serviceKey})
      `);

      // Sync with vehicle categories to reflect in customer app
      const isActive = status === "active";
      if (serviceKey === 'bike_ride') {
        await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active = ${isActive} WHERE vehicle_type = 'bike' OR name ILIKE '%bike%'`);
      } else if (serviceKey === 'parcel_delivery') {
        await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active = ${isActive} WHERE type = 'parcel' OR type = 'cargo'`);
      } else if (serviceKey === 'auto_ride') {
        await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active = ${isActive} WHERE vehicle_type = 'auto' OR name ILIKE '%auto%'`);
      } else if (serviceKey === 'mini_car') {
         await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active = ${isActive} WHERE vehicle_type = 'mini_car' OR name ILIKE '%mini%'`);
      } else if (serviceKey === 'sedan') {
         await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active = ${isActive} WHERE vehicle_type = 'sedan' OR name ILIKE '%sedan%'`);
      } else if (serviceKey === 'suv') {
         await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active = ${isActive} WHERE vehicle_type = 'suv' OR name ILIKE '%suv%'`);
      } else if (serviceKey === 'city_pool') {
        await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active = ${isActive} WHERE name ILIKE '%city%pool%' OR name ILIKE '%car%pool%'`);
      } else if (serviceKey === 'intercity_pool') {
        await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active = ${isActive} WHERE name ILIKE '%intercity%'`);
      } else if (serviceKey === 'outstation_pool') {
        await rawDb.execute(rawSql`UPDATE vehicle_categories SET is_active = ${isActive} WHERE name ILIKE '%outstation%'`);
      }

      await logAdminAction("toggle_service", "platform_services", undefined, { serviceKey, status }, (req as any).adminUser?.email);

      res.json({ success: true, serviceKey, status });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e), status: "error" }); }
  });

  // --------------------------------------------------------------------------
  //  DRIVER HEATMAP EARNINGS PREDICTOR SYSTEM
  //  - Grid-based demand tracking (configurable cell size, default 500m�500m)
  //  - Real-time demand score = requests / active_drivers per cell
  //  - Service-wise breakdown: ride, parcel, pool, cargo
  //  - Earning predictions per zone (?min�?max in 30 min)
  //  - Idle driver suggestions after configurable idle timeout
  //  - Admin config: grid size, thresholds, activation, idle timeout
  //  - Event sources: search, booking, pickup, cancellation, parcel
  //  - Background refresh every 30�60 seconds
  //  - Data privacy: only aggregated stats, no individual passenger data
  // --------------------------------------------------------------------------

  // -- DB Schema -------------------------------------------------------------
  await rawDb.execute(rawSql`
    CREATE TABLE IF NOT EXISTS heatmap_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type VARCHAR(30) NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      service_type VARCHAR(20) DEFAULT 'ride',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_heatmap_events_time ON heatmap_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_heatmap_events_loc ON heatmap_events(lat, lng);

    CREATE TABLE IF NOT EXISTS heatmap_grid_cache (
      grid_key VARCHAR(60) PRIMARY KEY,
      center_lat DOUBLE PRECISION NOT NULL,
      center_lng DOUBLE PRECISION NOT NULL,
      request_count INT DEFAULT 0,
      active_drivers INT DEFAULT 0,
      demand_score NUMERIC(10,4) DEFAULT 0,
      demand_level VARCHAR(10) DEFAULT 'low',
      service_breakdown JSONB DEFAULT '{}',
      estimated_earning_min INT DEFAULT 0,
      estimated_earning_max INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS heatmap_config (
      id INT PRIMARY KEY DEFAULT 1,
      grid_size_meters INT DEFAULT 500,
      refresh_interval_seconds INT DEFAULT 30,
      is_active BOOLEAN DEFAULT true,
      idle_timeout_minutes INT DEFAULT 5,
      low_demand_threshold NUMERIC(6,3) DEFAULT 0.5,
      medium_demand_threshold NUMERIC(6,3) DEFAULT 1.5,
      high_demand_threshold NUMERIC(6,3) DEFAULT 3.0,
      lookback_minutes INT DEFAULT 30,
      earning_low_min INT DEFAULT 60,
      earning_low_max INT DEFAULT 130,
      earning_medium_min INT DEFAULT 120,
      earning_medium_max INT DEFAULT 220,
      earning_high_min INT DEFAULT 200,
      earning_high_max INT DEFAULT 350,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    INSERT INTO heatmap_config (id) VALUES (1) ON CONFLICT DO NOTHING;
  `).catch(dbCatch("db"));

  // -- Helper: fire-and-forget event log (never blocks request) --------------
  function logHeatmapEvent(
    eventType: 'search' | 'booking' | 'pickup' | 'cancellation' | 'parcel',
    lat: number, lng: number,
    serviceType: 'ride' | 'parcel' | 'pool' | 'cargo' = 'ride'
  ) {
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;
    rawDb.execute(rawSql`
      INSERT INTO heatmap_events (event_type, lat, lng, service_type, created_at)
      VALUES (${eventType}, ${lat}, ${lng}, ${serviceType}, NOW())
    `).catch(dbCatch("db"));
  }

  // -- Grid Computation Engine -----------------------------------------------
  async function computeHeatmapGrid() {
    try {
      const cfgR = await rawDb.execute(rawSql`SELECT * FROM heatmap_config WHERE id=1 LIMIT 1`);
      const cfg: any = cfgR.rows[0] || {};
      if (cfg.is_active === false) return;

      const gridMeters = parseInt(cfg.grid_size_meters ?? '500');
      const lookbackMin = parseInt(cfg.lookback_minutes ?? '30');
      // Convert grid size to degrees (~111,320 m per degree at equator)
      const gridDeg = gridMeters / 111320;

      const lowT = parseFloat(cfg.low_demand_threshold ?? '0.5');
      const medT = parseFloat(cfg.medium_demand_threshold ?? '1.5');
      const highT = parseFloat(cfg.high_demand_threshold ?? '3.0');

      const eLoMin = parseInt(cfg.earning_low_min ?? '60');
      const eLoMax = parseInt(cfg.earning_low_max ?? '130');
      const eMedMin = parseInt(cfg.earning_medium_min ?? '120');
      const eMedMax = parseInt(cfg.earning_medium_max ?? '220');
      const eHiMin = parseInt(cfg.earning_high_min ?? '200');
      const eHiMax = parseInt(cfg.earning_high_max ?? '350');

      // Fetch recent demand events
      const evtR = await rawDb.execute(rawSql`
        SELECT lat, lng, event_type, service_type
        FROM heatmap_events
        WHERE created_at > NOW() - (${lookbackMin} || ' minutes')::INTERVAL
          AND lat IS NOT NULL AND lng IS NOT NULL
          AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180
      `);

      // Aggregate events into grid cells
      const gridMap = new Map<string, {
        centerLat: number; centerLng: number;
        requests: number;
        services: Record<string, number>;
      }>();

      for (const row of evtR.rows as any[]) {
        const cellX = Math.floor(row.lat / gridDeg);
        const cellY = Math.floor(row.lng / gridDeg);
        const key = `${cellX}:${cellY}`;
        if (!gridMap.has(key)) {
          gridMap.set(key, {
            centerLat: parseFloat(((cellX + 0.5) * gridDeg).toFixed(6)),
            centerLng: parseFloat(((cellY + 0.5) * gridDeg).toFixed(6)),
            requests: 0,
            services: { ride: 0, parcel: 0, pool: 0, cargo: 0 },
          });
        }
        const cell = gridMap.get(key)!;
        if (['search', 'booking', 'pickup'].includes(row.event_type)) cell.requests++;
        const svc = row.service_type || 'ride';
        cell.services[svc] = (cell.services[svc] || 0) + 1;
      }

      if (gridMap.size === 0) return;

      // Fetch online driver positions
      const drvR = await rawDb.execute(rawSql`
        SELECT lat, lng FROM driver_locations WHERE is_online = true
          AND lat IS NOT NULL AND lng IS NOT NULL
      `);
      const driverGrid = new Map<string, number>();
      for (const row of drvR.rows as any[]) {
        const cellX = Math.floor(row.lat / gridDeg);
        const cellY = Math.floor(row.lng / gridDeg);
        const key = `${cellX}:${cellY}`;
        driverGrid.set(key, (driverGrid.get(key) || 0) + 1);
      }

      // Upsert each grid cell
      for (const [key, cell] of Array.from(gridMap.entries())) {
        const drivers = driverGrid.get(key) || 0;
        const score = parseFloat((cell.requests / Math.max(1, drivers)).toFixed(4));

        let level = 'low';
        let eMin = eLoMin, eMax = eLoMax;
        if (score >= highT) { level = 'high'; eMin = eHiMin; eMax = eHiMax; }
        else if (score >= medT) { level = 'medium'; eMin = eMedMin; eMax = eMedMax; }
        else if (score >= lowT) { level = 'low'; eMin = eLoMin; eMax = eLoMax; }
        else { level = 'low'; eMin = 0; eMax = 0; }

        await rawDb.execute(rawSql`
          INSERT INTO heatmap_grid_cache
            (grid_key, center_lat, center_lng, request_count, active_drivers,
             demand_score, demand_level, service_breakdown,
             estimated_earning_min, estimated_earning_max, updated_at)
          VALUES (
            ${key}, ${cell.centerLat}, ${cell.centerLng},
            ${cell.requests}, ${drivers}, ${score}, ${level},
            ${JSON.stringify(cell.services)}::jsonb,
            ${eMin}, ${eMax}, NOW()
          )
          ON CONFLICT (grid_key) DO UPDATE SET
            center_lat=${cell.centerLat}, center_lng=${cell.centerLng},
            request_count=${cell.requests}, active_drivers=${drivers},
            demand_score=${score}, demand_level=${level},
            service_breakdown=${JSON.stringify(cell.services)}::jsonb,
            estimated_earning_min=${eMin}, estimated_earning_max=${eMax},
            updated_at=NOW()
        `);
      }

      // Purge stale cells not updated in 2� lookback window
      await rawDb.execute(rawSql`
        DELETE FROM heatmap_grid_cache
        WHERE updated_at < NOW() - (${lookbackMin * 2} || ' minutes')::INTERVAL
      `);

      // Purge old raw events (keep 24h)
      await rawDb.execute(rawSql`
        DELETE FROM heatmap_events WHERE created_at < NOW() - INTERVAL '24 hours'
      `);
    } catch (e: any) {
      console.error('[Heatmap] Grid compute error:', e.message);
    }
  }

  // -- Background refresh: start after 10s delay, then every 30s -------------
  setTimeout(async () => {
    await computeHeatmapGrid();
    setInterval(computeHeatmapGrid, 30000);
  }, 10000);

  // -- Hook event logging into estimate-fare (demand signal: customer is searching) --
  // Wrap existing estimate-fare to also log search events
  app.use('/api/app/customer/estimate-fare', (req: Request, res: Response, next: any) => {
    const origJson = res.json.bind(res);
    (res as any).json = (body: any) => {
      if (res.statusCode === 200 || res.statusCode === undefined) {
        const pLat = parseFloat(req.body?.pickupLat ?? 0);
        const pLng = parseFloat(req.body?.pickupLng ?? 0);
        const svc = req.body?.vehicleCategoryId ? 'ride' : 'ride';
        if (pLat && pLng) logHeatmapEvent('search', pLat, pLng, svc);
      }
      return origJson(body);
    };
    next();
  });

  // --------------------------------------------------------------------------
  //  HEATMAP API ENDPOINTS
  // --------------------------------------------------------------------------

  // -- DRIVER: Get heatmap grid zones (for map overlay) ---------------------
  app.get("/api/app/driver/heatmap", authApp, async (req, res) => {
    try {
      const cfgR = await rawDb.execute(rawSql`SELECT * FROM heatmap_config WHERE id=1 LIMIT 1`);
      const cfg: any = cfgR.rows[0] || {};
      if (cfg.is_active === false) return res.json({ zones: [], isActive: false });

      const lat = parseFloat((req.query.lat || '17.38') as string);
      const lng = parseFloat((req.query.lng || '78.49') as string);
      const radiusKm = parseFloat((req.query.radius || '10') as string);

      // Convert radius to degrees
      const radiusDeg = radiusKm / 111.32;

      const zones = await rawDb.execute(rawSql`
        SELECT grid_key, center_lat, center_lng, request_count, active_drivers,
               demand_score, demand_level, service_breakdown,
               estimated_earning_min, estimated_earning_max, updated_at
        FROM heatmap_grid_cache
        WHERE center_lat BETWEEN ${lat - radiusDeg} AND ${lat + radiusDeg}
          AND center_lng BETWEEN ${lng - radiusDeg} AND ${lng + radiusDeg}
          AND updated_at > NOW() - INTERVAL '1 hour'
          AND request_count > 0
        ORDER BY demand_score DESC
        LIMIT 100
      `);

      const gridMeters = parseInt(cfg.grid_size_meters ?? '500');

      res.json({
        isActive: true,
        gridSizeMeters: gridMeters,
        refreshIntervalSeconds: parseInt(cfg.refresh_interval_seconds ?? '30'),
        idleTimeoutMinutes: parseInt(cfg.idle_timeout_minutes ?? '5'),
        zones: zones.rows.map((z: any) => ({
          key: z.grid_key,
          lat: parseFloat(z.center_lat),
          lng: parseFloat(z.center_lng),
          requestCount: parseInt(z.request_count),
          activeDrivers: parseInt(z.active_drivers),
          demandScore: parseFloat(z.demand_score),
          demandLevel: z.demand_level, // low | medium | high
          serviceBreakdown: z.service_breakdown || {},
          earningMin: parseInt(z.estimated_earning_min),
          earningMax: parseInt(z.estimated_earning_max),
          updatedAt: z.updated_at,
        })),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- DRIVER: Get best zone suggestion for idle driver ---------------------
  app.get("/api/app/driver/heatmap/suggestion", authApp, async (req, res) => {
    try {
      const lat = parseFloat((req.query.lat || '17.38') as string);
      const lng = parseFloat((req.query.lng || '78.49') as string);

      // Find nearest high-demand zone within 15km
      const best = await rawDb.execute(rawSql`
        SELECT grid_key, center_lat, center_lng, demand_level, demand_score,
               estimated_earning_min, estimated_earning_max, service_breakdown,
               SQRT(
                 POW((center_lat - ${lat}) * 111.32, 2) +
                 POW((center_lng - ${lng}) * 111.32 * COS(${lat} * PI() / 180), 2)
               ) AS dist_km
        FROM heatmap_grid_cache
        WHERE demand_level IN ('high', 'medium')
          AND updated_at > NOW() - INTERVAL '45 minutes'
          AND request_count > 0
          AND SQRT(
            POW((center_lat - ${lat}) * 111.32, 2) +
            POW((center_lng - ${lng}) * 111.32 * COS(${lat} * PI() / 180), 2)
          ) <= 15
        ORDER BY demand_score DESC, dist_km ASC
        LIMIT 1
      `);

      if (!best.rows.length) return res.json({ suggestion: null });

      const z: any = best.rows[0];
      const distKm = parseFloat(z.dist_km).toFixed(1);
      const level = z.demand_level;

      // Build human-readable message
      let icon = level === 'high' ? '??' : '??';
      const svc = z.service_breakdown || {};
      const topService = Object.entries(svc as Record<string, number>)
        .sort(([, a], [, b]) => (b as number) - (a as number))[0]?.[0] || 'ride';
      const svcLabel = topService === 'parcel' ? 'Parcel delivery'
        : topService === 'pool' ? 'Pool rides'
          : topService === 'cargo' ? 'Cargo'
            : 'Ride requests';

      res.json({
        suggestion: {
          lat: parseFloat(z.center_lat),
          lng: parseFloat(z.center_lng),
          distanceKm: parseFloat(distKm),
          demandLevel: level,
          earningMin: parseInt(z.estimated_earning_min),
          earningMax: parseInt(z.estimated_earning_max),
          topService,
          message: `${icon} ${level === 'high' ? 'High' : 'Medium'} demand zone ${distKm} km away`,
          detail: `${svcLabel} detected. Estimated ?${z.estimated_earning_min}�?${z.estimated_earning_max} in next 30 min`,
        },
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- INTERNAL: Log heatmap event (called from booking flows) --------------
  app.post("/api/app/heatmap/event", authApp, async (req, res) => {
    try {
      const { eventType, lat, lng, serviceType = 'ride' } = req.body;
      if (!lat || !lng) return res.json({ ok: true });
      logHeatmapEvent(eventType || 'search', parseFloat(lat), parseFloat(lng), serviceType);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: Get heatmap config ---------------------------------------------
  app.get("/api/admin/heatmap/config", requireAdminAuth, async (req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM heatmap_config WHERE id=1 LIMIT 1`);
      res.json(camelize(r.rows[0] || {}));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: Update heatmap config ------------------------------------------
  app.put("/api/admin/heatmap/config", requireAdminAuth, async (req, res) => {
    try {
      const {
        gridSizeMeters, refreshIntervalSeconds, isActive, idleTimeoutMinutes,
        lowDemandThreshold, mediumDemandThreshold, highDemandThreshold, lookbackMinutes,
        earningLowMin, earningLowMax, earningMediumMin, earningMediumMax,
        earningHighMin, earningHighMax,
      } = req.body;
      await rawDb.execute(rawSql`
        UPDATE heatmap_config SET
          grid_size_meters            = COALESCE(${gridSizeMeters ?? null}::int, grid_size_meters),
          refresh_interval_seconds    = COALESCE(${refreshIntervalSeconds ?? null}::int, refresh_interval_seconds),
          is_active                   = COALESCE(${isActive ?? null}::boolean, is_active),
          idle_timeout_minutes        = COALESCE(${idleTimeoutMinutes ?? null}::int, idle_timeout_minutes),
          low_demand_threshold        = COALESCE(${lowDemandThreshold ?? null}::numeric, low_demand_threshold),
          medium_demand_threshold     = COALESCE(${mediumDemandThreshold ?? null}::numeric, medium_demand_threshold),
          high_demand_threshold       = COALESCE(${highDemandThreshold ?? null}::numeric, high_demand_threshold),
          lookback_minutes            = COALESCE(${lookbackMinutes ?? null}::int, lookback_minutes),
          earning_low_min             = COALESCE(${earningLowMin ?? null}::int, earning_low_min),
          earning_low_max             = COALESCE(${earningLowMax ?? null}::int, earning_low_max),
          earning_medium_min          = COALESCE(${earningMediumMin ?? null}::int, earning_medium_min),
          earning_medium_max          = COALESCE(${earningMediumMax ?? null}::int, earning_medium_max),
          earning_high_min            = COALESCE(${earningHighMin ?? null}::int, earning_high_min),
          earning_high_max            = COALESCE(${earningHighMax ?? null}::int, earning_high_max),
          updated_at                  = NOW()
        WHERE id=1
      `);
      const r = await rawDb.execute(rawSql`SELECT * FROM heatmap_config WHERE id=1 LIMIT 1`);
      res.json(camelize(r.rows[0]));
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: Get grid stats summary -----------------------------------------
  app.get("/api/admin/heatmap/stats", requireAdminAuth, async (req, res) => {
    try {
      const grid = await rawDb.execute(rawSql`
        SELECT demand_level, COUNT(*) as zones, SUM(request_count) as total_requests,
               AVG(demand_score)::numeric(6,2) as avg_score,
               SUM(active_drivers) as total_drivers
        FROM heatmap_grid_cache
        WHERE updated_at > NOW() - INTERVAL '1 hour'
        GROUP BY demand_level
      `);
      const totalEvents = await rawDb.execute(rawSql`
        SELECT event_type, COUNT(*) as cnt
        FROM heatmap_events WHERE created_at > NOW() - INTERVAL '1 hour'
        GROUP BY event_type
      `);
      const topZones = await rawDb.execute(rawSql`
        SELECT center_lat, center_lng, demand_level, demand_score, request_count,
               active_drivers, estimated_earning_min, estimated_earning_max, service_breakdown
        FROM heatmap_grid_cache
        WHERE updated_at > NOW() - INTERVAL '1 hour' AND request_count > 0
        ORDER BY demand_score DESC LIMIT 10
      `);
      res.json({
        gridSummary: grid.rows.map(camelize),
        eventCounts: totalEvents.rows.map(camelize),
        topZones: topZones.rows.map(camelize),
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- ADMIN: Alert engine ---------------------------------------------------
  app.get("/api/admin/alert-engine/status", requireAdminAuth, async (_req, res) => {
    try {
      res.json(getAlertEngineStatus());
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.get("/api/admin/alert-engine/config", requireAdminAuth, async (_req, res) => {
    try {
      res.json(getEngineConfig());
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.get("/api/admin/alert-engine/metrics-history", requireAdminAuth, async (_req, res) => {
    try {
      res.json(getMetricHistory());
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.get("/api/admin/alert-engine/recent-actions", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT tag, message, COALESCE(details, data, '{}'::jsonb) AS details, created_at
        FROM system_logs
        WHERE tag IN (
          'AUTO_ACTION',
          'MANUAL_ACTION',
          'CONFIG_RELOAD',
          'CONFIG_ROLLBACK',
          'ALERT_RESOLVED',
          'ACTION_SUPPRESSED_REDIS_DOWN',
          'ALERT_CRITICAL',
          'ALERT_WARNING'
        )
        ORDER BY created_at DESC
        LIMIT 50
      `);
      res.json(r.rows.map(camelize));
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.get("/api/admin/alert-engine/rule-history/:ruleId", requireAdminAuth, async (req, res) => {
    try {
      const { ruleId } = req.params;
      const r = await rawDb.execute(rawSql`
        SELECT tag, message, COALESCE(details, data, '{}'::jsonb) AS details, created_at
        FROM system_logs
        WHERE (
          COALESCE(details, data, '{}'::jsonb)->>'rule' = ${ruleId}
          OR COALESCE(details, data, '{}'::jsonb)->>'ruleId' = ${ruleId}
        )
        OR message ILIKE ${`%${ruleId}%`}
        ORDER BY created_at DESC
        LIMIT 100
      `);
      res.json(r.rows.map(camelize));
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.post("/api/admin/alert-engine/config/reload", requireAdminAuth, requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const adminUser = (req as any).adminUser;
      const result = reloadEngineConfig({
        reason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
        force: !!req.body?.force,
        requestedBy: adminUser?.email || adminUser?.name || "admin",
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (e: any) {
      res.status(500).json({ message: safeErrMsg(e) });
    }
  });

  app.post("/api/admin/alert-engine/test", requireAdminAuth, async (_req, res) => {
    try {
      const status = getAlertEngineStatus();
      const metrics = getMetricHistory();
      res.json({
        ok: true,
        message: "Alert engine check completed",
        checkedAt: new Date().toISOString(),
        running: status.running,
        activeAlerts: Array.isArray(status.activeAlerts) ? status.activeAlerts.length : 0,
        metricsSnapshots: Array.isArray(metrics) ? metrics.length : 0,
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, message: safeErrMsg(e) });
    }
  });

  app.post("/api/admin/alert-engine/manual-action", requireAdminAuth, requireAdminRole(["admin", "superadmin"]), async (req, res) => {
    try {
      const adminUser = (req as any).adminUser;
      const action = String(req.body?.action || "").trim();
      if (!["booking_pause", "booking_restore", "surge_restore"].includes(action)) {
        return res.status(400).json({ ok: false, message: "Invalid manual action" });
      }
      const result = await executeManualAction(
        action as "booking_pause" | "booking_restore" | "surge_restore",
        adminUser?.email || adminUser?.name || "admin",
        typeof req.body?.reason === "string" ? req.body.reason : undefined,
      );
      res.status(result.ok ? 200 : 400).json(result);
    } catch (e: any) {
      res.status(500).json({ ok: false, message: safeErrMsg(e) });
    }
  });

  // -- HOOK: Log booking events automatically --------------------------------
  // Intercept book-ride responses to log pickup location
  const _origBookRide = app._router?.stack?.find?.((l: any) => l?.route?.path === '/api/app/customer/book-ride');
  // Event logging is done directly inside book-ride handler � see post-booking log below

  // ----------------------------------------------------------------------------
  //  ADVANCED MOBILITY INTELLIGENCE � API ENDPOINTS
  // ----------------------------------------------------------------------------

  // -- 1. DEMAND HEATMAP � Admin + Driver -------------------------------------
  app.get("/api/admin/demand-heatmap", requireAdminAuth, async (_req, res) => {
    try {
      const zones = await computeDemandHeatmap();
      res.json({ zones, generatedAt: new Date().toISOString() });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/app/driver/heatmap", authApp, async (req, res) => {
    try {
      const zones = await computeDemandHeatmap();
      // Filter to relevant info for driver app overlay
      const driverZones = zones.map(z => ({
        zoneName: z.zoneName,
        lat: z.centerLat,
        lng: z.centerLng,
        intensity: z.demandIntensity,
        color: z.color,
        demandRatio: z.demandRatio,
        surgeMultiplier: z.surgeMultiplier,
      }));
      res.json({ zones: driverZones });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- 2. SURGE PRICING � Admin CRUD + Calculation ----------------------------
  app.get("/api/app/surge", async (req, res) => {
    try {
      const lat = Number(req.query.lat) || 0;
      const lng = Number(req.query.lng) || 0;
      const serviceType = String(req.query.serviceType || "all");
      const surge = await calculateSurgeMultiplier(lat, lng, serviceType);
      res.json(surge);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/surge-configs", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`SELECT * FROM surge_configs ORDER BY created_at DESC`);
      res.json({ configs: r.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/surge-configs", requireAdminAuth, async (req, res) => {
    try {
      const { serviceType = 'all', minMultiplier = 1.0, maxMultiplier = 3.0, demandThreshold = 1.5,
        peakHoursEnabled = true, peakHourStart = 8, peakHourEnd = 10, peakHourMultiplier = 1.3,
        weatherMultiplier = 1.0, manualSurge = null, zoneId = null } = req.body;
      const r = await rawDb.execute(rawSql`
        INSERT INTO surge_configs (zone_id, service_type, min_multiplier, max_multiplier, demand_threshold,
          peak_hours_enabled, peak_hour_start, peak_hour_end, peak_hour_multiplier, weather_multiplier, manual_surge, is_active)
        VALUES (${zoneId}::uuid, ${serviceType}, ${minMultiplier}, ${maxMultiplier}, ${demandThreshold},
          ${peakHoursEnabled}, ${peakHourStart}, ${peakHourEnd}, ${peakHourMultiplier}, ${weatherMultiplier}, ${manualSurge}, true)
        RETURNING *
      `);
      res.json({ config: r.rows[0] });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.put("/api/admin/surge-configs/:id", requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { serviceType, minMultiplier, maxMultiplier, demandThreshold,
        peakHoursEnabled, peakHourStart, peakHourEnd, peakHourMultiplier,
        weatherMultiplier, manualSurge, isActive } = req.body;
      await rawDb.execute(rawSql`
        UPDATE surge_configs SET
          service_type = COALESCE(${serviceType}, service_type),
          min_multiplier = COALESCE(${minMultiplier}, min_multiplier),
          max_multiplier = COALESCE(${maxMultiplier}, max_multiplier),
          demand_threshold = COALESCE(${demandThreshold}, demand_threshold),
          peak_hours_enabled = COALESCE(${peakHoursEnabled}, peak_hours_enabled),
          peak_hour_start = COALESCE(${peakHourStart}, peak_hour_start),
          peak_hour_end = COALESCE(${peakHourEnd}, peak_hour_end),
          peak_hour_multiplier = COALESCE(${peakHourMultiplier}, peak_hour_multiplier),
          weather_multiplier = COALESCE(${weatherMultiplier}, weather_multiplier),
          manual_surge = ${manualSurge ?? null},
          is_active = COALESCE(${isActive}, is_active),
          updated_at = NOW()
        WHERE id = ${id}::uuid
      `);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.delete("/api/admin/surge-configs/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`DELETE FROM surge_configs WHERE id = ${req.params.id}::uuid`);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Manual surge activation (admin override)
  app.post("/api/admin/surge-configs/activate-manual", requireAdminAuth, async (req, res) => {
    try {
      const { multiplier, serviceType = 'all' } = req.body;
      if (!multiplier || multiplier < 1.0 || multiplier > 3.0) {
        return res.status(400).json({ message: "Multiplier must be between 1.0 and 3.0" });
      }
      await rawDb.execute(rawSql`
        UPDATE surge_configs SET manual_surge = ${multiplier}, updated_at = NOW()
        WHERE service_type = ${serviceType} AND is_active = true
      `);
      res.json({ success: true, message: `Manual surge ${multiplier}x activated for ${serviceType}` });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // Deactivate manual surge
  app.post("/api/admin/surge-configs/deactivate-manual", requireAdminAuth, async (req, res) => {
    try {
      const { serviceType = 'all' } = req.body;
      await rawDb.execute(rawSql`
        UPDATE surge_configs SET manual_surge = NULL, updated_at = NOW()
        WHERE service_type = ${serviceType} AND is_active = true
      `);
      res.json({ success: true, message: `Manual surge deactivated for ${serviceType}` });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- 3. DRIVER BEHAVIOR SCORING ----------------------------------------------
  app.get("/api/app/driver/behavior-score", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const score = await calculateDriverBehaviorScore(user.id);
      if (!score) return res.status(404).json({ message: "Score not available" });
      res.json(score);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/driver-scores", requireAdminAuth, async (req, res) => {
    try {
      const { grade, limit = 50, offset = 0 } = req.query;
      const gradeFilter = grade ? rawSql`WHERE dbs.grade = ${grade}` : rawSql``;
      const r = await rawDb.execute(rawSql`
        SELECT dbs.*, u.full_name, u.phone, u.rating
        FROM driver_behavior_scores dbs
        JOIN users u ON u.id = dbs.driver_id
        ${gradeFilter}
        ORDER BY dbs.overall_score DESC
        LIMIT ${parseInt(String(limit))} OFFSET ${parseInt(String(offset))}
      `);
      res.json({ scores: r.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/driver-scores/refresh", requireAdminAuth, async (_req, res) => {
    try {
      const count = await refreshAllBehaviorScores();
      res.json({ success: true, driversRefreshed: count });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- 4. FRAUD DETECTION ------------------------------------------------------
  app.get("/api/admin/fraud-flags", requireAdminAuth, async (req, res) => {
    try {
      const { status = 'pending', severity, limit = 50, offset = 0 } = req.query;
      const sevFilter = severity ? rawSql`AND ff.severity = ${severity}` : rawSql``;
      const r = await rawDb.execute(rawSql`
        SELECT ff.*, u.full_name, u.phone, u.rating
        FROM fraud_flags ff
        JOIN users u ON u.id = ff.user_id
        WHERE ff.status = ${status}
        ${sevFilter}
        ORDER BY ff.created_at DESC
        LIMIT ${parseInt(String(limit))} OFFSET ${parseInt(String(offset))}
      `);
      res.json({ flags: r.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/admin/fraud-flags/:id", requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { status, reviewNotes } = req.body;
      const admin = (req as any).adminUser;
      if (!['reviewed', 'dismissed', 'confirmed'].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      await rawDb.execute(rawSql`
        UPDATE fraud_flags SET status = ${status}, review_notes = ${reviewNotes || null},
          reviewed_by = ${admin?.id || null}::uuid, updated_at = NOW()
        WHERE id = ${id}::uuid
      `);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/fraud-scan", requireAdminAuth, async (_req, res) => {
    try {
      const flagCount = await runFraudScan();
      res.json({ success: true, newFlags: flagCount });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- 5. DRIVER EARNINGS FORECAST ---------------------------------------------
  app.get("/api/app/driver/earnings-forecast", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const lat = Number(req.query.lat) || 0;
      const lng = Number(req.query.lng) || 0;
      if (!lat || !lng) return res.status(400).json({ message: "lat and lng required" });
      const forecast = await forecastDriverEarnings(user.id, lat, lng);
      res.json(forecast);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- 6. DRIVER REBALANCING ---------------------------------------------------
  app.get("/api/app/driver/rebalancing", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const lat = Number(req.query.lat) || 0;
      const lng = Number(req.query.lng) || 0;
      if (!lat || !lng) return res.status(400).json({ message: "lat and lng required" });
      const suggestion = await getRebalancingSuggestion(user.id, lat, lng);
      res.json({ suggestion });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/rebalancing/push-notifications", requireAdminAuth, async (_req, res) => {
    try {
      const sent = await pushRebalancingNotifications();
      res.json({ success: true, notificationsSent: sent });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- 7. REAL-TIME OPERATIONS DASHBOARD ---------------------------------------
  app.get("/api/admin/operations-dashboard", requireAdminAuth, async (_req, res) => {
    try {
      const dashboard = await getOperationsDashboard();
      res.json(dashboard);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- 8. GOOGLE MAPS CACHE � Optimized endpoints -----------------------------
  app.get("/api/app/geocode", authApp, async (req, res) => {
    try {
      const address = String(req.query.address || "");
      if (!address) return res.status(400).json({ message: "address required" });
      const result = await geocodeWithCache(address);
      if (!result) return res.status(404).json({ message: "Geocode not found" });
      res.json(result);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/app/distance", authApp, async (req, res) => {
    try {
      const oLat = Number(req.query.originLat), oLng = Number(req.query.originLng);
      const dLat = Number(req.query.destLat), dLng = Number(req.query.destLng);
      if (!oLat || !oLng || !dLat || !dLng) return res.status(400).json({ message: "Origin and destination coordinates required" });
      const result = await getDistanceWithCache(oLat, oLng, dLat, dLng);
      res.json(result);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/app/route", authApp, async (req, res) => {
    try {
      const oLat = Number(req.query.originLat), oLng = Number(req.query.originLng);
      const dLat = Number(req.query.destLat), dLng = Number(req.query.destLng);
      if (!oLat || !oLng || !dLat || !dLng) return res.status(400).json({ message: "Origin and destination coordinates required" });
      const result = await getRouteWithCache(oLat, oLng, dLat, dLng);
      if (!result) return res.status(404).json({ message: "Route not available" });
      res.json(result);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/maps-cache-stats", requireAdminAuth, async (_req, res) => {
    try {
      const stats = getCacheStats();
      const dbStats = await rawDb.execute(rawSql`
        SELECT cache_type, COUNT(*) as entries, MIN(expires_at) as oldest_expiry
        FROM maps_cache WHERE expires_at > NOW()
        GROUP BY cache_type
      `);
      res.json({ memory: stats, database: dbStats.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/maps-cache/clear", requireAdminAuth, async (_req, res) => {
    try {
      clearAllCaches();
      await rawDb.execute(rawSql`DELETE FROM maps_cache`);
      res.json({ success: true, message: "All maps caches cleared" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- 9. CUSTOMER RETENTION ---------------------------------------------------
  app.post("/api/app/promo/validate", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { promoCode } = req.body;
      if (!promoCode) return res.status(400).json({ message: "promoCode required" });
      const result = await validateRetentionPromo(user.id, promoCode);
      res.json(result);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/retention-analytics", requireAdminAuth, async (_req, res) => {
    try {
      const analytics = await getRetentionAnalytics();
      res.json(analytics);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/retention/run-campaign", requireAdminAuth, async (_req, res) => {
    try {
      const result = await runRetentionCampaign();
      res.json(result);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --------------------------------------------------------------------------
  //  ADVANCED PARCEL SYSTEM � NEW ENDPOINTS
  // --------------------------------------------------------------------------

  // -- Parcel: Get insurance quote -----------------------------------------
  app.post("/api/app/parcel/insurance-quote", authApp, async (req, res) => {
    try {
      const { declaredValue = 0, isFragile = false } = req.body;
      if (!declaredValue || declaredValue <= 0) return res.status(400).json({ message: "declaredValue must be > 0" });
      const quote = await calculateInsurance(parseFloat(declaredValue), isFragile === true);
      res.json(quote);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Parcel: Validate prohibited items -----------------------------------
  app.post("/api/app/parcel/check-prohibited", authApp, async (req, res) => {
    try {
      const { description = '' } = req.body;
      const result = await validateProhibitedItems(description);
      res.json(result);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Parcel: SLA tracking ------------------------------------------------
  app.get("/api/app/parcel/:id/sla", authApp, async (req, res) => {
    try {
      const sla = await getParcelSLA(String(req.params.id));
      if (!sla) return res.status(404).json({ message: "Order not found" });
      res.json(sla);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Parcel: Proof of delivery upload ------------------------------------
  app.post("/api/app/driver/parcel/:id/proof", authApp, upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'signature', maxCount: 1 },
  ]), async (req, res) => {
    try {
      const driverId = (req as any).currentUser?.id;
      const { dropIndex = 0, deliveredTo = '' } = req.body;
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const photoFile = files?.photo?.[0];
      const signatureFile = files?.signature?.[0];
      const photoUrl = photoFile ? `/uploads/${photoFile.filename}` : undefined;
      const signatureUrl = signatureFile ? `/uploads/${signatureFile.filename}` : undefined;

      await saveProofOfDelivery({
        orderId: String(req.params.id),
        dropIndex: parseInt(dropIndex),
        photoUrl,
        signatureUrl,
        deliveredTo,
        driverId,
      });
      res.json({ success: true, photoUrl, signatureUrl });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Parcel: Get proof of delivery ---------------------------------------
  app.get("/api/app/parcel/:id/proof", authApp, async (req, res) => {
    try {
      const dropIndex = req.query.dropIndex !== undefined ? parseInt(String(req.query.dropIndex)) : undefined;
      const proofs = await getProofOfDelivery(String(req.params.id), dropIndex);
      res.json({ proofs });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Parcel: Calculate billable weight -----------------------------------
  app.post("/api/app/parcel/calculate-weight", authApp, async (req, res) => {
    try {
      const { lengthCm = 0, widthCm = 0, heightCm = 0, weightKg = 1 } = req.body;
      const result = calculateBillableWeight({
        lengthCm: safeFloat(lengthCm, 0), widthCm: safeFloat(widthCm, 0),
        heightCm: safeFloat(heightCm, 0), weightKg: safeFloat(weightKg, 0),
      });
      res.json(result);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- B2B: CSV bulk upload ------------------------------------------------
  app.post("/api/b2b/:companyId/bulk-csv-upload", authApp, upload.single('csvFile'), async (req, res) => {
    try {
      const { companyId } = req.params;
      const customerId = (req as any).currentUser?.id;
      const { vehicleCategory = 'bike_parcel', pickupAddress, pickupLat, pickupLng,
        pickupContactName, pickupContactPhone } = req.body;
      const parcelVehicleCategory = assertAllowedParcelVehicle(vehicleCategory);

      if (!req.file) return res.status(400).json({ message: "CSV file required" });
      if (!pickupAddress) return res.status(400).json({ message: "pickupAddress required" });

      const csvContent = fs.readFileSync(req.file.path, 'utf-8');
      const { rows: csvRows, errors: parseErrors } = parseParcelCSV(csvContent);

      if (parseErrors.length && !csvRows.length) {
        return res.status(400).json({ message: "CSV parsing failed", errors: parseErrors });
      }

      const vc = PARCEL_VEHICLES[parcelVehicleCategory];
      const results: any[] = [];
      const errors: string[] = [...parseErrors];

      for (let i = 0; i < csvRows.length; i++) {
        try {
          const row = csvRows[i];
          const wt = row.weightKg || 1;
          const dist = 5; // Default estimate
          const baseFare = vc.baseFare;
          const distF = Math.round(dist * vc.perKm);
          const wtF = Math.round(wt * vc.perKg);
          const total = baseFare + distF + wtF + vc.loadCharge;
          const commAmt = Math.round(total * 0.15);
          const pickupOtp = Math.floor(100000 + Math.random() * 900000).toString();
          const drops = [{
            address: row.dropAddress,
            lat: row.dropLat || null,
            lng: row.dropLng || null,
            receiverName: row.receiverName,
            receiverPhone: row.receiverPhone,
            dropIndex: 0,
            deliveryOtp: Math.floor(100000 + Math.random() * 900000).toString(),
            delivered_at: null,
          }];

          // Insurance for declared value
          let insPremium = 0;
          if (row.declaredValue && row.declaredValue > 0) {
            const ins = await calculateInsurance(row.declaredValue, false);
            insPremium = ins.premiumAmount;
          }

          const r = await rawDb.execute(rawSql`
            INSERT INTO parcel_orders
              (customer_id, vehicle_category, pickup_address, pickup_lat, pickup_lng,
               pickup_contact_name, pickup_contact_phone, drop_locations,
               total_distance_km, weight_kg, base_fare, distance_fare, weight_fare,
               total_fare, commission_amt, commission_pct, current_status,
               pickup_otp, is_b2b, b2b_company_id, parcel_description,
               declared_value, insurance_premium, load_charge)
            VALUES
              (${customerId}::uuid, ${parcelVehicleCategory}, ${pickupAddress},
               ${pickupLat ?? null}, ${pickupLng ?? null},
               ${pickupContactName ?? ''}, ${pickupContactPhone ?? ''},
               ${JSON.stringify(drops)}, ${dist}, ${wt}, ${baseFare}, ${distF}, ${wtF},
               ${total + insPremium}, ${commAmt}, 15, 'searching',
               ${pickupOtp}, true, ${companyId}::uuid,
               ${row.description || null}, ${row.declaredValue || 0}, ${insPremium}, ${vc.loadCharge})
            RETURNING id, total_fare
          `);
          results.push((r.rows as any[])[0]);
        } catch (err: any) {
          errors.push(`Row ${i + 1}: ${err.message}`);
        }
      }

      // Fire B2B webhook for bulk creation
      if (results.length > 0) {
        fireB2BWebhook({
          eventType: "order_created",
          orderId: results[0].id,
          companyId: String(companyId),
          timestamp: new Date().toISOString(),
          data: { bulkUpload: true, ordersCreated: results.length, totalOrders: csvRows.length },
        }).catch(dbCatch("db"));
      }

      // Clean up uploaded file
      fs.unlink(req.file.path, () => { });

      res.json({
        success: true,
        ordersCreated: results.length,
        totalRows: csvRows.length,
        orders: results,
        errors: errors.length ? errors : undefined,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- B2B: Configure webhook ----------------------------------------------
  app.post("/api/b2b/:companyId/webhook", authApp, async (req, res) => {
    try {
      const { companyId } = req.params;
      const { webhookUrl, webhookSecret } = req.body;
      if (!webhookUrl) return res.status(400).json({ message: "webhookUrl required" });
      await rawDb.execute(rawSql`
        UPDATE b2b_companies
        SET webhook_url = ${webhookUrl}, webhook_secret = ${webhookSecret || null}, updated_at = NOW()
        WHERE id = ${companyId}::uuid
      `);
      res.json({ success: true, message: "Webhook configured" });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- B2B: Get webhook logs -----------------------------------------------
  app.get("/api/b2b/:companyId/webhook-logs", authApp, async (req, res) => {
    try {
      const { companyId } = req.params;
      const r = await rawDb.execute(rawSql`
        SELECT id, event_type, order_id, status, response_code, delivered_at, created_at
        FROM b2b_webhook_logs
        WHERE company_id = ${companyId}::uuid
        ORDER BY created_at DESC
        LIMIT 50
      `);
      res.json({ logs: r.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: Prohibited items management ----------------------------------
  app.get("/api/admin/parcel/prohibited-items", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT * FROM parcel_prohibited_items ORDER BY category, item_name
      `);
      res.json({ items: r.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/parcel/prohibited-items", requireAdminAuth, async (req, res) => {
    try {
      const { itemName, category = 'general' } = req.body;
      if (!itemName) return res.status(400).json({ message: "itemName required" });
      await rawDb.execute(rawSql`
        INSERT INTO parcel_prohibited_items (item_name, category) VALUES (${itemName}, ${category})
      `);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.delete("/api/admin/parcel/prohibited-items/:id", requireAdminAuth, async (req, res) => {
    try {
      await rawDb.execute(rawSql`
        DELETE FROM parcel_prohibited_items WHERE id = ${req.params.id}::uuid
      `);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: Insurance settings -------------------------------------------
  app.get("/api/admin/parcel/insurance-settings", requireAdminAuth, async (_req, res) => {
    try {
      const sr = await rawDb.execute(rawSql`
        SELECT key_name, value FROM business_settings
        WHERE key_name IN ('parcel_insurance_standard_rate', 'parcel_insurance_fragile_rate')
      `);
      const settings: Record<string, any> = {};
      for (const row of sr.rows as any[]) {
        try { settings[row.key_name] = JSON.parse(row.value); } catch { settings[row.key_name] = row.value; }
      }
      res.json(settings);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.put("/api/admin/parcel/insurance-settings", requireAdminAuth, async (req, res) => {
    try {
      const { standardRate, fragileRate } = req.body;
      if (standardRate) {
        await rawDb.execute(rawSql`
          UPDATE business_settings SET value = ${JSON.stringify(standardRate)}
          WHERE key_name = 'parcel_insurance_standard_rate'
        `);
      }
      if (fragileRate) {
        await rawDb.execute(rawSql`
          UPDATE business_settings SET value = ${JSON.stringify(fragileRate)}
          WHERE key_name = 'parcel_insurance_fragile_rate'
        `);
      }
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: SLA dashboard ------------------------------------------------
  app.get("/api/admin/parcel/sla-dashboard", requireAdminAuth, async (_req, res) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT
          COUNT(*)::int as total_orders,
          COUNT(*) FILTER (WHERE sla_breached = true)::int as sla_breached,
          COUNT(*) FILTER (WHERE current_status = 'completed')::int as completed,
          ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) FILTER (WHERE current_status = 'completed'))::int as avg_delivery_minutes,
          ROUND(AVG(expected_delivery_minutes) FILTER (WHERE expected_delivery_minutes > 0))::int as avg_expected_minutes
        FROM parcel_orders
        WHERE created_at > NOW() - INTERVAL '7 days'
      `);
      res.json(r.rows[0] || {});
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --------------------------------------------------------------------------
  //  UNIFIED MAPPING ARCHITECTURE � NEW ENDPOINTS
  // --------------------------------------------------------------------------

  // -- Places Autocomplete -------------------------------------------------
  app.get("/api/app/places/autocomplete", authApp, async (req, res) => {
    try {
      const query = String(req.query.query || req.query.input || "");
      const sessionToken = String(req.query.sessionToken || "");
      const lat = req.query.lat ? Number(req.query.lat) : undefined;
      const lng = req.query.lng ? Number(req.query.lng) : undefined;
      if (!query) return res.status(400).json({ message: "query required" });
      const predictions = await searchPlaces(query, sessionToken, lat, lng);
      res.json({ predictions });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Place Details (get lat/lng from place_id) ---------------------------
  app.get("/api/app/places/details", authApp, async (req, res) => {
    try {
      const placeId = String(req.query.placeId || "");
      const sessionToken = String(req.query.sessionToken || "");
      if (!placeId) return res.status(400).json({ message: "placeId required" });
      const details = await getPlaceDetails(placeId, sessionToken);
      if (!details) return res.status(404).json({ message: "Place not found" });
      res.json(details);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/app/places/select", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const { placeId, queryText, placeLabel, placeAddress, lat, lng } = req.body || {};
      if (!placeId && !placeAddress) return res.status(400).json({ message: "placeId or placeAddress required" });
      await rawDb.execute(rawSql`
        CREATE TABLE IF NOT EXISTS app_place_selections (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL,
          place_id TEXT,
          query_text TEXT,
          place_label TEXT,
          place_address TEXT,
          lat NUMERIC(10,7),
          lng NUMERIC(10,7),
          created_at TIMESTAMP DEFAULT NOW()
        )
      `).catch(dbCatch("db"));
      const r = await rawDb.execute(rawSql`
        INSERT INTO app_place_selections
          (user_id, place_id, query_text, place_label, place_address, lat, lng)
        VALUES
          (${user.id}::uuid, ${placeId || null}, ${queryText || null}, ${placeLabel || null},
           ${placeAddress || null}, ${lat != null ? Number(lat) : null}, ${lng != null ? Number(lng) : null})
        RETURNING id, created_at
      `);
      res.json({ success: true, selection: camelize(r.rows[0]) });
    } catch (e: any) { res.status(e?.statusCode || 500).json({ message: safeErrMsg(e), code: e?.code, allowed: e?.allowed }); }
  });

  // -- Reverse Geocode -----------------------------------------------------
  app.get("/api/app/reverse-geocode", authApp, async (req, res) => {
    try {
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      if (!lat || !lng) return res.status(400).json({ message: "lat and lng required" });
      const result = await reverseGeocode(lat, lng);
      if (!result) return res.status(404).json({ message: "Address not found" });
      res.json(result);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Multi-waypoint Route ------------------------------------------------
  app.post("/api/app/route/multi-waypoint", authApp, async (req, res) => {
    try {
      const { origin, destination, waypoints = [], optimize = true } = req.body;
      if (!origin?.lat || !origin?.lng || !destination?.lat || !destination?.lng) {
        return res.status(400).json({ message: "origin and destination with lat/lng required" });
      }
      const route = await getMultiWaypointRoute(origin, destination, waypoints, optimize);
      if (!route) return res.status(404).json({ message: "Route not available" });
      res.json(route);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Real-time ETA -------------------------------------------------------
  app.get("/api/app/eta", authApp, async (req, res) => {
    try {
      const dLat = Number(req.query.driverLat);
      const dLng = Number(req.query.driverLng);
      const destLat = Number(req.query.destLat);
      const destLng = Number(req.query.destLng);
      if (!dLat || !dLng || !destLat || !destLng) return res.status(400).json({ message: "Driver and destination coordinates required" });
      const eta = await getRealTimeETA(dLat, dLng, destLat, destLng);
      res.json(eta);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Short location name -------------------------------------------------
  app.get("/api/app/short-name", authApp, async (req, res) => {
    try {
      const address = String(req.query.address || "");
      if (!address) return res.status(400).json({ message: "address required" });
      res.json({ shortName: extractShortName(address) });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Nearby Places -------------------------------------------------------
  app.get("/api/app/places/nearby", authApp, async (req, res) => {
    try {
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      const type = String(req.query.type || "point_of_interest");
      const radius = Number(req.query.radius || 2000);
      if (!lat || !lng) return res.status(400).json({ message: "lat and lng required" });
      const places = await searchNearbyPlaces(lat, lng, type, radius);
      res.json({ places });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Mapping Stats (admin) ----------------------------------------------
  app.get("/api/admin/mapping-stats", requireAdminAuth, async (_req, res) => {
    try {
      const mapsCacheStats = getCacheStats();
      const mappingStats = getMappingStats();
      const dbStats = await rawDb.execute(rawSql`
        SELECT cache_type, COUNT(*)::int as entries,
          COUNT(*) FILTER (WHERE expires_at > NOW())::int as active
        FROM maps_cache GROUP BY cache_type
      `).catch(() => ({ rows: [] }));
      res.json({ memory: { ...mapsCacheStats, ...mappingStats }, database: dbStats.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --------------------------------------------------------------------------
  //  UNIFIED REVENUE ENGINE � ENDPOINTS
  // --------------------------------------------------------------------------

  // -- Payment Methods: list supported -------------------------------------
  app.get("/api/app/payment-methods", authApp, async (_req, res) => {
    try {
      res.json({
        methods: [
          { id: "cash", name: "Cash", icon: "??", isActive: true },
          { id: "upi", name: "UPI", icon: "??", isActive: true, providers: SUPPORTED_UPI_PROVIDERS.filter(p => p.isActive) },
          { id: "wallet", name: "Wallet", icon: "??", isActive: true },
        ],
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- UPI Providers -------------------------------------------------------
  app.get("/api/app/upi-providers", authApp, async (_req, res) => {
    res.json({ providers: SUPPORTED_UPI_PROVIDERS });
  });

  // -- Revenue Breakdown Preview (before trip) -----------------------------
  app.post("/api/app/revenue/preview", authApp, async (req, res) => {
    try {
      const { fare, serviceCategory = "rides" } = req.body;
      if (!fare || fare <= 0) return res.status(400).json({ message: "fare required" });
      const breakdown = await calculateRevenueBreakdown(parseFloat(fare), serviceCategory as ServiceCategory);
      res.json(breakdown);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Driver Wallet Summary -----------------------------------------------
  app.get("/api/app/driver/wallet/summary", authApp, async (req, res) => {
    try {
      const driverId = (req as any).currentUser?.id;
      const wallet = await getDriverWalletSummary(driverId);
      if (!wallet) return res.status(404).json({ message: "Driver not found" });
      res.json(wallet);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Driver Withdrawal Request -------------------------------------------
  app.post("/api/app/driver/wallet/withdraw", authApp, async (req, res) => {
    try {
      const driverId = (req as any).currentUser?.id;
      const { amount, method = "bank_transfer" } = req.body;
      if (!amount || amount <= 0) return res.status(400).json({ message: "amount must be > 0" });
      const result = await requestWithdrawal(driverId, parseFloat(amount), method);
      res.json({ success: true, withdrawal: result });
    } catch (e: any) { res.status(400).json({ message: safeErrMsg(e) }); }
  });

  // -- Driver Transaction History ------------------------------------------
  app.get("/api/app/driver/wallet/transactions", authApp, async (req, res) => {
    try {
      const driverId = (req as any).currentUser?.id;
      const limit = Math.min(100, parseInt(String(req.query.limit || "50")));
      const r = await rawDb.execute(rawSql`
        SELECT id, account, credit, debit, balance, transaction_type, ref_transaction_id, created_at
        FROM transactions WHERE user_id=${driverId}::uuid
        ORDER BY created_at DESC LIMIT ${limit}
      `);
      res.json({ transactions: r.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Customer Wallet Balance ---------------------------------------------
  app.get("/api/app/customer/wallet/balance", authApp, async (req, res) => {
    try {
      const customerId = (req as any).currentUser?.id;
      const balance = await getCustomerWallet(customerId);
      res.json({ walletBalance: balance });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Customer Wallet Top-up ----------------------------------------------
  app.post("/api/app/customer/wallet/topup", authApp, async (req, res) => {
    try {
      const customerId = (req as any).currentUser?.id;
      const { amount, paymentMethod = "upi", paymentId } = req.body;
      if (!amount || amount <= 0) return res.status(400).json({ message: "amount must be > 0" });
      const newBalance = await topUpCustomerWallet(customerId, parseFloat(amount), paymentMethod, paymentId);
      res.json({ success: true, walletBalance: newBalance });
    } catch (e: any) { res.status(400).json({ message: safeErrMsg(e) }); }
  });

  // -- Customer Transaction History ----------------------------------------
  app.get("/api/app/customer/wallet/transactions", authApp, async (req, res) => {
    try {
      const customerId = (req as any).currentUser?.id;
      const limit = Math.min(100, parseInt(String(req.query.limit || "50")));
      const r = await rawDb.execute(rawSql`
        SELECT id, account, credit, debit, balance, transaction_type, ref_transaction_id, created_at
        FROM transactions WHERE user_id=${customerId}::uuid
        ORDER BY created_at DESC LIMIT ${limit}
      `);
      res.json({ transactions: r.rows });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: Withdrawal Management ----------------------------------------
  app.get("/api/admin/withdrawals", requireAdminAuth, async (_req, res) => {
    try {
      const withdrawals = await getPendingWithdrawals();
      res.json({ data: withdrawals });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/withdrawals/:id/approve", requireAdminAuth, async (req, res) => {
    try {
      await approveWithdrawal(String(req.params.id));
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/withdrawals/:id/reject", requireAdminAuth, async (req, res) => {
    try {
      await rejectWithdrawal(String(req.params.id));
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: Revenue Model per Service ------------------------------------
  app.get("/api/admin/revenue/models", requireAdminAuth, async (_req, res) => {
    try {
      const settings = await loadRevenueSettings();
      const services = [
        { service: "rides", modelKey: "rides_model", model: settings.rides_model || "subscription" },
        { service: "parcel", modelKey: "parcels_model", model: settings.parcels_model || "commission" },
        { service: "b2b_parcel", modelKey: "parcels_model", model: settings.parcels_model || "commission" },
        { service: "cargo", modelKey: "cargo_model", model: settings.cargo_model || "commission" },
        { service: "intercity", modelKey: "intercity_model", model: settings.intercity_model || "commission" },
        { service: "city_pool", modelKey: "city_pool_model", model: settings.city_pool_model || "commission" },
        { service: "outstation_pool", modelKey: "outstation_pool_model", model: settings.outstation_pool_model || "commission" },
      ];
      res.json({
        services,
        commissionPct: settings.commission_pct || "15",
        rideGstRate: settings.ride_gst_rate || "5",
        parcelGstRate: settings.parcel_gst_rate || "18",
        insurancePerRide: settings.commission_insurance_per_ride || "2",
        platformFeePerRide: settings.sub_platform_fee_per_ride || "5",
        hybridCommissionPct: settings.hybrid_commission_pct || "10",
        insuranceOptional: settings.insurance_optional || "true",
        lockThreshold: settings.commission_lock_threshold || "200",
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: Update Revenue Model for a Service ---------------------------
  app.put("/api/admin/revenue/models/:service", requireAdminAuth, async (req, res) => {
    try {
      const { service } = req.params;
      const { revenueModel } = req.body;
      if (!["commission", "subscription", "hybrid"].includes(revenueModel)) {
        return res.status(400).json({ message: "revenueModel must be commission, subscription, or hybrid" });
      }
      const keyMap: Record<string, string> = {
        rides: "rides_model", parcel: "parcels_model", b2b_parcel: "parcels_model",
        cargo: "cargo_model", intercity: "intercity_model",
        city_pool: "city_pool_model", outstation_pool: "outstation_pool_model",
      };
      const key = keyMap[String(service)];
      if (!key) return res.status(400).json({ message: "Invalid service" });
      await rawDb.execute(rawSql`
        INSERT INTO revenue_model_settings (key_name, value)
        VALUES (${key}, ${revenueModel})
        ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `);
      // Also update platform_services table if it exists
      const svcKeyMap: Record<string, string[]> = {
        rides: ["bike_ride", "auto_ride", "mini_car", "sedan", "suv"],
        parcel: ["parcel_delivery"], b2b_parcel: ["parcel_delivery"],
        city_pool: ["city_pool"], outstation_pool: ["outstation_pool"],
        intercity: ["intercity_pool"],
      };
      const svcKeys = svcKeyMap[String(service)] || [];
      for (const sk of svcKeys) {
        await rawDb.execute(rawSql`
          UPDATE platform_services SET revenue_model=${revenueModel}, updated_at=NOW()
          WHERE service_key=${sk}
        `).catch(dbCatch("db"));
      }
      res.json({ success: true, service: String(service), revenueModel });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: Update Commission / GST / Insurance Rates --------------------
  app.put("/api/admin/revenue/rates", requireAdminAuth, async (req, res) => {
    try {
      const allowedKeys = [
        "commission_pct", "ride_gst_rate", "parcel_gst_rate",
        "commission_insurance_per_ride", "sub_platform_fee_per_ride",
        "hybrid_commission_pct", "hybrid_platform_fee_per_ride",
        "hybrid_insurance_per_ride", "commission_lock_threshold",
        "auto_lock_threshold", "insurance_optional",
        "city_pool_commission", "outstation_pool_commission",
      ];
      const updates: string[] = [];
      for (const [key, value] of Object.entries(req.body)) {
        if (allowedKeys.includes(key)) {
          await rawDb.execute(rawSql`
            INSERT INTO revenue_model_settings (key_name, value)
            VALUES (${key}, ${String(value)})
            ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
          `);
          updates.push(key);
        }
      }
      res.json({ success: true, updated: updates });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: Revenue Analytics --------------------------------------------
  app.get("/api/admin/revenue/analytics", requireAdminAuth, async (req, res) => {
    try {
      const days = parseInt(String(req.query.days || "7"));
      const [byType, byService, gstWallet] = await Promise.all([
        getRevenueAnalytics(days),
        getRevenueByService(days),
        rawDb.execute(rawSql`SELECT * FROM company_gst_wallet WHERE id=1`).catch(() => ({ rows: [] })),
      ]);
      res.json({
        byRevenueType: byType,
        byService,
        gstWallet: gstWallet.rows[0] || { balance: 0, total_collected: 0, total_trips: 0 },
        period: `${days} days`,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: Revenue breakdown for a specific trip/order ------------------
  app.get("/api/admin/revenue/trip/:tripId", requireAdminAuth, async (req, res) => {
    try {
      const tripId = String(req.params.tripId);
      const [revenueR, settlementsR] = await Promise.all([
        rawDb.execute(rawSql`SELECT * FROM admin_revenue WHERE trip_id=${tripId}::uuid`),
        rawDb.execute(rawSql`SELECT * FROM commission_settlements WHERE trip_id=${tripId}::uuid ORDER BY created_at`),
      ]);
      res.json({
        revenue: revenueR.rows[0] || null,
        settlements: settlementsR.rows,
      });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // --------------------------------------------------------------------------
  //  DYNAMIC SERVICES & PARCEL VEHICLES � ENDPOINTS
  // --------------------------------------------------------------------------

  // App: Get services available at a location (city-based filtering)
  app.get("/api/app/services/location", async (req, res) => {
    try {
      const lat = req.query.lat ? Number(req.query.lat) : undefined;
      const lng = req.query.lng ? Number(req.query.lng) : undefined;
      const services = await getServicesForLocation(lat, lng);
      res.json({ services });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // App: Get parcel vehicles available at a location
  app.get("/api/app/parcel-vehicles", async (req, res) => {
    try {
      const lat = req.query.lat ? Number(req.query.lat) : undefined;
      const lng = req.query.lng ? Number(req.query.lng) : undefined;
      const result = await getParcelVehiclesForLocation(lat, lng);
      res.json({ vehicles: result.vehicles, city: result.city });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // App: Recommend a parcel vehicle by weight
  app.post("/api/app/parcel-vehicles/recommend", async (req, res) => {
    try {
      const { lat, lng, weightKg } = req.body;
      const result = await getParcelVehiclesForLocation(
        lat ? Number(lat) : undefined,
        lng ? Number(lng) : undefined
      );
      const recommended = recommendVehicle(result.vehicles, Number(weightKg) || 5);
      res.json({ recommended, allVehicles: result.vehicles });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // App: Get services a driver is eligible for based on vehicle type
  app.get("/api/app/driver/eligible-services", authApp, async (req, res) => {
    try {
      const user = (req as any).currentUser;
      const services = await getDriverEligibleServices(user.id);
      res.json({ services });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: City-based service management --------------------------------
  app.get("/api/admin/city-services", requireAdminAuth, async (_req, res) => {
    try {
      const cities = await getCitiesWithServices();
      res.json({ cities });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/city-services/add", requireAdminAuth, async (req, res) => {
    try {
      const { cityName, serviceKey, cityLat, cityLng, radiusKm } = req.body;
      if (!cityName || !serviceKey) return res.status(400).json({ message: "cityName and serviceKey required" });
      await addCityService(String(cityName), Number(cityLat) || 0, Number(cityLng) || 0, String(serviceKey), radiusKm ? Number(radiusKm) : undefined);
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/city-services/toggle", requireAdminAuth, async (req, res) => {
    try {
      const { cityName, serviceKey, isActive } = req.body;
      if (!cityName || !serviceKey) return res.status(400).json({ message: "cityName and serviceKey required" });
      await toggleCityService(String(cityName), String(serviceKey), Boolean(isActive));
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: Parcel vehicle type management -------------------------------
  app.get("/api/admin/parcel-vehicles", requireAdminAuth, async (_req, res) => {
    try {
      const vehicles = await getAllParcelVehicles();
      res.json({ vehicles });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.patch("/api/admin/parcel-vehicles/:key", requireAdminAuth, async (req, res) => {
    try {
      const key = String(req.params.key);
      const updated = await updateParcelVehicle(key, req.body);
      res.json({ success: true, vehicle: updated });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.post("/api/admin/parcel-vehicles", requireAdminAuth, async (req, res) => {
    try {
      const vehicle = await addParcelVehicle(req.body);
      res.json({ success: true, vehicle });
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  // -- Admin: AI Mobility Brain dashboard ----------------------------------
  app.get("/api/admin/ai-brain/dashboard", requireAdminAuth, async (_req, res) => {
    try {
      if (!AI_MOBILITY_BRAIN_ENABLED) {
        return res.status(503).json({ message: "AI mobility brain is disabled in production." });
      }
      const data = await getAIDashboardData();
      res.json(data);
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  app.get("/api/admin/ai-brain/status", requireAdminAuth, async (_req, res) => {
    try {
      if (!AI_MOBILITY_BRAIN_ENABLED) {
        return res.status(503).json({ enabled: false, message: "AI mobility brain is disabled in production." });
      }
      res.json(getBrainStatus());
    } catch (e: any) { res.status(500).json({ message: safeErrMsg(e) }); }
  });

  return httpServer;
}
