import crypto from "crypto";
import { db as rawDb } from "../db";
import { sql as rawSql } from "drizzle-orm";

export type SessionContext = {
  deviceId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

let appAuthSchemaReady: Promise<void> | null = null;

async function ensureAppAuthSchemaInner() {
  await rawDb.execute(rawSql`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      expires_at TIMESTAMP NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT false,
      revoked_at TIMESTAMP,
      last_active_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await rawDb.execute(rawSql`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      expires_at TIMESTAMP NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT false,
      revoked_at TIMESTAMP,
      replaced_by_token TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await rawDb.execute(rawSql`
    CREATE TABLE IF NOT EXISTS otp_request_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone VARCHAR(20) NOT NULL,
      country_code VARCHAR(8) NOT NULL DEFAULT '+91',
      device_id TEXT,
      ip_address TEXT,
      user_agent TEXT,
      user_type VARCHAR(25) NOT NULL DEFAULT 'customer',
      event_type VARCHAR(20) NOT NULL,
      outcome VARCHAR(50) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await rawDb.execute(rawSql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id TEXT`).catch(() => undefined);
  await rawDb.execute(rawSql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_address TEXT`).catch(() => undefined);
  await rawDb.execute(rawSql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT`).catch(() => undefined);
  await rawDb.execute(rawSql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked BOOLEAN NOT NULL DEFAULT false`).catch(() => undefined);
  await rawDb.execute(rawSql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP`).catch(() => undefined);
  await rawDb.execute(rawSql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP DEFAULT NOW()`).catch(() => undefined);
  await rawDb.execute(rawSql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`).catch(() => undefined);

  await rawDb.execute(rawSql`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS device_id TEXT`).catch(() => undefined);
  await rawDb.execute(rawSql`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip_address TEXT`).catch(() => undefined);
  await rawDb.execute(rawSql`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent TEXT`).catch(() => undefined);
  await rawDb.execute(rawSql`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked BOOLEAN NOT NULL DEFAULT false`).catch(() => undefined);
  await rawDb.execute(rawSql`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP`).catch(() => undefined);
  await rawDb.execute(rawSql`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS replaced_by_token TEXT`).catch(() => undefined);
  await rawDb.execute(rawSql`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`).catch(() => undefined);

  await rawDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`).catch(() => undefined);
  await rawDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, expires_at) WHERE revoked = false`).catch(() => undefined);
  await rawDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)`).catch(() => undefined);
  await rawDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, expires_at) WHERE revoked = false`).catch(() => undefined);
  await rawDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session_id ON refresh_tokens(session_id)`).catch(() => undefined);
  await rawDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_otp_request_events_phone_created ON otp_request_events(phone, created_at DESC)`).catch(() => undefined);
}

export async function ensureAppAuthSchema() {
  if (!appAuthSchemaReady) {
    appAuthSchemaReady = ensureAppAuthSchemaInner().catch((error) => {
      appAuthSchemaReady = null;
      throw error;
    });
  }
  await appAuthSchemaReady;
}

export async function createSessionRecord(
  userId: string,
  token: string,
  expiresAtIso: string,
  context: SessionContext,
) {
  await ensureAppAuthSchema();
  const result = await rawDb.execute(rawSql`
    INSERT INTO sessions (user_id, token, device_id, ip_address, user_agent, expires_at, last_active_at)
    VALUES (
      ${userId}::uuid,
      ${token},
      ${context.deviceId},
      ${context.ipAddress || null},
      ${context.userAgent || null},
      ${expiresAtIso}::timestamp,
      NOW()
    )
    RETURNING id
  `);
  return String((result.rows[0] as any).id);
}

export async function revokeSessionById(sessionId: string) {
  await ensureAppAuthSchema();
  await rawDb.execute(rawSql`
    UPDATE sessions
    SET revoked=true, revoked_at=NOW()
    WHERE id=${sessionId}::uuid
      AND revoked=false
  `);
}

export async function touchSession(token: string) {
  await ensureAppAuthSchema();
  await rawDb.execute(rawSql`
    UPDATE sessions
    SET last_active_at=NOW()
    WHERE token=${token}
      AND revoked=false
  `).catch(() => undefined);
}

export async function findSessionByToken(token: string) {
  await ensureAppAuthSchema();
  const result = await rawDb.execute(rawSql`
    SELECT s.id, s.user_id, s.device_id, s.expires_at, u.user_type
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token=${token}
      AND s.revoked=false
      AND s.expires_at > NOW()
      AND u.is_active=true
    LIMIT 1
  `);
  return (result.rows[0] as any) || null;
}

export async function findSessionById(sessionId: string) {
  await ensureAppAuthSchema();
  const result = await rawDb.execute(rawSql`
    SELECT s.id, s.user_id, s.device_id, s.expires_at, s.token, u.user_type
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id=${sessionId}::uuid
      AND s.revoked=false
      AND s.expires_at > NOW()
      AND u.is_active=true
    LIMIT 1
  `);
  return (result.rows[0] as any) || null;
}

export async function createRefreshTokenRecord(
  userId: string,
  sessionId: string,
  token: string,
  expiresAtIso: string,
  context: SessionContext,
) {
  await ensureAppAuthSchema();
  await rawDb.execute(rawSql`
    INSERT INTO refresh_tokens (user_id, session_id, token, device_id, ip_address, user_agent, expires_at, revoked)
    VALUES (
      ${userId}::uuid,
      ${sessionId}::uuid,
      ${token},
      ${context.deviceId},
      ${context.ipAddress || null},
      ${context.userAgent || null},
      ${expiresAtIso}::timestamp,
      false
    )
  `);
}

export async function findRefreshToken(token: string) {
  await ensureAppAuthSchema();
  const result = await rawDb.execute(rawSql`
    SELECT rt.id, rt.user_id, rt.session_id, rt.token, rt.device_id, rt.expires_at, rt.revoked, u.is_active
    FROM refresh_tokens rt
    JOIN users u ON u.id = rt.user_id
    WHERE rt.token=${token}
      AND rt.revoked=false
      AND rt.expires_at > NOW()
    LIMIT 1
  `);
  return (result.rows[0] as any) || null;
}

export async function revokeRefreshToken(token: string, replacedByToken?: string | null) {
  await ensureAppAuthSchema();
  await rawDb.execute(rawSql`
    UPDATE refresh_tokens
    SET revoked=true,
        revoked_at=NOW(),
        replaced_by_token=${replacedByToken || null}
    WHERE token=${token}
      AND revoked=false
  `);
}

export async function revokeRefreshTokensBySession(sessionId: string) {
  await ensureAppAuthSchema();
  await rawDb.execute(rawSql`
    UPDATE refresh_tokens
    SET revoked=true, revoked_at=NOW()
    WHERE session_id=${sessionId}::uuid
      AND revoked=false
  `);
}

export async function countRecentOtpSendAttempts(params: {
  phone: string;
  countryCode: string;
  sinceMinutes: number;
}): Promise<number> {
  await ensureAppAuthSchema();
  const result = await rawDb.execute(rawSql`
    SELECT COUNT(*)::int AS count
    FROM otp_request_events
    WHERE phone=${params.phone}
      AND country_code=${params.countryCode}
      AND event_type='send'
      AND outcome='OTP_ATTEMPT'
      AND created_at > NOW() - (${params.sinceMinutes} * INTERVAL '1 minute')
  `);
  return Number((result.rows[0] as any)?.count || 0);
}

/**
 * Atomically check rate limit AND insert the attempt event in a single SQL statement.
 * Returns { allowed: true } if the insert succeeded (under limit),
 * or { allowed: false, currentCount } if the limit was already reached.
 * Using a CTE prevents the TOCTOU race where two concurrent requests both pass
 * a sequential count-then-insert check.
 */
export async function tryInsertOtpAttemptAtomic(params: {
  phone: string;
  countryCode: string;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  userType: string;
  maxRequests: number;
  windowMinutes: number;
}): Promise<{ allowed: boolean; currentCount: number }> {
  await ensureAppAuthSchema();
  const result = await rawDb.execute(rawSql`
    WITH recent AS (
      SELECT COUNT(*)::int AS cnt
      FROM otp_request_events
      WHERE phone=${params.phone}
        AND country_code=${params.countryCode}
        AND event_type='send'
        AND outcome='OTP_ATTEMPT'
        AND created_at > NOW() - (${params.windowMinutes} * INTERVAL '1 minute')
    ),
    inserted AS (
      INSERT INTO otp_request_events
        (phone, country_code, device_id, ip_address, user_agent, user_type, event_type, outcome)
      SELECT
        ${params.phone}, ${params.countryCode},
        ${params.deviceId || null}, ${params.ipAddress || null}, ${params.userAgent || null},
        ${params.userType}, 'send', 'OTP_ATTEMPT'
      FROM recent
      WHERE cnt < ${params.maxRequests}
      RETURNING id
    )
    SELECT (SELECT cnt FROM recent) AS current_count,
           (SELECT COUNT(*) FROM inserted)::int AS did_insert
  `);
  const row = result.rows[0] as any;
  return {
    allowed: Number(row?.did_insert || 0) > 0,
    currentCount: Number(row?.current_count || 0),
  };
}

export async function countDistinctOtpPhonesForDevice(
  deviceId: string,
  sinceMinutes: number,
) {
  await ensureAppAuthSchema();
  const result = await rawDb.execute(rawSql`
    SELECT COUNT(DISTINCT phone)::int AS count
    FROM otp_request_events
    WHERE device_id=${deviceId}
      AND created_at > NOW() - (${sinceMinutes} * INTERVAL '1 minute')
      AND event_type='send'
  `);
  return Number((result.rows[0] as any)?.count || 0);
}

export async function insertOtpRequestEvent(input: {
  phone: string;
  countryCode: string;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  userType: string;
  eventType: "send" | "verify";
  outcome: string;
}) {
  await ensureAppAuthSchema();
  await rawDb.execute(rawSql`
    INSERT INTO otp_request_events (phone, country_code, device_id, ip_address, user_agent, user_type, event_type, outcome)
    VALUES (
      ${input.phone},
      ${input.countryCode},
      ${input.deviceId || null},
      ${input.ipAddress || null},
      ${input.userAgent || null},
      ${input.userType},
      ${input.eventType},
      ${input.outcome}
    )
  `).catch(() => undefined);
}

export function createOpaqueToken(userId: string, bytes: number) {
  return `${userId}:${crypto.randomBytes(bytes).toString("hex")}`;
}
