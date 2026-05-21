import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

const avatarBg = (name: string) => {
  const colors = ["#1a73e8", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#dc2626"];
  return colors[(name || "A").charCodeAt(0) % colors.length];
};

const initials = (name: string) =>
  (name || "?")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .substring(0, 2)
    .toUpperCase();

const STATUS_CONFIG: Record<string, { cls: string }> = {
  completed: { cls: "bg-success" },
  ongoing: { cls: "bg-info" },
  pending: { cls: "bg-warning text-dark" },
  cancelled: { cls: "bg-danger" },
  accepted: { cls: "bg-primary" },
  searching: { cls: "bg-warning text-dark" },
  driver_assigned: { cls: "bg-primary" },
  arrived: { cls: "bg-info" },
  on_the_way: { cls: "bg-info" },
};

const TYPE_CONFIG: Record<string, { label: string; icon: string; bg: string; color: string }> = {
  ride: { label: "Ride", icon: "🚗", bg: "#eff6ff", color: "#1E5FCC" },
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
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: "15" });
      if (status !== "all") params.set("status", status);
      if (search) params.set("search", search);
      if (typeFilter !== "all") params.set("type", typeFilter);

      const response = await fetch(`/api/trips?${params.toString()}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.message || "Error");
      }

      const body = await response.json();
      return body?.data ? body : { data: Array.isArray(body) ? body : [], total: 0 };
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
      <style>{`
        .jago-trips-toolbar {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          align-items: center;
          justify-content: space-between;
        }
        .jago-trips-controls {
          display: flex;
          flex: 1 1 420px;
          flex-wrap: wrap;
          gap: 12px;
          align-items: center;
          justify-content: flex-end;
        }
        .jago-trips-search {
          display: flex;
          align-items: stretch;
          gap: 10px;
          flex-wrap: wrap;
          flex: 1 1 360px;
          min-width: 280px;
          margin: 0;
        }
        .jago-trips-search .search-form__input_group {
          flex: 1 1 240px;
          min-width: 0;
          height: 48px;
          background: #fff;
          border-radius: 14px;
        }
        .jago-trips-search .search-form__input {
          width: 100%;
          min-width: 0;
          padding-right: 12px;
        }
        .jago-trips-search .btn {
          height: 48px;
          padding-inline: 22px;
          white-space: nowrap;
          border-radius: 14px;
        }
        .jago-trips-table {
          table-layout: fixed;
          min-width: 1180px;
        }
        .jago-trips-table thead th {
          vertical-align: middle;
          border-bottom: 1px solid #e8eef6;
        }
        .jago-trips-table tbody td {
          vertical-align: middle;
          padding-top: 16px;
          padding-bottom: 16px;
          border-top: 1px solid #eef3f8;
        }
        .jago-trips-table tbody tr:first-child td {
          border-top: none;
        }
        .jago-trips-table .trip-ref {
          color: #1a73e8;
          font-family: monospace;
          font-size: 13px;
          font-weight: 700;
          word-break: break-word;
        }
        .jago-trips-table .route-line {
          display: flex;
          align-items: flex-start;
          gap: 6px;
          font-size: 11px;
          color: #64748b;
          line-height: 1.45;
          white-space: normal;
          word-break: break-word;
          overflow-wrap: anywhere;
        }
        .jago-trips-table .route-dot {
          flex: 0 0 auto;
          margin-top: 2px;
          font-size: 10px;
          line-height: 1;
        }
        .jago-trips-table .vehicle-cell {
          font-size: 13px;
          color: #334155;
          font-weight: 600;
          white-space: normal;
          word-break: break-word;
          overflow-wrap: anywhere;
        }
        .jago-trips-table .type-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          max-width: 100%;
          white-space: nowrap;
        }
        .jago-trips-table .fare-block {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        @media (max-width: 991px) {
          .jago-trips-controls {
            justify-content: stretch;
          }
          .jago-trips-search {
            min-width: 100%;
          }
          .jago-trips-search .btn {
            width: 100%;
          }
        }
      `}</style>

      <div className="d-flex align-items-center justify-content-between mb-4">
        <div>
          <h4 className="mb-0 fw-bold" data-testid="page-title">
            Trip Management
          </h4>
          <div className="text-muted small">All ride and parcel delivery trips</div>
        </div>
        <div className="d-flex align-items-center gap-2">
          <span className="text-muted small">Total:</span>
          <span className="fw-bold text-primary fs-5" data-testid="total-count">
            {data?.total || 0}
          </span>
        </div>
      </div>

      <div className="card border-0 shadow-sm" style={{ borderRadius: 14 }}>
        <div className="card-header bg-white py-3 px-4" style={{ borderBottom: "1px solid #f1f5f9" }}>
          <div className="jago-trips-toolbar">
            <ul className="nav nav--tabs p-1 rounded bg-light" role="tablist">
              {STATUSES.map((entry) => (
                <li key={entry} className="nav-item">
                  <button
                    className={`nav-link${status === entry ? " active" : ""}`}
                    onClick={() => {
                      setStatus(entry);
                      setPage(1);
                    }}
                    data-testid={`tab-${entry}`}
                  >
                    {entry.charAt(0).toUpperCase() + entry.slice(1)}
                  </button>
                </li>
              ))}
            </ul>

            <div className="jago-trips-controls">
              <div className="btn-group btn-group-sm">
                {["all", "ride", "parcel"].map((entry) => (
                  <button
                    key={entry}
                    className={`btn ${typeFilter === entry ? "btn-primary" : "btn-outline-secondary"}`}
                    style={{ fontSize: 12 }}
                    onClick={() => {
                      setTypeFilter(entry);
                      setPage(1);
                    }}
                    data-testid={`filter-type-${entry}`}
                  >
                    {entry === "all" ? "All Types" : entry === "ride" ? "🚗 Rides" : "📦 Parcels"}
                  </button>
                ))}
              </div>

              <form
                className="search-form search-form_style-two jago-trips-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  setPage(1);
                }}
              >
                <div className="input-group search-form__input_group">
                  <span className="search-form__icon">
                    <i className="bi bi-search"></i>
                  </span>
                  <input
                    type="search"
                    className="theme-input-style search-form__input"
                    placeholder="Search Trip ID..."
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setPage(1);
                    }}
                    data-testid="input-search"
                  />
                </div>
                <button type="submit" className="btn btn-primary" data-testid="btn-search">
                  Search
                </button>
              </form>
            </div>
          </div>
        </div>

        <div className="card-body p-0">
          <div className="table-responsive">
            <table className="table table-borderless align-middle table-hover mb-0 jago-trips-table">
              <colgroup>
                <col style={{ width: "5%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "28%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "8%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "9%" }} />
              </colgroup>
              <thead style={{ background: "#f8fafc" }}>
                <tr>
                  {["#", "Trip ID", "Customer", "Route", "Vehicle", "Type", "Fare", "Payment", "Status", "Date", ""].map(
                    (heading, index) => (
                      <th
                        key={index}
                        className={index === 0 ? "ps-4" : index === 10 ? "text-center pe-4" : ""}
                        style={{
                          fontSize: 11,
                          color: "#475569",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: ".5px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array.from({ length: 8 }).map((_, rowIndex) => (
                    <tr key={rowIndex}>
                      {Array.from({ length: 11 }).map((__, colIndex) => (
                        <td key={colIndex}>
                          <div style={{ height: 14, background: "#f1f5f9", borderRadius: 4 }} />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : data?.data?.length ? (
                  data.data
                    .filter((item: any) => item?.trip)
                    .map((item: any, idx: number) => {
                      const trip = item.trip || {};
                      const st = trip.currentStatus || "pending";
                      const sc = STATUS_CONFIG[st] || { cls: "bg-secondary" };
                      const tc = TYPE_CONFIG[trip.type] || TYPE_CONFIG.ride;
                      const name = item.customer?.fullName || "-";
                      const fare = Number(trip.actualFare || trip.estimatedFare || 0).toFixed(0);
                      const distance = Number(trip.estimatedDistance || 0).toFixed(1);

                      return (
                        <tr key={trip.id || idx} data-testid={`trip-row-${trip.id}`}>
                          <td className="ps-4 text-muted small">{(page - 1) * 15 + idx + 1}</td>
                          <td>
                            <span className="trip-ref">{trip.refId || "-"}</span>
                          </td>
                          <td>
                            <div className="d-flex align-items-center gap-2">
                              <div
                                className="d-flex align-items-center justify-content-center rounded-circle flex-shrink-0"
                                style={{
                                  width: 40,
                                  height: 40,
                                  background: avatarBg(name),
                                  color: "white",
                                  fontSize: 11,
                                  fontWeight: 700,
                                }}
                              >
                                {initials(name)}
                              </div>
                              <span style={{ fontSize: 13 }}>{name}</span>
                            </div>
                          </td>
                          <td>
                            <div className="route-line">
                              <span className="route-dot" style={{ color: "#16a34a" }}>
                                ●
                              </span>
                              <span>{trip.pickupAddress || "-"}</span>
                            </div>
                            <div className="route-line">
                              <span className="route-dot" style={{ color: "#dc2626" }}>
                                ●
                              </span>
                              <span>{trip.destinationAddress || "-"}</span>
                            </div>
                          </td>
                          <td className="vehicle-cell">{item.vehicleCategory?.name || "-"}</td>
                          <td>
                            <span
                              className="badge rounded-pill type-badge"
                              style={{
                                background: tc.bg,
                                color: tc.color,
                                fontSize: 10,
                                fontWeight: 600,
                                padding: "4px 8px",
                              }}
                            >
                              {tc.icon} {tc.label}
                            </span>
                          </td>
                          <td>
                            <div className="fare-block">
                              <div className="fw-semibold small">₹{fare}</div>
                              <div style={{ fontSize: 10, color: "#94a3b8" }}>{distance} km</div>
                            </div>
                          </td>
                          <td>
                            <span
                              className={`badge ${trip.paymentStatus === "paid" ? "bg-success" : "bg-warning text-dark"}`}
                              style={{ fontSize: 10 }}
                            >
                              {trip.paymentStatus === "paid" ? "Paid" : "Unpaid"}
                            </span>
                          </td>
                          <td>
                            <span className={`badge ${sc.cls}`} style={{ fontSize: 10 }}>
                              {st ? st.charAt(0).toUpperCase() + st.slice(1) : "-"}
                            </span>
                          </td>
                          <td className="text-muted" style={{ fontSize: 12 }}>
                            {trip.createdAt ? new Date(trip.createdAt).toLocaleDateString("en-IN") : "-"}
                          </td>
                          <td className="text-center pe-4">
                            {(st === "pending" || st === "accepted") && (
                              <button
                                className="btn btn-sm btn-outline-danger rounded-pill px-3"
                                style={{ fontSize: 11 }}
                                onClick={() => updateStatus.mutate({ id: trip.id, newStatus: "cancelled" })}
                                data-testid={`btn-cancel-${trip.id}`}
                              >
                                Cancel
                              </button>
                            )}
                            {st === "ongoing" && (
                              <span className="badge bg-info-subtle text-info" style={{ fontSize: 10 }}>
                                <i className="bi bi-broadcast me-1"></i>
                                Live
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                ) : (
                  <tr>
                    <td colSpan={11}>
                      <div className="text-center py-5 text-muted">
                        <i className="bi bi-car-front fs-1 d-block mb-2" style={{ opacity: 0.3 }}></i>
                        <p className="fw-semibold mb-1">No trips found</p>
                        <p className="small">Try changing the filter or search term</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {totalPages > 1 && (
          <div className="card-footer bg-white border-0 py-3 px-4 d-flex align-items-center justify-content-between">
            <div className="text-muted small">
              Showing page {page} of {totalPages}
            </div>
            <div className="d-flex gap-1">
              <button
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page === 1}
              >
                <i className="bi bi-chevron-left"></i>
              </button>
              {Array.from({ length: Math.min(5, totalPages) }, (_, index) => index + 1).map((entry) => (
                <button
                  key={entry}
                  className={`btn btn-sm ${entry === page ? "btn-primary" : "btn-outline-secondary"}`}
                  onClick={() => setPage(entry)}
                >
                  {entry}
                </button>
              ))}
              <button
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={page === totalPages}
              >
                <i className="bi bi-chevron-right"></i>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
