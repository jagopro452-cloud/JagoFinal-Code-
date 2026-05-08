import { Server as SocketIOServer, Socket } from "socket.io";
import type { Server as HttpServer } from "http";
import { db as rawDb } from "./db";
import { sql as rawSql } from "drizzle-orm";
import { atomicAcceptDispatchOffer, rollbackAtomicAcceptDispatchOffer, onDriverAccepted as dispatchOnDriverAccepted, cancelDispatch as dispatchCancelTrip } from "./dispatch";
import { getRebalancingSuggestion } from "./intelligence";
import { emitParcelLifecycle, notifyAllReceivers, notifyReceiver } from "./parcel-advanced";
import { notifyUser } from "./notification-service";
import { acceptRide, assignRideToDriver, cancelRide, completeRide, startRide, transitionRideState } from "./ride-state";
import { assignParcelDriver, cancelParcel, completeParcel, startParcel } from "./parcel-state";
import { activeDriverEligibilitySql, getDriverState } from "./driver-state";
import {
  recordWaypoint,
  getTripWaypoints,
  clearTripWaypoints,
  checkRouteDeviation,
  checkAbnormalStop,
  checkSpeedAnomaly,
} from "./ai";
import { parseEnv } from "./config/env";
import {
  getDriverDbVehicleType,
  getDriverSocketRoomKeyForCategoryId,
  getMatchingDriverCategoryIds,
  uuidArraySql,
} from "./vehicle-matching";
import { setDriverPresence, deleteDriverPresence } from "./presence";
import { logInfo, logWarn } from "./hardening";
import {
  checkSpeedFraud,
  checkGpsJumpFraud,
  checkTripNoMovement,
  clearDriverLocationState,
  clearTripMovementState,
} from "./fraud";

export let io: SocketIOServer;

export function emitRuntimeConfigUpdated(payload: Record<string, any>) {
  io?.emit("config:updated", {
    ...payload,
    emittedAt: new Date().toISOString(),
  });
}

// Track connected sockets: userId → socketId
// NOTE: These maps are local to this process. With Redis adapter, socket routing works across processes but these maps still need Redis-backed storage for full HA. TODO: migrate to Redis hashes.
const driverSockets = new Map<string, string>();
const customerSockets = new Map<string, string>();
const activeCallSessions = new Map<string, { callerId: string; targetId: string; startedAt: number }>();
const driverLastTrackingAt = new Map<string, number>();

// Grace-period timers: when a driver socket disconnects we wait before marking them offline.
// If they reconnect within the grace window the timer is cancelled and they stay online.
// This prevents momentary network blips from removing drivers from active dispatch searches.
const pendingOfflineTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DRIVER_OFFLINE_GRACE_MS = 90_000; // 90 seconds
const DRIVER_TRACKING_STALE_MS = 20_000;
const DRIVER_ROOM_PREFIX = "drivers_";

function camelize(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      v,
    ])
  );
}

function getDriverRoomName(vehicleType: string): string {
  return `${DRIVER_ROOM_PREFIX}${vehicleType}`;
}

function emitSelf(socket: Socket, event: string, payload: Record<string, any>) {
  io?.to(socket.id).emit(event, payload);
}

function isValidCallSession(tripId: string | undefined, userId: string, targetUserId: string): boolean {
  if (!tripId) return false;
  const session = activeCallSessions.get(tripId);
  if (!session) return false;
  const participants = new Set([session.callerId, session.targetId]);
  return participants.has(userId) && participants.has(targetUserId);
}

async function hasAnyLiveSocketForUser(userId: string): Promise<boolean> {
  if (!io) return false;
  try {
    const sockets = await io.in(`user:${userId}`).allSockets();
    return sockets.size > 0;
  } catch {
    return false;
  }
}

async function loadDriverVehicleProfile(driverId: string): Promise<{
  vehicleCategoryId: string | null;
  vehicleType: string | null;
  driverRoom: string | null;
}> {
  const result = await rawDb.execute(rawSql`
    SELECT dd.vehicle_category_id
    FROM driver_details dd
    WHERE dd.user_id=${driverId}::uuid
    LIMIT 1
  `).catch(() => ({ rows: [] as any[] }));
  const vehicleCategoryId = ((result.rows[0] as any)?.vehicle_category_id || null) as string | null;
  const vehicleType = await getDriverSocketRoomKeyForCategoryId(vehicleCategoryId);
  return {
    vehicleCategoryId,
    vehicleType,
    driverRoom: vehicleType ? getDriverRoomName(vehicleType) : null,
  };
}

async function syncDriverVehicleRoom(socket: Socket, driverId: string) {
  const profile = await loadDriverVehicleProfile(driverId);
  for (const room of Array.from(socket.rooms)) {
    if (room.startsWith(DRIVER_ROOM_PREFIX) && room !== profile.driverRoom) {
      socket.leave(room);
    }
  }
  if (profile.driverRoom && !socket.rooms.has(profile.driverRoom)) {
    socket.join(profile.driverRoom);
  }
  console.log(
    `[SOCKET_MATCH] driver=${driverId} driver.vehicleType=${profile.vehicleType || "missing"} ` +
      `vehicleCategoryId=${profile.vehicleCategoryId || "missing"} room=${profile.driverRoom || "none"}`,
  );
  return profile;
}

async function persistSafetyAlert(alert: any, driverId: string) {
  try {
    await rawDb.execute(rawSql`
      INSERT INTO ai_safety_alerts (trip_id, driver_id, alert_type, severity, message, lat, lng)
      VALUES (
        ${alert.tripId}::uuid,
        ${driverId}::uuid,
        ${alert.type},
        ${alert.severity},
        ${alert.message},
        ${alert.lat || 0},
        ${alert.lng || 0}
      )
    `);
  } catch (e: any) {
    console.error("[AI-SAFETY] Failed to persist alert:", e.message);
  }
}

// Verify socket handshake token — prevents room spoofing (connecting as another user).
// Returns verified user identity + role from DB, or null if invalid.
async function verifySocketToken(token: string | undefined, claimedUserId: string | undefined): Promise<{ userId: string; userType: string } | null> {
  if (!token || !claimedUserId) return null;
  try {
    const r = await rawDb.execute(rawSql`
      SELECT u.id, u.user_type FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE u.id = ${claimedUserId}::uuid
        AND s.token = ${token}
        AND s.revoked = false
        AND s.expires_at > NOW()
        AND u.is_active = true
      LIMIT 1
    `);
    if (!r.rows.length) {
      const legacy = await rawDb.execute(rawSql`
        SELECT id, user_type FROM users
        WHERE id = ${claimedUserId}::uuid
          AND auth_token = ${token}
          AND is_active = true
          AND (auth_token_expires_at IS NULL OR auth_token_expires_at > NOW())
        LIMIT 1
      `).catch(() => ({ rows: [] as any[] }));
      if (!legacy.rows.length) return null;
      return {
        userId: (legacy.rows[0] as any).id as string,
        userType: String((legacy.rows[0] as any).user_type || "").toLowerCase(),
      };
    }
    return {
      userId: (r.rows[0] as any).id as string,
      userType: String((r.rows[0] as any).user_type || "").toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function setupSocket(httpServer: HttpServer) {
  const env = parseEnv();
  const socketAllowedOrigins = (env.SOCKET_ALLOWED_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const isProd = env.NODE_ENV === "production";
  if (isProd && (!socketAllowedOrigins.length || socketAllowedOrigins.includes("*"))) {
    console.warn("[socket] SOCKET_ALLOWED_ORIGINS not set — defaulting to jagopro.org origins");
    socketAllowedOrigins.push("https://jagopro.org", "https://www.jagopro.org");
  }

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: isProd
        ? (origin, callback) => {
            if (!origin || socketAllowedOrigins.includes(origin)) {
              callback(null, true);
              return;
            }
            callback(new Error("Origin not allowed"));
          }
        : (socketAllowedOrigins.length === 1 ? socketAllowedOrigins[0] : socketAllowedOrigins),
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
  });

  io.on("connection", async (socket: Socket) => {
    const claimedUserId = socket.handshake.query.userId as string;
    const token = (socket.handshake.query.token || socket.handshake.auth?.token) as string | undefined;
    const claimedUserType = String(socket.handshake.query.userType || "").toLowerCase();

    if (!claimedUserId) {
      socket.disconnect();
      return;
    }

    // Verify the token matches the claimed userId (prevents room spoofing)
    const verified = await verifySocketToken(token, claimedUserId);
    if (!verified) {
      console.warn(`[SOCKET] Auth failed for userId=${claimedUserId} — disconnecting`);
      emitSelf(socket, "auth:error", { message: "Invalid or expired token. Please reconnect with a valid token." });
      socket.disconnect();
      return;
    }
    const userId = verified.userId;
    const userType = verified.userType;
    if (claimedUserType && claimedUserType !== userType) {
      console.warn(`[SOCKET] Role mismatch for ${userId}: claimed=${claimedUserType}, actual=${userType}`);
    }

    // Join personal room
    socket.join(`user:${userId}`);

    if (userType === "driver") {
      driverSockets.set(userId, socket.id);
      const driverProfile = await syncDriverVehicleRoom(socket, userId);

      // Cancel any pending offline timer (driver reconnected within grace window)
      const pendingTimer = pendingOfflineTimers.get(userId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingOfflineTimers.delete(userId);
        console.log(`[SOCKET] Driver ${userId} reconnected within grace window — offline timer cancelled`);
      }

      // Re-sync driver_locations.is_online with users.is_online.
      // When the app restarts after a crash/kill, is_online may be true in users table
      // but driver_locations.is_online was set false by the previous disconnect handler.
      // This ensures dispatch finds them immediately without waiting for the first location update.
      rawDb.execute(rawSql`
        UPDATE driver_locations SET is_online=true, updated_at=NOW()
        WHERE driver_id=${userId}::uuid
          AND (SELECT is_online FROM users WHERE id=${userId}::uuid LIMIT 1) = true
          AND is_online = false
      `).catch(() => { });

      console.log(`[SOCKET] Driver ${userId} connected`);

      // ── Driver: send location update ───────────────────────────────────────
      socket.on("driver:location", async (data: { lat: number; lng: number; heading?: number; speed?: number }) => {
        try {
          const { lat, lng, heading = 0, speed = 0 } = data;
          if (!lat || !lng || !isFinite(lat) || !isFinite(lng)) return; // ignore invalid GPS
          const now = Date.now();
          const previousSeenAt = driverLastTrackingAt.get(userId);
          if (previousSeenAt && now - previousSeenAt > DRIVER_TRACKING_STALE_MS) {
            console.log(`[TRACKING_RESUMED] driver=${userId} gapMs=${now - previousSeenAt}`);
          }
          driverLastTrackingAt.set(userId, now);
          // Update location; also set is_online=true — active location streaming means driver IS online
          await rawDb.execute(rawSql`
            INSERT INTO driver_locations (driver_id, lat, lng, heading, speed, is_online, updated_at)
            VALUES (${userId}::uuid, ${lat}, ${lng}, ${heading}, ${speed}, true, NOW())
            ON CONFLICT (driver_id) DO UPDATE
              SET lat=${lat}, lng=${lng}, heading=${heading}, speed=${speed}, is_online=true, updated_at=NOW()
          `);
          // Redis presence: refresh TTL so the key stays alive as long as driver is streaming
          setDriverPresence(userId, {
            lat, lng, heading, speed,
            vehicleType: driverProfile.vehicleType || "",
            vehicleCategoryId: driverProfile.vehicleCategoryId || "",
            lastSeen: now,
          }).catch(() => { });
          const tripR = await rawDb.execute(rawSql`
            SELECT
              u.current_trip_id,
              (
                SELECT tr.id
                FROM trip_requests tr
                WHERE tr.driver_id=${userId}::uuid
                  AND tr.current_status IN ('accepted','driver_assigned','arrived','on_the_way')
                ORDER BY tr.updated_at DESC NULLS LAST, tr.created_at DESC
                LIMIT 1
              ) AS active_trip_id
            FROM users u
            WHERE u.id=${userId}::uuid
          `);
          const tripRow = tripR.rows[0] as any;
          const tripId = tripRow?.current_trip_id || tripRow?.active_trip_id;

          // ── Fraud checks (sync, non-blocking log) ──────────────────────────
          checkGpsJumpFraud(userId, lat, lng);
          checkSpeedFraud(userId, speed * 3.6, tripId ?? null); // m/s → km/h
          if (tripId) checkTripNoMovement(tripId, userId, lat, lng);

          if (tripId) {
            io.to(`trip:${tripId}`).emit("driver:location_update", { lat, lng, heading, speed, tripId });

            recordWaypoint(tripId, lat, lng, speed);

            const speedAlert = checkSpeedAnomaly(speed, tripId, lat, lng);
            if (speedAlert) {
              persistSafetyAlert(speedAlert, userId);
              io.to(`trip:${tripId}`).emit("safety:alert", speedAlert);
            }

            const waypoints = getTripWaypoints(tripId);
            const stopAlert = checkAbnormalStop(waypoints, tripId);
            if (stopAlert) {
              persistSafetyAlert(stopAlert, userId);
              io.to(`trip:${tripId}`).emit("safety:alert", stopAlert);
            }

            if (waypoints.length % 10 === 0) {
              try {
                const tripData = await rawDb.execute(rawSql`
                  SELECT pickup_lat, pickup_lng, destination_lat, destination_lng, current_status
                  FROM trip_requests WHERE id=${tripId}::uuid
                `);
                if (tripData.rows.length) {
                  const t = tripData.rows[0] as any;
                  if (t.current_status === 'on_the_way' && t.destination_lat && t.destination_lng) {
                    const devAlert = checkRouteDeviation(
                      lat, lng,
                      Number(t.pickup_lat), Number(t.pickup_lng),
                      Number(t.destination_lat), Number(t.destination_lng),
                      tripId
                    );
                    if (devAlert) {
                      persistSafetyAlert(devAlert, userId);
                      io.to(`trip:${tripId}`).emit("safety:alert", devAlert);
                    }
                  }
                }
              } catch { }
            }
          }
        } catch (e: any) {
          console.error("[SOCKET] driver:location error:", e.message);
        }
      });

      // ── Driver: heartbeat — refreshes Redis presence TTL without a full location update ──
      // Drivers should send this every 10–15s when online but not actively streaming GPS.
      socket.on("driver:heartbeat", async (data?: { lat?: number; lng?: number }) => {
        try {
          const now = Date.now();
          const prev = driverLastTrackingAt.get(userId);
          driverLastTrackingAt.set(userId, now);
          const lat = data?.lat;
          const lng = data?.lng;
          if (lat && lng && isFinite(lat) && isFinite(lng)) {
            setDriverPresence(userId, {
              lat, lng, heading: 0, speed: 0,
              vehicleType: driverProfile.vehicleType || "",
              vehicleCategoryId: driverProfile.vehicleCategoryId || "",
              lastSeen: now,
            }).catch(() => { });
          } else {
            // No coords — just ping Redis to extend TTL without updating geo
            const { getDriverPresence, setDriverPresence: sp } = await import("./presence");
            const existing = await getDriverPresence(userId);
            if (existing) {
              sp(userId, { ...existing, lastSeen: now }).catch(() => { });
            }
          }
          emitSelf(socket, "driver:heartbeat_ack", { ts: now });
        } catch { }
      });

      // ── Driver: rejoin trip room after reconnect ───────────────────────────
      socket.on("driver:rejoin_trip", async (data: { tripId: string }) => {
        try {
          const { tripId } = data;
          if (!tripId) return;
          // Verify driver still owns this active trip before joining
          const r = await rawDb.execute(rawSql`
            SELECT id FROM trip_requests
            WHERE id=${tripId}::uuid AND driver_id=${userId}::uuid
              AND current_status IN ('accepted','driver_assigned','arrived','on_the_way')
            LIMIT 1
          `);
          if (r.rows.length) {
            socket.join(`trip:${tripId}`);
            console.log(`[ROOM_REJOIN] driver=${userId} trip=${tripId}`);
          }
        } catch (_) { }
      });

      // ── Driver: go online/offline ──────────────────────────────────────────
      socket.on("driver:online", async (data: { isOnline: boolean; lat?: number; lng?: number }) => {
        try {
          const { isOnline, lat, lng } = data;
          const hasValidCoords = lat != null && lng != null && isFinite(lat) && isFinite(lng) && (lat !== 0 || lng !== 0);

          // UPSERT — creates the row if it doesn't exist (new drivers have no row yet)
          // Only write lat/lng if we have a valid GPS fix; never store 0,0 as it breaks radius search
          if (hasValidCoords) {
            await rawDb.execute(rawSql`
              INSERT INTO driver_locations (driver_id, lat, lng, is_online, updated_at)
              VALUES (${userId}::uuid, ${lat}, ${lng}, ${isOnline}, NOW())
              ON CONFLICT (driver_id) DO UPDATE
                SET lat=${lat}, lng=${lng}, is_online=${isOnline}, updated_at=NOW()
            `);
          } else {
            await rawDb.execute(rawSql`
              UPDATE driver_locations
              SET is_online=${isOnline}, updated_at=NOW()
              WHERE driver_id=${userId}::uuid
            `);
            console.log(`[SOCKET] Driver ${userId} online toggle waiting for first GPS fix`);
          }
          await rawDb.execute(rawSql`
            UPDATE users
            SET is_online=${isOnline},
                current_lat=COALESCE(${lat ?? null}, current_lat),
                current_lng=COALESCE(${lng ?? null}, current_lng)
            WHERE id=${userId}::uuid
          `);
          const driverProfile = await syncDriverVehicleRoom(socket, userId);
          emitSelf(socket, "driver:online_ack", { isOnline });
          // If driver explicitly went offline, cancel any pending grace-period timer and clear Redis presence
          if (!isOnline) {
            const pending = pendingOfflineTimers.get(userId);
            if (pending) { clearTimeout(pending); pendingOfflineTimers.delete(userId); }
            deleteDriverPresence(userId).catch(() => { });
          }
          logInfo("DRIVER_STATUS", `Driver ${userId} ${isOnline ? "ONLINE" : "OFFLINE"}`, {
            lat, lng, vehicleType: driverProfile.vehicleType || "missing",
          }).catch(() => { });

          // If driver just came online, check for searching trips nearby
          if (isOnline && hasValidCoords && lat != null && lng != null) {
            await notifyDriverNearbyTrips(userId, lat, lng);

            // Send rebalancing suggestion if driver is in a low-demand area
            getRebalancingSuggestion(userId, lat, lng).then((suggestion) => {
              if (suggestion) {
                emitSelf(socket, "driver:rebalancing_suggestion", suggestion);
              }
            }).catch(() => { });
          }
        } catch (e: any) {
          console.error("[SOCKET] driver:online error:", e.message);
        }
      });

      // ── Driver: accept trip ────────────────────────────────────────────────
      socket.on("driver:accept_trip", async (data: { tripId: string }) => {
        console.log(`[SOCKET] driver:accept_trip received for trip ${data.tripId} from driver ${userId}`);
        try {
          const { tripId } = data;
          const pickupOtp = Math.floor(1000 + Math.random() * 9000).toString();
          const driverStateR = await rawDb.execute(rawSql`
            SELECT id, user_type, is_locked, current_trip_id
            FROM users
            WHERE id=${userId}::uuid
            LIMIT 1
          `);
          const driverState = driverStateR.rows[0] as any;
          if (!driverState || driverState.user_type !== "driver") {
            emitSelf(socket, "driver:accept_trip_error", { message: "Only drivers can accept trips" });
            return;
          }
          const onboardingState = await getDriverState(userId);
          if (onboardingState !== "ACTIVE") {
            emitSelf(socket, "driver:accept_trip_error", { message: "Driver is not ACTIVE", state: onboardingState });
            return;
          }
          if (driverState.current_trip_id) {
            emitSelf(socket, "driver:accept_trip_error", { message: "You already have an active trip" });
            return;
          }

          const tripR = await rawDb.execute(rawSql`
            SELECT t.*, dd.vehicle_category_id, dl.lat as driver_lat, dl.lng as driver_lng
            FROM trip_requests t
            LEFT JOIN driver_details dd ON dd.user_id=${userId}::uuid
            LEFT JOIN driver_locations dl ON dl.driver_id=${userId}::uuid
            WHERE t.id=${tripId}::uuid AND t.current_status IN ('searching','driver_assigned')
          `);
          if (!tripR.rows.length) {
            emitSelf(socket, "driver:accept_trip_error", { message: "Trip no longer available" });
            return;
          }
          const trip = camelize(tripR.rows[0]) as any;

          const dispatchAccept = await atomicAcceptDispatchOffer(tripId, userId, { pickupOtp });
          if (!dispatchAccept.ok) {
            const messageMap: Record<string, string> = {
              OWNER_MISMATCH: "Dispatch ownership changed. Please wait for a fresh offer.",
              NO_OWNER: "Offer expired. Please wait for a fresh offer.",
              NO_OFFER: "Offer no longer active.",
              OFFER_MISMATCH: "Offer no longer active.",
              NO_SESSION: "Offer expired. Please wait for a fresh offer.",
              STALE_OFFER: "This offer is stale. Please wait for a fresh request.",
              ACCEPT_FAILED: "Trip acceptance failed. Please retry.",
            };
            emitSelf(socket, "driver:accept_trip_error", {
              message: messageMap[dispatchAccept.code] || "Trip acceptance failed",
              code: dispatchAccept.code,
            });
            return;
          }

          if (trip.currentStatus === "searching") {
            const assigned = await assignRideToDriver(tripId, userId, { source: "socket_accept" });
            if (!assigned) {
              await rollbackAtomicAcceptDispatchOffer(tripId, userId).catch(() => undefined);
              emitSelf(socket, "driver:accept_trip_error", { message: "Trip was already accepted by another pilot" });
              return;
            }
          }

          await acceptRide(tripId, {
            actorId: userId,
            actorType: "driver",
            driverId: userId,
            data: { source: "socket_accept", pickupOtp },
            extraSetters: [
              rawSql`pickup_otp=${pickupOtp}`,
              rawSql`driver_accepted_at=COALESCE(driver_accepted_at, NOW())`,
              rawSql`driver_arriving_at=COALESCE(driver_arriving_at, NOW())`,
            ],
          });
          await rawDb.execute(rawSql`UPDATE users SET current_trip_id=${tripId}::uuid WHERE id=${userId}::uuid`);
          dispatchOnDriverAccepted(tripId, userId);

          const driverR = await rawDb.execute(rawSql`
            SELECT full_name, phone, rating, profile_photo FROM users WHERE id=${userId}::uuid
          `);
          const driver = (camelize(driverR.rows[0]) || {}) as any;
          const vehicleR = await rawDb.execute(rawSql`
            SELECT dd.vehicle_number, dd.vehicle_model, vc.name as vehicle_category
            FROM driver_details dd
            LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
            WHERE dd.user_id = ${userId}::uuid
            LIMIT 1
          `).catch(() => ({ rows: [] }));
          const vehicle = (vehicleR.rows[0] as any) || {};
          const driverPayload = {
            id: userId,
            fullName: driver.fullName,
            phone: driver.phone,
            rating: driver.rating,
            photo: driver.profilePhoto,
            vehicleNumber: vehicle.vehicle_number || "",
            vehicleModel: vehicle.vehicle_model || "",
            vehicleCategory: vehicle.vehicle_category || "",
            lat: trip.driverLat,
            lng: trip.driverLng,
          };

          await notifyUser(trip.customerId, "trip:driver_assigned", {
            tripId,
            pickupOtp,
            status: "accepted",
            currentStatus: "accepted",
            driver: driverPayload,
          }, {
            title: "Driver Accepted Your Ride!",
            body: `${driver.fullName} is on the way to pick you up`,
          });
          await notifyUser(trip.customerId, "trip:accepted", {
            tripId,
            pickupOtp,
            status: "accepted",
            currentStatus: "accepted",
            driverId: userId,
            driverName: driver.fullName,
            driverPhone: driver.phone,
            driverPhoto: driver.profilePhoto,
            driverRating: driver.rating,
            driverVehicleNumber: vehicle.vehicle_number || "",
            driverVehicleModel: vehicle.vehicle_model || "",
            vehicleName: vehicle.vehicle_category || "",
            driver: driverPayload,
          }, {
            title: "Driver Accepted Your Ride!",
            body: `${driver.fullName} is on the way to pick you up`,
          });
          io.to(`trip:${tripId}`).emit("trip:status_update", {
            tripId,
            status: "accepted",
            currentStatus: "accepted",
            otp: pickupOtp,
            driver: driverPayload,
          });

          socket.join(`trip:${tripId}`);
          emitSelf(socket, "driver:accept_trip_ok", { tripId });
        } catch (e: any) {
          await rollbackAtomicAcceptDispatchOffer(data.tripId, userId).catch(() => undefined);
          console.error("[SOCKET] driver:accept_trip error:", e.message);
          emitSelf(socket, "driver:accept_trip_error", { message: e.message });
        }
      });

      // ── Driver: respond to ping (FIX #1: Driver verification) ─────────────────
      socket.on("system:ping_response", async (data: { tripId: string }) => {
        try {
          if (!userId) return;
          const { handleDriverPingResponse } = await import("./hardening");
          const success = handleDriverPingResponse(userId);
          if (success) {
            emitSelf(socket, "system:ping_ack", { status: "ok" });
          }
        } catch (e: any) {
          console.error("[SOCKET] ping_response error:", e.message);
        }
      });

      // ── Driver: update trip status ─────────────────────────────────────────
      socket.on("driver:trip_status", async (data: { tripId: string; status: string; otp?: string }) => {
        try {
          const { tripId, status, otp } = data;
          const allowed = ["accepted", "arrived", "on_the_way", "completed", "cancelled"];
          if (!allowed.includes(status)) {
            emitSelf(socket, "error", { message: "Invalid status" });
            return;
          }

          if (status === "arrived") {
            await transitionRideState(tripId, "arrived", {
              driverId: userId,
              actorId: userId,
              actorType: "driver",
              event: "ARRIVED",
              data: { source: "socket_status", otp: otp || "" },
            });
          } else if (status === "on_the_way") {
            await startRide(tripId, {
              driverId: userId,
              actorId: userId,
              actorType: "driver",
              data: { source: "socket_status", otp: otp || "" },
            });
          } else if (status === "completed") {
            // PAYMENT GATE: trip only moves to completed if payment is verified
            const paymentCheckR = await rawDb.execute(rawSql`
              SELECT payment_status, payment_method FROM trip_requests WHERE id=${tripId}::uuid
            `);
            const paymentStatus = (paymentCheckR.rows[0] as any)?.payment_status;
            const paymentMethod = (paymentCheckR.rows[0] as any)?.payment_method;
            // Cash trips: always allow completion (driver collects cash in person)
            // Paid/wallet/online trips: verify payment_status before completing
            const paymentClear = paymentMethod === 'cash' || paymentStatus === 'paid' || paymentStatus === 'cash' || paymentStatus === 'paid_online' || paymentStatus === 'wallet_paid';
            if (paymentClear) {
              await completeRide(tripId, {
                driverId: userId,
                actorId: userId,
                actorType: "driver",
                data: { source: "socket_status" },
              });
              clearTripMovementState(tripId);
            } else {
              await transitionRideState(tripId, "payment_pending", {
                driverId: userId,
                actorId: userId,
                actorType: "driver",
                event: "PAYMENT_PENDING",
                data: { source: "socket_status" },
              });
              // Notify customer to complete payment before trip is marked done
              const pendingTripR = await rawDb.execute(rawSql`
                SELECT customer_id FROM trip_requests WHERE id=${tripId}::uuid
              `);
              if (pendingTripR.rows.length) {
                const customerId = (pendingTripR.rows[0] as any).customer_id;
                await notifyUser(String(customerId), "trip:payment_pending", {
                  tripId,
                  status: "payment_pending",
                  currentStatus: "payment_pending",
                  message: "Ride complete. Awaiting payment confirmation.",
                }, {
                  title: "Payment Pending",
                  body: "Ride complete. Awaiting payment confirmation.",
                });
                await notifyUser(String(customerId), "trip:status_update", {
                  tripId,
                  status: "payment_pending",
                  currentStatus: "payment_pending",
                  message: "Ride complete. Awaiting payment confirmation.",
                });
                io.to(`trip:${tripId}`).emit("trip:status_update", {
                  tripId,
                  status: "payment_pending",
                  currentStatus: "payment_pending",
                  message: "Ride complete. Awaiting payment confirmation.",
                });
              }
              emitSelf(socket, "driver:trip_status_ok", { tripId, status: "payment_pending" });
              console.log(`[SOCKET] Trip ${tripId} held at payment_pending — payment not verified`);
              return;
            }
          } else if (status === "cancelled") {
            await cancelRide(tripId, {
              actorId: userId,
              actorType: "driver",
              driverId: userId,
              reason: "Driver cancelled via socket",
            });
          } else {
            await acceptRide(tripId, {
              driverId: userId,
              actorId: userId,
              actorType: "driver",
              data: { source: "socket_status" },
            });
          }

          if (status === "completed" || status === "cancelled") {
            await rawDb.execute(rawSql`UPDATE users SET current_trip_id=NULL WHERE id=${userId}::uuid`);
          }

          // Get customer id + fare for FCM
          const tripR = await rawDb.execute(rawSql`SELECT customer_id, estimated_fare, actual_fare FROM trip_requests WHERE id=${tripId}::uuid`);
          if (tripR.rows.length) {
            const customerId = (tripR.rows[0] as any).customer_id;
            const fare = (tripR.rows[0] as any).actual_fare || (tripR.rows[0] as any).estimated_fare || 0;
            // Socket notify (foreground)
            const dObjR = await rawDb.execute(rawSql`
              SELECT u.full_name, u.phone, u.rating, u.profile_photo, 
                dd.vehicle_number, dd.vehicle_model, vc.name as vehicle_category,
                dl.lat, dl.lng
              FROM users u
              LEFT JOIN driver_details dd ON dd.user_id = u.id
              LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
              LEFT JOIN driver_locations dl ON dl.driver_id = u.id
              WHERE u.id = (SELECT driver_id FROM trip_requests WHERE id=${tripId}::uuid)
              LIMIT 1
            `).catch(() => ({ rows: [] }));
            const dObjRaw = dObjR.rows[0] as any;
            const driver = dObjRaw ? {
              id: dObjRaw.id,
              fullName: dObjRaw.full_name,
              phone: dObjRaw.phone,
              rating: dObjRaw.rating,
              photo: dObjRaw.profile_photo,
              vehicleNumber: dObjRaw.vehicle_number || '',
              vehicleModel: dObjRaw.vehicle_model || '',
              vehicleCategory: dObjRaw.vehicle_category || '',
              lat: dObjRaw.lat,
              lng: dObjRaw.lng,
            } : undefined;

            const payload = { tripId, status, otp, driver };
            await notifyUser(String(customerId), "trip:status_update", payload);
            io.to(`trip:${tripId}`).emit("trip:status_update", payload);
            if (status === "completed") {
              await notifyUser(String(customerId), "trip:completed", { ...payload, fare: Number(fare) }, {
                title: "Trip Completed!",
                body: `Fare: Rs.${Number(fare)}. Thank you for riding with JAGO Pro!`,
              });
            } else if (status === "cancelled") {
              await notifyUser(String(customerId), "trip:cancelled", { ...payload, cancelledBy: "driver" }, {
                title: "Trip Cancelled",
                body: "Driver cancelled this trip",
              });
            }
          }

          emitSelf(socket, "driver:trip_status_ok", { tripId, status });
          console.log(`[SOCKET] Trip ${tripId} status → ${status}`);
        } catch (e: any) {
          console.error("[SOCKET] driver:trip_status error:", e.message);
        }
      });

      // ── Driver: accept parcel order via socket ─────────────────────────────
      socket.on("driver:accept_parcel", async (data: { orderId: string }) => {
        try {
          const { orderId } = data;
          if (!orderId) return;

          const assigned = await assignParcelDriver(orderId, userId, { source: "socket_accept" });
          if (!assigned) {
            emitSelf(socket, "parcel:accept_error", { orderId, message: "Order already assigned or unavailable" });
            return;
          }
          emitSelf(socket, "parcel:accept_ok", { orderId });
          socket.join(`parcel:${orderId}`);
          console.log(`[SOCKET] Driver ${userId} accepted parcel ${orderId}`);
        } catch (e: any) {
          emitSelf(socket, "parcel:accept_error", { message: e.message });
        }
      });

      // ── Driver: update parcel status ───────────────────────────────────────
      socket.on("driver:parcel_status", async (data: { orderId: string; status: string }) => {
        try {
          const { orderId, status } = data;
          const allowed = ["picked_up", "in_transit", "delivery_approaching", "cancelled"];
          if (!allowed.includes(status)) {
            emitSelf(socket, "parcel:status_error", { message: "Invalid status" });
            return;
          }

          const orderR = await rawDb.execute(rawSql`
            SELECT customer_id, driver_id, drop_locations, current_status
            FROM parcel_orders WHERE id = ${orderId}::uuid AND driver_id = ${userId}::uuid
          `);
          if (!orderR.rows.length) {
            emitSelf(socket, "parcel:status_error", { message: "Order not found" });
            return;
          }
          const order = orderR.rows[0] as any;
          const drops: any[] = typeof order.drop_locations === 'string'
            ? JSON.parse(order.drop_locations) : (order.drop_locations || []);
          const driverR = await rawDb.execute(rawSql`SELECT full_name FROM users WHERE id=${userId}::uuid`);
          const driverName = (driverR.rows[0] as any)?.full_name || "Pilot";

          if (status === "picked_up") {
            await startParcel(orderId, {
              driverId: userId,
              actorId: userId,
              actorType: "driver",
              data: { driverName, source: "socket_status" },
            });
            // Notify all receivers that parcel has been picked up
            notifyAllReceivers(orderId, drops, "pickup_started", driverName).catch(() => { });
          } else if (status === "delivery_approaching") {
            emitParcelLifecycle(orderId, order.customer_id, userId, "delivery_approaching", { driverName });
            // Notify current drop receiver
            const currentDrop = drops[order.current_drop_index || 0];
            if (currentDrop?.receiverPhone) {
              notifyReceiver({
                receiverPhone: currentDrop.receiverPhone,
                receiverName: currentDrop.receiverName || "Customer",
                eventType: "arriving",
                orderId,
                otp: currentDrop.deliveryOtp,
                driverName,
              }).catch(() => { });
            }
          } else if (status === "cancelled") {
            await cancelParcel(orderId, {
              driverId: userId,
              actorId: userId,
              actorType: "driver",
              reason: "Driver cancelled",
            });
          } else if (status === "in_transit") {
            await startParcel(orderId, {
              driverId: userId,
              actorId: userId,
              actorType: "driver",
              data: { driverName, source: "socket_status" },
            });
          }

          emitSelf(socket, "parcel:status_ok", { orderId, status });
          console.log(`[SOCKET] Parcel ${orderId} status → ${status}`);
        } catch (e: any) {
          emitSelf(socket, "parcel:status_error", { message: e.message });
        }
      });

      // ── Driver: parcel location broadcast (for parcel tracking) ────────────
      socket.on("driver:parcel_location", async (data: { orderId: string; lat: number; lng: number }) => {
        try {
          const { orderId, lat, lng } = data;
          if (!orderId || !lat || !lng) return;
          // Verify driver is assigned to this parcel
          const r = await rawDb.execute(rawSql`
            SELECT customer_id FROM parcel_orders
            WHERE id = ${orderId}::uuid AND driver_id = ${userId}::uuid
              AND current_status IN ('driver_assigned', 'in_transit')
          `);
          if (!r.rows.length) return;
          const customerId = (r.rows[0] as any).customer_id;
          io.to(`user:${customerId}`).emit("parcel:driver_location", { orderId, lat, lng, timestamp: new Date().toISOString() });
        } catch { }
      });

    } else if (userType === "customer") {
      customerSockets.set(userId, socket.id);
      console.log(`[SOCKET] Customer ${userId} connected`);

      // ── Customer: join trip room for tracking ──────────────────────────────
      socket.on("customer:track_trip", async (data: { tripId: string }) => {
        try {
          const { tripId } = data;
          if (!tripId) return;
          const tripR = await rawDb.execute(rawSql`
            SELECT id FROM trip_requests WHERE id=${tripId}::uuid AND customer_id=${userId}::uuid
          `);
          if (!tripR.rows.length) {
            emitSelf(socket, "error", { message: "Trip not found" });
            return;
          }
          socket.join(`trip:${tripId}`);
          console.log(`[ROOM_REJOIN] customer=${userId} trip=${tripId}`);
        } catch (e: any) {
          console.error("[SOCKET] customer:track_trip error:", e.message);
        }
      });

      // ── Customer: cancel trip ──────────────────────────────────────────────
      socket.on("customer:cancel_trip", async (data: { tripId: string }) => {
        try {
          const { tripId } = data;
          const ownershipR = await rawDb.execute(rawSql`
            SELECT customer_id
            FROM trip_requests
            WHERE id=${tripId}::uuid
            LIMIT 1
          `);
          if (ownershipR.rows.length && String((ownershipR.rows[0] as any).customer_id || "") !== userId) {
            emitSelf(socket, "error", { message: "Forbidden", code: "FORBIDDEN" });
            return;
          }
          const tripR = await rawDb.execute(rawSql`
            SELECT driver_id FROM trip_requests
            WHERE id=${tripId}::uuid AND customer_id=${userId}::uuid AND current_status NOT IN ('completed','cancelled')
          `);
          if (!tripR.rows.length) {
            emitSelf(socket, "error", { message: "Trip not found or already ended" });
            return;
          }
          const driverId = (tripR.rows[0] as any).driver_id;
          await cancelRide(tripId, {
            actorId: userId,
            actorType: "customer",
            customerId: userId,
            reason: "Customer cancelled via socket",
          });
          // Cancel active dispatch session
          dispatchCancelTrip(tripId);
          if (driverId) {
            await rawDb.execute(rawSql`UPDATE users SET current_trip_id=NULL WHERE id=${driverId}::uuid`);
            await notifyUser(String(driverId), "trip:cancelled", { tripId, cancelledBy: "customer" }, {
              title: "Trip Cancelled",
              body: "Customer cancelled this trip",
            });
          }
          emitSelf(socket, "trip:cancelled", { tripId, cancelledBy: "customer" });
        } catch (e: any) {
          console.error("[SOCKET] customer:cancel_trip error:", e.message);
        }
      });

      // ── Customer: track parcel order ───────────────────────────────────────
      socket.on("customer:track_parcel", async (data: { orderId: string }) => {
        try {
          const { orderId } = data;
          if (!orderId) return;
          const r = await rawDb.execute(rawSql`
            SELECT id FROM parcel_orders WHERE id=${orderId}::uuid AND customer_id=${userId}::uuid
          `);
          if (!r.rows.length) {
            emitSelf(socket, "parcel:error", { message: "Parcel order not found" });
            return;
          }
          socket.join(`parcel:${orderId}`);
          emitSelf(socket, "parcel:tracking_started", { orderId });
          console.log(`[SOCKET] Customer ${userId} tracking parcel ${orderId}`);
        } catch (e: any) {
          console.error("[SOCKET] customer:track_parcel error:", e.message);
        }
      });

      // ── Customer: cancel parcel order ──────────────────────────────────────
      socket.on("customer:cancel_parcel", async (data: { orderId: string; reason?: string }) => {
        try {
          const { orderId, reason } = data;
          if (!orderId) return;
          const cancelled = await cancelParcel(orderId, {
            customerId: userId,
            actorId: userId,
            actorType: "customer",
            reason: reason || "Customer cancelled via app",
          });
          if (!cancelled) {
            emitSelf(socket, "parcel:cancel_error", { message: "Cannot cancel this order" });
            return;
          }
          emitSelf(socket, "parcel:cancelled", { orderId });
        } catch (e: any) {
          console.error("[SOCKET] customer:cancel_parcel error:", e.message);
        }
      });
    }

    // ── In-app trip chat relay + DB persistence ──────────────────────────────
    socket.on("trip:send_message", async (data: { tripId: string; message: string; senderName: string; senderType: string }) => {
      try {
        const { tripId, message, senderName, senderType } = data;
        if (!tripId || !message?.trim() || message.length > 2000) return;

        const tripParticipant = await rawDb.execute(rawSql`
          SELECT
            t.id,
            CASE
              WHEN t.customer_id = ${userId}::uuid THEN 'customer'
              WHEN t.driver_id = ${userId}::uuid THEN 'driver'
              ELSE NULL
            END as sender_type,
            COALESCE(u.full_name, ${senderName || ""}) as sender_name
          FROM trip_requests t
          JOIN users u ON u.id = ${userId}::uuid
          WHERE t.id = ${tripId}::uuid
            AND (t.customer_id = ${userId}::uuid OR t.driver_id = ${userId}::uuid)
          LIMIT 1
        `);
        if (!tripParticipant.rows.length) {
          emitSelf(socket, "trip:message_error", { tripId, message: "You are not part of this trip" });
          return;
        }
        const participant = tripParticipant.rows[0] as any;
        const now = new Date();

        // Persist to DB first
        await rawDb.execute(rawSql`
          INSERT INTO trip_messages (trip_id, sender_id, sender_type, sender_name, message, created_at)
          VALUES (${tripId}::uuid, ${userId}::uuid, ${participant.sender_type || senderType || 'customer'}, ${participant.sender_name || senderName || ''}, ${message.trim()}, ${now.toISOString()})
        `);

        // Then relay to all participants in the trip room
        io.to(`trip:${tripId}`).emit("trip:new_message", {
          from: userId,
          senderType: participant.sender_type || senderType || 'customer',
          senderName: participant.sender_name || senderName || '',
          message: message.trim(),
          timestamp: now.toISOString(),
        });
      } catch (e: any) {
        console.error("[SOCKET] trip:send_message error:", e.message);
      }
    });

    // ── Load chat history on reconnect ────────────────────────────────────────
    socket.on("trip:get_messages", async (data: { tripId: string }) => {
      try {
        const { tripId } = data;
        if (!tripId) return;

        const tripParticipant = await rawDb.execute(rawSql`
          SELECT id
          FROM trip_requests
          WHERE id = ${tripId}::uuid
            AND (customer_id = ${userId}::uuid OR driver_id = ${userId}::uuid)
          LIMIT 1
        `);
        if (!tripParticipant.rows.length) {
          emitSelf(socket, "trip:message_error", { tripId, message: "You are not part of this trip" });
          return;
        }

        const rows = await rawDb.execute(rawSql`
          SELECT id, trip_id, sender_id, sender_type, sender_name, message, created_at
          FROM trip_messages
          WHERE trip_id = ${tripId}::uuid
          ORDER BY created_at ASC
          LIMIT 200
        `);

        emitSelf(socket, "trip:message_history", {
          tripId,
          messages: rows.rows.map((r: any) => ({
            id: r.id,
            from: r.sender_id,
            senderType: r.sender_type,
            senderName: r.sender_name,
            message: r.message,
            timestamp: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
          })),
        });
      } catch (e: any) {
        console.error("[SOCKET] trip:get_messages error:", e.message);
      }
    });

    // ── In-app call signaling (WebRTC relay) ──────────────────────────────────
    // Only allowed during active trip: accepted → arrived → on_the_way
    // Phone numbers are MASKED — real numbers never exposed over socket

    // Track active call sessions: tripId → { callerId, targetId, startedAt }

    socket.on("call:initiate", async (data: { targetUserId: string; tripId: string; callerName: string }) => {
      try {
        const { targetUserId, tripId, callerName } = data;
        // Verify active trip between the two users — ONLY during booking window
        const tripR = await rawDb.execute(rawSql`
          SELECT id, customer_id, driver_id FROM trip_requests
          WHERE id=${tripId}::uuid
            AND current_status IN ('accepted','arrived','on_the_way')
            AND (customer_id=${userId}::uuid OR driver_id=${userId}::uuid)
            AND (customer_id=${targetUserId}::uuid OR driver_id=${targetUserId}::uuid)
          LIMIT 1
        `);
        if (!tripR.rows.length) {
          emitSelf(socket, "call:error", { message: "Calling is only available during an active booking." });
          return;
        }

        // Log call initiation in call_logs table (best-effort)
        await rawDb.execute(rawSql`
          INSERT INTO call_logs (caller_id, receiver_id, trip_id, status, initiated_at)
          VALUES (${userId}::uuid, ${targetUserId}::uuid, ${tripId}::uuid, 'initiated', NOW())
          ON CONFLICT DO NOTHING
        `).catch(() => { });

        activeCallSessions.set(tripId, { callerId: userId, targetId: targetUserId, startedAt: Date.now() });

        io.to(`user:${targetUserId}`).emit("call:incoming", {
          callerId: userId,
          callerName,
          tripId,
          // Phone masking: never expose real phone numbers
          maskedPhone: null,
        });

        // Send FCM push for incoming call (works when app is backgrounded)
        try {
          const fcmRow = await rawDb.execute(rawSql`
            SELECT fcm_token FROM users WHERE id=${targetUserId}::uuid AND fcm_token IS NOT NULL LIMIT 1
          `);
          const fcmToken = (fcmRow.rows[0] as any)?.fcm_token;
          if (fcmToken) {
            await notifyUser(targetUserId, "call:incoming", {
              type: "incoming_call",
              title: "📞 Incoming Call",
              callerId: userId,
              callerName,
              tripId,
              maskedPhone: null,
            });
          }
        } catch (_) { }

        console.log(`[CALL] ${userId} → ${targetUserId} for trip ${tripId}`);
      } catch (e: any) {
        emitSelf(socket, "call:error", { message: "Call initiation failed" });
      }
    });

    socket.on("call:offer", (data: { targetUserId: string; tripId: string; sdp: any }) => {
      if (!isValidCallSession(data.tripId, userId, data.targetUserId)) {
        emitSelf(socket, "call:error", { message: "Invalid call session" });
        return;
      }
      io.to(`user:${data.targetUserId}`).emit("call:offer", { callerId: userId, tripId: data.tripId, sdp: data.sdp });
    });

    socket.on("call:answer", async (data: { targetUserId: string; tripId: string; sdp: any }) => {
      if (!isValidCallSession(data.tripId, userId, data.targetUserId)) {
        emitSelf(socket, "call:error", { message: "Invalid call session" });
        return;
      }
      io.to(`user:${data.targetUserId}`).emit("call:answer", { callerId: userId, tripId: data.tripId, sdp: data.sdp });
      await rawDb.execute(rawSql`
        UPDATE call_logs SET status='connected'
        WHERE trip_id=${data.tripId}::uuid
          AND ((caller_id=${userId}::uuid AND receiver_id=${data.targetUserId}::uuid) OR (caller_id=${data.targetUserId}::uuid AND receiver_id=${userId}::uuid))
          AND status='initiated'
      `).catch(() => { });
    });

    socket.on("call:ice", (data: { targetUserId: string; tripId: string; candidate: any }) => {
      if (!isValidCallSession(data.tripId, userId, data.targetUserId)) {
        return;
      }
      io.to(`user:${data.targetUserId}`).emit("call:ice", { from: userId, tripId: data.tripId, candidate: data.candidate });
    });

    socket.on("call:end", async (data: { targetUserId: string; tripId?: string; durationSec?: number }) => {
      const { targetUserId, tripId, durationSec } = data;
      io.to(`user:${targetUserId}`).emit("call:ended", { by: userId });
      // Update call log with duration
      if (tripId) {
        activeCallSessions.delete(tripId);
        await rawDb.execute(rawSql`
          UPDATE call_logs SET status='completed', ended_at=NOW(), duration_sec=${durationSec || 0}
          WHERE caller_id=${userId}::uuid AND trip_id=${tripId}::uuid AND status='initiated'
        `).catch(() => { });
      }
      console.log(`[CALL] Call ended by ${userId}${durationSec ? ` (${durationSec}s)` : ''}`);
    });

    socket.on("call:reject", async (data: { targetUserId: string; tripId?: string }) => {
      const { targetUserId, tripId } = data;
      io.to(`user:${targetUserId}`).emit("call:rejected", { by: userId });
      if (tripId) {
        activeCallSessions.delete(tripId);
        await rawDb.execute(rawSql`
          UPDATE call_logs SET status='rejected', ended_at=NOW()
          WHERE caller_id=${userId}::uuid AND trip_id=${tripId}::uuid AND status='initiated'
        `).catch(() => { });
      }
    });

    socket.on("disconnect", (reason) => {
      driverSockets.delete(userId);
      customerSockets.delete(userId);
      if (userType === "driver") {
        // Grace period: don't mark offline immediately — reconnect within 90s keeps driver visible.
        // This prevents momentary network blips from removing driver from active dispatch.
        // If driver explicitly called driver:online with isOnline=false, that already updated DB directly.
        const timer = setTimeout(async () => {
          pendingOfflineTimers.delete(userId);
          // Only mark offline if still not reconnected across any socket server instance.
          if (!(await hasAnyLiveSocketForUser(userId))) {
            rawDb.execute(rawSql`
              UPDATE driver_locations SET is_online=false, updated_at=NOW()
              WHERE driver_id=${userId}::uuid
            `).catch(() => { });
            rawDb.execute(rawSql`
              UPDATE users SET is_online=false WHERE id=${userId}::uuid
            `).catch(() => { });
            deleteDriverPresence(userId).catch(() => { });
            logInfo("PRESENCE", `Driver ${userId} offline after grace period`, { reason }).catch(() => { });
            console.log(`[SOCKET] Driver ${userId} offline (grace period expired, reason=${reason})`);
            clearDriverLocationState(userId);
          }
        }, DRIVER_OFFLINE_GRACE_MS);
        pendingOfflineTimers.set(userId, timer);
        console.log(`[SOCKET] Driver ${userId} socket disconnected (reason=${reason}) — grace period started, not offline yet`);
      } else {
        console.log(`[SOCKET] ${userType} ${userId} disconnected`);
      }
    });
  });

  console.log("[SOCKET] Socket.IO initialized");
  return io;
}

// ── Razorpay webhook: POST /api/app/razorpay/webhook ─────────────────────────
// When payment is verified and the trip was in payment_pending, set current_status = 'completed'.
// This must be implemented in routes.ts as an Express route that:
//   1. Validates the Razorpay webhook signature using RAZORPAY_WEBHOOK_SECRET
//   2. On event 'payment.captured': finds the trip by razorpay_order_id, checks current_status = 'payment_pending'
//   3. Updates trip: current_status = 'completed', completed_at = NOW(), payment_status = 'paid'
//   4. Emits trip:status_update { status: 'completed' } to the customer and driver via io
// ─────────────────────────────────────────────────────────────────────────────

// ── Notify nearby online drivers of a new searching trip ─────────────────────
export async function notifyNearbyDriversNewTrip(
  tripId: string,
  pickupLat: number,
  pickupLng: number,
  vehicleCategoryId?: string,
  excludeDriverIds: string[] = []
) {
  if (!io) return;
  try {
    if (!vehicleCategoryId) {
      console.error(`[SOCKET_MATCH] Refusing unfiltered new trip notify trip=${tripId} vehicleCategoryId=missing`);
      return;
    }
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const safeIds = excludeDriverIds.filter((id) => uuidRe.test(id));
    const excludeClause = safeIds.length > 0
      ? rawSql`AND NOT (u.id = ANY(${uuidArraySql(safeIds)}))`
      : rawSql``;
    const matchingCategoryIds = await getMatchingDriverCategoryIds(vehicleCategoryId);
    const driverRoomKey = await getDriverSocketRoomKeyForCategoryId(vehicleCategoryId);
    const driverDbVehicleType = getDriverDbVehicleType(driverRoomKey);

    const drivers = await rawDb.execute(rawSql`
      SELECT u.id, dl.lat, dl.lng, COALESCE(vc.vehicle_type, vc.name, '') as driver_vehicle_type
      FROM users u
      JOIN driver_locations dl ON dl.driver_id = u.id
      JOIN driver_details dd ON dd.user_id = u.id
      LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
      WHERE u.user_type='driver' AND ${activeDriverEligibilitySql("u")}
        AND dl.is_online=true AND u.current_trip_id IS NULL
        AND COALESCE(dd.availability_status, 'offline') = 'online'
        ${matchingCategoryIds?.length
        ? rawSql`AND dd.vehicle_category_id = ANY(${uuidArraySql(matchingCategoryIds)})`
        : vehicleCategoryId
          ? rawSql`AND dd.vehicle_category_id = ${vehicleCategoryId}::uuid`
          : rawSql``}
        ${driverDbVehicleType ? rawSql`AND vc.type = ${driverDbVehicleType}` : rawSql``}
        ${excludeClause}
        AND ((dl.lat - ${Number(pickupLat)})*(dl.lat - ${Number(pickupLat)}) + (dl.lng - ${Number(pickupLng)})*(dl.lng - ${Number(pickupLng)})) < 0.06
      ORDER BY ((dl.lat - ${Number(pickupLat)})*(dl.lat - ${Number(pickupLat)}) + (dl.lng - ${Number(pickupLng)})*(dl.lng - ${Number(pickupLng)})) ASC
      LIMIT 10
    `);

    const tripR = await rawDb.execute(rawSql`
      SELECT
        t.*,
        u.full_name as customer_name,
        vc.name as vehicle_name,
        vc.icon as vehicle_icon,
        COALESCE(NULLIF(t.vehicle_type, ''), COALESCE(vc.vehicle_type, '')) as vehicle_type_field
      FROM trip_requests t
      JOIN users u ON u.id=t.customer_id
      LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
      WHERE t.id=${tripId}::uuid
    `);
    if (!tripR.rows.length) return;
    const trip = camelize(tripR.rows[0]) as any;
    const bookingVehicleType = String(driverRoomKey || trip.vehicleTypeField || "").trim().toLowerCase();
    if (!bookingVehicleType) {
      console.error(`[SOCKET_MATCH] Refusing segmented emit trip=${tripId} booking.vehicleType=missing`);
      return;
    }
    const matchedDriverTypes = Array.from(
      new Set((drivers.rows as any[]).map((row) => String(row.driver_vehicle_type || "unknown"))),
    );

    // Get driver FCM tokens for background push
    const driverIds = drivers.rows.map((r: any) => r.id);
    let fcmMap: Record<string, string> = {};
    if (driverIds.length > 0) {
      const devRes = await rawDb.execute(rawSql`
        SELECT user_id, fcm_token FROM user_devices
        WHERE user_id = ANY(${uuidArraySql(driverIds)}) AND fcm_token IS NOT NULL
      `);
      for (const r of devRes.rows) {
        fcmMap[(r as any).user_id] = (r as any).fcm_token;
      }
    }

    io.to(getDriverRoomName(bookingVehicleType)).emit("new_booking", {
      tripId,
      bookingVehicleType,
      matchedDriversCount: drivers.rows.length,
    });

    for (const row of drivers.rows) {
      const driverId = (row as any).id;
      const payload = {
        tripId,
        refId: trip.refId,
        customerName: trip.customerName,
        pickupAddress: trip.pickupAddress,
        destinationAddress: trip.destinationAddress,
        pickupLat: trip.pickupLat,
        pickupLng: trip.pickupLng,
        estimatedFare: trip.estimatedFare,
        estimatedDistance: trip.estimatedDistance,
        paymentMethod: trip.paymentMethod,
        tripType: trip.tripType,
        vehicleCategoryName: trip.vehicleName || trip.vehicleTypeName || null,
        vehicleIcon: trip.vehicleIcon || null,
        vehicleType: bookingVehicleType || trip.vehicleTypeField || null,
      };
      await notifyUser(driverId, "trip:new_request", payload, {
        title: "New Ride Request!",
        body: `${trip.customerName} - ${trip.pickupAddress} - Rs.${trip.estimatedFare}`,
        dataOnly: true,
        channelId: "trip_alerts",
      }).catch(() => {});
    }
    console.log(
      `[SOCKET_MATCH] trip=${tripId} booking.vehicleType=${bookingVehicleType} matchedDrivers=${drivers.rows.length} ` +
        `driverTypes=${matchedDriverTypes.join(",") || "none"}`,
    );
  } catch (e: any) {
    console.error("[SOCKET] notifyNearbyDriversNewTrip error:", e.message);
  }
}

// ── When driver comes online, check for searching trips nearby ────────────────
async function notifyDriverNearbyTrips(driverId: string, lat: number, lng: number) {
  if (!io) return;
  try {
    const driverProfile = await rawDb.execute(rawSql`
      SELECT dd.vehicle_category_id, COALESCE(vc.vehicle_type, '') as vehicle_type
      FROM driver_details dd
      LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
      WHERE dd.user_id=${driverId}::uuid
      LIMIT 1
    `);
    const driverVehicleCategoryId = (driverProfile.rows[0] as any)?.vehicle_category_id || null;
    const driverVehicleType =
      await getDriverSocketRoomKeyForCategoryId(driverVehicleCategoryId) ||
      (String((driverProfile.rows[0] as any)?.vehicle_type || "").trim().toLowerCase() || null);
    if (!driverVehicleCategoryId || !driverVehicleType) {
      console.error(
        `[SOCKET_MATCH] Refusing nearby trip scan driver=${driverId} driver.vehicleType=${driverVehicleType || "missing"} ` +
          `vehicleCategoryId=${driverVehicleCategoryId || "missing"}`,
      );
      return;
    }
    const matchingCategoryIds = await getMatchingDriverCategoryIds(driverVehicleCategoryId);
    const driverDbVehicleType = getDriverDbVehicleType(driverVehicleType);

    const trips = await rawDb.execute(rawSql`
      SELECT
        t.*,
        u.full_name as customer_name,
        vc.name as vehicle_name,
        vc.icon as vehicle_icon,
        COALESCE(NULLIF(t.vehicle_type, ''), COALESCE(vc.vehicle_type, '')) as vehicle_type_field
      FROM trip_requests t
      JOIN users u ON u.id=t.customer_id
      LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
      WHERE t.current_status='searching'
        AND t.driver_id IS NULL
        AND NOT (${driverId}::uuid = ANY(COALESCE(t.rejected_driver_ids, '{}'::uuid[])))
        ${matchingCategoryIds?.length
        ? rawSql`AND t.vehicle_category_id = ANY(${uuidArraySql(matchingCategoryIds)})`
        : driverVehicleCategoryId
          ? rawSql`AND t.vehicle_category_id = ${driverVehicleCategoryId}::uuid`
          : rawSql``}
        AND (NULLIF(t.vehicle_type, '') IS NULL OR t.vehicle_type = ${driverVehicleType})
        ${driverDbVehicleType ? rawSql`AND vc.type = ${driverDbVehicleType}` : rawSql``}
        AND ((t.pickup_lat - ${lat})*(t.pickup_lat - ${lat}) + (t.pickup_lng - ${lng})*(t.pickup_lng - ${lng})) < 0.06
      LIMIT 3
    `);
    console.log(
      `[SOCKET_MATCH] driver=${driverId} driver.vehicleType=${driverVehicleType} matchedTrips=${trips.rows.length}`,
    );
    for (const row of trips.rows) {
      const trip = camelize(row) as any;
      await notifyUser(driverId, "trip:new_request", {
        tripId: trip.id,
        refId: trip.refId,
        customerName: trip.customerName,
        pickupAddress: trip.pickupAddress,
        destinationAddress: trip.destinationAddress,
        pickupLat: trip.pickupLat,
        pickupLng: trip.pickupLng,
        estimatedFare: trip.estimatedFare,
        estimatedDistance: trip.estimatedDistance,
        paymentMethod: trip.paymentMethod,
        vehicleCategoryName: trip.vehicleName || trip.vehicleTypeName || null,
        vehicleIcon: trip.vehicleIcon || null,
        vehicleType: driverVehicleType,
      }, {
        title: "New Ride Request!",
        body: `${trip.customerName} - ${trip.pickupAddress} - Rs.${trip.estimatedFare}`,
        dataOnly: true,
        channelId: "trip_alerts",
      }).catch(() => {});
    }
  } catch (e: any) {
    console.error("[SOCKET] notifyDriverNearbyTrips error:", e.message);
  }
}
