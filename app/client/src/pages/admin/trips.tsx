import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { adminFetch, apiRequest } from "@/lib/queryClient";

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

const STATUS_CONFIG: Record<string, { cls: string; label: string }> = {
  completed: { cls: "bg-success", label: "Completed" },
  ongoing: { cls: "bg-info", label: "Ongoing" },
  pending: { cls: "bg-warning text-dark", label: "Pending" },
  cancelled: { cls: "bg-danger", label: "Cancelled" },
  accepted: { cls: "bg-primary", label: "Accepted" },
  searching: { cls: "bg-warning text-dark", label: "Searching" },
  driver_assigned: { cls: "bg-primary", label: "Driver Assigned" },
  arrived: { cls: "bg-info", label: "Arrived" },
  on_the_way: { cls: "bg-info", label: "On The Way" },
};

const TYPE_CONFIG: Record<string, { label: string; icon: string; bg: string; color: string }> = {
  ride: { label: "Ride", icon: "bi-car-front-fill", bg: "#eff6ff", color: "#1E5FCC" },
  parcel: { label: "Parcel", icon: "bi-box-seam-fill", bg: "#f0fdf4", color: "#16a34a" },
};

const STATUSES = ["all", "pending", "accepted", "ongoing", "completed", "cancelled"];

function formatTripDate(value: string | undefined) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleDateString("en-IN");
  } catch {
    return "-";
  }
}

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

      const response = await adminFetch(`/api/trips?${params.toString()}`);
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
        .jago-trips-page {
          gap: 18px;
        }
        .jago-trips-page .card-body.p-0 > .table-responsive,
        .jago-trips-page .table-responsive {
          max-height: none !important;
          overflow: auto !important;
        }
        .jago-trips-page .table thead th {
          position: static !important;
          top: auto !important;
          z-index: auto !important;
          box-shadow: inset 0 -1px 0 rgba(226, 232, 240, 0.95) !important;
        }
        .jago-trips-page .table tbody tr {
          border-bottom: 1px solid #eef2f7;
        }
        .jago-trips-page .table tbody td {
          vertical-align: top;
          padding-top: 18px;
          padding-bottom: 18px;
        }
        .jago-trips-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }
        .jago-trips-toolbar .nav {
          flex: 1 1 560px;
        }
        .jago-trips-toolbar-right {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          flex: 1 1 420px;
          gap: 12px;
          flex-wrap: wrap;
          min-width: 0;
        }
        .jago-trips-type-group {
          display: inline-flex;
          flex-wrap: wrap;
        }
        .jago-trips-search {
          display: flex;
          align-items: stretch;
          gap: 10px;
          flex: 1 1 340px;
          flex-wrap: wrap;
          min-width: 280px;
        }
        .jago-trips-search .search-form__input_group {
          flex: 1 1 240px;
          min-width: 0;
        }
        .jago-trips-search .btn {
          min-height: 46px;
          padding-inline: 20px;
          white-space: nowrap;
        }
        .jago-trips-table {
          table-layout: fixed;
          min-width: 1180px;
        }
        .jago-trips-table thead th {
          white-space: nowrap;
        }
        .jago-trips-table .trip-ref {
          color: #2563eb;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 13px;
          font-weight: 700;
          word-break: break-word;
        }
        .jago-trips-table .customer-name {
          font-size: 13px;
          color: #0f172a;
          font-weight: 600;
        }
        .jago-trips-table .route-stack {
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-width: 0;
          padding-right: 6px;
        }
        .jago-trips-table .route-line {
          display: grid;
          grid-template-columns: 8px minmax(0, 1fr);
          gap: 8px;
          align-items: flex-start;
          font-size: 12px;
          color: #64748b;
          line-height: 1.45;
        }
        .jago-trips-table .route-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          margin-top: 5px;
        }
        .jago-trips-table .route-text,
        .jago-trips-table .vehicle-cell {
          white-space: normal;
          word-break: break-word;
          overflow-wrap: anywhere;
        }
        .jago-trips-table .vehicle-cell {
          font-size: 13px;
          color: #334155;
          font-weight: 600;
        }
        .jago-trips-table .type-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 700;
          white-space: nowrap;
        }
        .jago-trips-table .type-badge i {
          font-size: 11px;
        }
        .jago-trips-table .fare-block {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .jago-trips-table .fare-primary {
          color: #0f172a;
          font-weight: 700;
          font-size: 13px;
        }
        .jago-trips-table .fare-secondary {
          color: #94a3b8;
          font-size: 10px;
        }
        @media (max-width: 991px) {
          .jago-trips-toolbar .nav {
            width: 100%;
          }
          .jago-trips-toolbar-right,
          .jago-trips-search {
            width: 100%;
          }
          .jago-trips-search .btn {
            width: 100%;
          }
          .jago-trips-type-group {
            width: 100%;
          }
          .jago-trips-type-group > .btn {
            flex: 1 1 140px;
          }
        }
      `}</style>

      <div className="jago-trips-page">
        <div className="d-flex align-items-center justify-content-between mb-0">
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

        <div className="card border-0 shadow-sm" style={{ borderRadius: 16 }}>
          <div className="card-header bg-white py-3 px-4">
            <div className="jago-trips-toolbar">
              <ul className="nav nav--tabs p-1 rounded bg-light mb-0" role="tablist">
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

              <div className="jago-trips-toolbar-right">
                <div className="btn-group btn-group-sm jago-trips-type-group">
                  {[
                    { key: "all", label: "All Types" },
                    { key: "ride", label: "Ride Trips" },
                    { key: "parcel", label: "Parcel Trips" },
                  ].map((entry) => (
                    <button
                      key={entry.key}
                      className={`btn ${typeFilter === entry.key ? "btn-primary" : "btn-outline-secondary"}`}
                      style={{ fontSize: 12 }}
                      onClick={() => {
                        setTypeFilter(entry.key);
                        setPage(1);
                      }}
                      data-testid={`filter-type-${entry.key}`}
                    >
                      {entry.label}
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
                      placeholder="Search Trip ID"
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
                <thead>
                  <tr>
                    {["#", "Trip ID", "Customer", "Route", "Vehicle", "Type", "Fare", "Payment", "Status", "Date", ""].map(
                      (heading, index) => (
                        <th
                          key={index}
                          className={index === 0 ? "ps-4" : index === 10 ? "text-center pe-4" : ""}
                          style={{ whiteSpace: "nowrap" }}
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
                        const sc = STATUS_CONFIG[st] || { cls: "bg-secondary", label: st || "Unknown" };
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
                                <span className="customer-name">{name}</span>
                              </div>
                            </td>
                            <td>
                              <div className="route-stack">
                                <div className="route-line">
                                  <span className="route-dot" style={{ background: "#16a34a" }}></span>
                                  <span className="route-text">{trip.pickupAddress || "-"}</span>
                                </div>
                                <div className="route-line">
                                  <span className="route-dot" style={{ background: "#dc2626" }}></span>
                                  <span className="route-text">{trip.destinationAddress || "-"}</span>
                                </div>
                              </div>
                            </td>
                            <td className="vehicle-cell">{item.vehicleCategory?.name || "-"}</td>
                            <td>
                              <span
                                className="type-badge"
                                style={{
                                  background: tc.bg,
                                  color: tc.color,
                                }}
                              >
                                <i className={`bi ${tc.icon}`}></i>
                                {tc.label}
                              </span>
                            </td>
                            <td>
                              <div className="fare-block">
                                <div className="fare-primary">Rs. {fare}</div>
                                <div className="fare-secondary">{distance} km</div>
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
                                {sc.label}
                              </span>
                            </td>
                            <td className="text-muted" style={{ fontSize: 12 }}>
                              {formatTripDate(trip.createdAt)}
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
    </div>
  );
}
