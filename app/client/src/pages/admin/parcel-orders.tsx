import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminFetch } from "@/lib/queryClient";

interface ParcelOrder {
  id: string;
  customer_name: string;
  customer_phone: string;
  driver_name: string | null;
  driver_phone: string | null;
  vehicle_category: string;
  pickup_address: string;
  drop_locations: any[];
  total_distance_km: number;
  weight_kg: number;
  total_fare: number;
  commission_amt: number;
  current_status: string;
  current_drop_index: number;
  is_b2b: boolean;
  payment_method: string;
  payment_status: string;
  created_at: string;
}

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string }> = {
  pending:         { label: "Pending",         bg: "rgba(243,156,18,0.15)",  color: "#F39C12" },
  searching:       { label: "Searching",       bg: "rgba(47,123,255,0.15)",  color: "#2F7BFF" },
  driver_assigned: { label: "Driver Assigned", bg: "rgba(74,144,226,0.15)",  color: "#4A90E2" },
  in_transit:      { label: "In Transit",      bg: "rgba(16,185,129,0.15)",  color: "#10B981" },
  completed:       { label: "Completed",       bg: "rgba(46,204,113,0.15)",  color: "#2ECC71" },
  cancelled:       { label: "Cancelled",       bg: "rgba(231,76,60,0.15)",   color: "#E74C3C" },
};

const VEHICLE_LABELS: Record<string, string> = {
  bike_parcel:  "Bike Parcel",
  auto_parcel:  "Auto Parcel",
  tata_ace:     "Tata Ace",
  bolero_cargo: "Bolero Cargo",
  pickup_truck: "Pickup Truck",
  tempo_407:    "Tempo 407",
};

interface DetailModalProps { order: ParcelOrder; onClose: () => void }

function DetailModal({ order, onClose }: DetailModalProps) {
  const drops: any[] = Array.isArray(order.drop_locations)
    ? order.drop_locations
    : (typeof order.drop_locations === "string" ? (() => { try { return JSON.parse(order.drop_locations); } catch { return []; } })() : []);
  const sc = STATUS_CONFIG[order.current_status] ?? { label: order.current_status, bg: "#F3F4F6", color: "#6B7280" };

  return (
    <div className="modal-backdrop-jago" onClick={onClose}>
      <div className="modal-jago" style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()}>
        <div className="modal-jago-header">
          <h5 className="modal-jago-title">
            <i className="bi bi-box-seam-fill me-2 text-primary" />
            Parcel Order Detail
          </h5>
          <button className="modal-jago-close" onClick={onClose}><i className="bi bi-x-lg" /></button>
        </div>

        <div className="row g-3">
          <div className="col-12">
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontFamily: "monospace", fontSize: 12, color: "#6B7280" }}>#{order.id.slice(0, 8).toUpperCase()}</span>
              <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: sc.bg, color: sc.color }}>{sc.label}</span>
              {order.is_b2b && <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: "rgba(139,92,246,0.15)", color: "#8B5CF6" }}>B2B</span>}
            </div>
          </div>

          <div className="col-6">
            <div className="jago-detail-label">Customer</div>
            <div className="jago-detail-value">{order.customer_name || "—"}</div>
            <div style={{ fontSize: 12, color: "#6B7280" }}>{order.customer_phone || "—"}</div>
          </div>
          <div className="col-6">
            <div className="jago-detail-label">Driver</div>
            <div className="jago-detail-value">{order.driver_name || "Not assigned"}</div>
            {order.driver_phone && <div style={{ fontSize: 12, color: "#6B7280" }}>{order.driver_phone}</div>}
          </div>

          <div className="col-12">
            <div className="jago-detail-label">Vehicle</div>
            <div className="jago-detail-value">{VEHICLE_LABELS[order.vehicle_category] || order.vehicle_category}</div>
          </div>

          <div className="col-12">
            <div className="jago-detail-label">Pickup Location</div>
            <div style={{ background: "#F0FDF4", borderRadius: 10, padding: "10px 14px", borderLeft: "3px solid #2ECC71" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                <i className="bi bi-geo-alt-fill me-2 text-success" />Pickup
              </div>
              <div style={{ fontSize: 13, color: "#374151" }}>{order.pickup_address}</div>
            </div>
          </div>

          <div className="col-12">
            <div className="jago-detail-label">Drop Locations ({drops.length} stop{drops.length !== 1 ? "s" : ""})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {drops.map((d: any, i: number) => (
                <div key={i} style={{
                  background: d.delivered_at ? "rgba(46,204,113,0.08)" : i === order.current_drop_index && order.current_status === "in_transit" ? "rgba(47,123,255,0.08)" : "#F9FAFB",
                  borderRadius: 10, padding: "10px 14px",
                  borderLeft: `3px solid ${d.delivered_at ? "#2ECC71" : i === order.current_drop_index ? "#2F7BFF" : "#E5E7EB"}`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>
                      Stop {i + 1} {d.receiverName ? `— ${d.receiverName}` : ""}
                    </div>
                    {d.delivered_at
                      ? <span style={{ fontSize: 10, fontWeight: 700, color: "#2ECC71" }}>✓ Delivered</span>
                      : i === order.current_drop_index && order.current_status === "in_transit"
                        ? <span style={{ fontSize: 10, fontWeight: 700, color: "#2F7BFF" }}>● Current</span>
                        : <span style={{ fontSize: 10, color: "#9CA3AF" }}>Pending</span>
                    }
                  </div>
                  <div style={{ fontSize: 12, color: "#6B7280" }}>{d.address}</div>
                  {d.receiverPhone && <div style={{ fontSize: 11, color: "#9CA3AF" }}>{d.receiverPhone}</div>}
                </div>
              ))}
            </div>
          </div>

          <div className="col-4">
            <div className="jago-detail-label">Distance</div>
            <div className="jago-detail-value">{order.total_distance_km} km</div>
          </div>
          <div className="col-4">
            <div className="jago-detail-label">Weight</div>
            <div className="jago-detail-value">{order.weight_kg} kg</div>
          </div>
          <div className="col-4">
            <div className="jago-detail-label">Payment</div>
            <div className="jago-detail-value" style={{ textTransform: "capitalize" }}>{order.payment_method}</div>
          </div>

          <div className="col-12">
            <div style={{ background: "linear-gradient(135deg,#2F7BFF,#4A90E2)", borderRadius: 14, padding: "14px 18px", color: "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 2 }}>Total Fare</div>
                  <div style={{ fontSize: 24, fontWeight: 800 }}>&#8377;{order.total_fare}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 2 }}>Commission Earned</div>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>&#8377;{order.commission_amt}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ParcelOrdersPage() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [b2bOnly, setB2bOnly] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<ParcelOrder | null>(null);

  const { data, isLoading } = useQuery<{ orders: ParcelOrder[] }>({
    queryKey: ["/api/admin/parcel-orders", statusFilter, b2bOnly],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (b2bOnly) params.set("b2b", "true");
      const r = await adminFetch(`/api/admin/parcel-orders?${params}`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const orders = data?.orders ?? [];

  const stats = {
    total:     orders.length,
    searching: orders.filter(o => o.current_status === "searching").length,
    inTransit: orders.filter(o => o.current_status === "in_transit").length,
    completed: orders.filter(o => o.current_status === "completed").length,
    revenue:   orders.filter(o => o.current_status === "completed").reduce((s, o) => s + Number(o.commission_amt), 0),
  };

  return (
      <div style={{ padding: "28px 32px", maxWidth: 1200 }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: "linear-gradient(135deg,#FF6B35,#F59E0B)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 14px rgba(255,107,53,0.35)" }}>
            <i className="bi bi-box-seam-fill" style={{ color: "#fff", fontSize: 22 }} />
          </div>
          <div>
            <h4 style={{ fontWeight: 800, margin: 0, letterSpacing: -0.3, fontSize: 20 }}>Parcel Orders</h4>
            <p style={{ margin: 0, fontSize: 13, color: "#6B7280" }}>Multi-drop Porter-style deliveries · B2B bulk orders · real-time tracking</p>
          </div>
        </div>

        {/* KPI row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14, marginBottom: 24 }}>
          {[
            { label: "Total Orders", value: stats.total,     icon: "bi-box-seam",       color: "#2F7BFF" },
            { label: "Searching",    value: stats.searching, icon: "bi-search",          color: "#F39C12" },
            { label: "In Transit",   value: stats.inTransit, icon: "bi-truck",           color: "#10B981" },
            { label: "Completed",    value: stats.completed, icon: "bi-check-circle",    color: "#2ECC71" },
            { label: "Commission",   value: `\u20b9${stats.revenue}`, icon: "bi-coin", color: "#8B5CF6" },
          ].map(s => (
            <div key={s.label} className="jago-stat-card" style={{ "--stat-accent": s.color } as any}>
              <div className="stat-icon" style={{ background: `${s.color}18`, color: s.color }}>
                <i className={`bi ${s.icon}`} />
              </div>
              <div>
                <div className="stat-value">{s.value}</div>
                <div className="stat-label">{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {["all", "searching", "driver_assigned", "in_transit", "completed", "cancelled"].map(s => (
              <button key={s} onClick={() => setStatusFilter(s)} style={{
                padding: "6px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
                background: statusFilter === s ? "linear-gradient(135deg,#2F7BFF,#4A90E2)" : "#F3F4F6",
                color: statusFilter === s ? "#fff" : "#6B7280",
                border: "none",
              }}>
                {s === "all" ? "All" : STATUS_CONFIG[s]?.label ?? s}
              </button>
            ))}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", marginLeft: "auto" }}>
            <input type="checkbox" checked={b2bOnly} onChange={e => setB2bOnly(e.target.checked)} />
            B2B only
          </label>
        </div>

        {/* Table */}
        {isLoading ? (
          <div style={{ textAlign: "center", padding: 60 }}><div className="spinner-border" style={{ color: "#FF6B35" }} /></div>
        ) : orders.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#9CA3AF" }}>
            <i className="bi bi-inbox" style={{ fontSize: 48, display: "block", marginBottom: 12 }} />
            No parcel orders found
          </div>
        ) : (
          <div className="admin-table-wrapper">
            <table className="jago-table">
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Customer</th>
                  <th>Vehicle</th>
                  <th>Stops</th>
                  <th>Distance</th>
                  <th>Fare</th>
                  <th>Status</th>
                  <th>Type</th>
                  <th>Date</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {orders.map(order => {
                  const sc = STATUS_CONFIG[order.current_status] ?? { label: order.current_status, bg: "#F3F4F6", color: "#6B7280" };
                  const drops: any[] = Array.isArray(order.drop_locations)
                    ? order.drop_locations
                    : (typeof order.drop_locations === "string" ? JSON.parse(order.drop_locations || "[]") : []);
                  const delivered = drops.filter(d => d.delivered_at).length;
                  return (
                    <tr key={order.id}>
                      <td>
                        <span style={{ fontFamily: "monospace", fontSize: 12, color: "#6B7280" }}>
                          #{order.id.slice(0, 8).toUpperCase()}
                        </span>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{order.customer_name || "—"}</div>
                        <div style={{ fontSize: 11, color: "#9CA3AF" }}>{order.customer_phone}</div>
                      </td>
                      <td style={{ fontSize: 13 }}>{VEHICLE_LABELS[order.vehicle_category] || order.vehicle_category}</td>
                      <td>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>
                          {drops.length > 0 ? `${delivered}/${drops.length} done` : "—"}
                        </span>
                      </td>
                      <td style={{ fontSize: 13 }}>{order.total_distance_km} km</td>
                      <td>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>&#8377;{order.total_fare}</div>
                        <div style={{ fontSize: 11, color: "#9CA3AF" }}>Comm: &#8377;{order.commission_amt}</div>
                      </td>
                      <td>
                        <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: sc.bg, color: sc.color }}>
                          {sc.label}
                        </span>
                      </td>
                      <td>
                        {order.is_b2b
                          ? <span style={{ padding: "3px 8px", borderRadius: 20, fontSize: 10, fontWeight: 700, background: "rgba(139,92,246,0.15)", color: "#8B5CF6" }}>B2B</span>
                          : <span style={{ fontSize: 11, color: "#9CA3AF" }}>Direct</span>}
                      </td>
                      <td style={{ fontSize: 12, color: "#9CA3AF" }}>
                        {new Date(order.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                      </td>
                      <td>
                        <button onClick={() => setSelectedOrder(order)} className="btn btn-sm btn-outline-primary" style={{ fontSize: 11 }}>
                          View
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {selectedOrder && <DetailModal order={selectedOrder} onClose={() => setSelectedOrder(null)} />}
      </div>
  );
}
