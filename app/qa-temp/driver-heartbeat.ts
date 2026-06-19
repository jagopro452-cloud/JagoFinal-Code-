import fs from "node:fs/promises";
import path from "node:path";
import { io, type Socket } from "socket.io-client";

type DriverActor = {
  label: string;
  session: {
    token: string;
    user: {
      id: string;
      phone: string;
      userType: string;
    };
  };
};

type SuiteState = {
  actors: Record<string, DriverActor | null>;
};

const baseURL = process.env.PW_BASE_URL || "http://127.0.0.1:5013";
const apiBaseURL = process.env.PW_API_BASE_URL || baseURL;
const statePath = path.resolve(process.cwd(), "test-results", ".live", "suite-state.json");
const heartbeatMs = Number(process.env.QA_HEARTBEAT_MS || "15000");
const pickupLat = Number(process.env.PW_RIDE_PICKUP_LAT || "17.385");
const pickupLng = Number(process.env.PW_RIDE_PICKUP_LNG || "78.4867");

function log(message: string) {
  console.log(`[HEARTBEAT] ${new Date().toISOString()} ${message}`);
}

function connectDriverSocket(token: string, userId: string) {
  return io(apiBaseURL, {
    transports: ["websocket", "polling"],
    path: "/socket.io",
    query: {
      userId,
      userType: "driver",
      token,
    },
    auth: {
      token,
    },
    extraHeaders: {
      Origin: baseURL,
    },
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: 10,
    timeout: 20_000,
  });
}

async function waitForSocketReady(socket: Socket, label: string, timeoutMs = 20_000) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} connect timeout`)), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} socket ready timeout`)), timeoutMs);
    socket.once("socket:ready", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("disconnect", (reason) => {
      clearTimeout(timer);
      reject(new Error(`${label} disconnected before ready: ${reason}`));
    });
  });
}

async function loadDrivers(): Promise<DriverActor[]> {
  const raw = await fs.readFile(statePath, "utf8");
  const state = JSON.parse(raw) as SuiteState;
  return Object.entries(state.actors)
    .filter(([key, actor]) => key.startsWith("driverBike") && actor?.session?.token)
    .map(([, actor]) => actor as DriverActor);
}

async function main() {
  const drivers = await loadDrivers();
  if (!drivers.length) {
    throw new Error("No bike driver actors found in live suite state.");
  }

  const intervals: NodeJS.Timeout[] = [];
  const sockets: Socket[] = [];

  const shutdown = async () => {
    for (const interval of intervals) clearInterval(interval);
    for (const socket of sockets) {
      try {
        socket.emit("driver:online", { isOnline: false });
      } catch {}
      socket.disconnect();
    }
    log("shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  for (const [index, driver] of drivers.entries()) {
    const lat = pickupLat + index * 0.0002;
    const lng = pickupLng + index * 0.0002;
    const socket = connectDriverSocket(driver.session.token, driver.session.user.id);
    sockets.push(socket);
    await waitForSocketReady(socket, driver.label);
    log(`${driver.label} connected driverId=${driver.session.user.id}`);

    socket.on("driver:online_ack", (payload) => {
      log(`${driver.label} online_ack=${JSON.stringify(payload)}`);
    });

    socket.emit("driver:online", {
      isOnline: true,
      lat,
      lng,
    });
    socket.emit("driver:location", {
      lat,
      lng,
      heading: 90,
      speed: 8,
    });

    const interval = setInterval(() => {
      socket.emit("driver:location", {
        lat,
        lng,
        heading: 90,
        speed: 8,
      });
      log(`${driver.label} heartbeat lat=${lat} lng=${lng}`);
    }, heartbeatMs);
    intervals.push(interval);
  }

  log(`heartbeat runner active drivers=${drivers.length} heartbeatMs=${heartbeatMs}`);
}

main().catch((error) => {
  console.error(`[HEARTBEAT] fatal ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
