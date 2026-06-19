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

type DriverActor = {
  kind: "driver";
  session: MobileSession;
  phone: string;
  name: string;
};

type CustomerActor = {
  kind: "customer";
  session: MobileSession;
  phone: string;
  name: string;
};

type ActorBundle = {
  drivers: {
    a: DriverActor;
    b: DriverActor;
  };
  customers: CustomerActor[];
  poolCategory: any;
};

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

const report = {
  environment: {
    baseUrl: BASE_URL,
    startedAt: new Date().toISOString(),
  },
  bootstrap: {} as Record<string, any>,
  phases: {} as Record<string, any>,
  issues: [] as Array<{ severity: Severity; title: string; details: any }>,
};

function addIssue(severity: Severity, title: string, details: any) {
  report.issues.push({ severity, title, details });
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

function makeBookingBody(poolCategoryId: string, latOffset: number, lngOffset: number, seatsRequested = 1) {
  return {
    pickupLat: 17.385 + latOffset,
    pickupLng: 78.4867 + lngOffset,
    dropLat: 17.395 + latOffset,
    dropLng: 78.4967 + lngOffset,
    pickupAddress: `QA pickup ${latOffset.toFixed(4)},${lngOffset.toFixed(4)}`,
    dropAddress: `QA drop ${latOffset.toFixed(4)},${lngOffset.toFixed(4)}`,
    seatsRequested,
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
        cancel_reason = 'QA certification bootstrap cleanup',
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
    deviceId: `qa-local-pool-customer-${crypto.randomUUID()}`,
    ipAddress: "127.0.0.1",
    userAgent: "qa-local-pool-cert",
  });
  return {
    kind: "customer",
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

async function upsertDriver(phone: string, name: string, vehicleCategoryId: string, passwordHash: string, seatCapacity = 4): Promise<DriverActor> {
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
      'approved', ARRAY['city_pool','outstation_pool']::text[], true, true, ${seatCapacity}, NOW()
    )
    ON CONFLICT (user_id) DO UPDATE
    SET vehicle_category_id = EXCLUDED.vehicle_category_id,
        availability_status = 'offline',
        approval_state = 'approved',
        service_eligibility = ARRAY['city_pool','outstation_pool']::text[],
        pool_eligibility = true,
        outstation_eligibility = true,
        seat_capacity = ${seatCapacity},
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
    deviceId: `qa-local-pool-driver-${crypto.randomUUID()}`,
    ipAddress: "127.0.0.1",
    userAgent: "qa-local-pool-cert",
  });
  return {
    kind: "driver",
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

async function bootstrapActors(): Promise<ActorBundle> {
  const poolCategory = await getPoolCategory();
  await ensureCityPoolActive();
  await cleanupStaleQaPoolState();
  const passwordHash = await hashPassword(PASSWORD);

  const seed = Number(String(Date.now()).slice(-6));
  const customerBase = 9300000000 + seed % 100000;
  const driverBase = 9400000000 + seed % 10000;

  const driverA = await upsertDriver(makePhone(driverBase, 1), "QA Pool Driver A", String(poolCategory.id), passwordHash, 4);
  const driverB = await upsertDriver(makePhone(driverBase, 2), "QA Pool Driver B", String(poolCategory.id), passwordHash, 4);

  const customers: CustomerActor[] = [];
  for (let index = 0; index < 180; index += 1) {
    customers.push(await upsertCustomer(makePhone(customerBase, index + 1), `QA Pool Customer ${index + 1}`, passwordHash));
  }

  report.bootstrap = {
    poolCategory: {
      id: String(poolCategory.id),
      name: String(poolCategory.name),
      serviceType: String(poolCategory.service_type || ""),
      vehicleType: String(poolCategory.vehicle_type || ""),
      isCarpool: poolCategory.is_carpool === true,
      totalSeats: Number(poolCategory.total_seats || 0),
    },
    driverPhones: [driverA.phone, driverB.phone],
    customerCount: customers.length,
  };

  return {
    drivers: { a: driverA, b: driverB },
    customers,
    poolCategory,
  };
}

async function endActivePoolSession(driverToken: string) {
  try {
    await api("/api/app/driver/pool/session/end", { method: "POST", token: driverToken, expected: [200, 404] });
  } catch {}
}

async function startPoolSession(driverToken: string, vehicleCategoryId: string, lat: number, lng: number) {
  await endActivePoolSession(driverToken);
  const startRes = await api("/api/app/driver/pool/session/start", {
    method: "POST",
    token: driverToken,
    body: { vehicleCategoryId, maxSeats: 4 },
    expected: [200],
  });
  await updatePoolLocation(driverToken, lat, lng, 45);
  return startRes.data?.data?.session || startRes.data?.session || null;
}

async function updatePoolLocation(driverToken: string, lat: number, lng: number, bearingDeg = 45) {
  return api("/api/app/driver/pool/location", {
    method: "PATCH",
    token: driverToken,
    body: { lat, lng, bearingDeg },
    expected: [200],
  });
}

async function driverEligibleServices(driverToken: string) {
  return api("/api/app/driver/eligible-services", { token: driverToken, expected: [200] });
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

async function cancelPool(customerToken: string, requestId: string, reason: string) {
  return api(`/api/app/customer/pool/cancel/${requestId}`, {
    method: "POST",
    token: customerToken,
    body: { reason },
    expected: [200, 400, 404],
  });
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

async function driverNoShow(driverToken: string, requestId: string) {
  return api(`/api/app/driver/pool/passengers/${requestId}/no-show`, {
    method: "POST",
    token: driverToken,
    expected: [200, 404],
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRequestInDriverSession(driverToken: string, requestId: string, timeoutMs = 35000) {
  const started = Date.now();
  let lastSession: any = null;
  let lastPassengers: any[] = [];
  while (Date.now() - started < timeoutMs) {
    const sessionRes = await getDriverPoolSession(driverToken);
    const session = sessionRes.data?.data?.session || sessionRes.data?.session || null;
    const passengers = sessionRes.data?.data?.passengers || sessionRes.data?.passengers || [];
    lastSession = session;
    lastPassengers = passengers;
    const passenger = passengers.find((entry: any) => String(entry.id) === String(requestId));
    if (passenger) {
      return { session, passengers, passenger };
    }
    await sleep(500);
  }
  const diag = await rawDb.execute(rawSql`
    SELECT id, status, session_id, proposed_session_id, seats_requested, searched_at, seat_lock_expires_at
    FROM pool_ride_requests
    WHERE id = ${requestId}::uuid
    LIMIT 1
  `).catch(() => ({ rows: [] as any[] }));
  throw new Error(`Request ${requestId} not visible in driver session. diag=${JSON.stringify({
    request: (diag.rows[0] as any) || null,
    sessionId: lastSession?.id || null,
    availableSeats: lastSession?.available_seats || null,
    passengerIds: lastPassengers.map((entry: any) => String(entry.id)),
    passengerStatuses: lastPassengers.map((entry: any) => ({ id: String(entry.id), status: entry.status })),
  })}`);
}

async function waitForStatus(customerToken: string, requestId: string, allowedStatuses: string[], timeoutMs = 35000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const statusRes = await poolStatus(customerToken, requestId);
    const booking = statusRes.data?.data?.booking || statusRes.data?.booking || statusRes.data?.data || statusRes.data;
    const status = String(booking?.status || "");
    if (allowedStatuses.includes(status)) {
      return booking;
    }
    await sleep(500);
  }
  throw new Error(`Request ${requestId} did not reach statuses: ${allowedStatuses.join(", ")}`);
}

async function fetchRequestSnapshot(requestIds: string[]) {
  if (!requestIds.length) return [];
  const result = await rawDb.execute(rawSql`
    SELECT id, customer_id, session_id, proposed_session_id, status, seats_requested
    FROM pool_ride_requests
    WHERE id IN (${rawSql.join(requestIds.map((id) => rawSql`${id}::uuid`), rawSql`, `)})
  `).catch(() => ({ rows: [] as any[] }));
  return result.rows as any[];
}

async function verifyEligibility(bundle: ActorBundle) {
  const evidence: Record<string, any> = {};
  for (const [label, actor] of Object.entries(bundle.drivers)) {
    const res = await driverEligibleServices(actor.session.token);
    const modules = Array.isArray(res.data?.modules) ? res.data.modules : [];
    const cityPool = modules.find((item: any) => String(item.key) === "city_pool") || null;
    evidence[label] = {
      phone: actor.phone,
      cityPoolEnabled: cityPool?.enabled === true,
      blockedReasons: cityPool?.blockedReasons || [],
      dispatchProfile: {
        approvalState: res.data?.dispatchProfile?.approvalState || null,
        poolEligibility: res.data?.dispatchProfile?.poolEligibility ?? null,
        seatCapacity: res.data?.dispatchProfile?.seatCapacity ?? null,
        vehicleCategoryId: res.data?.dispatchProfile?.vehicleCategoryId ?? null,
      },
      missingDocuments: res.data?.missingDocuments || [],
    };
    if (cityPool?.enabled !== true || (cityPool?.blockedReasons || []).length > 0) {
      addIssue("CRITICAL", "Local pool eligibility blocked", { driver: label, evidence: evidence[label] });
    }
  }
  report.phases.step1Eligibility = evidence;
}

async function phaseSinglePassenger(bundle: ActorBundle) {
  await cleanupStaleQaPoolState();
  const driver = bundle.drivers.a;
  const customer = bundle.customers[0];
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.3850, 78.4867);

  const booking = await bookPool(customer.session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0001, 0.0001));
  const requestId = booking.data?.data?.requestId;
  const otp = booking.data?.data?.boardingOtp;
  if (!requestId || !otp) throw new Error("Single passenger booking did not return requestId/OTP");

  await waitForRequestInDriverSession(driver.session.token, requestId);
  const acceptRes = await driverAccept(driver.session.token, requestId);
  const matched = await waitForStatus(customer.session.token, requestId, ["matched"]);

  const socket = io(BASE_URL, {
    transports: ["websocket"],
    auth: { token: customer.session.token },
    query: { userId: customer.session.user.id, userType: "customer" },
    extraHeaders: { Authorization: `Bearer ${customer.session.token}` },
  });
  const trackingEvents: any[] = [];
  let connectCount = 0;
  const disconnectReasons: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket connect timeout")), 10000);
    socket.on("connect", () => { connectCount += 1; clearTimeout(timer); resolve(); });
    socket.on("connect_error", reject);
  });
  socket.on("disconnect", (reason) => disconnectReasons.push(String(reason)));
  socket.on("pool:driver_location", (payload) => trackingEvents.push(payload));

  const pickupRes = await driverPickup(driver.session.token, requestId, otp);
  await waitForStatus(customer.session.token, requestId, ["picked_up"]);
  await updatePoolLocation(driver.session.token, 17.3860, 78.4875, 50);
  await sleep(1500);
  const reconnectEvents: any[] = [];
  socket.disconnect();

  const reconnectSocket = io(BASE_URL, {
    transports: ["websocket"],
    auth: { token: customer.session.token },
    query: { userId: customer.session.user.id, userType: "customer" },
    extraHeaders: { Authorization: `Bearer ${customer.session.token}` },
  });
  let reconnectConnectCount = 0;
  const reconnectDisconnectReasons: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Reconnect timeout")), 10000);
    reconnectSocket.on("connect", () => { reconnectConnectCount += 1; clearTimeout(timer); resolve(); });
    reconnectSocket.on("connect_error", reject);
  });
  reconnectSocket.on("disconnect", (reason) => reconnectDisconnectReasons.push(String(reason)));
  reconnectSocket.on("pool:driver_location", (payload) => reconnectEvents.push(payload));
  await updatePoolLocation(driver.session.token, 17.3870, 78.4880, 55);
  await sleep(1500);
  reconnectSocket.disconnect();

  const dropRes = await driverDrop(driver.session.token, requestId);
  const dropped = await waitForStatus(customer.session.token, requestId, ["dropped"]);
  const sessionAfter = await getDriverPoolSession(driver.session.token);
  await endActivePoolSession(driver.session.token);

  report.phases.singlePassenger = {
    requestId,
    acceptCode: acceptRes.data?.code || null,
    matchedStatus: matched?.status || null,
    pickupCode: pickupRes.data?.code || null,
    dropCode: dropRes.data?.code || null,
    finalStatus: dropped?.status || null,
    roomId: `user:${customer.session.user.id}`,
    gpsEmitCount: 1,
    trackingEvents: trackingEvents.length,
    initialSocketConnects: connectCount,
    initialDisconnectReasons: disconnectReasons,
    reconnectRoomId: `user:${customer.session.user.id}`,
    reconnectGpsEmitCount: 1,
    reconnectEvents: reconnectEvents.length,
    reconnectSocketConnects: reconnectConnectCount,
    reconnectDisconnectReasons: reconnectDisconnectReasons,
    availableSeatsAfterDrop: sessionAfter.data?.data?.session?.available_seats ?? sessionAfter.data?.session?.available_seats ?? null,
  };

  if (!trackingEvents.length) addIssue("HIGH", "Single passenger tracking events missing", { requestId });
  if (!reconnectEvents.length) addIssue("HIGH", "Single passenger reconnect tracking missing", { requestId });
}

async function phaseMultiPassenger(bundle: ActorBundle) {
  await cleanupStaleQaPoolState();
  const driver = bundle.drivers.a;
  const customerA = bundle.customers[1];
  const customerB = bundle.customers[2];
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.3852, 78.4869);

  const bookingA = await bookPool(customerA.session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0002, 0.0002));
  const requestA = bookingA.data?.data?.requestId;
  const otpA = bookingA.data?.data?.boardingOtp;
  if (!requestA || !otpA) throw new Error("Multi passenger booking A missing requestId/OTP");
  await waitForRequestInDriverSession(driver.session.token, requestA);
  await driverAccept(driver.session.token, requestA);
  await waitForStatus(customerA.session.token, requestA, ["matched"]);

  const bookingB = await bookPool(customerB.session.token, makeBookingBody(String(bundle.poolCategory.id), 0.00025, 0.00025));
  const requestB = bookingB.data?.data?.requestId;
  const otpB = bookingB.data?.data?.boardingOtp;
  if (!requestB || !otpB) throw new Error("Multi passenger booking B missing requestId/OTP");
  const sessionWithBoth = await waitForRequestInDriverSession(driver.session.token, requestB);
  await driverAccept(driver.session.token, requestB);
  await waitForStatus(customerB.session.token, requestB, ["matched"]);

  const passengerSnapshot = (sessionWithBoth.passengers || []).map((entry: any) => ({
    id: String(entry.id),
    pickupOrder: entry.pickup_order ?? entry.pickupOrder ?? null,
    dropOrder: entry.drop_order ?? entry.dropOrder ?? null,
    seatsRequested: entry.seats_requested ?? entry.seatsRequested ?? null,
  }));

  await driverPickup(driver.session.token, requestA, otpA);
  await waitForStatus(customerA.session.token, requestA, ["picked_up"]);
  await driverPickup(driver.session.token, requestB, otpB);
  await waitForStatus(customerB.session.token, requestB, ["picked_up"]);

  await driverDrop(driver.session.token, requestA);
  const afterDropA = await getDriverPoolSession(driver.session.token);
  await driverDrop(driver.session.token, requestB);
  const afterDropB = await getDriverPoolSession(driver.session.token);
  await endActivePoolSession(driver.session.token);

  report.phases.multiPassenger = {
    requestA,
    requestB,
    passengerSnapshot,
    availableSeatsAfterDropA: afterDropA.data?.data?.session?.available_seats ?? afterDropA.data?.session?.available_seats ?? null,
    availableSeatsAfterDropB: afterDropB.data?.data?.session?.available_seats ?? afterDropB.data?.session?.available_seats ?? null,
    activePassengersAfterDropB: (afterDropB.data?.data?.passengers || afterDropB.data?.passengers || []).length,
  };

  if (passengerSnapshot.length < 2) {
    addIssue("CRITICAL", "Multi passenger session did not contain both passengers", { requestA, requestB, passengerSnapshot });
  }
}

async function phaseConcurrency(bundle: ActorBundle, count: number, startIndex: number) {
  await cleanupStaleQaPoolState();
  const driverA = bundle.drivers.a;
  const driverB = bundle.drivers.b;
  await startPoolSession(driverA.session.token, String(bundle.poolCategory.id), 17.3860, 78.4867);
  await startPoolSession(driverB.session.token, String(bundle.poolCategory.id), 17.3863, 78.4870);

  const customers = bundle.customers.slice(startIndex, startIndex + count);
  const responses = await Promise.all(customers.map((customer, index) =>
    bookPool(
      customer.session.token,
      makeBookingBody(String(bundle.poolCategory.id), 0.001 + index * 0.00001, 0.001 + index * 0.00001),
    ).then((result) => ({
      phone: customer.phone,
      status: result.status,
      code: result.data?.code || null,
      requestId: result.data?.data?.requestId || null,
    })).catch((error: any) => ({
      phone: customer.phone,
      status: error?.status || 500,
      code: error?.data?.code || error?.message || "request_failed",
      requestId: null,
    })),
  ));

  await sleep(2500);
  const requestIds = responses.map((entry) => entry.requestId).filter(Boolean) as string[];
  const snapshots = await fetchRequestSnapshot(requestIds);
  const customerIds = customers.map((customer) => customer.session.user.id);
  const duplicateCustomerActive = await rawDb.execute(rawSql`
    SELECT customer_id, COUNT(*)::int AS active_count
    FROM pool_ride_requests
    WHERE customer_id IN (${rawSql.join(customerIds.map((id) => rawSql`${id}::uuid`), rawSql`, `)})
      AND status IN ('searching', 'pending_driver_accept', 'matched', 'picked_up')
    GROUP BY customer_id
    HAVING COUNT(*) > 1
  `).catch(() => ({ rows: [] as any[] }));
  const negativeSeats = await rawDb.execute(rawSql`
    SELECT id, available_seats, max_seats
    FROM driver_pool_sessions
    WHERE driver_id IN (${rawSql`${driverA.session.user.id}::uuid`}, ${rawSql`${driverB.session.user.id}::uuid`})
      AND available_seats < 0
  `).catch(() => ({ rows: [] as any[] }));
  const overbookedSessions = await rawDb.execute(rawSql`
    SELECT dps.id,
           dps.max_seats,
           COALESCE(SUM(prr.seats_requested), 0)::int AS booked_seats
    FROM driver_pool_sessions dps
    LEFT JOIN pool_ride_requests prr
      ON prr.session_id = dps.id
     AND prr.status IN ('matched', 'picked_up')
    WHERE dps.driver_id IN (${rawSql`${driverA.session.user.id}::uuid`}, ${rawSql`${driverB.session.user.id}::uuid`})
      AND dps.status = 'active'
    GROUP BY dps.id, dps.max_seats
    HAVING COALESCE(SUM(prr.seats_requested), 0) > dps.max_seats
  `).catch(() => ({ rows: [] as any[] }));

  report.phases[`concurrency${count}`] = {
    responseSummary: responses.reduce<Record<string, number>>((acc, entry) => {
      const key = `${entry.status}:${entry.code}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    requestCount: requestIds.length,
    dbRows: snapshots.length,
    duplicateCustomerActiveRows: duplicateCustomerActive.rows.length,
    negativeSeatRows: negativeSeats.rows.length,
    overbookedSessions: overbookedSessions.rows,
  };

  if (duplicateCustomerActive.rows.length) {
    addIssue("CRITICAL", `Concurrency ${count}: duplicate active bookings detected`, duplicateCustomerActive.rows);
  }
  if (negativeSeats.rows.length) {
    addIssue("CRITICAL", `Concurrency ${count}: negative seat counts detected`, negativeSeats.rows);
  }
  if (overbookedSessions.rows.length) {
    addIssue("CRITICAL", `Concurrency ${count}: overbooked local pool session detected`, overbookedSessions.rows);
  }

  await endActivePoolSession(driverA.session.token);
  await endActivePoolSession(driverB.session.token);
}

async function phaseCancellation(bundle: ActorBundle) {
  const driver = bundle.drivers.a;

  const beforeCustomer = bundle.customers[105];
  await cleanupStaleQaPoolState();
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.3857, 78.4869);
  const beforeBooking = await bookPool(beforeCustomer.session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0021, 0.0021));
  const beforeReq = beforeBooking.data?.data?.requestId;
  if (!beforeReq) throw new Error(`Cancellation before-accept booking did not return requestId: ${JSON.stringify(beforeBooking.data)}`);
  await waitForRequestInDriverSession(driver.session.token, beforeReq);
  const beforeCancel = await cancelPool(beforeCustomer.session.token, beforeReq, "before accept");
  await endActivePoolSession(driver.session.token);

  const afterCustomer = bundle.customers[106];
  await cleanupStaleQaPoolState();
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.38575, 78.48695);
  const afterBooking = await bookPool(afterCustomer.session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0022, 0.0022));
  const afterReq = afterBooking.data?.data?.requestId;
  if (!afterReq) throw new Error(`Cancellation after-accept booking did not return requestId: ${JSON.stringify(afterBooking.data)}`);
  await waitForRequestInDriverSession(driver.session.token, afterReq);
  await driverAccept(driver.session.token, afterReq);
  const afterCancel = await cancelPool(afterCustomer.session.token, afterReq, "after accept");
  await endActivePoolSession(driver.session.token);

  const noShowCustomer = bundle.customers[107];
  await cleanupStaleQaPoolState();
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.3858, 78.4870);
  const noShowBooking = await bookPool(noShowCustomer.session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0023, 0.0023));
  const noShowReq = noShowBooking.data?.data?.requestId;
  if (!noShowReq) throw new Error(`Cancellation no-show booking did not return requestId: ${JSON.stringify(noShowBooking.data)}`);
  await waitForRequestInDriverSession(driver.session.token, noShowReq);
  await driverAccept(driver.session.token, noShowReq);
  const noShowRes = await driverNoShow(driver.session.token, noShowReq);
  await endActivePoolSession(driver.session.token);

  const driverCancelCustomer = bundle.customers[108];
  await cleanupStaleQaPoolState();
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.38585, 78.48705);
  const driverCancelBooking = await bookPool(driverCancelCustomer.session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0024, 0.0024));
  const driverCancelReq = driverCancelBooking.data?.data?.requestId;
  if (!driverCancelReq) throw new Error(`Cancellation driver-cancel booking did not return requestId: ${JSON.stringify(driverCancelBooking.data)}`);
  await waitForRequestInDriverSession(driver.session.token, driverCancelReq);
  await driverAccept(driver.session.token, driverCancelReq);
  await endActivePoolSession(driver.session.token);
  const driverCancelledStatus = await waitForStatus(driverCancelCustomer.session.token, driverCancelReq, ["cancelled"]);

  report.phases.cancellation = {
    beforeAccept: { requestId: beforeReq, status: beforeCancel.status, code: beforeCancel.data?.code || null },
    afterAccept: { requestId: afterReq, status: afterCancel.status, code: afterCancel.data?.code || null },
    noShow: { requestId: noShowReq, status: noShowRes.status, code: noShowRes.data?.code || null },
    driverCancel: { requestId: driverCancelReq, finalStatus: driverCancelledStatus?.status || null },
  };
}

async function phaseTracking(bundle: ActorBundle) {
  await cleanupStaleQaPoolState();
  const driver = bundle.drivers.b;
  const customer = bundle.customers[109];
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.3859, 78.4872);

  const booking = await bookPool(customer.session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0031, 0.0031));
  const requestId = booking.data?.data?.requestId;
  const otp = booking.data?.data?.boardingOtp;
  await waitForRequestInDriverSession(driver.session.token, requestId);
  await driverAccept(driver.session.token, requestId);
  await waitForStatus(customer.session.token, requestId, ["matched"]);

  const events: any[] = [];
  const socket = io(BASE_URL, {
    transports: ["websocket"],
    auth: { token: customer.session.token },
    query: { userId: customer.session.user.id, userType: "customer" },
    extraHeaders: { Authorization: `Bearer ${customer.session.token}` },
  });
  let connectCount = 0;
  const disconnectReasons: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tracking socket connect timeout")), 10000);
    socket.on("connect", () => { connectCount += 1; clearTimeout(timer); resolve(); });
    socket.on("connect_error", reject);
  });
  socket.on("disconnect", (reason) => disconnectReasons.push(String(reason)));
  socket.on("pool:driver_location", (payload) => events.push(payload));

  await driverPickup(driver.session.token, requestId, otp);
  await waitForStatus(customer.session.token, requestId, ["picked_up"]);
  await updatePoolLocation(driver.session.token, 17.3880, 78.4885, 65);
  await sleep(1200);
  socket.disconnect();

  const reconnectEvents: any[] = [];
  const reconnectSocket = io(BASE_URL, {
    transports: ["websocket"],
    auth: { token: customer.session.token },
    query: { userId: customer.session.user.id, userType: "customer" },
    extraHeaders: { Authorization: `Bearer ${customer.session.token}` },
  });
  let reconnectConnectCount = 0;
  const reconnectDisconnectReasons: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tracking reconnect timeout")), 10000);
    reconnectSocket.on("connect", () => { reconnectConnectCount += 1; clearTimeout(timer); resolve(); });
    reconnectSocket.on("connect_error", reject);
  });
  reconnectSocket.on("disconnect", (reason) => reconnectDisconnectReasons.push(String(reason)));
  reconnectSocket.on("pool:driver_location", (payload) => reconnectEvents.push(payload));
  await updatePoolLocation(driver.session.token, 17.3885, 78.4890, 70);
  await sleep(1200);
  reconnectSocket.disconnect();
  await driverDrop(driver.session.token, requestId);
  await endActivePoolSession(driver.session.token);

  report.phases.tracking = {
    requestId,
    roomId: `user:${customer.session.user.id}`,
    gpsEmitCount: 1,
    initialEvents: events.length,
    initialSocketConnects: connectCount,
    initialDisconnectReasons: disconnectReasons,
    reconnectRoomId: `user:${customer.session.user.id}`,
    reconnectGpsEmitCount: 1,
    reconnectEvents: reconnectEvents.length,
    reconnectSocketConnects: reconnectConnectCount,
    reconnectDisconnectReasons: reconnectDisconnectReasons,
  };

  if (!events.length) addIssue("HIGH", "Tracking phase emitted no initial GPS events", { requestId });
  if (!reconnectEvents.length) addIssue("HIGH", "Tracking phase emitted no reconnect GPS events", { requestId });
}

async function phaseOtp(bundle: ActorBundle) {
  const driver = bundle.drivers.a;

  const wrongCustomer = bundle.customers[110];
  await cleanupStaleQaPoolState();
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.3864, 78.4873);
  const wrongBooking = await bookPool(wrongCustomer.session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0041, 0.0041));
  const wrongReq = wrongBooking.data?.data?.requestId;
  await waitForRequestInDriverSession(driver.session.token, wrongReq);
  await driverAccept(driver.session.token, wrongReq);
  const wrongRes = await driverPickup(driver.session.token, wrongReq, "0000");
  await cancelPool(wrongCustomer.session.token, wrongReq, "otp cleanup wrong");
  await endActivePoolSession(driver.session.token);

  const expiredCustomer = bundle.customers[111];
  await cleanupStaleQaPoolState();
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.38645, 78.48735);
  const expiredBooking = await bookPool(expiredCustomer.session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0042, 0.0042));
  const expiredReq = expiredBooking.data?.data?.requestId;
  const expiredOtp = expiredBooking.data?.data?.boardingOtp;
  await waitForRequestInDriverSession(driver.session.token, expiredReq);
  await driverAccept(driver.session.token, expiredReq);
  await sleep(46_000);
  const expiredRes = await driverPickup(driver.session.token, expiredReq, expiredOtp);
  if (expiredRes.status === 200) {
    await driverDrop(driver.session.token, expiredReq).catch(() => undefined);
  } else {
    await cancelPool(expiredCustomer.session.token, expiredReq, "otp cleanup expired").catch(() => undefined);
  }
  await endActivePoolSession(driver.session.token);

  const duplicateCustomer = bundle.customers[112];
  await cleanupStaleQaPoolState();
  await startPoolSession(driver.session.token, String(bundle.poolCategory.id), 17.3865, 78.4874);
  const duplicateBooking = await bookPool(duplicateCustomer.session.token, makeBookingBody(String(bundle.poolCategory.id), 0.0043, 0.0043));
  const duplicateReq = duplicateBooking.data?.data?.requestId;
  const duplicateOtp = duplicateBooking.data?.data?.boardingOtp;
  await waitForRequestInDriverSession(driver.session.token, duplicateReq);
  await driverAccept(driver.session.token, duplicateReq);
  const correctRes = await driverPickup(driver.session.token, duplicateReq, duplicateOtp);
  const duplicateRes = await driverPickup(driver.session.token, duplicateReq, duplicateOtp);
  if (correctRes.status === 200) {
    await driverDrop(driver.session.token, duplicateReq).catch(() => undefined);
  }

  await endActivePoolSession(driver.session.token);

  report.phases.otp = {
    wrongRequestId: wrongReq,
    wrongOtpStatus: wrongRes.status,
    wrongOtpCode: wrongRes.data?.code || null,
    expiredRequestId: expiredReq,
    expiredOtpStatus: expiredRes.status,
    expiredOtpCode: expiredRes.data?.code || null,
    duplicateRequestId: duplicateReq,
    duplicateOtpStatus: duplicateRes.status,
    duplicateOtpCode: duplicateRes.data?.code || null,
  };

  if (wrongRes.status === 200) addIssue("CRITICAL", "Wrong OTP was accepted", { requestId: wrongReq });
  if (expiredRes.status === 200) addIssue("HIGH", "Expired OTP was still accepted after 46 seconds", { requestId: expiredReq });
  if (duplicateRes.status === 200) addIssue("HIGH", "Duplicate OTP reuse was accepted", { requestId: duplicateReq });
}

function countBySeverity(issues: Array<{ severity: Severity }>) {
  return {
    critical: issues.filter((issue) => issue.severity === "CRITICAL").length,
    high: issues.filter((issue) => issue.severity === "HIGH").length,
    medium: issues.filter((issue) => issue.severity === "MEDIUM").length,
    low: issues.filter((issue) => issue.severity === "LOW").length,
  };
}

function computeScore() {
  const phaseChecks = [
    report.phases.step1Eligibility,
    report.phases.singlePassenger,
    report.phases.multiPassenger,
    report.phases.concurrency50,
    report.phases.concurrency100,
    report.phases.cancellation,
    report.phases.tracking,
    report.phases.otp,
  ];
  const completed = phaseChecks.filter(Boolean).length;
  const severity = countBySeverity(report.issues);
  const base = Math.round((completed / phaseChecks.length) * 100);
  const penalty = severity.critical * 20 + severity.high * 10 + severity.medium * 5 + severity.low * 2;
  return Math.max(0, base - penalty);
}

async function runPhase(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error: any) {
    addIssue("CRITICAL", `${name} phase failed`, {
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
  }
}

async function main() {
  try {
    const bundle = await bootstrapActors();
    const phaseOnly = (process.env.POOL_CERT_PHASES || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const shouldRun = (name: string) => phaseOnly.length === 0 || phaseOnly.includes(name);

    if (shouldRun("eligibility")) await runPhase("eligibility", () => verifyEligibility(bundle));
    if (shouldRun("singlePassenger")) await runPhase("singlePassenger", () => phaseSinglePassenger(bundle));
    if (shouldRun("multiPassenger")) await runPhase("multiPassenger", () => phaseMultiPassenger(bundle));
    if (shouldRun("concurrency50")) await runPhase("concurrency50", () => phaseConcurrency(bundle, 50, 3));
    if (shouldRun("concurrency100")) await runPhase("concurrency100", () => phaseConcurrency(bundle, 100, 53));
    if (shouldRun("cancellation")) await runPhase("cancellation", () => phaseCancellation(bundle));
    if (shouldRun("tracking")) await runPhase("tracking", () => phaseTracking(bundle));
    if (shouldRun("otp")) await runPhase("otp", () => phaseOtp(bundle));
  } catch (error: any) {
    addIssue("CRITICAL", "Local pool certification runner aborted", {
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
  } finally {
    const counts = countBySeverity(report.issues);
    report.environment.finishedAt = new Date().toISOString();
    (report as any).summary = {
      critical: counts.critical,
      high: counts.high,
      medium: counts.medium,
      low: counts.low,
      localPoolScore: computeScore(),
      readiness: counts.critical > 0 || counts.high > 0 ? "NOT READY" : "READY",
    };
    console.log(JSON.stringify(report, null, 2));
  }
}

await main();
