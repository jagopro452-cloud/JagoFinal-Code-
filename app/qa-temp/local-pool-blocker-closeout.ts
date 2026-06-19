import crypto from "node:crypto";
import { io } from "socket.io-client";
import { db as rawDb } from "../server/db";
import { sql as rawSql } from "drizzle-orm";
import { issueAppSession } from "../server/auth/app-session";
import { hashPassword } from "../server/utils/crypto";

const BASE_URL = process.env.PW_API_BASE_URL || "http://127.0.0.1:5000";
const PASSWORD = process.env.PW_LIVE_MOBILE_PASSWORD || "Greeshmant@2023";
const DRIVER_REQUIRED_DOCUMENT_TYPES = [
  "dl_front",
  "dl_back",
  "rc",
  "insurance",
  "selfie",
  "vehicle_photo",
] as const;

type MobileSession = {
  token: string;
  refreshToken: string;
  expiresAt: string;
  user: {
    id: string;
    fullName: string;
    phone: string;
    userType: "customer" | "driver";
    walletBalance: number;
  };
};

type DriverActor = { session: MobileSession; phone: string; name: string };
type CustomerActor = { session: MobileSession; phone: string; name: string };

const report: any = {
  environment: {
    baseUrl: BASE_URL,
    startedAt: new Date().toISOString(),
  },
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path: string, { method = "GET", token, body, expected = [200] }: { method?: string; token?: string; body?: any; expected?: number[] } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (response.status === 429 && attempt < 2) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader && Number.isFinite(Number(retryAfterHeader))
        ? Math.max(1000, Number(retryAfterHeader) * 1000)
        : 1500;
      await sleep(retryAfterMs);
      continue;
    }
    if (!expected.includes(response.status)) {
      const error = new Error(`Unexpected ${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
      (error as any).status = response.status;
      (error as any).data = data;
      throw error;
    }
    return { status: response.status, data };
  }
  throw new Error(`Retry budget exhausted for ${method} ${path}`);
}

function makePhone(base: number, offset: number) {
  return String(base + offset).padStart(10, "0");
}

function makeBookingBody(poolCategoryId: string, latOffset: number, lngOffset: number) {
  return {
    pickupLat: 17.385 + latOffset,
    pickupLng: 78.4867 + lngOffset,
    dropLat: 17.395 + latOffset,
    dropLng: 78.4967 + lngOffset,
    pickupAddress: `QA pickup ${latOffset.toFixed(4)},${lngOffset.toFixed(4)}`,
    dropAddress: `QA drop ${latOffset.toFixed(4)},${lngOffset.toFixed(4)}`,
    seatsRequested: 1,
    vehicleCategoryId: poolCategoryId,
    paymentMethod: "cash",
  };
}

async function getPoolCategory() {
  const vcRes = await rawDb.execute(rawSql`
    SELECT id, name, service_type, vehicle_type, is_carpool, total_seats
    FROM vehicle_categories
    ORDER BY
      CASE
        WHEN LOWER(name) = 'local pool' THEN 1
        WHEN LOWER(name) LIKE '%local pool%' THEN 2
        WHEN COALESCE(is_carpool, false) = true THEN 3
        WHEN LOWER(COALESCE(service_type, '')) = 'pool' THEN 4
        ELSE 100
      END,
      created_at ASC
  `);
  const pool = (vcRes.rows as any[]).find((row) => {
    const name = String(row.name || "").toLowerCase();
    return name.includes("pool") || row.is_carpool === true || String(row.service_type || "").toLowerCase() === "pool";
  });
  if (!pool) throw new Error("No pool-capable vehicle category found");
  return pool;
}

async function ensureCityPoolActive() {
  await rawDb.execute(rawSql`
    INSERT INTO platform_services (service_key, service_name, service_category, service_status, revenue_model, commission_rate, sort_order)
    VALUES ('city_pool', 'City Car Pool', 'carpool', 'active', 'commission', 10, 6)
    ON CONFLICT (service_key) DO UPDATE
    SET service_status = 'active',
        updated_at = NOW()
  `).catch(async () => {
    await rawDb.execute(rawSql`
      UPDATE platform_services
      SET service_status = 'active', updated_at = NOW()
      WHERE service_key = 'city_pool'
    `);
  });
}

async function cleanupStaleQaPoolState() {
  await rawDb.execute(rawSql`
    UPDATE pool_ride_requests prr
    SET status = 'cancelled',
        cancelled_at = NOW(),
        cancel_reason = 'QA certification blocker closeout cleanup',
        updated_at = NOW()
    FROM users u
    WHERE u.id = prr.customer_id
      AND u.full_name LIKE 'QA Pool Customer %'
      AND prr.status IN ('searching', 'pending_driver_accept', 'matched', 'picked_up')
  `).catch(() => undefined);

  await rawDb.execute(rawSql`
    UPDATE driver_pool_sessions dps
    SET status = 'ended',
        ended_at = NOW(),
        updated_at = NOW()
    FROM users u
    WHERE u.id = dps.driver_id
      AND u.full_name LIKE 'QA Pool Driver %'
      AND dps.status = 'active'
  `).catch(() => undefined);
}

async function upsertCustomer(phone: string, name: string, passwordHash: string): Promise<CustomerActor> {
  const result = await rawDb.execute(rawSql`
    INSERT INTO users (full_name, phone, user_type, is_active, wallet_balance, password_hash, city)
    VALUES (${name}, ${phone}, 'customer', true, 100, ${passwordHash}, 'Hyderabad')
    ON CONFLICT (phone) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        is_active = true,
        password_hash = EXCLUDED.password_hash,
        city = EXCLUDED.city,
        updated_at = NOW()
    RETURNING id, full_name, phone, user_type, wallet_balance
  `);
  const row = result.rows[0] as any;
  const session = await issueAppSession(String(row.id), "customer", {
    deviceId: `qa-local-pool-closeout-customer-${crypto.randomUUID()}`,
    ipAddress: "127.0.0.1",
    userAgent: "qa-local-pool-blocker-closeout",
  });
  return {
    phone,
    name,
    session: {
      token: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.accessTokenExpiresAt,
      user: {
        id: String(row.id),
        fullName: String(row.full_name || name),
        phone: String(row.phone || phone),
        userType: "customer",
        walletBalance: Number(row.wallet_balance || 0),
      },
    },
  };
}

async function upsertDriver(phone: string, name: string, vehicleCategoryId: string, passwordHash: string): Promise<DriverActor> {
  const userResult = await rawDb.execute(rawSql`
    INSERT INTO users (
      full_name, phone, user_type, is_active, verification_status, wallet_balance,
      password_hash, vehicle_number, vehicle_model, launch_free_active, free_period_end, onboard_date,
      current_lat, current_lng, is_online, city
    )
    VALUES (
      ${name}, ${phone}, 'driver', true, 'verified', 0,
      ${passwordHash}, ${`TS09${phone.slice(-4)}`}, 'QA Pool Vehicle', true, NOW() + INTERVAL '30 days', NOW(),
      17.3850, 78.4867, true, 'Hyderabad'
    )
    ON CONFLICT (phone) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        is_active = true,
        verification_status = 'verified',
        wallet_balance = 0,
        password_hash = EXCLUDED.password_hash,
        vehicle_number = EXCLUDED.vehicle_number,
        vehicle_model = EXCLUDED.vehicle_model,
        launch_free_active = true,
        free_period_end = GREATEST(COALESCE(users.free_period_end, NOW()), NOW() + INTERVAL '30 days'),
        onboard_date = COALESCE(users.onboard_date, NOW()),
        current_lat = 17.3850,
        current_lng = 78.4867,
        is_online = true,
        city = 'Hyderabad',
        updated_at = NOW()
    RETURNING id, full_name, phone, user_type, wallet_balance
  `);
  const row = userResult.rows[0] as any;
  const driverId = String(row.id);

  await rawDb.execute(rawSql`
    INSERT INTO driver_details (
      user_id, vehicle_category_id, availability_status, avg_rating, total_trips,
      approval_state, service_eligibility, pool_eligibility, outstation_eligibility, seat_capacity, updated_at
    )
    VALUES (
      ${driverId}::uuid, ${vehicleCategoryId}::uuid, 'offline', 5.0, 0,
      'approved', ARRAY['city_pool','outstation_pool']::text[], true, true, 4, NOW()
    )
    ON CONFLICT (user_id) DO UPDATE
    SET vehicle_category_id = EXCLUDED.vehicle_category_id,
        availability_status = 'offline',
        approval_state = 'approved',
        service_eligibility = ARRAY['city_pool','outstation_pool']::text[],
        pool_eligibility = true,
        outstation_eligibility = true,
        seat_capacity = 4,
        updated_at = NOW()
  `);

  await rawDb.execute(rawSql`
    INSERT INTO driver_locations (driver_id, lat, lng, is_online, updated_at)
    VALUES (${driverId}::uuid, 17.3850, 78.4867, true, NOW())
    ON CONFLICT (driver_id) DO UPDATE
    SET lat = EXCLUDED.lat,
        lng = EXCLUDED.lng,
        is_online = true,
        updated_at = NOW()
  `);

  for (const docType of DRIVER_REQUIRED_DOCUMENT_TYPES) {
    await rawDb.execute(rawSql`
      INSERT INTO driver_documents (driver_id, doc_type, file_data, mime_type, status)
      VALUES (${driverId}::uuid, ${docType}, ${"qa-seeded-document"}, 'text/plain', 'approved')
      ON CONFLICT DO NOTHING
    `);
  }

  const session = await issueAppSession(driverId, "driver", {
    deviceId: `qa-local-pool-closeout-driver-${crypto.randomUUID()}`,
    ipAddress: "127.0.0.1",
    userAgent: "qa-local-pool-blocker-closeout",
  });
  return {
    phone,
    name,
    session: {
      token: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.accessTokenExpiresAt,
      user: {
        id: driverId,
        fullName: String(row.full_name || name),
        phone: String(row.phone || phone),
        userType: "driver",
        walletBalance: Number(row.wallet_balance || 0),
      },
    },
  };
}

async function bootstrapActors() {
  const poolCategory = await getPoolCategory();
  await ensureCityPoolActive();
  await cleanupStaleQaPoolState();
  const passwordHash = await hashPassword(PASSWORD);
  const seed = Number(String(Date.now()).slice(-6));
  const customerBase = 9305000000 + seed % 100000;
  const driverBase = 9405000000 + seed % 10000;
  const driver = await upsertDriver(makePhone(driverBase, 1), "QA Pool Driver A", String(poolCategory.id), passwordHash);
  const customers = await Promise.all([
    upsertCustomer(makePhone(customerBase, 1), "QA Pool Customer 1", passwordHash),
    upsertCustomer(makePhone(customerBase, 2), "QA Pool Customer 2", passwordHash),
    upsertCustomer(makePhone(customerBase, 3), "QA Pool Customer 3", passwordHash),
    upsertCustomer(makePhone(customerBase, 4), "QA Pool Customer 4", passwordHash),
  ]);
  return { poolCategory, driver, customers };
}

async function endActivePoolSession(driverToken: string) {
  try {
    await api("/api/app/driver/pool/session/end", { method: "POST", token: driverToken, expected: [200, 404] });
  } catch {}
}

async function startPoolSession(driverToken: string, vehicleCategoryId: string, lat: number, lng: number) {
  await endActivePoolSession(driverToken);
  await api("/api/app/driver/pool/session/start", {
    method: "POST",
    token: driverToken,
    body: { vehicleCategoryId, maxSeats: 4 },
    expected: [200],
  });
  await updatePoolLocation(driverToken, lat, lng, 45);
}

async function updatePoolLocation(driverToken: string, lat: number, lng: number, bearingDeg = 45) {
  return api("/api/app/driver/pool/location", {
    method: "PATCH",
    token: driverToken,
    body: { lat, lng, bearingDeg },
    expected: [200],
  });
}

async function getDriverPoolSession(driverToken: string) {
  return api("/api/app/driver/pool/session/active", { token: driverToken, expected: [200, 404] });
}

async function bookPool(customerToken: string, payload: any) {
  return api("/api/app/customer/pool/book", {
    method: "POST",
    token: customerToken,
    body: payload,
    expected: [200, 400, 409, 503],
  });
}

async function poolStatus(customerToken: string, requestId: string) {
  return api(`/api/app/customer/pool/status/${requestId}`, { token: customerToken, expected: [200, 404] });
}

async function waitForRequestInDriverSession(driverToken: string, requestId: string, timeoutMs = 35000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const sessionRes = await getDriverPoolSession(driverToken);
    const passengers = sessionRes.data?.data?.passengers || sessionRes.data?.passengers || [];
    const passenger = passengers.find((entry: any) => String(entry.id) === String(requestId));
    if (passenger) return passenger;
    await sleep(500);
  }
  throw new Error(`Request ${requestId} not visible in driver session`);
}

async function waitForStatus(customerToken: string, requestId: string, allowedStatuses: string[], timeoutMs = 35000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const statusRes = await poolStatus(customerToken, requestId);
    const booking = statusRes.data?.data?.booking || statusRes.data?.booking || statusRes.data?.data || statusRes.data;
    const status = String(booking?.status || "");
    if (allowedStatuses.includes(status)) return booking;
    await sleep(500);
  }
  throw new Error(`Request ${requestId} did not reach statuses: ${allowedStatuses.join(", ")}`);
}

async function driverAccept(driverToken: string, requestId: string) {
  return api(`/api/app/driver/pool/passengers/${requestId}/accept`, {
    method: "POST",
    token: driverToken,
    expected: [200, 404],
  });
}

async function driverPickup(driverToken: string, requestId: string, otp: string) {
  return api(`/api/app/driver/pool/passengers/${requestId}/pickup`, {
    method: "POST",
    token: driverToken,
    body: { otp },
    expected: [200, 400, 404, 409, 410],
  });
}

async function driverDrop(driverToken: string, requestId: string) {
  return api(`/api/app/driver/pool/passengers/${requestId}/drop`, {
    method: "POST",
    token: driverToken,
    expected: [200, 404, 409],
  });
}

async function cancelPool(customerToken: string, requestId: string, reason: string) {
  return api(`/api/app/customer/pool/cancel/${requestId}`, {
    method: "POST",
    token: customerToken,
    body: { reason },
    expected: [200, 400, 404],
  });
}

async function runTracking(bundle: Awaited<ReturnType<typeof bootstrapActors>>) {
  console.log("[closeout] tracking:start");
  await cleanupStaleQaPoolState();
  const driver = bundle.driver;
  const customer = bundle.customers[0];
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.3859, 78.4872);

  const booking = await bookPool(customer.session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0031, 0.0031));
  const requestId = booking.data?.data?.requestId;
  const otp = booking.data?.data?.boardingOtp;
  await waitForRequestInDriverSession(driver.session.token, requestId);
  console.log("[closeout] tracking:request-visible", requestId);
  await driverAccept(driver.session.token, requestId);
  await waitForStatus(customer.session.token, requestId, ["matched"]);
  console.log("[closeout] tracking:matched", requestId);

  const initialEvents: any[] = [];
  const reconnectEvents: any[] = [];
  const socket = io(BASE_URL, {
    transports: ["websocket"],
    auth: { token: customer.session.token },
    query: { userId: customer.session.user.id, userType: "customer" },
    extraHeaders: { Authorization: `Bearer ${customer.session.token}` },
  });
  let initialConnects = 0;
  const initialDisconnects: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tracking socket connect timeout")), 10000);
    socket.on("connect", () => { initialConnects += 1; clearTimeout(timer); resolve(); });
    socket.on("connect_error", reject);
  });
  socket.on("disconnect", (reason) => initialDisconnects.push(String(reason)));
  socket.on("pool:driver_location", (payload) => initialEvents.push(payload));

  await driverPickup(driver.session.token, requestId, otp);
  await waitForStatus(customer.session.token, requestId, ["picked_up"]);
  console.log("[closeout] tracking:picked-up", requestId);
  const emitOne = await updatePoolLocation(driver.session.token, 17.3880, 78.4885, 65);
  await sleep(1200);
  socket.disconnect();

  const reconnectSocket = io(BASE_URL, {
    transports: ["websocket"],
    auth: { token: customer.session.token },
    query: { userId: customer.session.user.id, userType: "customer" },
    extraHeaders: { Authorization: `Bearer ${customer.session.token}` },
  });
  let reconnectConnects = 0;
  const reconnectDisconnects: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tracking reconnect timeout")), 10000);
    reconnectSocket.on("connect", () => { reconnectConnects += 1; clearTimeout(timer); resolve(); });
    reconnectSocket.on("connect_error", reject);
  });
  reconnectSocket.on("disconnect", (reason) => reconnectDisconnects.push(String(reason)));
  reconnectSocket.on("pool:driver_location", (payload) => reconnectEvents.push(payload));
  const emitTwo = await updatePoolLocation(driver.session.token, 17.3885, 78.4890, 70);
  await sleep(1200);
  reconnectSocket.disconnect();
  await driverDrop(driver.session.token, requestId);
  await endActivePoolSession(driver.session.token);
  console.log("[closeout] tracking:done", requestId);

  report.tracking = {
    requestId,
    roomId: `user:${customer.session.user.id}`,
    emitStatusCodes: [emitOne.status, emitTwo.status],
    gpsEmitCount: 2,
    receiveCount: initialEvents.length,
    reconnectReceiveCount: reconnectEvents.length,
    initialSocketConnects: initialConnects,
    reconnectSocketConnects: reconnectConnects,
    initialDisconnectReasons: initialDisconnects,
    reconnectDisconnectReasons: reconnectDisconnects,
  };
}

async function runOtp(bundle: Awaited<ReturnType<typeof bootstrapActors>>) {
  const driver = bundle.driver;
  console.log("[closeout] otp:start");

  await cleanupStaleQaPoolState();
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.3864, 78.4873);
  const wrongBooking = await bookPool(bundle.customers[1].session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0041, 0.0041));
  const wrongReq = wrongBooking.data?.data?.requestId;
  await waitForRequestInDriverSession(driver.session.token, wrongReq);
  console.log("[closeout] otp:wrong-visible", wrongReq);
  await driverAccept(driver.session.token, wrongReq);
  const wrongRes = await driverPickup(driver.session.token, wrongReq, "0000");
  console.log("[closeout] otp:wrong-result", wrongReq, wrongRes.status, wrongRes.data?.code || null);
  await cancelPool(bundle.customers[1].session.token, wrongReq, "otp cleanup wrong").catch(() => undefined);
  await endActivePoolSession(driver.session.token);

  await cleanupStaleQaPoolState();
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.38645, 78.48735);
  const expiredBooking = await bookPool(bundle.customers[2].session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0042, 0.0042));
  const expiredReq = expiredBooking.data?.data?.requestId;
  const expiredOtp = expiredBooking.data?.data?.boardingOtp;
  await waitForRequestInDriverSession(driver.session.token, expiredReq);
  console.log("[closeout] otp:expired-visible", expiredReq);
  await driverAccept(driver.session.token, expiredReq);
  console.log("[closeout] otp:expired-waiting", expiredReq);
  await sleep(46_000);
  const expiredRes = await driverPickup(driver.session.token, expiredReq, expiredOtp);
  console.log("[closeout] otp:expired-result", expiredReq, expiredRes.status, expiredRes.data?.code || null);
  await cancelPool(bundle.customers[2].session.token, expiredReq, "otp cleanup expired").catch(() => undefined);
  await endActivePoolSession(driver.session.token);

  await cleanupStaleQaPoolState();
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.3865, 78.4874);
  const duplicateBooking = await bookPool(bundle.customers[3].session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0043, 0.0043));
  const duplicateReq = duplicateBooking.data?.data?.requestId;
  const duplicateOtp = duplicateBooking.data?.data?.boardingOtp;
  await waitForRequestInDriverSession(driver.session.token, duplicateReq);
  console.log("[closeout] otp:duplicate-visible", duplicateReq);
  await driverAccept(driver.session.token, duplicateReq);
  const validRes = await driverPickup(driver.session.token, duplicateReq, duplicateOtp);
  const duplicateRes = await driverPickup(driver.session.token, duplicateReq, duplicateOtp);
  console.log("[closeout] otp:duplicate-result", duplicateReq, validRes.status, validRes.data?.code || null, duplicateRes.status, duplicateRes.data?.code || null);
  if (validRes.status === 200) {
    await driverDrop(driver.session.token, duplicateReq).catch(() => undefined);
  }
  await endActivePoolSession(driver.session.token);
  console.log("[closeout] otp:done");

  report.otp = {
    wrongRequestId: wrongReq,
    wrongOtpStatus: wrongRes.status,
    wrongOtpCode: wrongRes.data?.code || null,
    expiredRequestId: expiredReq,
    expiredOtpStatus: expiredRes.status,
    expiredOtpCode: expiredRes.data?.code || null,
    duplicateRequestId: duplicateReq,
    validOtpStatus: validRes.status,
    validOtpCode: validRes.data?.code || null,
    duplicateOtpStatus: duplicateRes.status,
    duplicateOtpCode: duplicateRes.data?.code || null,
  };
}

async function main() {
  console.log("[closeout] bootstrap:start");
  const bundle = await bootstrapActors();
  console.log("[closeout] bootstrap:done", bundle.driver.phone, bundle.customers.map((entry) => entry.phone).join(","));
  await runTracking(bundle);
  await runOtp(bundle);
  report.environment.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
