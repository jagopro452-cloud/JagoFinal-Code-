import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const routesSource = readFileSync(join(repoRoot, "server", "routes.ts"), "utf8");
const hardeningRoutesSource = readFileSync(join(repoRoot, "server", "hardening-routes.ts"), "utf8");

describe("route hardening contracts", () => {
  it("keeps critical admin endpoints behind admin auth", () => {
    const requiredSnippets = [
      'app.post("/api/admin/rides/:tripId/force-cancel", requireAdminAuth, requireAdminRole(["admin", "superadmin"])',
      'app.get("/api/refund-requests", requireAdminAuth',
      'app.post("/api/refund-requests", requireAdminAuth',
      'app.patch("/api/refund-requests/:id", requireAdminAuth',
      'app.get("/api/admin/outstation-pool/bookings", requireAdminAuth',
      'app.get("/api/admin/outstation-pool/rides", requireAdminAuth',
      'app.patch("/api/admin/outstation-pool/settings", requireAdminAuth, requireAdminRole(["admin", "superadmin"])',
      'app.get("/api/admin/revenue/settings", requireAdminAuth',
      'app.get("/api/admin/languages", requireAdminAuth',
      'app.get("/api/platform-services", requireAdminAuth',
      'app.patch("/api/platform-services/:key", requireAdminAuth, requireAdminRole(["admin", "superadmin"])',
    ];

    for (const snippet of requiredSnippets) {
      expect(routesSource).toContain(snippet);
    }
  });

  it("guards customer cancel flow with pre-cancel state and safe refunds", () => {
    expect(routesSource).toContain("const effectiveTripId = tripId || await rawDb.execute");
    expect(routesSource).toContain("existingTrip.payment_status === 'paid_online'");
    expect(routesSource).toContain("const rzpPaymentId = existingTrip.razorpay_payment_id || null;");
    expect(routesSource).toContain("shouldApplyCustomerLateCancelFee(previousStatus, existingTrip.driver_id)");
    expect(routesSource).toContain("if (canWalletCoverCharge(walBal, cancelFee))");
    expect(routesSource).toContain('io.to(`user:${trip.driver_id}`).emit("trip:cancelled", { tripId: effectiveTripId');
    expect(routesSource).toContain('io.to(`user:${customer.id}`).emit("trip:cancelled", {');
  });

  it("keeps outstation pool booking atomic and bounded", () => {
    expect(routesSource).toContain("const seats = clampSeatRequest(seatsBooked);");
    expect(routesSource).toContain("AND available_seats >= ${seats}");
    expect(routesSource).toContain("INSERT INTO outstation_pool_bookings");
    expect(routesSource).toContain('return res.status(409).json({ message: "Not enough seats available"');
  });

  it("prevents duplicate outstation completion settlement", () => {
    expect(routesSource).toContain("AND status NOT IN ('completed', 'completing')");
    expect(routesSource).toContain("SET status='completing', updated_at=NOW()");
    expect(routesSource).toContain("status='completing'");
    expect(routesSource).toContain('return res.status(409).json({ message: existing.status === "completed" ? "Ride already completed" : "Ride completion is already in progress" });');
  });

  it("keeps cancellation penalties and notifications non-destructive", () => {
    expect(hardeningRoutesSource).toContain("if (!canWalletCoverCharge(walletBalance, penaltyAmount))");
    expect(hardeningRoutesSource).toContain("SELECT wallet_balance FROM users WHERE id=${customerId}::uuid LIMIT 1");
    expect(hardeningRoutesSource).toContain("applyWalletChange({");
    expect(hardeningRoutesSource).toContain('reason: "customer_cancel_penalty"');
    expect(hardeningRoutesSource).toContain("action: 'trip:cancelled'");
    expect(hardeningRoutesSource).toContain("type: 'trip_cancelled'");
  });

  it("queues trip completion notifications through the outbox processor", () => {
    expect(routesSource).toContain("processOutboxBatch(io, 5).catch(dbCatch(\"db\"));");
    expect(routesSource).toContain("CREATE TABLE IF NOT EXISTS outbox_events");
    expect(routesSource).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_one_active_trip");
    expect(routesSource).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_one_active_trip");
  });
});
