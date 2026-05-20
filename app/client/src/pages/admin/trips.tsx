import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const avatarBg = (name: string) => {
  const colors = ["#1a73e8","#16a34a","#d97706","#9333ea","#0891b2","#dc2626"];
  return colors[(name || "A").charCodeAt(0) % colors.length];
};
const initials = (name: string) => (name || "?").split(" ").map(n => n[0]).join("").substring(0, 2).toUpperCase();

const STATUS_CONFIG: Record<string, { cls: string; dot: string }> = {
  completed:       { cls: "bg-success",           dot: "#16a34a" },
  ongoing:         { cls: "bg-info",               dot: "#0891b2" },
  pending:         { cls: "bg-warning text-dark",  dot: "#d97706" },
  cancelled:       { cls: "bg-danger",             dot: "#dc2626" },
  accepted:        { cls: "bg-primary",            dot: "#1a73e8" },
  searching:       { cls: "bg-warning text-dark",  dot: "#d97706" },
  driver_assigned: { cls: "bg-primary",            dot: "#1a73e8" },
  arrived:         { cls: "bg-info",               dot: "#0891b2" },
  on_the_way:      { cls: "bg-info",               dot: "#0891b2" },
};

const TYPE_CONFIG: Record<string, { label: string; icon: string; bg: string; color: string }> = {
  ride:   { label: "Ride",   icon: "🚗", bg: "#eff6ff", color: "#1E5FCC" },
  parcel: { label: "Parcel", icon: "📦", bg: "#f0fdf4", color: "#16a34a" },
};

const STATUSES = ["all", "pending", "accepted", "ongoing", "completed", "cancelled"];

export default function Trips() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [page, setPage] = useState(1);
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/trips", { status, search, page, typeFilter }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: "15" });
      if (status !== "all") params.set("status", status);
      if (search) params.set("search", search);
      if (typeFilter !== "all") params.set("type", typeFilter);
      return fetch(`/api/trips?${params}`).then(r => r.ok ? r.json() : r.json().then(d => { throw new Error(d?.message || "Error") })).then(d => d?.data ? d : { data: Array.isArray(d) ? d : [], total: 0 });
    },
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, newStatus }: { id: string; newStatus: string }) =>
      apiRequest("PATCH", `/api/trips/${id}/status`, { status: newStatus }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/trips"] });
      qc.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({ title: "Trip status updated successfully" });
    },
  });

  const totalPages = Math.ceil((data?.total || 0) / 15);

  return (
    <div className="container-fluid">
      <div className="d-flex align-items-center justify-content-between mb-4">
        <div>
          <h4 className="mb-0 fw-bold" data-testid="page-title">Trip Management</h4>
          <div className="text-muted small">All ride and parcel delivery trips</div>
        </div>
        <div className="d-flex align-items-center gap-2">
          <span className="text-muted small">Total:</span>
          <span className="fw-bold text-primary fs-5" data-testid="total-count">{data?.total || 0}</span>
        </div>
      </div>

      <div className="card border-0 shadow-sm" style={{ borderRadius: 14 }}>
        <div className="card-header bg-white py-3 px-4" style={{ borderBottom: "1px solid #f1f5f9" }}>
          <div className="d-flex flex-wrap gap-3 align-items-center justify-content-between">

            {/* Status tabs */}
            <ul className="nav nav--tabs p-1 rounded bg-light" role="tablist">
              {STATUSES.map(s => (
                <li key={s} className="nav-item">
                  <button className={`nav-link${status === s ? " active" : ""}`}
                    onClick={() => { setStatus(s); setPage(1); }}
                    data-testid={`tab-${s}`}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                </li>
              ))}
            </ul>

            <div className="d-flex gap-2 align-items-center">
              {/* Type filter */}
              <div className="btn-group btn-group-sm">
                {["all","ride","parcel"].map(t => (
                  <button key={t}
                    className={`btn ${typeFilter === t ? "btn-primary" : "btn-outline-secondary"}`}
                    style={{ fontSize: 12 }}
                    onClick={() => { setTypeFilter(t); setPage(1); }}
                    data-testid={`filter-type-${t}`}>
                    {t === "all" ? "All Types" : t === "ride" ? "🚗 Rides" : "📦 Parcels"}
                  </button>
                ))}
              </div>

              {/* Search */}
              <form className="search-form search-form_style-two" onSubmit={e => { e.preventDefault(); setPage(1); }}>
                <div className="input-group search-form__input_group">
                  <span className="search-form__icon"><i className="bi bi-search"></i></span>
                  <input type="search" className="theme-input-style search-form__input"
                    placeholder="Search Trip ID…" value={search}
                    onChange={e => { setSearch(e.target.value); setPage(1); }}
                    data-testid="input-search" />
                </div>
                <button type="submit" className="btn btn-primary" data-testid="btn-search">Search</button>
              </form>
            </div>
          </div>
        </div>

        <div className="card-body p-0">
          <div className="table-responsive">
            <table className="table table-borderless align-middle table-hover mb-0">
              <thead style={{ background: "#f8fafc" }}>
                <tr>
                  {["#","Trip ID","Customer","Route","Vehicle","Type","Fare","Payment","Status","Date",""].map((h, i) => (
                    <th key={i} className={i === 0 ? "ps-4" : i === 10 ? "text-center pe-4" : ""}
                      style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".5px", whiteSpace: "nowrap" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array(8).fill(0).map((_, i) => (
                    <tr key={i}>{Array(11).fill(0).map((_, j) => (
                      <td key={j}><div style={{ height: 14, background: "#f1f5f9", borderRadius: 4 }} /></td>
                    ))}</tr>
                  ))
                ) : data?.data?.length ? (
                  data.data.filter((item: any) => item?.trip).map((item: any, idx: number) => {
                    const st = item.trip?.currentStatus || "pending";
                    const sc = STATUS_CONFIG[st] || { cls: "bg-secondary", dot: "#64748b" };
                    const tc = TYPE_CONFIG[item.trip?.type] || TYPE_CONFIG["ride"];
                    const name = item.customer?.fullName || "—";
                    return (
                      <tr key={item.trip?.id || idx} data-testid={`trip-row-${item.trip?.id}`}>
                        <td className="ps-4 text-muted small">{(page - 1) * 15 + idx + 1}</td>
                        <td>
                          <span className="fw-bold small" style={{ color: "#1a73e8", fontFamily: "monospace" }}>{item.trip?.refId || "—"}</span>
                        </td>
                        <td>
                          <div className="d-flex align-items-center gap-2">
                            <div className="d-flex align-items-center justify-content-center rounded-circle flex-shrink-0"
                              style={{ width: 32, height: 32, background: avatarBg(name), color: "white", fontSize: 11, fontWeight: 700 }}>
                              {initials(name)}
                            </div>
                            <span style={{ fontSize: 13 }}>{name}</span>
                          </div>
                        </td>
                        <td style={{ maxWidth: 200 }}>
                          <div style={{ fontSize: 11, color: "#64748b" }}>
                            <span style={{ color: "#16a34a" }}>●</span> {item.trip?.pickupAddress || "—"}
                          </div>
                          <div style={{ fontSize: 11, color: "#64748b" }}>
                            <span style={{ color: "#dc2626" }}>●</span> {item.trip?.destinationAddress || "—"}
                          </div>
                        </td>
                        <td className="text-muted small">{item.vehicleCategory?.name || "—"}</td>
                        <td>
                          <span className="badge rounded-pill" style={{ background: tc.bg, color: tc.color, fontSize: 10, fontWeight: 600, padding: "4px 8px" }}>
                            {tc.icon} {tc.label}
                          </span>
                        </td>
                        <td>
                          <div className="fw-semibold small">₹{Number(item.trip?.actualFare || item.trip?.estimatedFare || 0).toFixed(0)}</div>
                          <div style={{ fontSize: 10, color: "#94a3b8" }}>{Number(item.trip?.estimatedDistance || 0).toFixed(1)} km</div>
                        </td>
                        <td>
                          <span className={`badge ${item.trip?.paymentStatus === "paid" ? "bg-success" : "bg-warning text-dark"}`} style={{ fontSize: 10 }}>
                            {item.trip?.paymentStatus === "paid" ? "✓ Paid" : "Unpaid"}
                          </span>
                        </td>
                        <td>
                          <span className={`badge ${sc.cls}`} style={{ fontSize: 10 }}>
                            {st ? st.charAt(0).toUpperCase() + st.slice(1) : "—"}
                          </span>
                        </td>
                        <td className="text-muted" style={{ fontSize: 12 }}>
                          {item.trip?.createdAt ? new Date(item.trip.createdAt).toLocaleDateString("en-IN") : "—"}
                        </td>
                        <td className="text-center pe-4">
                          {(st === "pending" || st === "accepted") && (
                            <button className="btn btn-sm btn-outline-danger rounded-pill px-3"
                              style={{ fontSize: 11 }}
                              onClick={() => updateStatus.mutate({ id: item.trip?.id, newStatus: "cancelled" })}
                              data-testid={`btn-cancel-${item.trip?.id}`}>
                              Cancel
                            </button>
                          )}
                          {st === "ongoing" && (
                            <span className="badge bg-info-subtle text-info" style={{ fontSize: 10 }}>
                              <i className="bi bi-broadcast me-1"></i>Live
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr><td colSpan={11}>
                    <div className="text-center py-5 text-muted">
                      <i className="bi bi-car-front fs-1 d-block mb-2" style={{ opacity: 0.3 }}></i>
                      <p className="fw-semibold mb-1">No trips found</p>
                      <p className="small">Try changing the filter or search term</p>
                    </div>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {totalPages > 1 && (
          <div className="card-footer bg-white border-0 py-3 px-4 d-flex align-items-center justify-content-between">
            <div className="text-muted small">Showing page {page} of {totalPages}</div>
            <div className="d-flex gap-1">
              <button className="btn btn-sm btn-outline-secondary" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                <i className="bi bi-chevron-left"></i>
              </button>
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => i + 1).map(p => (
                <button key={p} className={`btn btn-sm ${p === page ? "btn-primary" : "btn-outline-secondary"}`}
                  onClick={() => setPage(p)}>{p}</button>
              ))}
              <button className="btn btn-sm btn-outline-secondary" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                <i className="bi bi-chevron-right"></i>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
