import crypto from "node:crypto";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { runtime } from "./runtime";

type OtpRecord = {
  otp: string;
  phone: string;
  userType: string;
  attempts: number;
  expiresAt: number;
  deviceId: string;
};

type BookingRecord = {
  id: string;
  serviceType: string;
  customerId: string;
  driverId: string | null;
  pickup: string;
  destination: string;
  amount: number;
  status: "pending" | "accepted" | "rejected" | "paid";
  paymentStatus: "pending" | "paid";
  pickupOtp: string;
  deliveryOtp: string;
  history: Array<{ status: string; at: string }>;
};

const otpStore = new Map<string, OtpRecord>();
const bookings = new Map<string, BookingRecord>();
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

app.use(express.json());

function nowIso() {
  return new Date().toISOString();
}

function broadcastBooking(booking: BookingRecord, eventName: string, extra: Record<string, unknown> = {}) {
  const payload = {
    bookingId: booking.id,
    serviceType: booking.serviceType,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    driverId: booking.driverId,
    pickupOtp: booking.pickupOtp,
    deliveryOtp: booking.deliveryOtp,
    ...extra,
  };
  let target = io.to(`user:${booking.customerId}`).to(`booking:${booking.id}`);
  if (booking.driverId) {
    target = target.to(`user:${booking.driverId}`);
  }
  target.emit(eventName, payload);
}

io.on("connection", (socket) => {
  const userId = String(socket.handshake.query.userId || "");
  const bookingId = String(socket.handshake.query.bookingId || "");

  if (userId) socket.join(`user:${userId}`);
  if (bookingId) {
    socket.join(`booking:${bookingId}`);
    const booking = bookings.get(bookingId);
    if (booking) {
      socket.emit("booking:snapshot", {
        bookingId: booking.id,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
      });
    }
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: nowIso() });
});

app.post("/auth/otp/send", (req, res) => {
  const { phone, userType = "customer", deviceId = "device-1" } = req.body || {};
  const otp = "123456";
  otpStore.set(String(phone), {
    otp,
    phone: String(phone),
    userType: String(userType),
    attempts: 0,
    expiresAt: Date.now() + 120_000,
    deviceId: String(deviceId),
  });
  res.json({ success: true, phone, otp, expiresInSeconds: 120 });
});

app.post("/auth/otp/verify", (req, res) => {
  const { phone, otp, userType = "customer", deviceId = "device-1" } = req.body || {};
  const record = otpStore.get(String(phone));
  if (!record) return res.status(404).json({ message: "OTP not requested" });
  if (record.deviceId !== String(deviceId)) return res.status(409).json({ message: "OTP belongs to a different device" });
  if (record.expiresAt < Date.now()) return res.status(410).json({ message: "OTP expired" });
  if (record.attempts >= 3) return res.status(429).json({ message: "Too many invalid attempts" });
  if (record.otp !== String(otp)) {
    record.attempts += 1;
    return res.status(record.attempts >= 3 ? 429 : 400).json({ message: record.attempts >= 3 ? "Too many invalid attempts" : "Invalid OTP" });
  }
  res.json({
    success: true,
    token: `token-${phone}`,
    refreshToken: `refresh-${phone}`,
    user: {
      id: userType === "driver" ? runtime.driverId : runtime.customerId,
      phone,
      userType,
    },
  });
});

app.post("/auth/otp/expire", (req, res) => {
  const record = otpStore.get(String(req.body?.phone || runtime.testPhone));
  if (record) record.expiresAt = Date.now() - 1;
  res.json({ success: true });
});

app.post("/bookings", (req, res) => {
  const id = `booking-${bookings.size + 1}`;
  const booking: BookingRecord = {
    id,
    serviceType: String(req.body?.serviceType || "bike"),
    customerId: String(req.body?.customerId || runtime.customerId),
    driverId: null,
    pickup: String(req.body?.pickup || "Hitech City"),
    destination: String(req.body?.destination || "Airport"),
    amount: Number(req.body?.amount || 275),
    status: "pending",
    paymentStatus: "pending",
    pickupOtp: "7482",
    deliveryOtp: "9154",
    history: [{ status: "pending", at: nowIso() }],
  };
  bookings.set(id, booking);
  res.status(201).json(booking);
});

app.get("/bookings/:bookingId", (req, res) => {
  const booking = bookings.get(req.params.bookingId);
  if (!booking) return res.status(404).json({ message: "Booking not found" });
  res.json(booking);
});

app.get("/bookings/:bookingId/recovery", (req, res) => {
  const booking = bookings.get(req.params.bookingId);
  if (!booking) return res.status(404).json({ message: "Booking not found" });
  res.json({
    bookingId: booking.id,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    history: booking.history,
  });
});

app.post("/bookings/:bookingId/driver/accept", (req, res) => {
  const booking = bookings.get(req.params.bookingId);
  if (!booking) return res.status(404).json({ message: "Booking not found" });
  booking.driverId = String(req.body?.driverId || runtime.driverId);
  booking.status = "accepted";
  booking.history.push({ status: "accepted", at: nowIso() });
  broadcastBooking(booking, "trip:accepted", { acceptedAt: nowIso() });
  res.json(booking);
});

app.post("/bookings/:bookingId/driver/reject", (req, res) => {
  const booking = bookings.get(req.params.bookingId);
  if (!booking) return res.status(404).json({ message: "Booking not found" });
  booking.driverId = String(req.body?.driverId || runtime.driverId);
  booking.status = "rejected";
  booking.history.push({ status: "rejected", at: nowIso() });
  broadcastBooking(booking, "trip:rejected", { reason: String(req.body?.reason || "Rejected") });
  res.json(booking);
});

app.post("/bookings/:bookingId/payment/create-order", (req, res) => {
  const booking = bookings.get(req.params.bookingId);
  if (!booking) return res.status(404).json({ message: "Booking not found" });
  const amount = Number(req.body?.amount || booking.amount);
  res.json({
    bookingId: booking.id,
    orderId: `order_${booking.id}`,
    amount,
    currency: "INR",
  });
});

app.post("/bookings/:bookingId/payment/verify", (req, res) => {
  const booking = bookings.get(req.params.bookingId);
  if (!booking) return res.status(404).json({ message: "Booking not found" });
  const { orderId, paymentId, signature } = req.body || {};
  const expected = crypto
    .createHmac("sha256", runtime.razorpaySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  if (expected !== signature) return res.status(400).json({ message: "Invalid payment signature" });
  booking.paymentStatus = "paid";
  booking.status = "paid";
  booking.history.push({ status: "paid", at: nowIso() });
  broadcastBooking(booking, "payment:verified", { paymentId, orderId });
  broadcastBooking(booking, "trip:completed", { paymentId });
  res.json({ success: true, bookingId: booking.id, paymentId });
});

const port = Number(process.env.PW_API_PORT || 4010);
httpServer.listen(port, "127.0.0.1", () => {
  console.log(`[playwright-mock-server] listening on ${port}`);
});
