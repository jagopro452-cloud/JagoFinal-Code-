import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type PopularLocation = {
  id: string;
  name: string;
  cityName: string;
  latitude: number;
  longitude: number;
  fullAddress?: string;
  isActive: boolean;
};

const EMPTY_FORM = {
  name: "",
  cityName: "Vijayawada",
  latitude: "",
  longitude: "",
  fullAddress: "",
  isActive: true,
};

export default function PopularLocationsAdmin() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [city, setCity] = useState("Vijayawada");
  const [editing, setEditing] = useState<PopularLocation | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const { data = [], isLoading } = useQuery<PopularLocation[]>({
    queryKey: ["/api/popular-locations", city],
    queryFn: async () => {
      const r = await fetch(`/api/popular-locations?city=${encodeURIComponent(city)}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load popular locations");
      return r.json();
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        cityName: form.cityName.trim(),
        latitude: Number(form.latitude),
        longitude: Number(form.longitude),
        fullAddress: form.fullAddress.trim() || null,
        isActive: form.isActive,
      };
      if (!payload.name || !payload.cityName || Number.isNaN(payload.latitude) || Number.isNaN(payload.longitude)) {
        throw new Error("Name, city, latitude and longitude are required");
      }
      if (editing) {
        return apiRequest("PUT", `/api/popular-locations/${editing.id}`, payload);
      }
      return apiRequest("POST", "/api/popular-locations", payload);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["/api/popular-locations"] });
      setEditing(null);
      setForm(EMPTY_FORM);
      toast({ title: "Popular location saved" });
    },
    onError: (e: any) => {
      toast({ title: "Save failed", description: e?.message || "Error", variant: "destructive" });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/popular-locations/${id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["/api/popular-locations"] });
      toast({ title: "Popular location deleted" });
    },
    onError: (e: any) => toast({ title: "Delete failed", description: e?.message || "Error", variant: "destructive" }),
  });

  const sorted = useMemo(() => [...data].sort((a, b) => a.name.localeCompare(b.name)), [data]);

  const startEdit = (row: PopularLocation) => {
    setEditing(row);
    setForm({
      name: row.name || "",
      cityName: row.cityName || "",
      latitude: String(row.latitude ?? ""),
      longitude: String(row.longitude ?? ""),
      fullAddress: row.fullAddress || "",
      isActive: row.isActive !== false,
    });
  };

  const clearForm = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
  };

  return (
    <div className="container-fluid py-3">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <div>
          <h4 className="mb-0 fw-bold">Popular Locations</h4>
          <div className="text-muted small">City-wise landmark shortcuts for booking flow</div>
        </div>
      </div>

      <div className="card border-0 shadow-sm mb-3">
        <div className="card-body">
          <div className="row g-2 align-items-end">
            <div className="col-md-3">
              <label className="form-label">City</label>
              <input className="form-control" value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="col-md-2">
              <button className="btn btn-outline-secondary w-100" onClick={clearForm}>New</button>
            </div>
          </div>
        </div>
      </div>

      <div className="card border-0 shadow-sm mb-3">
        <div className="card-header bg-white fw-semibold">{editing ? "Edit Location" : "Add Location"}</div>
        <div className="card-body">
          <div className="row g-2">
            <div className="col-md-3"><input className="form-control" placeholder="Location Name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
            <div className="col-md-2"><input className="form-control" placeholder="City" value={form.cityName} onChange={(e) => setForm((f) => ({ ...f, cityName: e.target.value }))} /></div>
            <div className="col-md-2"><input className="form-control" placeholder="Latitude" value={form.latitude} onChange={(e) => setForm((f) => ({ ...f, latitude: e.target.value }))} /></div>
            <div className="col-md-2"><input className="form-control" placeholder="Longitude" value={form.longitude} onChange={(e) => setForm((f) => ({ ...f, longitude: e.target.value }))} /></div>
            <div className="col-md-3"><input className="form-control" placeholder="Full Address (optional)" value={form.fullAddress} onChange={(e) => setForm((f) => ({ ...f, fullAddress: e.target.value }))} /></div>
            <div className="col-md-2 form-check mt-2 ms-2">
              <input className="form-check-input" type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} id="popular-active" />
              <label className="form-check-label" htmlFor="popular-active">Active</label>
            </div>
            <div className="col-md-2">
              <button className="btn btn-primary w-100" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving..." : "Save"}</button>
            </div>
          </div>
        </div>
      </div>

      <div className="card border-0 shadow-sm">
        <div className="card-header bg-white fw-semibold">Locations ({sorted.length})</div>
        <div className="card-body p-0">
          {isLoading ? (
            <div className="p-3 text-muted">Loading...</div>
          ) : sorted.length === 0 ? (
            <div className="p-3 text-muted">No locations found for this city.</div>
          ) : (
            <div className="table-responsive">
              <table className="table table-sm mb-0">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>City</th>
                    <th>Lat</th>
                    <th>Lng</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td>{row.cityName}</td>
                      <td>{Number(row.latitude).toFixed(6)}</td>
                      <td>{Number(row.longitude).toFixed(6)}</td>
                      <td><span className={`badge ${row.isActive ? "bg-success" : "bg-secondary"}`}>{row.isActive ? "Active" : "Inactive"}</span></td>
                      <td>
                        <button className="btn btn-sm btn-outline-primary me-2" onClick={() => startEdit(row)}>Edit</button>
                        <button className="btn btn-sm btn-outline-danger" onClick={() => { if (confirm(`Delete ${row.name}?`)) remove.mutate(row.id); }}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
