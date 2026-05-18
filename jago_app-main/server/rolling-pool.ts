/**
 * Rolling Pool Engine
 *
 * How it works:
 *   1. Driver starts a pool session (goes "pool mode ON")
 *   2. Customer books → matcher finds nearest compatible active session
 *   3. Driver gets notified → picks up passenger at their location
 *   4. Driver drops passenger at destination → revenue settled immediately
 *   5. Seat freed → next passenger can join
 *   6. Process repeats until driver ends session
 *
 * Key rules:
 *   - Multiple passengers can be in the car simultaneously (up to max_seats)
 *   - New passenger added only if direction compatible + detour ≤ MAX_DETOUR_KM
 *   - Revenue settled per-drop (not at session end)
 *   - If no match within 5 min → customer is informed, can try regular ride
 */

import type { Express } from "express";
import { rawDb, rawSql, pool as dbPool } from "./db";
import { io } from "./socket";
import { sendFcmNotification } from "./fcm";
import { calculateRevenueBreakdown, settleRevenue } from "./revenue-engine";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_DETOUR_KM = 2.5;        // max extra km to pick up a new passenger
const MAX_MATCH_RADIUS_KM = 4;    // search for sessions within this radius
const DIRECTION_TOLERANCE_DEG = 50; // bearing must match within ±50°
const SEARCH_TIMEOUT_MIN = 5;     // cancel search if no match in 5 min
const MATCHER_INTERVAL_MS = 20_000; // re-run matcher every 20s

function poolResponse(
  success: boolean,
  code: string,
  message: string,
  data: Record<string, any> = {},
  retryable = false,
) {
  return {
    success,
    code,
    message,
    retryable,
    data,
    timestamp: new Date().toISOString(),
  };
}

function generateBoardingOtp(): string {
  return String(1000 + Math.floor(Math.random() * 9000));
}

// ── Schema ───────────────────────────────────────────────────────────────────

export async function ensureRollingPoolSchema(): Promise<void> {
  await rawDb.execute(rawSql`
    CREATE TABLE IF NOT EXISTS driver_pool_sessions (
      id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id              UUID NOT NULL REFERENCES users(id),
      vehicle_category_id    UUID,
      status                 VARCHAR(20) NOT NULL DEFAULT 'active',
      max_seats              INTEGER NOT NULL DEFAULT 4,
      available_seats        INTEGER NOT NULL DEFAULT 4,
      current_lat            NUMERIC(10,7),
      current_lng            NUMERIC(10,7),
      current_bearing_deg    NUMERIC(6,2),
      last_location_at       TIMESTAMP,
      total_passengers_served INTEGER NOT NULL DEFAULT 0,
      total_earnings         NUMERIC(12,2) NOT NULL DEFAULT 0,
      started_at             TIMESTAMP NOT NULL DEFAULT NOW(),
      ended_at               TIMESTAMP,
      created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await rawDb.execute(rawSql`
    ALTER TABLE driver_pool_sessions
    ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMP
  `);

  await rawDb.execute(rawSql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_active_pool_session
    ON driver_pool_sessions(driver_id)
    WHERE status = 'active'
  `);

  await rawDb.execute(rawSql`
    CREATE TABLE IF NOT EXISTS pool_ride_requests (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id       UUID REFERENCES driver_pool_sessions(id),
      customer_id      UUID NOT NULL REFERENCES users(id),
      vehicle_category_id UUID,
      pickup_lat       NUMERIC(10,7) NOT NULL,
      pickup_lng       NUMERIC(10,7) NOT NULL,
      drop_lat         NUMERIC(10,7) NOT NULL,
      drop_lng         NUMERIC(10,7) NOT NULL,
      pickup_address   TEXT,
      drop_address     TEXT,
      seats_requested  INTEGER NOT NULL DEFAULT 1,
      fare_per_seat    NUMERIC(10,2) NOT NULL DEFAULT 0,
      total_fare       NUMERIC(10,2) NOT NULL DEFAULT 0,
      distance_km      NUMERIC(10,2) NOT NULL DEFAULT 0,
      commission_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      driver_earnings  NUMERIC(10,2) NOT NULL DEFAULT 0,
      payment_method   VARCHAR(20) NOT NULL DEFAULT 'cash',
      status           VARCHAR(20) NOT NULL DEFAULT 'searching',
      pickup_order     INTEGER,
      drop_order       INTEGER,
      boarding_otp     VARCHAR(6),
      seat_lock_expires_at TIMESTAMP,
      cluster_key      TEXT,
      cancel_reason    TEXT,
      refund_amount    NUMERIC(10,2) NOT NULL DEFAULT 0,
      searched_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      matched_at       TIMESTAMP,
      picked_up_at     TIMESTAMP,
      dropped_at       TIMESTAMP,
      cancelled_at     TIMESTAMP,
      created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await rawDb.execute(rawSql`
    ALTER TABLE pool_ride_requests
    ADD COLUMN IF NOT EXISTS vehicle_category_id UUID,
    ADD COLUMN IF NOT EXISTS commission_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS driver_earnings NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS drop_order INTEGER,
    ADD COLUMN IF NOT EXISTS boarding_otp VARCHAR(6),
    ADD COLUMN IF NOT EXISTS seat_lock_expires_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS cluster_key TEXT,
    ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
    ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(10,2) NOT NULL DEFAULT 0
  `);

  await rawDb.execute(rawSql`
    CREATE INDEX IF NOT EXISTS idx_pool_requests_searching
    ON pool_ride_requests(status, created_at)
    WHERE status = 'searching'
  `);
  await rawDb.execute(rawSql`
    CREATE INDEX IF NOT EXISTS idx_pool_requests_session
    ON pool_ride_requests(session_id, status)
  `);
  await rawDb.execute(rawSql`
    CREATE INDEX IF NOT EXISTS idx_pool_requests_customer_status
    ON pool_ride_requests(customer_id, status, created_at DESC)
  `);
  await rawDb.execute(rawSql`
    CREATE INDEX IF NOT EXISTS idx_pool_requests_vehicle_status
    ON pool_ride_requests(vehicle_category_id, status, searched_at DESC)
  `);
  await rawDb.execute(rawSql`
    CREATE INDEX IF NOT EXISTS idx_pool_sessions_active
    ON driver_pool_sessions(status, updated_at)
    WHERE status = 'active'
  `);
}

// ── Geo helpers ───────────────────────────────────────────────────────────────

function haversineKmPool(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function bearingDegPool(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function bearingDiff(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// Detour added by picking up new passenger at (pLat,pLng) dropping at (dLat,dLng)
// from driver's current position (cLat,cLng)
function detourKm(
  cLat: number, cLng: number,  // driver current position
  pLat: number, pLng: number,  // new passenger pickup
  dLat: number, dLng: number,  // new passenger drop
): number {
  // Extra distance = drive to pickup + drive pickup→drop − drive direct to drop
  const driverToPickup = haversineKmPool(cLat, cLng, pLat, pLng);
  const pickupToDrop   = haversineKmPool(pLat, pLng, dLat, dLng);
  const driverToDrop   = haversineKmPool(cLat, cLng, dLat, dLng);
  return Math.max(0, driverToPickup + pickupToDrop - driverToDrop);
}

// ── Fare calc ─────────────────────────────────────────────────────────────────

function calcPoolFare(distKm: number, seats: number): { farePerSeat: number; totalFare: number } {
  const BASE = 18;
  const PER_KM = 8;
  const MIN_FARE = 40;
  const raw = Math.max(MIN_FARE, BASE + PER_KM * distKm);
  const seatDiscountFactor = seats >= 3 ? 0.70 : seats === 2 ? 0.73 : 0.76;
  const poolPrice = Math.round(raw * seatDiscountFactor * 100) / 100;
  return {
    farePerSeat: poolPrice,
    totalFare: Math.round(poolPrice * seats * 100) / 100,
  };
}

async function emitSeatUpdate(sessionId: string): Promise<void> {
  const sessionR = await rawDb.execute(rawSql`
    SELECT dps.id, dps.driver_id, dps.max_seats, dps.available_seats, dps.status,
           COUNT(prr.id) FILTER (WHERE prr.status IN ('matched', 'picked_up'))::int as active_passengers,
           COUNT(prr.id) FILTER (WHERE prr.status = 'picked_up')::int as onboard_passengers,
           COUNT(prr.id) FILTER (WHERE prr.status = 'matched')::int as pending_pickups
    FROM driver_pool_sessions dps
    LEFT JOIN pool_ride_requests prr ON prr.session_id = dps.id
    WHERE dps.id = ${sessionId}::uuid
    GROUP BY dps.id
    LIMIT 1
  `).catch(() => ({ rows: [] as any[] }));
  const session = sessionR.rows[0] as any;
  if (!session) return;

  const maxSeats = parseInt(session.max_seats || 0);
  const availableSeats = parseInt(session.available_seats || 0);
  const payload = {
    sessionId,
    maxSeats,
    availableSeats,
    occupiedSeats: Math.max(0, maxSeats - availableSeats),
    activePassengers: parseInt(session.active_passengers || 0),
    onboardPassengers: parseInt(session.onboard_passengers || 0),
    pendingPickups: parseInt(session.pending_pickups || 0),
    occupancyPercent: maxSeats > 0 ? Math.round(((maxSeats - availableSeats) / maxSeats) * 100) : 0,
    status: session.status,
  };

  io.to(`user:${session.driver_id}`).emit("pool:seat_update", payload);
  const customerR = await rawDb.execute(rawSql`
    SELECT customer_id
    FROM pool_ride_requests
    WHERE session_id = ${sessionId}::uuid AND status IN ('matched', 'picked_up')
  `).catch(() => ({ rows: [] as any[] }));
  for (const row of customerR.rows as any[]) {
    io.to(`user:${row.customer_id}`).emit("pool:seat_update", payload);
  }
}

// ── Core matching logic ───────────────────────────────────────────────────────

async function findBestSession(
  pickupLat: number, pickupLng: number,
  dropLat: number, dropLng: number,
  seatsNeeded: number,
  vehicleCategoryId?: string | null,
): Promise<{ sessionId: string; driverId: string } | null> {
  const customerBearing = bearingDegPool(pickupLat, pickupLng, dropLat, dropLng);

  const r = await rawDb.execute(rawSql`
    SELECT dps.id, dps.driver_id, dps.available_seats,
           dps.current_lat, dps.current_lng, dps.current_bearing_deg,
           dps.vehicle_category_id
    FROM driver_pool_sessions dps
    WHERE dps.status = 'active'
      AND dps.available_seats >= ${seatsNeeded}
      AND dps.current_lat IS NOT NULL
      AND dps.current_lng IS NOT NULL
      AND (
        6371 * 2 * ASIN(SQRT(
          POWER(SIN((${pickupLat} - dps.current_lat::float) * PI()/360), 2) +
          COS(${pickupLat} * PI()/180) * COS(dps.current_lat::float * PI()/180) *
          POWER(SIN((${pickupLng} - dps.current_lng::float) * PI()/360), 2)
        ))
      ) <= ${MAX_MATCH_RADIUS_KM}
      ${vehicleCategoryId
        ? rawSql`AND dps.vehicle_category_id = ${vehicleCategoryId}::uuid`
        : rawSql``}
    ORDER BY (
      6371 * 2 * ASIN(SQRT(
        POWER(SIN((${pickupLat} - dps.current_lat::float) * PI()/360), 2) +
        COS(${pickupLat} * PI()/180) * COS(dps.current_lat::float * PI()/180) *
        POWER(SIN((${pickupLng} - dps.current_lng::float) * PI()/360), 2)
      ))
    ) ASC
    LIMIT 10
  `).catch(() => ({ rows: [] as any[] }));

  for (const row of r.rows as any[]) {
    const driverBearing = parseFloat(row.current_bearing_deg || 0);
    // H7 FIX: bearing=0 means uninitialized GPS — skip direction check to avoid wrong rejections
    if (driverBearing > 0) {
      const bdiff = bearingDiff(driverBearing, customerBearing);
      if (bdiff > DIRECTION_TOLERANCE_DEG) continue;
    }

    const cLat = parseFloat(row.current_lat);
    const cLng = parseFloat(row.current_lng);
    const extra = detourKm(cLat, cLng, pickupLat, pickupLng, dropLat, dropLng);
    if (extra > MAX_DETOUR_KM) continue;

    return { sessionId: String(row.id), driverId: String(row.driver_id) };
  }
  return null;
}

async function matchRequest(requestId: string): Promise<boolean> {
  const reqR = await rawDb.execute(rawSql`
    SELECT * FROM pool_ride_requests WHERE id = ${requestId}::uuid AND status = 'searching' LIMIT 1
  `).catch(() => ({ rows: [] as any[] }));
  const req = reqR.rows[0] as any;
  if (!req) return false;

  const match = await findBestSession(
    parseFloat(req.pickup_lat), parseFloat(req.pickup_lng),
    parseFloat(req.drop_lat), parseFloat(req.drop_lng),
    parseInt(req.seats_requested),
    req.vehicle_category_id || null,
  );
  if (!match) return false;

  // Atomically assign request to session and decrement available_seats
  let assignedPickupOrder = 1;
  const txClient = await dbPool.connect();
  try {
    await txClient.query("BEGIN");

    // Re-check session still has seats (FOR UPDATE prevents race)
    const lockR = await txClient.query(
      `SELECT available_seats FROM driver_pool_sessions
       WHERE id = $1 AND status = 'active' AND available_seats >= $2
       FOR UPDATE`,
      [match.sessionId, parseInt(req.seats_requested)],
    );
    if (!lockR.rows.length) {
      await txClient.query("ROLLBACK");
      return false;
    }

    // Assign
    const pickupOrderR = await txClient.query(
      `SELECT COALESCE(MAX(pickup_order), 0) + 1 AS next
       FROM pool_ride_requests WHERE session_id = $1`,
      [match.sessionId],
    );
    assignedPickupOrder = pickupOrderR.rows[0].next;
    const pickupOrder = assignedPickupOrder;
    const dropOrder = assignedPickupOrder;

    await txClient.query(
      `UPDATE pool_ride_requests
       SET session_id = $1, status = 'matched', matched_at = NOW(),
           pickup_order = $2, drop_order = $3,
           seat_lock_expires_at = NOW() + INTERVAL '8 minutes',
           updated_at = NOW()
       WHERE id = $4`,
      [match.sessionId, pickupOrder, dropOrder, requestId],
    );
    await txClient.query(
      `UPDATE driver_pool_sessions
       SET available_seats = available_seats - $1, updated_at = NOW()
       WHERE id = $2`,
      [parseInt(req.seats_requested), match.sessionId],
    );

    await txClient.query("COMMIT");
  } catch (e) {
    await txClient.query("ROLLBACK");
    return false;
  } finally {
    txClient.release();
  }

  // Fetch updated request for payload
  const updR = await rawDb.execute(rawSql`
    SELECT prr.*, u.full_name as customer_name, u.phone as customer_phone
    FROM pool_ride_requests prr
    JOIN users u ON u.id = prr.customer_id
    WHERE prr.id = ${requestId}::uuid LIMIT 1
  `).catch(() => ({ rows: [] as any[] }));
  const updReq = (updR.rows[0] as any) || req;

  // Notify driver of new passenger
  io.to(`user:${match.driverId}`).emit("pool:new_passenger", {
    requestId,
    sessionId: match.sessionId,
    customerName: updReq.customer_name || "Passenger",
    customerPhone: updReq.customer_phone,
    pickupLat: parseFloat(req.pickup_lat),
    pickupLng: parseFloat(req.pickup_lng),
    dropLat: parseFloat(req.drop_lat),
    dropLng: parseFloat(req.drop_lng),
    pickupAddress: req.pickup_address,
    dropAddress: req.drop_address,
    seatsRequested: parseInt(req.seats_requested),
    totalFare: parseFloat(req.total_fare),
    pickupOrder: assignedPickupOrder,
  });

  // Notify customer they've been matched
  const driverInfoR = await rawDb.execute(rawSql`
    SELECT u.full_name, u.phone, dd.vehicle_number, dd.vehicle_model, dd.avg_rating,
           dps.current_lat, dps.current_lng
    FROM driver_pool_sessions dps
    JOIN users u ON u.id = dps.driver_id
    LEFT JOIN driver_details dd ON dd.user_id = dps.driver_id
    WHERE dps.id = ${match.sessionId}::uuid LIMIT 1
  `).catch(() => ({ rows: [] as any[] }));
  const di = (driverInfoR.rows[0] as any) || {};

  io.to(`user:${req.customer_id}`).emit("pool:matched", {
    requestId,
    sessionId: match.sessionId,
    driver: {
      name: di.full_name,
      phone: di.phone,
      vehicleNumber: di.vehicle_number,
      vehicleModel: di.vehicle_model,
      rating: di.avg_rating,
      lat: parseFloat(di.current_lat || 0),
      lng: parseFloat(di.current_lng || 0),
    },
    seatLockExpiresAt: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
    message: "Driver found! Watch for pickup notification.",
  });

  await emitSeatUpdate(match.sessionId);

  return true;
}

// ── Background matcher ────────────────────────────────────────────────────────

export function startRollingPoolMatcher(): void {
  setInterval(runMatcher, MATCHER_INTERVAL_MS);
  console.log("[ROLLING-POOL] matcher started");
}

async function runMatcher(): Promise<void> {
  try {
    // 1. Try to match all pending "searching" requests
    const searchingR = await rawDb.execute(rawSql`
      SELECT id FROM pool_ride_requests
      WHERE status = 'searching'
        AND searched_at > NOW() - INTERVAL '${rawSql.raw(String(SEARCH_TIMEOUT_MIN))} minutes'
    `).catch(() => ({ rows: [] as any[] }));

    for (const row of searchingR.rows as any[]) {
      matchRequest(String(row.id)).catch(() => undefined);
    }

    // 2. Cancel requests that have been searching too long
    const timedOutR = await rawDb.execute(rawSql`
      UPDATE pool_ride_requests
      SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
      WHERE status = 'searching'
        AND searched_at <= NOW() - INTERVAL '${rawSql.raw(String(SEARCH_TIMEOUT_MIN))} minutes'
      RETURNING id, customer_id
    `).catch(() => ({ rows: [] as any[] }));

    for (const row of timedOutR.rows as any[]) {
      io.to(`user:${(row as any).customer_id}`).emit("pool:search_timeout", {
        requestId: (row as any).id,
        message: "No pool driver available nearby. Try booking a regular ride.",
      });
    }
  } catch (e: any) {
    console.error("[ROLLING-POOL] matcher error", e?.message);
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerRollingPoolRoutes(app: Express, authApp: any, requireAdminAuth?: any): void {

  // ─── DRIVER: Start pool session ───────────────────────────────────────────

  app.post("/api/app/driver/pool/session/start", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;
      const { vehicleCategoryId, maxSeats = 4 } = req.body;

      // End any existing active session first
      await rawDb.execute(rawSql`
        UPDATE driver_pool_sessions
        SET status = 'ended', ended_at = NOW(), updated_at = NOW()
        WHERE driver_id = ${driver.id}::uuid AND status = 'active'
      `);

      const seatsN = Math.min(Math.max(parseInt(String(maxSeats)) || 4, 1), 6);

      // Get driver's current location
      const locR = await rawDb.execute(rawSql`
        SELECT current_lat, current_lng FROM users WHERE id = ${driver.id}::uuid LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      const loc = locR.rows[0] as any;

      const r = await rawDb.execute(rawSql`
        INSERT INTO driver_pool_sessions
          (driver_id, vehicle_category_id, status, max_seats, available_seats, current_lat, current_lng)
        VALUES
          (${driver.id}::uuid,
           ${vehicleCategoryId || null}${vehicleCategoryId ? rawSql`::uuid` : rawSql``},
           'active', ${seatsN}, ${seatsN},
           ${loc?.current_lat || null}, ${loc?.current_lng || null})
        RETURNING *
      `);
      const session = r.rows[0] as any;

      console.log(`[ROLLING-POOL] driver ${driver.id} started session ${session.id}`);
      await emitSeatUpdate(String(session.id));
      res.json(poolResponse(true, "POOL_SESSION_STARTED", "Pool session started", { session }));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_SESSION_START_FAILED", e.message || "Could not start pool session", {}, true));
    }
  });

  // ─── DRIVER: Update location (called from driver's GPS stream) ────────────

  app.patch("/api/app/driver/pool/location", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;
      const { lat, lng, bearingDeg } = req.body;
      if (!lat || !lng) return res.status(400).json(poolResponse(false, "POOL_LOCATION_REQUIRED", "lat/lng required"));

      await rawDb.execute(rawSql`
        UPDATE driver_pool_sessions
        SET current_lat = ${parseFloat(lat)},
            current_lng = ${parseFloat(lng)},
            current_bearing_deg = ${bearingDeg != null ? parseFloat(bearingDeg) : null},
            last_location_at = NOW(),
            updated_at = NOW()
        WHERE driver_id = ${driver.id}::uuid AND status = 'active'
      `);

      // Broadcast driver location to all matched/picked-up passengers in this session
      await rawDb.execute(rawSql`
        SELECT prr.customer_id
        FROM pool_ride_requests prr
        JOIN driver_pool_sessions dps ON dps.id = prr.session_id
        WHERE dps.driver_id = ${driver.id}::uuid
          AND dps.status = 'active'
          AND prr.status IN ('matched', 'picked_up')
      `).then(r2 => {
        for (const p of r2.rows as any[]) {
          io.to(`user:${p.customer_id}`).emit("pool:driver_location", {
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            bearingDeg: bearingDeg != null ? parseFloat(bearingDeg) : null,
          });
        }
      }).catch(() => undefined);

      const sessionR = await rawDb.execute(rawSql`
        SELECT id FROM driver_pool_sessions
        WHERE driver_id = ${driver.id}::uuid AND status = 'active' LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      const session = sessionR.rows[0] as any;
      if (session?.id) {
        await emitSeatUpdate(String(session.id));
      }

      res.json(poolResponse(true, "POOL_LOCATION_UPDATED", "Pool location updated"));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_LOCATION_UPDATE_FAILED", e.message || "Could not update pool location", {}, true));
    }
  });

  // ─── DRIVER: Get active session + current passenger queue ─────────────────

  app.get("/api/app/driver/pool/session/active", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;
      const sessionR = await rawDb.execute(rawSql`
        SELECT * FROM driver_pool_sessions
        WHERE driver_id = ${driver.id}::uuid AND status = 'active'
        LIMIT 1
      `);
      if (!sessionR.rows.length) return res.json(poolResponse(true, "POOL_SESSION_EMPTY", "No active pool session", { session: null, passengers: [] }));

      const session = sessionR.rows[0] as any;
      const passR = await rawDb.execute(rawSql`
        SELECT prr.*, u.full_name as customer_name, u.phone as customer_phone
        FROM pool_ride_requests prr
        JOIN users u ON u.id = prr.customer_id
        WHERE prr.session_id = ${session.id}::uuid
          AND prr.status IN ('matched', 'picked_up')
        ORDER BY prr.pickup_order ASC
      `);
      res.json(poolResponse(true, "POOL_SESSION_ACTIVE", "Active pool session loaded", {
        session,
        passengers: passR.rows,
      }));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_SESSION_FETCH_FAILED", e.message || "Could not load pool session", {}, true));
    }
  });

  // ─── DRIVER: Mark passenger as picked up ─────────────────────────────────

  app.post("/api/app/driver/pool/passengers/:requestId/pickup", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;
      const requestId = String(req.params.requestId);
      const otp = String(req.body?.otp ?? '').trim();
      if (otp.length === 0) {
        return res.status(400).json(poolResponse(false, "POOL_PICKUP_OTP_REQUIRED", "Boarding OTP required"));
      }

      // Verify driver owns the session for this request
      const r = await rawDb.execute(rawSql`
        UPDATE pool_ride_requests prr
        SET status = 'picked_up', picked_up_at = NOW(), updated_at = NOW()
        FROM driver_pool_sessions dps
        WHERE prr.id = ${requestId}::uuid
          AND prr.session_id = dps.id
          AND dps.driver_id = ${driver.id}::uuid
          AND dps.status = 'active'
          AND prr.status = 'matched'
          AND prr.boarding_otp = ${otp}
        RETURNING prr.customer_id, prr.pickup_address, prr.drop_address, prr.session_id
      `);
      if (!r.rows.length) return res.status(404).json(poolResponse(false, "POOL_PICKUP_FAILED", "Passenger not found, already picked up, or OTP invalid"));

      const p = r.rows[0] as any;
      io.to(`user:${p.customer_id}`).emit("pool:picked_up", {
        requestId,
        message: "You've been picked up! Enjoy your ride.",
        dropAddress: p.drop_address,
      });

      await emitSeatUpdate(String(p.session_id));
      res.json(poolResponse(true, "POOL_PASSENGER_PICKED_UP", "Passenger picked up"));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_PICKUP_ERROR", e.message || "Could not pick up passenger", {}, true));
    }
  });

  // ─── DRIVER: Drop passenger + settle fare ────────────────────────────────

  app.post("/api/app/driver/pool/passengers/:requestId/no-show", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;
      const requestId = String(req.params.requestId);

      const r = await rawDb.execute(rawSql`
        SELECT prr.session_id, prr.customer_id, prr.seats_requested
        FROM pool_ride_requests prr
        JOIN driver_pool_sessions dps ON dps.id = prr.session_id
        WHERE prr.id = ${requestId}::uuid
          AND dps.driver_id = ${driver.id}::uuid
          AND dps.status = 'active'
          AND prr.status = 'matched'
        LIMIT 1
      `);
      if (!r.rows.length) {
        return res.status(404).json(poolResponse(false, "POOL_NO_SHOW_NOT_FOUND", "Passenger not found or cannot be marked no-show"));
      }

      const row = r.rows[0] as any;
      await rawDb.execute(rawSql`
        UPDATE pool_ride_requests
        SET status = 'cancelled',
            cancelled_at = NOW(),
            cancel_reason = 'Passenger no-show',
            updated_at = NOW()
        WHERE id = ${requestId}::uuid
      `);
      await rawDb.execute(rawSql`
        UPDATE driver_pool_sessions
        SET available_seats = available_seats + ${parseInt(row.seats_requested || 1)},
            updated_at = NOW()
        WHERE id = ${row.session_id}::uuid
      `);

      io.to(`user:${row.customer_id}`).emit("pool:cancelled", {
        requestId,
        reason: "Driver marked you as a no-show for this pooled ride.",
      });
      await emitSeatUpdate(String(row.session_id));
      res.json(poolResponse(true, "POOL_PASSENGER_NO_SHOW", "Passenger marked as no-show"));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_NO_SHOW_FAILED", e.message || "Could not mark no-show", {}, true));
    }
  });

  app.post("/api/app/driver/pool/passengers/:requestId/drop", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;
      const requestId = String(req.params.requestId);

      // Fetch request + session together (verify ownership)
      const rr = await rawDb.execute(rawSql`
        SELECT prr.*, dps.id as session_id
        FROM pool_ride_requests prr
        JOIN driver_pool_sessions dps ON dps.id = prr.session_id
        WHERE prr.id = ${requestId}::uuid
          AND dps.driver_id = ${driver.id}::uuid
          AND dps.status = 'active'
          AND prr.status = 'picked_up'
        LIMIT 1
      `);
      if (!rr.rows.length) return res.status(404).json({ message: "Passenger not found or not picked up yet" });
      const req_ = rr.rows[0] as any;

      // Mark dropped + free seats atomically
      await rawDb.execute(rawSql`
        UPDATE pool_ride_requests
        SET status = 'dropped', dropped_at = NOW(), updated_at = NOW()
        WHERE id = ${requestId}::uuid
      `);
      await rawDb.execute(rawSql`
        UPDATE driver_pool_sessions
        SET available_seats = available_seats + ${parseInt(req_.seats_requested)},
            total_passengers_served = total_passengers_served + 1,
            updated_at = NOW()
        WHERE id = ${req_.session_id}::uuid
      `);

      // Revenue settlement for this passenger
      const fare = parseFloat(req_.total_fare);
      let driverEarnings = fare;
      let newWalletBalance = 0;
      try {
        const breakdown = await calculateRevenueBreakdown(fare, "city_pool", driver.id);
        const settlement = await settleRevenue({
          driverId: driver.id,
          tripId: requestId,
          fare,
          paymentMethod: req_.payment_method || "cash",
          breakdown,
          serviceCategory: "city_pool",
          serviceLabel: "rolling_pool",
        });
        driverEarnings = breakdown.driverEarnings;
        newWalletBalance = settlement.newWalletBalance;

        // Update total_earnings on session
        await rawDb.execute(rawSql`
          UPDATE driver_pool_sessions
          SET total_earnings = total_earnings + ${driverEarnings}, updated_at = NOW()
          WHERE id = ${req_.session_id}::uuid
        `);
      } catch (settleErr: any) {
        console.error("[ROLLING-POOL] settlement error", settleErr?.message);
      }

      // Notify customer they've been dropped
      io.to(`user:${req_.customer_id}`).emit("pool:dropped", {
        requestId,
        fare,
        driverEarnings,
        message: "Thanks for riding! Have a great day.",
      });

      await emitSeatUpdate(String(req_.session_id));
      res.json(poolResponse(true, "POOL_PASSENGER_DROPPED", "Passenger dropped successfully", {
        fare,
        driverEarnings,
        newWalletBalance,
      }));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_DROP_FAILED", e.message || "Could not complete pooled drop", {}, true));
    }
  });

  // ─── DRIVER: End pool session ─────────────────────────────────────────────

  app.post("/api/app/driver/pool/session/end", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;

      // Cancel all pending matched requests in this session (no-shows)
      const sessionR = await rawDb.execute(rawSql`
        SELECT id FROM driver_pool_sessions
        WHERE driver_id = ${driver.id}::uuid AND status = 'active' LIMIT 1
      `);
      if (!sessionR.rows.length) return res.json(poolResponse(true, "POOL_SESSION_ALREADY_ENDED", "No active session"));

      const sessionId = (sessionR.rows[0] as any).id;

      // H8 FIX: Cancel matched AND picked_up passengers on session end
      // picked_up passengers who didn't complete their drop get a refund
      const pendingR = await rawDb.execute(rawSql`
        UPDATE pool_ride_requests
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW(),
            refund_amount = CASE WHEN status = 'picked_up' THEN COALESCE(fare, 0) ELSE 0 END,
            cancel_reason = CASE WHEN status = 'picked_up' THEN 'Driver ended session mid-ride' ELSE 'Driver ended pool session' END
        WHERE session_id = ${sessionId}::uuid AND status IN ('matched', 'picked_up')
        RETURNING customer_id, status, refund_amount
      `);
      for (const p of pendingR.rows as any[]) {
        const wasPickedUp = p.status === 'picked_up';
        const refundAmt = parseFloat(p.refund_amount || 0);
        io.to(`user:${p.customer_id}`).emit("pool:cancelled", {
          reason: wasPickedUp
            ? "Driver ended session during your ride. A refund has been initiated."
            : "Driver ended pool session. Please rebook.",
          refundAmount: wasPickedUp ? refundAmt : 0,
        });
      }

      // End session
      const endR = await rawDb.execute(rawSql`
        UPDATE driver_pool_sessions
        SET status = 'ended', ended_at = NOW(), updated_at = NOW()
        WHERE id = ${sessionId}::uuid
        RETURNING total_passengers_served, total_earnings
      `);
      const stats = endR.rows[0] as any;

      console.log(`[ROLLING-POOL] driver ${driver.id} ended session ${sessionId}`);
      await emitSeatUpdate(String(sessionId));
      res.json(poolResponse(true, "POOL_SESSION_ENDED", "Pool session ended", {
        totalPassengersServed: parseInt(stats?.total_passengers_served || 0),
        totalEarnings: parseFloat(stats?.total_earnings || 0),
      }));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_SESSION_END_FAILED", e.message || "Could not end pool session", {}, true));
    }
  });

  // ─── CUSTOMER: Book a rolling pool ride ──────────────────────────────────

  app.post("/api/app/customer/pool/book", authApp, async (req: any, res: any) => {
    try {
      const customer = req.currentUser;
      const {
        pickupLat, pickupLng, dropLat, dropLng,
        pickupAddress = "", dropAddress = "",
        seatsRequested = 1,
        vehicleCategoryId,
        paymentMethod = "cash",
      } = req.body;

      if (!pickupLat || !pickupLng || !dropLat || !dropLng) {
        return res.status(400).json(poolResponse(false, "POOL_COORDS_REQUIRED", "Pickup and drop coordinates required"));
      }

      const requestedSeats = parseInt(String(seatsRequested), 10) || 1;
      if (requestedSeats < 1 || requestedSeats > 2) {
        return res.status(400).json(poolResponse(
          false,
          "POOL_SEAT_LIMIT",
          "You can book only 1 or 2 seats per pool booking",
        ));
      }
      const seats = requestedSeats;
      const pLat = parseFloat(pickupLat);
      const pLng = parseFloat(pickupLng);
      const dLat = parseFloat(dropLat);
      const dLng = parseFloat(dropLng);
      const distKm = haversineKmPool(pLat, pLng, dLat, dLng);
      const { farePerSeat, totalFare } = calcPoolFare(distKm, seats);
      const commissionAmount = Math.round(totalFare * 0.15 * 100) / 100;
      const driverEarnings = Math.round((totalFare - commissionAmount) * 100) / 100;
      const boardingOtp = generateBoardingOtp();
      const clusterKey = [
        Math.round(pLat * 100) / 100,
        Math.round(pLng * 100) / 100,
        Math.round(dLat * 100) / 100,
        Math.round(dLng * 100) / 100,
      ].join(':');

      // Create request in 'searching' state
      const r = await rawDb.execute(rawSql`
        INSERT INTO pool_ride_requests
          (customer_id, vehicle_category_id, pickup_lat, pickup_lng, drop_lat, drop_lng,
           pickup_address, drop_address, seats_requested,
           fare_per_seat, total_fare, distance_km, commission_amount, driver_earnings,
           payment_method, status, searched_at, boarding_otp, cluster_key)
        VALUES
          (${customer.id}::uuid,
           ${vehicleCategoryId || null}${vehicleCategoryId ? rawSql`::uuid` : rawSql``},
           ${pLat}, ${pLng}, ${dLat}, ${dLng},
           ${pickupAddress || null}, ${dropAddress || null}, ${seats},
           ${farePerSeat}, ${totalFare}, ${distKm}, ${commissionAmount}, ${driverEarnings},
           ${paymentMethod}, 'searching', NOW(), ${boardingOtp}, ${clusterKey})
        RETURNING id
      `);
      const requestId = String((r.rows[0] as any).id);

      // Try immediate match
      const matched = await matchRequest(requestId);

      res.json(poolResponse(true, matched ? "POOL_MATCHED" : "POOL_SEARCHING", matched ? "Driver found! Tracking now." : `Searching for a pool driver nearby... (up to ${SEARCH_TIMEOUT_MIN} min)`, {
        requestId,
        status: matched ? "matched" : "searching",
        boardingOtp,
        farePerSeat,
        totalFare,
        seatsRequested: seats,
        distanceKm: distKm,
        fareBreakdown: {
          perSeatFare: farePerSeat,
          seatsBooked: seats,
          totalFare,
          commissionAmount,
          driverEarnings,
          note: `Dynamic pool fare — Rs ${farePerSeat.toFixed(0)}/seat x ${seats} = Rs ${totalFare.toFixed(0)}`,
        },
      }));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_BOOKING_FAILED", e.message || "Could not create pooled booking", {}, true));
    }
  });

  // ─── CUSTOMER: Get booking status ────────────────────────────────────────

  app.get("/api/app/customer/pool/status/:requestId", authApp, async (req: any, res: any) => {
    try {
      const customer = req.currentUser;
      const requestId = String(req.params.requestId);

      const r = await rawDb.execute(rawSql`
        SELECT prr.*,
          u.full_name as driver_name, u.phone as driver_phone,
          dd.vehicle_number, dd.vehicle_model, dd.avg_rating,
          dps.current_lat as driver_lat, dps.current_lng as driver_lng
        FROM pool_ride_requests prr
        LEFT JOIN driver_pool_sessions dps ON dps.id = prr.session_id
        LEFT JOIN users u ON u.id = dps.driver_id
        LEFT JOIN driver_details dd ON dd.user_id = dps.driver_id
        WHERE prr.id = ${requestId}::uuid AND prr.customer_id = ${customer.id}::uuid
        LIMIT 1
      `);
      if (!r.rows.length) return res.status(404).json(poolResponse(false, "POOL_STATUS_NOT_FOUND", "Booking not found"));

      res.json(poolResponse(true, "POOL_STATUS_LOADED", "Pool booking loaded", { booking: r.rows[0] }));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_STATUS_FAILED", e.message || "Could not load pool status", {}, true));
    }
  });

  // ─── CUSTOMER: Cancel booking ─────────────────────────────────────────────

  app.post("/api/app/customer/pool/cancel/:requestId", authApp, async (req: any, res: any) => {
    try {
      const customer = req.currentUser;
      const requestId = String(req.params.requestId);

      const r = await rawDb.execute(rawSql`
        SELECT prr.status, prr.seats_requested, prr.session_id
        FROM pool_ride_requests prr
        WHERE prr.id = ${requestId}::uuid AND prr.customer_id = ${customer.id}::uuid
        LIMIT 1
      `);
      if (!r.rows.length) return res.status(404).json(poolResponse(false, "POOL_CANCEL_NOT_FOUND", "Booking not found"));

      const booking = r.rows[0] as any;
      if (booking.status === "picked_up") {
        return res.status(400).json(poolResponse(false, "POOL_CANCEL_TOO_LATE", "Cannot cancel - already picked up"));
      }
      if (["dropped", "cancelled"].includes(booking.status)) {
        return res.json(poolResponse(true, "POOL_ALREADY_CLOSED", "Already completed/cancelled"));
      }

      await rawDb.execute(rawSql`
        UPDATE pool_ride_requests
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE id = ${requestId}::uuid AND customer_id = ${customer.id}::uuid
      `);

      // Free seats if matched to a session
      if (booking.session_id) {
        await rawDb.execute(rawSql`
          UPDATE driver_pool_sessions
          SET available_seats = available_seats + ${parseInt(booking.seats_requested) || 1},
              updated_at = NOW()
          WHERE id = ${booking.session_id}::uuid AND status = 'active'
        `);

        // Notify driver that passenger cancelled
        const driverR = await rawDb.execute(rawSql`
          SELECT driver_id FROM driver_pool_sessions WHERE id = ${booking.session_id}::uuid LIMIT 1
        `).catch(() => ({ rows: [] as any[] }));
        const drv = driverR.rows[0] as any;
        if (drv?.driver_id) {
          io.to(`user:${drv.driver_id}`).emit("pool:passenger_cancelled", {
            requestId,
            message: "A passenger cancelled their booking.",
          });
        }
        await emitSeatUpdate(String(booking.session_id));
      }

      res.json(poolResponse(true, "POOL_CANCELLED", "Pool booking cancelled"));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_CANCEL_FAILED", e.message || "Could not cancel pool booking", {}, true));
    }
  });

  // ─── CUSTOMER: My pool ride history ──────────────────────────────────────

  app.get("/api/app/customer/pool/history", authApp, async (req: any, res: any) => {
    try {
      const customer = req.currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT prr.*,
          u.full_name as driver_name, dd.vehicle_number, dd.vehicle_model, dd.avg_rating
        FROM pool_ride_requests prr
        LEFT JOIN driver_pool_sessions dps ON dps.id = prr.session_id
        LEFT JOIN users u ON u.id = dps.driver_id
        LEFT JOIN driver_details dd ON dd.user_id = dps.driver_id
        WHERE prr.customer_id = ${customer.id}::uuid
        ORDER BY prr.created_at DESC
        LIMIT 50
      `);
      res.json(poolResponse(true, "POOL_HISTORY_LOADED", "Pool booking history loaded", { bookings: r.rows }));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_HISTORY_FAILED", e.message || "Could not load pool history", {}, true));
    }
  });

  // ─── ADMIN: Active pool sessions ──────────────────────────────────────────

  app.get("/api/admin/pool/sessions", requireAdminAuth || ((_req: any, _res: any, next: any) => next()), async (req: any, res: any) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT dps.*,
          u.full_name as driver_name, u.phone as driver_phone,
          COUNT(prr.id) FILTER (WHERE prr.status = 'picked_up')::int as passengers_onboard,
          COUNT(prr.id) FILTER (WHERE prr.status = 'matched')::int as pending_pickups,
          COUNT(prr.id) FILTER (WHERE prr.status = 'dropped')::int as dropped_count
        FROM driver_pool_sessions dps
        JOIN users u ON u.id = dps.driver_id
        LEFT JOIN pool_ride_requests prr ON prr.session_id = dps.id
        WHERE dps.status = 'active'
        GROUP BY dps.id, u.full_name, u.phone
        ORDER BY dps.started_at DESC
      `);
      res.json(poolResponse(true, "POOL_SESSIONS_LOADED", "Active pool sessions loaded", { sessions: r.rows }));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_SESSIONS_FAILED", e.message || "Could not load active pool sessions", {}, true));
    }
  });

  app.get("/api/admin/pool/stats", requireAdminAuth || ((_req: any, _res: any, next: any) => next()), async (_req: any, res: any) => {
    try {
      const r = await rawDb.execute(rawSql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::int as active_sessions,
          COUNT(*) FILTER (WHERE status = 'ended')::int as ended_sessions,
          COALESCE(SUM(total_passengers_served), 0)::int as total_passengers_served,
          COALESCE(SUM(total_earnings), 0)::numeric as total_driver_earnings,
          COALESCE(AVG(NULLIF(max_seats - available_seats, 0)), 0)::numeric as avg_occupied_seats
        FROM driver_pool_sessions
      `);
      res.json(poolResponse(true, "POOL_STATS_LOADED", "Pool analytics loaded", {
        stats: r.rows[0] ?? {},
      }));
    } catch (e: any) {
      res.status(500).json(poolResponse(false, "POOL_STATS_FAILED", e.message || "Could not load pool analytics", {}, true));
    }
  });
}
