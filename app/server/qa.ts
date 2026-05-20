/**
 * QA Tracking & Build Approval System
 *
 * Enforces: no build ships without a complete QA session signed off by an approver.
 *
 * Workflow:
 *   1. Tester creates a QA session for a build version
 *   2. System pre-populates the standard checklist (login, booking, payment, edge cases)
 *   3. Tester marks each item PASS / FAIL / SKIP with optional notes
 *   4. Tester submits session — system validates: 0 FAILs + all critical items PASS
 *   5. Manager approves (or rejects with reason)
 *   6. Only an approved session unlocks the build for delivery
 *
 * Build types: customer_app | driver_app | admin_panel | all
 * Critical items: any item with critical=true — a single FAIL blocks submission
 */

// ── Standard checklist ────────────────────────────────────────────────────────

export interface ChecklistTemplate {
  id: string;          // stable identifier
  category: string;
  name: string;
  description: string;
  critical: boolean;   // if true, FAIL blocks submission entirely
  appliesTo: ("customer_app" | "driver_app" | "admin_panel")[]; // which builds
}

export const STANDARD_CHECKLIST: ChecklistTemplate[] = [
  // ── LOGIN ──────────────────────────────────────────────────────────────────
  {
    id: "login_password_customer",
    category: "LOGIN",
    name: "Customer: password login",
    description: "Enter registered email + password → lands on home screen",
    critical: true,
    appliesTo: ["customer_app"],
  },
  {
    id: "login_otp_customer",
    category: "LOGIN",
    name: "Customer: OTP login",
    description: "Enter phone → receive OTP → enter OTP → lands on home screen",
    critical: true,
    appliesTo: ["customer_app"],
  },
  {
    id: "login_wrong_otp",
    category: "LOGIN",
    name: "Customer: wrong OTP shows error",
    description: "Enter wrong OTP → clear error message, not silent fail or crash",
    critical: true,
    appliesTo: ["customer_app"],
  },
  {
    id: "login_expired_otp",
    category: "LOGIN",
    name: "Customer: expired OTP rejected",
    description: "Wait >5 min after OTP sent → try entering → 'OTP expired' message",
    critical: false,
    appliesTo: ["customer_app"],
  },
  {
    id: "login_otp_retry_limit",
    category: "LOGIN",
    name: "Customer: OTP retry limit enforced",
    description: "Attempt OTP >5 times → rate limit message shown, no infinite loop",
    critical: false,
    appliesTo: ["customer_app"],
  },
  {
    id: "login_password_driver",
    category: "LOGIN",
    name: "Driver: password login",
    description: "Driver logs in with credentials → lands on home/online screen",
    critical: true,
    appliesTo: ["driver_app"],
  },
  {
    id: "login_otp_driver",
    category: "LOGIN",
    name: "Driver: OTP login",
    description: "Driver uses phone OTP → logs in correctly",
    critical: true,
    appliesTo: ["driver_app"],
  },
  {
    id: "login_logout_relogin",
    category: "LOGIN",
    name: "Logout → re-login works",
    description: "Logout → fully clears session → login again without stale state",
    critical: true,
    appliesTo: ["customer_app", "driver_app"],
  },

  // ── BOOKING FLOW ───────────────────────────────────────────────────────────
  {
    id: "booking_create",
    category: "BOOKING",
    name: "Customer: book a ride end-to-end",
    description: "Select pickup → destination → vehicle → confirm → 'searching' state shown",
    critical: true,
    appliesTo: ["customer_app"],
  },
  {
    id: "booking_driver_notified",
    category: "BOOKING",
    name: "Driver: receives ride request",
    description: "Driver app shows incoming trip with fare, pickup, timer",
    critical: true,
    appliesTo: ["driver_app"],
  },
  {
    id: "booking_driver_accept",
    category: "BOOKING",
    name: "Driver accepts → customer sees driver",
    description: "Driver taps Accept → customer screen shows driver name, photo, ETA",
    critical: true,
    appliesTo: ["customer_app", "driver_app"],
  },
  {
    id: "booking_ride_start_otp",
    category: "BOOKING",
    name: "Ride starts with OTP verification",
    description: "Driver enters OTP shown on customer screen → ride status = in_progress",
    critical: true,
    appliesTo: ["customer_app", "driver_app"],
  },
  {
    id: "booking_live_tracking",
    category: "BOOKING",
    name: "Customer: live driver location tracking",
    description: "Driver's marker moves on customer map in real time during ride",
    critical: true,
    appliesTo: ["customer_app"],
  },
  {
    id: "booking_complete_ride",
    category: "BOOKING",
    name: "Ride completion flow",
    description: "Driver marks complete → customer sees fare summary → rating prompt",
    critical: true,
    appliesTo: ["customer_app", "driver_app"],
  },
  {
    id: "booking_payment_cash",
    category: "BOOKING",
    name: "Cash payment works",
    description: "Cash trip completes → no payment error, trip marked completed correctly",
    critical: true,
    appliesTo: ["customer_app"],
  },
  {
    id: "booking_payment_wallet",
    category: "BOOKING",
    name: "Wallet payment deducted correctly",
    description: "Wallet balance deducted by exact fare amount after trip completes",
    critical: true,
    appliesTo: ["customer_app"],
  },
  {
    id: "booking_driver_reject_next",
    category: "BOOKING",
    name: "Driver rejects → next driver offered",
    description: "Driver rejects → dispatch moves to next driver, customer still searching",
    critical: false,
    appliesTo: ["customer_app", "driver_app"],
  },
  {
    id: "booking_customer_cancel",
    category: "BOOKING",
    name: "Customer cancels → driver notified",
    description: "Customer cancels → driver sees 'Trip cancelled' immediately",
    critical: false,
    appliesTo: ["customer_app", "driver_app"],
  },

  // ── EDGE CASES ─────────────────────────────────────────────────────────────
  {
    id: "edge_network_drop",
    category: "EDGE_CASE",
    name: "Network drop during ride → recovers",
    description: "Turn off WiFi/data for 30s during active ride → turn back on → app reconnects, tracking resumes",
    critical: true,
    appliesTo: ["customer_app", "driver_app"],
  },
  {
    id: "edge_app_background",
    category: "EDGE_CASE",
    name: "App backgrounded → returns to correct screen",
    description: "Minimize app during ride → open again → trip screen still showing, not reset",
    critical: true,
    appliesTo: ["customer_app", "driver_app"],
  },
  {
    id: "edge_call_during_ride",
    category: "EDGE_CASE",
    name: "Incoming phone call during ride",
    description: "Receive phone call → end call → app still tracking, no crash",
    critical: false,
    appliesTo: ["customer_app", "driver_app"],
  },
  {
    id: "edge_driver_offline_reconnect",
    category: "EDGE_CASE",
    name: "Driver reconnects after socket drop",
    description: "Kill driver app mid-trip → reopen → trip automatically rejoins, customer still tracking",
    critical: true,
    appliesTo: ["driver_app"],
  },

  // ── ADMIN PANEL ────────────────────────────────────────────────────────────
  {
    id: "admin_login",
    category: "ADMIN",
    name: "Admin login (2FA if enabled)",
    description: "Admin email + password → OTP if configured → dashboard loads",
    critical: true,
    appliesTo: ["admin_panel"],
  },
  {
    id: "admin_live_kpis",
    category: "ADMIN",
    name: "Live KPIs dashboard loads",
    description: "Active rides, online drivers, revenue — all load without error or spinner hang",
    critical: true,
    appliesTo: ["admin_panel"],
  },
  {
    id: "admin_driver_list",
    category: "ADMIN",
    name: "Driver list loads and is searchable",
    description: "Driver management page loads, search/filter works, no blank table",
    critical: false,
    appliesTo: ["admin_panel"],
  },
  {
    id: "admin_trip_history",
    category: "ADMIN",
    name: "Trip history loads with correct data",
    description: "Trip reports page loads, trip from today visible, fare amounts correct",
    critical: false,
    appliesTo: ["admin_panel"],
  },
  {
    id: "admin_action_reflect",
    category: "ADMIN",
    name: "Admin action reflects in app immediately",
    description: "Block a driver in admin → driver app loses access within 30s",
    critical: false,
    appliesTo: ["admin_panel"],
  },
];

/** Returns checklist items relevant to a given build type. */
export function getChecklistForBuild(
  buildType: "customer_app" | "driver_app" | "admin_panel" | "all",
): ChecklistTemplate[] {
  if (buildType === "all") return STANDARD_CHECKLIST;
  return STANDARD_CHECKLIST.filter(item => item.appliesTo.includes(buildType));
}

/** Validates a set of results before allowing submission.
 *  Returns { valid: true } or { valid: false, blockers: string[] }
 */
export function validateQaSession(
  results: { templateId: string; status: "pass" | "fail" | "skip" | "pending" }[],
  buildType: "customer_app" | "driver_app" | "admin_panel" | "all",
): { valid: boolean; blockers: string[] } {
  const checklist = getChecklistForBuild(buildType);
  const resultMap = new Map(results.map(r => [r.templateId, r.status]));
  const blockers: string[] = [];

  for (const item of checklist) {
    const status = resultMap.get(item.id) ?? "pending";
    if (item.critical && status === "fail") {
      blockers.push(`CRITICAL FAIL: [${item.category}] ${item.name}`);
    }
    if (item.critical && status === "skip") {
      blockers.push(`CRITICAL SKIPPED: [${item.category}] ${item.name}`);
    }
    if (item.critical && status === "pending") {
      blockers.push(`CRITICAL NOT TESTED: [${item.category}] ${item.name}`);
    }
  }

  return { valid: blockers.length === 0, blockers };
}
