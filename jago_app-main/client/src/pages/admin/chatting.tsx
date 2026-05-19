import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useEffect } from "react";
import { apiRequest } from "@/lib/queryClient";

const avatarBg = (name: string) => {
  const c = ["#1a73e8","#16a34a","#d97706","#9333ea","#0891b2","#dc2626"];
  return c[(name || "A").charCodeAt(0) % c.length];
};
const fmtTime = (ts: string | number) =>
  new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

export default function ChattingPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<any>(null);
  const [filter, setFilter] = useState("all");
  const [msgInput, setMsgInput] = useState("");
  const [search, setSearch] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: custData } = useQuery<any>({
    queryKey: ["/api/users", { userType: "customer" }],
    queryFn: () => apiRequest("GET", "/api/users?userType=customer&limit=30").then(r => r.json()).then(d => (d && !d.message && !d.error) ? d : { data: [] }),
  });
  const { data: driverData } = useQuery<any>({
    queryKey: ["/api/users", { userType: "driver" }],
    queryFn: () => apiRequest("GET", "/api/users?userType=driver&limit=30").then(r => r.json()).then(d => (d && !d.message && !d.error) ? d : { data: [] }),
  });
  const { data: unreadData } = useQuery<any>({
    queryKey: ["/api/support-chat/unread-count"],
    queryFn: () => apiRequest("GET", "/api/support-chat/unread-count").then(r => r.json()).then(d => (d && !d.message && !d.error) ? d : {}),
    refetchInterval: 5000,
  });

  const { data: chatData, isLoading: chatLoading } = useQuery<any>({
    queryKey: ["/api/support-chat", selected?.id],
    queryFn: () => apiRequest("GET", `/api/support-chat?userId=${selected.id}`).then(r => r.json()).then(d => (d && !d.message && !d.error) ? d : { messages: [] }),
    enabled: !!selected?.id,
    refetchInterval: 3000,
  });

  const sendMutation = useMutation({
    mutationFn: (msg: string) => apiRequest("POST", "/api/support-chat", { userId: selected.id, message: msg, sender: "admin" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/support-chat", selected?.id] }); },
  });

  const customers = Array.isArray(custData?.data) ? custData.data : [];
  const drivers = Array.isArray(driverData?.data) ? driverData.data : [];
  const allUsers = filter === "customer" ? customers : filter === "driver" ? drivers : [...customers, ...drivers];
  const filtered = search ? allUsers.filter((u: any) => {
    const name = u.fullName || `${u.firstName || ""} ${u.lastName || ""}`.trim();
    return name.toLowerCase().includes(search.toLowerCase()) || (u.phone || "").includes(search);
  }) : allUsers;

  const messages: any[] = chatData?.messages || [];
  const unreadByUser: any[] = unreadData?.unreadByUser || [];
  const getUnread = (id: string) => {
    const found = unreadByUser.find((u: any) => u.userId === id || u.user_id === id);
    return found ? parseInt(found.unread || 0) : 0;
  };

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length]);

  const sendMsg = () => {
    if (!msgInput.trim() || !selected || sendMutation.isPending) return;
    sendMutation.mutate(msgInput.trim());
    setMsgInput("");
  };

  const selectedName = selected
    ? (selected.fullName || `${selected.firstName || ""} ${selected.lastName || ""}`.trim() || "User")
    : "";

  return (
    <div className="container-fluid px-0">
      <div className="d-flex" style={{ height: "calc(100vh - 130px)", minHeight: 600 }}>

        {/* LEFT: Contacts */}
        <div className="border-end d-flex flex-column" style={{ width: 300, flexShrink: 0 }}>
          <div className="p-3 border-bottom">
            <h6 className="fw-bold mb-2">Support Chats</h6>
            <div className="input-group input-group-sm">
              <span className="input-group-text bg-light border-0"><i className="bi bi-search text-muted"></i></span>
              <input className="form-control border-0 bg-light" placeholder="Search users..." value={search}
                onChange={e => setSearch(e.target.value)} data-testid="input-chat-search" />
            </div>
          </div>
          <div className="px-2 py-2 border-bottom">
            <div className="btn-group btn-group-sm w-100">
              {["all","customer","driver"].map(t => (
                <button key={t} className={`btn ${filter === t ? "btn-primary" : "btn-outline-secondary"} text-capitalize`}
                  onClick={() => setFilter(t)} data-testid={`btn-filter-${t}`}>{t}</button>
              ))}
            </div>
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {filtered.length === 0 ? (
              <div className="text-center py-5 text-muted">
                <i className="bi bi-chat-left-dots fs-2 d-block mb-2 opacity-25"></i>
                <small>No users found</small>
              </div>
            ) : filtered.map((u: any) => {
              const name = u.fullName || `${u.firstName || ""} ${u.lastName || ""}`.trim() || "User";
              const isSelected = selected?.id === u.id;
              const unread = getUnread(u.id);
              return (
                <div key={u.id} onClick={() => setSelected(u)} data-testid={`chat-user-${u.id}`}
                  className={`d-flex align-items-center gap-3 px-3 py-2 border-bottom ${isSelected ? "bg-primary bg-opacity-10" : ""}`}
                  style={{ cursor: "pointer" }}>
                  <div className="position-relative flex-shrink-0">
                    <div className="rounded-circle d-flex align-items-center justify-content-center text-white fw-bold"
                      style={{ width: 40, height: 40, fontSize: "0.9rem", background: avatarBg(name) }}>
                      {name[0]?.toUpperCase()}
                    </div>
                    <span className="position-absolute bottom-0 end-0 rounded-circle border border-white"
                      style={{ width: 10, height: 10, background: "#16a34a" }}></span>
                  </div>
                  <div className="flex-grow-1 min-w-0">
                    <div className="d-flex justify-content-between align-items-center">
                      <span className="fw-semibold text-truncate" style={{ fontSize: "0.85rem" }}>{name}</span>
                      {unread > 0 && (
                        <span className="badge bg-danger rounded-pill" style={{ fontSize: "0.65rem" }}>{unread}</span>
                      )}
                    </div>
                    <small className="text-muted text-truncate d-block">
                      {u.userType === "driver" ? "🚗 Driver" : "👤 Customer"} · {u.phone || "—"}
                    </small>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* RIGHT: Chat Area */}
        <div className="flex-grow-1 d-flex flex-column">
          {selected ? (
            <>
              {/* Header */}
              <div className="p-3 border-bottom bg-white d-flex align-items-center justify-content-between">
                <div className="d-flex align-items-center gap-3">
                  <div className="rounded-circle d-flex align-items-center justify-content-center text-white fw-bold"
                    style={{ width: 42, height: 42, background: avatarBg(selectedName) }}>
                    {selectedName[0]?.toUpperCase()}
                  </div>
                  <div>
                    <div className="fw-semibold">{selectedName}</div>
                    <small className="text-muted">{selected.phone} · {selected.userType === "driver" ? "Driver" : "Customer"}</small>
                  </div>
                </div>
                <div className="d-flex gap-2">
                  <button className="btn btn-sm btn-outline-secondary" title="Call"
                    onClick={() => window.open(`tel:${selected.phone}`)}>
                    <i className="bi bi-telephone-fill"></i>
                  </button>
                  <button className="btn btn-sm btn-outline-secondary" title="Clear" onClick={() => setSelected(null)}>
                    <i className="bi bi-x-lg"></i>
                  </button>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-grow-1 p-3 overflow-auto" style={{ background: "#f8fafc" }}>
                {chatLoading ? (
                  <div className="text-center py-5 text-muted">
                    <div className="spinner-border spinner-border-sm me-2"></div>Loading messages...
                  </div>
                ) : messages.length === 0 ? (
                  <div className="text-center py-5 text-muted">
                    <i className="bi bi-chat-left-dots fs-2 d-block mb-2 opacity-25"></i>
                    <p className="small">No messages yet. Start the conversation!</p>
                  </div>
                ) : messages.map((msg: any, i: number) => (
                  <div key={i} className={`d-flex mb-3 ${msg.sender === "admin" ? "justify-content-end" : "justify-content-start"}`}>
                    {msg.sender !== "admin" && (
                      <div className="rounded-circle d-flex align-items-center justify-content-center text-white fw-bold me-2 flex-shrink-0"
                        style={{ width: 32, height: 32, fontSize: "0.75rem", background: avatarBg(selectedName), alignSelf: "flex-end" }}>
                        {selectedName[0]?.toUpperCase()}
                      </div>
                    )}
                    <div>
                      <div className="px-3 py-2 shadow-sm"
                        style={{
                          maxWidth: 340, fontSize: "0.875rem",
                          background: msg.sender === "admin" ? "#1a73e8" : "#fff",
                          color: msg.sender === "admin" ? "#fff" : "#1e293b",
                          borderRadius: msg.sender === "admin" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                        }}>
                        {msg.message}
                      </div>
                      <div className={`text-muted mt-1 ${msg.sender === "admin" ? "text-end" : ""}`} style={{ fontSize: "0.7rem" }}>
                        {fmtTime(msg.createdAt)}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div className="p-3 border-top bg-white">
                <div className="input-group">
                  <input className="form-control border-0 bg-light rounded-start-3"
                    placeholder="Type a message..." value={msgInput}
                    onChange={e => setMsgInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && sendMsg()}
                    data-testid="input-chat-message" />
                  <button className="btn btn-primary px-4" onClick={sendMsg}
                    disabled={sendMutation.isPending} data-testid="btn-send-message">
                    {sendMutation.isPending
                      ? <span className="spinner-border spinner-border-sm"></span>
                      : <i className="bi bi-send-fill"></i>}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-grow-1 d-flex align-items-center justify-content-center text-muted">
              <div className="text-center">
                <i className="bi bi-chat-left-dots fs-1 d-block mb-3 opacity-25"></i>
                <h5 className="fw-semibold">Select a conversation</h5>
                <p className="mb-0 small">Choose a user from the left to start chatting</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
