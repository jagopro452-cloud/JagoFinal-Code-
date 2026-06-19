import fs from "node:fs/promises";
import path from "node:path";
import { io } from "socket.io-client";
import pg from "pg";

const root = process.cwd();
const statePath = path.join(root, "test-results", ".live", "suite-state.json");
const state = JSON.parse(await fs.readFile(statePath, "utf8"));

const apiBase = process.env.PW_API_BASE_URL || "http://127.0.0.1:5013";
const baseURL = process.env.PW_BASE_URL || apiBase;
const dbUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/postgres";
const pool = new pg.Pool({ connectionString: dbUrl });

const customer = state.actors.customerPrimary.session;
const drivers = [
  state.actors.driverBikePrimary.session,
  state.actors.driverBikeSecondary.session,
  state.actors.driverBikeTertiary.session,
  state.actors.driverBikeQuaternary.session,
];
const bike = state.categories.bike;
const qaRunId = `REPRO-${Date.now()}`;

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function apiGet(pathname, token) {
  const response = await fetch(`${apiBase}${pathname}`, {
    headers: token ? authHeaders(token) : undefined,
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, ok: response.ok, body };
}

async function apiPost(pathname, token, body) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, ok: response.ok, body: parsed };
}

function connect(user, userType) {
  const socket = io(apiBase, {
    transports: ["websocket", "polling"],
    path: "/socket.io",
    query: {
      userId: user.user.id,
      userType,
      token: user.token,
    },
    auth: { token: user.token },
    extraHeaders: { Origin: baseURL },
    forceNew: true,
    reconnection: false,
    timeout: 10000,
  });
  return socket;
}

function waitForEvent(socket, event, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (event === "connect" && socket.connected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
    socket.once("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function snapshotTrip(tripId) {
  const trip = await pool.query(
    `select id,current_status,customer_id,driver_id,offered_driver_id,offer_expires_at,driver_accepted_at,updated_at,offer_payload,rejected_driver_ids
       from trip_requests
      where id = $1::uuid`,
    [tripId],
  );
  const statuses = await pool.query(
    `select status, source, note, created_at
       from trip_status
      where trip_id = $1::uuid
      order by created_at`,
    [tripId],
  ).catch(() => ({ rows: [] }));
  return {
    trip: trip.rows[0] || null,
    statuses: statuses.rows,
  };
}

async function main() {
  console.log("API", apiBase);
  console.log("DB", dbUrl);

  const customerSocket = connect(customer, "customer");
  const driverSockets = drivers.map((driver) => ({ driver, socket: connect(driver, "driver") }));

  const customerEvents = [];
  for (const name of ["trip:driver_assigned", "trip:accepted", "trip:searching", "trip:no_drivers"]) {
    customerSocket.on(name, (payload) => {
      customerEvents.push({ event: name, payload, at: new Date().toISOString() });
      console.log("CUSTOMER_EVENT", name, JSON.stringify(payload));
    });
  }

  for (const { driver, socket } of driverSockets) {
    socket.on("trip:new_request", (payload) => {
      console.log("DRIVER_NEW_REQUEST", driver.user.phone, JSON.stringify(payload));
    });
    socket.on("driver:accept_trip_error", (payload) => {
      console.log("DRIVER_ACCEPT_ERROR", driver.user.phone, JSON.stringify(payload));
    });
  }

  await waitForEvent(customerSocket, "connect");
  for (const { socket } of driverSockets) {
    await waitForEvent(socket, "connect");
  }

  for (const { socket } of driverSockets) {
    socket.emit("driver:online", { isOnline: true, lat: 17.385, lng: 78.4867 });
    await waitForEvent(socket, "driver:online_ack");
  }

  const booking = await apiPost("/api/app/customer/book-ride", customer.token, {
    pickupAddress: `[${qaRunId}] repro pickup`,
    pickupLat: 17.385,
    pickupLng: 78.4867,
    destinationAddress: `[${qaRunId}] repro destination`,
    destinationLat: 17.4474,
    destinationLng: 78.3762,
    vehicleCategoryId: bike.id,
    vehicleType: bike.vehicleType || bike.name.toLowerCase(),
    estimatedFare: 123,
    estimatedDistance: 5.5,
    paymentMethod: "cash",
    tripType: "normal",
  });
  console.log("BOOKING", JSON.stringify(booking));
  const tripId = booking.body?.trip?.id || booking.body?.id || booking.body?.tripId;
  if (!tripId) throw new Error("tripId missing");

  customerSocket.emit("customer:track_trip", { tripId });

  await new Promise((resolve) => setTimeout(resolve, 4000));

  const incoming = [];
  for (const driver of drivers) {
    incoming.push({
      phone: driver.user.phone,
      incoming: await apiGet("/api/app/driver/incoming-trip", driver.token),
    });
  }
  console.log("INCOMING", JSON.stringify(incoming, null, 2));
  console.log("SNAPSHOT_BEFORE_ACCEPT", JSON.stringify(await snapshotTrip(tripId), null, 2));

  const accept = await apiPost("/api/app/driver/accept-trip", drivers[0].token, { tripId });
  console.log("HTTP_ACCEPT_DRIVER1", JSON.stringify(accept, null, 2));

  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log("SNAPSHOT_AFTER_ACCEPT", JSON.stringify(await snapshotTrip(tripId), null, 2));
  console.log("CUSTOMER_EVENTS", JSON.stringify(customerEvents, null, 2));

  for (const { driver, socket } of driverSockets.slice(1, 3)) {
    socket.emit("driver:accept_trip", { tripId });
    console.log("SOCKET_ACCEPT_SENT", driver.user.phone);
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log("SNAPSHOT_AFTER_SOCKET_RACE", JSON.stringify(await snapshotTrip(tripId), null, 2));
  console.log("CUSTOMER_EVENTS_FINAL", JSON.stringify(customerEvents, null, 2));

  await apiPost("/api/app/customer/cancel-trip", customer.token, { tripId, reason: `[${qaRunId}] cleanup` }).catch(() => null);
  customerSocket.close();
  for (const { socket } of driverSockets) socket.close();
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
