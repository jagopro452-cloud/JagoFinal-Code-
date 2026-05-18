import { useState, useEffect, useMemo } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const PAGE_TABS = [
  { label: "Business Info", href: "/admin/business-setup" },
  { label: "Pages & Media", href: "/admin/pages-media" },
  { label: "Configurations", href: "/admin/configurations" },
  { label: "System Settings", href: "/admin/settings" },
];

const CONFIG_TABS = [
  { id: "otp", label: "OTP Setup", icon: "bi-shield-lock-fill", color: "#dc2626", bg: "#fee2e2" },
  { id: "payment", label: "Payment Gateway", icon: "bi-credit-card-fill", color: "#1a73e8", bg: "#e8f0fe" },
  { id: "commission", label: "Commission", icon: "bi-percent", color: "#d97706", bg: "#fef9c3" },
  { id: "features", label: "Features", icon: "bi-toggles", color: "#16a34a", bg: "#f0fdf4" },
  { id: "dispatch", label: "Dispatch Settings", icon: "bi-broadcast", color: "#0891b2", bg: "#ecfeff" },
  { id: "sound", label: "Sound Alerts", icon: "bi-volume-up-fill", color: "#7c3aed", bg: "#f5f3ff" },
  { id: "firebase", label: "Firebase & SMS", icon: "bi-bell-fill", color: "#f97316", bg: "#fff7ed" },
  { id: "maps", label: "Google Maps", icon: "bi-map-fill", color: "#059669", bg: "#f0fdf4" },
  { id: "ai", label: "Claude AI", icon: "bi-stars", color: "#7c3aed", bg: "#f5f3ff" },
  { id: "runtime", label: "Runtime Control", icon: "bi-sliders2-vertical", color: "#2563eb", bg: "#eff6ff" },
];

function Toggle({ label, desc, value, onChange, id }: any) {
  return (
    <div className="d-flex align-items-center justify-content-between"
      style={{ padding: "14px 0", borderBottom: "1px solid #f1f5f9" }}>
      <div style={{ flex: 1, paddingRight: 24 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "#0f172a" }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{desc}</div>}
      </div>
      <label className="switcher mb-0">
        <input type="checkbox" className="switcher_input"
          checked={value === "true" || value === true}
          onChange={e => onChange(e.target.checked ? "true" : "false")}
          data-testid={`toggle-${id}`} />
        <span className="switcher_control"></span>
      </label>
    </div>
  );
}

function Field({ label, desc, value, onChange, type = "text", placeholder, suffix, id }: any) {
  return (
    <div style={{ padding: "14px 0", borderBottom: "1px solid #f1f5f9" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", marginBottom: 6 }}>{label}</div>
      {desc && <div style={{ fontSize: 11.5, color: "#94a3b8", marginBottom: 8 }}>{desc}</div>}
      <div className="input-group">
        <input type={type} className="admin-form-control"
          value={value || ""} onChange={e => onChange(e.target.value)}
          placeholder={placeholder || ""} data-testid={`input-${id}`}
          style={{ fontSize: 13 }} />
        {suffix && <span className="input-group-text" style={{ fontSize: 12 }}>{suffix}</span>}
      </div>
    </div>
  );
}

function NumberField({ label, desc, value, onChange, min, max, suffix, id }: any) {
  return (
    <div className="d-flex align-items-center justify-content-between"
      style={{ padding: "14px 0", borderBottom: "1px solid #f1f5f9" }}>
      <div style={{ flex: 1, paddingRight: 24 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "#0f172a" }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{desc}</div>}
      </div>
      <div className="input-group" style={{ width: 130 }}>
        <input type="number" min={min} max={max} className="admin-form-control text-center"
          value={value || ""} onChange={e => onChange(e.target.value)}
          style={{ fontSize: 15, fontWeight: 700, padding: "6px 10px" }}
          data-testid={`input-${id}`} />
        {suffix && <span className="input-group-text fw-semibold">{suffix}</span>}
      </div>
    </div>
  );
}

export default function ConfigurationsPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState("otp");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [runtimeScopeType, setRuntimeScopeType] = useState("global");
  const [runtimeScopeKey, setRuntimeScopeKey] = useState("default");
  const [runtimeReason, setRuntimeReason] = useState("");
  const [runtimeDraft, setRuntimeDraft] = useState<Record<string, any>>({});

  const { data: settingsData = [] } = useQuery<any[]>({
    queryKey: ["/api/business-settings"],
    queryFn: () => apiRequest("GET", "/api/business-settings")
      .then(r => r.json())
      .then(d => Array.isArray(d) ? d : []),
  });

  const arr = Array.isArray(settingsData) ? settingsData : [];
  const dbMap: Record<string, string> = {};
  arr.forEach((s: any) => { dbMap[s.keyName] = s.value; });

  const get = (key: string) => local[key] !== undefined ? local[key] : (dbMap[key] ?? "");
  const set = (key: string) => (val: string) => setLocal(p => ({ ...p, [key]: val }));

  const { data: runtimeSnapshotResponse, isLoading: runtimeSnapshotLoading } = useQuery<any>({
    queryKey: ["/api/admin/runtime-config"],
    queryFn: () => apiRequest("GET", "/api/admin/runtime-config").then(r => r.json()),
  });

  const { data: runtimeAuditResponse, isLoading: runtimeAuditLoading } = useQuery<any>({
    queryKey: ["/api/admin/runtime-config/audit"],
    queryFn: () => apiRequest("GET", "/api/admin/runtime-config/audit?limit=12").then(r => r.json()),
  });

  const runtimeSnapshot = runtimeSnapshotResponse?.data;
  const runtimeAudit = Array.isArray(runtimeAuditResponse?.data) ? runtimeAuditResponse.data : [];

  const resolvedRuntimeConfig = useMemo(() => {
    if (!runtimeSnapshot?.effectiveConfig) return {};
    const effective = runtimeSnapshot.effectiveConfig;
    const resolved: Record<string, any> = { ...(effective.global || {}) };
    const scopeKey = runtimeScopeKey.trim().toLowerCase();
    if (runtimeScopeType === "city" && scopeKey && effective.city?.[scopeKey]) {
      Object.assign(resolved, effective.city[scopeKey]);
    }
    if (runtimeScopeType === "service" && scopeKey && effective.service?.[scopeKey]) {
      Object.assign(resolved, effective.service[scopeKey]);
    }
    if (runtimeScopeType === "vehicle" && scopeKey && effective.vehicle?.[scopeKey]) {
      Object.assign(resolved, effective.vehicle[scopeKey]);
    }
    return resolved;
  }, [runtimeSnapshot, runtimeScopeType, runtimeScopeKey]);

  const hasBusinessChanges = Object.keys(local).length > 0;
  const hasRuntimeChanges = Object.keys(runtimeDraft).length > 0;
  const hasChanges = hasBusinessChanges || hasRuntimeChanges;

  const runtimeGet = (key: string, fallback: any = "") =>
    runtimeDraft[key] !== undefined ? runtimeDraft[key] : (resolvedRuntimeConfig?.[key] ?? fallback);
  const setRuntime = (key: string) => (val: any) => setRuntimeDraft(p => ({ ...p, [key]: val }));

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasChanges) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasChanges]);

  const save = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/business-settings", local),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/business-settings"] });
      setLocal({});
      toast({ title: "Settings saved successfully" });
    },
    onError: () => toast({ title: "Failed to save settings", variant: "destructive" }),
  });

  const saveRuntime = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/admin/runtime-config", {
      scopeType: runtimeScopeType,
      scopeKey: runtimeScopeType === "global" ? "default" : (runtimeScopeKey.trim() || "default"),
      reason: runtimeReason.trim() || "admin_runtime_update",
      entries: Object.entries(runtimeDraft).map(([key, value]) => ({ key, value })),
    }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/runtime-config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/runtime-config/audit"] });
      setRuntimeDraft({});
      setRuntimeReason("");
      toast({ title: "Runtime config updated" });
    },
    onError: (error: any) => toast({ title: error?.message || "Failed to update runtime config", variant: "destructive" }),
  });

  const rollbackRuntime = useMutation({
    mutationFn: (auditLogId: string) => apiRequest("POST", "/api/admin/runtime-config/rollback", { auditLogId }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/runtime-config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/runtime-config/audit"] });
      toast({ title: "Runtime config rolled back" });
    },
    onError: (error: any) => toast({ title: error?.message || "Rollback failed", variant: "destructive" }),
  });

  const curTab = CONFIG_TABS.find(t => t.id === tab)!;

  return (
    <div className="container-fluid">
      {/* Header */}
      <div className="d-flex align-items-center justify-content-between mb-4">
        <div>
          <h4 className="fw-bold mb-0">Configurations</h4>
          <div className="text-muted small">OTP setup, payment gateway, commission rates and feature toggles</div>
        </div>
        {hasBusinessChanges && tab !== "runtime" && (
          <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}
            data-testid="btn-save-settings">
            {save.isPending
              ? <><span className="spinner-border spinner-border-sm me-2"></span>Saving…</>
              : <><i className="bi bi-save-fill me-1"></i>Save Changes ({Object.keys(local).length})</>}
          </button>
        )}
        {hasRuntimeChanges && tab === "runtime" && (
          <button className="btn btn-primary" onClick={() => saveRuntime.mutate()} disabled={saveRuntime.isPending}
            data-testid="btn-save-runtime-settings">
            {saveRuntime.isPending
              ? <><span className="spinner-border spinner-border-sm me-2"></span>Publishingâ€¦</>
              : <><i className="bi bi-lightning-charge-fill me-1"></i>Publish Runtime ({Object.keys(runtimeDraft).length})</>}
          </button>
        )}
      </div>

      {/* Page-level tabs */}
      <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 14 }}>
        <div className="card-header bg-white py-3 px-4" style={{ borderBottom: "1px solid #f1f5f9" }}>
          <ul className="nav nav--tabs p-1 rounded bg-light">
            {PAGE_TABS.map(t => (
              <li key={t.href} className="nav-item">
                <Link href={t.href} className={`nav-link${t.href === "/admin/configurations" ? " active" : ""}`}>
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Config section tabs — horizontal, icon-based */}
      <div className="row g-2 mb-4">
        {CONFIG_TABS.map(ct => (
          <div key={ct.id} className="col-6 col-md-4 col-xl-2">
            <button
              onClick={() => setTab(ct.id)}
              className="w-100 text-start border-0"
              style={{
                background: tab === ct.id ? ct.color : "#fff",
                color: tab === ct.id ? "#fff" : "#475569",
                borderRadius: 12,
                padding: "12px 14px",
                cursor: "pointer",
                boxShadow: tab === ct.id ? `0 4px 14px ${ct.color}44` : "0 1px 4px rgba(0,0,0,0.07)",
                transition: "all .15s",
                border: `1.5px solid ${tab === ct.id ? ct.color : "#e2e8f0"}`,
              }}
              data-testid={`tab-config-${ct.id}`}>
              <div className="d-flex align-items-center gap-2 mb-1">
                <div style={{
                  width: 28, height: 28, borderRadius: 8,
                  background: tab === ct.id ? "rgba(255,255,255,0.2)" : ct.bg,
                  color: tab === ct.id ? "#fff" : ct.color,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, flexShrink: 0,
                }}>
                  <i className={`bi ${ct.icon}`}></i>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.2 }}>{ct.label}</span>
              </div>
            </button>
          </div>
        ))}
      </div>

      {/* Section header */}
      <div className="d-flex align-items-center gap-3 mb-3">
        <div style={{
          width: 42, height: 42, borderRadius: 12,
          background: curTab.bg, color: curTab.color,
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
        }}>
          <i className={`bi ${curTab.icon}`}></i>
        </div>
        <div>
          <h5 className="fw-bold mb-0">{curTab.label}</h5>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>
            {tab === "otp" && "Configure OTP verification for rides and parcels"}
            {tab === "payment" && "Setup Razorpay, Cash and Wallet payment methods"}
            {tab === "commission" && "Platform fees for B2C rides and B2B deliveries"}
            {tab === "features" && "Enable or disable platform features instantly"}
            {tab === "firebase" && "Push notifications and SMS gateway settings"}
            {tab === "maps" && "Google Maps API for location and routing"}
            {tab === "ai" && "Claude AI for voice booking — understands Telugu, Hindi, English"}
          </div>
        </div>
      </div>

      <div className="card border-0 shadow-sm" style={{ borderRadius: 14 }}>
        <div className="card-body p-4">

          {/* ===== OTP SETUP ===== */}
          {tab === "otp" && (
            <div>
              <div className="d-flex gap-2 mb-4 p-3 rounded-3" style={{ background: "#fef9c3", border: "1px solid #fde047" }}>
                <i className="bi bi-info-circle-fill text-warning mt-1" style={{ fontSize: 13, flexShrink: 0 }}></i>
                <div style={{ fontSize: 12.5, color: "#713f12" }}>
                  OTP verification ensures the right passenger gets into the right vehicle. Enable both pickup and drop OTP for maximum security.
                </div>
              </div>

              <Toggle label="Pickup OTP Verification" id="otp_pickup"
                desc="Driver asks customer to share OTP when reaching pickup location"
                value={get("otp_pickup_enabled")} onChange={set("otp_pickup_enabled")} />

              <Toggle label="Drop-off OTP Verification" id="otp_drop"
                desc="Customer enters OTP at destination before trip ends"
                value={get("otp_drop_enabled")} onChange={set("otp_drop_enabled")} />

              <NumberField label="OTP Length (digits)" id="otp_length"
                desc="Number of digits in OTP code — 4 digits recommended"
                value={get("otp_length")} onChange={set("otp_length")} min={4} max={8} suffix="digits" />

              <div className="row g-3 mt-2">
                {[
                  { key: "otp_pickup_enabled", label: "Pickup OTP", icon: "bi-geo-alt-fill", desc: "When driver arrives" },
                  { key: "otp_drop_enabled", label: "Drop OTP", icon: "bi-flag-fill", desc: "When trip ends" },
                ].map(card => {
                  const isOn = get(card.key) === "true";
                  return (
                    <div key={card.key} className="col-6">
                      <div className="card border-0" style={{
                        borderRadius: 12, padding: 16,
                        background: isOn ? "#f0fdf4" : "#f8fafc",
                        border: `1.5px solid ${isOn ? "#86efac" : "#e2e8f0"}`,
                      }}>
                        <div className="d-flex align-items-center gap-2 mb-1">
                          <i className={`bi ${card.icon}`} style={{ color: isOn ? "#16a34a" : "#94a3b8", fontSize: 16 }}></i>
                          <div style={{ fontSize: 13, fontWeight: 700, color: isOn ? "#166534" : "#475569" }}>{card.label}</div>
                        </div>
                        <div style={{ fontSize: 11.5, color: isOn ? "#16a34a" : "#94a3b8" }}>{card.desc}</div>
                        <div className="mt-2">
                          <span className="badge" style={{
                            background: isOn ? "#16a34a" : "#e2e8f0",
                            color: isOn ? "#fff" : "#475569",
                            fontSize: 10, padding: "3px 8px",
                          }}>
                            {isOn ? "ENABLED" : "DISABLED"}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ===== PAYMENT GATEWAY ===== */}
          {tab === "payment" && (
            <div>
              {/* Cash & Wallet */}
              <div className="mb-4">
                <div style={{ fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>
                  Basic Payment Methods
                </div>
                <Toggle label="Cash Payment" id="cash_enabled"
                  desc="Allow customers to pay in cash after the trip"
                  value={get("cash_enabled")} onChange={set("cash_enabled")} />
                <Toggle label="Wallet Payment" id="wallet_enabled"
                  desc="Allow customers to pay from JAGO in-app wallet"
                  value={get("wallet_enabled")} onChange={set("wallet_enabled")} />
              </div>

              {/* Razorpay */}
              <div style={{ border: "1.5px solid #e2e8f0", borderRadius: 14, padding: 20, marginBottom: 16 }}>
                <div className="d-flex align-items-center justify-content-between mb-3">
                  <div className="d-flex align-items-center gap-3">
                    <div style={{ width: 42, height: 42, borderRadius: 10, background: "#1a73e808", border: "1.5px solid #e2e8f0", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <span style={{ fontWeight: 900, fontSize: 15, color: "#1a73e8" }}>R</span>
                    </div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>Razorpay</div>
                      <div style={{ fontSize: 11.5, color: "#94a3b8" }}>India's leading payment gateway</div>
                    </div>
                  </div>
                  <label className="switcher mb-0">
                    <input type="checkbox" className="switcher_input"
                      checked={get("razorpay_enabled") === "true"}
                      onChange={e => set("razorpay_enabled")(e.target.checked ? "true" : "false")}
                      data-testid="toggle-razorpay" />
                    <span className="switcher_control"></span>
                  </label>
                </div>

                {/* Mode toggle */}
                <div className="d-flex gap-2 mb-3">
                  {["test", "live"].map(mode => (
                    <button key={mode}
                      onClick={() => set("razorpay_mode")(mode)}
                      className="btn btn-sm"
                      style={{
                        borderRadius: 8, fontSize: 12, fontWeight: 700,
                        background: get("razorpay_mode") === mode ? (mode === "live" ? "#16a34a" : "#d97706") : "#f8fafc",
                        color: get("razorpay_mode") === mode ? "#fff" : "#64748b",
                        border: `1.5px solid ${get("razorpay_mode") === mode ? (mode === "live" ? "#16a34a" : "#d97706") : "#e2e8f0"}`,
                        padding: "5px 16px",
                      }}
                      data-testid={`btn-razorpay-${mode}`}>
                      {mode === "test" ? "Test Mode" : "Live Mode"}
                    </button>
                  ))}
                  {get("razorpay_mode") === "test" && (
                    <span className="badge align-self-center" style={{ background: "#fef9c3", color: "#713f12", fontSize: 10 }}>
                      Payments will not be charged in Test mode
                    </span>
                  )}
                  {get("razorpay_mode") === "live" && (
                    <span className="badge align-self-center" style={{ background: "#f0fdf4", color: "#166534", fontSize: 10 }}>
                      Real payments will be charged
                    </span>
                  )}
                </div>

                <div className="row g-3">
                  <div className="col-12 col-md-6">
                    <label style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6, display: "block" }}>
                      Key ID <span className="text-danger">*</span>
                      <span style={{ fontWeight: 400, color: "#94a3b8", marginLeft: 6 }}>
                        (rzp_{get("razorpay_mode") === "live" ? "live" : "test"}_XXXX)
                      </span>
                    </label>
                    <input className="admin-form-control"
                      value={get("razorpay_key_id")} onChange={e => set("razorpay_key_id")(e.target.value)}
                      placeholder={`rzp_${get("razorpay_mode") === "live" ? "live" : "test"}_xxxxxxxxxxxxxxxx`}
                      data-testid="input-razorpay-key-id" style={{ fontSize: 12, fontFamily: "monospace" }} />
                  </div>
                  <div className="col-12 col-md-6">
                    <label style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6, display: "block" }}>
                      Key Secret <span className="text-danger">*</span>
                    </label>
                    <input type="password" className="admin-form-control"
                      value={get("razorpay_key_secret")} onChange={e => set("razorpay_key_secret")(e.target.value)}
                      placeholder="Enter secret key"
                      data-testid="input-razorpay-secret" style={{ fontSize: 12 }} />
                  </div>
                </div>

                <div className="mt-3 p-3 rounded-3" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 }}>
                    <i className="bi bi-info-circle me-1"></i>How to get Razorpay keys:
                  </div>
                  <ol style={{ fontSize: 11.5, color: "#64748b", margin: 0, paddingLeft: 16 }}>
                    <li>Login to <strong>dashboard.razorpay.com</strong></li>
                    <li>Go to Settings → API Keys</li>
                    <li>Click <strong>Generate Test/Live Key</strong></li>
                    <li>Copy Key ID and Secret, paste here</li>
                  </ol>
                </div>
              </div>

              {get("razorpay_enabled") !== "true" && (
                <div className="d-flex gap-2 p-3 rounded-3" style={{ background: "#f0f9ff", border: "1px solid #bae6fd" }}>
                  <i className="bi bi-lightbulb-fill text-info mt-1" style={{ fontSize: 13, flexShrink: 0 }}></i>
                  <div style={{ fontSize: 12, color: "#0c4a6e" }}>
                    Enable Razorpay toggle above to accept UPI, Cards, Net Banking, and EMI payments. Currently only Cash and Wallet payments are active.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ===== COMMISSION ===== */}
          {tab === "commission" && (
            <div>
              <div className="row g-3 mb-4">
                {[
                  { key: "platform_commission_b2c", label: "B2C Commission", desc: "Customer rides (Bike, Auto, Car, SUV)", color: "#1a73e8", bg: "#e8f0fe" },
                  { key: "platform_commission_b2b", label: "B2B Commission", desc: "Porter and business deliveries", color: "#7c3aed", bg: "#f5f3ff" },
                  { key: "driver_payout_pct", label: "Driver Payout", desc: "Driver gets this % of fare", color: "#16a34a", bg: "#f0fdf4" },
                ].map(card => (
                  <div key={card.key} className="col-12 col-md-4">
                    <div style={{ borderRadius: 14, background: card.bg, border: `1.5px solid ${card.color}22`, padding: 20, textAlign: "center" }}>
                      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8, fontWeight: 600 }}>{card.label}</div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                        <input type="number" min="0" max="100" step="0.5"
                          className="admin-form-control text-center"
                          style={{ width: 80, fontSize: 28, fontWeight: 900, color: card.color, border: "none", background: "transparent", padding: "4px 0" }}
                          value={get(card.key)} onChange={e => set(card.key)(e.target.value)}
                          data-testid={`input-${card.key}`} />
                        <span style={{ fontSize: 24, fontWeight: 900, color: card.color }}>%</span>
                      </div>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>{card.desc}</div>
                    </div>
                  </div>
                ))}
              </div>

              <NumberField label="Driver Search Radius (km)" id="driver_search_radius"
                desc="How far to search for available drivers from pickup location"
                value={get("driver_search_radius")} onChange={set("driver_search_radius")}
                min={1} max={50} suffix="km" />

              <NumberField label="Ride Request Timeout (sec)" id="ride_request_timeout"
                desc="Seconds before ride request expires if no driver accepts"
                value={get("ride_request_timeout")} onChange={set("ride_request_timeout")}
                min={10} max={120} suffix="sec" />

              <NumberField label="Surge Multiplier Cap" id="surge_max_multiplier"
                desc="Maximum allowed surge pricing multiplier (e.g. 3 = 3× normal fare)"
                value={get("surge_max_multiplier") || "3"} onChange={set("surge_max_multiplier")}
                min={1} max={10} suffix="×" />
            </div>
          )}

          {/* ===== FEATURES ===== */}
          {tab === "features" && (
            <div>
              <div className="row g-3 mb-4">
                {[
                  { key: "intercity_enabled", label: "Outstation Pool", icon: "bi-signpost-2-fill", color: "#1a73e8" },
                  { key: "car_sharing_enabled", label: "Local Pool", icon: "bi-people-fill", color: "#7c3aed" },
                  { key: "parcel_subscription_enabled", label: "Parcel Subscriptions", icon: "bi-box-seam-fill", color: "#16a34a" },
                  { key: "ride_subscription_enabled", label: "Ride Subscriptions", icon: "bi-car-front-fill", color: "#d97706" },
                  { key: "surge_pricing_enabled", label: "Surge Pricing", icon: "bi-lightning-charge-fill", color: "#dc2626" },
                  { key: "otp_pickup_enabled", label: "Pickup OTP", icon: "bi-shield-check-fill", color: "#0891b2" },
                  { key: "otp_drop_enabled", label: "Drop OTP", icon: "bi-shield-fill", color: "#0891b2" },
                  { key: "cash_enabled", label: "Cash Payments", icon: "bi-cash-coin", color: "#16a34a" },
                  { key: "wallet_enabled", label: "Wallet Payments", icon: "bi-wallet-fill", color: "#7c3aed" },
                ].map(item => {
                  const isOn = get(item.key) === "true";
                  return (
                    <div key={item.key} className="col-6 col-md-4">
                      <div style={{
                        borderRadius: 12, padding: "12px 14px",
                        background: isOn ? item.color + "10" : "#f8fafc",
                        border: `1.5px solid ${isOn ? item.color + "33" : "#e2e8f0"}`,
                      }}>
                        <div className="d-flex align-items-center justify-content-between mb-1">
                          <div className="d-flex align-items-center gap-2">
                            <i className={`bi ${item.icon}`} style={{ fontSize: 14, color: isOn ? item.color : "#94a3b8" }}></i>
                            <span style={{ fontSize: 12, fontWeight: 600, color: isOn ? "#0f172a" : "#64748b" }}>{item.label}</span>
                          </div>
                        </div>
                        <label className="switcher">
                          <input type="checkbox" className="switcher_input"
                            checked={isOn}
                            onChange={e => set(item.key)(e.target.checked ? "true" : "false")}
                            data-testid={`toggle-feature-${item.key}`} />
                          <span className="switcher_control"></span>
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ===== FIREBASE & SMS ===== */}
          {tab === "firebase" && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 12 }}>
                Firebase Push Notifications
              </div>

              <Field label="Firebase Server Key" id="firebase_server_key"
                desc="Found in Firebase Console → Project Settings → Cloud Messaging → Server key"
                value={get("firebase_server_key")} onChange={set("firebase_server_key")}
                type="password" placeholder="AAAAxxxxxxxx:APA91b..." />

              <Field label="Firebase Project ID" id="firebase_project_id"
                desc="Found in Firebase Console → Project Settings → General → Project ID"
                value={get("firebase_project_id")} onChange={set("firebase_project_id")}
                placeholder="jago-app-xxxxx" />

              <Field label="Firebase Service Account JSON" id="firebase_service_account"
                desc='Firebase Console → Project Settings → Service accounts → Generate new private key → JSON content paste cheyyi. Push notifications + phone auth ki required.'
                value={get("firebase_service_account")} onChange={set("firebase_service_account")}
                type="password" placeholder='{"type":"service_account","project_id":"..."}' />

              <div style={{ height: 24 }} />
              <div style={{ fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 12 }}>
                SMS Gateway
              </div>

              <div style={{ padding: "14px 0", borderBottom: "1px solid #f1f5f9" }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "#0f172a", marginBottom: 8 }}>SMS Provider</div>
                <div className="d-flex gap-2">
                  {["msg91", "twilio", "nexmo"].map(p => (
                    <button key={p}
                      onClick={() => set("sms_provider")(p)}
                      style={{
                        borderRadius: 8, fontSize: 12, fontWeight: 700,
                        background: get("sms_provider") === p ? "#1a73e8" : "#f8fafc",
                        color: get("sms_provider") === p ? "#fff" : "#64748b",
                        border: `1.5px solid ${get("sms_provider") === p ? "#1a73e8" : "#e2e8f0"}`,
                        padding: "7px 18px", cursor: "pointer",
                      }}
                      data-testid={`btn-sms-${p}`}>
                      {p.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <Field label="SMS API Key" id="sms_api_key"
                desc={`API key for ${(get("sms_provider") || "MSG91").toUpperCase()} SMS gateway`}
                value={get("sms_api_key")} onChange={set("sms_api_key")}
                type="password" placeholder="Enter SMS API key" />

              <div className="mt-3 p-3 rounded-3" style={{ background: "#f0f9ff", border: "1px solid #bae6fd" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#0369a1", marginBottom: 4 }}>
                  <i className="bi bi-phone-fill me-1"></i>SMS is used for OTP delivery
                </div>
                <div style={{ fontSize: 11.5, color: "#0c4a6e" }}>
                  Make sure SMS gateway is configured before enabling OTP verification. Without it, customers won't receive OTP codes.
                </div>
              </div>
            </div>
          )}

          {/* ===== GOOGLE MAPS ===== */}
          {tab === "maps" && (
            <div>
              <div className="d-flex gap-3 mb-4 p-3 rounded-3" style={{ background: "#f5f3ff", border: "1px solid #c4b5fd" }}>
                <i className="bi bi-map-fill text-purple mt-1" style={{ fontSize: 18, color: "#7c3aed", flexShrink: 0 }}></i>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#4c1d95" }}>Google Maps API</div>
                  <div style={{ fontSize: 12, color: "#6d28d9" }}>Used for pickup/drop location selection, distance calculation, and routing in the Flutter app.</div>
                </div>
              </div>

              <Field label="Google Maps API Key" id="google_maps_key"
                desc="Enable Maps SDK for Android, iOS and Places API in Google Cloud Console"
                value={get("google_maps_key")} onChange={set("google_maps_key")}
                type="password" placeholder="AIzaSy..." />

              <div className="mt-3 p-3 rounded-3" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 }}>
                  <i className="bi bi-info-circle me-1"></i>Required APIs to enable in Google Cloud:
                </div>
                <div className="row g-2">
                  {["Maps SDK for Android", "Maps SDK for iOS", "Places API", "Directions API", "Distance Matrix API", "Geocoding API"].map(api => (
                    <div key={api} className="col-6 col-md-4">
                      <div style={{ fontSize: 11.5, color: "#64748b", display: "flex", alignItems: "center", gap: 6 }}>
                        <i className="bi bi-check-circle-fill text-success" style={{ fontSize: 10 }}></i>
                        {api}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ===== CLAUDE AI ===== */}
          {tab === "ai" && (
            <div>
              <div className="d-flex gap-3 mb-4 p-3 rounded-3" style={{ background: "linear-gradient(135deg,#f5f3ff,#ede9fe)", border: "1.5px solid #c4b5fd" }}>
                <i className="bi bi-stars mt-1" style={{ fontSize: 22, color: "#7c3aed", flexShrink: 0 }}></i>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#4c1d95" }}>Claude AI — Voice Booking Intelligence</div>
                  <div style={{ fontSize: 12, color: "#6d28d9", marginTop: 3 }}>
                    Users voice lo ride/parcel book cheyagalaru — Telugu, Hindi, English anni support avutundi.
                    API Key paste chesthe immediately activate avutundi. Cost: ~₹0.001 per voice request.
                  </div>
                </div>
              </div>

              <Field label="Anthropic API Key" id="anthropic_api_key"
                desc='console.anthropic.com → API Keys → Create Key. Format: sk-ant-api03-...'
                value={get("anthropic_api_key")} onChange={set("anthropic_api_key")}
                type="password" placeholder="sk-ant-api03-..." />

              <div className="mt-3 p-3 rounded-3" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 8 }}>
                  <i className="bi bi-info-circle me-1"></i>Voice commands supported:
                </div>
                <div className="row g-2">
                  {[
                    '"Book a bike from JNTU to Hitech City"',
                    '"JNTU nundi Hitech City ki bike kavali"',
                    '"Auto bulao JNTU se Hitech City"',
                    '"Send parcel from Kukatpally to Miyapur"',
                    '"Parcel pampinchu Ameerpet ki"',
                    '"Cancel my ride"',
                  ].map(ex => (
                    <div key={ex} className="col-12 col-md-6">
                      <div style={{ fontSize: 11.5, color: "#64748b", display: "flex", alignItems: "flex-start", gap: 6 }}>
                        <i className="bi bi-mic-fill mt-1" style={{ fontSize: 10, color: "#7c3aed", flexShrink: 0 }}></i>
                        <span style={{ fontStyle: "italic" }}>{ex}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-3 p-3 rounded-3 d-flex gap-2 align-items-start" style={{ background: "#fefce8", border: "1px solid #fde68a" }}>
                <i className="bi bi-lightning-charge-fill mt-1" style={{ color: "#d97706", flexShrink: 0 }}></i>
                <div style={{ fontSize: 12, color: "#92400e" }}>
                  Key save chesaaka server automatically Claude AI use chestundi. No restart needed.
                  Key lekapothe regex fallback use avutundi (English basic patterns only).
                </div>
              </div>
            </div>
          )}

          {/* ===== RUNTIME CONTROL ===== */}
          {tab === "runtime" && (
            <div>
              <div className="mb-4 p-3 rounded-3" style={{ background: "linear-gradient(135deg,#eff6ff,#f8fbff)", border: "1.5px solid #bfdbfe" }}>
                <div className="d-flex align-items-center justify-content-between flex-wrap gap-3">
                  <div>
                    <div className="d-flex align-items-center gap-2 mb-1">
                      <i className="bi bi-sliders2-vertical" style={{ fontSize: 18, color: "#2563eb" }}></i>
                      <span style={{ fontWeight: 700, fontSize: 14, color: "#1d4ed8" }}>Runtime Governance Console</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>
                      Scope-safe live overrides with audit visibility, rollback actions, and config precedence awareness.
                    </div>
                  </div>
                  <div className="d-flex align-items-center gap-2 flex-wrap">
                    <span className="badge" style={{ background: "#dbeafe", color: "#1d4ed8", fontSize: 11, padding: "6px 10px" }}>
                      version {runtimeSnapshot?.version || "loading"}
                    </span>
                    <span className="badge" style={{ background: "#eff6ff", color: "#1e40af", fontSize: 11, padding: "6px 10px" }}>
                      realtime &gt; city &gt; service &gt; vehicle &gt; global
                    </span>
                  </div>
                </div>
              </div>

              <div className="row g-4 mb-4">
                <div className="col-12 col-xl-4">
                  <div className="card border-0 h-100" style={{ borderRadius: 14, background: "#f8fbff", border: "1px solid #dbeafe" }}>
                    <div className="card-body p-4">
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 14 }}>Scope Selector</div>
                      <div className="mb-3">
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", marginBottom: 6 }}>Override Scope</div>
                        <select className="admin-form-control" value={runtimeScopeType} onChange={e => { setRuntimeScopeType(e.target.value); setRuntimeDraft({}); }} data-testid="runtime-scope-type">
                          <option value="global">Global</option>
                          <option value="city">City</option>
                          <option value="service">Service</option>
                          <option value="vehicle">Vehicle</option>
                        </select>
                      </div>
                      <div className="mb-3">
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", marginBottom: 6 }}>Scope Key</div>
                        <input
                          className="admin-form-control"
                          value={runtimeScopeType === "global" ? "default" : runtimeScopeKey}
                          onChange={e => setRuntimeScopeKey(e.target.value)}
                          disabled={runtimeScopeType === "global"}
                          placeholder={runtimeScopeType === "city" ? "vijayawada" : runtimeScopeType === "service" ? "parcel" : runtimeScopeType === "vehicle" ? "bike_parcel" : "default"}
                          data-testid="runtime-scope-key"
                        />
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", marginBottom: 6 }}>Change Reason</div>
                        <textarea
                          className="admin-form-control"
                          rows={3}
                          value={runtimeReason}
                          onChange={e => setRuntimeReason(e.target.value)}
                          placeholder="Reason for this live production change"
                          data-testid="runtime-reason"
                        />
                      </div>
                    </div>
                  </div>
                </div>
                <div className="col-12 col-xl-8">
                  <div className="card border-0 h-100" style={{ borderRadius: 14 }}>
                    <div className="card-body p-4">
                      <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px" }}>Live Overrides</div>
                          <div style={{ fontSize: 12, color: "#94a3b8" }}>Changes publish through runtime cache invalidation and realtime socket propagation.</div>
                        </div>
                        {runtimeSnapshotLoading && <span className="text-muted small">Loading runtime snapshotâ€¦</span>}
                      </div>
                      <div className="row g-3">
                        <div className="col-12 col-md-6">
                          <Toggle label="Rides Enabled" id="runtime_rides_enabled" desc="Booking and dispatch for ride services" value={runtimeGet("rides_enabled", true)} onChange={setRuntime("rides_enabled")} />
                          <Toggle label="Parcel Enabled" id="runtime_parcel_enabled" desc="Parcel visibility, booking and dispatch" value={runtimeGet("parcel_enabled", true)} onChange={setRuntime("parcel_enabled")} />
                          <Toggle label="Pool Enabled" id="runtime_pool_enabled" desc="Local pool and outstation pool flows" value={runtimeGet("pool_enabled", true)} onChange={setRuntime("pool_enabled")} />
                          <Toggle label="Subscriptions Enabled" id="runtime_subscriptions_enabled" desc="Subscription plan access and validation" value={runtimeGet("subscriptions_enabled", true)} onChange={setRuntime("subscriptions_enabled")} />
                        </div>
                        <div className="col-12 col-md-6">
                          <Field label="Commission Rate" id="runtime_commission_rate" desc="Platform commission percentage for this scope" value={runtimeGet("commission_rate", "")} onChange={setRuntime("commission_rate")} type="number" placeholder="18" suffix="%" />
                          <Field label="Surge Multiplier" id="runtime_surge_multiplier" desc="Realtime pricing pressure multiplier" value={runtimeGet("surge_multiplier", "")} onChange={setRuntime("surge_multiplier")} type="number" placeholder="1.2" suffix="x" />
                          <Field label="Ride Radius" id="runtime_max_ride_radius_km" desc="Maximum driver discovery radius" value={runtimeGet("max_ride_radius_km", "")} onChange={setRuntime("max_ride_radius_km")} type="number" placeholder="6" suffix="km" />
                          <Toggle label="Force Update" id="runtime_force_update" desc="Force app update prompt after next config refresh" value={runtimeGet("force_update", false)} onChange={setRuntime("force_update")} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="row g-4">
                <div className="col-12 col-xl-6">
                  <div className="card border-0 h-100" style={{ borderRadius: 14 }}>
                    <div className="card-body p-4">
                      <div className="d-flex align-items-center justify-content-between mb-3">
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px" }}>Resolved Snapshot Preview</div>
                          <div style={{ fontSize: 12, color: "#94a3b8" }}>Current effective values before publish.</div>
                        </div>
                        <span className="badge" style={{ background: "#f8fafc", color: "#475569", fontSize: 11, padding: "6px 10px" }}>
                          {runtimeScopeType}:{runtimeScopeType === "global" ? "default" : (runtimeScopeKey || "unset")}
                        </span>
                      </div>
                      <div className="table-responsive">
                        <table className="table align-middle mb-0">
                          <thead>
                            <tr>
                              <th>Key</th>
                              <th>Current</th>
                              <th>Draft</th>
                            </tr>
                          </thead>
                          <tbody>
                            {["rides_enabled","parcel_enabled","pool_enabled","subscriptions_enabled","commission_rate","surge_multiplier","max_ride_radius_km","force_update"].map((key) => (
                              <tr key={key}>
                                <td style={{ fontSize: 12.5, fontWeight: 600, color: "#334155" }}>{key}</td>
                                <td style={{ fontSize: 12.5, color: "#64748b" }}>{String(resolvedRuntimeConfig?.[key] ?? "-")}</td>
                                <td style={{ fontSize: 12.5, color: runtimeDraft[key] !== undefined ? "#1d4ed8" : "#94a3b8", fontWeight: runtimeDraft[key] !== undefined ? 700 : 500 }}>
                                  {runtimeDraft[key] !== undefined ? String(runtimeDraft[key]) : "No change"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="col-12 col-xl-6">
                  <div className="card border-0 h-100" style={{ borderRadius: 14 }}>
                    <div className="card-body p-4">
                      <div className="d-flex align-items-center justify-content-between mb-3">
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px" }}>Rollback & Audit Timeline</div>
                          <div style={{ fontSize: 12, color: "#94a3b8" }}>Latest mutations with rollback access.</div>
                        </div>
                        {runtimeAuditLoading && <span className="text-muted small">Loading auditâ€¦</span>}
                      </div>
                      <div className="d-flex flex-column gap-2">
                        {runtimeAudit.slice(0, 8).map((log: any) => (
                          <div key={log.id} className="d-flex align-items-start justify-content-between gap-3 p-3 rounded-3" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#0f172a" }}>{log.scopeType}:{log.scopeKey} â†’ {log.configKey}</div>
                              <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 2 }}>{log.updatedBy || "admin"} â€¢ {new Date(log.createdAt).toLocaleString()}</div>
                              <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 4, wordBreak: "break-word" }}>
                                {JSON.stringify(log.previousValue)} â†’ {JSON.stringify(log.nextValue)}
                              </div>
                            </div>
                            <button className="btn btn-sm btn-outline-secondary" onClick={() => rollbackRuntime.mutate(log.id)} disabled={rollbackRuntime.isPending} data-testid={`runtime-rollback-${log.id}`}>
                              Rollback
                            </button>
                          </div>
                        ))}
                        {!runtimeAudit.length && !runtimeAuditLoading && (
                          <div className="text-muted small">No runtime audit history yet.</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ===== DISPATCH SETTINGS ===== */}
          {tab === "dispatch" && (
            <div>
              <div className="mb-4 p-3 rounded-3" style={{ background: "linear-gradient(135deg,#ecfeff,#f0f9ff)", border: "1.5px solid #bae6fd" }}>
                <div className="d-flex align-items-center gap-2 mb-1">
                  <i className="bi bi-broadcast text-info" style={{ fontSize: 18 }}></i>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "#0891b2" }}>Auto Dispatch Engine</span>
                </div>
                <div style={{ fontSize: 12, color: "#64748b" }}>Controls how ride requests are assigned to drivers — acceptance timer, smart matching, auto-cancel logic</div>
              </div>

              <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>Driver Acceptance</div>

              <Field label="Acceptance Timeout (seconds)" id="acceptance_timeout_sec"
                desc="Time given to a driver to accept a ride before it moves to the next driver. Recommended: 30 seconds"
                value={get("acceptance_timeout_sec") || "30"} onChange={set("acceptance_timeout_sec")}
                type="number" placeholder="30" suffix="sec" />

              <Field label="Max Drivers to Notify" id="max_drivers_to_notify"
                desc="Maximum number of drivers to simultaneously broadcast a ride request to"
                value={get("max_drivers_to_notify") || "5"} onChange={set("max_drivers_to_notify")}
                type="number" placeholder="5" suffix="drivers" />

              <Field label="Driver Broadcast Radius (km)" id="broadcast_radius_km"
                desc="How far from pickup to search for available drivers"
                value={get("broadcast_radius_km") || "5"} onChange={set("broadcast_radius_km")}
                type="number" placeholder="5" suffix="km" />

              <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8, marginTop: 20 }}>Smart Assignment Logic</div>

              <Toggle label="First Accept Wins" id="first_accept_wins"
                desc="When multiple drivers receive the same request, only the first to accept gets the ride. Others are notified automatically."
                value={get("first_accept_wins") || "true"} onChange={set("first_accept_wins")} />

              <Toggle label="Auto-Assign on Driver Cancel" id="auto_assign_on_cancel"
                desc="If a driver cancels after accepting, automatically assign the next available driver without customer intervention"
                value={get("auto_assign_on_cancel") || "true"} onChange={set("auto_assign_on_cancel")} />

              <Toggle label="Sequential Dispatch Mode" id="sequential_dispatch"
                desc="Send request to one driver at a time in order of proximity. If rejected/timeout, moves to next driver automatically."
                value={get("sequential_dispatch") || "false"} onChange={set("sequential_dispatch")} />

              <Toggle label="Driver Group Broadcast" id="group_broadcast"
                desc="Broadcast ride to a group of nearby drivers simultaneously (like Rapido/Ola). All see it, first to tap gets it."
                value={get("group_broadcast") || "true"} onChange={set("group_broadcast")} />

              <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8, marginTop: 20 }}>Parcel & Helper</div>

              <Toggle label="Helper Booking Enabled" id="helper_booking_enabled"
                desc="Allow customers to request a loading/unloading helper along with vehicle booking"
                value={get("helper_booking_enabled") || "true"} onChange={set("helper_booking_enabled")} />

              <Field label="Helper Charge per Trip (₹)" id="helper_charge_per_trip"
                desc="Fixed charge added when customer requests a helper for loading/unloading"
                value={get("helper_charge_per_trip") || "100"} onChange={set("helper_charge_per_trip")}
                type="number" placeholder="100" suffix="₹" />

              <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8, marginTop: 20 }}>Intercity Dispatch</div>

              <Field label="Intercity Acceptance Timeout (seconds)" id="intercity_acceptance_timeout_sec"
                desc="Longer timeout for intercity bookings (customers plan ahead)"
                value={get("intercity_acceptance_timeout_sec") || "120"} onChange={set("intercity_acceptance_timeout_sec")}
                type="number" placeholder="120" suffix="sec" />

              <Toggle label="Intercity Driver Verification Required" id="intercity_driver_verification"
                desc="Only allow approved/verified drivers to accept intercity trips"
                value={get("intercity_driver_verification") || "true"} onChange={set("intercity_driver_verification")} />
            </div>
          )}

          {/* ===== SOUND ALERTS ===== */}
          {tab === "sound" && (
            <div>
              <div className="mb-4 p-3 rounded-3" style={{ background: "linear-gradient(135deg,#f5f3ff,#faf5ff)", border: "1.5px solid #ddd6fe" }}>
                <div className="d-flex align-items-center gap-2 mb-1">
                  <i className="bi bi-volume-up-fill text-purple" style={{ fontSize: 18, color: "#7c3aed" }}></i>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "#7c3aed" }}>Sound Alert Configuration</span>
                </div>
                <div style={{ fontSize: 12, color: "#64748b" }}>Configure alert sounds for driver app, customer app and admin dashboard. These settings sync to Flutter mobile apps.</div>
              </div>

              <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>Driver App Alerts</div>

              <Toggle label="New Ride Request Sound" id="sound_new_ride"
                desc="Play alert sound when a new ride request is dispatched to driver"
                value={get("sound_new_ride") || "true"} onChange={set("sound_new_ride")} />

              <Toggle label="New Parcel Request Sound" id="sound_new_parcel"
                desc="Play distinct alert sound for new parcel delivery requests"
                value={get("sound_new_parcel") || "true"} onChange={set("sound_new_parcel")} />

              <Toggle label="Intercity Request Sound" id="sound_intercity"
                desc="Play premium alert sound for intercity/outstation booking requests"
                value={get("sound_intercity") || "true"} onChange={set("sound_intercity")} />

              <Toggle label="Trip Completed Sound" id="sound_trip_complete"
                desc="Play confirmation sound when trip is completed and fare is settled"
                value={get("sound_trip_complete") || "true"} onChange={set("sound_trip_complete")} />

              <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8, marginTop: 20 }}>Customer App Alerts</div>

              <Toggle label="Driver Accepted Sound" id="sound_driver_accepted"
                desc="Notify customer with sound when driver accepts their booking"
                value={get("sound_driver_accepted") || "true"} onChange={set("sound_driver_accepted")} />

              <Toggle label="Driver Arriving Sound" id="sound_driver_arriving"
                desc="Play alert when driver is 2 minutes away from pickup"
                value={get("sound_driver_arriving") || "true"} onChange={set("sound_driver_arriving")} />

              <Toggle label="Trip Started Sound" id="sound_trip_started"
                desc="Play sound when driver starts the trip meter"
                value={get("sound_trip_started") || "false"} onChange={set("sound_trip_started")} />

              <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8, marginTop: 20 }}>Safety Alerts</div>

              <Toggle label="SOS Alert Sound" id="sound_sos"
                desc="HIGH PRIORITY — always play loud alert for SOS emergency triggers. Cannot be muted by driver."
                value={get("sound_sos") || "true"} onChange={set("sound_sos")} />

              <Toggle label="Accident Detection Alert" id="sound_accident"
                desc="Play alert if sudden motion/impact detected (requires phone accelerometer)"
                value={get("sound_accident") || "true"} onChange={set("sound_accident")} />

              <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8, marginTop: 20 }}>Sound Configuration</div>

              <div style={{ padding: "14px 0", borderBottom: "1px solid #f1f5f9" }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "#0f172a", marginBottom: 8 }}>Alert Sound Type</div>
                <div className="d-flex gap-2 flex-wrap">
                  {[
                    { val: "bell", label: "🔔 Bell", desc: "Classic bell" },
                    { val: "chime", label: "🎵 Chime", desc: "Soft chime" },
                    { val: "notification", label: "📳 Notification", desc: "Phone ping" },
                    { val: "horn", label: "📯 Horn", desc: "Loud horn" },
                  ].map(s => (
                    <div key={s.val}
                      onClick={() => set("sound_type")(s.val)}
                      style={{
                        padding: "10px 16px", borderRadius: 10, cursor: "pointer",
                        border: `2px solid ${get("sound_type") === s.val || (!get("sound_type") && s.val === "bell") ? "#7c3aed" : "#e2e8f0"}`,
                        background: get("sound_type") === s.val || (!get("sound_type") && s.val === "bell") ? "#f5f3ff" : "#fff",
                        textAlign: "center",
                      }}>
                      <div style={{ fontSize: 18 }}>{s.label.split(' ')[0]}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>{s.label.split(' ')[1]}</div>
                      <div style={{ fontSize: 10, color: "#94a3b8" }}>{s.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              <Field label="Alert Sound Repeat Count" id="sound_repeat_count"
                desc="Number of times to repeat the alert sound for incoming ride/parcel requests"
                value={get("sound_repeat_count") || "3"} onChange={set("sound_repeat_count")}
                type="number" placeholder="3" suffix="times" />

              <Toggle label="Vibration with Sound" id="sound_vibration"
                desc="Vibrate device alongside alert sound for better driver attention"
                value={get("sound_vibration") || "true"} onChange={set("sound_vibration")} />
            </div>
          )}

        </div>
      </div>

      {/* Bottom save bar */}
      {hasBusinessChanges && tab !== "runtime" && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, left: "auto", zIndex: 999,
          background: "#0f172a", borderRadius: 14, padding: "14px 20px",
          display: "flex", alignItems: "center", gap: 12,
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        }}>
          <div style={{ fontSize: 13, color: "#94a3b8" }}>
            <span style={{ color: "#fff", fontWeight: 700 }}>{Object.keys(local).length}</span> unsaved changes
          </div>
          <button className="btn btn-sm" style={{ background: "#475569", color: "#fff", borderRadius: 8, fontSize: 12, border: "none" }}
            onClick={() => setLocal({})}>Discard</button>
          <button className="btn btn-sm btn-primary" style={{ borderRadius: 8, fontSize: 12 }}
            onClick={() => save.mutate()} disabled={save.isPending}
            data-testid="btn-save-float">
            {save.isPending ? "Saving…" : "Save Changes"}
          </button>
        </div>
      )}
      {hasRuntimeChanges && tab === "runtime" && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, left: "auto", zIndex: 999,
          background: "#0f172a", borderRadius: 14, padding: "14px 20px",
          display: "flex", alignItems: "center", gap: 12,
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        }}>
          <div style={{ fontSize: 13, color: "#94a3b8" }}>
            <span style={{ color: "#fff", fontWeight: 700 }}>{Object.keys(runtimeDraft).length}</span> runtime changes
          </div>
          <button className="btn btn-sm" style={{ background: "#475569", color: "#fff", borderRadius: 8, fontSize: 12, border: "none" }}
            onClick={() => {
              setRuntimeDraft({});
              setRuntimeReason("");
            }}>Discard</button>
          <button className="btn btn-sm btn-primary" style={{ borderRadius: 8, fontSize: 12 }}
            onClick={() => saveRuntime.mutate()} disabled={saveRuntime.isPending}
            data-testid="btn-save-runtime-float">
            {saveRuntime.isPending ? "Publishingâ€¦" : "Publish Runtime"}
          </button>
        </div>
      )}
    </div>
  );
}
