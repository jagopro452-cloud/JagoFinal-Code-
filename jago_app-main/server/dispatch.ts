/**
 * Smart Driver Dispatch Engine
 *
 * Sequential driver dispatch with expanding radius search.
 * Sends trip request to ONE driver at a time, with configurable timeout.
 * Expands radius progressively (2→4→6→8 km) when no driver accepts.
 *
 * Works for all service types: bike, auto, cab, parcel, b2b, carpool, outstation.
 */

import { db as rawDb } from "./db";
import { sql as rawSql } from "drizzle-orm";
import { io } from "./socket";
import crypto from "crypto";
import { notifyDriverNewRide } from "./fcm";
import { findBestDrivers, type DriverMatchScore } from "./ai";
import { notifyUser } from "./notification-service";
import { findParcelCapableDrivers } from "./parcel-advanced";
import {
  getDriverDbVehicleType,
  getDriverSocketRoomKeyForCategoryId,
  getMatchingDriverCategoryIds,
  normalizeVehicleKey,
  uuidArraySql,
} from "./vehicle-matching";
import {
  assignRideToDriver,
  cancelRideState,
  logRideEvent,
  resetRideForRedispatch,
  transitionRideState,
} from "./ride-state";
import { activeDriverEligibilitySql } from "./driver-state";
import { applyWalletChange } from "./revenue-engine";
import { getDistanceWithCache } from "./maps-cache";
import { getSurgeInfo, recordDispatchOutcome } from "./surge";

// Driver fatigue backoff — avoid hammering the same driver across concurrent trips
// If a driver was offered any ride within this window, skip them to prevent burnout
// and improve acceptance (a driver already reviewing one offer won't accept another)
const DRIVER_FATIGUE_BACKOFF_MS = 25_000;
const DRIVER_OFFER_LOCK_TTL_SEC = 30; // Redis key TTL — auto-releases if ack is never received
const DISPATCH_OWNER_TTL_SEC = 10 * 60;
const DISPATCH_SESSION_TTL_SEC = 15 * 60;
const driverLastOfferedAt = new Map<string, number>();
// In-process fallback (single pod or Redis unavailable)
const driverActiveOfferCount = new Map<string, number>();

let _redisOffer: import("ioredis").Redis | null = null;
let _redisOfferReady = false;
(async () => {
  try {
    const { default: IORedis } = await import("ioredis");
    const url = process.env.REDIS_URL;
    if (!url) return;
    const client = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    await client.connect();
    _redisOffer = client;
    _redisOfferReady = true;
  } catch { /* Redis unavailable — in-process fallback active */ }
})();

function driverOfferKey(driverId: string): string {
  return `driver_offer:${driverId}`;
}

function dispatchOwnerKey(tripId: string): string {
  return `dispatch_owner:${tripId}`;
}

function dispatchSessionKey(tripId: string): string {
  return `dispatch_session:${tripId}`;
}

function driverFatigueKey(driverId: string): string {
  return `driver_fatigue:${driverId}`;
}

async function tryClaimDriverOffer(driverId: string, tripId: string): Promise<boolean> {
  const now = Date.now();
  driverLastOfferedAt.set(driverId, now);
  // H11 FIX: Also persist to Redis so fatigue survives pod restarts
  if (_redisOfferReady && _redisOffer) {
    _redisOffer.set(driverFatigueKey(driverId), String(now), 'EX', Math.ceil(DRIVER_FATIGUE_BACKOFF_MS / 1000) + 5).catch(() => {});
  }
  if (_redisOfferReady && _redisOffer) {
    try {
      const result = await _redisOffer.set(driverOfferKey(driverId), tripId, "EX", DRIVER_OFFER_LOCK_TTL_SEC, "NX");
      return result === "OK";
    } catch { /* fall through to in-process */ }
  }
  const active = driverActiveOfferCount.get(driverId) ?? 0;
  if (active >= 1) return false;
  driverActiveOfferCount.set(driverId, active + 1);
  return true;
}

async function releaseDriverOffer(driverId: string, tripId?: string): Promise<void> {
  if (_redisOfferReady && _redisOffer) {
    try {
      const key = driverOfferKey(driverId);
      if (tripId) {
        const current = await _redisOffer.get(key);
        if (current && current !== tripId) return;
      }
      await _redisOffer.del(key);
      return;
    } catch { /* fall through to in-process */ }
  }
  const n = driverActiveOfferCount.get(driverId) ?? 0;
  if (n <= 1) driverActiveOfferCount.delete(driverId);
  else driverActiveOfferCount.set(driverId, n - 1);
}

async function claimDispatchOwner(tripId: string): Promise<string | null> {
  const token = crypto.randomUUID();
  if (_redisOfferReady && _redisOffer) {
    try {
      const result = await _redisOffer.set(dispatchOwnerKey(tripId), token, "EX", DISPATCH_OWNER_TTL_SEC, "NX");
      return result === "OK" ? token : null;
    } catch { /* fall through */ }
  }
  return !activeDispatches.has(tripId) ? token : null;
}

async function refreshDispatchOwner(tripId: string, ownerToken?: string | null): Promise<void> {
  if (_redisOfferReady && _redisOffer) {
    try {
      const key = dispatchOwnerKey(tripId);
      if (ownerToken) {
        const current = await _redisOffer.get(key);
        if (current !== ownerToken) return;
      }
      await _redisOffer.expire(key, DISPATCH_OWNER_TTL_SEC);
    } catch { /* ignore */ }
  }
}

async function releaseDispatchOwner(tripId: string, ownerToken?: string | null): Promise<void> {
  if (_redisOfferReady && _redisOffer) {
    try {
      const key = dispatchOwnerKey(tripId);
      if (ownerToken) {
        const current = await _redisOffer.get(key);
        if (current && current !== ownerToken) return;
      }
      await _redisOffer.del(key);
      return;
    } catch { /* fall through */ }
  }
}

async function getDispatchOwnerToken(tripId: string): Promise<string | null> {
  if (_redisOfferReady && _redisOffer) {
    try {
      return await _redisOffer.get(dispatchOwnerKey(tripId));
    } catch {
      return null;
    }
  }
  return activeDispatches.has(tripId) ? (activeDispatches.get(tripId)?.ownerToken || null) : null;
}

async function stillOwnsDispatch(session: DispatchSession): Promise<boolean> {
  const active = activeDispatches.get(session.tripId);
  if (active && active !== session) return false;
  if (!session.ownerToken) return !_redisOfferReady || !_redisOffer;
  const current = await getDispatchOwnerToken(session.tripId);
  // CRITICAL FIX C4: If token doesn't match, we lost ownership (TTL expired, other pod claimed)
  if (current && current !== session.ownerToken) {
    console.warn(`[DISPATCH] Lost ownership of ${session.tripId} — current token: ${current}, our token: ${session.ownerToken}`);
    return false;
  }
  return !current || current === session.ownerToken;
}

async function reacquireDispatchOwner(session: DispatchSession): Promise<boolean> {
  const current = await getDispatchOwnerToken(session.tripId);
  if (current) {
    session.ownerToken = current;
    await persistDispatchSession(session);
    return false;
  }
  const claimed = await claimDispatchOwner(session.tripId);
  if (!claimed) return false;
  session.ownerToken = claimed;
  await persistDispatchSession(session);
  console.info("[DISPATCH] dispatch_owner_acquired", JSON.stringify({ tripId: session.tripId, source: "reaper" }));
  return true;
}

function attachDispatchOwnerHeartbeat(session: DispatchSession): void {
  if (session.ownerHeartbeatTimer) {
    clearInterval(session.ownerHeartbeatTimer);
    session.ownerHeartbeatTimer = null;
  }
  session.ownerHeartbeatTimer = setInterval(async () => {
    if (session.status !== "searching" && session.status !== "offered") {
      if (session.ownerHeartbeatTimer) {
        clearInterval(session.ownerHeartbeatTimer);
        session.ownerHeartbeatTimer = null;
      }
      return;
    }
    await refreshDispatchOwner(session.tripId, session.ownerToken ?? undefined);
  }, 10_000);
}

async function listPersistedDispatchTripIds(): Promise<string[]> {
  if (!_redisOfferReady || !_redisOffer) return [];
  const ids = new Set<string>();
  try {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await _redisOffer.scan(cursor, "MATCH", "dispatch_session:*", "COUNT", 100);
      cursor = String(nextCursor);
      for (const key of keys || []) {
        const tripId = String(key).slice("dispatch_session:".length);
        if (tripId) ids.add(tripId);
      }
    } while (cursor !== "0");
  } catch {
    return [];
  }
  return Array.from(ids);
}

async function getActiveDispatchTripIds(): Promise<string[]> {
  const ids = new Set<string>(Array.from(activeDispatches.keys()));
  const persisted = await listPersistedDispatchTripIds();
  for (const tripId of persisted) ids.add(tripId);
  return Array.from(ids);
}

setInterval(() => {
  const cutoff = Date.now() - DRIVER_FATIGUE_BACKOFF_MS * 4;
  Array.from(driverLastOfferedAt.entries()).forEach(([id, t]) => {
    if (t < cutoff) { driverLastOfferedAt.delete(id); driverActiveOfferCount.delete(id); }
  });
}, 60_000);

// ── Service-specific dispatch configuration ──────────────────────────────────

export interface DispatchConfig {
  radiusStepsKm: number[];
  driverTimeoutMs: number;
  maxTotalTimeMs: number;
  driversPerStep: number; // how many drivers to fetch per radius step
}

const DISPATCH_CONFIGS: Record<string, DispatchConfig> = {
  bike: { radiusStepsKm: [5, 8, 12, 15], driverTimeoutMs: 15000, maxTotalTimeMs: 300000, driversPerStep: 10 },
  auto: { radiusStepsKm: [5, 8, 12, 15], driverTimeoutMs: 15000, maxTotalTimeMs: 300000, driversPerStep: 10 },
  cab: { radiusStepsKm: [5, 8, 12, 15, 20], driverTimeoutMs: 15000, maxTotalTimeMs: 360000, driversPerStep: 10 },
  parcel: { radiusStepsKm: [5, 10, 15], driverTimeoutMs: 15000, maxTotalTimeMs: 240000, driversPerStep: 8 },
  b2b_parcel: { radiusStepsKm: [5, 10, 15], driverTimeoutMs: 15000, maxTotalTimeMs: 300000, driversPerStep: 8 },
  carpool: { radiusStepsKm: [5, 8, 12, 20], driverTimeoutMs: 15000, maxTotalTimeMs: 360000, driversPerStep: 10 },
  outstation: { radiusStepsKm: [5, 10, 15, 25], driverTimeoutMs: 15000, maxTotalTimeMs: 420000, driversPerStep: 10 },
};

const LOCATION_FRESHNESS_SECONDS = 150;
const MAX_IDLE_BONUS_MINUTES = 30;
// ETA is the strongest signal for pickup time — doubled from 0.15 to 0.30.
// Distance weight halved (ETA already captures proximity + traffic).
const DISPATCH_SCORE_WEIGHTS = {
  distance: 0.10,
  eta: 0.30,
  behavior: 0.25,
  rating: 0.15,
  responseSpeed: 0.08,
  completionRate: 0.08,
  idleBonus: 0.04,
} as const;

function getConfig(serviceType: string): DispatchConfig {
  return DISPATCH_CONFIGS[serviceType] || DISPATCH_CONFIGS.auto;
}

// ── Dispatch session state ───────────────────────────────────────────────────

interface DispatchSession {
  tripId: string;
  customerId: string;
  pickupLat: number;
  pickupLng: number;
  vehicleCategoryId?: string;
  vehicleType?: string;
  parcelVehicleCategory?: string; // e.g. "bike_parcel", "tata_ace" — for parcel vehicle-type filtering
  serviceType: string;
  config: DispatchConfig;

  // Trip metadata for socket payloads
  tripMeta: TripMeta;

  // State
  radiusIndex: number;
  driverQueue: DriverMatchScore[];
  queueIndex: number;
  currentOfferedDriverId: string | null;
  currentOfferId: string | null;
  ownerToken: string | null;
  offerExpiresAt: number | null;
  acceptedDriverId: string | null;
  pickupOtp: string | null;
  offerTimer: ReturnType<typeof setTimeout> | null;
  ownerHeartbeatTimer: ReturnType<typeof setInterval> | null;
  notifiedDriverIds: Set<string>;
  rejectedDriverIds: Set<string>;
  status: "searching" | "offered" | "accepted" | "cancelled" | "no_drivers" | "expired";
  createdAt: number;
  totalTimer: ReturnType<typeof setTimeout> | null;
  retryCount: number;      // how many full-radius restarts have been done
  retryTimer: ReturnType<typeof setTimeout> | null;
  femaleOnlyPass: boolean;
  femalePreferenceEnabled: boolean;
}

type DispatchSessionSnapshot = {
  tripId: string;
  customerId: string;
  pickupLat: number;
  pickupLng: number;
  vehicleCategoryId?: string;
  vehicleType?: string;
  parcelVehicleCategory?: string;
  serviceType: string;
  tripMeta: TripMeta;
  radiusIndex: number;
  queueIndex: number;
  driverQueue: DriverMatchScore[];
  currentOfferedDriverId: string | null;
  currentOfferId: string | null;
  ownerToken: string | null;
  offerExpiresAt: number | null;
  acceptedDriverId: string | null;
  pickupOtp: string | null;
  notifiedDriverIds: string[];
  rejectedDriverIds: string[];
  status: DispatchSession["status"];
  createdAt: number;
  retryCount: number;
  femaleOnlyPass: boolean;
  femalePreferenceEnabled: boolean;
};

type DispatchAuditStatus = "sent" | "rejected" | "timeout" | "accepted";

export interface TripMeta {
  refId: string;
  customerName: string;
  pickupAddress: string;
  destinationAddress: string;
  pickupShortName?: string;
  destinationShortName?: string;
  pickupLat: number;
  pickupLng: number;
  estimatedFare: number;
  estimatedDistance: number;
  paymentMethod: string;
  tripType: string;
  vehicleType?: string | null;
  vehicleCategoryName?: string | null;
}

export interface PendingDriverOfferPayload {
  offerId: string;
  tripId: string;
  expiresAt: number | null;
  timeoutMs: number;
  trip: Record<string, unknown>;
}

function logDispatchAudit(rideId: string, driverId: string, status: DispatchAuditStatus): void {
  console.log(`[DISPATCH] rideId=${rideId}, driverId=${driverId}, status=${status}`);
}

function getLocationAgeSeconds(updatedAt: unknown): number | null {
  if (!updatedAt) return null;
  const at = new Date(String(updatedAt));
  if (Number.isNaN(at.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - at.getTime()) / 1000));
}

function isDriverLocationFresh(updatedAt: unknown, thresholdSeconds = LOCATION_FRESHNESS_SECONDS): boolean {
  const ageSeconds = getLocationAgeSeconds(updatedAt);
  return ageSeconds !== null && ageSeconds <= thresholdSeconds;
}

function buildDispatchScore(input: {
  distanceKm: number;
  rating: number;
  avgResponseTimeSec: number;
  completionRate: number;
  behaviorScore: number;
  idleSeconds?: number;
  etaMinutes?: number | null;
  locationAgeSeconds?: number | null;
}): { final: number; breakdown: DriverMatchScore["scoreBreakdown"] } {
  const distKm = Number(input.distanceKm) || 99;
  const rating = Number(input.rating) || 3.0;
  const avgResp = Number(input.avgResponseTimeSec) || 60;
  const completionRate = Number(input.completionRate) || 0.8;
  const behaviorScore = Number(input.behaviorScore) || 50;
  const idleSeconds = Math.max(0, Number(input.idleSeconds) || 0);
  const etaMinutes = input.etaMinutes != null
    ? Math.max(0, Number(input.etaMinutes) || 0)
    : null;

  const distanceScore = Math.max(0, 1 - distKm / 25);
  const etaScore = Math.max(0, 1 - ((etaMinutes ?? Math.max(1, distKm * 3)) / 30));
  const behaviorNorm = Math.max(0, Math.min(1, behaviorScore / 100));
  const ratingScore = Math.max(0, Math.min(1, (rating - 1) / 4));
  const responseScore = Math.max(0, 1 - avgResp / 300);
  const completionScore = Math.max(0, Math.min(1, completionRate));
  const idleMinutes = Math.min(MAX_IDLE_BONUS_MINUTES, idleSeconds / 60);
  const idleBonusScore = Math.max(0, Math.min(1, idleMinutes / MAX_IDLE_BONUS_MINUTES));

  const final =
    distanceScore * DISPATCH_SCORE_WEIGHTS.distance +
    etaScore * DISPATCH_SCORE_WEIGHTS.eta +
    behaviorNorm * DISPATCH_SCORE_WEIGHTS.behavior +
    ratingScore * DISPATCH_SCORE_WEIGHTS.rating +
    responseScore * DISPATCH_SCORE_WEIGHTS.responseSpeed +
    completionScore * DISPATCH_SCORE_WEIGHTS.completionRate +
    idleBonusScore * DISPATCH_SCORE_WEIGHTS.idleBonus;

  return {
    final: Math.round(final * 1000) / 1000,
    breakdown: {
      distance: Math.round(distanceScore * 1000) / 1000,
      eta: Math.round(etaScore * 1000) / 1000,
      behavior: Math.round(behaviorNorm * 1000) / 1000,
      rating: Math.round(ratingScore * 1000) / 1000,
      responseSpeed: Math.round(responseScore * 1000) / 1000,
      completionRate: Math.round(completionScore * 1000) / 1000,
      idleBonus: Math.round(idleBonusScore * 1000) / 1000,
      final: Math.round(final * 1000) / 1000,
      etaMinutes: etaMinutes ?? undefined,
      locationAgeSeconds: input.locationAgeSeconds ?? undefined,
    },
  };
}

function formatScoreBreakdown(breakdown?: DriverMatchScore["scoreBreakdown"]): string {
  if (!breakdown) return "n/a";
  return [
    `distance=${breakdown.distance}`,
    `eta=${breakdown.eta}`,
    `etaMin=${breakdown.etaMinutes ?? "?"}`,
    `behavior=${breakdown.behavior}`,
    `rating=${breakdown.rating}`,
    `response=${breakdown.responseSpeed}`,
    `completion=${breakdown.completionRate}`,
    `idle=${breakdown.idleBonus}`,
    `age=${breakdown.locationAgeSeconds ?? "?"}s`,
    `final=${breakdown.final}`,
  ].join(" ");
}

/**
 * Surge-aware scoring formula (active when surgeMultiplier > 1.0):
 *   score = (etaScore * 0.50) + (ratingScore * 0.20) + (surgeZonePriority * 0.30)
 *
 * surgeZonePriority rewards drivers who are close to the pickup inside a surge zone
 * — they relieve demand fastest, which is the platform's highest priority under surge.
 *
 * Under no-surge conditions the full 7-factor buildDispatchScore() runs instead.
 */
function buildSurgeAwareScore(
  etaMinutes: number,
  rating: number,
  distanceKm: number,
  surgeMultiplier: number,
): number {
  const etaScore = Math.max(0, 1 - etaMinutes / 30);
  const ratingScore = Math.max(0, Math.min(1, (rating - 1) / 4));
  // Surge zone priority: high surge + close driver = highest priority
  const surgeIntensity = Math.min(1.0, (surgeMultiplier - 1.0) / 1.0); // 0 at 1x, 1.0 at 2x
  const proximityScore = Math.max(0, 1 - distanceKm / 15);
  const surgeZonePriority = surgeIntensity * proximityScore;

  return (etaScore * 0.50) + (ratingScore * 0.20) + (surgeZonePriority * 0.30);
}

async function rerankDriversWithEta(
  drivers: DriverMatchScore[],
  pickupLat: number,
  pickupLng: number,
  maxCandidates = 5,
): Promise<DriverMatchScore[]> {
  if (drivers.length <= 1) return drivers;
  const limit = Math.min(maxCandidates, drivers.length);
  const top = drivers.slice(0, limit);
  const rest = drivers.slice(limit);

  // Fetch surge once for the pickup — used by all drivers in this batch
  let surgeMultiplier = 1.0;
  try {
    const surgeInfo = await getSurgeInfo(pickupLat, pickupLng);
    surgeMultiplier = surgeInfo.multiplier;
  } catch { /* no-op — use 1.0 */ }

  const isSurgeActive = surgeMultiplier > 1.0;

  await Promise.all(top.map(async (driver) => {
    try {
      const eta = await getDistanceWithCache(driver.lat, driver.lng, pickupLat, pickupLng);
      const breakdown = driver.scoreBreakdown;

      if (isSurgeActive) {
        // Under surge: simplified 3-factor formula prioritises speed + proximity
        driver.score = buildSurgeAwareScore(
          eta.durationMinutes,
          driver.rating,
          driver.distanceKm,
          surgeMultiplier,
        );
      } else {
        // Normal: full 7-factor quality score
        const recomputed = buildDispatchScore({
          distanceKm: driver.distanceKm,
          rating: driver.rating,
          avgResponseTimeSec: driver.avgResponseTimeSec,
          completionRate: breakdown?.completionRate ?? 0.8,
          behaviorScore: (breakdown?.behavior ?? 0.5) * 100,
          idleSeconds: (breakdown?.idleBonus ?? 0) * MAX_IDLE_BONUS_MINUTES * 60,
          etaMinutes: eta.durationMinutes,
          locationAgeSeconds: breakdown?.locationAgeSeconds ?? null,
        });
        driver.score = recomputed.final;
        driver.scoreBreakdown = recomputed.breakdown;
      }
      // Always store ETA minutes in breakdown for customer notification
      if (driver.scoreBreakdown) {
        driver.scoreBreakdown.etaMinutes = eta.durationMinutes;
      }
    } catch {
      // Keep distance-based score if ETA fetch fails.
    }
  }));

  top.sort((a, b) => b.score - a.score);
  return [...top, ...rest];
}

async function loadDispatchGenderPreference(customerId: string, serviceType: string): Promise<boolean> {
  if (serviceType === "parcel" || serviceType === "b2b_parcel") return false;
  try {
    const prefR = await rawDb.execute(rawSql`
      SELECT
        u.gender,
        COALESCE(u.prefer_female_driver, false) as prefer_female_driver,
        COALESCE(up.preferred_gender, 'any') as preferred_gender,
        COALESCE(bs.value, '0') as female_to_female_matching
      FROM users u
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN business_settings bs ON bs.key_name = 'female_to_female_matching'
      WHERE u.id = ${customerId}::uuid
      LIMIT 1
    `).catch(() => ({ rows: [] as any[] }));
    const row = prefR.rows[0] as any;
    if (!row) return false;
    const customerGender = String(row.gender || "").toLowerCase();
    const preferFemale = row.prefer_female_driver === true || row.prefer_female_driver === "true";
    const preferredGender = String(row.preferred_gender || "any").toLowerCase();
    const featureEnabled = String(row.female_to_female_matching || "0") === "1";
    return featureEnabled && customerGender === "female" && (preferFemale || preferredGender === "female");
  } catch {
    return false;
  }
}

// ── Dispatch Engine (singleton) ──────────────────────────────────────────────

const activeDispatches = new Map<string, DispatchSession>();

function snapshotDispatchSession(session: DispatchSession): DispatchSessionSnapshot {
  return {
    tripId: session.tripId,
    customerId: session.customerId,
    pickupLat: session.pickupLat,
    pickupLng: session.pickupLng,
    vehicleCategoryId: session.vehicleCategoryId,
    vehicleType: session.vehicleType,
    parcelVehicleCategory: session.parcelVehicleCategory,
    serviceType: session.serviceType,
    tripMeta: session.tripMeta,
    radiusIndex: session.radiusIndex,
    queueIndex: session.queueIndex,
    driverQueue: session.driverQueue,
    currentOfferedDriverId: session.currentOfferedDriverId,
    currentOfferId: session.currentOfferId,
    ownerToken: session.ownerToken,
    offerExpiresAt: session.offerExpiresAt,
    acceptedDriverId: session.acceptedDriverId,
    pickupOtp: session.pickupOtp,
    notifiedDriverIds: Array.from(session.notifiedDriverIds),
    rejectedDriverIds: Array.from(session.rejectedDriverIds),
    status: session.status,
    createdAt: session.createdAt,
    retryCount: session.retryCount,
    femaleOnlyPass: session.femaleOnlyPass,
    femalePreferenceEnabled: session.femalePreferenceEnabled,
  };
}

async function persistDispatchSession(session: DispatchSession): Promise<void> {
  if (_redisOfferReady && _redisOffer) {
    try {
      await _redisOffer.set(
        dispatchSessionKey(session.tripId),
        JSON.stringify(snapshotDispatchSession(session)),
        "EX",
        DISPATCH_SESSION_TTL_SEC,
      );
    } catch { /* ignore */ }
  }
  await refreshDispatchOwner(session.tripId, session.ownerToken);
}

async function clearDispatchSessionPersistence(tripId: string, ownerToken?: string | null): Promise<void> {
  const session = activeDispatches.get(tripId);
  if (_redisOfferReady && _redisOffer) {
    try {
      await _redisOffer.del(dispatchSessionKey(tripId));
    } catch { /* ignore */ }
  }
  await releaseDispatchOwner(tripId, session?.ownerToken || ownerToken || null);
}

async function restoreDispatchSession(tripId: string): Promise<DispatchSession | null> {
  const existing = activeDispatches.get(tripId);
  if (existing) return existing;
  if (!_redisOfferReady || !_redisOffer) return null;
  try {
    const raw = await _redisOffer.get(dispatchSessionKey(tripId));
    if (!raw) return null;
    const snap = JSON.parse(raw) as DispatchSessionSnapshot;
    const config = getConfig(snap.serviceType);
    const restored: DispatchSession = {
      tripId: snap.tripId,
      customerId: snap.customerId,
      pickupLat: snap.pickupLat,
      pickupLng: snap.pickupLng,
      vehicleCategoryId: snap.vehicleCategoryId,
      vehicleType: snap.vehicleType,
      parcelVehicleCategory: snap.parcelVehicleCategory,
      serviceType: snap.serviceType,
      config,
      tripMeta: snap.tripMeta,
      radiusIndex: snap.radiusIndex,
      driverQueue: snap.driverQueue || [],
      queueIndex: snap.queueIndex,
      currentOfferedDriverId: snap.currentOfferedDriverId,
      currentOfferId: snap.currentOfferId,
      ownerToken: snap.ownerToken,
      offerExpiresAt: snap.offerExpiresAt,
      acceptedDriverId: snap.acceptedDriverId,
      pickupOtp: snap.pickupOtp,
      offerTimer: null,
      ownerHeartbeatTimer: null,
      notifiedDriverIds: new Set(snap.notifiedDriverIds || []),
      rejectedDriverIds: new Set(snap.rejectedDriverIds || []),
      status: snap.status,
      createdAt: snap.createdAt,
      totalTimer: null,
      retryCount: snap.retryCount,
      retryTimer: null,
      femaleOnlyPass: snap.femaleOnlyPass,
      femalePreferenceEnabled: snap.femalePreferenceEnabled,
    };
    activeDispatches.set(tripId, restored);
    attachDispatchOwnerHeartbeat(restored);

    // Re-attach timers using remaining time so pod restart doesn't reset the clocks
    if (restored.status === "searching" || restored.status === "offered") {
      const elapsed = Date.now() - restored.createdAt;
      const remainingTotalMs = config.maxTotalTimeMs - elapsed;
      if (remainingTotalMs <= 1000) {
        await expireDispatch(restored, "expired during recovery");
        return null;
      }
      restored.totalTimer = setTimeout(async () => {
        try {
          await expireDispatch(restored, "No pilots available nearby. Please try again.");
        } catch { /* ignore */ }
      }, remainingTotalMs);

      if (restored.status === "offered" && restored.offerExpiresAt) {
        const remainingOfferMs = restored.offerExpiresAt - Date.now();
        if (remainingOfferMs <= 1000) {
          if (restored.currentOfferedDriverId) {
            await onDriverRejected(tripId, restored.currentOfferedDriverId);
          }
        } else {
          restored.offerTimer = setTimeout(async () => {
            try {
              if (restored.currentOfferedDriverId) {
                await onDriverRejected(tripId, restored.currentOfferedDriverId);
              }
            } catch { /* ignore */ }
          }, remainingOfferMs);
        }
      }
    }

    return restored;
  } catch {
    return null;
  }
}

export async function getPendingDriverOffer(driverId: string): Promise<PendingDriverOfferPayload | null> {
  let tripId: string | null = null;
  if (_redisOfferReady && _redisOffer) {
    try {
      tripId = await _redisOffer.get(driverOfferKey(driverId));
    } catch {
      tripId = null;
    }
  }
  if (!tripId) {
    const local = Array.from(activeDispatches.values()).find(
      (session) => session.currentOfferedDriverId === driverId && session.status === "offered",
    );
    tripId = local?.tripId || null;
  }
  if (!tripId) return null;

  const session = activeDispatches.get(tripId) || await restoreDispatchSession(tripId);
  if (!session || session.currentOfferedDriverId !== driverId || session.status !== "offered" || !session.currentOfferId) {
    return null;
  }

  return {
    offerId: session.currentOfferId,
    tripId: session.tripId,
    expiresAt: session.offerExpiresAt,
    timeoutMs: session.config.driverTimeoutMs,
    trip: {
      tripId: session.tripId,
      ...session.tripMeta,
      timeoutMs: session.config.driverTimeoutMs,
    },
  };
}

export async function acknowledgePendingDriverOffer(
  driverId: string,
  tripId: string,
  offerId: string,
): Promise<boolean> {
  const session = activeDispatches.get(tripId) || await restoreDispatchSession(tripId);
  if (!session || session.currentOfferedDriverId !== driverId || session.currentOfferId !== offerId || session.status !== "offered") {
    return false;
  }

  if (_redisOfferReady && _redisOffer) {
    try {
      const currentTripId = await _redisOffer.get(driverOfferKey(driverId));
      if (currentTripId !== tripId) return false;
      const ttlMs = Math.max((session.offerExpiresAt || Date.now()) - Date.now(), 1000);
      await _redisOffer.expire(driverOfferKey(driverId), Math.max(1, Math.ceil(ttlMs / 1000)));
    } catch {
      return false;
    }
  }

  await persistDispatchSession(session);
  return true;
}

/**
 * Resolve the service type from trip_type and vehicle category name.
 * Maps the various trip_type values to dispatch config keys.
 */
export function resolveServiceType(
  tripType: string,
  vehicleCategoryName?: string
): string {
  const tt = (tripType || "").toLowerCase();
  const vc = (vehicleCategoryName || "").toLowerCase();

  if (tt === "parcel" || tt === "delivery") return "parcel";
  if (tt === "cargo" || tt === "b2b") return "b2b_parcel";
  if (tt === "carpool" || tt === "pool") return "carpool";
  if (tt === "intercity" || tt === "outstation") return "outstation";

  // Determine from vehicle category name fallback
  if (vc.includes("bike") || vc.includes("two")) return "bike";
  if (vc.includes("auto") || vc.includes("rickshaw")) return "auto";
  if (vc.includes("cab") || vc.includes("car") || vc.includes("sedan") || vc.includes("suv") || vc.includes("mini")) return "cab";

  return "auto"; // default
}

/**
 * Start the smart dispatch process for a trip.
 * This is the main entry point called after trip creation.
 */
export async function startDispatch(
  tripId: string,
  customerId: string,
  pickupLat: number,
  pickupLng: number,
  vehicleCategoryId: string | undefined,
  vehicleType: string | undefined,
  serviceType: string,
  tripMeta: TripMeta,
  parcelVehicleCategory?: string,
  initialRejectedDriverIds: string[] = []
): Promise<void> {
  // Cancel any existing dispatch for this trip (defensive)
  cancelDispatch(tripId);
  const ownerClaimed = await claimDispatchOwner(tripId);
  if (!ownerClaimed) {
    console.log(`[DISPATCH] Another pod already owns trip ${tripId}; skipping duplicate start`);
    return;
  }

  const config = getConfig(serviceType);
  const femalePreferenceEnabled = await loadDispatchGenderPreference(customerId, serviceType);

  const session: DispatchSession = {
    tripId,
    customerId,
    pickupLat,
    pickupLng,
    vehicleCategoryId,
    vehicleType,
    parcelVehicleCategory,
    serviceType,
    config,
    tripMeta,
    radiusIndex: 0,
    driverQueue: [],
    queueIndex: 0,
    currentOfferedDriverId: null,
    currentOfferId: null,
    ownerToken: ownerClaimed,
    offerExpiresAt: null,
    acceptedDriverId: null,
    pickupOtp: null,
    offerTimer: null,
    ownerHeartbeatTimer: null,
    notifiedDriverIds: new Set(),
    rejectedDriverIds: new Set(initialRejectedDriverIds.filter(Boolean)),
    status: "searching",
    createdAt: Date.now(),
    totalTimer: null,
    retryCount: 0,
    retryTimer: null,
    femaleOnlyPass: femalePreferenceEnabled,
    femalePreferenceEnabled,
  };

  activeDispatches.set(tripId, session);
  await persistDispatchSession(session);

  // Set max total timeout — auto-cancel if no driver found in time
  session.totalTimer = setTimeout(async () => {
    if (!await stillOwnsDispatch(session)) return;
    if (session.status === "searching" || session.status === "offered") {
      await expireDispatch(session, "No pilots available nearby. Please try again.");
    }
  }, config.maxTotalTimeMs);

  attachDispatchOwnerHeartbeat(session);
  // Tie the interval lifetime to the session's totalTimer so it cleans up automatically
  const origTotalTimer = session.totalTimer;
  session.totalTimer = setTimeout(async () => {
    if (session.ownerHeartbeatTimer) {
      clearInterval(session.ownerHeartbeatTimer);
      session.ownerHeartbeatTimer = null;
    }
    if (!await stillOwnsDispatch(session)) return;
    if (session.status === "searching" || session.status === "offered") {
      await expireDispatch(session, "No pilots available nearby. Please try again.");
    }
  }, config.maxTotalTimeMs);
  clearTimeout(origTotalTimer); // we replaced the timer above

  console.log(
    `[DISPATCH] trip=${tripId} service=${serviceType} booking.vehicleType=${vehicleType ?? "missing"} ` +
      `vehicleCategoryId=${vehicleCategoryId ?? "missing"} pickup=(${pickupLat},${pickupLng}) ` +
      `radiusSteps=${config.radiusStepsKm.join("->")} timeout=${config.driverTimeoutMs / 1000}s/driver ` +
      `femaleOnlyPass=${femalePreferenceEnabled}`,
  );

  // Begin the first radius step
  await searchAndDispatchNextRadius(session);
}

export async function restartDispatchForTrip(
  tripId: string,
  options?: {
    additionalRejectedDriverIds?: string[];
    preserveSessionRejections?: boolean;
  }
): Promise<void> {
  const additionalRejectedDriverIds = options?.additionalRejectedDriverIds || [];
  const existingSession = activeDispatches.get(tripId);
  const preservedRejected = options?.preserveSessionRejections !== false
    ? Array.from(existingSession?.rejectedDriverIds || [])
    : [];

  const tripRes = await rawDb.execute(rawSql`
    SELECT
      t.id,
      t.customer_id,
      t.pickup_lat,
      t.pickup_lng,
      t.pickup_address,
      t.destination_address,
      t.pickup_short_name,
      t.destination_short_name,
      t.estimated_fare,
      t.estimated_distance,
      t.payment_method,
      t.trip_type,
      t.vehicle_category_id,
      t.driver_id,
      t.ref_id,
      t.current_status,
      t.rejected_driver_ids,
      u.full_name as customer_name,
      vc.name as vehicle_category_name,
      COALESCE(vc.vehicle_type, vc.name, '') as vehicle_category_key
    FROM trip_requests t
    JOIN users u ON u.id = t.customer_id
    LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
    WHERE t.id = ${tripId}::uuid
    LIMIT 1
  `);

  if (!tripRes.rows.length) {
    throw new Error(`Trip ${tripId} not found for restart`);
  }

  const trip = tripRes.rows[0] as any;
  const currentStatus = String(trip.current_status || "");
  if (currentStatus === "accepted") {
    await resetRideForRedispatch(tripId, {
      actorType: "system",
      reason: "redispatch_recovery",
      rejectedDriverId: trip.driver_id ? String(trip.driver_id) : null,
      clearPickupOtp: true,
    });
    if (trip.driver_id) {
      await rawDb.execute(rawSql`
        UPDATE users
        SET current_trip_id=NULL
        WHERE id=${trip.driver_id}::uuid
          AND current_trip_id=${tripId}::uuid
      `).catch(() => {});
    }
  } else if (!["searching", "driver_assigned"].includes(currentStatus)) {
    throw new Error(`Trip ${tripId} is not dispatchable from status ${trip.current_status}`);
  }

  const rejectedIds = Array.from(new Set([
    ...(((trip.rejected_driver_ids as string[]) || []).filter(Boolean)),
    ...preservedRejected,
    ...additionalRejectedDriverIds.filter(Boolean),
  ]));

  const serviceType = resolveServiceType(trip.trip_type, trip.vehicle_category_name);
  const parcelVehicleCategory = serviceType === "parcel" || serviceType === "b2b_parcel"
    ? normalizeVehicleKey(trip.vehicle_category_key || trip.vehicle_category_name)
    : undefined;
  const tripVehicleType =
    trip.vehicle_type || await getDriverSocketRoomKeyForCategoryId(trip.vehicle_category_id);

  await startDispatch(
    trip.id,
    trip.customer_id,
    Number(trip.pickup_lat),
    Number(trip.pickup_lng),
    trip.vehicle_category_id || undefined,
    tripVehicleType || undefined,
    serviceType,
    {
      refId: trip.ref_id,
      customerName: trip.customer_name || "Customer",
      pickupAddress: trip.pickup_address || "",
      destinationAddress: trip.destination_address || "",
      pickupShortName: trip.pickup_short_name || undefined,
      destinationShortName: trip.destination_short_name || undefined,
      pickupLat: Number(trip.pickup_lat),
      pickupLng: Number(trip.pickup_lng),
      estimatedFare: Number(trip.estimated_fare) || 0,
      estimatedDistance: Number(trip.estimated_distance) || 0,
      paymentMethod: trip.payment_method || "cash",
      tripType: trip.trip_type || "ride",
    },
    parcelVehicleCategory,
    rejectedIds
  );
}

const ATOMIC_ACCEPT_LUA = `
local owner = redis.call("GET", KEYS[1])
if not owner then
  return cjson.encode({ err = "NO_OWNER" })
end

if owner ~= ARGV[1] then
  return cjson.encode({ err = "OWNER_MISMATCH" })
end

local offerTrip = redis.call("GET", KEYS[2])
if not offerTrip then
  return cjson.encode({ err = "NO_OFFER" })
end

if offerTrip ~= ARGV[2] then
  return cjson.encode({ err = "OFFER_MISMATCH" })
end

local sessionRaw = redis.call("GET", KEYS[3])
if not sessionRaw then
  return cjson.encode({ err = "NO_SESSION" })
end

local decoded = cjson.decode(sessionRaw)
if decoded.currentOfferId ~= ARGV[3] then
  return cjson.encode({ err = "STALE_OFFER" })
end

decoded.status = "accepted"
decoded.acceptedDriverId = ARGV[4]
decoded.currentOfferedDriverId = ARGV[4]
decoded.pickupOtp = ARGV[6]
redis.call("SET", KEYS[3], cjson.encode(decoded), "EX", ARGV[5])
redis.call("DEL", KEYS[2])
return cjson.encode({ ok = "ACCEPTED" })
`;

type AtomicAcceptResult =
  | { ok: true; ownerToken: string; offerId: string }
  | { ok: false; code: "NO_OWNER" | "OWNER_MISMATCH" | "NO_OFFER" | "OFFER_MISMATCH" | "NO_SESSION" | "STALE_OFFER" | "ACCEPT_FAILED" };

export async function atomicAcceptDispatchOffer(
  tripId: string,
  driverId: string,
  options?: { pickupOtp?: string | null },
): Promise<AtomicAcceptResult> {
  const session = activeDispatches.get(tripId) || await restoreDispatchSession(tripId);
  if (!session || !session.ownerToken || !session.currentOfferId) {
    return { ok: false, code: "NO_SESSION" };
  }
  if (session.currentOfferedDriverId !== driverId) {
    return { ok: false, code: "STALE_OFFER" };
  }

  if (_redisOfferReady && _redisOffer) {
    try {
      const raw = await _redisOffer.eval(
        ATOMIC_ACCEPT_LUA,
        3,
        dispatchOwnerKey(tripId),
        driverOfferKey(driverId),
        dispatchSessionKey(tripId),
        session.ownerToken,
        tripId,
        session.currentOfferId,
        driverId,
        String(DISPATCH_SESSION_TTL_SEC),
        options?.pickupOtp || "",
      );
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed?.ok === "ACCEPTED") {
        session.status = "accepted";
        session.acceptedDriverId = driverId;
        session.pickupOtp = options?.pickupOtp || null;
        await persistDispatchSession(session);
        return { ok: true, ownerToken: session.ownerToken, offerId: session.currentOfferId };
      }
      return {
        ok: false,
        code: (parsed?.err || "ACCEPT_FAILED") as "NO_OWNER" | "OWNER_MISMATCH" | "NO_OFFER" | "OFFER_MISMATCH" | "NO_SESSION" | "STALE_OFFER" | "ACCEPT_FAILED",
      };
    } catch {
      return { ok: false, code: "ACCEPT_FAILED" };
    }
  }

  // No Redis: fall back to DB-level atomic state transition so only one accept wins.
  // CRITICAL FIX C1: Use FOR UPDATE NOWAIT to prevent double-acceptance race condition
  try {
    const guardR = await rawDb.execute(rawSql`
      WITH locked AS (
        SELECT id FROM trip_requests
        WHERE id = ${tripId}::uuid
        FOR UPDATE NOWAIT
      )
      UPDATE trip_requests
      SET current_status = 'accepted',
          status = 'ACCEPTED',
          accepted_at = COALESCE(accepted_at, NOW()),
          driver_id = ${driverId}::uuid,
          updated_at = NOW()
      WHERE id = ${tripId}::uuid
        AND current_status = 'driver_assigned'
        AND (driver_id IS NULL OR driver_id = ${driverId}::uuid)
      RETURNING id
    `);
    if (!guardR.rows.length) {
      return { ok: false, code: "ACCEPT_FAILED" };
    }
  } catch {
    return { ok: false, code: "ACCEPT_FAILED" };
  }
  session.status = "accepted";
  session.acceptedDriverId = driverId;
  session.pickupOtp = options?.pickupOtp || null;
  await releaseDriverOffer(driverId, tripId);
  await persistDispatchSession(session);
  return { ok: true, ownerToken: session.ownerToken, offerId: session.currentOfferId };
}

export async function rollbackAtomicAcceptDispatchOffer(tripId: string, driverId: string): Promise<void> {
  const session = activeDispatches.get(tripId) || await restoreDispatchSession(tripId);
  if (!session) return;
  if (session.currentOfferedDriverId && session.currentOfferedDriverId !== driverId) return;
  session.status = "searching";
  session.currentOfferedDriverId = null;
  session.currentOfferId = null;
  session.offerExpiresAt = null;
  session.acceptedDriverId = null;
  session.pickupOtp = null;
  await persistDispatchSession(session);
}

/**
 * Called when a driver accepts a trip (from accept-trip endpoint or socket).
 * Clears the dispatch session and verifies driver is still online.
 */
export async function onDriverAccepted(tripId: string, driverId: string): Promise<void> {
  const session = activeDispatches.get(tripId) || await restoreDispatchSession(tripId);
  if (!session) return;

  session.status = "accepted";
  session.acceptedDriverId = driverId;
  session.offerExpiresAt = null;
  clearTimers(session);
  await releaseDriverOffer(driverId, tripId); // release concurrent offer slot

  // Notify all previously-notified (but not accepted) drivers that trip is taken
  if (io) {
    Array.from(session.notifiedDriverIds).forEach((notifiedId) => {
      if (notifiedId !== driverId) {
        io.to(`user:${notifiedId}`).emit("trip:request_taken", { tripId });
      }
    });
  }

  // Record accepted outcome for surge feedback loop
  const waitMs = Date.now() - session.createdAt;
  recordDispatchOutcome(session.pickupLat, session.pickupLng, true, waitMs);

  await clearDispatchSessionPersistence(tripId, session.ownerToken);
  activeDispatches.delete(tripId);
  console.log(`[DISPATCH] ✅ DRIVER ACCEPTED — trip=${tripId} driver=${driverId} waitMs=${waitMs}`);
  logDispatchAudit(tripId, driverId, "accepted");

  // ─────────────────────────────────────────────────────────────────────────────
  // FIX #1: Verify driver is still online 5 seconds after accepting
  // If driver is ghost/offline → reassign to next driver
  // ─────────────────────────────────────────────────────────────────────────────

  (async () => {
    try {
      const { verifyDriverAfterAccept, logInfo } = await import("./hardening");
      const isOnline = await verifyDriverAfterAccept(driverId, tripId);
      if (isOnline) {
        await logInfo('DISPATCH-VERIFY', 'Driver verified online after accept', {
          driverId: driverId.toString().slice(0, 8),
          tripId: tripId.toString().slice(0, 8),
        });
      }
      // If not online, verifyDriverAfterAccept handles reassignment
    } catch (e: any) {
      console.error('[Driver verification] Error:', e.message);
    }
  })();
}

/**
 * Called when a driver explicitly rejects a trip.
 * Immediately moves to next driver in queue.
 */
export async function onDriverRejected(tripId: string, driverId: string): Promise<void> {
  const session = activeDispatches.get(tripId) || await restoreDispatchSession(tripId);
  if (!session) return;

  // Clear offer timer for current driver
  if (session.offerTimer) {
    clearTimeout(session.offerTimer);
    session.offerTimer = null;
  }

  session.rejectedDriverIds.add(driverId);
  session.currentOfferedDriverId = null;
  session.currentOfferId = null;
  session.offerExpiresAt = null;
  await releaseDriverOffer(driverId, tripId); // release concurrent offer slot
  await persistDispatchSession(session);

  // Emit timeout/rejection to driver
  if (io) {
    io.to(`user:${driverId}`).emit("trip:offer_timeout", { tripId });
  }

  // Notify customer we're still searching
  emitCustomerSearchStatus(session);

  console.log(`[DISPATCH] Driver ${driverId} rejected trip ${tripId} — moving to next`);
  logDispatchAudit(tripId, driverId, "rejected");

  // Try next driver in queue
  await dispatchNextDriver(session);
}

/**
 * Cancel dispatch for a trip (customer cancelled, system cancel, etc.)
 */
export function cancelDispatch(tripId: string): void {
  const session = activeDispatches.get(tripId);
  if (!session) return;

  session.status = "cancelled";
  clearTimers(session);
  session.currentOfferId = null;
  session.offerExpiresAt = null;

  // Notify current offered driver that trip was cancelled
  if (session.currentOfferedDriverId && io) {
    io.to(`user:${session.currentOfferedDriverId}`).emit("trip:cancelled", {
      tripId,
      cancelledBy: "customer",
    });
  }

  clearDispatchSessionPersistence(tripId, session.ownerToken).catch(() => undefined);
  activeDispatches.delete(tripId);
  console.log(`[DISPATCH] Cancelled for trip ${tripId}`);
}

/**
 * Check if a trip has an active dispatch session.
 */
export function hasActiveDispatch(tripId: string): boolean {
  return activeDispatches.has(tripId);
}

/**
 * Get dispatch status for monitoring/debugging.
 */
export function getDispatchStatus(tripId: string) {
  const session = activeDispatches.get(tripId);
  if (!session) return null;
  const config = session.config;
  const currentRadius = config.radiusStepsKm[session.radiusIndex] || config.radiusStepsKm[config.radiusStepsKm.length - 1];
  return {
    tripId,
    serviceType: session.serviceType,
    status: session.status,
    currentRadiusKm: currentRadius,
    radiusStep: session.radiusIndex + 1,
    totalRadiusSteps: config.radiusStepsKm.length,
    driversInQueue: session.driverQueue.length,
    queuePosition: session.queueIndex,
    notifiedCount: session.notifiedDriverIds.size,
    rejectedCount: session.rejectedDriverIds.size,
    currentOfferedDriverId: session.currentOfferedDriverId,
    elapsedMs: Date.now() - session.createdAt,
  };
}

/**
 * Get count of all active dispatches (for admin monitoring).
 */
export function getActiveDispatchCount(): number {
  return activeDispatches.size;
}

// ── Internal dispatch logic ──────────────────────────────────────────────────

/**
 * Search for drivers within the current radius step and start dispatching.
 */
async function searchAndDispatchNextRadius(session: DispatchSession): Promise<void> {
  if (!await stillOwnsDispatch(session)) return;
  if (session.status !== "searching" && session.status !== "offered") return;

  const config = session.config;
  if (session.radiusIndex >= config.radiusStepsKm.length) {
    if (session.femaleOnlyPass) {
      session.femaleOnlyPass = false;
      session.radiusIndex = 0;
      session.driverQueue = [];
      session.queueIndex = 0;
      await persistDispatchSession(session);
      console.log(`[DISPATCH] trip=${session.tripId} no female pilots found; falling back to nearest eligible ${session.vehicleType || session.serviceType} drivers`);
      emitCustomerSearchStatus(session);
      await searchAndDispatchNextRadius(session);
      return;
    }
    // All radius steps exhausted
    expireDispatch(session, "No pilots available nearby. Please try again.");
    return;
  }

  const radiusKm = config.radiusStepsKm[session.radiusIndex];
  await persistDispatchSession(session);

  // Build exclude list: all previously notified + rejected drivers
  const excludeIds: string[] = [
    ...Array.from(session.notifiedDriverIds),
    ...Array.from(session.rejectedDriverIds),
    session.customerId, // don't send to the customer (they might also be a driver)
  ].filter(Boolean);
  // Deduplicate
  const uniqueExcludeIds = Array.from(new Set(excludeIds));

  console.log(`[DISPATCH] Trip ${session.tripId} — searching radius ${radiusKm}km (step ${session.radiusIndex + 1}/${config.radiusStepsKm.length}) femaleOnly=${session.femaleOnlyPass}`);

  try {
    // Use parcel-specific driver search for parcel/b2b_parcel service types
    let drivers: DriverMatchScore[];
    if ((session.serviceType === "parcel" || session.serviceType === "b2b_parcel") && session.parcelVehicleCategory) {
      const parcelDrivers = await findParcelCapableDrivers(
        session.pickupLat,
        session.pickupLng,
        radiusKm,
        session.parcelVehicleCategory,
        uniqueExcludeIds,
        config.driversPerStep
      );
      // Convert to DriverMatchScore format
      drivers = parcelDrivers.map((row: any) => {
        const distKm = Number(row.distance_km) || 99;
        const rating = Number(row.rating) || 3.0;
        const behaviorScore = Number(row.behavior_score) || 50;
        const scoreMeta = buildDispatchScore({
          distanceKm: distKm,
          rating,
          avgResponseTimeSec: 60,
          completionRate: 0.8,
          behaviorScore,
          idleSeconds: 0,
          locationAgeSeconds: getLocationAgeSeconds(row.updated_at),
        });
        return {
          driverId: row.id,
          fullName: row.full_name || "Pilot",
          phone: row.phone || "",
          lat: Number(row.lat),
          lng: Number(row.lng),
          distanceKm: Math.round(distKm * 100) / 100,
          rating: Math.round(rating * 10) / 10,
          totalTrips: 0,
          avgResponseTimeSec: 60,
          score: scoreMeta.final,
          fcmToken: row.fcm_token || undefined,
          scoreBreakdown: scoreMeta.breakdown,
        };
      });
      drivers.sort((a, b) => b.score - a.score);
      drivers = await rerankDriversWithEta(drivers, session.pickupLat, session.pickupLng, 4);
    } else {
      drivers = await findDriversInRadius(
        session.pickupLat,
        session.pickupLng,
        radiusKm,
        session.vehicleCategoryId,
        session.vehicleType,
        uniqueExcludeIds,
        config.driversPerStep,
        session.femaleOnlyPass
      );
      drivers = await rerankDriversWithEta(drivers, session.pickupLat, session.pickupLng);
    }

    if (session.status !== "searching" && session.status !== "offered") return;

    if (drivers.length === 0) {
      // No drivers at this radius — try next
      session.radiusIndex++;
      await persistDispatchSession(session);
      if (session.status === "searching" || session.status === "offered") {
        emitCustomerSearchStatus(session);
      }
      await searchAndDispatchNextRadius(session);
      return;
    }

    // Set up the driver queue for this radius
    session.driverQueue = drivers;
    session.queueIndex = 0;
    await persistDispatchSession(session);

    // Notify customer about search progress
    if (session.status === "searching" || session.status === "offered") {
      emitCustomerSearchStatus(session);
    }

    // Start dispatching sequentially
    await dispatchNextDriver(session);
  } catch (err: any) {
    console.error(`[DISPATCH] Error searching radius for trip ${session.tripId}:`, err.message);
    // On error, try next radius
    session.radiusIndex++;
    await searchAndDispatchNextRadius(session);
  }
}

/**
 * Dispatch to the next driver in the queue.
 * If queue exhausted, expand to next radius.
 */
async function dispatchNextDriver(session: DispatchSession): Promise<void> {
  if (!await stillOwnsDispatch(session)) return;
  if (session.status !== "searching" && session.status !== "offered") return;

  // Verify trip is still in 'searching' status in DB
  try {
    const tripCheck = await rawDb.execute(rawSql`
      SELECT current_status FROM trip_requests WHERE id=${session.tripId}::uuid
    `);
    const dbStatus = (tripCheck.rows[0] as any)?.current_status;
    if (!dbStatus || (dbStatus !== "searching" && dbStatus !== "driver_assigned")) {
      // Trip is no longer searchable — clean up
      session.status = "cancelled";
      clearTimers(session);
      activeDispatches.delete(session.tripId);
      return;
    }
  } catch {
    // DB check failed — continue dispatch (trip might still be valid)
  }

  session.status = "searching";
  session.currentOfferedDriverId = null;
  session.currentOfferId = null;
  session.offerExpiresAt = null;
  session.acceptedDriverId = null;
  session.pickupOtp = null;
  await persistDispatchSession(session);

  // Find next un-notified, un-rejected driver in queue
  while (session.queueIndex < session.driverQueue.length) {
    const driver = session.driverQueue[session.queueIndex];
    session.queueIndex++;

    if (session.notifiedDriverIds.has(driver.driverId) || session.rejectedDriverIds.has(driver.driverId)) {
      continue; // Skip already-notified or rejected drivers
    }

    // H11 FIX: Fatigue backoff — check in-memory first, then Redis fallback for cross-pod accuracy
    let lastOffered = driverLastOfferedAt.get(driver.driverId) ?? 0;
    if (lastOffered === 0 && _redisOfferReady && _redisOffer) {
      try {
        const redisFatigue = await _redisOffer.get(driverFatigueKey(driver.driverId));
        if (redisFatigue) { lastOffered = parseInt(redisFatigue, 10) || 0; }
      } catch { /* ignore Redis errors */ }
    }
    if (Date.now() - lastOffered < DRIVER_FATIGUE_BACKOFF_MS) continue;

    // Atomically claim offer slot (Redis NX across pods, in-process fallback)
    if (!await tryClaimDriverOffer(driver.driverId, session.tripId)) continue;

    // Verify driver is still available (online, no active trip)
    const isAvailable = await checkDriverAvailability(driver.driverId);
    if (!isAvailable) { await releaseDriverOffer(driver.driverId, session.tripId); continue; }

    // Send request to this single driver
    await offerTripToDriver(session, driver);
    return;
  }

  // Queue exhausted — expand to next radius
  session.radiusIndex++;
  session.driverQueue = [];
  session.queueIndex = 0;
  await persistDispatchSession(session);
  await searchAndDispatchNextRadius(session);
}

/**
 * Send trip request to a single driver and start the acceptance timer.
 */
async function offerTripToDriver(session: DispatchSession, driver: DriverMatchScore): Promise<void> {
  if (!await stillOwnsDispatch(session)) return;
  const assignedRide = await assignRideToDriver(session.tripId, driver.driverId, {
    serviceType: session.serviceType,
    vehicleType: session.vehicleType || null,
    distanceKm: driver.distanceKm,
    score: driver.score,
  });
  if (!assignedRide) {
    console.warn(`[DISPATCH] Atomic assign failed for trip=${session.tripId} driver=${driver.driverId}; trying next driver`);
    await dispatchNextDriver(session);
    return;
  }

  session.status = "offered";
  session.currentOfferedDriverId = driver.driverId;
  session.currentOfferId = crypto.randomUUID();
  session.offerExpiresAt = Date.now() + session.config.driverTimeoutMs;
  session.acceptedDriverId = null;
  session.pickupOtp = null;
  session.notifiedDriverIds.add(driver.driverId);
  await persistDispatchSession(session);
  // Offer slot already claimed atomically in dispatchNextDriver via tryClaimDriverOffer

  // ETA from score breakdown (set by rerankDriversWithEta); fallback to distance estimate
  const etaMinutes: number =
    driver.scoreBreakdown?.etaMinutes ??
    Math.max(1, Math.round((driver.distanceKm / 25) * 60));

  const payload = {
    tripId: session.tripId,
    ...session.tripMeta,
    offerId: session.currentOfferId,
    expiresAt: session.offerExpiresAt,
    aiScore: driver.score,
    driverDistanceKm: driver.distanceKm,
    etaMinutes,
    timeoutMs: session.config.driverTimeoutMs,
  };

  await notifyUser(driver.driverId, "trip:new_request", payload, {
    title: "New Ride Request!",
    body: `${session.tripMeta.customerName} - ${session.tripMeta.pickupAddress} - Rs.${session.tripMeta.estimatedFare}`,
    dataOnly: true,
    channelId: "trip_alerts",
  });

  // Notify customer of the ETA so the app can show "Driver arriving in ~X min"
  if (io) {
    io.to(`user:${session.customerId}`).emit("trip:driver_eta", {
      tripId: session.tripId,
      etaMinutes,
      driverDistanceKm: Math.round(driver.distanceKm * 10) / 10,
    });
  }

  // FCM notification (background/killed app)
  const socketRoom = io?.sockets?.adapter?.rooms?.get(`user:${driver.driverId}`);
  const socketConnected = !!(socketRoom && socketRoom.size > 0);
  if (!socketConnected && driver.fcmToken) {
    notifyDriverNewRide({
      fcmToken: driver.fcmToken || null,
      driverName: driver.fullName,
      customerName: session.tripMeta.customerName,
      pickupAddress: session.tripMeta.pickupAddress,
      estimatedFare: session.tripMeta.estimatedFare,
      tripId: session.tripId,
    }).then(() => {
      console.log(`[DISPATCH] ✅ FCM sent — trip=${session.tripId} pilot=${driver.driverId} (${driver.fullName}) token=${driver.fcmToken!.substring(0, 15)}...`);
    }).catch((err: any) => {
      console.error(`[DISPATCH] ❌ FCM FAILED — trip=${session.tripId} pilot=${driver.driverId} error=${err?.message || err}`);
      // FCM failed fallback: re-emit via socket (covers apps that were background but socket stayed open)
      if (io) {
        io.to(`user:${driver.driverId}`).emit("trip:new_request", {
          ...payload,
          _fcmFallback: true,
        });
        console.log(`[DISPATCH] 🔁 FCM fallback socket emit — trip=${session.tripId} pilot=${driver.driverId}`);
      }
    });
  } else {
    console.warn(`[DISPATCH] ⚠️  No FCM token for pilot=${driver.driverId} (${driver.fullName}) — socket-only`);
    // No FCM token — socket is the only channel. Already emitted above. Log for monitoring.
  }

  console.log(`[DISPATCH] 📣 PILOT NOTIFIED — trip=${session.tripId} → pilot=${driver.driverId} (${driver.fullName}, ${driver.distanceKm}km away, score=${driver.score}) socketOnline=${socketConnected} fcmToken=${driver.fcmToken ? driver.fcmToken.substring(0, 15) + '...' : 'MISSING'} timeout=${session.config.driverTimeoutMs / 1000}s`);
  console.log(`[DISPATCH] score_breakdown trip=${session.tripId} driver=${driver.driverId} ${formatScoreBreakdown(driver.scoreBreakdown)}`);
  logDispatchAudit(session.tripId, driver.driverId, "sent");

  // Start timeout timer — if driver doesn't respond, auto-skip
  session.offerTimer = setTimeout(async () => {
    if (!await stillOwnsDispatch(session)) return;
    if (session.currentOfferedDriverId !== driver.driverId) return;
    if (session.status !== "offered") return;
    await handleOfferTimeout(session, "Driver offer timed out");
  }, session.config.driverTimeoutMs);
}

async function handleOfferTimeout(session: DispatchSession, reason: string): Promise<void> {
  if (!await stillOwnsDispatch(session)) return;
  const driverId = session.currentOfferedDriverId;
  if (!driverId || session.status !== "offered") return;

  console.log(`[DISPATCH] Driver ${driverId} timed out on trip ${session.tripId}`);
  logDispatchAudit(session.tripId, driverId, "timeout");
  console.info("[DISPATCH] offer_timeout_count", JSON.stringify({ tripId: session.tripId, driverId }));

  await releaseDriverOffer(driverId, session.tripId);
  recordDispatchOutcome(session.pickupLat, session.pickupLng, false, session.config.driverTimeoutMs);

  session.rejectedDriverIds.add(driverId);
  session.currentOfferedDriverId = null;
  session.currentOfferId = null;
  session.offerExpiresAt = null;
  await persistDispatchSession(session);

  await resetRideForRedispatch(session.tripId, {
    actorId: driverId,
    actorType: "driver",
    reason,
    rejectedDriverId: driverId,
  }).catch((err: any) => {
    console.error(`[DISPATCH] Failed to reset timed-out trip ${session.tripId}:`, err.message);
  });

  if (io) {
    io.to(`user:${driverId}`).emit("trip:offer_timeout", { tripId: session.tripId });
  }

  emitCustomerSearchStatus(session);
  await dispatchNextDriver(session);
}

async function reconcileAcceptedDispatch(session: DispatchSession): Promise<void> {
  if (!await stillOwnsDispatch(session)) return;
  const acceptedDriverId = session.acceptedDriverId || session.currentOfferedDriverId;
  if (!acceptedDriverId) return;

  const tripR = await rawDb.execute(rawSql`
    SELECT id, current_status, driver_id
    FROM trip_requests
    WHERE id=${session.tripId}::uuid
    LIMIT 1
  `);
  if (!tripR.rows.length) {
    session.status = "cancelled";
    await persistDispatchSession(session);
    return;
  }

  const trip = tripR.rows[0] as any;
  const currentStatus = String(trip.current_status || "");
  if (currentStatus === "accepted" && String(trip.driver_id || "") === acceptedDriverId) {
    await onDriverAccepted(session.tripId, acceptedDriverId);
    return;
  }

  if (!["searching", "driver_assigned"].includes(currentStatus)) {
    session.status = "cancelled";
    await persistDispatchSession(session);
    return;
  }

  await rawDb.transaction(async (trx) => {
    const locked = await trx.execute(rawSql`
      SELECT id, current_status, driver_id
      FROM trip_requests
      WHERE id=${session.tripId}::uuid
      FOR UPDATE
    `);
    const row = locked.rows[0] as any;
    const status = String(row?.current_status || "");
    if (!row || !["searching", "driver_assigned"].includes(status)) return;

    await trx.execute(rawSql`
      UPDATE trip_requests
      SET current_status='accepted',
          driver_id=${acceptedDriverId}::uuid,
          pickup_otp=COALESCE(pickup_otp, ${session.pickupOtp || null}),
          driver_accepted_at=COALESCE(driver_accepted_at, NOW()),
          driver_arriving_at=COALESCE(driver_arriving_at, NOW()),
          updated_at=NOW()
      WHERE id=${session.tripId}::uuid
    `);
    await trx.execute(rawSql`
      UPDATE users
      SET current_trip_id=${session.tripId}::uuid
      WHERE id=${acceptedDriverId}::uuid
    `);
  });

  console.info("[DISPATCH] accept_success", JSON.stringify({ tripId: session.tripId, driverId: acceptedDriverId, source: "reaper" }));
  await onDriverAccepted(session.tripId, acceptedDriverId);
}

/**
 * Expire/fail the dispatch session — no driver found.
 * Before giving up: retry once from radius step 0 after 45s (catches drivers who just came online).
 */
async function expireDispatch(session: DispatchSession, message: string): Promise<void> {
  if (!await stillOwnsDispatch(session)) return;
  if (session.status === "accepted" || session.status === "cancelled") return;

  // Allow ONE retry from scratch — a driver may have just come online
  const MAX_RETRIES = 1;
  if (session.retryCount < MAX_RETRIES) {
    session.retryCount++;
    session.radiusIndex = 0;
    session.driverQueue = [];
    session.queueIndex = 0;
    session.status = "searching";
    session.offerExpiresAt = null;
    await persistDispatchSession(session);
    console.log(`[DISPATCH] No drivers found for trip ${session.tripId} — scheduling retry #${session.retryCount} in 45s`);

    // Notify customer we're still searching
    emitCustomerSearchStatus(session);

    session.retryTimer = setTimeout(async () => {
      if (!await stillOwnsDispatch(session)) return;
      session.retryTimer = null;
      if (session.status !== "searching") return; // may have been accepted/cancelled
      console.log(`[DISPATCH] Retry #${session.retryCount} starting for trip ${session.tripId}`);
      await searchAndDispatchNextRadius(session);
    }, 45000);
    return;
  }

  session.status = "no_drivers";
  clearTimers(session);
  session.currentOfferId = null;
  await persistDispatchSession(session);

  // Notify customer
  if (io) {
    io.to(`user:${session.customerId}`).emit("trip:no_drivers", {
      tripId: session.tripId,
      message,
    });
  }

  // Update trip status in DB
  try {
    await cancelRideState(session.tripId, message, {
      actorType: "system",
      cancelledBy: "system",
      allowedStatuses: ["searching", "driver_assigned"],
    });
    await logRideEvent(session.tripId, "NO_DRIVER_FOUND", { message }, null, "system");
  } catch (err: any) {
    console.error(`[DISPATCH] Failed to cancel trip ${session.tripId}:`, err.message);
  }

  // ── Auto-refund: if customer paid online and no driver found, refund to wallet ──
  try {
    const tripData = await rawDb.execute(rawSql`
      SELECT payment_status, customer_id FROM trip_requests
      WHERE id=${session.tripId}::uuid LIMIT 1
    `);
    const t = tripData.rows[0] as any;
    if (t?.payment_status === 'paid_online' && t?.customer_id) {
      const atomicRefund = await rawDb.execute(rawSql`
        UPDATE customer_payments
        SET status='refunded', refunded_at=NOW()
        WHERE trip_id=${session.tripId}::uuid
          AND customer_id=${t.customer_id}::uuid
          AND payment_type='ride_payment'
          AND status='completed'
        RETURNING id, amount
      `);
      if (atomicRefund.rows.length) {
        const refundAmt = parseFloat((atomicRefund.rows[0] as any).amount);
        await applyWalletChange({
          userId: String(t.customer_id),
          amount: refundAmt,
          type: "CREDIT",
          reason: "ride_refund_no_driver",
          refId: session.tripId,
        });
        await rawDb.execute(rawSql`
          UPDATE trip_requests SET payment_status='refunded_to_wallet'
          WHERE id=${session.tripId}::uuid
        `).catch(() => { });
        await rawDb.execute(rawSql`
          INSERT INTO transactions (user_id, account, credit, debit, balance, transaction_type, ref_transaction_id)
          SELECT ${t.customer_id}::uuid, 'Refund — no driver available', ${refundAmt}, 0,
                 wallet_balance, 'ride_refund', ${session.tripId}
          FROM users WHERE id=${t.customer_id}::uuid
          ON CONFLICT DO NOTHING
        `).catch(() => { });
        if (io) {
          io.to(`user:${session.customerId}`).emit("trip:refunded", {
            tripId: session.tripId,
            amount: refundAmt,
            reason: "No drivers available — full refund to wallet",
          });
        }
        console.log(`[DISPATCH-REFUND] ₹${refundAmt} auto-refunded to wallet — customer ${t.customer_id}, trip ${session.tripId}`);
      }
    }
  } catch (err: any) {
    console.error(`[DISPATCH-REFUND] Failed auto-refund for trip ${session.tripId}:`, err.message);
  }

  await clearDispatchSessionPersistence(session.tripId, session.ownerToken);
  activeDispatches.delete(session.tripId);
  console.log(`[DISPATCH] Trip ${session.tripId} expired — ${message}`);
}

/**
 * Check if a specific driver is still available to receive a trip offer.
 */
async function checkDriverAvailability(driverId: string): Promise<boolean> {
  try {
    const r = await rawDb.execute(rawSql`
      SELECT u.is_online, u.is_locked, u.current_trip_id, u.is_active, u.verification_status,
             dl.is_online as dl_online,
             dl.updated_at as last_location_at,
             COALESCE(dd.availability_status, 'offline') as availability_status
      FROM users u
      LEFT JOIN driver_locations dl ON dl.driver_id = u.id
      LEFT JOIN driver_details dd ON dd.user_id = u.id
      WHERE u.id = ${driverId}::uuid
      LIMIT 1
    `);
    if (!r.rows.length) {
      console.log(`[DISPATCH] ⚠ Driver ${driverId} — NOT FOUND in DB`);
      return false;
    }
    const d = r.rows[0] as any;
    const freshLocation = isDriverLocationFresh(d.last_location_at);
    const available = (
      d.is_active === true &&
      d.is_locked !== true &&
      (d.is_online === true || d.dl_online === true) &&
      d.availability_status === "online" &&
      d.current_trip_id === null &&
      d.verification_status === "approved" &&
      freshLocation
    );
    if (!available) {
      const reasons: string[] = [];
      if (!d.is_active) reasons.push("not active");
      if (d.is_locked) reasons.push("locked");
      if (!d.is_online && !d.dl_online) reasons.push("offline (both is_online flags false)");
      if (d.availability_status !== "online") reasons.push(`availability_status=${d.availability_status}`);
      if (d.current_trip_id !== null) reasons.push(`on trip ${d.current_trip_id}`);
      if (d.verification_status !== "approved") reasons.push(`verification=${d.verification_status} (need ACTIVE)`);
      if (!freshLocation) reasons.push(`stale location (${getLocationAgeSeconds(d.last_location_at) ?? "unknown"}s old)`);
      console.log(`[DISPATCH] ⚠ Driver ${driverId} unavailable — ${reasons.join(", ")}`);
    }
    return available;
  } catch {
    return false;
  }
}

/**
 * Find drivers within a specific radius using Haversine-based distance.
 * Returns drivers sorted by AI matching score (distance + rating + response speed + completion rate).
 */
async function findDriversInRadius(
  pickupLat: number,
  pickupLng: number,
  radiusKm: number,
  vehicleCategoryId: string | undefined,
  vehicleType: string | undefined,
  excludeDriverIds: string[],
  limit: number,
  femaleOnly = false
): Promise<DriverMatchScore[]> {
  console.log(
    `[DISPATCH] findDriversInRadius pickup=(${pickupLat},${pickupLng}) radius=${radiusKm}km ` +
      `booking.vehicleType=${vehicleType || "missing"} vehicleCategoryId=${vehicleCategoryId || "missing"}`,
  );

  if (!vehicleCategoryId || !vehicleType) {
    console.error(
      `[DISPATCH] Refusing unfiltered driver search booking.vehicleType=${vehicleType || "missing"} ` +
        `vehicleCategoryId=${vehicleCategoryId || "missing"}`,
    );
    return [];
  }

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const safeIds = excludeDriverIds.filter((id) => uuidRe.test(id));
  const excludeClause = safeIds.length > 0
    ? rawSql.raw(`AND NOT (u.id = ANY(ARRAY[${safeIds.map(id => `'${id}'::uuid`).join(',')}]))`)
    : rawSql``;

  // Expand the customer's chosen category UUID into all driver-category UUIDs
  // that share the same vehicle_type ("bike" -> all bike-typed UUIDs).
  // Strict UUID equality used to drop drivers whose category row has the same
  // type but a different UUID (e.g. customer "Bike Premium" vs driver "Bike Standard").
  const matchingCategoryIds = await getMatchingDriverCategoryIds(vehicleCategoryId);
  const allowedCategoryIds = new Set((matchingCategoryIds || []).map((id) => String(id)));
  const vcFilter = matchingCategoryIds && matchingCategoryIds.length
    ? rawSql`AND dd.vehicle_category_id = ANY(${uuidArraySql(matchingCategoryIds)})`
    : vehicleCategoryId
      ? rawSql`AND dd.vehicle_category_id = ${vehicleCategoryId}::uuid`
      : rawSql``;
  const driverDbVehicleType = getDriverDbVehicleType(vehicleType);
  const vehicleTypeFilter = driverDbVehicleType
    ? rawSql`AND vc.type = ${driverDbVehicleType}`
    : rawSql``;
  const femaleFilter = femaleOnly
    ? rawSql`AND LOWER(COALESCE(u.gender, '')) = 'female'`
    : rawSql``;

  // Rapido-style ranking: distance first, then idle time (longest-waiting driver
  // gets next ride — fairness + reduces ghost drivers), then rating.
  const drivers = await rawDb.execute(rawSql`
    SELECT
      u.id, u.full_name, u.phone, u.rating,
      dl.lat, dl.lng,
      COALESCE(vc.vehicle_type, vc.name, '') as driver_vehicle_type,
      COALESCE(vc.name, '') as driver_vehicle_name,
      COALESCE(ds.total_trips, 0) as total_trips,
      COALESCE(ds.avg_response_time_sec, 60) as avg_response_time_sec,
      COALESCE(ds.completion_rate, 0.8) as completion_rate,
      COALESCE(dbs.overall_score, 50) as behavior_score,
      EXTRACT(EPOCH FROM (NOW() - COALESCE(ds.updated_at, dl.updated_at))) as idle_seconds,
      EXTRACT(EPOCH FROM (NOW() - dl.updated_at)) as location_age_seconds,
      (SELECT ud.fcm_token FROM user_devices ud WHERE ud.user_id = u.id AND ud.fcm_token IS NOT NULL LIMIT 1) as fcm_token,
      SQRT(
        POW((dl.lat - ${Number(pickupLat)}) * 111.32, 2) +
        POW((dl.lng - ${Number(pickupLng)}) * 111.32 * COS(RADIANS(${Number(pickupLat)})), 2)
      ) as distance_km
    FROM users u
    JOIN driver_locations dl ON dl.driver_id = u.id
    LEFT JOIN driver_details dd ON dd.user_id = u.id
    LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
    LEFT JOIN driver_stats ds ON ds.driver_id = u.id
    LEFT JOIN driver_behavior_scores dbs ON dbs.driver_id = u.id
    WHERE u.user_type = 'driver'
      AND ${activeDriverEligibilitySql("u")}
      AND dl.is_online = true
      AND COALESCE(dd.availability_status, 'offline') = 'online'
      AND dl.updated_at > NOW() - (${LOCATION_FRESHNESS_SECONDS} * INTERVAL '1 second')
      AND dl.lat != 0 AND dl.lng != 0
      AND u.current_trip_id IS NULL
      AND COALESCE(ds.completion_rate, 0.8) >= 0.5
      ${vcFilter}
      ${vehicleTypeFilter}
      ${femaleFilter}
      ${excludeClause}
      AND SQRT(
        POW((dl.lat - ${Number(pickupLat)}) * 111.32, 2) +
        POW((dl.lng - ${Number(pickupLng)}) * 111.32 * COS(RADIANS(${Number(pickupLat)})), 2)
      ) <= ${radiusKm}
    ORDER BY distance_km ASC, idle_seconds DESC NULLS LAST, COALESCE(u.rating, 4.0) DESC
    LIMIT ${limit}
  `);

  // Debug: log total online drivers vs filtered results
  const totalOnlineCheck = await rawDb.execute(rawSql`
    SELECT COUNT(*) as total FROM driver_locations WHERE is_online=true
  `).catch(() => ({ rows: [{ total: '?' }] }));
  const onlineCount = (totalOnlineCheck.rows[0] as any)?.total ?? 0;
  const matchedVehicleTypes = Array.from(
    new Set(
      (drivers.rows as any[]).map((row) => String(row.driver_vehicle_type || row.driver_vehicle_name || "unknown")),
    ),
  );
  console.log(
    `[DISPATCH] radius=${radiusKm}km booking.vehicleType=${vehicleType} femaleOnly=${femaleOnly} matchedDrivers=${drivers.rows.length} ` +
      `totalOnline=${onlineCount} matchedDriverTypes=${matchedVehicleTypes.join(",") || "none"}`,
  );

  // Debug: if no drivers found but some are online, log exclusion reasons for nearby drivers
  if (!drivers.rows.length && Number(onlineCount) > 0) {
    try {
      const nearbyAll = await rawDb.execute(rawSql`
        SELECT u.id, u.full_name, u.is_active, u.is_locked, u.is_online, u.current_trip_id, u.verification_status,
               dl.is_online as dl_online, dl.lat, dl.lng, dl.updated_at,
               dd.vehicle_category_id, dd.availability_status,
               COALESCE(vc.vehicle_type, vc.name, '') as driver_vehicle_type,
                SQRT(
                  POW((dl.lat - ${Number(pickupLat)}) * 111.32, 2) +
                  POW((dl.lng - ${Number(pickupLng)}) * 111.32 * COS(RADIANS(${Number(pickupLat)})), 2)
                ) as distance_km
        FROM users u
        JOIN driver_locations dl ON dl.driver_id = u.id
        LEFT JOIN driver_details dd ON dd.user_id = u.id
        LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
        WHERE u.user_type = 'driver' AND dl.is_online = true
        ORDER BY distance_km ASC
        LIMIT 10
      `);
      for (const row of nearbyAll.rows) {
        const r = row as any;
        const reasons: string[] = [];
        if (!r.is_active) reasons.push("is_active=false");
        if (r.is_locked) reasons.push("is_locked=true");
        if (!r.dl_online) reasons.push("dl.is_online=false");
        if (r.availability_status !== 'online') reasons.push(`availability_status=${r.availability_status}`);
        if (r.current_trip_id) reasons.push(`on trip ${r.current_trip_id}`);
        if (r.verification_status !== "approved") reasons.push(`verification=${r.verification_status} (need ACTIVE)`);
        if (r.lat == 0 && r.lng == 0) reasons.push("lat/lng=0,0 (no GPS fix)");
        const locationAgeSeconds = getLocationAgeSeconds(r.updated_at);
        if (!isDriverLocationFresh(r.updated_at)) reasons.push(`stale location (${locationAgeSeconds ?? "unknown"}s old)`);
        if (allowedCategoryIds.size > 0 && !allowedCategoryIds.has(String(r.vehicle_category_id || ""))) {
          reasons.push(
            `vehicle_category mismatch (has=${r.vehicle_category_id}, allowed=${Array.from(allowedCategoryIds).join("|")})`,
          );
        }
        if (
          driverDbVehicleType &&
          r.driver_vehicle_type &&
          getDriverDbVehicleType(String(r.driver_vehicle_type)) !== driverDbVehicleType
        ) {
          reasons.push(`vehicle_type mismatch (has=${r.driver_vehicle_type}, need=${vehicleType})`);
        }
        const distKm = Number(r.distance_km).toFixed(1);
        if (Number(distKm) > radiusKm) reasons.push(`outside radius (${distKm}km > ${radiusKm}km)`);
        console.log(`[DISPATCH] ⚠ Nearby driver ${r.id} (${r.full_name || "?"}, ${distKm}km away) EXCLUDED — ${reasons.length ? reasons.join(", ") : "in exclude list or already notified"}`);
      }
    } catch (e: any) {
      console.error("[DISPATCH] Exclusion debug query failed:", e.message);
    }
  }

  if (!drivers.rows.length) return [];

  // AI scoring: distance (35%) + behavior score (25%) + rating (20%) + response speed (10%) + completion (10%)
  const WEIGHTS = DISPATCH_SCORE_WEIGHTS;

  const scored: DriverMatchScore[] = drivers.rows.map((row: any) => {
    const distKm = Number(row.distance_km) || 99;
    const rating = Number(row.rating) || 3.0;
    const avgResp = Number(row.avg_response_time_sec) || 60;
    const completionRate = Number(row.completion_rate) || 0.8;
    const behaviorScore = Number(row.behavior_score) || 50;
    const idleSeconds = Number(row.idle_seconds) || 0;
    const locationAgeSeconds = row.location_age_seconds != null
      ? Math.round(Number(row.location_age_seconds))
      : null;

    const maxRadius = 25;
    const distScore = Math.max(0, 1 - distKm / maxRadius);
    const behaviorNorm = behaviorScore / 100; // 0-100 → 0-1
    const ratingScore = (rating - 1) / 4;
    const respScore = Math.max(0, 1 - avgResp / 300);
    const complScore = completionRate;

    const score =
      distScore * WEIGHTS.distance +
      behaviorNorm * WEIGHTS.behavior +
      ratingScore * WEIGHTS.rating +
      respScore * WEIGHTS.responseSpeed +
      complScore * WEIGHTS.completionRate;
    const scoreMeta = buildDispatchScore({
      distanceKm: distKm,
      rating,
      avgResponseTimeSec: avgResp,
      completionRate,
      behaviorScore,
      idleSeconds,
      locationAgeSeconds,
    });

    return {
      driverId: row.id,
      fullName: row.full_name || "Pilot",
      phone: row.phone || "",
      lat: Number(row.lat),
      lng: Number(row.lng),
      distanceKm: Math.round(distKm * 100) / 100,
      rating: Math.round(rating * 10) / 10,
      totalTrips: Number(row.total_trips) || 0,
      avgResponseTimeSec: Math.round(avgResp),
      score: scoreMeta.final,
      fcmToken: row.fcm_token || undefined,
      scoreBreakdown: scoreMeta.breakdown,
    };
  });

  // Sort by score descending — nearest + highest rated first
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Emit search status update to the customer.
 */
function emitCustomerSearchStatus(session: DispatchSession): void {
  if (!io) return;
  const config = session.config;
  const currentRadius = config.radiusStepsKm[Math.min(session.radiusIndex, config.radiusStepsKm.length - 1)];

  io.to(`user:${session.customerId}`).emit("dispatch:status", {
    tripId: session.tripId,
    status: "searching",
    currentRadiusKm: currentRadius,
    radiusStep: Math.min(session.radiusIndex + 1, config.radiusStepsKm.length),
    totalRadiusSteps: config.radiusStepsKm.length,
    driversNotified: session.notifiedDriverIds.size,
    message: "Looking for a pilot near you...",
  });

  // Also emit legacy event for backward compatibility
  io.to(`user:${session.customerId}`).emit("trip:searching", {
    tripId: session.tripId,
    message: "Looking for another pilot...",
  });
}

/**
 * Clear all timers for a dispatch session.
 */
function clearTimers(session: DispatchSession): void {
  if (session.offerTimer) {
    clearTimeout(session.offerTimer);
    session.offerTimer = null;
  }
  if (session.ownerHeartbeatTimer) {
    clearInterval(session.ownerHeartbeatTimer);
    session.ownerHeartbeatTimer = null;
  }
  if (session.totalTimer) {
    clearTimeout(session.totalTimer);
    session.totalTimer = null;
  }
  if (session.retryTimer) {
    clearTimeout(session.retryTimer);
    session.retryTimer = null;
  }
}

// ── Scheduled ride dispatch trigger ──────────────────────────────────────────

/**
 * Background interval that checks for scheduled rides approaching their
 * departure time and starts dispatch for them.
 * Runs every 30 seconds. Dispatches rides 5 minutes before scheduled time.
 */
export function startScheduledRideDispatcher(): void {
  setInterval(async () => {
    try {
      const upcoming = await rawDb.execute(rawSql`
        SELECT t.id, t.customer_id, t.pickup_lat, t.pickup_lng,
               t.vehicle_category_id, t.vehicle_type, t.trip_type, t.ref_id,
               t.pickup_address, t.destination_address,
               t.estimated_fare, t.estimated_distance, t.payment_method,
               t.pickup_short_name, t.destination_short_name,
               u.full_name as customer_name,
               vc.name as vehicle_category_name,
               COALESCE(vc.vehicle_type, vc.name, '') as vehicle_category_key
        FROM trip_requests t
        JOIN users u ON u.id = t.customer_id
        LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
        WHERE t.current_status = 'scheduled'
          AND t.is_scheduled = true
          AND t.scheduled_at <= NOW() + INTERVAL '5 minutes'
          AND t.scheduled_at > NOW() - INTERVAL '10 minutes'
      `);

      for (const row of upcoming.rows) {
        const trip = row as any;
        if (activeDispatches.has(trip.id)) continue; // Already dispatching
        const scheduledVehicleType =
          trip.vehicle_type || await getDriverSocketRoomKeyForCategoryId(trip.vehicle_category_id);

        await transitionRideState(String(trip.id), "searching", {
          actorType: "system",
          event: "REQUESTED",
          data: { source: "scheduled_dispatch" },
        });

        const serviceType = resolveServiceType(trip.trip_type, trip.vehicle_category_name);

        const parcelVehicleCategory = serviceType === "parcel" || serviceType === "b2b_parcel"
          ? normalizeVehicleKey(trip.vehicle_category_key || trip.vehicle_category_name)
          : undefined;

        await startDispatch(
          trip.id,
          trip.customer_id,
          Number(trip.pickup_lat),
          Number(trip.pickup_lng),
          trip.vehicle_category_id,
          scheduledVehicleType || undefined,
          serviceType,
          {
            refId: trip.ref_id,
            customerName: trip.customer_name || "Customer",
            pickupAddress: trip.pickup_address || "",
            destinationAddress: trip.destination_address || "",
            pickupShortName: trip.pickup_short_name,
            destinationShortName: trip.destination_short_name,
            pickupLat: Number(trip.pickup_lat),
            pickupLng: Number(trip.pickup_lng),
            estimatedFare: Number(trip.estimated_fare) || 0,
            estimatedDistance: Number(trip.estimated_distance) || 0,
            paymentMethod: trip.payment_method || "cash",
            tripType: trip.trip_type || "normal",
            vehicleType: scheduledVehicleType || null,
            vehicleCategoryName: trip.vehicle_category_name || null,
          },
          parcelVehicleCategory
        );

        console.log(`[DISPATCH] Scheduled ride ${trip.id} activated for dispatch`);
      }
    } catch (err: any) {
      console.error("[DISPATCH] Scheduled ride dispatcher error:", err.message);
    }
  }, 30000);

  console.log("[DISPATCH] Scheduled ride dispatcher started (30s interval)");
}

// ── Stale dispatch cleanup ───────────────────────────────────────────────────

/**
 * Periodic cleanup of dispatch sessions that got stuck.
 * Runs every 60 seconds.
 */
async function processDispatchReaperTrip(tripId: string): Promise<void> {
  const session = activeDispatches.get(tripId) || await restoreDispatchSession(tripId);
  if (!session) return;

  const ownerToken = await getDispatchOwnerToken(tripId);
  if (!ownerToken) {
    const claimed = await reacquireDispatchOwner(session);
    if (!claimed) {
      console.info("[DISPATCH] dispatch_owner_conflict", JSON.stringify({ tripId, reason: "reacquire_failed" }));
      return;
    }
  } else if (session.ownerToken && ownerToken !== session.ownerToken) {
    session.ownerToken = ownerToken;
    activeDispatches.set(tripId, session);
    await persistDispatchSession(session);
    console.info("[DISPATCH] dispatch_recovery_count", JSON.stringify({ tripId, reason: "owner_token_changed" }));
    return;
  } else if (!session.ownerToken) {
    session.ownerToken = ownerToken;
    await persistDispatchSession(session);
  }

  if (!await stillOwnsDispatch(session)) return;

  const now = Date.now();
  if (session.status === "accepted") {
    await reconcileAcceptedDispatch(session);
    return;
  }

  if (session.status === "offered" && session.offerExpiresAt && session.offerExpiresAt <= now) {
    await handleOfferTimeout(session, "Driver offer timed out");
    return;
  }

  if ((session.status === "searching" || session.status === "offered") && now - session.createdAt > session.config.maxTotalTimeMs) {
    await expireDispatch(session, "No pilots available nearby. Please try again.");
    return;
  }

  if (session.status === "searching" && !session.currentOfferedDriverId) {
    if (session.driverQueue.length && session.queueIndex < session.driverQueue.length) {
      await dispatchNextDriver(session);
    } else {
      await searchAndDispatchNextRadius(session);
    }
    return;
  }

  await persistDispatchSession(session);
}

export function startDispatchReaper(intervalMs = 7000): void {
  const tick = async () => {
    const tripIds = await getActiveDispatchTripIds();
    for (const tripId of tripIds) {
      try {
        await processDispatchReaperTrip(tripId);
      } catch (error: any) {
        console.error("[DISPATCH] REAPER_TRIP_ERROR", JSON.stringify({
          tripId,
          message: error?.message || String(error),
        }));
      }
    }
  };

  const handle = setInterval(() => {
    tick().catch((error) => {
      console.error("[DISPATCH] REAPER_LOOP_ERROR", error?.message || error);
    });
  }, intervalMs);
  (handle as any).unref?.();
  setTimeout(() => {
    tick().catch((error) => {
      console.error("[DISPATCH] REAPER_BOOT_ERROR", error?.message || error);
    });
  }, 1500);

  console.log(`[DISPATCH] Reaper started (${intervalMs}ms interval)`);
}

export function startDispatchCleanup(): void {
  setInterval(() => {
    const now = Date.now();
    const entries = Array.from(activeDispatches.entries());
    for (const [tripId, session] of entries) {
      // Remove sessions older than 10 minutes (safety net)
      if (now - session.createdAt > 600000) {
        console.warn(`[DISPATCH] Cleaning up stale session for trip ${tripId} (age: ${Math.round((now - session.createdAt) / 1000)}s)`);
        session.status = "expired";
        clearTimers(session);
        if (session.currentOfferedDriverId) {
          releaseDriverOffer(session.currentOfferedDriverId, tripId).catch(() => undefined);
        }
        activeDispatches.delete(tripId);
        clearDispatchSessionPersistence(tripId).catch(() => undefined);
      }
    }
  }, 60000);

  console.log("[DISPATCH] Stale session cleanup started (60s interval)");
}
