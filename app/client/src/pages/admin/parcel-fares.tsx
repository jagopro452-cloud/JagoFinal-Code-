import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

const defaultForm = { zoneId: "", baseFare: "", farePerKm: "", farePerKg: "", minimumFare: "", loadingCharge: "", helperChargePerHour: "", maxHelpers: "" };

export default function ParcelFaresPage() {
  const { toast } = useToast();
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ ...defaultForm });

  const { data: fares, isLoading } = useQuery<any[]>({ queryKey: ["/api/parcel-fares"] });
  const { data: zonesData } = useQuery<any[]>({ queryKey: ["/api/zones"] });
  const parcelFares = Array.isArray(fares) ? fares : [];
  const zones = Array.isArray(zonesData) ? zonesData : [];

  const saveMutation = useMutation({
    mutationFn: (d: any) => editing ? apiRequest("PUT", `/api/parcel-fares/${editing.id}`, d) : apiRequest("POST", "/api/parcel-fares", d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/parcel-fares"] });
      setShowModal(false);
      toast({ title: editing ? "Updated" : "Created" });
      setEditing(null);
    },
    onError: () => toast({ title: "Failed", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/parcel-fares/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/parcel-fares"] }); toast({ title: "Deleted" }); },
  });

  const openAdd = () => { setEditing(null); setForm({ ...defaultForm }); setShowModal(true); };
  const openEdit = (f: any) => {
    setEditing(f);
    setForm({
      zoneId: f.zoneId || "",
      baseFare: f.baseFare || "",
      farePerKm: f.farePerKm || "",
      farePerKg: f.farePerKg || "",
      minimumFare: f.minimumFare || "",
      loadingCharge: f.loadingCharge || "",
      helperChargePerHour: f.helperChargePerHour || "",
      maxHelpers: f.maxHelpers != null ? String(f.maxHelpers) : "",
    });
    setShowModal(true);
  };

  const f2 = (v: any) => parseFloat(v || 0).toFixed(2);

  return (
    <>
      <div className="content-header">
        <div className="container-fluid">
          <div className="d-flex align-items-center justify-content-between gap-3 flex-wrap mb-3">
            <h2 className="h5 mb-0">Parcel Delivery Fare Setup</h2>
            <button className="btn btn-primary btn-sm" onClick={openAdd} data-testid="btn-add-parcel-fare">
              <i className="bi bi-plus me-1"></i>Add Fare
            </button>
          </div>
        </div>
      </div>
      <div className="container-fluid">
        <div className="card">
          <div className="card-body">
            <div className="table-responsive">
              <table className="table table-borderless align-middle table-hover">
                <thead className="table-light">
                  <tr>
                    <th>#</th>
                    <th>Zone</th>
                    <th>Base (₹)</th>
                    <th>Per Km (₹)</th>
                    <th>Per Kg (₹)</th>
                    <th>Min (₹)</th>
                    <th>Loading (₹)</th>
                    <th>Helper/hr (₹)</th>
                    <th>Max Helpers</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr><td colSpan={10} className="text-center py-4"><div className="spinner-border spinner-border-sm" role="status" /></td></tr>
                  ) : parcelFares.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="text-center py-5 text-muted">
                        <i className="bi bi-box fs-2 d-block mb-2 opacity-25"></i>
                        No parcel delivery fares found.
                      </td>
                    </tr>
                  ) : parcelFares.map((f: any, idx: number) => (
                    <tr key={f.id} data-testid={`row-parcel-fare-${f.id}`}>
                      <td>{idx + 1}</td>
                      <td className="fw-semibold">{f.zoneName || "—"}</td>
                      <td>₹{f2(f.baseFare)}</td>
                      <td>₹{f2(f.farePerKm)}</td>
                      <td>₹{f2(f.farePerKg)}</td>
                      <td>₹{f2(f.minimumFare)}</td>
                      <td>₹{f2(f.loadingCharge)}</td>
                      <td>₹{f2(f.helperChargePerHour)}</td>
                      <td>{f.maxHelpers ?? 0}</td>
                      <td>
                        <button className="btn btn-sm btn-outline-primary me-1" onClick={() => openEdit(f)}><i className="bi bi-pencil-fill"></i></button>
                        <button className="btn btn-sm btn-outline-danger" onClick={() => { if (confirm("Delete?")) deleteMutation.mutate(f.id); }}><i className="bi bi-trash-fill"></i></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {showModal && (
        <div className="modal fade show d-block" style={{ background: "rgba(0,0,0,0.5)" }}>
          <div className="modal-dialog">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">{editing ? "Edit Parcel Fare" : "Add Parcel Fare"}</h5>
                <button className="btn-close" onClick={() => setShowModal(false)} />
              </div>
              <div className="modal-body">
                <div className="mb-3">
                  <label className="form-label fw-semibold">Zone <span className="text-danger">*</span></label>
                  <select className="form-select" value={form.zoneId} onChange={e => setForm({ ...form, zoneId: e.target.value })} data-testid="select-parcel-zone">
                    <option value="">Select zone</option>
                    {zones.map((z: any) => <option key={z.id} value={z.id}>{z.name}</option>)}
                  </select>
                </div>

                <p className="text-muted small mb-2">Base rates (applied per booking)</p>
                <div className="row g-3 mb-3">
                  <div className="col-6">
                    <label className="form-label fw-semibold">Base Fare (₹)</label>
                    <input className="form-control" type="number" min="0" value={form.baseFare} onChange={e => setForm({ ...form, baseFare: e.target.value })} data-testid="input-parcel-base-fare" />
                  </div>
                  <div className="col-6">
                    <label className="form-label fw-semibold">Per Km (₹)</label>
                    <input className="form-control" type="number" min="0" value={form.farePerKm} onChange={e => setForm({ ...form, farePerKm: e.target.value })} data-testid="input-parcel-per-km" />
                  </div>
                </div>
                <div className="row g-3 mb-3">
                  <div className="col-6">
                    <label className="form-label fw-semibold">Per Kg (₹)</label>
                    <input className="form-control" type="number" min="0" value={form.farePerKg} onChange={e => setForm({ ...form, farePerKg: e.target.value })} data-testid="input-parcel-per-kg" />
                  </div>
                  <div className="col-6">
                    <label className="form-label fw-semibold">Minimum Fare (₹)</label>
                    <input className="form-control" type="number" min="0" value={form.minimumFare} onChange={e => setForm({ ...form, minimumFare: e.target.value })} data-testid="input-parcel-min-fare" />
                  </div>
                </div>

                <p className="text-muted small mb-2">Loading &amp; Helper charges (optional)</p>
                <div className="row g-3 mb-3">
                  <div className="col-6">
                    <label className="form-label fw-semibold">Loading Charge (₹)</label>
                    <input className="form-control" type="number" min="0" value={form.loadingCharge} onChange={e => setForm({ ...form, loadingCharge: e.target.value })} data-testid="input-parcel-loading" />
                  </div>
                  <div className="col-6">
                    <label className="form-label fw-semibold">Helper Charge / hr (₹)</label>
                    <input className="form-control" type="number" min="0" value={form.helperChargePerHour} onChange={e => setForm({ ...form, helperChargePerHour: e.target.value })} data-testid="input-parcel-helper-rate" />
                  </div>
                </div>
                <div className="mb-3">
                  <label className="form-label fw-semibold">Max Helpers Allowed</label>
                  <input className="form-control" type="number" min="0" max="10" value={form.maxHelpers} onChange={e => setForm({ ...form, maxHelpers: e.target.value })} data-testid="input-parcel-max-helpers" />
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-light" onClick={() => setShowModal(false)}>Cancel</button>
                <button className="btn btn-primary" disabled={!form.zoneId || saveMutation.isPending} onClick={() => saveMutation.mutate(form)} data-testid="btn-save-parcel-fare">
                  {saveMutation.isPending ? "Saving..." : editing ? "Update" : "Create"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
