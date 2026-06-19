import crypto from "node:crypto";
import { io } from "socket.io-client";
import { db as rawDb } from "../server/db";
import { sql as rawSql } from "drizzle-orm";
import { issueAppSession } from "../server/auth/app-session";
import { hashPassword } from "../server/utils/crypto";

const BASE_URL = process.env.PW_API_BASE_URL || "http://127.0.0.1:5000";
const PASSWORD = process.env.PW_LIVE_MOBILE_PASSWORD || "Greeshmant@2023";

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path: string, { method = "GET", token, body, expected = [200] }: { method?: string; token?: string; body?: any; expected?: number[] } = {}) {
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
  if (!expected.includes(response.status)) {
    const error = new Error(`Unexpected ${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
    (error as any).status = response.status;
    (error as any).data = data;
    throw error;
  }
  return { status: response.status, data };
}

function makePhone(base: number, offset: number) {
  return String(base + offset).padStart(10, "0");
}

async function getPoolCategory() {
  const vcRes = await rawDb.execute(rawSql`
    SELECT id, name, service_type, vehicle_type, is_carpool, total_seats
    FROM vehicle_categories
    ORDER BY created_at ASC
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
  `);
  await rawDb.execute(rawSql`
    INSERT INTO business_settings (key_name, value, settings_type, updated_at)
    VALUES ('local_pool_mode', 'on', 'operations', NOW())
    ON CONFLICT (key_name) DO UPDATE
    SET value = EXCLUDED.value,
        settings_type = EXCLUDED.settings_type,
        updated_at = NOW()
  `);
}

async function cleanupStaleQaPoolState() {
  await rawDb.execute(rawSql`
    DELETE FROM pool_ride_requests
    WHERE pickup_address ILIKE 'QA pickup %'
       OR drop_address ILIKE 'QA drop %'
       OR pickup_address ILIKE 'Blocker diag %'
       OR drop_address ILIKE 'Blocker diag %'
  `);
  await rawDb.execute(rawSql`
    DELETE FROM driver_pool_sessions
    WHERE notes ILIKE 'qa-%'
       OR route_name ILIKE 'qa-%'
  `).catch(() => undefined);
}

async function upsertCustomer(phone: string, fullName: string, passwordHash: string): Promise<MobileSession> {
  await rawDb.execute(rawSql`
    INSERT INTO users (full_name, phone, user_type, is_active, wallet_balance, password_hash, city)
    VALUES (${fullName}, ${phone}, 'customer', true, 100, ${passwordHash}, 'Hyderabad')
    ON CONFLICT (phone) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        password_hash = EXCLUDED.password_hash,
        user_type = 'customer',
        is_active = true,
        city = EXCLUDED.city,
        updated_at = NOW()
  `);
  const r = await rawDb.execute(rawSql`
    SELECT id, full_name, phone, COALESCE(wallet_balance, 0) AS wallet_balance
    FROM users
    WHERE phone = ${phone}
    LIMIT 1
  `);
  const row = r.rows[0] as any;
  const session = await issueAppSession(String(row.id), "customer", {
    deviceId: `qa-blocker-customer-${crypto.randomUUID()}`,
    ipAddress: "127.0.0.1",
    userAgent: "qa-local-pool-blocker",
  });
  return {
    token: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.accessTokenExpiresAt,
    user: {
      id: String(row.id),
      fullName: String(row.full_name || fullName),
      phone: String(row.phone || phone),
      userType: "customer",
      walletBalance: Number(row.wallet_balance || 0),
    },
  };
}

async function upsertDriver(phone: string, fullName: string, vehicleCategoryId: string, passwordHash: string): Promise<MobileSession> {
  await rawDb.execute(rawSql`
    INSERT INTO users (
      full_name, phone, user_type, is_active, verification_status, wallet_balance,
      password_hash, vehicle_number, vehicle_model, launch_free_active, free_period_end, onboard_date,
      current_lat, current_lng, is_online, city
    )
    VALUES (
      ${fullName}, ${phone}, 'driver', true, 'verified', 0,
      ${passwordHash}, ${`TS09${phone.slice(-4)}`}, 'QA Pool Vehicle', true, NOW() + INTERVAL '30 days', NOW(),
      17.3850, 78.4867, true, 'Hyderabad'
    )
    ON CONFLICT (phone) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        password_hash = EXCLUDED.password_hash,
        user_type = 'driver',
        verification_status = 'verified',
        is_active = true,
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
  `);
  const r = await rawDb.execute(rawSql`
    SELECT id, full_name, phone, COALESCE(wallet_balance, 0) AS wallet_balance
    FROM users
    WHERE phone = ${phone}
    LIMIT 1
  `);
  const row = r.rows[0] as any;
  await rawDb.execute(rawSql`
    INSERT INTO driver_details (
      user_id, vehicle_category_id, availability_status, avg_rating, total_trips,
      approval_state, service_eligibility, pool_eligibility, outstation_eligibility, seat_capacity, updated_at
    )
    VALUES (
      ${row.id}::uuid, ${vehicleCategoryId}::uuid, 'offline', 5.0, 0,
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
  `).catch(() => undefined);
  await rawDb.execute(rawSql`
    INSERT INTO vehicles (driver_id, vehicle_category_id, brand, model, plate_number, color, is_active, seat_capacity, created_at, updated_at)
    VALUES (${row.id}::uuid, ${vehicleCategoryId}::uuid, 'QA', 'Pool', ${`QA-${phone.slice(-4)}`}, 'Blue', true, 4, NOW(), NOW())
    ON CONFLICT (driver_id) DO UPDATE
    SET vehicle_category_id = EXCLUDED.vehicle_category_id,
        is_active = true,
        seat_capacity = 4,
        updated_at = NOW()
  `).catch(() => undefined);
  await rawDb.execute(rawSql`
    INSERT INTO driver_locations (driver_id, lat, lng, is_online, updated_at)
    VALUES (${row.id}::uuid, 17.3850, 78.4867, true, NOW())
    ON CONFLICT (driver_id) DO UPDATE
    SET lat = EXCLUDED.lat,
        lng = EXCLUDED.lng,
        is_online = true,
        updated_at = NOW()
  `);
  const session = await issueAppSession(String(row.id), "driver", {
    deviceId: `qa-blocker-driver-${crypto.randomUUID()}`,
    ipAddress: "127.0.0.1",
    userAgent: "qa-local-pool-blocker",
  });
  return {
    token: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.accessTokenExpiresAt,
    user: {
      id: String(row.id),
      fullName: String(row.full_name || fullName),
      phone: String(row.phone || phone),
      userType: "driver",
      walletBalance: Number(row.wallet_balance || 0),
    },
  };
}

async function bootstrapActors() {
  const poolCategory = await getPoolCategory();
  await ensureCityPoolActive();
  await cleanupStaleQaPoolState();
  const passwordHash = await hashPassword(PASSWORD);
  const seed = Number(String(Date.now()).slice(-6));
  const customerBase = 9301000000 + (seed % 100000);
  const driverBase = 9401000000 + (seed % 10000);
  const customer = await upsertCustomer(makePhone(customerBase, 1), "QA Pool Blocker Customer", passwordHash);
  const driver = await upsertDriver(makePhone(driverBase, 1), "QA Pool Blocker Driver", String(poolCategory.id), passwordHash);
  return { poolCategory, customer, driver };
}

async function startPoolSession(driverToken: string, vehicleCategoryId: string) {
  await api("/api/app/driver/pool/session/end", {
    method: "POST",
    token: driverToken,
    expected: [200, 404],
  }).catch(() => undefined);
  const result = await api("/api/app/driver/pool/session/start", {
    method: "POST",
    token: driverToken,
    body: {
      vehicleCategoryId,
      maxSeats: 4,
    },
    expected: [200],
  });
  await updatePoolLocation(driverToken, 17.3850, 78.4867, 45);
  return result;
}

function makeBookingBody(poolCategoryId: string) {
  return {
    pickupLat: 17.3851,
    pickupLng: 78.4868,
    dropLat: 17.3951,
    dropLng: 78.4968,
    pickupAddress: "Blocker diag pickup",
    dropAddress: "Blocker diag drop",
    seatsRequested: 1,
    vehicleCategoryId: poolCategoryId,
    paymentMethod: "cash",
  };
}

async function bookPool(customerToken: string, body: any) {
  return api("/api/app/customer/pool/book", {
    method: "POST",
    token: customerToken,
    body,
    expected: [200],
  });
}

function readRequestId(response: any) {
  return String(
    response?.data?.requestId ||
    response?.data?.data?.requestId ||
    response?.requestId ||
    "",
  );
}

function readBoardingOtp(response: any) {
  return String(
    response?.data?.boardingOtp ||
    response?.data?.data?.boardingOtp ||
    response?.boardingOtp ||
    "",
  );
}

async function waitForRequestInDriverSession(driverToken: string, requestId: string, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const session = await api("/api/app/driver/pool/session", { token: driverToken, expected: [200] });
    const queue = session.data?.data?.queue || session.data?.queue || [];
    if (Array.isArray(queue) && queue.some((item: any) => String(item.id) === requestId)) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Request ${requestId} not visible in driver session`);
}

async function driverAccept(driverToken: string, requestId: string) {
  return api(`/api/app/driver/pool/passengers/${requestId}/accept`, {
    method: "POST",
    token: driverToken,
    expected: [200],
  });
}

async function driverPickup(driverToken: string, requestId: string, otp: string, expected = [200, 400, 404, 409, 410]) {
  return api(`/api/app/driver/pool/passengers/${requestId}/pickup`, {
    method: "POST",
    token: driverToken,
    body: { otp },
    expected,
  });
}

async function updatePoolLocation(driverToken: string, lat: number, lng: number, bearingDeg = 0) {
  return api("/api/app/driver/pool/location", {
    method: "PATCH",
    token: driverToken,
    body: { lat, lng, bearingDeg },
    expected: [200],
  });
}

async function waitForStatus(customerToken: string, requestId: string, statuses: string[], timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await api(`/api/app/customer/pool/status/${requestId}`, { token: customerToken, expected: [200, 404] });
    const match = res.data?.data || res.data || null;
    if (match && statuses.includes(String(match.status))) {
      return match;
    }
    await sleep(500);
  }
  throw new Error(`Request ${requestId} did not reach statuses: ${statuses.join(", ")}`);
}

async function runTrackingProbe() {
  const { poolCategory, customer, driver } = await bootstrapActors();
  await startPoolSession(driver.token, String(poolCategory.id));
  const booking = await bookPool(customer.token, makeBookingBody(String(poolCategory.id)));
  const requestId = readRequestId(booking);
  const otp = readBoardingOtp(booking);
  if (!requestId || !otp) {
    throw new Error(`Tracking booking missing requestId/otp: ${JSON.stringify(booking.data)}`);
  }
  await waitForRequestInDriverSession(driver.token, requestId);
  await driverAccept(driver.token, requestId);
  await waitForStatus(customer.token, requestId, ["matched"]);

  const tokenOnlyEvents: any[] = [];
  const fullQueryEvents: any[] = [];
  const diagnostics = {
    tokenOnly: { connect: 0, disconnect: [] as string[], connectErrors: [] as string[] },
    fullQuery: { connect: 0, disconnect: [] as string[], connectErrors: [] as string[] },
  };

  const tokenOnly = io(BASE_URL, {
    transports: ["websocket"],
    auth: { token: customer.token },
    extraHeaders: { Authorization: `Bearer ${customer.token}` },
  });
  tokenOnly.on("connect", () => diagnostics.tokenOnly.connect++);
  tokenOnly.on("disconnect", (reason) => diagnostics.tokenOnly.disconnect.push(reason));
  tokenOnly.on("connect_error", (error: any) => diagnostics.tokenOnly.connectErrors.push(String(error?.message || error)));
  tokenOnly.on("pool:driver_location", (payload) => tokenOnlyEvents.push(payload));

  const fullQuery = io(BASE_URL, {
    transports: ["websocket"],
    auth: { token: customer.token },
    query: { userId: customer.user.id, userType: "customer" },
    extraHeaders: { Authorization: `Bearer ${customer.token}` },
  });
  fullQuery.on("connect", () => diagnostics.fullQuery.connect++);
  fullQuery.on("disconnect", (reason) => diagnostics.fullQuery.disconnect.push(reason));
  fullQuery.on("connect_error", (error: any) => diagnostics.fullQuery.connectErrors.push(String(error?.message || error)));
  fullQuery.on("pool:driver_location", (payload) => fullQueryEvents.push(payload));

  await sleep(1000);
  await driverPickup(driver.token, requestId, otp, [200]);
  await waitForStatus(customer.token, requestId, ["picked_up"]);
  await updatePoolLocation(driver.token, 17.3860, 78.4875, 55);
  await sleep(1500);
  tokenOnly.disconnect();
  fullQuery.disconnect();

  return {
    requestId,
    customerId: customer.user.id,
    tokenOnlyEvents: tokenOnlyEvents.length,
    fullQueryEvents: fullQueryEvents.length,
    tokenOnlyLastEvent: tokenOnlyEvents[tokenOnlyEvents.length - 1] || null,
    fullQueryLastEvent: fullQueryEvents[fullQueryEvents.length - 1] || null,
    diagnostics,
  };
}

async function runOtpProbe() {
  const { poolCategory, customer, driver } = await bootstrapActors();
  await startPoolSession(driver.token, String(poolCategory.id));

  const wrong = await bookPool(customer.token, makeBookingBody(String(poolCategory.id)));
  const wrongRequestId = readRequestId(wrong);
  const wrongOtp = readBoardingOtp(wrong);
  if (!wrongRequestId || !wrongOtp) throw new Error(`Wrong-OTP booking missing requestId/otp: ${JSON.stringify(wrong.data)}`);
  await waitForRequestInDriverSession(driver.token, wrongRequestId);
  await driverAccept(driver.token, wrongRequestId);
  await waitForStatus(customer.token, wrongRequestId, ["matched"]);
  const wrongPickup = await driverPickup(driver.token, wrongRequestId, "000000");

  const expired = await bookPool(customer.token, makeBookingBody(String(poolCategory.id)));
  const expiredRequestId = readRequestId(expired);
  const expiredOtp = readBoardingOtp(expired);
  if (!expiredRequestId || !expiredOtp) throw new Error(`Expired-OTP booking missing requestId/otp: ${JSON.stringify(expired.data)}`);
  await waitForRequestInDriverSession(driver.token, expiredRequestId);
  await driverAccept(driver.token, expiredRequestId);
  await waitForStatus(customer.token, expiredRequestId, ["matched"]);
  const before = await rawDb.execute(rawSql`
    SELECT created_at, searched_at, seat_lock_expires_at, boarding_otp, status
    FROM pool_ride_requests
    WHERE id = ${expiredRequestId}::uuid
  `);
  await sleep(46000);
  const expiredPickup = await driverPickup(driver.token, expiredRequestId, expiredOtp);
  const after = await rawDb.execute(rawSql`
    SELECT created_at, searched_at, seat_lock_expires_at, boarding_otp, picked_up_at, status
    FROM pool_ride_requests
    WHERE id = ${expiredRequestId}::uuid
  `);

  const duplicate = await bookPool(customer.token, makeBookingBody(String(poolCategory.id)));
  const duplicateRequestId = readRequestId(duplicate);
  const duplicateOtp = readBoardingOtp(duplicate);
  if (!duplicateRequestId || !duplicateOtp) throw new Error(`Duplicate-OTP booking missing requestId/otp: ${JSON.stringify(duplicate.data)}`);
  await waitForRequestInDriverSession(driver.token, duplicateRequestId);
  await driverAccept(driver.token, duplicateRequestId);
  await waitForStatus(customer.token, duplicateRequestId, ["matched"]);
  const firstPickup = await driverPickup(driver.token, duplicateRequestId, duplicateOtp, [200]);
  const duplicatePickup = await driverPickup(driver.token, duplicateRequestId, duplicateOtp);

  return {
    wrongOtp: {
      requestId: wrongRequestId,
      expected: [400],
      actualStatus: wrongPickup.status,
      actualCode: wrongPickup.data?.code || null,
      actualMessage: wrongPickup.data?.message || null,
    },
    expiredOtp: {
      requestId: expiredRequestId,
      expected: [410],
      before: before.rows[0] || null,
      actualStatus: expiredPickup.status,
      actualCode: expiredPickup.data?.code || null,
      actualMessage: expiredPickup.data?.message || null,
      after: after.rows[0] || null,
    },
    duplicateOtp: {
      requestId: duplicateRequestId,
      firstStatus: firstPickup.status,
      expected: [409],
      actualStatus: duplicatePickup.status,
      actualCode: duplicatePickup.data?.code || null,
      actualMessage: duplicatePickup.data?.message || null,
    },
  };
}

async function main() {
  const tracking = await runTrackingProbe();
  const otp = await runOtpProbe();
  console.log(JSON.stringify({ tracking, otp }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
