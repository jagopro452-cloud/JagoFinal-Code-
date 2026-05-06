/**
 * Redis-backed driver presence cache.
 *
 * Stores each online driver as a Redis HASH at key `presence:driver:{id}` with a
 * 35-second TTL. The driver location socket handler refreshes the TTL on every GPS
 * ping (every ~5s), so the key expires only if the driver goes truly silent.
 *
 * Why Redis instead of DB for this:
 *  - dispatch.ts runs a haversine query on driver_locations for every booking —
 *    that's a full table scan on PostgreSQL.
 *  - Redis GEORADIUS returns nearby drivers in <1ms vs 20-100ms DB.
 *  - TTL-based expiry gives free "ghost driver" cleanup with zero background jobs.
 *
 * Fallback: if Redis is unavailable the functions no-op (DB remains the source of
 * truth) — the system degrades gracefully, never hard-fails.
 */

import IORedis from "ioredis";

const PRESENCE_TTL_SEC = 35;
const GEO_KEY = "driver:geo";

let redis: IORedis | null = null;
let redisConnectPromise: Promise<IORedis | null> | null = null;

function getRedis(): IORedis | null {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    redis = new IORedis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on("error", () => { });
    return redis;
  } catch {
    return null;
  }
}

async function connectRedis(): Promise<IORedis | null> {
  const r = getRedis();
  if (!r) return null;
  if (r.status === "ready") return r;
  if (redisConnectPromise) return redisConnectPromise;

  redisConnectPromise = (async () => {
    try {
      if (r.status === "wait") {
        await r.connect();
      }
      await r.ping();
      return r;
    } catch {
      return null;
    } finally {
      redisConnectPromise = null;
    }
  })();

  return redisConnectPromise;
}

export async function checkRedis(): Promise<{ status: "ok" | "down" | "not_configured"; error?: string | null }> {
  const r = await connectRedis();
  if (!r) {
    return {
      status: process.env.REDIS_URL ? "down" : "not_configured",
      error: process.env.REDIS_URL ? "ping_failed" : "REDIS_URL not configured",
    };
  }

  try {
    await r.ping();
    return { status: "ok" };
  } catch (error: any) {
    return { status: "down", error: error?.message || "ping_failed" };
  }
}

export interface DriverPresence {
  lat: number;
  lng: number;
  heading: number;
  speed: number;
  vehicleType: string;
  vehicleCategoryId: string;
  lastSeen: number;
}

/** Write driver presence to Redis. Call on every location update. */
export async function setDriverPresence(driverId: string, data: DriverPresence): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    const key = `presence:driver:${driverId}`;
    const pipeline = r.pipeline();
    pipeline.hset(key, {
      lat: String(data.lat),
      lng: String(data.lng),
      heading: String(data.heading),
      speed: String(data.speed),
      vehicleType: data.vehicleType,
      vehicleCategoryId: data.vehicleCategoryId,
      lastSeen: String(data.lastSeen),
    });
    pipeline.expire(key, PRESENCE_TTL_SEC);
    // Also update geo index for radius search
    pipeline.geoadd(GEO_KEY, data.lng, data.lat, driverId);
    await pipeline.exec();
  } catch { }
}

/** Remove driver from presence cache (explicit offline or grace period expired). */
export async function deleteDriverPresence(driverId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.pipeline()
      .del(`presence:driver:${driverId}`)
      .zrem(GEO_KEY, driverId)
      .exec();
  } catch { }
}

/** Read single driver's presence. Returns null if not in cache. */
export async function getDriverPresence(driverId: string): Promise<DriverPresence | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const data = await r.hgetall(`presence:driver:${driverId}`);
    if (!data || !data.lat) return null;
    return {
      lat: parseFloat(data.lat),
      lng: parseFloat(data.lng),
      heading: parseFloat(data.heading || "0"),
      speed: parseFloat(data.speed || "0"),
      vehicleType: data.vehicleType || "",
      vehicleCategoryId: data.vehicleCategoryId || "",
      lastSeen: parseInt(data.lastSeen || "0"),
    };
  } catch {
    return null;
  }
}

/** Find online driver IDs within radiusKm of a point using Redis GEORADIUS.
 *  Returns [] if Redis is unavailable (caller falls back to DB). */
export async function getNearbyDriverIds(
  lat: number,
  lng: number,
  radiusKm: number,
  vehicleType?: string
): Promise<string[]> {
  const r = getRedis();
  if (!r) return [];
  try {
    const members = await r.georadius(GEO_KEY, lng, lat, radiusKm, "km", "ASC", "COUNT", 50);
    const ids = (members as string[]).filter(Boolean);
    if (!vehicleType) return ids;
    // Filter by vehicleType from presence hash
    const filtered: string[] = [];
    for (const id of ids) {
      const vt = await r.hget(`presence:driver:${id}`, "vehicleType");
      if (vt === vehicleType) filtered.push(id);
    }
    return filtered;
  } catch {
    return [];
  }
}

/** How many drivers are currently online (Redis count, best-effort). */
export async function getOnlineDriverCount(): Promise<number | null> {
  const r = await connectRedis();
  if (!r) return null;
  try {
    return await r.zcard(GEO_KEY);
  } catch {
    return null;
  }
}

/** Health check for presence layer. */
export async function presenceHealthy(): Promise<boolean> {
  const health = await checkRedis();
  return health.status === "ok";
}
