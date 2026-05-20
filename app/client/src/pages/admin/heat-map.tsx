import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

declare global { interface Window { L: any; } }

function loadScript(src: string): Promise<void> {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = () => res(); s.onerror = rej;
    document.head.appendChild(s);
  });
}
function loadLeafletCss() {
  if (document.querySelector('link[href*="leaflet.css"]')) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
  document.head.appendChild(l);
}

const DEMAND_COLORS: Record<string, string> = { high: "#ef4444", medium: "#f59e0b", low: "#22c55e" };
const SERVICE_LABELS: Record<string, string> = { ride: "🚗 Ride", parcel: "📦 Parcel", pool: "🚌 Pool", cargo: "🚛 Cargo" };

export default function HeatMapPage() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const heatRef = useRef<any>(null);
  const gridLayerRef = useRef<any>(null);
  const tileRef = useRef<any>(null);
  const [mapReady, setMapReady] = useState(false);
  const [tileStyle, setTileStyle] = useState<"dark"|"voyager"|"light">("dark");
  const [viewMode, setViewMode] = useState<"heatmap"|"grid">("grid");
  const [serviceFilter, setServiceFilter] = useState<string>("all");
  const [zoom, setZoom] = useState(11);
  const [configOpen, setConfigOpen] = useState(false);
  const [cfgForm, setCfgForm] = useState<Record<string, any>>({});
  const [cfgSaving, setCfgSaving] = useState(false);
  const qc = useQueryClient();

  const TILES = {
    dark:    { url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",    label: "🌙 Dark" },
    voyager: { url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", label: "🗺️ Map" },
    light:   { url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",   label: "☀️ Light" },
  };

  // Raw heatmap points (existing endpoint)
  const { data: points = [] } = useQuery<any[]>({
    queryKey: ["/api/heatmap-points"],
    refetchInterval: 30000,
  });

  // Grid stats (new endpoint)
  const { data: stats } = useQuery<any>({
    queryKey: ["/api/admin/heatmap/stats"],
    refetchInterval: 30000,
  });

  // Heatmap config
  const { data: config } = useQuery<any>({
    queryKey: ["/api/admin/heatmap/config"],
    refetchInterval: 60000,
  });

  // Sync config into form when loaded
  useEffect(() => {
    if (config) setCfgForm({ ...config });
  }, [config]);

  useEffect(() => {
    loadLeafletCss();
    async function init() {
      await loadScript("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js");
      await loadScript("https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js");
      setMapReady(true);
    }
    init();
    return () => { if (mapInstance.current) { mapInstance.current.remove(); mapInstance.current = null; } };
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current || mapInstance.current) return;
    const L = window.L;
    const map = L.map(mapRef.current, { center: [17.43, 78.49], zoom: 11, zoomControl: false });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    const t = TILES[tileStyle];
    tileRef.current = L.tileLayer(t.url, { attribution: '&copy; CARTO', maxZoom: 19, subdomains: "abcd" }).addTo(map);
    map.on("zoomend", () => setZoom(map.getZoom()));
    mapInstance.current = map;
  }, [mapReady]);

  // Heatmap layer
  useEffect(() => {
    if (!mapReady || !mapInstance.current || viewMode !== "heatmap") return;
    const L = window.L;
    if (heatRef.current) mapInstance.current.removeLayer(heatRef.current);
    if (gridLayerRef.current) { mapInstance.current.removeLayer(gridLayerRef.current); gridLayerRef.current = null; }
    if (!points.length) return;
    const latlngs = points.filter((p: any) => p.lat && p.lng)
      .map((p: any) => [parseFloat(p.lat), parseFloat(p.lng), parseFloat(p.intensity) || 1]);
    heatRef.current = L.heatLayer(latlngs, {
      radius: 35, blur: 25, maxZoom: zoom,
      gradient: { 0.2: "#3b82f6", 0.4: "#06b6d4", 0.6: "#22c55e", 0.8: "#f59e0b", 1.0: "#ef4444" },
    }).addTo(mapInstance.current);
  }, [mapReady, points, zoom, viewMode]);

  // Grid overlay
  useEffect(() => {
    if (!mapReady || !mapInstance.current || viewMode !== "grid") return;
    const L = window.L;
    if (heatRef.current) { mapInstance.current.removeLayer(heatRef.current); heatRef.current = null; }
    if (gridLayerRef.current) { mapInstance.current.removeLayer(gridLayerRef.current); gridLayerRef.current = null; }
    const zones: any[] = stats?.topZones || [];
    if (!zones.length) return;
    const layer = L.layerGroup();
    const gridMeters = config?.gridSizeMeters || 500;
    const filtered = serviceFilter === "all" ? zones : zones.filter((z: any) => {
      const sb = z.serviceBreakdown || {};
      return (sb[serviceFilter] || 0) > 0;
    });
    filtered.forEach((z: any) => {
      const color = DEMAND_COLORS[z.demandLevel] || "#94a3b8";
      const circle = L.circle([parseFloat(z.centerLat), parseFloat(z.centerLng)], {
        radius: gridMeters * 0.45,
        color, fillColor: color, fillOpacity: 0.25, weight: 2,
      });
      const sb = z.serviceBreakdown || {};
      const svcLines = Object.entries(sb).filter(([,v]) => (v as number) > 0)
        .map(([k, v]) => `${SERVICE_LABELS[k] || k}: ${v}`).join(" · ");
      circle.bindPopup(`
        <div style="font-family:system-ui;min-width:180px">
          <div style="font-weight:700;font-size:13px;margin-bottom:6px">
            <span style="color:${color}">⬤</span> ${z.demandLevel?.toUpperCase()} Demand Zone
          </div>
          <div style="font-size:11px;color:#64748b;margin-bottom:4px">
            Score: <b>${parseFloat(z.demandScore || 0).toFixed(2)}</b> ·
            ${z.requestCount} requests · ${z.activeDrivers} drivers
          </div>
          ${z.estimatedEarningMin > 0 ? `<div style="font-size:11px;color:#16a34a;font-weight:600">
            Est. ₹${z.estimatedEarningMin}–₹${z.estimatedEarningMax}/30 min
          </div>` : ''}
          ${svcLines ? `<div style="font-size:10px;color:#94a3b8;margin-top:4px">${svcLines}</div>` : ''}
        </div>
      `);
      layer.addLayer(circle);
    });
    layer.addTo(mapInstance.current);
    gridLayerRef.current = layer;
  }, [mapReady, stats, viewMode, serviceFilter, config]);

  // Switch tile
  const switchTile = (style: "dark"|"voyager"|"light") => {
    setTileStyle(style);
    if (mapInstance.current && tileRef.current) {
      mapInstance.current.removeLayer(tileRef.current);
      tileRef.current = window.L.tileLayer(TILES[style].url, {
        attribution: '&copy; CARTO', maxZoom: 19, subdomains: "abcd"
      }).addTo(mapInstance.current);
    }
  };

  const saveConfig = async () => {
    setCfgSaving(true);
    try {
      await apiRequest("PUT", "/api/admin/heatmap/config", cfgForm);
      qc.invalidateQueries({ queryKey: ["/api/admin/heatmap/config"] });
    } finally { setCfgSaving(false); setConfigOpen(false); }
  };

  const totalZones  = (stats?.gridSummary || []).reduce((a: number, r: any) => a + parseInt(r.zones || 0), 0);
  const highZones   = (stats?.gridSummary || []).find((r: any) => r.demandLevel === "high")?.zones || 0;
  const mediumZones = (stats?.gridSummary || []).find((r: any) => r.demandLevel === "medium")?.zones || 0;
  const totalReqs   = (stats?.gridSummary || []).reduce((a: number, r: any) => a + parseInt(r.totalRequests || 0), 0);

  const cfgField = (key: string, label: string, type = "number") => (
    <div key={key} className="mb-3">
      <label className="form-label small fw-semibold">{label}</label>
      <input type={type} className="form-control form-control-sm"
        value={cfgForm[key] ?? ""}
        onChange={e => setCfgForm((p: any) => ({ ...p, [key]: type === "number" ? Number(e.target.value) : e.target.value }))} />
    </div>
  );

  return (
    <>
      <div className="content-header">
        <div className="container-fluid">
          <div className="d-flex align-items-center justify-content-between gap-3 flex-wrap mb-3">
            <h2 className="h5 mb-0 fw-bold">
              <i className="bi bi-fire text-danger me-2"></i>Driver Heatmap & Demand Predictor
            </h2>
            <div className="d-flex gap-2 align-items-center flex-wrap">
              {/* View mode */}
              <div className="btn-group btn-group-sm">
                <button className={`btn ${viewMode === "grid" ? "btn-primary" : "btn-outline-secondary"}`}
                  style={{ fontSize: 11 }} onClick={() => setViewMode("grid")}>
                  ⬡ Demand Grid
                </button>
                <button className={`btn ${viewMode === "heatmap" ? "btn-danger" : "btn-outline-secondary"}`}
                  style={{ fontSize: 11 }} onClick={() => setViewMode("heatmap")}>
                  🔥 Heat Map
                </button>
              </div>
              {/* Service filter */}
              {viewMode === "grid" && (
                <div className="btn-group btn-group-sm">
                  {["all", "ride", "parcel", "pool", "cargo"].map(s => (
                    <button key={s}
                      className={`btn ${serviceFilter === s ? "btn-dark" : "btn-outline-secondary"}`}
                      style={{ fontSize: 11 }}
                      onClick={() => setServiceFilter(s)}>
                      {s === "all" ? "All" : SERVICE_LABELS[s]}
                    </button>
                  ))}
                </div>
              )}
              {/* Tile style */}
              <div className="btn-group btn-group-sm">
                {(Object.entries(TILES) as any).map(([k, v]: any) => (
                  <button key={k}
                    className={`btn ${tileStyle === k ? "btn-dark" : "btn-outline-secondary"}`}
                    style={{ fontSize: 11 }}
                    onClick={() => switchTile(k)}>
                    {v.label}
                  </button>
                ))}
              </div>
              {/* Config */}
              <button className="btn btn-sm btn-outline-primary" style={{ fontSize: 11 }}
                onClick={() => setConfigOpen(v => !v)}>
                <i className="bi bi-sliders me-1"></i>Config
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="container-fluid">
        {/* Config Panel */}
        {configOpen && (
          <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 14 }}>
            <div className="card-header d-flex align-items-center justify-content-between py-2 px-3"
              style={{ borderBottom: "1px solid #f1f5f9" }}>
              <h6 className="mb-0 fw-semibold"><i className="bi bi-sliders me-2 text-primary"></i>Heatmap Configuration</h6>
              <div className="d-flex align-items-center gap-2">
                <div className="form-check form-switch mb-0">
                  <input className="form-check-input" type="checkbox" id="hmActive"
                    checked={cfgForm.isActive ?? true}
                    onChange={e => setCfgForm((p: any) => ({ ...p, isActive: e.target.checked }))} />
                  <label className="form-check-label small" htmlFor="hmActive">Heatmap Active</label>
                </div>
                <button className="btn btn-sm btn-primary" onClick={saveConfig} disabled={cfgSaving}>
                  {cfgSaving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </div>
            <div className="card-body py-3">
              <div className="row g-3">
                <div className="col-md-4">
                  <h6 className="small fw-bold text-muted text-uppercase mb-3">Grid Settings</h6>
                  {cfgField("gridSizeMeters", "Grid Cell Size (meters)")}
                  {cfgField("lookbackMinutes", "Lookback Window (minutes)")}
                  {cfgField("refreshIntervalSeconds", "Refresh Interval (seconds)")}
                  {cfgField("idleTimeoutMinutes", "Idle Driver Timeout (minutes)")}
                </div>
                <div className="col-md-4">
                  <h6 className="small fw-bold text-muted text-uppercase mb-3">Demand Thresholds (Score)</h6>
                  {cfgField("lowDemandThreshold", "Low Demand Threshold")}
                  {cfgField("mediumDemandThreshold", "Medium Demand Threshold")}
                  {cfgField("highDemandThreshold", "High Demand Threshold")}
                </div>
                <div className="col-md-4">
                  <h6 className="small fw-bold text-muted text-uppercase mb-3">Earning Predictions (₹)</h6>
                  <div className="row g-2">
                    <div className="col-6">{cfgField("earningLowMin", "Low Zone Min")}</div>
                    <div className="col-6">{cfgField("earningLowMax", "Low Zone Max")}</div>
                    <div className="col-6">{cfgField("earningMediumMin", "Med Zone Min")}</div>
                    <div className="col-6">{cfgField("earningMediumMax", "Med Zone Max")}</div>
                    <div className="col-6">{cfgField("earningHighMin", "High Zone Min")}</div>
                    <div className="col-6">{cfgField("earningHighMax", "High Zone Max")}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Stats Cards */}
        <div className="row g-3 mb-3">
          {[
            { label: "Total Active Zones", val: totalZones, icon: "bi-grid-3x3-gap-fill", color: "#8b5cf6", bg: "linear-gradient(135deg,#8b5cf612,#c4b5fd12)" },
            { label: "High Demand Zones", val: highZones, icon: "bi-fire", color: "#ef4444", bg: "linear-gradient(135deg,#ef444412,#fca5a512)" },
            { label: "Medium Demand Zones", val: mediumZones, icon: "bi-activity", color: "#f59e0b", bg: "linear-gradient(135deg,#f59e0b12,#fde68a12)" },
            { label: "Total Ride Requests", val: totalReqs, icon: "bi-arrow-up-circle", color: "#22c55e", bg: "linear-gradient(135deg,#22c55e12,#86efac12)" },
          ].map((s, i) => (
            <div key={i} className="col-sm-6 col-xl-3">
              <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
                <div className="card-body d-flex align-items-center gap-3 py-3">
                  <div className="rounded-3 d-flex align-items-center justify-content-center flex-shrink-0"
                    style={{ width: 46, height: 46, background: s.bg }}>
                    <i className={`bi ${s.icon} fs-5`} style={{ color: s.color }}></i>
                  </div>
                  <div>
                    <div className="fw-bold fs-4 lh-1" style={{ color: s.color }}>{s.val}</div>
                    <div className="text-muted small mt-1">{s.label}</div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Map */}
        <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 16, overflow: "hidden" }}>
          <div className="card-header bg-white py-2 px-3 d-flex align-items-center justify-content-between"
            style={{ borderBottom: "1px solid #f1f5f9" }}>
            <h6 className="mb-0 fw-semibold">
              <i className={`bi ${viewMode === "grid" ? "bi-grid-fill" : "bi-map"} me-2 text-primary`}></i>
              {viewMode === "grid" ? "Live Demand Grid" : "Trip Density Heatmap"}
            </h6>
            <div className="d-flex align-items-center gap-3">
              {viewMode === "grid" && (
                <div className="d-flex gap-2" style={{ fontSize: 11 }}>
                  {Object.entries(DEMAND_COLORS).map(([level, color]) => (
                    <span key={level} className="d-flex align-items-center gap-1">
                      <span style={{ width: 10, height: 10, background: color, borderRadius: 2, display: "inline-block" }}></span>
                      <span className="text-muted text-capitalize">{level}</span>
                    </span>
                  ))}
                </div>
              )}
              <span className="badge bg-secondary-subtle text-secondary" style={{ fontSize: 10 }}>
                Auto-refresh 30s
              </span>
            </div>
          </div>
          <div style={{ position: "relative" }}>
            <div ref={mapRef} style={{ height: "60vh", width: "100%" }} />
            {/* Info overlay */}
            {viewMode === "grid" && stats?.topZones?.length > 0 && (
              <div style={{
                position: "absolute", bottom: 40, left: 16, zIndex: 500,
                background: "rgba(15,23,42,0.88)", backdropFilter: "blur(8px)",
                borderRadius: 12, padding: "10px 16px", color: "white",
                boxShadow: "0 4px 20px rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)"
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>📍 Demand Legend</div>
                <div style={{ fontSize: 10, color: "#94a3b8" }}>Click a circle for zone details</div>
                <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                  Score = Requests ÷ Active Drivers
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Top Zones Table */}
        {stats?.topZones?.length > 0 && (
          <div className="card border-0 shadow-sm" style={{ borderRadius: 14 }}>
            <div className="card-header py-2 px-3 bg-white" style={{ borderBottom: "1px solid #f1f5f9" }}>
              <h6 className="mb-0 fw-semibold"><i className="bi bi-table me-2 text-primary"></i>Top Demand Zones</h6>
            </div>
            <div className="table-responsive">
              <table className="table table-hover table-sm mb-0 align-middle">
                <thead className="table-light">
                  <tr>
                    <th style={{ fontSize: 11 }}>Level</th>
                    <th style={{ fontSize: 11 }}>Location (Lat, Lng)</th>
                    <th style={{ fontSize: 11 }}>Demand Score</th>
                    <th style={{ fontSize: 11 }}>Requests</th>
                    <th style={{ fontSize: 11 }}>Active Drivers</th>
                    <th style={{ fontSize: 11 }}>Est. Earning (30 min)</th>
                    <th style={{ fontSize: 11 }}>Services</th>
                  </tr>
                </thead>
                <tbody>
                  {(stats.topZones as any[]).map((z: any, i: number) => {
                    const color = DEMAND_COLORS[z.demandLevel] || "#94a3b8";
                    const sb = z.serviceBreakdown || {};
                    return (
                      <tr key={i}>
                        <td>
                          <span className="badge rounded-pill" style={{ background: color + "20", color, fontSize: 10, fontWeight: 700 }}>
                            ⬤ {z.demandLevel?.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ fontSize: 11, fontFamily: "monospace" }}>
                          {parseFloat(z.centerLat).toFixed(4)}, {parseFloat(z.centerLng).toFixed(4)}
                        </td>
                        <td style={{ fontSize: 12, fontWeight: 700, color }}>{parseFloat(z.demandScore).toFixed(2)}</td>
                        <td style={{ fontSize: 12 }}>{z.requestCount}</td>
                        <td style={{ fontSize: 12 }}>{z.activeDrivers}</td>
                        <td style={{ fontSize: 12, color: "#16a34a", fontWeight: 600 }}>
                          {z.estimatedEarningMin > 0 ? `₹${z.estimatedEarningMin}–₹${z.estimatedEarningMax}` : "—"}
                        </td>
                        <td style={{ fontSize: 10 }}>
                          {Object.entries(sb).filter(([,v]) => (v as number) > 0)
                            .map(([k, v]) => (
                              <span key={k} className="badge bg-light text-secondary me-1">{SERVICE_LABELS[k] || k} {v as number}</span>
                            ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Event count breakdown */}
        {stats?.eventCounts?.length > 0 && (
          <div className="row g-3 mt-1">
            {(stats.eventCounts as any[]).map((e: any) => (
              <div key={e.eventType} className="col-auto">
                <div className="card border-0 shadow-sm px-3 py-2" style={{ borderRadius: 10 }}>
                  <div className="d-flex align-items-center gap-2">
                    <span className="text-muted small">{e.eventType}</span>
                    <span className="fw-bold">{e.cnt}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
