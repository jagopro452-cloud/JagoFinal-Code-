import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { lazy, Suspense, useState, useEffect } from "react";

const DashboardRevenueChart = lazy(() => import("./dashboard-charts").then((m) => ({ default: m.DashboardRevenueChart })));
const DashboardTripDistributionChart = lazy(() => import("./dashboard-charts").then((m) => ({ default: m.DashboardTripDistributionChart })));

const avatarBg = (name: string) => {
  const colors = ["#2F7BFF","#16a34a","#d97706","#9333ea","#0891b2","#dc2626"];
  return colors[(name || "A").charCodeAt(0) % colors.length];
};
const initials = (name: string) => (name || "?").split(" ").map(n => n[0]).join("").substring(0, 2).toUpperCase();

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  completed: { cls: "badge bg-success", label: "Completed" },
  ongoing:   { cls: "badge bg-info", label: "Ongoing" },
  pending:   { cls: "badge bg-warning text-dark", label: "Pending" },
  cancelled: { cls: "badge bg-danger", label: "Cancelled" },
  accepted:  { cls: "badge bg-primary", label: "Accepted" },
};

const NOTIF_ICONS: Record<string, { icon: string; color: string; bg: string }> = {
  trip:     { icon: "bi-car-front-fill",    color: "#2F7BFF", bg: "#EBF4FF" },
  driver:   { icon: "bi-person-badge-fill", color: "#16a34a", bg: "#f0fdf4" },
  payment:  { icon: "bi-cash-stack",        color: "#d97706", bg: "#fefce8" },
  alert:    { icon: "bi-exclamation-triangle-fill", color: "#dc2626", bg: "#fef2f2" },
  user:     { icon: "bi-person-plus-fill",  color: "#7c3aed", bg: "#f5f3ff" },
  withdraw: { icon: "bi-wallet2",           color: "#0891b2", bg: "#ecfeff" },
};

/* ── Live Clock Widget ── */
function LiveClock() {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const h12 = time.getHours() % 12 || 12;
  const m = time.getMinutes().toString().padStart(2, "0");
  const s = time.getSeconds().toString().padStart(2, "0");
  const ampm = time.getHours() >= 12 ? "PM" : "AM";
  const date = time.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="jd-clock-widget">
      <div style={{ fontSize: 9.5, letterSpacing: 2.5, color: "rgba(255,255,255,0.45)", textTransform: "uppercase", marginBottom: 8, fontWeight: 600 }}>Local Time</div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 2 }}>
        <span style={{ fontSize: 36, fontWeight: 800, letterSpacing: 1, fontFamily: "'Inter', monospace", lineHeight: 1, color: "#fff" }}>
          {h12}:{m}
        </span>
        <span style={{ fontSize: 18, opacity: 0.5, fontWeight: 600, fontFamily: "'Inter', monospace" }}>:{s}</span>
        <span style={{ fontSize: 12, marginLeft: 6, fontWeight: 700, color: "rgba(147,197,253,0.8)" }}>{ampm}</span>
      </div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 8, fontWeight: 500 }}>{date}</div>
      <div style={{ display: "flex", justifyContent: "center", gap: 3, marginTop: 12 }}>
        {[0,1,2,3,4,5,6,7,8,9].map(i => (
          <div key={i} style={{
            width: 2.5,
            height: i % 3 === 0 ? 16 : i % 2 === 0 ? 10 : 6,
            background: `rgba(147,197,253,${0.15 + (i % 4) * 0.08})`,
            borderRadius: 2,
            transition: "height 0.3s ease",
          }} />
        ))}
      </div>
    </div>
  );
}

/* ── Stat Card ── */
function StatCard({ label, val, icon, color, bg, link, trend, trendUp, isLoading }: any) {
  return (
    <Link href={link}>
      <div className="jd-stat-card" data-testid={`stat-card-${label.toLowerCase().replace(/\s+/g,"-")}`} style={{ color }}>
        <div className="jd-stat-icon-wrap" style={{ background: bg }}>
          <i className={`bi ${icon}`} style={{ color, fontSize: "1.3rem" }}></i>
        </div>
        <div className="jd-stat-body">
          <div className="jd-stat-label">{label}</div>
          <div className="jd-stat-value" style={{ color }}>
            {isLoading ? <span className="jd-stat-skeleton"></span> : (val ?? 0).toLocaleString()}
          </div>
        </div>
        {trend && (
          <div className={`jd-stat-trend ${trendUp ? "jd-trend-up" : "jd-trend-down"}`}>
            <i className={`bi ${trendUp ? "bi-arrow-up-short" : "bi-arrow-down-short"}`}></i>
            {trend}
          </div>
        )}
        <div className="jd-stat-arrow"><i className="bi bi-chevron-right"></i></div>
      </div>
    </Link>
  );
}

/* ── Service Card ── */
function ServiceCard({ label, icon, color, bg, trips, revenue, model, modelColor, href, loaded }: any) {
  return (
    <Link href={href}>
      <div className="jd-svc-card" style={{ "--accent": color, "--accent-bg": bg } as any}>
        <div className="jd-svc-head">
          <div className="jd-svc-icon" style={{ background: bg }}>
            <i className={`bi ${icon}`} style={{ color, fontSize: 15 }}></i>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "#0f172a", lineHeight: 1.2 }}>{label}</div>
            <div style={{ fontSize: 10, color: modelColor ?? color, fontWeight: 600, textTransform: "capitalize", marginTop: 1 }}>{model}</div>
          </div>
        </div>
        <div className="jd-svc-stats">
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color, lineHeight: 1 }}>{loaded ? trips.toLocaleString() : "—"}</div>
            <div style={{ fontSize: 9.5, color: "#94a3b8", marginTop: 2, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Trips</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a", lineHeight: 1 }}>₹{loaded ? revenue.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : "—"}</div>
            <div style={{ fontSize: 9.5, color: "#94a3b8", marginTop: 2, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Revenue</div>
          </div>
        </div>
      </div>
    </Link>
  );
}

function ChartFallback({ height = 210 }: { height?: number }) {
  return <div className="h-100 d-flex align-items-center justify-content-center text-muted" style={{ height }}>Loading chart...</div>;
}

/* ── Section Header ── */
function SectionHeader({ title, badge, badgeColor }: { title: string; badge?: string; badgeColor?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, marginTop: 2 }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1.2 }}>{title}</span>
      {badge && (
        <span style={{
          fontSize: 10.5, background: `${badgeColor || "#dc2626"}10`, color: badgeColor || "#dc2626",
          border: `1px solid ${badgeColor || "#dc2626"}30`, borderRadius: 8, padding: "3px 10px", fontWeight: 700,
        }}>
          {badge}
        </span>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   DASHBOARD COMPONENT
   ═══════════════════════════════════════════════════════════════ */
export default function Dashboard() {
  const { data: stats, isLoading } = useQuery<any>({ queryKey: ["/api/dashboard/stats"] });
  const { data: svcData } = useQuery<any>({ queryKey: ["/api/admin/dashboard"], staleTime: 30_000 });
  const { data: chart = [] } = useQuery<any[]>({ queryKey: ["/api/dashboard/chart"] });
  const { data: notifs = [] } = useQuery<any[]>({ queryKey: ["/api/notifications"] });
  const { data: liveKpis } = useQuery<any>({ queryKey: ["/api/admin/live-kpis"], refetchInterval: 15_000 });

  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const adminName = (() => { try { return JSON.parse(localStorage.getItem("jago-admin") || "{}").name || "Admin"; } catch { return "Admin"; } })();
  const revenue = Number(stats?.totalRevenue || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  /* ── Top stat cards ── */
  const topStats = [
    { label: "Total Customers", val: stats?.totalCustomers, icon: "bi-people-fill", color: "#2F7BFF", bg: "#EBF4FF", link: "/admin/customers", trend: "+12%", trendUp: true },
    { label: "Total Drivers", val: stats?.totalDrivers, icon: "bi-person-badge-fill", color: "#16a34a", bg: "#f0fdf4", link: "/admin/drivers", trend: "+5%", trendUp: true },
    { label: "Total Revenue", val: `₹${revenue}`, icon: "bi-currency-rupee", color: "#b45309", bg: "#fefce8", link: "/admin/reports", trend: "+18%", trendUp: true },
    { label: "Total Trips", val: stats?.totalTrips, icon: "bi-car-front-fill", color: "#7e22ce", bg: "#f5f3ff", link: "/admin/trips", trend: "+8%", trendUp: true },
  ];

  /* ── Pie data ── */
  const pieData = [
    { name: "Completed", value: stats?.completedTrips || 0, color: "#10b981" },
    { name: "Ongoing",   value: stats?.ongoingTrips || 0,   color: "#2F7BFF" },
    { name: "Cancelled", value: stats?.cancelledTrips || 0, color: "#ef4444" },
    { name: "Other",     value: Math.max(0, (stats?.totalTrips || 0) - (stats?.completedTrips || 0) - (stats?.ongoingTrips || 0) - (stats?.cancelledTrips || 0)), color: "#cbd5e1" },
  ].filter(d => d.value > 0);

  /* ── Service cards ── */
  const svc = svcData?.services;
  const drv = svcData?.drivers;
  const services = [
    { label: "City Rides", icon: "bi-car-front-fill", color: "#2F7BFF", bg: "#eff6ff", trips: svc?.rides?.trips ?? 0, revenue: svc?.rides?.revenue ?? 0, model: svc?.rides?.model ?? "subscription", href: "/admin/trips" },
    { label: "Parcels", icon: "bi-box-seam-fill", color: "#16a34a", bg: "#f0fdf4", trips: svc?.parcels?.trips ?? 0, revenue: svc?.parcels?.revenue ?? 0, model: svc?.parcels?.model ?? "commission", href: "/admin/parcel-trips" },
    { label: "Intercity Carpool", icon: "bi-people-fill", color: "#7c3aed", bg: "#f5f3ff", trips: svc?.carpool?.trips ?? 0, revenue: svc?.carpool?.revenue ?? 0, model: svc?.carpool?.model ?? "commission", href: "/admin/intercity-carsharing" },
    { label: "Outstation Pool", icon: "bi-signpost-2-fill", color: "#d97706", bg: "#fefce8", trips: svc?.outstationPool?.bookings ?? 0, revenue: svc?.outstationPool?.revenue ?? 0, model: svc?.outstationPool?.mode === "on" ? "active" : "inactive", modelColor: svc?.outstationPool?.mode === "on" ? "#16a34a" : "#94a3b8", href: "/admin/outstation-pool" },
  ];
  const pendingComm = drv?.totalPendingCommission ?? 0;

  /* ── Quick links ── */
  const quickLinks = [
    { label: "All Trips", icon: "bi-car-front", href: "/admin/trips", color: "#2F7BFF" },
    { label: "Drivers", icon: "bi-person-badge", href: "/admin/drivers", color: "#16a34a" },
    { label: "Withdrawals", icon: "bi-cash-coin", href: "/admin/withdrawals", color: "#d97706" },
    { label: "Reports", icon: "bi-graph-up", href: "/admin/reports", color: "#7c3aed" },
    { label: "Customer APK", icon: "bi-android2", href: "/apks/jago-customer-latest.apk", color: "#16a34a", external: true },
    { label: "Driver APK", icon: "bi-android2", href: "/apks/jago-driver-latest.apk", color: "#0891b2", external: true },
  ];

  const recentNotifs = Array.isArray(notifs) ? notifs.slice(0, 12) : [];

  const timeAgo = (d: string) => {
    const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return `${Math.floor(s/86400)}d ago`;
  };

  /* ── Quick stats mini ── */
  const quickStatsMini = [
    { label: "Completed", val: stats?.completedTrips ?? 0, color: "#10b981", bg: "#f0fdf4", icon: "bi-check-circle-fill" },
    { label: "Ongoing", val: stats?.ongoingTrips ?? 0, color: "#2F7BFF", bg: "#eff6ff", icon: "bi-broadcast-pin" },
    { label: "Cancelled", val: stats?.cancelledTrips ?? 0, color: "#ef4444", bg: "#fef2f2", icon: "bi-x-circle-fill" },
    { label: "Withdrawals", val: stats?.pendingWithdrawals ?? 0, color: "#f59e0b", bg: "#fefce8", icon: "bi-clock-history" },
    { label: "Reviews", val: stats?.totalReviews ?? 0, color: "#f59e0b", bg: "#fffbeb", icon: "bi-star-fill" },
    { label: "Zones", val: stats?.totalZones ?? 0, color: "#7c3aed", bg: "#f5f3ff", icon: "bi-map-fill" },
  ];

  /* ── Live KPI items ── */
  const liveKpiItems = liveKpis ? [
    { label: "Searching", val: liveKpis.live?.searching ?? 0, icon: "bi-search", color: "#f59e0b", bg: "#fffbeb" },
    { label: "Dispatching", val: liveKpis.live?.dispatching ?? 0, icon: "bi-lightning-charge-fill", color: "#2563eb", bg: "#eff6ff" },
    { label: "In Progress", val: liveKpis.live?.inProgress ?? 0, icon: "bi-car-front-fill", color: "#16a34a", bg: "#f0fdf4" },
    { label: "Done (1h)", val: liveKpis.live?.completedLastHour ?? 0, icon: "bi-check-circle-fill", color: "#0891b2", bg: "#ecfeff" },
    { label: "Cancelled (1h)", val: liveKpis.live?.cancelledLastHour ?? 0, icon: "bi-x-circle-fill", color: "#dc2626", bg: "#fef2f2" },
    { label: "Avg Wait", val: `${liveKpis.live?.avgPickupWaitMin ?? 0}m`, icon: "bi-clock-fill", color: "#7c3aed", bg: "#f5f3ff" },
    { label: "Ghost Pilots", val: liveKpis.quality?.ghostDriverCount ?? 0, icon: "bi-wifi-off", color: "#6b7280", bg: "#f9fafb" },
    { label: "Surge Zones", val: liveKpis.surge?.activeSurgeZones?.length ?? 0, icon: "bi-arrow-up-circle-fill", color: "#ea580c", bg: "#fff7ed" },
  ] : [];

  return (
    <div className="container-fluid admin-dashboard-page">
      <style>{`
        .admin-dashboard-page .jd-banner {
          position: relative;
          overflow: hidden;
          background:
            radial-gradient(circle at top right, rgba(147,197,253,0.22), transparent 24%),
            linear-gradient(135deg, #0f2f70 0%, #1e4fa8 48%, #2f7bff 100%);
          border: 1px solid rgba(96,165,250,0.2);
          border-radius: 26px;
          box-shadow: 0 24px 60px rgba(30,79,168,0.18);
        }
        .admin-dashboard-page .jd-banner::after {
          content: "";
          position: absolute;
          inset: auto -80px -80px auto;
          width: 220px;
          height: 220px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(255,255,255,0.16), transparent 68%);
          pointer-events: none;
        }
        .admin-dashboard-page .jd-banner-inner {
          padding: 24px 24px 14px;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 18px;
        }
        .admin-dashboard-page .jd-banner-kpis {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 0;
          border-top: 1px solid rgba(255,255,255,0.12);
          margin-top: 6px;
        }
        .admin-dashboard-page .jd-kpi {
          padding: 16px 18px 18px;
        }
        .admin-dashboard-page .jd-kpi-sep {
          width: 1px;
          background: rgba(255,255,255,0.1);
          align-self: stretch;
        }
        .admin-dashboard-page .jd-kpi-n {
          display: block;
          font-size: 1.25rem;
          font-weight: 800;
          color: #fff;
          letter-spacing: -0.03em;
        }
        .admin-dashboard-page .jd-kpi-l {
          display: block;
          margin-top: 4px;
          font-size: 11px;
          color: rgba(255,255,255,0.68);
          text-transform: uppercase;
          letter-spacing: 1px;
          font-weight: 700;
        }
        .admin-dashboard-page .jd-date-badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: rgba(255,255,255,0.12);
          border: 1px solid rgba(255,255,255,0.14);
          color: #e0ecff;
          padding: 10px 14px;
          border-radius: 14px;
          font-size: 12px;
          font-weight: 700;
          backdrop-filter: blur(10px);
        }
        .admin-dashboard-page .jd-card,
        .admin-dashboard-page .jd-clock-widget,
        .admin-dashboard-page .jd-stat-card,
        .admin-dashboard-page .jd-svc-card {
          border-radius: 22px;
        }
        .admin-dashboard-page .jd-card {
          background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.98));
          border: 1px solid rgba(226,232,240,0.9);
          box-shadow: 0 16px 40px rgba(15,23,42,0.06);
          overflow: hidden;
        }
        .admin-dashboard-page .jd-card-header {
          padding: 18px 18px 14px;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
        }
        .admin-dashboard-page .jd-card-title {
          margin: 0;
          font-size: 15px;
          font-weight: 800;
          color: #0f172a;
          letter-spacing: -0.02em;
        }
        .admin-dashboard-page .jd-card-subtitle {
          margin-top: 4px;
          color: #64748b;
          font-size: 11.5px;
          font-weight: 500;
        }
        .admin-dashboard-page .jd-stat-card {
          position: relative;
          overflow: hidden;
          min-height: 132px;
          background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.98));
          border: 1px solid rgba(226,232,240,0.9);
          box-shadow: 0 16px 34px rgba(15,23,42,0.06);
          padding: 18px 18px 16px;
          display: flex;
          gap: 14px;
          align-items: flex-start;
          text-decoration: none;
        }
        .admin-dashboard-page .jd-stat-card::after {
          content: "";
          position: absolute;
          inset: auto -32px -42px auto;
          width: 110px;
          height: 110px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(59,130,246,0.08), transparent 70%);
        }
        .admin-dashboard-page .jd-stat-icon-wrap {
          width: 52px;
          height: 52px;
          border-radius: 16px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.45);
        }
        .admin-dashboard-page .jd-stat-label {
          color: #64748b;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 1px;
          text-transform: uppercase;
          margin-bottom: 8px;
        }
        .admin-dashboard-page .jd-stat-value {
          font-size: 1.55rem;
          font-weight: 800;
          line-height: 1.1;
          letter-spacing: -0.04em;
          color: #0f172a;
        }
        .admin-dashboard-page .jd-stat-trend {
          position: absolute;
          right: 16px;
          top: 16px;
          display: inline-flex;
          align-items: center;
          gap: 2px;
          padding: 5px 8px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 700;
        }
        .admin-dashboard-page .jd-trend-up {
          background: rgba(22,163,74,0.1);
          color: #15803d;
        }
        .admin-dashboard-page .jd-trend-down {
          background: rgba(239,68,68,0.1);
          color: #dc2626;
        }
        .admin-dashboard-page .jd-stat-arrow {
          margin-left: auto;
          align-self: center;
          color: rgba(100,116,139,0.45);
          font-size: 13px;
        }
        .admin-dashboard-page .jd-svc-card {
          min-height: 138px;
          background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(249,250,251,0.98));
          border: 1px solid rgba(226,232,240,0.88);
          box-shadow: 0 14px 34px rgba(15,23,42,0.05);
          padding: 16px;
        }
        .admin-dashboard-page .jd-svc-head {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 18px;
        }
        .admin-dashboard-page .jd-svc-icon {
          width: 42px;
          height: 42px;
          border-radius: 14px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .admin-dashboard-page .jd-svc-stats {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 14px;
        }
        .admin-dashboard-page .jd-clock-widget {
          background:
            radial-gradient(circle at top right, rgba(147,197,253,0.18), transparent 24%),
            linear-gradient(145deg, #091a3b 0%, #102b66 46%, #173d88 100%);
          color: white;
          padding: 22px 20px;
          border: 1px solid rgba(96,165,250,0.18);
          box-shadow: 0 24px 60px rgba(15,23,42,0.22);
          margin-bottom: 16px;
        }
        .admin-dashboard-page .jd-kpi-mini-card,
        .admin-dashboard-page .jd-quick-stat,
        .admin-dashboard-page .jd-quick-action,
        .admin-dashboard-page .jd-info-pill {
          border-radius: 16px;
        }
        .admin-dashboard-page .jd-kpi-mini-card,
        .admin-dashboard-page .jd-quick-stat {
          border: 1px solid rgba(226,232,240,0.9);
          padding: 13px 14px;
          display: flex;
          gap: 12px;
          align-items: center;
        }
        .admin-dashboard-page .jd-quick-action {
          background: #fff;
          border: 1px solid rgba(226,232,240,0.9);
          box-shadow: 0 12px 28px rgba(15,23,42,0.04);
          padding: 12px 13px;
          display: flex;
          align-items: center;
          gap: 10px;
          transition: transform .16s ease, box-shadow .16s ease;
          min-height: 66px;
        }
        .admin-dashboard-page .jd-quick-action:hover {
          transform: translateY(-1px);
          box-shadow: 0 16px 30px rgba(15,23,42,0.08);
        }
        .admin-dashboard-page .jd-quick-action-icon {
          width: 36px;
          height: 36px;
          border-radius: 12px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .admin-dashboard-page .jd-table-head th {
          font-size: 10.5px;
          font-weight: 800;
          color: #94a3b8;
          text-transform: uppercase;
          letter-spacing: 1px;
          padding-top: 14px;
          padding-bottom: 14px;
          border-bottom: 1px solid #eef2f7;
          background: #f8fbff;
        }
        .admin-dashboard-page .jd-mini-avatar {
          width: 30px;
          height: 30px;
          border-radius: 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-size: 11px;
          font-weight: 800;
          flex-shrink: 0;
        }
        .admin-dashboard-page .jd-type-badge,
        .admin-dashboard-page .jd-live-badge,
        .admin-dashboard-page .jd-info-pill,
        .admin-dashboard-page .jd-view-all-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .admin-dashboard-page .jd-type-badge {
          border-radius: 999px;
          padding: 4px 8px;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: .8px;
        }
        .admin-dashboard-page .jd-live-badge,
        .admin-dashboard-page .jd-info-pill,
        .admin-dashboard-page .jd-view-all-btn {
          font-size: 11px;
          font-weight: 700;
        }
        .admin-dashboard-page .jd-live-badge {
          color: #166534;
          background: #f0fdf4;
          border: 1px solid #bbf7d0;
          border-radius: 999px;
          padding: 6px 10px;
        }
        .admin-dashboard-page .jd-live-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #16a34a;
          box-shadow: 0 0 0 4px rgba(22,163,74,0.12);
        }
        .admin-dashboard-page .jd-info-pill {
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid transparent;
        }
        .admin-dashboard-page .jd-view-all-btn {
          color: #1e40af;
          background: rgba(59,130,246,0.08);
          border: 1px solid rgba(147,197,253,0.55);
          border-radius: 999px;
          padding: 7px 11px;
          text-decoration: none;
        }
        .admin-dashboard-page .jd-empty-chart,
        .admin-dashboard-page .jd-empty-table {
          min-height: 210px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-direction: column;
          text-align: center;
        }
        .admin-dashboard-page .jd-empty-icon {
          width: 68px;
          height: 68px;
          border-radius: 22px;
          background: linear-gradient(180deg, #eff6ff, #f8fbff);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 14px;
        }
        .admin-dashboard-page .jd-notif-item {
          padding: 14px 18px;
          display: flex;
          gap: 12px;
          align-items: flex-start;
        }
        .admin-dashboard-page .jd-notif-icon {
          width: 36px;
          height: 36px;
          border-radius: 12px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .admin-dashboard-page .jd-skeleton,
        .admin-dashboard-page .jd-stat-skeleton {
          display: inline-block;
          background: linear-gradient(90deg, #eef2f7 0%, #f8fafc 50%, #eef2f7 100%);
          background-size: 200% 100%;
          animation: jdPulse 1.4s linear infinite;
          border-radius: 999px;
        }
        .admin-dashboard-page .jd-stat-skeleton {
          width: 110px;
          height: 26px;
        }
        @keyframes jdPulse {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @media (max-width: 1199px) {
          .admin-dashboard-page .jd-banner-kpis {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .admin-dashboard-page .jd-kpi-sep:nth-child(2),
          .admin-dashboard-page .jd-kpi-sep:nth-child(6) {
            display: none;
          }
        }
        @media (max-width: 767px) {
          .admin-dashboard-page .jd-banner-inner {
            flex-direction: column;
            align-items: flex-start;
          }
          .admin-dashboard-page .jd-banner-kpis {
            grid-template-columns: 1fr;
          }
          .admin-dashboard-page .jd-kpi-sep {
            display: none;
          }
        }
      `}</style>

      {/* ═══════════ BANNER ═══════════ */}
      <div className="jd-banner mb-3" data-testid="dashboard-banner">
        <div className="jd-banner-inner">
          <div className="d-flex align-items-center gap-3">
            <div className="jd-avatar">
              <span style={{ fontSize: "1.5rem" }}>👋</span>
            </div>
            <div>
              <h3 className="mb-1" style={{ fontSize: "1.25rem", fontWeight: 700 }}>{greeting}, {adminName}!</h3>
              <p className="mb-0" style={{ fontSize: 13 }}>Here's your platform overview for today</p>
            </div>
          </div>
          <div className="d-flex align-items-center gap-2">
            <div className="jd-date-badge">
              <i className="bi bi-calendar3" style={{ fontSize: 12 }}></i>
              <span>{today}</span>
            </div>
          </div>
        </div>
        <div className="jd-banner-kpis">
          <div className="jd-kpi">
            <span className="jd-kpi-n">{liveKpis?.live?.inProgress ?? stats?.ongoingTrips ?? "—"}</span>
            <span className="jd-kpi-l">Live Trips</span>
          </div>
          <div className="jd-kpi-sep"></div>
          <div className="jd-kpi">
            <span className="jd-kpi-n">{svcData?.drivers?.online ?? Math.round((stats?.totalDrivers ?? 0) * 0.7)}</span>
            <span className="jd-kpi-l">Online Pilots</span>
          </div>
          <div className="jd-kpi-sep"></div>
          <div className="jd-kpi">
            <span className="jd-kpi-n">₹{Number(stats?.totalRevenue ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
            <span className="jd-kpi-l">Total Revenue</span>
          </div>
          <div className="jd-kpi-sep"></div>
          <div className="jd-kpi">
            <span className="jd-kpi-n">{stats?.totalZones ?? "—"}</span>
            <span className="jd-kpi-l">Active Zones</span>
          </div>
        </div>
      </div>

      {/* ═══════════ TWO-COLUMN LAYOUT ═══════════ */}
      <div className="row g-3">

        {/* ────── LEFT: Main Content ────── */}
        <div className="col-xl-8 col-lg-8">

          {/* 4 Stat Cards */}
          <div className="row g-3 mb-3">
            {topStats.map((s, i) => (
              <div key={i} className="col-xl-6 col-sm-6">
                <StatCard {...s} isLoading={isLoading} />
              </div>
            ))}
          </div>

          {/* Services Overview */}
          <SectionHeader
            title="Services Overview"
            badge={pendingComm > 0 ? `₹${pendingComm.toLocaleString("en-IN", { maximumFractionDigits: 0 })} pending commission` : undefined}
            badgeColor="#dc2626"
          />
          <div className="row g-3 mb-3">
            {services.map((s, i) => (
              <div key={i} className="col-xl-3 col-sm-6">
                <ServiceCard {...s} loaded={!!svcData} />
              </div>
            ))}
          </div>

          {/* Live Operations KPIs */}
          {liveKpis && (
            <div className="mb-3">
              <div className="mb-2 d-flex align-items-center justify-content-between">
                <span style={{ fontSize: 10.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1.2 }}>
                  Live Operations
                </span>
                <span className="jd-live-badge">
                  <span className="jd-live-dot"></span>
                  Live · refreshes every 15s
                </span>
              </div>
              <div className="row g-2">
                {liveKpiItems.map((k, i) => (
                  <div key={i} className="col-xl-3 col-sm-6 col-6">
                    <div className="jd-kpi-mini-card" style={{ background: k.bg, borderColor: `${k.color}20` }}>
                      <div className="jd-kpi-mini-icon" style={{ background: `${k.color}15` }}>
                        <i className={`bi ${k.icon}`} style={{ color: k.color, fontSize: 13 }}></i>
                      </div>
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: k.color, lineHeight: 1.1 }}>{k.val}</div>
                        <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>{k.label}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Cancellation & Surge badges */}
              {(liveKpis.cancellations?.penaltyCollectedToday > 0 || liveKpis.cancellations?.totalToday > 0) && (
                <div className="mt-2 d-flex gap-2 flex-wrap">
                  <span className="jd-info-pill" style={{ background: "#fef2f2", color: "#dc2626", borderColor: "#fecaca" }}>
                    {liveKpis.cancellations?.driverCancelsToday ?? 0} driver cancels today
                  </span>
                  <span className="jd-info-pill" style={{ background: "#fff7ed", color: "#ea580c", borderColor: "#fed7aa" }}>
                    {liveKpis.cancellations?.customerCancelsToday ?? 0} customer cancels today
                  </span>
                  {liveKpis.cancellations?.penaltyCollectedToday > 0 && (
                    <span className="jd-info-pill" style={{ background: "#f0fdf4", color: "#16a34a", borderColor: "#bbf7d0" }}>
                      ₹{liveKpis.cancellations?.penaltyCollectedToday} penalty collected
                    </span>
                  )}
                  {liveKpis.surge?.activeSurgeZones?.length > 0 && (
                    <span className="jd-info-pill" style={{ background: "#fff7ed", color: "#ea580c", borderColor: "#fed7aa" }}>
                      Surge: {liveKpis.surge.activeSurgeZones.map((z: any) => `${z.name} ${z.factor}x`).join(", ")}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Charts Row ── */}
          <div className="row g-3 mb-3">
            {/* Area Chart */}
            <div className="col-lg-7">
              <div className="jd-card h-100">
                <div className="jd-card-header">
                  <div>
                    <h6 className="jd-card-title">Weekly Revenue Trend</h6>
                    <div className="jd-card-subtitle">Revenue & trips over the last 7 days</div>
                  </div>
                  <div className="d-flex gap-3 small">
                    <span className="d-flex align-items-center gap-1" style={{ color: "#2F7BFF", fontWeight: 600, fontSize: 11 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "#2F7BFF", display: "inline-block" }}></span>Revenue
                    </span>
                    <span className="d-flex align-items-center gap-1" style={{ color: "#16a34a", fontWeight: 600, fontSize: 11 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "#16a34a", display: "inline-block" }}></span>Trips
                    </span>
                  </div>
                </div>
                <div style={{ padding: "0 12px 16px" }}>
                  <Suspense fallback={<ChartFallback />}>
                    <DashboardRevenueChart data={chart} />
                  </Suspense>
                </div>
              </div>
            </div>

            {/* Pie Chart */}
            <div className="col-lg-5">
              <div className="jd-card h-100">
                <div className="jd-card-header">
                  <div>
                    <h6 className="jd-card-title">Trip Distribution</h6>
                    <div className="jd-card-subtitle">Status breakdown</div>
                  </div>
                </div>
                <div style={{ padding: "0 12px 8px" }} className="d-flex flex-column align-items-center">
                  <Suspense fallback={<ChartFallback />}>
                    <DashboardTripDistributionChart data={pieData} />
                  </Suspense>
                </div>
              </div>
            </div>
          </div>

          {/* ── Recent Trips Table ── */}
          <div className="jd-card mb-3" data-testid="recent-trips-card">
            <div className="jd-card-header">
              <div>
                <h6 className="jd-card-title">Recent Trips</h6>
                <div className="jd-card-subtitle">Latest platform activity</div>
              </div>
              <Link href="/admin/trips" className="jd-view-all-btn">
                View All <i className="bi bi-arrow-right ms-1"></i>
              </Link>
            </div>
            <div style={{ padding: 0 }}>
              <div className="table-responsive">
                <table className="table table-borderless align-middle table-hover mb-0">
                  <thead>
                    <tr className="jd-table-head">
                      {["Trip ID","Customer","Vehicle","Type","Fare","Payment","Status","Date"].map((h, i) => (
                        <th key={i} className={i === 0 ? "ps-4" : ""}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading ? (
                      Array(5).fill(0).map((_, i) => (
                        <tr key={i}>
                          {Array(8).fill(0).map((_, j) => (
                            <td key={j}><div className="jd-skeleton" style={{ width: j === 0 ? 70 : "80%", height: 12 }} /></td>
                          ))}
                        </tr>
                      ))
                    ) : stats?.recentTrips?.length ? (
                      stats.recentTrips.filter((item: any) => item?.trip).map((item: any) => {
                        const st = item.trip?.currentStatus || "pending";
                        const badge = STATUS_BADGE[st] || { cls: "badge bg-secondary", label: st };
                        const name = item.customer?.fullName || "—";
                        return (
                          <tr key={item.trip?.id} data-testid={`trip-row-${item.trip?.id}`}>
                            <td className="ps-4">
                              <span style={{ fontSize: 12, color: "#2F7BFF", fontFamily: "'Inter', monospace", fontWeight: 700 }}>{item.trip?.refId || "—"}</span>
                            </td>
                            <td>
                              <div className="d-flex align-items-center gap-2">
                                <div className="jd-mini-avatar" style={{ background: avatarBg(name) }}>
                                  {initials(name)}
                                </div>
                                <span style={{ fontSize: 12.5, fontWeight: 500 }}>{name}</span>
                              </div>
                            </td>
                            <td style={{ fontSize: 12, color: "#64748b" }}>{item.vehicleCategory?.name || "—"}</td>
                            <td>
                              <span className="jd-type-badge" style={{
                                background: item.trip?.type === "parcel" ? "#f0fdf4" : "#eff6ff",
                                color: item.trip?.type === "parcel" ? "#16a34a" : "#1E5FCC",
                              }}>
                                {item.trip?.type === "parcel" ? "Parcel" : "Ride"}
                              </span>
                            </td>
                            <td style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>₹{Number(item.trip?.actualFare || item.trip?.estimatedFare || 0).toFixed(0)}</td>
                            <td>
                              <span className={`badge ${item.trip?.paymentStatus === "paid" ? "bg-success" : "bg-warning text-dark"}`} style={{ fontSize: 10, fontWeight: 600 }}>
                                {item.trip?.paymentStatus === "paid" ? "Paid" : "Unpaid"}
                              </span>
                            </td>
                            <td><span className={badge.cls} style={{ fontSize: 10, fontWeight: 600 }}>{badge.label}</span></td>
                            <td style={{ fontSize: 11.5, color: "#94a3b8", fontWeight: 500 }}>{item.trip?.createdAt ? new Date(item.trip.createdAt).toLocaleDateString("en-IN") : "—"}</td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr><td colSpan={8}>
                        <div className="jd-empty-table">
                          <div className="jd-empty-icon">
                            <i className="bi bi-car-front" style={{ fontSize: 28, color: "#93c5fd" }}></i>
                          </div>
                          <h6 style={{ fontWeight: 700, color: "#0f172a", marginBottom: 4 }}>No Trips Yet</h6>
                          <p style={{ fontSize: 12.5, color: "#94a3b8", maxWidth: 260, textAlign: "center", lineHeight: 1.5, margin: "0 0 12px" }}>
                            Trips will appear here once customers book rides through the JAGO app
                          </p>
                          <div style={{ display: "flex", gap: 8 }}>
                            <span className="jd-info-pill" style={{ background: "#f0fdf4", color: "#16a34a", borderColor: "#bbf7d0" }}>Platform Ready</span>
                            <span className="jd-info-pill" style={{ background: "#eff6ff", color: "#1E5FCC", borderColor: "#bfdbfe" }}>Awaiting First Trip</span>
                          </div>
                        </div>
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* ────── RIGHT PANEL ────── */}
        <div className="col-xl-4 col-lg-4">

          {/* Live Clock */}
          <LiveClock />

          {/* Quick Stats Mini */}
          <div className="jd-card mb-3">
            <div style={{ padding: "16px 16px 12px" }}>
              <SectionHeader title="Quick Stats" />
              <div className="row g-2">
                {quickStatsMini.map((s, i) => (
                  <div key={i} className="col-6">
                    <div className="jd-quick-stat" style={{ background: s.bg }}>
                      <i className={`bi ${s.icon}`} style={{ color: s.color, fontSize: 15 }}></i>
                      <div>
                        <div style={{ fontSize: 17, fontWeight: 800, color: s.color, lineHeight: 1 }}>{isLoading ? "—" : s.val}</div>
                        <div style={{ fontSize: 10, color: "#64748b", marginTop: 1, fontWeight: 500 }}>{s.label}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="jd-card mb-3">
            <div style={{ padding: "16px 16px 12px" }}>
              <SectionHeader title="Quick Actions" />
              <div className="row g-2">
                {quickLinks.map((l, i) => (
                  <div key={i} className="col-6">
                    {l.external ? (
                      <a href={l.href} download style={{ textDecoration: "none" }}>
                        <div className="jd-quick-action" style={{ "--accent": l.color } as any}>
                          <div className="jd-quick-action-icon" style={{ background: `${l.color}12` }}>
                            <i className={`bi ${l.icon}`} style={{ color: l.color, fontSize: 13 }}></i>
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#1e293b" }}>{l.label}</span>
                        </div>
                      </a>
                    ) : (
                      <Link href={l.href}>
                        <div className="jd-quick-action" style={{ "--accent": l.color } as any}>
                          <div className="jd-quick-action-icon" style={{ background: `${l.color}12` }}>
                            <i className={`bi ${l.icon}`} style={{ color: l.color, fontSize: 13 }}></i>
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#1e293b" }}>{l.label}</span>
                        </div>
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Notifications Feed */}
          <div className="jd-card">
            <div className="jd-card-header" style={{ paddingBottom: 0 }}>
              <h6 className="jd-card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <i className="bi bi-bell-fill" style={{ color: "#2F7BFF", fontSize: 14 }}></i>
                Notifications
              </h6>
              <Link href="/admin/notifications">
                <span style={{ fontSize: 11, color: "#2F7BFF", cursor: "pointer", fontWeight: 600 }}>View all</span>
              </Link>
            </div>
            <div style={{ maxHeight: 420, overflowY: "auto", padding: 0 }}>
              {recentNotifs.length === 0 ? (
                <div className="text-center py-5" style={{ color: "#94a3b8" }}>
                  <i className="bi bi-bell-slash fs-2 d-block mb-2" style={{ opacity: 0.25 }}></i>
                  <span style={{ fontSize: 12, fontWeight: 500 }}>No notifications yet</span>
                </div>
              ) : (
                recentNotifs.map((n: any, i: number) => {
                  const type = n.type || "trip";
                  const style = NOTIF_ICONS[type] || NOTIF_ICONS.trip;
                  return (
                    <div key={n.id || i} className="jd-notif-item" style={{
                      background: n.isRead === false ? "#f8fbff" : "transparent",
                      borderBottom: i < recentNotifs.length - 1 ? "1px solid #f8fafc" : "none",
                    }}>
                      <div className="jd-notif-icon" style={{ background: style.bg }}>
                        <i className={`bi ${style.icon}`} style={{ color: style.color, fontSize: 13 }}></i>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#1e293b", lineHeight: 1.3, marginBottom: 1 }}>{n.title || "Notification"}</div>
                        <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.message || n.body || ""}</div>
                      </div>
                      <div style={{ fontSize: 9.5, color: "#94a3b8", whiteSpace: "nowrap", marginTop: 2, fontWeight: 500 }}>
                        {n.createdAt ? timeAgo(n.createdAt) : ""}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
