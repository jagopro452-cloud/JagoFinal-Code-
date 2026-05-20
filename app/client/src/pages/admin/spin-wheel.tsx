import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

export default function SpinWheelPage() {
  const { toast } = useToast();
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ label: "", rewardAmount: "", rewardType: "wallet", probability: "", isActive: true });

  const { data, isLoading } = useQuery<any[]>({ queryKey: ["/api/spin-wheel"] });
  const items = Array.isArray(data) ? data : [];

  const saveMutation = useMutation({
    mutationFn: (payload: any) =>
      editing
        ? apiRequest("PUT", `/api/spin-wheel/${editing.id}`, payload)
        : apiRequest("POST", "/api/spin-wheel", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/spin-wheel"] });
      setShowModal(false);
      toast({ title: editing ? "Updated" : "Created" });
      setEditing(null);
    },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/spin-wheel/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/spin-wheel"] });
      toast({ title: "Deleted" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiRequest("PATCH", `/api/spin-wheel/${id}`, { isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/spin-wheel"] });
      toast({ title: "Status updated" });
    },
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  return (
    <>
    
      <div className="content-header">
        <div className="container-fluid">
          <div className="d-flex align-items-center justify-content-between gap-3 flex-wrap mb-3">
            <h2 className="h5 mb-0">Spin Wheel Setup</h2>
            <button className="btn btn-primary btn-sm" onClick={() => { setEditing(null); setForm({ label: "", rewardAmount: "", rewardType: "wallet", probability: "", isActive: true }); setShowModal(true); }} data-testid="btn-add-spin">
              <i className="bi bi-plus me-1"></i>Add Slot
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
                    <th>Label</th>
                    <th>Reward</th>
                    <th>Type</th>
                    <th>Probability</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr><td colSpan={7} className="text-center py-4"><div className="spinner-border spinner-border-sm" role="status" /></td></tr>
                  ) : items.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center py-5 text-muted">
                        <i className="bi bi-trophy-fill fs-2 d-block mb-2 opacity-25"></i>
                        No spin wheel slots found. Click Add Slot to create one.
                      </td>
                    </tr>
                  ) : items.map((item: any, idx: number) => (
                    <tr key={item.id} data-testid={`row-spin-${item.id}`}>
                      <td>{idx + 1}</td>
                      <td className="fw-semibold">{item.label}</td>
                      <td>₹{item.rewardAmount}</td>
                      <td className="text-capitalize">{item.rewardType}</td>
                      <td>{item.probability}%</td>
                      <td><span className={`badge ${item.isActive ? "bg-success" : "bg-secondary"}`}>{item.isActive ? "Active" : "Inactive"}</span></td>
                      <td>
                        <button
                          className={`btn btn-sm me-1 ${item.isActive ? "btn-outline-warning" : "btn-outline-success"}`}
                          onClick={() => toggleMutation.mutate({ id: item.id, isActive: !item.isActive })}
                          title={item.isActive ? "Deactivate" : "Activate"}
                        >
                          <i className={`bi ${item.isActive ? "bi-toggle-on" : "bi-toggle-off"}`}></i>
                        </button>
                        <button className="btn btn-sm btn-outline-primary me-1" onClick={() => { setEditing(item); setForm({ label: item.label, rewardAmount: item.rewardAmount, rewardType: item.rewardType, probability: item.probability, isActive: item.isActive }); setShowModal(true); }}><i className="bi bi-pencil-fill"></i></button>
                        <button className="btn btn-sm btn-outline-danger" onClick={() => { if (confirm("Delete?")) deleteMutation.mutate(item.id); }}><i className="bi bi-trash-fill"></i></button>
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
                <h5 className="modal-title">{editing ? "Edit Slot" : "Add Slot"}</h5>
                <button className="btn-close" onClick={() => setShowModal(false)} />
              </div>
              <div className="modal-body">
                <div className="mb-3">
                  <label className="form-label fw-semibold">Label <span className="text-danger">*</span></label>
                  <input className="form-control" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} data-testid="input-spin-label" />
                </div>
                <div className="row g-3 mb-3">
                  <div className="col-6">
                    <label className="form-label fw-semibold">Reward Amount</label>
                    <input className="form-control" type="number" min="0" value={form.rewardAmount} onChange={e => setForm({ ...form, rewardAmount: e.target.value })} data-testid="input-spin-reward" />
                  </div>
                  <div className="col-6">
                    <label className="form-label fw-semibold">Type</label>
                    <select className="form-select" value={form.rewardType} onChange={e => setForm({ ...form, rewardType: e.target.value })}>
                      <option value="wallet">Wallet Amount (₹)</option>
                      <option value="coins">JAGO Coins</option>
                      <option value="none">No Reward</option>
                    </select>
                  </div>
                </div>
                <div className="mb-3">
                  <label className="form-label fw-semibold">Probability (%)</label>
                  <input className="form-control" type="number" min="0" max="100" value={form.probability} onChange={e => setForm({ ...form, probability: e.target.value })} data-testid="input-spin-probability" />
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-light" onClick={() => setShowModal(false)}>Cancel</button>
                <button className="btn btn-primary" disabled={!form.label || saveMutation.isPending} onClick={() => saveMutation.mutate(form)} data-testid="btn-spin-save">
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
