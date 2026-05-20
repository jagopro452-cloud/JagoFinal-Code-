import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  scheduled:   { cls: "badge bg-primary",          label: "Scheduled" },
  completed:   { cls: "badge bg-success",           label: "Completed" },
  cancelled:   { cls: "badge bg-danger",            label: "Cancelled" },
  confirmed:   { cls: "badge bg-success",           label: "Confirmed" },
  pending:     { cls: "badge bg-warning text-dark", label: "Pending" },
};

function fmtDate(d: string) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export default function OutstationPool() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"rides" | "bookings">("rides");

  const { data: ridesData, isLoading: ridesLoading } = useQuery<any>({
    queryKey: ["/api/admin/outstation-pool/rides"],
  });
  const { data: bookingsData, isLoading: bookingsLoading } = useQuery<any>({
    queryKey: ["/api/admin/outstation-pool/bookings"],
  });
  const { data: settingsData } = useQuery<any>({
    queryKey: ["/api/admin/revenue/settings"],
  });

  const toggleMode = useMutation({
    mutationFn: async (mode: "on" | "off") => {
      const res = await fetch("/api/admin/outstation-pool/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || "Failed to update pool mode");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/revenue/settings"] });
    },
  });

  const rides    = ridesData?.data || [];
  const bookings = bookingsData?.data || [];
  const isPoolOn = settingsData?.outstation_pool_mode === "on";

  const rideStats = {
    total: rides.length,
    active: rides.filter((r: any) => r.status === "scheduled" && r.isActive).length,
    totalBookings: rides.reduce((s: number, r: any) => s + (parseInt(r.totalBookings) || 0), 0),
    totalRevenue: rides.reduce((s: number, r: any) => s + (parseFloat(r.totalRevenue) || 0), 0),
  };

  return (
    <div className="container-fluid">
      {/* Header */}
      <div className="d-flex align-items-center justify-content-between mb-4 flex-wrap gap-3">
        <div>
          <h4 className="fw-bold mb-1" style={{ color: "#0f172a" }}>
            <i className="bi bi-signpost-2-fill me-2" style={{ color: "#2F7BFF" }}></i>
            Outstation Pool
          </h4>
          <p className="text-muted mb-0" style={{ fontSize: 13 }}>
            Manage city-to-city carpool rides posted by drivers
          </p>
        </div>
        <div className="d-flex align-items-center gap-3">
          <div className="d-flex align-items-center gap-2 bg-white rounded-3 px-3 py-2 border">
            <span style={{ fontSize: 13, fontWeight: 600, color: "#334155" }}>Pool Mode:</span>
            <span className={`badge ${isPoolOn ? "bg-success" : "bg-secondary"} fs-6 px-3`}>
              {isPoolOn ? "🟢 Active" : "⚪ Inactive"}
            </span>
            <button
              onClick={() => toggleMode.mutate(isPoolOn ? "off" : "on")}
              className={`btn btn-sm ${isPoolOn ? "btn-outline-danger" : "btn-outline-success"} ms-2`}
              disabled={toggleMode.isPending}
            >
              {isPoolOn ? "Disable" : "Enable"}
            </button>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="row g-3 mb-4">
        {[
          { label: "Total Rides Posted",  val: rideStats.total,        icon: "bi-car-front-fill",     color: "#1a73e8", bg: "#e8f0fe" },
          { label: "Active / Scheduled",  val: rideStats.active,       icon: "bi-broadcast-pin",      color: "#16a34a", bg: "#f0fdf4" },
          { label: "Total Bookings",      val: rideStats.totalBookings, icon: "bi-ticket-fill",        color: "#7c3aed", bg: "#f5f3ff" },
          { label: "Total Revenue",       val: `₹${rideStats.totalRevenue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, icon: "bi-currency-rupee", color: "#b45309", bg: "#fefce8" },
        ].map((s, i) => (
          <div key={i} className="col-xl-3 col-md-6 col-6">
            <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14 }}>
              <div className="card-body d-flex align-items-center gap-3 p-3">
                <div style={{ width: 48, height: 48, borderRadius: 12, background: s.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <i className={`bi ${s.icon}`} style={{ color: s.color, fontSize: "1.3rem" }}></i>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>{s.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: s.color, lineHeight: 1.2 }}>{s.val}</div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="card border-0 shadow-sm" style={{ borderRadius: 16 }}>
        <div className="card-header bg-white border-0 px-4 pt-4 pb-0" style={{ borderRadius: "16px 16px 0 0" }}>
          <ul className="nav nav-tabs border-0" style={{ gap: 4 }}>
            {(["rides", "bookings"] as const).map(t => (
              <li key={t} className="nav-item">
                <button
                  className={`nav-link border-0 fw-bold px-4 py-2 rounded-top ${tab === t ? "active text-primary" : "text-secondary"}`}
                  style={{ fontSize: 13, background: tab === t ? "#eff6ff" : "transparent" }}
                  onClick={() => setTab(t)}
                >
                  {t === "rides" ? (
                    <><i className="bi bi-car-front me-2"></i>Rides ({rides.length})</>
                  ) : (
                    <><i className="bi bi-ticket me-2"></i>Bookings ({bookings.length})</>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="card-body p-0">
          {tab === "rides" && (
            <div className="table-responsive">
              <table className="table table-borderless table-hover align-middle mb-0">
                <thead style={{ background: "#f8fafc" }}>
                  <tr>
                    {["Driver", "Route", "Date & Time", "Seats", "Fare/Seat", "Bookings", "Revenue", "Status"].map((h, i) => (
                      <th key={i} className={i === 0 ? "ps-4" : ""}
                        style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, paddingTop: 12, paddingBottom: 12, whiteSpace: "nowrap" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ridesLoading ? (
                    Array(5).fill(0).map((_, i) => (
                      <tr key={i}>
                        {Array(8).fill(0).map((_, j) => (
                          <td key={j}><div className="skeleton" style={{ height: 13, borderRadius: 4 }} /></td>
                        ))}
                      </tr>
                    ))
                  ) : rides.length === 0 ? (
                    <tr><td colSpan={8}>
                      <div className="text-center py-5 text-muted">
                        <i className="bi bi-signpost-2 fs-1 d-block mb-2" style={{ opacity: 0.25 }}></i>
                        <p className="mb-0">No outstation rides posted yet</p>
                      </div>
                    </td></tr>
                  ) : (
                    rides.map((r: any) => {
                      const badge = STATUS_BADGE[r.status] || { cls: "badge bg-secondary", label: r.status };
                      return (
                        <tr key={r.id}>
                          <td className="ps-4">
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 600 }}>{r.driverName || "—"}</div>
                              <div style={{ fontSize: 11, color: "#64748b" }}>{r.driverPhone || ""}</div>
                            </div>
                          </td>
                          <td>
                            <div className="d-flex align-items-center gap-2">
                              <span style={{ fontSize: 12, fontWeight: 700, color: "#1a73e8" }}>{r.fromCity}</span>
                              <i className="bi bi-arrow-right" style={{ fontSize: 10, color: "#94a3b8" }}></i>
                              <span style={{ fontSize: 12, fontWeight: 700, color: "#16a34a" }}>{r.toCity}</span>
                            </div>
                            {r.routeKm > 0 && (
                              <div style={{ fontSize: 10, color: "#94a3b8" }}>{r.routeKm} km</div>
                            )}
                          </td>
                          <td>
                            <div style={{ fontSize: 12, fontWeight: 600 }}>{fmtDate(r.departureDate)}</div>
                            <div style={{ fontSize: 11, color: "#64748b" }}>{r.departureTime || "—"}</div>
                          </td>
                          <td>
                            <div className="d-flex align-items-center gap-1">
                              <span style={{ fontSize: 14, fontWeight: 700, color: "#1a73e8" }}>{r.availableSeats}</span>
                              <span style={{ fontSize: 11, color: "#94a3b8" }}>/ {r.totalSeats}</span>
                            </div>
                            <div style={{ fontSize: 10, color: "#94a3b8" }}>available</div>
                          </td>
                          <td style={{ fontSize: 14, fontWeight: 700, color: "#16a34a" }}>₹{parseFloat(r.farePerSeat || 0).toFixed(0)}</td>
                          <td>
                            <span className="badge bg-primary bg-opacity-10 text-primary" style={{ fontSize: 12 }}>
                              {r.totalBookings || 0}
                            </span>
                          </td>
                          <td style={{ fontSize: 13, fontWeight: 600 }}>₹{parseFloat(r.totalRevenue || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
                          <td><span className={badge.cls} style={{ fontSize: 10 }}>{badge.label}</span></td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === "bookings" && (
            <div className="table-responsive">
              <table className="table table-borderless table-hover align-middle mb-0">
                <thead style={{ background: "#f8fafc" }}>
                  <tr>
                    {["Customer", "Route", "Seats", "Total Fare", "Payment", "Status", "Booked On"].map((h, i) => (
                      <th key={i} className={i === 0 ? "ps-4" : ""}
                        style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, paddingTop: 12, paddingBottom: 12, whiteSpace: "nowrap" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bookingsLoading ? (
                    Array(5).fill(0).map((_, i) => (
                      <tr key={i}>
                        {Array(7).fill(0).map((_, j) => (
                          <td key={j}><div className="skeleton" style={{ height: 13, borderRadius: 4 }} /></td>
                        ))}
                      </tr>
                    ))
                  ) : bookings.length === 0 ? (
                    <tr><td colSpan={7}>
                      <div className="text-center py-5 text-muted">
                        <i className="bi bi-ticket fs-1 d-block mb-2" style={{ opacity: 0.25 }}></i>
                        <p className="mb-0">No bookings yet</p>
                      </div>
                    </td></tr>
                  ) : (
                    bookings.map((b: any) => {
                      const badge = STATUS_BADGE[b.status] || { cls: "badge bg-secondary", label: b.status };
                      const pmBadge = b.paymentStatus === "paid"
                        ? <span className="badge bg-success" style={{ fontSize: 10 }}>✓ Paid</span>
                        : <span className="badge bg-warning text-dark" style={{ fontSize: 10 }}>Unpaid</span>;
                      return (
                        <tr key={b.id}>
                          <td className="ps-4">
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{b.customerName || "—"}</div>
                            <div style={{ fontSize: 11, color: "#64748b" }}>{b.customerPhone || ""}</div>
                          </td>
                          <td>
                            <div className="d-flex align-items-center gap-2">
                              <span style={{ fontSize: 12, fontWeight: 700, color: "#1a73e8" }}>{b.fromCity}</span>
                              <i className="bi bi-arrow-right" style={{ fontSize: 10, color: "#94a3b8" }}></i>
                              <span style={{ fontSize: 12, fontWeight: 700, color: "#16a34a" }}>{b.toCity}</span>
                            </div>
                          </td>
                          <td style={{ fontSize: 14, fontWeight: 700, color: "#1a73e8" }}>{b.seatsBooked}</td>
                          <td style={{ fontSize: 14, fontWeight: 700, color: "#16a34a" }}>₹{parseFloat(b.totalFare || 0).toFixed(0)}</td>
                          <td>{pmBadge}</td>
                          <td><span className={badge.cls} style={{ fontSize: 10 }}>{badge.label}</span></td>
                          <td style={{ fontSize: 12, color: "#64748b" }}>{fmtDate(b.createdAt)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
