import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  completed: { cls: "badge bg-success", label: "Completed" },
  ongoing: { cls: "badge bg-info", label: "Ongoing" },
  pending: { cls: "badge bg-warning text-dark", label: "Pending" },
  cancelled: { cls: "badge bg-danger", label: "Cancelled" },
  accepted: { cls: "badge bg-primary", label: "Accepted" },
};

const NOTIF_ICONS: Record<string, { icon: string; color: string; bg: string }> = {
  trip: { icon: "bi-car-front-fill", color: "#2F7BFF", bg: "#EBF4FF" },
  driver: { icon: "bi-person-badge-fill", color: "#16a34a", bg: "#f0fdf4" },
  payment: { icon: "bi-cash-stack", color: "#d97706", bg: "#fefce8" },
  alert: { icon: "bi-exclamation-triangle-fill", color: "#dc2626", bg: "#fef2f2" },
  user: { icon: "bi-person-plus-fill", color: "#7c3aed", bg: "#f5f3ff" },
  withdraw: { icon: "bi-wallet2", color: "#0891b2", bg: "#ecfeff" },
};

function avatarBg(name: string) {
  const colors = ["#2F7BFF", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#dc2626"];
  return colors[(name || "A").charCodeAt(0) % colors.length];
}

function initials(name: string) {
  return (name || "?")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .substring(0, 2)
    .toUpperCase();
}

function formatMoney(value: number | string | null | undefined) {
  const amount = Number(value || 0);
  return `Rs. ${amount.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function formatDate(value: Date) {
  return value.toLocaleDateString("en-IN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function timeAgo(value?: string) {
  if (!value) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function customLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) {
  if (percent < 0.06) return null;
  const radian = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * radian);
  const y = cy + radius * Math.sin(-midAngle * radian);
  return (
    <text
      x={x}
      y={y}
      fill="#fff"
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={10}
      fontWeight={700}
    >
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
}

function LiveClockCard() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const hours = now.getHours() % 12 || 12;
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const seconds = now.getSeconds().toString().padStart(2, "0");
  const ampm = now.getHours() >= 12 ? "PM" : "AM";

  return (
    <div className="jd-clock-widget">
      <div
        style={{
          fontSize: 9.5,
          letterSpacing: 2.5,
          color: "rgba(255,255,255,0.48)",
          textTransform: "uppercase",
          marginBottom: 8,
          fontWeight: 700,
        }}
      >
        Local Time
      </div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 3 }}>
        <span
          style={{
            fontSize: 36,
            fontWeight: 800,
            letterSpacing: 1,
            fontFamily: "'Inter', monospace",
            lineHeight: 1,
            color: "#fff",
          }}
        >
          {hours}:{minutes}
        </span>
        <span style={{ fontSize: 18, opacity: 0.5, fontWeight: 600 }}>:{seconds}</span>
        <span style={{ fontSize: 12, marginLeft: 6, fontWeight: 700, color: "rgba(147,197,253,0.85)" }}>
          {ampm}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.48)", marginTop: 8, fontWeight: 500 }}>
        {formatDate(now)}
      </div>
    </div>
  );
}

function SectionHeader({ title, badge, badgeColor }: { title: string; badge?: string; badgeColor?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          color: "#94a3b8",
          textTransform: "uppercase",
          letterSpacing: 1.2,
        }}
      >
        {title}
      </span>
      {badge ? (
        <span
          style={{
            fontSize: 10.5,
            background: `${badgeColor || "#dc2626"}10`,
            color: badgeColor || "#dc2626",
            border: `1px solid ${badgeColor || "#dc2626"}30`,
            borderRadius: 999,
            padding: "4px 10px",
            fontWeight: 700,
          }}
        >
          {badge}
        </span>
      ) : null}
    </div>
  );
}

function StatCard({ label, value, icon, color, bg, href, trend }: any) {
  return (
    <Link href={href}>
      <div className="jd-stat-card" style={{ color }} data-testid={`stat-card-${label.toLowerCase().replace(/\s+/g, "-")}`}>
        <div className="jd-stat-icon-wrap" style={{ background: bg }}>
          <i className={`bi ${icon}`} style={{ color, fontSize: "1.25rem" }}></i>
        </div>
        <div className="jd-stat-body">
          <div className="jd-stat-label">{label}</div>
          <div className="jd-stat-value" style={{ color }}>
            {value}
          </div>
        </div>
        {trend ? <div className="jd-stat-trend jd-trend-up">{trend}</div> : null}
        <div className="jd-stat-arrow">
          <i className="bi bi-chevron-right"></i>
        </div>
      </div>
    </Link>
  );
}

function ServiceCard({ label, icon, color, bg, trips, revenue, model, href }: any) {
  return (
    <Link href={href}>
      <div className="jd-svc-card" style={{ "--accent": color, "--accent-bg": bg } as any}>
        <div className="jd-svc-head">
          <div className="jd-svc-icon" style={{ background: bg }}>
            <i className={`bi ${icon}`} style={{ color, fontSize: 15 }}></i>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "#0f172a", lineHeight: 1.2 }}>{label}</div>
            <div style={{ fontSize: 10, color, fontWeight: 600, textTransform: "capitalize", marginTop: 2 }}>{model}</div>
          </div>
        </div>
        <div className="jd-svc-stats">
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color, lineHeight: 1 }}>{Number(trips || 0).toLocaleString()}</div>
            <div style={{ fontSize: 9.5, color: "#94a3b8", marginTop: 2, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Trips
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a", lineHeight: 1 }}>{formatMoney(revenue)}</div>
            <div style={{ fontSize: 9.5, color: "#94a3b8", marginTop: 2, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Revenue
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function Dashboard() {
  const { data: stats, isLoading } = useQuery<any>({ queryKey: ["/api/dashboard/stats"] });
  const { data: serviceData } = useQuery<any>({ queryKey: ["/api/admin/dashboard"], staleTime: 30000 });
  const { data: chart = [] } = useQuery<any[]>({ queryKey: ["/api/dashboard/chart"] });
  const { data: notifications = [] } = useQuery<any[]>({ queryKey: ["/api/notifications"] });
  const { data: liveKpis } = useQuery<any>({ queryKey: ["/api/admin/live-kpis"], refetchInterval: 15000 });

  const adminName = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("jago-admin") || "{}").name || "Admin";
    } catch {
      return "Admin";
    }
  }, []);

  const now = new Date();
  const greeting = now.getHours() < 12 ? "Good morning" : now.getHours() < 17 ? "Good afternoon" : "Good evening";
  const today = formatDate(now);

  const topStats = [
    { label: "Total Customers", value: Number(stats?.totalCustomers || 0).toLocaleString(), icon: "bi-people-fill", color: "#2F7BFF", bg: "#EBF4FF", href: "/admin/customers", trend: "+12%" },
    { label: "Total Drivers", value: Number(stats?.totalDrivers || 0).toLocaleString(), icon: "bi-person-badge-fill", color: "#16a34a", bg: "#f0fdf4", href: "/admin/drivers", trend: "+5%" },
    { label: "Total Revenue", value: formatMoney(stats?.totalRevenue), icon: "bi-currency-rupee", color: "#b45309", bg: "#fefce8", href: "/admin/reports", trend: "+18%" },
    { label: "Total Trips", value: Number(stats?.totalTrips || 0).toLocaleString(), icon: "bi-car-front-fill", color: "#7e22ce", bg: "#f5f3ff", href: "/admin/trips", trend: "+8%" },
  ];

  const services = [
    { label: "City Rides", icon: "bi-car-front-fill", color: "#2F7BFF", bg: "#eff6ff", trips: serviceData?.services?.rides?.trips ?? 0, revenue: serviceData?.services?.rides?.revenue ?? 0, model: serviceData?.services?.rides?.model ?? "Commission", href: "/admin/trips" },
    { label: "Parcels", icon: "bi-box-seam-fill", color: "#16a34a", bg: "#f0fdf4", trips: serviceData?.services?.parcels?.trips ?? 0, revenue: serviceData?.services?.parcels?.revenue ?? 0, model: serviceData?.services?.parcels?.model ?? "Commission", href: "/admin/parcel-orders" },
    { label: "Intercity Pool", icon: "bi-people-fill", color: "#7c3aed", bg: "#f5f3ff", trips: serviceData?.services?.carpool?.trips ?? 0, revenue: serviceData?.services?.carpool?.revenue ?? 0, model: serviceData?.services?.carpool?.model ?? "Commission", href: "/admin/intercity-carsharing" },
    { label: "Outstation Pool", icon: "bi-signpost-2-fill", color: "#d97706", bg: "#fefce8", trips: serviceData?.services?.outstationPool?.bookings ?? 0, revenue: serviceData?.services?.outstationPool?.revenue ?? 0, model: serviceData?.services?.outstationPool?.mode === "on" ? "Active" : "Inactive", href: "/admin/outstation-pool" },
  ];

  const quickStats = [
    { label: "Completed", value: stats?.completedTrips ?? 0, color: "#10b981", bg: "#f0fdf4", icon: "bi-check-circle-fill" },
    { label: "Ongoing", value: stats?.ongoingTrips ?? 0, color: "#2F7BFF", bg: "#eff6ff", icon: "bi-broadcast-pin" },
    { label: "Cancelled", value: stats?.cancelledTrips ?? 0, color: "#ef4444", bg: "#fef2f2", icon: "bi-x-circle-fill" },
    { label: "Withdrawals", value: stats?.pendingWithdrawals ?? 0, color: "#f59e0b", bg: "#fefce8", icon: "bi-clock-history" },
    { label: "Reviews", value: stats?.totalReviews ?? 0, color: "#f59e0b", bg: "#fffbeb", icon: "bi-star-fill" },
    { label: "Zones", value: stats?.totalZones ?? 0, color: "#7c3aed", bg: "#f5f3ff", icon: "bi-map-fill" },
  ];

  const quickLinks = [
    { label: "All Trips", icon: "bi-car-front", href: "/admin/trips", color: "#2F7BFF" },
    { label: "Drivers", icon: "bi-person-badge", href: "/admin/drivers", color: "#16a34a" },
    { label: "Withdrawals", icon: "bi-cash-coin", href: "/admin/withdrawals", color: "#d97706" },
    { label: "Reports", icon: "bi-graph-up", href: "/admin/reports", color: "#7c3aed" },
  ];

  const pieData = [
    { name: "Completed", value: stats?.completedTrips || 0, color: "#10b981" },
    { name: "Ongoing", value: stats?.ongoingTrips || 0, color: "#2F7BFF" },
    { name: "Cancelled", value: stats?.cancelledTrips || 0, color: "#ef4444" },
    { name: "Other", value: Math.max(0, (stats?.totalTrips || 0) - (stats?.completedTrips || 0) - (stats?.ongoingTrips || 0) - (stats?.cancelledTrips || 0)), color: "#cbd5e1" },
  ].filter((item) => item.value > 0);

  const liveItems = liveKpis
    ? [
        { label: "Searching", value: liveKpis.live?.searching ?? 0, color: "#f59e0b", bg: "#fffbeb", icon: "bi-search" },
        { label: "Dispatching", value: liveKpis.live?.dispatching ?? 0, color: "#2563eb", bg: "#eff6ff", icon: "bi-lightning-charge-fill" },
        { label: "In Progress", value: liveKpis.live?.inProgress ?? 0, color: "#16a34a", bg: "#f0fdf4", icon: "bi-car-front-fill" },
        { label: "Done (1h)", value: liveKpis.live?.completedLastHour ?? 0, color: "#0891b2", bg: "#ecfeff", icon: "bi-check-circle-fill" },
        { label: "Cancelled (1h)", value: liveKpis.live?.cancelledLastHour ?? 0, color: "#dc2626", bg: "#fef2f2", icon: "bi-x-circle-fill" },
        { label: "Avg Wait", value: `${liveKpis.live?.avgPickupWaitMin ?? 0}m`, color: "#7c3aed", bg: "#f5f3ff", icon: "bi-clock-fill" },
      ]
    : [];

  const recentTrips = Array.isArray(stats?.recentTrips) ? stats.recentTrips.filter((item: any) => item?.trip).slice(0, 6) : [];
  const recentNotifications = Array.isArray(notifications) ? notifications.slice(0, 8) : [];
  const pendingCommission = serviceData?.drivers?.totalPendingCommission ?? 0;

  return (
    <div className="container-fluid admin-dashboard-page">
      <div className="jd-banner mb-3" data-testid="dashboard-banner">
        <div className="jd-banner-inner">
          <div className="d-flex align-items-center gap-3">
            <div className="jd-avatar">
              <i className="bi bi-sunrise-fill" style={{ fontSize: "1.25rem", color: "#fbbf24" }}></i>
            </div>
            <div>
              <h3 className="mb-1" style={{ fontSize: "1.55rem", fontWeight: 800 }}>{greeting}, {adminName}!</h3>
              <p className="mb-0" style={{ fontSize: 14, color: "rgba(255,255,255,0.82)" }}>Here is your platform overview for today</p>
            </div>
          </div>
          <div className="jd-date-badge">
            <i className="bi bi-calendar3" style={{ fontSize: 12 }}></i>
            <span>{today}</span>
          </div>
        </div>
        <div className="jd-banner-kpis">
          <div className="jd-kpi">
            <span className="jd-kpi-n">{liveKpis?.live?.inProgress ?? stats?.ongoingTrips ?? "-"}</span>
            <span className="jd-kpi-l">Live Trips</span>
          </div>
          <div className="jd-kpi-sep"></div>
          <div className="jd-kpi">
            <span className="jd-kpi-n">{serviceData?.drivers?.online ?? Math.round((stats?.totalDrivers ?? 0) * 0.7)}</span>
            <span className="jd-kpi-l">Online Pilots</span>
          </div>
          <div className="jd-kpi-sep"></div>
          <div className="jd-kpi">
            <span className="jd-kpi-n">{formatMoney(stats?.totalRevenue)}</span>
            <span className="jd-kpi-l">Total Revenue</span>
          </div>
          <div className="jd-kpi-sep"></div>
          <div className="jd-kpi">
            <span className="jd-kpi-n">{stats?.totalZones ?? "-"}</span>
            <span className="jd-kpi-l">Active Zones</span>
          </div>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-xl-8 col-lg-8">
          <div className="row g-3 mb-3">
            {topStats.map((card) => (
              <div key={card.label} className="col-xl-6 col-sm-6">
                <StatCard {...card} />
              </div>
            ))}
          </div>

          <SectionHeader
            title="Services Overview"
            badge={pendingCommission > 0 ? `${formatMoney(pendingCommission)} pending commission` : undefined}
            badgeColor="#dc2626"
          />
          <div className="row g-3 mb-3">
            {services.map((service) => (
              <div key={service.label} className="col-xl-3 col-sm-6">
                <ServiceCard {...service} />
              </div>
            ))}
          </div>

          {liveItems.length > 0 ? (
            <div className="mb-3">
              <div className="mb-2 d-flex align-items-center justify-content-between flex-wrap gap-2">
                <span style={{ fontSize: 10.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1.2 }}>
                  Live Operations
                </span>
                <span className="jd-live-badge">
                  <span className="jd-live-dot"></span>
                  Live · refreshes every 15s
                </span>
              </div>
              <div className="row g-2">
                {liveItems.map((item) => (
                  <div key={item.label} className="col-xl-4 col-sm-6 col-6">
                    <div className="jd-kpi-mini-card" style={{ background: item.bg, borderColor: `${item.color}20` }}>
                      <div className="jd-kpi-mini-icon" style={{ background: `${item.color}15` }}>
                        <i className={`bi ${item.icon}`} style={{ color: item.color, fontSize: 13 }}></i>
                      </div>
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: item.color, lineHeight: 1.1 }}>{item.value}</div>
                        <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>{item.label}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="row g-3 mb-3">
            <div className="col-lg-7">
              <div className="jd-card h-100">
                <div className="jd-card-header">
                  <div>
                    <h6 className="jd-card-title">Weekly Revenue Trend</h6>
                    <div className="jd-card-subtitle">Revenue and trips over the last 7 days</div>
                  </div>
                </div>
                <div style={{ padding: "0 12px 16px" }}>
                  {chart.length > 0 ? (
                    <ResponsiveContainer width="100%" height={220}>
                      <AreaChart data={chart} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id="gradRev" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#2F7BFF" stopOpacity={0.2} />
                            <stop offset="100%" stopColor="#2F7BFF" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="gradTrips" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#16a34a" stopOpacity={0.18} />
                            <stop offset="100%" stopColor="#16a34a" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                        <XAxis dataKey="day" tick={{ fontSize: 10.5, fill: "#94a3b8", fontWeight: 500 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10.5, fill: "#94a3b8", fontWeight: 500 }} axisLine={false} tickLine={false} width={42} />
                        <Tooltip
                          contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", boxShadow: "0 8px 32px rgba(0,0,0,0.08)", fontSize: 12, padding: "10px 14px" }}
                          formatter={(value: any, name: string) => [name === "revenue" ? formatMoney(value) : value, name === "revenue" ? "Revenue" : "Trips"]}
                        />
                        <Area type="monotone" dataKey="revenue" stroke="#2F7BFF" strokeWidth={2.5} fill="url(#gradRev)" dot={false} />
                        <Area type="monotone" dataKey="trips" stroke="#16a34a" strokeWidth={2} fill="url(#gradTrips)" dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="jd-empty-chart">
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#64748B", marginBottom: 4 }}>No analytics yet</div>
                      <div style={{ fontSize: 11, color: "#94a3b8", maxWidth: 220, lineHeight: 1.5, textAlign: "center" }}>
                        Data will appear once trips are completed on the platform
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="col-lg-5">
              <div className="jd-card h-100">
                <div className="jd-card-header">
                  <div>
                    <h6 className="jd-card-title">Trip Distribution</h6>
                    <div className="jd-card-subtitle">Status breakdown</div>
                  </div>
                </div>
                <div style={{ padding: "0 12px 8px" }} className="d-flex flex-column align-items-center">
                  {pieData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie data={pieData} cx="50%" cy="45%" innerRadius={52} outerRadius={80} paddingAngle={3} dataKey="value" labelLine={false} label={customLabel}>
                          {pieData.map((entry, index) => (
                            <Cell key={index} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value: any, name: string) => [`${value} trips`, name]} contentStyle={{ borderRadius: 10, fontSize: 12, border: "1px solid #e2e8f0" }} />
                        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, paddingTop: 4, fontWeight: 500 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="d-flex flex-column align-items-center justify-content-center" style={{ height: 220, color: "#cbd5e1" }}>
                      <i className="bi bi-pie-chart fs-1 mb-2" style={{ opacity: 0.3 }}></i>
                      <span style={{ fontSize: 12, fontWeight: 500 }}>No trip data yet</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

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
                      {["Trip ID", "Customer", "Vehicle", "Type", "Fare", "Payment", "Status", "Date"].map((heading, index) => (
                        <th key={heading} className={index === 0 ? "ps-4" : ""}>{heading}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading ? (
                      Array.from({ length: 5 }).map((_, rowIndex) => (
                        <tr key={rowIndex}>
                          {Array.from({ length: 8 }).map((__, cellIndex) => (
                            <td key={cellIndex}><div className="jd-skeleton" style={{ width: cellIndex === 0 ? 70 : "80%", height: 12 }} /></td>
                          ))}
                        </tr>
                      ))
                    ) : recentTrips.length > 0 ? (
                      recentTrips.map((item: any) => {
                        const status = item.trip?.currentStatus || "pending";
                        const badge = STATUS_BADGE[status] || { cls: "badge bg-secondary", label: status };
                        const name = item.customer?.fullName || "-";
                        return (
                          <tr key={item.trip?.id} data-testid={`trip-row-${item.trip?.id}`}>
                            <td className="ps-4">
                              <span style={{ fontSize: 12, color: "#2F7BFF", fontFamily: "'Inter', monospace", fontWeight: 700 }}>
                                {item.trip?.refId || "-"}
                              </span>
                            </td>
                            <td>
                              <div className="d-flex align-items-center gap-2">
                                <div className="jd-mini-avatar" style={{ background: avatarBg(name) }}>{initials(name)}</div>
                                <span style={{ fontSize: 12.5, fontWeight: 500 }}>{name}</span>
                              </div>
                            </td>
                            <td style={{ fontSize: 12, color: "#64748b" }}>{item.vehicleCategory?.name || "-"}</td>
                            <td>
                              <span
                                className="jd-type-badge"
                                style={{
                                  background: item.trip?.type === "parcel" ? "#f0fdf4" : "#eff6ff",
                                  color: item.trip?.type === "parcel" ? "#16a34a" : "#1E5FCC",
                                }}
                              >
                                {item.trip?.type === "parcel" ? "Parcel" : "Ride"}
                              </span>
                            </td>
                            <td style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>{formatMoney(item.trip?.actualFare || item.trip?.estimatedFare || 0)}</td>
                            <td>
                              <span className={`badge ${item.trip?.paymentStatus === "paid" ? "bg-success" : "bg-warning text-dark"}`} style={{ fontSize: 10, fontWeight: 600 }}>
                                {item.trip?.paymentStatus === "paid" ? "Paid" : "Unpaid"}
                              </span>
                            </td>
                            <td><span className={badge.cls} style={{ fontSize: 10, fontWeight: 600 }}>{badge.label}</span></td>
                            <td style={{ fontSize: 11.5, color: "#94a3b8", fontWeight: 500 }}>{item.trip?.createdAt ? new Date(item.trip.createdAt).toLocaleDateString("en-IN") : "-"}</td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={8}>
                          <div className="jd-empty-table">
                            <div className="jd-empty-icon">
                              <i className="bi bi-car-front" style={{ fontSize: 28, color: "#93c5fd" }}></i>
                            </div>
                            <h6 style={{ fontWeight: 700, color: "#0f172a", marginBottom: 4 }}>No Trips Yet</h6>
                            <p style={{ fontSize: 12.5, color: "#94a3b8", maxWidth: 260, textAlign: "center", lineHeight: 1.5, margin: "0 0 12px" }}>
                              Trips will appear here once customers start booking through the JAGO app.
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div className="col-xl-4 col-lg-4">
          <LiveClockCard />

          <div className="jd-card mb-3">
            <div style={{ padding: "16px 16px 12px" }}>
              <SectionHeader title="Quick Stats" />
              <div className="row g-2">
                {quickStats.map((item) => (
                  <div key={item.label} className="col-6">
                    <div className="jd-quick-stat" style={{ background: item.bg }}>
                      <i className={`bi ${item.icon}`} style={{ color: item.color, fontSize: 15 }}></i>
                      <div>
                        <div style={{ fontSize: 17, fontWeight: 800, color: item.color, lineHeight: 1 }}>{isLoading ? "-" : item.value}</div>
                        <div style={{ fontSize: 10, color: "#64748b", marginTop: 1, fontWeight: 500 }}>{item.label}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="jd-card mb-3">
            <div style={{ padding: "16px 16px 12px" }}>
              <SectionHeader title="Quick Actions" />
              <div className="row g-2">
                {quickLinks.map((item) => (
                  <div key={item.label} className="col-6">
                    <Link href={item.href}>
                      <div className="jd-quick-action" style={{ "--accent": item.color } as any}>
                        <div className="jd-quick-action-icon" style={{ background: `${item.color}12` }}>
                          <i className={`bi ${item.icon}`} style={{ color: item.color, fontSize: 13 }}></i>
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#1e293b" }}>{item.label}</span>
                      </div>
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          </div>

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
              {recentNotifications.length === 0 ? (
                <div className="text-center py-5" style={{ color: "#94a3b8" }}>
                  <i className="bi bi-bell-slash fs-2 d-block mb-2" style={{ opacity: 0.25 }}></i>
                  <span style={{ fontSize: 12, fontWeight: 500 }}>No notifications yet</span>
                </div>
              ) : (
                recentNotifications.map((notification: any, index: number) => {
                  const type = notification.type || "trip";
                  const style = NOTIF_ICONS[type] || NOTIF_ICONS.trip;
                  return (
                    <div
                      key={notification.id || index}
                      className="jd-notif-item"
                      style={{
                        background: notification.isRead === false ? "#f8fbff" : "transparent",
                        borderBottom: index < recentNotifications.length - 1 ? "1px solid #f8fafc" : "none",
                      }}
                    >
                      <div className="jd-notif-icon" style={{ background: style.bg }}>
                        <i className={`bi ${style.icon}`} style={{ color: style.color, fontSize: 13 }}></i>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#1e293b", lineHeight: 1.3, marginBottom: 1 }}>
                          {notification.title || "Notification"}
                        </div>
                        <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {notification.message || notification.body || ""}
                        </div>
                      </div>
                      <div style={{ fontSize: 9.5, color: "#94a3b8", whiteSpace: "nowrap", marginTop: 2, fontWeight: 500 }}>
                        {timeAgo(notification.createdAt)}
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
