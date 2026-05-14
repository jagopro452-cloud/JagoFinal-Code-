type PresenceRole = "driver" | "customer";

const SOCKET_PRESENCE_TTL_SEC = 60 * 60 * 24;

let redisClientPromise: Promise<any | null> | null = null;

function presenceKey(role: PresenceRole, userId: string) {
  return `socket:presence:${role}:${userId}`;
}

async function getRedisClient(): Promise<any | null> {
  if (redisClientPromise) return redisClientPromise;

  redisClientPromise = (async () => {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) return null;

    try {
      const { default: IORedis } = await import("ioredis");
      const client = new IORedis(redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      client.on("error", () => { });
      await client.connect();
      return client;
    } catch {
      return null;
    }
  })();

  return redisClientPromise;
}

export async function addSocketPresence(role: PresenceRole, userId: string, socketId: string): Promise<void> {
  const client = await getRedisClient();
  if (!client) return;
  try {
    await client.sadd(presenceKey(role, userId), socketId);
    await client.expire(presenceKey(role, userId), SOCKET_PRESENCE_TTL_SEC);
  } catch {
    // Presence caching must never break socket flows.
  }
}

export async function removeSocketPresence(role: PresenceRole, userId: string, socketId: string): Promise<void> {
  const client = await getRedisClient();
  if (!client) return;
  try {
    const key = presenceKey(role, userId);
    await client.srem(key, socketId);
    const remaining = Number(await client.scard(key));
    if (remaining <= 0) {
      await client.del(key);
    } else {
      await client.expire(key, SOCKET_PRESENCE_TTL_SEC);
    }
  } catch {
    // Presence cleanup must never break disconnect flows.
  }
}

export async function hasSocketPresence(role: PresenceRole, userId: string): Promise<boolean> {
  const client = await getRedisClient();
  if (!client) return false;
  try {
    return Number(await client.scard(presenceKey(role, userId))) > 0;
  } catch {
    return false;
  }
}
