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
import { notifyDriverNewRide } from "./fcm";
import { type DriverMatchScore } from "./ai";
import { findParcelCapableDrivers } from "./parcel-advanced";
import {
  buildDispatchRequirementsFromTripInput,
  findEligibleDriversForDispatch,
  isDriverEligibleForDispatch,
  resolveDispatchRequirementsFromTrip,
  type DispatchRequirements,
} from "./dispatch-eligibility";

// ── Service-specific dispatch configuration ──────────────────────────────────

export interface DispatchConfig {
  radiusStepsKm: number[];
  driverTimeoutMs: number;
  maxTotalTimeMs: number;
  driversPerStep: number; // how many drivers to fetch per radius step
}

const DISPATCH_CONFIGS: Record<string, DispatchConfig> = {
  // driverTimeoutMs=60s: extended for local testing
  bike:       { radiusStepsKm: [5, 8, 12, 15],    driverTimeoutMs: 60000, maxTotalTimeMs: 300000, driversPerStep: 10 },
  auto:       { radiusStepsKm: [5, 8, 12, 15],    driverTimeoutMs: 60000, maxTotalTimeMs: 300000, driversPerStep: 10 },
  cab:        { radiusStepsKm: [5, 8, 12, 15, 20],driverTimeoutMs: 60000, maxTotalTimeMs: 360000, driversPerStep: 10 },
  parcel:     { radiusStepsKm: [5, 10, 15],        driverTimeoutMs: 60000, maxTotalTimeMs: 240000, driversPerStep: 8 },
  b2b_parcel: { radiusStepsKm: [5, 10, 15],        driverTimeoutMs: 60000, maxTotalTimeMs: 300000, driversPerStep: 8 },
  carpool:    { radiusStepsKm: [5, 8, 12, 20],     driverTimeoutMs: 60000, maxTotalTimeMs: 360000, driversPerStep: 10 },
  outstation: { radiusStepsKm: [5, 10, 15, 25],    driverTimeoutMs: 60000, maxTotalTimeMs: 420000, driversPerStep: 10 },
};

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
  parcelVehicleCategory?: string; // e.g. "bike_parcel", "tata_ace" — for parcel vehicle-type filtering
  serviceType: string;
  config: DispatchConfig;
  requirements: DispatchRequirements;

  // Trip metadata for socket payloads
  tripMeta: TripMeta;

  // State
  radiusIndex: number;
  driverQueue: DriverMatchScore[];
  queueIndex: number;
  currentOfferedDriverId: string | null;
  offerTimer: ReturnType<typeof setTimeout> | null;
  notifiedDriverIds: Set<string>;
  rejectedDriverIds: Set<string>;
  status: "searching" | "offered" | "accepted" | "cancelled" | "no_drivers" | "expired";
  createdAt: number;
  totalTimer: ReturnType<typeof setTimeout> | null;
  retryCount: number;      // how many full-radius restarts have been done
  retryTimer: ReturnType<typeof setTimeout> | null;
}

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
  vehicleCategoryName?: string;
}

// ── Dispatch Engine (singleton) ──────────────────────────────────────────────

const activeDispatches = new Map<string, DispatchSession>();

async function persistDriverOffer(
  session: DispatchSession,
  driver: DriverMatchScore,
  payload: Record<string, any>,
): Promise<void> {
  const timeoutSec = Math.max(1, Math.ceil(session.config.driverTimeoutMs / 1000));
  await rawDb.execute(rawSql`
    UPDATE trip_requests
    SET offered_driver_id=${driver.driverId}::uuid,
        offer_expires_at=NOW() + (${timeoutSec} * INTERVAL '1 second'),
        offer_payload=${JSON.stringify(payload)}::jsonb,
        updated_at=NOW()
    WHERE id=${session.tripId}::uuid
      AND current_status='searching'
      AND driver_id IS NULL
  `);
}

async function clearPersistedOffer(tripId: string, driverId?: string): Promise<void> {
  await rawDb.execute(rawSql`
    UPDATE trip_requests
    SET offered_driver_id=NULL,
        offer_expires_at=NULL,
        offer_payload=NULL,
        updated_at=NOW()
    WHERE id=${tripId}::uuid
      ${driverId ? rawSql`AND offered_driver_id=${driverId}::uuid` : rawSql``}
  `);
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
  serviceType: string,
  tripMeta: TripMeta,
  parcelVehicleCategory?: string,
  seedRejectedDriverIds: string[] = []
): Promise<void> {
  // Cancel any existing dispatch for this trip (defensive)
  cancelDispatch(tripId);

  const config = getConfig(serviceType);
  const requirements = await resolveDispatchRequirementsFromTrip(tripId)
    || await buildDispatchRequirementsFromTripInput({
      tripId,
      tripType: tripMeta.tripType,
      vehicleCategoryId: vehicleCategoryId || null,
      parcelVehicleCategory: parcelVehicleCategory || null,
      seatsBooked: 1,
    });

  const session: DispatchSession = {
    tripId,
    customerId,
    pickupLat,
    pickupLng,
    vehicleCategoryId,
    parcelVehicleCategory,
    serviceType,
    config,
    requirements,
    tripMeta,
    radiusIndex: 0,
    driverQueue: [],
    queueIndex: 0,
    currentOfferedDriverId: null,
    offerTimer: null,
    notifiedDriverIds: new Set(),
    rejectedDriverIds: new Set(seedRejectedDriverIds.filter(Boolean)),
    status: "searching",
    createdAt: Date.now(),
    totalTimer: null,
    retryCount: 0,
    retryTimer: null,
  };

  activeDispatches.set(tripId, session);

  // Set max total timeout — auto-cancel if no driver found in time
  session.totalTimer = setTimeout(() => {
    if (session.status === "searching" || session.status === "offered") {
      expireDispatch(session, "No pilots available nearby. Please try again.");
    }
  }, config.maxTotalTimeMs);

  console.log(`[DISPATCH] ✅ RIDE CREATED — trip=${tripId} type=${serviceType} pickup=(${pickupLat},${pickupLng}) vehicleCategory=${vehicleCategoryId ?? "any"} — radius steps: ${config.radiusStepsKm.join("→")}km timeout=${config.driverTimeoutMs / 1000}s/driver`);

  // Begin the first radius step
  await searchAndDispatchNextRadius(session);
}

/**
 * Called when a driver accepts a trip (from accept-trip endpoint or socket).
 * Clears the dispatch session and verifies driver is still online.
 */
export async function onDriverAccepted(tripId: string, driverId: string): Promise<void> {
  const session = activeDispatches.get(tripId);
  if (!session) return;

  session.status = "accepted";
  clearTimers(session);
  await clearPersistedOffer(tripId).catch(() => {});

  // Notify all previously-notified (but not accepted) drivers that trip is taken
  if (io) {
    Array.from(session.notifiedDriverIds).forEach((notifiedId) => {
      if (notifiedId !== driverId) {
        io.to(`user:${notifiedId}`).emit("trip:request_taken", { tripId });
      }
    });
  }

  activeDispatches.delete(tripId);
  console.log(`[DISPATCH] ✅ DRIVER ACCEPTED — trip=${tripId} driver=${driverId}`);
  
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
  const session = activeDispatches.get(tripId);
  if (!session) return;

  // Clear offer timer for current driver
  if (session.offerTimer) {
    clearTimeout(session.offerTimer);
    session.offerTimer = null;
  }

  session.rejectedDriverIds.add(driverId);
  session.currentOfferedDriverId = null;
  await clearPersistedOffer(tripId, driverId).catch(() => {});

  // Emit timeout/rejection to driver
  if (io) {
    io.to(`user:${driverId}`).emit("trip:offer_timeout", { tripId });
  }

  // Notify customer we're still searching
  emitCustomerSearchStatus(session);

  console.log(`[DISPATCH] Driver ${driverId} rejected trip ${tripId} — moving to next`);

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

  // Notify current offered driver that trip was cancelled
  if (session.currentOfferedDriverId && io) {
    io.to(`user:${session.currentOfferedDriverId}`).emit("trip:cancelled", {
      tripId,
      cancelledBy: "customer",
    });
  }

  activeDispatches.delete(tripId);
  clearPersistedOffer(tripId).catch(() => {});
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

export function isDriverCurrentlyOfferedTrip(tripId: string, driverId: string): boolean {
  const session = activeDispatches.get(tripId);
  if (!session) return true;
  return session.status === "offered" && session.currentOfferedDriverId === driverId;
}

export function getCurrentOfferedTripForDriver(driverId: string): { tripId: string; trip: Record<string, any> } | null {
  let match: DispatchSession | null = null;
  for (const session of Array.from(activeDispatches.values())) {
    if (session.status !== "offered") continue;
    if (session.currentOfferedDriverId !== driverId) continue;
    if (!match || session.createdAt > match.createdAt) {
      match = session;
    }
  }

  if (!match) return null;

  const driverMeta = match.driverQueue.find((entry) => entry.driverId === driverId);
  return {
    tripId: match.tripId,
    trip: {
      tripId: match.tripId,
      ...match.tripMeta,
      vehicleCategoryId: match.vehicleCategoryId || null,
      aiScore: driverMeta?.score,
      driverDistanceKm: driverMeta?.distanceKm,
      timeoutMs: match.config.driverTimeoutMs,
    },
  };
}

// ── Internal dispatch logic ──────────────────────────────────────────────────

/**
 * Search for drivers within the current radius step and start dispatching.
 */
async function searchAndDispatchNextRadius(session: DispatchSession): Promise<void> {
  if (session.status !== "searching" && session.status !== "offered") return;

  const config = session.config;
  if (session.radiusIndex >= config.radiusStepsKm.length) {
    // All radius steps exhausted
    expireDispatch(session, "No pilots available nearby. Please try again.");
    return;
  }

  const radiusKm = config.radiusStepsKm[session.radiusIndex];

  // Build exclude list: all previously notified + rejected drivers
  const excludeIds: string[] = [
    ...Array.from(session.notifiedDriverIds),
    ...Array.from(session.rejectedDriverIds),
    session.customerId, // don't send to the customer (they might also be a driver)
  ].filter(Boolean);
  // Deduplicate
  const uniqueExcludeIds = Array.from(new Set(excludeIds));

  console.log(`[DISPATCH] Trip ${session.tripId} — searching radius ${radiusKm}km (step ${session.radiusIndex + 1}/${config.radiusStepsKm.length})`);

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
        const score = (1 - Math.min(distKm / 25, 1)) * 0.35 + (behaviorScore / 100) * 0.25 + ((rating - 1) / 4) * 0.20 + 0.15;
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
          score: Math.round(score * 1000) / 1000,
          fcmToken: row.fcm_token || undefined,
        };
      });
      drivers.sort((a, b) => b.score - a.score);
    } else {
      drivers = await findDriversInRadius(
        session.pickupLat,
        session.pickupLng,
        radiusKm,
        session.requirements,
        uniqueExcludeIds,
        config.driversPerStep
      );
    }

    if (session.status !== "searching" && session.status !== "offered") return;

    if (drivers.length === 0) {
      // No drivers at this radius — try next
      session.radiusIndex++;
      if (session.status === "searching" || session.status === "offered") {
        emitCustomerSearchStatus(session);
      }
      await searchAndDispatchNextRadius(session);
      return;
    }

    // Set up the driver queue for this radius
    session.driverQueue = drivers;
    session.queueIndex = 0;

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

  // Find next un-notified, un-rejected driver in queue
  while (session.queueIndex < session.driverQueue.length) {
    const driver = session.driverQueue[session.queueIndex];
    session.queueIndex++;

    if (session.notifiedDriverIds.has(driver.driverId) || session.rejectedDriverIds.has(driver.driverId)) {
      continue; // Skip already-notified or rejected drivers
    }

    // Verify driver is still available (online, no active trip)
    const isAvailable = await checkDriverAvailability(driver.driverId, session.requirements);
    if (!isAvailable) continue;

    // Send request to this single driver
    await offerTripToDriver(session, driver);
    return;
  }

  // Queue exhausted — expand to next radius
  session.radiusIndex++;
  session.driverQueue = [];
  session.queueIndex = 0;
  await searchAndDispatchNextRadius(session);
}

/**
 * Send trip request to a single driver and start the acceptance timer.
 */
async function offerTripToDriver(session: DispatchSession, driver: DriverMatchScore): Promise<void> {
  session.status = "offered";
  session.currentOfferedDriverId = driver.driverId;
  session.notifiedDriverIds.add(driver.driverId);

  const payload = {
    tripId: session.tripId,
    ...session.tripMeta,
    vehicleCategoryId: session.vehicleCategoryId || null,
    vehicleCategoryName: session.tripMeta.vehicleCategoryName || null,
    vehicleCategory: session.tripMeta.vehicleCategoryName || null,
    aiScore: driver.score,
    driverDistanceKm: driver.distanceKm,
    timeoutMs: session.config.driverTimeoutMs,
  };

  await persistDriverOffer(session, driver, payload).catch((err: any) => {
    console.error(`[DISPATCH] Failed to persist driver offer trip=${session.tripId} pilot=${driver.driverId}:`, err?.message || err);
  });

  // Socket notification (foreground)
  if (io) {
    io.to(`user:${driver.driverId}`).emit("trip:new_request", payload);
  }

  // FCM notification (background/killed app)
  const socketRoom = io?.sockets?.adapter?.rooms?.get(`user:${driver.driverId}`);
  const socketConnected = !!(socketRoom && socketRoom.size > 0);
  if (driver.fcmToken) {
    notifyDriverNewRide({
      fcmToken: driver.fcmToken,
      driverName: driver.fullName,
      customerName: session.tripMeta.customerName,
      pickupAddress: session.tripMeta.pickupAddress,
      destinationAddress: session.tripMeta.destinationAddress,
      estimatedFare: session.tripMeta.estimatedFare,
      estimatedDistance: session.tripMeta.estimatedDistance,
      tripId: session.tripId,
      vehicleCategoryId: session.vehicleCategoryId || null,
      vehicleCategoryName: session.tripMeta.vehicleCategoryName || null,
      timeoutMs: session.config.driverTimeoutMs,
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

  // Start timeout timer — if driver doesn't respond, auto-skip
  session.offerTimer = setTimeout(async () => {
    if (session.currentOfferedDriverId !== driver.driverId) return;
    if (session.status !== "offered") return;

    console.log(`[DISPATCH] Driver ${driver.driverId} timed out on trip ${session.tripId}`);

    // Record this driver as timed out (equivalent to soft rejection)
    session.rejectedDriverIds.add(driver.driverId);
    session.currentOfferedDriverId = null;
    await clearPersistedOffer(session.tripId, driver.driverId).catch(() => {});

    // Notify driver their time expired
    if (io) {
      io.to(`user:${driver.driverId}`).emit("trip:offer_timeout", { tripId: session.tripId });
    }

    // Update customer
    emitCustomerSearchStatus(session);

    // Move to next driver
    await dispatchNextDriver(session);
  }, session.config.driverTimeoutMs);
}

/**
 * Expire/fail the dispatch session — no driver found.
 * Before giving up: retry once from radius step 0 after 45s (catches drivers who just came online).
 */
async function expireDispatch(session: DispatchSession, message: string): Promise<void> {
  if (session.status === "accepted" || session.status === "cancelled") return;

  // Allow ONE retry from scratch — a driver may have just come online
  const MAX_RETRIES = 1;
  if (session.retryCount < MAX_RETRIES) {
    session.retryCount++;
    session.radiusIndex = 0;
    session.driverQueue = [];
    session.queueIndex = 0;
    session.status = "searching";
    console.log(`[DISPATCH] No drivers found for trip ${session.tripId} — scheduling retry #${session.retryCount} in 45s`);

    // Notify customer we're still searching
    emitCustomerSearchStatus(session);

    session.retryTimer = setTimeout(async () => {
      session.retryTimer = null;
      if (session.status !== "searching") return; // may have been accepted/cancelled
      console.log(`[DISPATCH] Retry #${session.retryCount} starting for trip ${session.tripId}`);
      await searchAndDispatchNextRadius(session);
    }, 45000);
    return;
  }

  session.status = "no_drivers";
  clearTimers(session);

  // Notify customer
  if (io) {
    io.to(`user:${session.customerId}`).emit("trip:no_drivers", {
      tripId: session.tripId,
      message,
    });
  }

  // Update trip status in DB
  try {
    await rawDb.execute(rawSql`
      UPDATE trip_requests
      SET current_status='cancelled',
          cancel_reason=${message},
          cancelled_by='system',
          offered_driver_id=NULL,
          offer_expires_at=NULL,
          offer_payload=NULL,
          updated_at=NOW()
      WHERE id=${session.tripId}::uuid
        AND current_status IN ('searching', 'driver_assigned')
    `);
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
        await rawDb.execute(rawSql`
          UPDATE users SET wallet_balance = wallet_balance + ${refundAmt}
          WHERE id=${t.customer_id}::uuid
        `);
        await rawDb.execute(rawSql`
          UPDATE trip_requests SET payment_status='refunded_to_wallet'
          WHERE id=${session.tripId}::uuid
        `).catch(() => {});
        await rawDb.execute(rawSql`
          INSERT INTO transactions (user_id, account, credit, debit, balance, transaction_type, ref_transaction_id)
          SELECT ${t.customer_id}::uuid, 'Refund — no driver available', ${refundAmt}, 0,
                 wallet_balance, 'ride_refund', ${session.tripId}
          FROM users WHERE id=${t.customer_id}::uuid
          ON CONFLICT DO NOTHING
        `).catch(() => {});
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

  activeDispatches.delete(session.tripId);
  console.log(`[DISPATCH] Trip ${session.tripId} expired — ${message}`);
}

/**
 * Check if a specific driver is still available to receive a trip offer.
 */
async function checkDriverAvailability(driverId: string, requirements: DispatchRequirements): Promise<boolean> {
  try {
    const strictEligibility = await isDriverEligibleForDispatch(driverId, requirements);
    if (!strictEligibility.eligible) {
      console.log(`[DISPATCH] âš  Driver ${driverId} unavailable â€” ${strictEligibility.reason || "not_eligible"}`);
      return false;
    }
    const r = await rawDb.execute(rawSql`
      SELECT u.is_online, u.is_locked, u.current_trip_id, u.is_active, u.verification_status,
             dl.is_online as dl_online
      FROM users u
      LEFT JOIN driver_locations dl ON dl.driver_id = u.id
      WHERE u.id = ${driverId}::uuid
      LIMIT 1
    `);
    if (!r.rows.length) {
      console.log(`[DISPATCH] ⚠ Driver ${driverId} — NOT FOUND in DB`);
      return false;
    }
    const d = r.rows[0] as any;
    const available = (
      d.is_active === true &&
      d.is_locked !== true &&
      (d.is_online === true || d.dl_online === true) &&
      d.current_trip_id === null &&
      ['approved', 'verified'].includes(d.verification_status)
    );
    if (!available) {
      const reasons: string[] = [];
      if (!d.is_active)                  reasons.push("not active");
      if (d.is_locked)                   reasons.push("locked");
      if (!d.is_online && !d.dl_online)  reasons.push("offline (both is_online flags false)");
      if (d.current_trip_id !== null)    reasons.push(`on trip ${d.current_trip_id}`);
      if (!['approved','verified'].includes(d.verification_status)) reasons.push(`verification=${d.verification_status}`);
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
  requirements: DispatchRequirements,
  excludeDriverIds: string[],
  limit: number
): Promise<DriverMatchScore[]> {
  console.log(`[DISPATCH] findDriversInRadius called: Lat=${pickupLat}, Lng=${pickupLng}, Radius=${radiusKm}km, Category=${requirements.vehicleCategoryId || 'any'}`);
  const strictDrivers = await findEligibleDriversForDispatch({
    pickupLat,
    pickupLng,
    radiusKm,
    excludeDriverIds,
    limit,
    requirements,
  });
  if (strictDrivers.length) {
    const scoredStrict: DriverMatchScore[] = strictDrivers.map((row: any) => {
      const distKm = Number(row.distanceKm) || 99;
      const rating = Number(row.rating) || 3.0;
      const avgResp = Number(row.avgResponseTimeSec) || 60;
      const behaviorScore = Number(row.behaviorScore) || 50;
      const score =
        Math.max(0, 1 - distKm / 25) * 0.35 +
        (behaviorScore / 100) * 0.25 +
        ((rating - 1) / 4) * 0.20 +
        Math.max(0, 1 - avgResp / 300) * 0.10 +
        0.8 * 0.10;

      return {
        driverId: row.driverId,
        fullName: row.fullName || "Pilot",
        phone: row.phone || "",
        lat: Number(row.lat),
        lng: Number(row.lng),
        distanceKm: Math.round(distKm * 100) / 100,
        rating: Math.round(rating * 10) / 10,
        totalTrips: Number(row.totalTrips) || 0,
        avgResponseTimeSec: Math.round(avgResp),
        score: Math.round(score * 1000) / 1000,
        fcmToken: row.fcmToken || undefined,
      };
    });
    scoredStrict.sort((a, b) => b.score - a.score);
    return scoredStrict;
  }

  console.log(
    `[DISPATCH] Strict eligibility returned 0 drivers for trip requirements ` +
    `service=${requirements.platformServiceKey || "unknown"} ` +
    `vehicle=${requirements.vehicleCategoryId || "any"} ` +
    `tripType=${requirements.tripType || "normal"}; skipping legacy fallback to avoid wrong-driver dispatch.`
  );
  return [];

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const safeIds = excludeDriverIds.filter((id) => uuidRe.test(id));
  const excludeClause = safeIds.length > 0
    ? rawSql.raw(`AND NOT (u.id = ANY(ARRAY[${safeIds.map(id => `'${id}'::uuid`).join(',')}]))`)
    : rawSql``;

  // LEFT JOIN driver_details so pilots without a details row are still found
  // vehicle_category filter: match OR driver has no category set (new/incomplete profile)
  const vcFilter = requirements.vehicleCategoryId
    ? rawSql`AND dd.vehicle_category_id = ${requirements.vehicleCategoryId}::uuid`
    : rawSql``;

  const drivers = await rawDb.execute(rawSql`
    SELECT
      u.id, u.full_name, u.phone, u.rating,
      dl.lat, dl.lng,
      COALESCE(ds.total_trips, 0) as total_trips,
      COALESCE(ds.avg_response_time_sec, 60) as avg_response_time_sec,
      COALESCE(ds.completion_rate, 0.8) as completion_rate,
      COALESCE(dbs.overall_score, 50) as behavior_score,
      (SELECT ud.fcm_token FROM user_devices ud WHERE ud.user_id = u.id AND ud.fcm_token IS NOT NULL LIMIT 1) as fcm_token,
      SQRT(
        POW((dl.lat - ${Number(pickupLat)}) * 111.32, 2) +
        POW((dl.lng - ${Number(pickupLng)}) * 111.32 * COS(RADIANS(${Number(pickupLat)})), 2)
      ) as distance_km
    FROM users u
    JOIN driver_locations dl ON dl.driver_id = u.id
    LEFT JOIN driver_details dd ON dd.user_id = u.id
    LEFT JOIN driver_stats ds ON ds.driver_id = u.id
    LEFT JOIN driver_behavior_scores dbs ON dbs.driver_id = u.id
    WHERE u.user_type = 'driver'
      AND u.is_active = true
      AND u.is_locked = false
      AND dl.is_online = true
      AND (
        dl.updated_at > NOW() - INTERVAL '30 minutes'
        OR (u.is_online = true AND dl.updated_at > NOW() - INTERVAL '4 hours')
      )
      AND dl.lat != 0 AND dl.lng != 0
      AND u.current_trip_id IS NULL
      AND u.verification_status IN ('approved', 'verified')
      ${vcFilter}
      ${excludeClause}
      AND SQRT(
        POW((dl.lat - ${Number(pickupLat)}) * 111.32, 2) +
        POW((dl.lng - ${Number(pickupLng)}) * 111.32 * COS(RADIANS(${Number(pickupLat)})), 2)
      ) <= ${radiusKm}
    ORDER BY distance_km ASC
    LIMIT ${limit}
  `);

  if (process.env.DISPATCH_DEBUG === "true") {
  // Debug: log total online drivers vs filtered results
  const totalOnlineCheck = await rawDb.execute(rawSql`
    SELECT COUNT(*) as total FROM driver_locations WHERE is_online=true
  `).catch(() => ({ rows: [{ total: '?' }] }));
  const onlineCount = (totalOnlineCheck.rows[0] as any)?.total ?? 0;
  console.log(`[DISPATCH] Radius ${radiusKm}km search — found ${drivers.rows.length} eligible drivers (${onlineCount} total is_online=true in system) vehicleCategoryId=${requirements.vehicleCategoryId ?? "any"}`);

  // Debug: if no drivers found but some are online, log exclusion reasons for nearby drivers
  if (!drivers.rows.length && Number(onlineCount) > 0) {
    try {
      const nearbyAll = await rawDb.execute(rawSql`
        SELECT u.id, u.full_name, u.is_active, u.is_locked, u.is_online, u.current_trip_id, u.verification_status,
               dl.is_online as dl_online, dl.lat, dl.lng, dl.updated_at,
               dd.vehicle_category_id,
               SQRT(
                 POW((dl.lat - ${Number(pickupLat)}) * 111.32, 2) +
                 POW((dl.lng - ${Number(pickupLng)}) * 111.32 * COS(RADIANS(${Number(pickupLat)})), 2)
               ) as distance_km
        FROM users u
        JOIN driver_locations dl ON dl.driver_id = u.id
        LEFT JOIN driver_details dd ON dd.user_id = u.id
        WHERE u.user_type = 'driver' AND dl.is_online = true
        ORDER BY distance_km ASC
        LIMIT 10
      `);
      for (const row of nearbyAll.rows) {
        const r = row as any;
        const reasons: string[] = [];
        if (!r.is_active)                        reasons.push("is_active=false");
        if (r.is_locked)                          reasons.push("is_locked=true");
        if (!r.dl_online)                         reasons.push("dl.is_online=false");
        if (r.current_trip_id)                    reasons.push(`on trip ${r.current_trip_id}`);
        if (!['approved', 'verified'].includes(r.verification_status)) reasons.push(`verification=${r.verification_status} (need approved/verified)`);
        if (r.lat == 0 && r.lng == 0)            reasons.push("lat/lng=0,0 (no GPS fix)");
        const staleMins = r.updated_at ? Math.round((Date.now() - new Date(r.updated_at).getTime()) / 60000) : 999;
        const isStale = staleMins > 30 && !(r.is_online && staleMins <= 240);
        if (isStale)                               reasons.push(`stale location (${staleMins}min ago, is_online=${r.is_online})`);
        if (requirements.vehicleCategoryId && r.vehicle_category_id !== requirements.vehicleCategoryId)
          reasons.push(`vehicle_category mismatch (has=${r.vehicle_category_id}, need=${requirements.vehicleCategoryId})`);
        const distKm = Number(r.distance_km).toFixed(1);
        if (Number(distKm) > radiusKm)            reasons.push(`outside radius (${distKm}km > ${radiusKm}km)`);
        console.log(`[DISPATCH] ⚠ Nearby driver ${r.id} (${r.full_name || "?"}, ${distKm}km away) EXCLUDED — ${reasons.length ? reasons.join(", ") : "in exclude list or already notified"}`);
      }
    } catch (e: any) {
      console.error("[DISPATCH] Exclusion debug query failed:", e.message);
    }
  }
  } else {
    console.log(`[DISPATCH] Radius ${radiusKm}km search - found ${drivers.rows.length} eligible drivers vehicleCategoryId=${requirements.vehicleCategoryId ?? "any"}`);
  }

  if (!drivers.rows.length) return [];

  // AI scoring: distance (35%) + behavior score (25%) + rating (20%) + response speed (10%) + completion (10%)
  const WEIGHTS = { distance: 0.35, behavior: 0.25, rating: 0.20, responseSpeed: 0.10, completionRate: 0.10 };

  const scored: DriverMatchScore[] = drivers.rows.map((row: any) => {
    const distKm = Number(row.distance_km) || 99;
    const rating = Number(row.rating) || 3.0;
    const avgResp = Number(row.avg_response_time_sec) || 60;
    const completionRate = Number(row.completion_rate) || 0.8;
    const behaviorScore = Number(row.behavior_score) || 50;

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
      score: Math.round(score * 1000) / 1000,
      fcmToken: row.fcm_token || undefined,
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
               t.vehicle_category_id, t.trip_type, t.ref_id,
               t.pickup_address, t.destination_address,
               t.estimated_fare, t.estimated_distance, t.payment_method,
               t.pickup_short_name, t.destination_short_name,
               u.full_name as customer_name,
               vc.name as vehicle_category_name
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

        // Switch status to searching
        await rawDb.execute(rawSql`
          UPDATE trip_requests SET current_status='searching', updated_at=NOW()
          WHERE id=${trip.id}::uuid AND current_status='scheduled'
        `);

        const serviceType = resolveServiceType(trip.trip_type, trip.vehicle_category_name);

        await startDispatch(
          trip.id,
          trip.customer_id,
          Number(trip.pickup_lat),
          Number(trip.pickup_lng),
          trip.vehicle_category_id,
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
            vehicleCategoryName: trip.vehicle_category_name || undefined,
          }
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
        activeDispatches.delete(tripId);
      }
    }
  }, 60000);

  console.log("[DISPATCH] Stale session cleanup started (60s interval)");
}

export async function restartDispatchForTrip(
  tripId: string,
  seedRejectedDriverIds: string[] = []
): Promise<void> {
  const tripR = await rawDb.execute(rawSql`
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
      t.ref_id,
      u.full_name as customer_name
    FROM trip_requests t
    JOIN users u ON u.id = t.customer_id
    WHERE t.id = ${tripId}::uuid
    LIMIT 1
  `).catch(() => ({ rows: [] as any[] }));
  if (!tripR.rows.length) return;

  const trip = tripR.rows[0] as any;
  const requirements = await resolveDispatchRequirementsFromTrip(tripId);
  const serviceType = requirements?.dispatchServiceType || resolveServiceType(trip.trip_type, "");

  await startDispatch(
    tripId,
    trip.customer_id,
    Number(trip.pickup_lat) || 0,
    Number(trip.pickup_lng) || 0,
    trip.vehicle_category_id || undefined,
    serviceType,
    {
      refId: trip.ref_id || "",
      customerName: trip.customer_name || "Customer",
      pickupAddress: trip.pickup_address || "",
      destinationAddress: trip.destination_address || "",
      pickupShortName: trip.pickup_short_name || undefined,
      destinationShortName: trip.destination_short_name || undefined,
      pickupLat: Number(trip.pickup_lat) || 0,
      pickupLng: Number(trip.pickup_lng) || 0,
      estimatedFare: Number(trip.estimated_fare) || 0,
      estimatedDistance: Number(trip.estimated_distance) || 0,
      paymentMethod: trip.payment_method || "cash",
      tripType: trip.trip_type || "normal",
    },
    requirements?.parcelVehicleCategory || undefined,
    seedRejectedDriverIds
  );
}
