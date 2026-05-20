import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface PlatformService {
  id: string;
  service_key: string;
  service_name: string;
  service_category: string;
  service_status: "active" | "inactive";
  revenue_model: "subscription" | "commission" | "hybrid";
  commission_rate: number;
  sort_order: number;
  icon: string;
  color: string;
  description: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  rides: "Ride Services",
  carpool: "Car Pool",
  parcel: "Parcel & Logistics",
};

const MODEL_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  subscription: { bg: "rgba(47,123,255,0.12)", text: "#2F7BFF", label: "Subscription" },
  commission:   { bg: "rgba(255,107,53,0.12)",  text: "#FF6B35", label: "Commission"   },
  hybrid:       { bg: "rgba(139,92,246,0.12)", text: "#8B5CF6", label: "Hybrid"        },
};

const LAUNCH_FIRST = ["bike_ride", "parcel_delivery"];

export default function ServiceManagement() {
  const queryClient = useQueryClient();
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [modelForm, setModelForm] = useState<{ revenue_model: string; commission_rate: string }>({
    revenue_model: "commission", commission_rate: "15",
  });

  const { data: services = [], isLoading } = useQuery<PlatformService[]>({
    queryKey: ["/api/platform-services"],
    queryFn: async () => {
      const r = await fetch("/api/platform-services");
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ key, current }: { key: string; current: "active" | "inactive" }) => {
      const r = await fetch(`/api/platform-services/${key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_status: current === "active" ? "inactive" : "active" }),
      });
      if (!r.ok) throw new Error("Failed to toggle");
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/platform-services"] }),
  });

  const modelMutation = useMutation({
    mutationFn: async ({ key, revenue_model, commission_rate }: { key: string; revenue_model: string; commission_rate: string }) => {
      const r = await fetch(`/api/platform-services/${key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revenue_model, commission_rate: parseFloat(commission_rate) }),
      });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    onSuccess: () => {
      setEditingModel(null);
      queryClient.invalidateQueries({ queryKey: ["/api/platform-services"] });
    },
  });

  const activeCount = services.filter(s => s.service_status === "active").length;
  const totalCount  = services.length;
  const pct = totalCount > 0 ? Math.round((activeCount / totalCount) * 100) : 0;

  const grouped = services.reduce<Record<string, PlatformService[]>>((acc, svc) => {
    const cat = svc.service_category;
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(svc);
    return acc;
  }, {});

  return (
      <div style={{ padding: "28px 32px", maxWidth: 1180 }}>

        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, background: "linear-gradient(135deg,#2F7BFF,#4A90E2)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 14px rgba(47,123,255,0.35)" }}>
              <i className="bi bi-toggles2" style={{ color: "#fff", fontSize: 22 }} />
            </div>
            <div>
              <h4 style={{ fontWeight: 800, margin: 0, letterSpacing: -0.3, fontSize: 20 }}>Service Management</h4>
              <p style={{ margin: 0, fontSize: 13, color: "#6B7280" }}>Activate/deactivate services � configure revenue model per service</p>
            </div>
          </div>
          <div style={{ background: "linear-gradient(135deg,#060D1E,#0D1B3E)", borderRadius: 16, padding: "14px 20px", minWidth: 220, border: "1px solid rgba(47,123,255,0.2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, fontWeight: 600 }}>Launch Readiness</span>
              <span style={{ color: "#2F7BFF", fontWeight: 800, fontSize: 14 }}>{activeCount}/{totalCount} Active</span>
            </div>
            <div style={{ background: "rgba(255,255,255,0.1)", borderRadius: 8, height: 8, overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg,#2F7BFF,#4A90E2)", borderRadius: 8, transition: "width .4s ease" }} />
            </div>
            <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 11, marginTop: 6, fontWeight: 500 }}>{pct}% services enabled</div>
          </div>
        </div>

        <div style={{ background: "linear-gradient(135deg,rgba(47,123,255,0.1),rgba(74,144,226,0.06))", border: "1px solid rgba(47,123,255,0.25)", borderRadius: 16, padding: "16px 20px", marginBottom: 28, display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 32 }}>??</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>Phase 1 Launch: Bike Ride + Parcel Delivery only</div>
            <div style={{ fontSize: 12, color: "#6B7280", lineHeight: 1.5 }}>
              Only these two services are active at launch. Enable additional services as your fleet grows.
              Each service supports an independent <strong>Subscription</strong> or <strong>Commission</strong> revenue model.
            </div>
          </div>
          <div style={{ padding: "6px 14px", borderRadius: 20, background: "linear-gradient(135deg,#2F7BFF,#4A90E2)", color: "#fff", fontWeight: 800, fontSize: 11, whiteSpace: "nowrap", boxShadow: "0 2px 10px rgba(47,123,255,0.35)" }}>?? Phase 1</div>
        </div>

        {isLoading ? (
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <div className="spinner-border" style={{ color: "#2F7BFF" }} />
            <p style={{ marginTop: 12, color: "#6B7280" }}>Loading services...</p>
          </div>
        ) : (
          Object.entries(grouped).map(([cat, catServices]) => (
            <div key={cat} style={{ marginBottom: 32 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#374151", textTransform: "uppercase", letterSpacing: 1.2 }}>{CATEGORY_LABELS[cat] ?? cat}</span>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#F3F4F6", color: "#6B7280" }}>
                  {catServices.filter(s => s.service_status === "active").length}/{catServices.length} active
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16 }}>
                {catServices.map(svc => {
                  const isActive = svc.service_status === "active";
                  const isLaunch = LAUNCH_FIRST.includes(svc.service_key);
                  const mdl = MODEL_COLORS[svc.revenue_model] ?? MODEL_COLORS.commission;
                  const editingThis = editingModel === svc.service_key;

                  return (
                    <div key={svc.service_key} style={{ background: "#fff", borderRadius: 20, overflow: "hidden", boxShadow: isActive ? `0 4px 24px ${svc.color}22, 0 1px 4px rgba(0,0,0,0.06)` : "0 2px 12px rgba(0,0,0,0.06)", border: isActive ? `1.5px solid ${svc.color}40` : "1.5px solid #F3F4F6", transition: "all .25s ease", position: "relative" }}>
                      <div style={{ height: 5, background: isActive ? `linear-gradient(90deg,${svc.color},${svc.color}99)` : "#E5E7EB" }} />
                      {isLaunch && (
                        <div style={{ position: "absolute", top: 14, right: 14, background: "linear-gradient(135deg,#2F7BFF,#4A90E2)", color: "#fff", fontSize: 9, fontWeight: 800, padding: "3px 8px", borderRadius: 8, letterSpacing: 0.5 }}>?? LAUNCH</div>
                      )}
                      <div style={{ padding: "20px 20px 16px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
                          <div style={{ width: 56, height: 56, borderRadius: 16, flexShrink: 0, background: isActive ? `linear-gradient(135deg,${svc.color},${svc.color}bb)` : "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: isActive ? `0 4px 14px ${svc.color}40` : "none", fontSize: 26 }}>
                            {svc.icon}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                              <span style={{ fontWeight: 800, fontSize: 15 }}>{svc.service_name}</span>
                              <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 700, background: isActive ? `${svc.color}18` : "#F3F4F6", color: isActive ? svc.color : "#9CA3AF", border: `1px solid ${isActive ? svc.color + "30" : "#E5E7EB"}` }}>
                                {isActive ? "? Active" : "? Inactive"}
                              </span>
                            </div>
                            <p style={{ margin: 0, fontSize: 12, color: "#6B7280", lineHeight: 1.4 }}>{svc.description}</p>
                          </div>
                        </div>

                        {!editingThis ? (
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: mdl.bg, borderRadius: 10, padding: "8px 12px", marginBottom: 12 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ fontSize: 12, fontWeight: 700, color: mdl.text }}>?? {mdl.label} Model</span>
                              {svc.revenue_model !== "subscription" && (
                                <span style={{ fontSize: 11, color: mdl.text, opacity: 0.85 }}>({svc.commission_rate}%)</span>
                              )}
                            </div>
                            <button onClick={() => { setModelForm({ revenue_model: svc.revenue_model, commission_rate: String(svc.commission_rate) }); setEditingModel(svc.service_key); }} style={{ fontSize: 10, fontWeight: 700, color: mdl.text, background: "transparent", border: `1px solid ${mdl.text}50`, borderRadius: 6, padding: "2px 8px", cursor: "pointer" }}>Edit</button>
                          </div>
                        ) : (
                          <div style={{ background: "#F9FAFB", borderRadius: 12, padding: "12px", marginBottom: 12 }}>
                            <div style={{ marginBottom: 8 }}>
                              <label style={{ fontSize: 11, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>Revenue Model</label>
                              <select value={modelForm.revenue_model} onChange={e => setModelForm(f => ({ ...f, revenue_model: e.target.value }))} style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid #E5E7EB", fontSize: 13 }}>
                                <option value="subscription">Subscription � drivers buy plans</option>
                                <option value="commission">Commission � % deducted per trip</option>
                                <option value="hybrid">Hybrid � both apply</option>
                              </select>
                            </div>
                            {modelForm.revenue_model !== "subscription" && (
                              <div style={{ marginBottom: 8 }}>
                                <label style={{ fontSize: 11, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>Commission Rate (%)</label>
                                <input type="number" min="0" max="50" step="0.5" value={modelForm.commission_rate} onChange={e => setModelForm(f => ({ ...f, commission_rate: e.target.value }))} style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid #E5E7EB", fontSize: 13 }} />
                              </div>
                            )}
                            <div style={{ display: "flex", gap: 8 }}>
                              <button onClick={() => modelMutation.mutate({ key: svc.service_key, ...modelForm })} disabled={modelMutation.isPending} style={{ flex: 1, padding: "7px 0", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#2F7BFF,#4A90E2)", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                                {modelMutation.isPending ? "Saving�" : "Save"}
                              </button>
                              <button onClick={() => setEditingModel(null)} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #E5E7EB", background: "#fff", color: "#6B7280", fontSize: 12, cursor: "pointer" }}>Cancel</button>
                            </div>
                          </div>
                        )}

                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", background: isActive ? `${svc.color}08` : "#F9FAFB", borderRadius: 12, border: `1px solid ${isActive ? svc.color + "25" : "#E5E7EB"}` }}>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>{isActive ? "? Visible in customer app" : "? Hidden from customers"}</div>
                            <div style={{ fontSize: 11, color: "#9CA3AF" }}>{isActive ? "Customers can book this service" : "Shows as Coming Soon"}</div>
                          </div>
                          <button onClick={() => toggleMutation.mutate({ key: svc.service_key, current: svc.service_status })} disabled={toggleMutation.isPending} style={{ width: 56, height: 30, borderRadius: 15, border: "none", background: isActive ? `linear-gradient(135deg,${svc.color},${svc.color}bb)` : "#D1D5DB", cursor: "pointer", position: "relative", transition: "all .25s ease", flexShrink: 0, boxShadow: isActive ? `0 2px 8px ${svc.color}40` : "none" }}>
                            <div style={{ position: "absolute", top: 3, left: isActive ? 30 : 4, width: 24, height: 24, borderRadius: "50%", background: "#fff", transition: "left .25s ease", boxShadow: "0 2px 4px rgba(0,0,0,0.15)" }} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}

        <div style={{ marginTop: 24, background: "linear-gradient(135deg,#060D1E,#0D1B3E)", borderRadius: 20, padding: "20px 24px", border: "1px solid rgba(47,123,255,0.15)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <i className="bi bi-lightbulb-fill" style={{ color: "#FFD700", fontSize: 18 }} />
            <span style={{ fontWeight: 700, color: "#fff", fontSize: 14 }}>Revenue Model Guide</span>
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {[
              { icon: "??", title: "Subscription", desc: "Drivers buy Daily/Weekly/Monthly plans. No per-trip deduction. Best for Bike/Auto rides.", color: "#2F7BFF" },
              { icon: "??", title: "Commission",   desc: "Platform deducts % per transaction. Best for Parcel, Pool, and Outstation services.",      color: "#FF6B35" },
              { icon: "?", title: "Hybrid",       desc: "Drivers need a plan AND platform takes a small commission. Best for premium services.",      color: "#8B5CF6" },
            ].map(g => (
              <div key={g.title} style={{ flex: "1 1 220px", background: "rgba(255,255,255,0.04)", borderRadius: 12, padding: "14px 16px", border: `1px solid ${g.color}30` }}>
                <div style={{ fontSize: 20, marginBottom: 6 }}>{g.icon}</div>
                <div style={{ fontWeight: 700, color: g.color, fontSize: 13, marginBottom: 4 }}>{g.title}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.55 }}>{g.desc}</div>
              </div>
            ))}
          </div>
        </div>

      </div>
  );
}
