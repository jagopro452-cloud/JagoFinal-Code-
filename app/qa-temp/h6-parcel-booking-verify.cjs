#!/usr/bin/env node
/**
 * H6 parcel booking hardening verification.
 * Run with local server: npm run dev (canonical-app)
 * Usage: node qa-temp/h6-parcel-booking-verify.cjs
 */
const path = require("node:path");
const crypto = require("node:crypto");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });
dotenv.config({ path: path.resolve(__dirname, "../.env.playwright.local"), override: true });

const BASE_URL = (process.env.LOAD_BASE_URL || process.env.PW_API_BASE_URL || process.env.APP_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const OPS_API_KEY = process.env.LOAD_OPS_API_KEY || process.env.PW_OPS_API_KEY || process.env.OPS_API_KEY || process.env.ADMIN_RESET_KEY || "";
const SEED_PASSWORD = process.env.PW_LIVE_MOBILE_PASSWORD || process.env.SEED_TEST_ACCOUNT_PASSWORD || "";

const BOOK_BODY = {
  vehicleCategory: "bike_parcel",
  pickupAddress: "H6 QA Pickup, Hyderabad",
  pickupLat: 17.385,
  pickupLng: 78.4867,
  pickupContactName: "QA",
  pickupContactPhone: "9999999999",
  dropLocations: [{
    address: "H6 QA Drop, Hyderabad",
    lat: 17.44,
    lng: 78.5,
    receiverName: "Receiver",
    receiverPhone: "8888888888",
  }],
  totalDistanceKm: 5,
  weightKg: 1,
  paymentMethod: "cash",
  notes: "H6 verification",
};

async function request(method, pathname, { token, idempotencyKey, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

async function seedAndLogin() {
  if (!OPS_API_KEY || !SEED_PASSWORD) {
    throw new Error("Missing OPS_API_KEY or SEED_TEST_ACCOUNT_PASSWORD in env");
  }
  const seeded = await request("GET", `/api/ops/seed-test-accounts?key=${encodeURIComponent(OPS_API_KEY)}`, {
    token: null,
  });
  if (seeded.status !== 200) throw new Error(`Seed failed: ${seeded.status}`);
  const customer = seeded.body?.customers?.[0];
  if (!customer?.phone) throw new Error("No seeded customer");

  const login = await request("POST", "/api/app/login-password", {
    body: {
      phone: customer.phone,
      password: SEED_PASSWORD,
      userType: "customer",
    },
  });
  if (login.status !== 200 || !login.body?.token) {
    throw new Error(`Login failed: ${login.status}`);
  }
  return { token: login.body.token, customerId: customer.id };
}

async function cleanupOrders(token) {
  const orders = await request("GET", "/api/app/parcel/orders", { token });
  for (const order of orders.body?.orders || []) {
    if (["searching", "driver_assigned", "accepted", "picked_up", "in_transit", "pending"].includes(order.current_status)) {
      await request("POST", `/api/app/parcel/${order.id}/cancel`, { token, body: { reason: "H6 QA cleanup" } });
    }
  }
}

function idemKey() {
  return crypto.randomBytes(16).toString("hex");
}

async function main() {
  const results = [];
  const { token } = await seedAndLogin();
  await cleanupOrders(token);

  // 1. Single booking
  const key1 = idemKey();
  const single = await request("POST", "/api/app/parcel/book", { token, idempotencyKey: key1, body: BOOK_BODY });
  results.push({
    test: "single_booking",
    pass: single.status === 200 && single.body?.success === true && Boolean(single.body?.orderId),
    status: single.status,
    code: single.body?.code || null,
    orderId: single.body?.orderId || null,
  });
  const firstOrderId = single.body?.orderId;

  // 2. Double tap (same idempotency key, active parcel exists)
  const doubleTap = await request("POST", "/api/app/parcel/book", { token, idempotencyKey: key1, body: BOOK_BODY });
  results.push({
    test: "double_tap_same_idempotency",
    pass: doubleTap.status === 200 && doubleTap.body?.idempotent === true && doubleTap.body?.orderId === firstOrderId,
    status: doubleTap.status,
    code: doubleTap.body?.code || null,
    orderId: doubleTap.body?.orderId || null,
  });

  // 3. Concurrent requests (10) with different idempotency keys
  const concurrent = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      request("POST", "/api/app/parcel/book", {
        token,
        idempotencyKey: idemKey(),
        body: { ...BOOK_BODY, notes: `H6 concurrent ${i}` },
      }),
    ),
  );
  const successCount = concurrent.filter((r) => r.status === 200 && r.body?.success === true && !r.body?.idempotent).length;
  const conflictCount = concurrent.filter((r) => r.status === 409 && r.body?.code === "ACTIVE_PARCEL_EXISTS").length;
  const replayCount = concurrent.filter((r) => r.status === 200 && r.body?.idempotent === true).length;
  results.push({
    test: "ten_concurrent_requests",
    pass: successCount === 1 && conflictCount + replayCount === 9,
    successCount,
    conflictCount,
    replayCount,
    statuses: concurrent.map((r) => r.status),
    codes: concurrent.map((r) => r.body?.code || null),
  });

  // 4. Same idempotency key retry after success
  const retry = await request("POST", "/api/app/parcel/book", { token, idempotencyKey: key1, body: BOOK_BODY });
  results.push({
    test: "same_idempotency_key_retry",
    pass: retry.status === 200 && retry.body?.idempotent === true && retry.body?.orderId === firstOrderId,
    status: retry.status,
    code: retry.body?.code || null,
    orderId: retry.body?.orderId || null,
  });

  // 5. New booking after cancel
  const activeOrderId = firstOrderId || concurrent.find((r) => r.body?.orderId)?.body?.orderId;
  if (activeOrderId) {
    const cancel = await request("POST", `/api/app/parcel/${activeOrderId}/cancel`, {
      token,
      body: { reason: "H6 QA cancel before rebook" },
    });
    const key2 = idemKey();
    const rebook = await request("POST", "/api/app/parcel/book", { token, idempotencyKey: key2, body: BOOK_BODY });
    results.push({
      test: "new_booking_after_cancel",
      pass: cancel.status === 200 && rebook.status === 200 && rebook.body?.success === true && rebook.body?.orderId !== activeOrderId,
      cancelStatus: cancel.status,
      rebookStatus: rebook.status,
      oldOrderId: activeOrderId,
      newOrderId: rebook.body?.orderId || null,
    });
    if (rebook.body?.orderId) {
      await request("POST", `/api/app/parcel/${rebook.body.orderId}/cancel`, { token, body: { reason: "H6 QA final cleanup" } });
    }
  } else {
    results.push({ test: "new_booking_after_cancel", pass: false, error: "No active order to cancel" });
  }

  const allPass = results.every((r) => r.pass);
  console.log(JSON.stringify({ allPass, results }, null, 2));
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ allPass: false, error: err.message }, null, 2));
  process.exit(1);
});
