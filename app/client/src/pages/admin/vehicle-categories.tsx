import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ImageUploader } from "@/components/image-uploader";

function VehicleModal({ open, onClose, editing, form, setForm, onSave, saving }: any) {
  if (!open) return null;
  return (
    <div className="modal-backdrop-jago">
      <div className="modal-jago" style={{ maxWidth: 520 }}>
        <div className="modal-jago-header">
          <h5 className="modal-jago-title">{editing ? "Edit Vehicle Category" : "Add Vehicle Category"}</h5>
          <button className="modal-jago-close" onClick={onClose}><i className="bi bi-x-lg"></i></button>
        </div>
        <div className="d-flex flex-column gap-3">
          <div>
            <label className="form-label-jago">Category Name <span className="text-danger">*</span></label>
            <input className="form-control" value={form.name} onChange={e => setForm((f: any) => ({ ...f, name: e.target.value }))} placeholder="e.g. Economy Car" data-testid="input-vehicle-name" />
          </div>
          <div>
            <label className="form-label-jago">Vehicle Type</label>
            <select className="form-select" value={form.type} onChange={e => setForm((f: any) => ({ ...f, type: e.target.value }))}>
              <option value="car">Car</option>
              <option value="motor_bike">Bike</option>
              <option value="auto">Auto</option>
            </select>
          </div>
          <div>
            <ImageUploader
              label="Category Icon / Image"
              value={form.icon}
              onChange={url => setForm((f: any) => ({ ...f, icon: url }))}
              testId="vehicle-icon"
              height={100}
            />
            <div className="mt-2">
              <label className="form-label small text-muted">Or paste image URL</label>
              <input
                className="form-control form-control-sm"
                value={form.icon}
                onChange={e => setForm((f: any) => ({ ...f, icon: e.target.value }))}
                placeholder="https://... or emoji like 🚗"
                data-testid="input-vehicle-icon"
              />
            </div>
          </div>
          <div className="d-flex gap-2 justify-content-end mt-2">
            <button className="btn btn-outline-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={onSave} disabled={!form.name || saving} data-testid="btn-save-vehicle">
              {saving ? "Saving..." : editing ? "Update" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function VehicleCategories() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", type: "car", icon: "" });

  const { data, isLoading } = useQuery<any[]>({ queryKey: ["/api/vehicle-categories"] });

  const save = useMutation({
    mutationFn: (d: any) => editing
      ? apiRequest("PUT", `/api/vehicle-categories/${editing.id}`, d)
      : apiRequest("POST", "/api/vehicle-categories", d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/vehicle-categories"] });
      toast({ title: editing ? "Updated successfully" : "Created successfully" });
      setOpen(false); setEditing(null); setForm({ name: "", type: "car", icon: "" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/vehicle-categories/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/vehicle-categories"] }); toast({ title: "Deleted" }); },
  });

  const toggleStatus = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiRequest("PATCH", `/api/vehicle-categories/${id}`, { isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/vehicle-categories"] }),
  });

  const openCreate = () => { setEditing(null); setForm({ name: "", type: "car", icon: "" }); setOpen(true); };
  const openEdit = (v: any) => { setEditing(v); setForm({ name: v.name, type: v.type || "car", icon: v.icon || "" }); setOpen(true); };
  const vehicles = Array.isArray(data) ? data : [];

  const typeColors: Record<string, string> = { car: "bg-primary", motor_bike: "bg-success", auto: "bg-warning text-dark" };
  const typeLabels: Record<string, string> = { car: "Car", motor_bike: "Bike", auto: "Auto" };
  const defaultIcon = (type: string) => type === "motor_bike" ? "bi-bicycle" : type === "auto" ? "bi-truck" : "bi-car-front-fill";

  return (
    <div className="container-fluid">
      <div className="d-flex align-items-center justify-content-between mb-4">
        <h2 className="fs-22 text-capitalize mb-0" data-testid="page-title">Vehicle Categories</h2>
        <button className="btn btn-primary" onClick={openCreate} data-testid="btn-add-vehicle">
          <i className="bi bi-plus-circle me-1"></i> Add Category
        </button>
      </div>

      <div className="card">
        <div className="card-body">
          <div className="table-responsive">
            <table className="table table-borderless align-middle table-hover">
              <thead className="table-light align-middle text-capitalize">
                <tr>
                  <th>SL</th>
                  <th>Category</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th className="text-center">Action</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array(5).fill(0).map((_, i) => (
                    <tr key={i}>{Array(5).fill(0).map((_, j) => <td key={j}><div style={{ height: "14px", background: "#f1f5f9", borderRadius: "4px" }} /></td>)}</tr>
                  ))
                ) : vehicles.length ? (
                  vehicles.map((v: any, idx: number) => (
                    <tr key={v.id} data-testid={`vehicle-row-${v.id}`}>
                      <td>{idx + 1}</td>
                      <td>
                        <div className="d-flex align-items-center gap-2">
                          <div style={{ width: 40, height: 40, borderRadius: 8, background: "rgba(37,99,235,0.1)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
                            {v.icon && (v.icon.startsWith("http") || v.icon.startsWith("/")) ? (
                              <img src={v.icon} alt={v.name} style={{ width: 40, height: 40, objectFit: "cover" }}
                                onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                            ) : v.icon ? (
                              <span style={{ fontSize: 20 }}>{v.icon}</span>
                            ) : (
                              <i className={`bi ${defaultIcon(v.type)}`} style={{ color: "#2F7BFF", fontSize: 18 }}></i>
                            )}
                          </div>
                          <div className="fw-medium">{v.name}</div>
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${typeColors[v.type] || "bg-secondary"}`}>
                          {typeLabels[v.type] || v.type}
                        </span>
                      </td>
                      <td>
                        <label className="switcher">
                          <input type="checkbox" className="switcher_input" checked={v.isActive} onChange={() => toggleStatus.mutate({ id: v.id, isActive: !v.isActive })} data-testid={`toggle-vehicle-${v.id}`} />
                          <span className="switcher_control"></span>
                        </label>
                      </td>
                      <td className="text-center">
                        <div className="d-flex justify-content-center gap-2">
                          <button className="btn btn-sm btn-outline-primary" onClick={() => openEdit(v)} data-testid={`btn-edit-vehicle-${v.id}`}><i className="bi bi-pencil-fill"></i></button>
                          <button className="btn btn-sm btn-outline-danger" onClick={() => { if (confirm("Delete this category?")) remove.mutate(v.id); }} data-testid={`btn-delete-vehicle-${v.id}`}><i className="bi bi-trash-fill"></i></button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={5}>
                    <div className="d-flex flex-column justify-content-center align-items-center gap-2 py-4">
                      <i className="bi bi-car-front" style={{ fontSize: "2rem", color: "#94a3b8" }}></i>
                      <p className="text-muted mb-0">No vehicle categories found</p>
                    </div>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <VehicleModal open={open} onClose={() => setOpen(false)} editing={editing} form={form} setForm={setForm} onSave={() => save.mutate(form)} saving={save.isPending} />
    </div>
  );
}
