import { io } from "socket.io-client";
import fs from "node:fs/promises";

const BASE_URL = process.env.PW_API_BASE_URL || "http://127.0.0.1:5000";
const PASSWORD = process.env.PW_LIVE_MOBILE_PASSWORD || "Greeshmant@2023";
const ADMIN_EMAIL = process.env.PW_ADMIN_EMAIL || "qa-admin@jago.test";
const ADMIN_PASSWORD = process.env.PW_ADMIN_PASSWORD || "Greeshmant@2023";

const now = Date.now();
const phasePhones = {
  single: "9000000001",
  dualA: "9000000001",
  dualB: "9000000002",
  driver: "9100000009",
};

const report = {
  environment: {
    baseUrl: BASE_URL,
    startedAt: new Date().toISOString(),
  },
  phases: {},
  issues: [],
};

let cachedState = null;

function decodeJwtPayload(token) {
  try {
    const [, payload] = String(token || "").split(".");
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function addIssue(severity, title, details) {
  report.issues.push({ severity, title, details });
}

async function api(path, { method = "GET", token, body, expected = [200] } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!expected.includes(response.status)) {
    const error = new Error(`Unexpected ${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { status: response.status, data };
}

async function login(phone, userType) {
  const res = await api("/api/app/login-password", {
    method: "POST",
    body: { phone, password: PASSWORD, userType },
    expected: [200, 201],
  });
  return res.data;
}

async function loadSuiteState() {
  if (cachedState) return cachedState;
  const raw = await fs.readFile(new URL("../test-results/.live/suite-state.json", import.meta.url), "utf8");
  cachedState = JSON.parse(raw);
  return cachedState;
}

async function refreshCachedMobileSession(session) {
  if (!session?.refreshToken || !session?.token) return session;
  const payload = decodeJwtPayload(session.token);
  const deviceId = payload?.deviceId;
  if (!deviceId) return session;
  const response = await fetch(`${BASE_URL}/api/app/auth/refresh`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": deviceId,
    },
    body: JSON.stringify({
      refreshToken: session.refreshToken,
      deviceId,
    }),
  });
  if (!response.ok) {
    return session;
  }
  const data = await response.json();
  if (data?.token) {
    session.token = data.token;
    if (data.refreshToken) session.refreshToken = data.refreshToken;
  }
  return session;
}

async function loginAdmin() {
  const res = await api("/api/admin/login", {
    method: "POST",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    expected: [200],
  });
  return res.data;
}

async function registerCustomer(phone, fullName) {
  const existing = await fetch(`${BASE_URL}/api/app/login-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password: PASSWORD, userType: "customer" }),
  });
  if (existing.ok) {
    return existing.json();
  }
  const res = await api("/api/app/register", {
    method: "POST",
    body: { phone, password: PASSWORD, fullName, userType: "customer" },
    expected: [200, 201, 409],
  });
  if (res.status === 409) {
    return login(phone, "customer");
  }
  return res.data;
}

async function getPoolCategory(token) {
  const res = await api("/api/app/vehicle-categories", { token });
  const list = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.data) ? res.data.data : [];
  const pool = list.find((item) => {
    const hay = `${item.name || ""} ${item.type || ""} ${item.vehicleType || ""} ${item.serviceType || ""}`.toLowerCase();
    return item.isCarpool === true || hay.includes("pool") || hay.includes("carpool");
  });
  if (!pool) throw new Error("Missing pool vehicle category");
  return pool;
}

async function registerDriver(phone, fullName) {
  const existing = await fetch(`${BASE_URL}/api/app/login-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password: PASSWORD, userType: "driver" }),
  });
  if (existing.ok) {
    return existing.json();
  }
  const res = await api("/api/app/register", {
    method: "POST",
    body: { phone, password: PASSWORD, fullName, userType: "driver" },
    expected: [200, 201, 409],
  });
  if (res.status === 409) {
    return login(phone, "driver");
  }
  return res.data;
}

async function updateDriverProfile(driverToken, payload) {
  return api("/api/app/driver/profile", {
    method: "PATCH",
    token: driverToken,
    body: payload,
    expected: [200],
  });
}

async function activateDriverPool(adminToken, driverId, seatCapacity = 4) {
  return api(`/api/admin/drivers/${driverId}/service-activation`, {
    method: "PATCH",
    token: adminToken,
    body: {
      poolEligibility: true,
      outstationEligibility: true,
      seatCapacity,
      parcelEligibility: false,
      serviceEligibility: [],
    },
    expected: [200],
  });
}

async function endActivePoolSession(driverToken) {
  try {
    await api("/api/app/driver/pool/session/end", { method: "POST", token: driverToken, expected: [200] });
  } catch {}
}

async function startPoolSession(driverToken, vehicleCategoryId, maxSeats = 4) {
  return api("/api/app/driver/pool/session/start", {
    method: "POST",
    token: driverToken,
    body: { vehicleCategoryId, maxSeats },
    expected: [200],
  });
}

async function updatePoolLocation(driverToken, lat, lng, bearingDeg = 45) {
  return api("/api/app/driver/pool/location", {
    method: "PATCH",
    token: driverToken,
    body: { lat, lng, bearingDeg },
    expected: [200],
  });
}

async function getDriverPoolSession(driverToken) {
  const res = await api("/api/app/driver/pool/session/active", {
    token: driverToken,
    expected: [200, 404],
  });
  return res.data;
}

async function bookPool(customerToken, payload) {
  return api("/api/app/customer/pool/book", {
    method: "POST",
    token: customerToken,
    body: payload,
    expected: [200, 400, 409, 503],
  });
}

async function poolStatus(customerToken, requestId) {
  return api(`/api/app/customer/pool/status/${requestId}`, { token: customerToken, expected: [200, 404] });
}

async function cancelPool(customerToken, requestId, reason) {
  return api(`/api/app/customer/pool/cancel/${requestId}`, {
    method: "POST",
    token: customerToken,
    body: { reason },
    expected: [200, 400, 404],
  });
}

async function driverAccept(driverToken, requestId) {
  return api(`/api/app/driver/pool/passengers/${requestId}/accept`, {
    method: "POST",
    token: driverToken,
    expected: [200, 404],
  });
}

async function driverPickup(driverToken, requestId, otp) {
  return api(`/api/app/driver/pool/passengers/${requestId}/pickup`, {
    method: "POST",
    token: driverToken,
    body: { otp },
    expected: [200, 400, 404],
  });
}

async function driverDrop(driverToken, requestId) {
  return api(`/api/app/driver/pool/passengers/${requestId}/drop`, {
    method: "POST",
    token: driverToken,
    expected: [200, 404, 409],
  });
}

async function driverNoShow(driverToken, requestId) {
  return api(`/api/app/driver/pool/passengers/${requestId}/no-show`, {
    method: "POST",
    token: driverToken,
    expected: [200, 404],
  });
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRequestInDriverSession(driverToken, requestId, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const session = await getDriverPoolSession(driverToken);
    const passengers = session?.data?.passengers || session?.passengers || [];
    const found = passengers.find((item) => String(item.id) === String(requestId));
    if (found) {
      return { session, passenger: found };
    }
    await wait(500);
  }
  throw new Error(`request ${requestId} not visible in driver session`);
}

async function waitForStatus(customerToken, requestId, allowedStatuses, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const statusRes = await poolStatus(customerToken, requestId);
    const booking = statusRes.data?.data?.booking || statusRes.data?.booking || statusRes.data?.data || statusRes.data;
    const status = booking?.status;
    if (allowedStatuses.includes(status)) {
      return booking;
    }
    await wait(500);
  }
  throw new Error(`request ${requestId} did not reach ${allowedStatuses.join(", ")}`);
}

function makePoolBookingBody(poolCategoryId, latOffset, lngOffset, seatsRequested = 1) {
  const pickupLat = 17.385 + latOffset;
  const pickupLng = 78.4867 + lngOffset;
  const dropLat = 17.395 + latOffset;
  const dropLng = 78.4967 + lngOffset;
  return {
    pickupLat,
    pickupLng,
    dropLat,
    dropLng,
    pickupAddress: `QA pickup ${latOffset},${lngOffset}`,
    dropAddress: `QA drop ${latOffset},${lngOffset}`,
    seatsRequested,
    vehicleCategoryId: poolCategoryId,
    paymentMethod: "cash",
  };
}

async function setupDriver() {
  const state = await loadSuiteState();
  const admin = state.admin.session;
  const bootstrapCustomer = await refreshCachedMobileSession(state.actors.customerPrimary.session);
  const poolCategory = await getPoolCategory(bootstrapCustomer.token);
  const driver = await refreshCachedMobileSession(state.actors.driverBikePrimary.session);
  const driverToken = driver.token;
  await updateDriverProfile(driverToken, {
    fullName: "QA Pool Driver",
    vehicleNumber: "TS09QA9009",
    vehicleModel: "QA Pool Sedan",
    vehicleCategoryId: poolCategory.id,
  });
  await activateDriverPool(admin.token, driver.user.id, 4);
  await endActivePoolSession(driverToken);
  await startPoolSession(driverToken, poolCategory.id, 4);
  await updatePoolLocation(driverToken, 17.385, 78.4867, 45);
  return { driver, driverToken, poolCategory };
}

async function phaseSinglePassenger() {
  const state = await loadSuiteState();
  const customer = await refreshCachedMobileSession(state.actors.customerPrimary.session);
  const { driverToken, poolCategory } = await setupDriver();
  const bookingRes = await bookPool(customer.token, makePoolBookingBody(poolCategory.id, 0.0001, 0.0001));
  const requestId = bookingRes.data?.data?.requestId;
  const boardingOtp = bookingRes.data?.data?.boardingOtp;
  if (!requestId || !boardingOtp) throw new Error("single passenger booking did not return requestId/boardingOtp");
  await waitForRequestInDriverSession(driverToken, requestId);
  const acceptRes = await driverAccept(driverToken, requestId);
  const matchedBooking = await waitForStatus(customer.token, requestId, ["matched"]);
  const wrongOtp = await driverPickup(driverToken, requestId, "0000");
  const correctOtp = await driverPickup(driverToken, requestId, boardingOtp);
  await waitForStatus(customer.token, requestId, ["picked_up"]);

  const trackingEvents = [];
  const socket = io(BASE_URL, {
    transports: ["websocket"],
    auth: { token: customer.token },
    extraHeaders: { Authorization: `Bearer ${customer.token}` },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket timeout")), 8000);
    socket.on("connect", () => { clearTimeout(timer); resolve(); });
    socket.on("connect_error", reject);
  });
  socket.on("pool:driver_location", (payload) => trackingEvents.push(payload));
  await updatePoolLocation(driverToken, 17.386, 78.4875, 50);
  await wait(1500);
  socket.disconnect();

  const reconnectSocket = io(BASE_URL, {
    transports: ["websocket"],
    auth: { token: customer.token },
    extraHeaders: { Authorization: `Bearer ${customer.token}` },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("reconnect socket timeout")), 8000);
    reconnectSocket.on("connect", () => { clearTimeout(timer); resolve(); });
    reconnectSocket.on("connect_error", reject);
  });
  const reconnectEvents = [];
  reconnectSocket.on("pool:driver_location", (payload) => reconnectEvents.push(payload));
  await updatePoolLocation(driverToken, 17.387, 78.488, 55);
  await wait(1500);
  reconnectSocket.disconnect();

  const duplicateOtp = await driverPickup(driverToken, requestId, boardingOtp);
  const dropRes = await driverDrop(driverToken, requestId);
  const droppedBooking = await waitForStatus(customer.token, requestId, ["dropped"]);
  const activeSessionAfterDrop = await getDriverPoolSession(driverToken);
  const endRes = await api("/api/app/driver/pool/session/end", { method: "POST", token: driverToken, expected: [200] });

  report.phases.singlePassenger = {
    bookingStatus: bookingRes.data?.code,
    acceptStatus: acceptRes.data?.code,
    matchedStatus: matchedBooking?.status,
    wrongOtpStatus: wrongOtp.status,
    wrongOtpCode: wrongOtp.data?.code || wrongOtp.data?.message,
    correctOtpStatus: correctOtp.data?.code,
    duplicateOtpStatus: duplicateOtp.status,
    dropStatus: dropRes.data?.code,
    finalStatus: droppedBooking?.status,
    seatStateAfterDrop: activeSessionAfterDrop?.data?.session ? {
      availableSeats: activeSessionAfterDrop.data.session.available_seats,
      maxSeats: activeSessionAfterDrop.data.session.max_seats,
    } : null,
    sessionEndCode: endRes.data?.code,
    trackingEvents: trackingEvents.length,
    reconnectEvents: reconnectEvents.length,
  };

  if (wrongOtp.status === 200) {
    addIssue("HIGH", "Wrong OTP accepted in local pool pickup", { requestId });
  }
  if (trackingEvents.length === 0) {
    addIssue("HIGH", "No realtime tracking event delivered for active local pool passenger", { requestId });
  }
  if (reconnectEvents.length === 0) {
    addIssue("HIGH", "No tracking event after socket reconnect", { requestId });
  }
}

async function phaseTwoPassenger() {
  const state = await loadSuiteState();
  const customerA = await refreshCachedMobileSession(state.actors.customerPrimary.session);
  const customerB = await refreshCachedMobileSession(state.actors.customerSecondary.session);
  const { driverToken, poolCategory } = await setupDriver();

  const bookingA = await bookPool(customerA.token, makePoolBookingBody(poolCategory.id, 0.0002, 0.0002));
  const requestA = bookingA.data?.data?.requestId;
  const otpA = bookingA.data?.data?.boardingOtp;
  if (!requestA || !otpA) throw new Error("booking A missing request/otp");
  await waitForRequestInDriverSession(driverToken, requestA);
  await driverAccept(driverToken, requestA);
  await waitForStatus(customerA.token, requestA, ["matched"]);

  const bookingB = await bookPool(customerB.token, makePoolBookingBody(poolCategory.id, 0.0003, 0.0003));
  const requestB = bookingB.data?.data?.requestId;
  const otpB = bookingB.data?.data?.boardingOtp;
  if (!requestB || !otpB) throw new Error("booking B missing request/otp");
  const sessionWithBoth = await waitForRequestInDriverSession(driverToken, requestB);
  await driverAccept(driverToken, requestB);
  await waitForStatus(customerB.token, requestB, ["matched"]);

  const passengerSnapshot = (sessionWithBoth.session?.data?.passengers || []).map((p) => ({
    id: String(p.id),
    pickupOrder: p.pickup_order ?? p.pickupOrder,
    dropOrder: p.drop_order ?? p.dropOrder,
    seats: p.seats_requested ?? p.seatsRequested,
  }));

  await driverPickup(driverToken, requestA, otpA);
  await driverPickup(driverToken, requestB, otpB);
  await waitForStatus(customerA.token, requestA, ["picked_up"]);
  await waitForStatus(customerB.token, requestB, ["picked_up"]);

  await driverDrop(driverToken, requestA);
  const afterDropA = await getDriverPoolSession(driverToken);
  await driverDrop(driverToken, requestB);
  const afterDropB = await getDriverPoolSession(driverToken);
  const endRes = await api("/api/app/driver/pool/session/end", { method: "POST", token: driverToken, expected: [200] });

  report.phases.twoPassenger = {
    requestA,
    requestB,
    passengerSnapshot,
    afterDropA: afterDropA?.data?.session ? {
      availableSeats: afterDropA.data.session.available_seats,
      activePassengers: afterDropA.data.passengers?.length || 0,
    } : null,
    afterDropB: afterDropB?.data?.session ? {
      availableSeats: afterDropB.data.session.available_seats,
      activePassengers: afterDropB.data.passengers?.length || 0,
    } : null,
    sessionEndCode: endRes.data?.code,
  };

  if (passengerSnapshot.length < 2) {
    addIssue("HIGH", "Second passenger did not appear in shared local pool session", { requestA, requestB });
  }
}

async function phaseConcurrency(batchSize) {
  report.phases[`concurrency${batchSize}`] = {
    executed: false,
    blocker: "Need 50/100 distinct customers or QA seed key. Current local environment rate-limits new registrations and exposes only 2 seeded customer actors.",
  };
  addIssue("HIGH", "Local pool hostile concurrency certification blocked", {
    batchSize,
    reason: "Insufficient seeded customers and registration endpoint is rate-limited for new actor creation.",
  });
}

async function phaseCancellation() {
  const state = await loadSuiteState();
  const customerBefore = await refreshCachedMobileSession(state.actors.customerPrimary.session);
  const customerAfter = await refreshCachedMobileSession(state.actors.customerSecondary.session);
  const customerNoShow = await refreshCachedMobileSession(state.actors.customerPrimary.session);
  const customerDriverCancel = await refreshCachedMobileSession(state.actors.customerSecondary.session);
  const { driverToken, poolCategory } = await setupDriver();

  const before = await bookPool(customerBefore.token, makePoolBookingBody(poolCategory.id, 0.0021, 0.0021));
  const beforeReq = before.data?.data?.requestId;
  await waitForRequestInDriverSession(driverToken, beforeReq);
  const beforeCancel = await cancelPool(customerBefore.token, beforeReq, "before accept");

  const after = await bookPool(customerAfter.token, makePoolBookingBody(poolCategory.id, 0.0022, 0.0022));
  const afterReq = after.data?.data?.requestId;
  await waitForRequestInDriverSession(driverToken, afterReq);
  await driverAccept(driverToken, afterReq);
  const afterCancel = await cancelPool(customerAfter.token, afterReq, "after accept");

  const noShow = await bookPool(customerNoShow.token, makePoolBookingBody(poolCategory.id, 0.0023, 0.0023));
  const noShowReq = noShow.data?.data?.requestId;
  const noShowOtp = noShow.data?.data?.boardingOtp;
  await waitForRequestInDriverSession(driverToken, noShowReq);
  await driverAccept(driverToken, noShowReq);
  const noShowRes = await driverNoShow(driverToken, noShowReq);

  const driverCancel = await bookPool(customerDriverCancel.token, makePoolBookingBody(poolCategory.id, 0.0024, 0.0024));
  const driverCancelReq = driverCancel.data?.data?.requestId;
  await waitForRequestInDriverSession(driverToken, driverCancelReq);
  await driverAccept(driverToken, driverCancelReq);
  const endSession = await api("/api/app/driver/pool/session/end", { method: "POST", token: driverToken, expected: [200] });
  const driverCancelStatus = await waitForStatus(customerDriverCancel.token, driverCancelReq, ["cancelled"]);

  report.phases.cancellation = {
    beforeAccept: { status: beforeCancel.data?.code, refundAmount: beforeCancel.data?.data?.refundAmount ?? beforeCancel.data?.refundAmount },
    afterAccept: { status: afterCancel.data?.code, refundAmount: afterCancel.data?.data?.refundAmount ?? afterCancel.data?.refundAmount },
    noShow: { status: noShowRes.data?.code, otpIssued: Boolean(noShowOtp) },
    driverCancel: { sessionEnd: endSession.data?.code, finalStatus: driverCancelStatus.status, refundAmount: driverCancelStatus.refund_amount },
  };
}

async function phaseOtp() {
  const state = await loadSuiteState();
  const customer = await refreshCachedMobileSession(state.actors.customerPrimary.session);
  const { driverToken, poolCategory } = await setupDriver();
  const booking = await bookPool(customer.token, makePoolBookingBody(poolCategory.id, 0.0031, 0.0031));
  const requestId = booking.data?.data?.requestId;
  const otp = booking.data?.data?.boardingOtp;
  await waitForRequestInDriverSession(driverToken, requestId);
  await driverAccept(driverToken, requestId);
  const wrong = await driverPickup(driverToken, requestId, "1111");
  await wait(46_000);
  const late = await driverPickup(driverToken, requestId, otp);
  const duplicate = late.status === 200 ? await driverPickup(driverToken, requestId, otp) : { status: null, data: null };
  if (late.status === 200) {
    await driverDrop(driverToken, requestId);
  } else {
    await cancelPool(customer.token, requestId, "otp cleanup");
  }
  await api("/api/app/driver/pool/session/end", { method: "POST", token: driverToken, expected: [200] });

  report.phases.otp = {
    wrongOtpStatus: wrong.status,
    lateOtpStatusAfter46s: late.status,
    duplicateOtpStatus: duplicate.status,
  };

  if (late.status === 200) {
    addIssue("MEDIUM", "Boarding OTP did not expire after 45+ seconds wait", { requestId });
  }
}

function summarize(values) {
  const out = {};
  for (const value of values) {
    const key = String(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

async function main() {
  try {
    await phaseSinglePassenger();
    await phaseTwoPassenger();
    await phaseConcurrency(50);
    await phaseConcurrency(100);
    await phaseCancellation();
    await phaseOtp();
  } catch (error) {
    addIssue("CRITICAL", "Certification runner aborted", {
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
  } finally {
    report.environment.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(report, null, 2));
  }
}

await main();
