/**
 * Outstation Pool V2 — Distance-Proportional Segment Fare Engine
 *
 * Example: Driver posts VJA → HYD (300km), ₹1.8/km/seat
 *   Passenger A: VJA → HYD = 300km × 1.8 = ₹540/seat
 *   Passenger B: VJA → GNT = 90km × 1.8  = ₹162/seat  (joins + exits midway)
 *   Passenger C: GNT → HYD = 210km × 1.8 = ₹378/seat  (joins at Guntur)
 *
 * Revenue settled per-drop. Driver picks up/drops each passenger individually.
 * Full segment freedom — any pickup/drop along the route within tolerance.
 */

import type { Express } from "express";
import { rawDb, rawSql, pool as dbPool } from "./db";
import { io } from "./socket";
import { sendFcmNotification } from "./fcm";
import { calculateRevenueBreakdown, settleRevenue } from "./revenue-engine";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PRICE_PER_KM_PER_SEAT = 1.8;   // ₹1.8/km/seat
const MIN_FARE_PER_BOOKING = 50;              // minimum ₹50 per booking
const ROUTE_CORRIDOR_KM = 15;                 // pickup/drop must be within 15km of route line
const DIRECTION_TOLERANCE_DEG = 45;           // bearing tolerance for "on route" check

function normalizePoolKey(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isPoolVehicleCategory(row: any): boolean {
  const key = normalizePoolKey(row?.vehicle_type || row?.slug || row?.name);
  const serviceType = normalizePoolKey(row?.service_type || row?.type);
  return Boolean(row) && (
    row.is_carpool === true ||
    row.is_carpool === "true" ||
    serviceType === "pool" ||
    serviceType === "carpool" ||
    key === "car_pool_4" ||
    key === "car_pool_6" ||
    key === "carpool" ||
    key.includes("pool")
  );
}

// ── Schema migration (safe — all IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) ──

export async function ensureOutstationPoolV2Schema(): Promise<void> {
  // Add new columns to existing outstation_pool_rides
  const rideAlters = [
    `ALTER TABLE outstation_pool_rides ADD COLUMN IF NOT EXISTS price_per_km_per_seat NUMERIC(10,2) DEFAULT ${DEFAULT_PRICE_PER_KM_PER_SEAT}`,
    `ALTER TABLE outstation_pool_rides ADD COLUMN IF NOT EXISTS from_lat NUMERIC(10,7)`,
    `ALTER TABLE outstation_pool_rides ADD COLUMN IF NOT EXISTS from_lng NUMERIC(10,7)`,
    `ALTER TABLE outstation_pool_rides ADD COLUMN IF NOT EXISTS to_lat NUMERIC(10,7)`,
    `ALTER TABLE outstation_pool_rides ADD COLUMN IF NOT EXISTS to_lng NUMERIC(10,7)`,
    `ALTER TABLE outstation_pool_rides ADD COLUMN IF NOT EXISTS current_lat NUMERIC(10,7)`,
    `ALTER TABLE outstation_pool_rides ADD COLUMN IF NOT EXISTS current_lng NUMERIC(10,7)`,
    `ALTER TABLE outstation_pool_rides ADD COLUMN IF NOT EXISTS accepting_new_requests BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE outstation_pool_rides ADD COLUMN IF NOT EXISTS state_version INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE outstation_pool_rides ADD COLUMN IF NOT EXISTS route_plan JSONB NOT NULL DEFAULT '[]'`,
    `ALTER TABLE outstation_pool_rides ADD COLUMN IF NOT EXISTS vehicle_category_id UUID`,
  ];
  for (const sql of rideAlters) {
    await rawDb.execute(rawSql.raw(sql)).catch(() => undefined);
  }

  // Add new columns to existing outstation_pool_bookings
  const bookingAlters = [
    `ALTER TABLE outstation_pool_bookings ADD COLUMN IF NOT EXISTS pickup_lat NUMERIC(10,7)`,
    `ALTER TABLE outstation_pool_bookings ADD COLUMN IF NOT EXISTS pickup_lng NUMERIC(10,7)`,
    `ALTER TABLE outstation_pool_bookings ADD COLUMN IF NOT EXISTS drop_lat NUMERIC(10,7)`,
    `ALTER TABLE outstation_pool_bookings ADD COLUMN IF NOT EXISTS drop_lng NUMERIC(10,7)`,
    `ALTER TABLE outstation_pool_bookings ADD COLUMN IF NOT EXISTS segment_km NUMERIC(10,2) DEFAULT 0`,
    `ALTER TABLE outstation_pool_bookings ADD COLUMN IF NOT EXISTS fare_per_seat NUMERIC(10,2) DEFAULT 0`,
    `ALTER TABLE outstation_pool_bookings ADD COLUMN IF NOT EXISTS pickup_order INTEGER DEFAULT 1`,
    `ALTER TABLE outstation_pool_bookings ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMP`,
    `ALTER TABLE outstation_pool_bookings ADD COLUMN IF NOT EXISTS dropped_at TIMESTAMP`,
    `ALTER TABLE outstation_pool_bookings ADD COLUMN IF NOT EXISTS driver_earnings NUMERIC(10,2)`,
    `ALTER TABLE outstation_pool_bookings ADD COLUMN IF NOT EXISTS revenue_model VARCHAR(40)`,
  ];
  for (const sql of bookingAlters) {
    await rawDb.execute(rawSql.raw(sql)).catch(() => undefined);
  }

  console.log("[OUTSTATION-V2] Schema columns ensured");
}

// ── Geo helpers ───────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const f1 = lat1 * Math.PI / 180, f2 = lat2 * Math.PI / 180;
  const dl = (lng2 - lng1) * Math.PI / 180;
  return ((Math.atan2(
    Math.sin(dl) * Math.cos(f2),
    Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl),
  ) * 180 / Math.PI) + 360) % 360;
}

function bearingDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Distance from point P to line segment A→B (in km).
 * Used to check if a customer's pickup/drop is "on the route corridor".
 */
function pointToSegmentDistKm(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const abKm = haversineKm(aLat, aLng, bLat, bLng);
  if (abKm < 0.001) return haversineKm(pLat, pLng, aLat, aLng);

  // Project point onto line using dot product approximation (flat-earth ok for <500km)
  const t = Math.max(0, Math.min(1,
    ((pLat - aLat) * (bLat - aLat) + (pLng - aLng) * (bLng - aLng)) /
    ((bLat - aLat) ** 2 + (bLng - aLng) ** 2),
  ));
  const projLat = aLat + t * (bLat - aLat);
  const projLng = aLng + t * (bLng - aLng);
  return haversineKm(pLat, pLng, projLat, projLng);
}

/**
 * Is this pickup/drop point "on" the route from (aLat,aLng) to (bLat,bLng)?
 * Checks corridor distance AND that it lies within the route extent.
 */
function isOnRoute(
  pLat: number, pLng: number,
  fromLat: number, fromLng: number,
  toLat: number, toLng: number,
): boolean {
  // Must be within corridor
  const corridorDist = pointToSegmentDistKm(pLat, pLng, fromLat, fromLng, toLat, toLng);
  if (corridorDist > ROUTE_CORRIDOR_KM) return false;

  // Must be between the two endpoints (not before from or after to)
  const totalKm = haversineKm(fromLat, fromLng, toLat, toLng);
  const fromToPoint = haversineKm(fromLat, fromLng, pLat, pLng);
  return fromToPoint <= totalKm + ROUTE_CORRIDOR_KM;
}

/**
 * Is pickup BEFORE drop along the route direction?
 * Pickup must be closer to `from` than drop is.
 */
function pickupBeforeDrop(
  pickupLat: number, pickupLng: number,
  dropLat: number, dropLng: number,
  fromLat: number, fromLng: number,
): boolean {
  const fromToPickup = haversineKm(fromLat, fromLng, pickupLat, pickupLng);
  const fromToDrop   = haversineKm(fromLat, fromLng, dropLat, dropLng);
  return fromToPickup < fromToDrop;
}

// ── Fare calculation ──────────────────────────────────────────────────────────

function calcSegmentFare(segmentKm: number, seats: number, pricePerKmPerSeat: number): {
  farePerSeat: number;
  totalFare: number;
  segmentKm: number;
} {
  const rawPerSeat = Math.max(MIN_FARE_PER_BOOKING, pricePerKmPerSeat * segmentKm);
  const farePerSeat = Math.round(rawPerSeat * 100) / 100;
  return {
    farePerSeat,
    totalFare: Math.round(farePerSeat * seats * 100) / 100,
    segmentKm: Math.round(segmentKm * 100) / 100,
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerOutstationPoolV2Routes(app: Express, authApp: any): void {

  // ─── DRIVER: Post a trip WITH coordinates + price_per_km ─────────────────
  // Replaces the old flat fare_per_seat model. Both are stored.

  app.post("/api/app/driver/outstation-pool/v2/rides", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;
      const {
        fromCity, toCity,
        fromLat, fromLng, toLat, toLng,
        departureDate, departureTime,
        totalSeats = 4,
        pricePerKmPerSeat,
        vehicleNumber, vehicleModel, note,
      } = req.body;

      if (!fromCity || !toCity) return res.status(400).json({ message: "fromCity and toCity required" });
      if (!fromLat || !fromLng || !toLat || !toLng) {
        return res.status(400).json({ message: "from/to coordinates required" });
      }

      const fromLatN = parseFloat(fromLat);
      const fromLngN = parseFloat(fromLng);
      const toLatN   = parseFloat(toLat);
      const toLngN   = parseFloat(toLng);
      const routeKm  = haversineKm(fromLatN, fromLngN, toLatN, toLngN);
      const pkmps    = parseFloat(String(pricePerKmPerSeat)) || DEFAULT_PRICE_PER_KM_PER_SEAT;

      const driverCategoryR = await rawDb.execute(rawSql`
        SELECT
          dd.vehicle_category_id,
          vc.id,
          vc.name,
          vc.slug,
          vc.type,
          vc.service_type,
          vc.vehicle_type,
          vc.is_carpool,
          vc.total_seats
        FROM driver_details dd
        LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
        WHERE dd.user_id = ${driver.id}::uuid
        LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      const driverCategory = driverCategoryR.rows[0] as any;
      if (!isPoolVehicleCategory(driverCategory)) {
        return res.status(403).json({
          message: "Only approved pool-enabled drivers can create outstation pool rides",
          code: "OUTSTATION_POOL_DRIVER_NOT_ELIGIBLE",
        });
      }

      const requestedSeats = Math.min(Math.max(parseInt(String(totalSeats)) || 4, 1), 8);
      const categorySeats = parseInt(String(driverCategory?.total_seats || 0));
      const seats = categorySeats > 0 ? Math.min(requestedSeats, categorySeats) : requestedSeats;
      // Legacy fare_per_seat = full-route fare for reference
      const farePerSeat = Math.round(Math.max(MIN_FARE_PER_BOOKING, pkmps * routeKm) * 100) / 100;

      const r = await rawDb.execute(rawSql`
        INSERT INTO outstation_pool_rides
          (driver_id, vehicle_category_id, from_city, to_city, from_lat, from_lng, to_lat, to_lng,
           route_km, departure_date, departure_time,
           total_seats, available_seats, vehicle_number, vehicle_model,
           fare_per_seat, price_per_km_per_seat, note, status, is_active)
        VALUES
          (${driver.id}::uuid,
           ${String(driverCategory.vehicle_category_id || driverCategory.id)}::uuid,
           ${fromCity}, ${toCity},
           ${fromLatN}, ${fromLngN}, ${toLatN}, ${toLngN},
           ${routeKm}, ${departureDate || null}, ${departureTime || null},
           ${seats}, ${seats}, ${vehicleNumber || null}, ${vehicleModel || null},
           ${farePerSeat}, ${pkmps}, ${note || null}, 'scheduled', true)
        RETURNING *
      `);

      res.json({
        success: true,
        ride: r.rows[0],
        info: {
          routeKm: Math.round(routeKm),
          pricePerKmPerSeat: pkmps,
          fullRouteFarePerSeat: farePerSeat,
          example: `VJA→halfway = ₹${Math.round(farePerSeat * 0.5)}/seat`,
        },
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ─── DRIVER: Start the trip (mark as active, set current location) ────────

  app.get("/api/app/driver/outstation-pool/rides/:id/passengers", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;
      const rideId = String(req.params.id);
      const ownRide = await rawDb.execute(rawSql`
        SELECT id FROM outstation_pool_rides
        WHERE id=${rideId}::uuid AND driver_id=${driver.id}::uuid
        LIMIT 1
      `);
      if (!ownRide.rows.length) return res.status(404).json({ message: "Ride not found" });

      const r = await rawDb.execute(rawSql`
        SELECT opb.*,
          u.full_name as passenger_name,
          u.phone as passenger_phone
        FROM outstation_pool_bookings opb
        LEFT JOIN users u ON u.id = opb.customer_id
        WHERE opb.ride_id=${rideId}::uuid
          AND opb.status != 'cancelled'
        ORDER BY COALESCE(opb.pickup_order, 1), opb.created_at ASC
      `);
      res.json({ passengers: r.rows });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/app/driver/outstation-pool/rides/:id/start", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;
      const rideId = String(req.params.id);
      const { lat, lng } = req.body;

      const r = await rawDb.execute(rawSql`
        UPDATE outstation_pool_rides
        SET status = 'active',
            current_lat = ${lat ? parseFloat(lat) : null},
            current_lng = ${lng ? parseFloat(lng) : null},
            updated_at = NOW()
        WHERE id = ${rideId}::uuid AND driver_id = ${driver.id}::uuid AND status = 'scheduled'
        RETURNING id
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Ride not found or already started" });

      // Notify all confirmed passengers
      const bookingsR = await rawDb.execute(rawSql`
        SELECT customer_id FROM outstation_pool_bookings
        WHERE ride_id = ${rideId}::uuid AND status = 'confirmed'
      `).catch(() => ({ rows: [] as any[] }));
      for (const b of bookingsR.rows as any[]) {
        io.to(`user:${b.customer_id}`).emit("outstation_pool:trip_started", {
          rideId,
          message: "Your driver has started the trip! Get ready for pickup.",
        });
      }

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ─── DRIVER: Update location (broadcast to all passengers in this ride) ───

  app.post("/api/app/driver/outstation-pool/rides/:id/accepting", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;
      const rideId = String(req.params.id);
      const accepting = req.body?.acceptingNewRequests !== false;
      const r = await rawDb.execute(rawSql`
        UPDATE outstation_pool_rides
        SET accepting_new_requests = ${accepting},
            state_version = state_version + 1,
            updated_at = NOW()
        WHERE id = ${rideId}::uuid
          AND driver_id = ${driver.id}::uuid
          AND status IN ('scheduled', 'active')
        RETURNING id, accepting_new_requests, state_version
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Ride not found or already closed" });
      const row = r.rows[0] as any;
      const passengersR = await rawDb.execute(rawSql`
        SELECT customer_id FROM outstation_pool_bookings
        WHERE ride_id = ${rideId}::uuid AND status IN ('confirmed', 'picked_up')
      `).catch(() => ({ rows: [] as any[] }));
      for (const p of passengersR.rows as any[]) {
        io.to(`user:${p.customer_id}`).emit("outstation_pool:seat_update", {
          rideId,
          acceptingNewRequests: row.accepting_new_requests !== false,
          stateVersion: parseInt(row.state_version || 1),
        });
      }
      res.json({ success: true, acceptingNewRequests: row.accepting_new_requests !== false, stateVersion: parseInt(row.state_version || 1) });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/app/driver/outstation-pool/rides/:id/location", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;
      const rideId = String(req.params.id);
      const { lat, lng } = req.body;
      if (!lat || !lng) return res.status(400).json({ message: "lat/lng required" });

      await rawDb.execute(rawSql`
        UPDATE outstation_pool_rides
        SET current_lat = ${parseFloat(lat)}, current_lng = ${parseFloat(lng)}, updated_at = NOW()
        WHERE id = ${rideId}::uuid AND driver_id = ${driver.id}::uuid AND status = 'active'
      `);

      // Broadcast to all active passengers
      const passR = await rawDb.execute(rawSql`
        SELECT customer_id FROM outstation_pool_bookings
        WHERE ride_id = ${rideId}::uuid AND status IN ('confirmed', 'picked_up')
      `).catch(() => ({ rows: [] as any[] }));
      for (const p of passR.rows as any[]) {
        io.to(`user:${p.customer_id}`).emit("outstation_pool:driver_location", {
          rideId, lat: parseFloat(lat), lng: parseFloat(lng),
        });
      }

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ─── DRIVER: Pick up a passenger ─────────────────────────────────────────

  app.post("/api/app/driver/outstation-pool/passengers/:bookingId/pickup", authApp, async (req: any, res: any) => {
    try {
      const driver = req.currentUser;
      const bookingId = String(req.params.bookingId);

      const r = await rawDb.execute(rawSql`
        UPDATE outstation_pool_bookings opb
        SET status = 'picked_up', picked_up_at = NOW(), updated_at = NOW()
        FROM outstation_pool_rides opr
        WHERE opb.id = ${bookingId}::uuid
          AND opb.ride_id = opr.id
          AND opr.driver_id = ${driver.id}::uuid
          AND opr.status = 'active'
          AND opb.status = 'confirmed'
        RETURNING opb.customer_id, opb.dropoff_address, opb.to_city
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Booking not found or not in confirmed state" });

      const b = r.rows[0] as any;
      io.to(`user:${b.customer_id}`).emit("outstation_pool:picked_up", {
        bookingId,
        message: `You've been picked up! Drop: ${b.dropoff_address || b.to_city}`,
      });

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ─── DRIVER: Drop a passenger + settle per-booking fare ──────────────────

  app.post("/api/app/driver/outstation-pool/passengers/:bookingId/drop", authApp, async (req: any, res: any) => {
    const driver = req.currentUser;
    const bookingId = String(req.params.bookingId);

    const client = await dbPool.connect();
    try {
      await client.query("BEGIN");

      // CRITICAL FIX C2: Lock booking row to prevent concurrent double-drop settlement
      const fetchR = await client.query(
        `SELECT opb.*, opr.id as ride_id
         FROM outstation_pool_bookings opb
         JOIN outstation_pool_rides opr ON opr.id = opb.ride_id
         WHERE opb.id = $1::uuid
           AND opr.driver_id = $2::uuid
           AND opr.status = 'active'
           AND opb.status = 'picked_up'
         FOR UPDATE OF opb`,
        [bookingId, driver.id],
      );
      if (!fetchR.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Booking not picked up or not found" });
      }

      const booking = fetchR.rows[0] as any;
      const fare = parseFloat(booking.total_fare || 0);
      const seatsBooked = parseInt(booking.seats_booked) || 1;

      await client.query(
        `UPDATE outstation_pool_bookings
         SET status = 'dropped', dropped_at = NOW(), payment_status = 'paid', updated_at = NOW()
         WHERE id = $1::uuid`,
        [bookingId],
      );
      await client.query(
        `UPDATE outstation_pool_rides
         SET available_seats = available_seats + $1, updated_at = NOW()
         WHERE id = $2::uuid`,
        [seatsBooked, booking.ride_id],
      );

      // CRITICAL: Commit BEFORE settlement to release lock and ensure drop is persisted
      await client.query("COMMIT");

      // Revenue settlement outside the lock (non-critical path)
      let driverEarnings = fare;
      let newWalletBalance = 0;
      try {
        const breakdown = await calculateRevenueBreakdown(fare, "outstation_pool", driver.id);
        const settlement = await settleRevenue({
          driverId: driver.id,
          tripId: bookingId,
          fare,
          paymentMethod: booking.payment_method || "cash",
          breakdown,
          serviceCategory: "outstation_pool",
          serviceLabel: "outstation_pool_segment",
        });
        driverEarnings = breakdown.driverEarnings;
        newWalletBalance = settlement.newWalletBalance;
        await rawDb.execute(rawSql`
          UPDATE outstation_pool_bookings
          SET driver_earnings = ${driverEarnings}, revenue_model = ${breakdown.model}
          WHERE id = ${bookingId}::uuid
        `).catch(() => undefined);
      } catch (settleErr: any) {
        console.error("[OUTSTATION-V2] settlement error", settleErr?.message);
      }

      io.to(`user:${booking.customer_id}`).emit("outstation_pool:dropped", {
        bookingId, fare, driverEarnings,
        message: "You've reached your destination! Thanks for riding with Jago Pool.",
      });

      res.json({ success: true, fare, driverEarnings, newWalletBalance });
    } catch (e: any) {
      await client.query("ROLLBACK").catch(() => undefined);
      res.status(500).json({ message: e.message });
    } finally {
      client.release();
    }
  });

  // ─── CUSTOMER: Search rides with segment fare preview ────────────────────

  app.get("/api/app/customer/outstation-pool/v2/search", authApp, async (req: any, res: any) => {
    try {
      const {
        fromCity, toCity,
        pickupLat, pickupLng, dropLat, dropLng,
        date, seats = "1",
      } = req.query as any;

      if (!fromCity || !toCity) return res.status(400).json({ message: "fromCity and toCity required" });

      const requestedSeats = parseInt(String(seats), 10) || 1;
      if (requestedSeats < 1 || requestedSeats > 2) {
        return res.status(400).json({ message: "You can book only 1 or 2 seats per booking" });
      }
      const seatsN = requestedSeats;
      const pLat = pickupLat ? parseFloat(pickupLat) : null;
      const pLng = pickupLng ? parseFloat(pickupLng) : null;
      const dLat = dropLat   ? parseFloat(dropLat)   : null;
      const dLng = dropLng   ? parseFloat(dropLng)   : null;

      const r = await rawDb.execute(rawSql`
        SELECT opr.*,
          u.full_name as driver_name, u.phone as driver_phone,
          dd.avg_rating as driver_rating, dd.vehicle_number, dd.vehicle_model,
          COUNT(opb.id) FILTER (WHERE opb.status != 'cancelled')::int as booked_count
        FROM outstation_pool_rides opr
        JOIN users u ON u.id = opr.driver_id
        LEFT JOIN driver_details dd ON dd.user_id = opr.driver_id
        LEFT JOIN outstation_pool_bookings opb ON opb.ride_id = opr.id
        WHERE opr.is_active = true
          AND opr.status IN ('scheduled', 'active')
          AND opr.accepting_new_requests = true
          AND opr.available_seats >= ${seatsN}
          AND LOWER(opr.from_city) LIKE LOWER(${`%${fromCity}%`})
          AND LOWER(opr.to_city) LIKE LOWER(${`%${toCity}%`})
          ${date ? rawSql`AND opr.departure_date = ${date}::date` : rawSql``}
        GROUP BY opr.id, u.full_name, u.phone, dd.avg_rating, dd.vehicle_number, dd.vehicle_model
        ORDER BY opr.departure_date ASC, opr.departure_time ASC
        LIMIT 20
      `);

      // Calculate segment fare for each result
      const results = (r.rows as any[]).map(ride => {
        const pkmps = parseFloat(ride.price_per_km_per_seat || DEFAULT_PRICE_PER_KM_PER_SEAT);
        const fromLatR = parseFloat(ride.from_lat || 0);
        const fromLngR = parseFloat(ride.from_lng || 0);
        const toLatR   = parseFloat(ride.to_lat   || 0);
        const toLngR   = parseFloat(ride.to_lng   || 0);

        let segmentKm = parseFloat(ride.route_km || 0);
        let onRoute = true;

        if (pLat && pLng && dLat && dLng && fromLatR && toLatR) {
          onRoute = isOnRoute(pLat, pLng, fromLatR, fromLngR, toLatR, toLngR) &&
                    isOnRoute(dLat, dLng, fromLatR, fromLngR, toLatR, toLngR) &&
                    pickupBeforeDrop(pLat, pLng, dLat, dLng, fromLatR, fromLngR);
          segmentKm = haversineKm(pLat, pLng, dLat, dLng);
        }

        const { farePerSeat, totalFare } = calcSegmentFare(segmentKm, seatsN, pkmps);

        return {
          ...ride,
          segmentKm: Math.round(segmentKm * 10) / 10,
          farePerSeat,
          totalFareForSeats: totalFare,
          pricePerKmPerSeat: pkmps,
          onRoute,
          fareBreakdown: {
            segmentKm: Math.round(segmentKm * 10) / 10,
            pricePerKmPerSeat: pkmps,
            seatsRequested: seatsN,
            farePerSeat,
            totalFare,
            note: `${Math.round(segmentKm)}km × ₹${pkmps}/km × ${seatsN} seat${seatsN > 1 ? 's' : ''} = ₹${totalFare}`,
          },
        };
      }).filter(r => r.onRoute || (!pLat && !pLng));

      res.json({ data: results, total: results.length });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ─── CUSTOMER: Book a seat with segment fare ──────────────────────────────

  app.post("/api/app/customer/outstation-pool/v2/book", authApp, async (req: any, res: any) => {
    try {
      const customer = req.currentUser;
      const {
        rideId,
        seats = 1,
        pickupLat, pickupLng, dropLat, dropLng,
        pickupAddress, dropAddress,
        paymentMethod = "cash",
        includeInsurance = true,  // customer opts in/out of insurance (₹2 goes to platform)
      } = req.body;

      if (!rideId) return res.status(400).json({ message: "rideId required" });
      if (!pickupLat || !pickupLng || !dropLat || !dropLng) {
        return res.status(400).json({ message: "pickup and drop coordinates required" });
      }

      const requestedSeats = parseInt(String(seats), 10) || 1;
      if (requestedSeats < 1 || requestedSeats > 2) {
        return res.status(400).json({ message: "You can book only 1 or 2 seats per booking" });
      }
      const seatsN = requestedSeats;
      const pLat = parseFloat(pickupLat);
      const pLng = parseFloat(pickupLng);
      const dLat = parseFloat(dropLat);
      const dLng = parseFloat(dropLng);

      // Reject GPS-not-yet-resolved coordinates (0,0 is in the Atlantic Ocean)
      if (Math.abs(pLat) < 0.001 && Math.abs(pLng) < 0.001) {
        return res.status(400).json({ message: "Invalid pickup coordinates — GPS not yet resolved" });
      }
      if (Math.abs(dLat) < 0.001 && Math.abs(dLng) < 0.001) {
        return res.status(400).json({ message: "Invalid drop coordinates — GPS not yet resolved" });
      }

      // Atomically check seats + lock
      const txClient = await dbPool.connect();
      let ride: any;
      try {
        await txClient.query("BEGIN");
        const rideR = await txClient.query(
          `SELECT * FROM outstation_pool_rides
           WHERE id = $1 AND is_active = true AND status IN ('scheduled','active')
             AND accepting_new_requests = true
             AND available_seats >= $2
           FOR UPDATE`,
          [rideId, seatsN],
        );
        if (!rideR.rows.length) {
          await txClient.query("ROLLBACK");
          return res.status(409).json({ message: "Ride not available or not enough seats" });
        }
        ride = rideR.rows[0];

        // Prevent duplicate booking by the same customer on this ride
        const dupR = await txClient.query(
          `SELECT id FROM outstation_pool_bookings
           WHERE ride_id = $1 AND customer_id = $2 AND status NOT IN ('cancelled')
           LIMIT 1`,
          [rideId, (req as any).currentUser.id],
        );
        if (dupR.rows.length) {
          await txClient.query("ROLLBACK");
          return res.status(409).json({ message: "You already have an active booking on this ride" });
        }

        // Validate customer's pickup/drop is on this route
        const fromLatR = parseFloat(ride.from_lat || 0);
        const fromLngR = parseFloat(ride.from_lng || 0);
        const toLatR   = parseFloat(ride.to_lat   || 0);
        const toLngR   = parseFloat(ride.to_lng   || 0);

        if (fromLatR && toLatR) {
          if (!isOnRoute(pLat, pLng, fromLatR, fromLngR, toLatR, toLngR)) {
            await txClient.query("ROLLBACK");
            return res.status(400).json({ message: "Pickup location is not on this route" });
          }
          if (!isOnRoute(dLat, dLng, fromLatR, fromLngR, toLatR, toLngR)) {
            await txClient.query("ROLLBACK");
            return res.status(400).json({ message: "Drop location is not on this route" });
          }
          if (!pickupBeforeDrop(pLat, pLng, dLat, dLng, fromLatR, fromLngR)) {
            await txClient.query("ROLLBACK");
            return res.status(400).json({ message: "Pickup must be before drop along the route" });
          }
        }

        // Calculate segment fare
        const segmentKm = haversineKm(pLat, pLng, dLat, dLng);
        const pkmps = parseFloat(ride.price_per_km_per_seat || DEFAULT_PRICE_PER_KM_PER_SEAT);
        const { farePerSeat, totalFare } = calcSegmentFare(segmentKm, seatsN, pkmps);

        // Calculate pickup_order (based on distance from route origin)
        const pickupDistFromOrigin = fromLatR
          ? haversineKm(fromLatR, fromLngR, pLat, pLng)
          : 0;
        const existingOrders = await txClient.query(
          `SELECT COUNT(*) as cnt FROM outstation_pool_bookings WHERE ride_id = $1 AND status != 'cancelled'`,
          [rideId],
        );
        const pickupOrder = parseInt(existingOrders.rows[0].cnt) + 1;

        // Revenue breakdown preview (commission + GST + optional insurance)
        let revenuePreview: any = null;
        try {
          revenuePreview = await calculateRevenueBreakdown(
            totalFare, "outstation_pool", ride.driver_id,
          );
          // If customer opts out of insurance, remove it from the preview only
          // (actual settlement at drop time will respect this flag)
          if (!includeInsurance && revenuePreview) {
            revenuePreview = {
              ...revenuePreview,
              insurance: 0,
              total: revenuePreview.total - revenuePreview.insurance,
              driverEarnings: revenuePreview.driverEarnings + revenuePreview.insurance,
            };
          }
        } catch { /* non-blocking */ }

        // Insert booking (store insurance_opted for settlement)
        const bookR = await txClient.query(
          `INSERT INTO outstation_pool_bookings
            (ride_id, customer_id, seats_booked, total_fare, fare_per_seat, segment_km,
             from_city, to_city, pickup_lat, pickup_lng, drop_lat, drop_lng,
             pickup_address, dropoff_address, payment_method, status, payment_status, pickup_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'confirmed','pending',$16)
           RETURNING id`,
          [
            rideId, customer.id, seatsN, totalFare, farePerSeat, Math.round(segmentKm * 100) / 100,
            ride.from_city, ride.to_city,
            pLat, pLng, dLat, dLng,
            pickupAddress || null, dropAddress || null,
            paymentMethod, pickupOrder,
          ],
        );
        const bookingId = bookR.rows[0]?.id;

        // Decrement available seats
        await txClient.query(
          `UPDATE outstation_pool_rides SET available_seats = available_seats - $1, state_version = state_version + 1, updated_at = NOW() WHERE id = $2`,
          [seatsN, rideId],
        );

        await txClient.query("COMMIT");

        // Notify driver about new booking
        io.to(`user:${ride.driver_id}`).emit("outstation_pool:new_booking", {
          rideId,
          bookingId,
          passengerName: customer.fullName || "Passenger",
          seatsBooked: seatsN,
          pickupAddress: pickupAddress || `${pLat.toFixed(4)},${pLng.toFixed(4)}`,
          dropAddress: dropAddress || `${dLat.toFixed(4)},${dLng.toFixed(4)}`,
          totalFare,
          segmentKm: Math.round(segmentKm * 10) / 10,
        });

        // Build clear fare breakdown for customer
        const fareBreakdown: any = {
          segmentKm: Math.round(segmentKm * 10) / 10,
          pricePerKmPerSeat: pkmps,
          seatsBooked: seatsN,
          farePerSeat,
          subtotal: totalFare,
          // Platform deductions (from driver's share — customer pays totalFare only)
          platformCommission: revenuePreview?.commission ?? null,
          commissionPct: revenuePreview?.commissionPct ?? null,
          gst: revenuePreview?.gst ?? null,
          insurance: includeInsurance ? (revenuePreview?.insurance ?? null) : 0,
          insuranceIncluded: !!includeInsurance,
          totalPlatformCut: revenuePreview?.total ?? null,
          driverEarnings: revenuePreview?.driverEarnings ?? null,
          totalFare,
          note: `${Math.round(segmentKm)}km × ₹${pkmps}/km × ${seatsN} seat${seatsN > 1 ? 's' : ''} = ₹${totalFare}`,
        };

        res.json({
          success: true,
          bookingId,
          rideId,
          seatsBooked: seatsN,
          farePerSeat,
          totalFare,
          fareBreakdown,
          message: "Booking confirmed! Driver will pick you up at your location.",
        });
      } catch (e) {
        await txClient.query("ROLLBACK");
        throw e;
      } finally {
        txClient.release();
      }
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ─── CUSTOMER: My outstation pool bookings ────────────────────────────────

  app.get("/api/app/customer/outstation-pool/v2/bookings", authApp, async (req: any, res: any) => {
    try {
      const customer = req.currentUser;
      const r = await rawDb.execute(rawSql`
        SELECT opb.*,
          opr.from_city, opr.to_city, opr.departure_date, opr.departure_time,
          opr.status as ride_status, opr.current_lat, opr.current_lng,
          u.full_name as driver_name, u.phone as driver_phone,
          dd.avg_rating as driver_rating, dd.vehicle_number, dd.vehicle_model
        FROM outstation_pool_bookings opb
        JOIN outstation_pool_rides opr ON opr.id = opb.ride_id
        JOIN users u ON u.id = opr.driver_id
        LEFT JOIN driver_details dd ON dd.user_id = opr.driver_id
        WHERE opb.customer_id = ${customer.id}::uuid
        ORDER BY opb.created_at DESC
        LIMIT 30
      `);
      res.json({ data: r.rows });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ─── CUSTOMER: Cancel booking (only if not yet picked up) ────────────────

  app.post("/api/app/customer/outstation-pool/v2/bookings/:id/cancel", authApp, async (req: any, res: any) => {
    try {
      const customer = req.currentUser;
      const bookingId = String(req.params.id);

      const r = await rawDb.execute(rawSql`
        SELECT opb.status, opb.seats_booked, opb.ride_id
        FROM outstation_pool_bookings opb
        WHERE opb.id = ${bookingId}::uuid AND opb.customer_id = ${customer.id}::uuid
        LIMIT 1
      `);
      if (!r.rows.length) return res.status(404).json({ message: "Booking not found" });

      const b = r.rows[0] as any;
      if (b.status === "picked_up") {
        return res.status(400).json({ message: "Cannot cancel — already picked up" });
      }
      if (["dropped", "cancelled", "completed"].includes(b.status)) {
        return res.json({ success: true, message: "Already completed/cancelled" });
      }

      await rawDb.execute(rawSql`
        UPDATE outstation_pool_bookings
        SET status = 'cancelled', updated_at = NOW()
        WHERE id = ${bookingId}::uuid
      `);
      await rawDb.execute(rawSql`
        UPDATE outstation_pool_rides
        SET available_seats = available_seats + ${parseInt(b.seats_booked) || 1}, updated_at = NOW()
        WHERE id = ${b.ride_id}::uuid
      `);

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });
}
