import { pool } from "./db";

type TableColumnCheck = {
  table: string;
  columns: string[];
};

type IndexCheck = {
  table: string;
  pattern: string;
  description: string;
};

const requiredTables = [
  "admins",
  "admin_sessions",
  "admin_refresh_tokens",
  "admin_login_otp",
  "admin_otp_resets",
  "sessions",
  "refresh_tokens",
  "otp_request_events",
  "driver_documents",
  "booking_intents",
  "company_wallet_events",
  "customer_payments",
  "driver_payments",
  "withdraw_requests",
  "trip_requests",
  "transactions",
  "referrals",
];

const requiredColumns: TableColumnCheck[] = [
  { table: "customer_payments", columns: ["booking_intent_id", "payment_context", "trip_id", "razorpay_order_id", "payment_type", "status"] },
  { table: "driver_payments", columns: ["trip_id", "plan_id", "insurance_plan_id", "payment_context", "razorpay_order_id", "payment_type", "status"] },
  { table: "withdraw_requests", columns: ["driver_payment_id", "user_id", "status", "amount"] },
  { table: "trip_requests", columns: ["booking_intent_id", "customer_id", "payment_status", "current_status"] },
  { table: "booking_intents", columns: ["customer_id", "status", "razorpay_order_id", "razorpay_payment_id"] },
  { table: "company_wallet_events", columns: ["company_id", "amount", "type", "reason", "created_at"] },
  { table: "admin_sessions", columns: ["admin_id", "token", "device_id", "expires_at"] },
  { table: "sessions", columns: ["user_id", "token", "device_id", "expires_at"] },
  { table: "driver_documents", columns: ["driver_id", "doc_type", "file_url", "file_data", "mime_type", "status"] },
];

const requiredIndexes: IndexCheck[] = [
  { table: "customer_payments", pattern: "%razorpay_order_id%payment_type%", description: "customer_payments unique order/payment type index" },
  { table: "customer_payments", pattern: "%booking_intent_id%", description: "customer_payments booking_intent_id unique linkage index" },
  { table: "driver_payments", pattern: "%razorpay_order_id%payment_type%", description: "driver_payments unique order/payment type index" },
  { table: "withdraw_requests", pattern: "%driver_payment_id%", description: "withdraw_requests driver_payment_id unique/indexed linkage" },
  { table: "trip_requests", pattern: "%booking_intent_id%", description: "trip_requests booking_intent_id unique linkage index" },
  { table: "sessions", pattern: "%token%", description: "sessions token index" },
  { table: "admin_sessions", pattern: "%token%", description: "admin_sessions token index" },
];

const requiredForeignKeys = [
  { table: "customer_payments", column: "customer_id", references: "users" },
  { table: "customer_payments", column: "trip_id", references: "trip_requests" },
  { table: "customer_payments", column: "booking_intent_id", references: "booking_intents" },
  { table: "driver_payments", column: "driver_id", references: "users" },
  { table: "driver_payments", column: "trip_id", references: "trip_requests" },
  { table: "withdraw_requests", column: "user_id", references: "users" },
  { table: "withdraw_requests", column: "driver_payment_id", references: "driver_payments" },
  { table: "trip_requests", column: "customer_id", references: "users" },
  { table: "trip_requests", column: "driver_id", references: "users" },
  { table: "trip_requests", column: "booking_intent_id", references: "booking_intents" },
  { table: "transactions", column: "user_id", references: "users" },
  { table: "transactions", column: "trip_id", references: "trip_requests" },
  { table: "referrals", column: "referrer_id", references: "users" },
  { table: "referrals", column: "referred_id", references: "users" },
  { table: "company_wallet_events", column: "company_id", references: "b2b_companies" },
];

type SchemaAssertionInput = {
  tables?: string[];
  columns?: TableColumnCheck[];
  indexes?: IndexCheck[];
  foreignKeys?: Array<{ table: string; column: string; references: string }>;
};

async function assertTablesExist(tables: string[]) {
  if (!tables.length) return;
  const result = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])`,
    [tables],
  );
  const present = new Set(result.rows.map((row) => String(row.tablename)));
  const missing = tables.filter((table) => !present.has(table));
  if (missing.length) {
    throw new Error(`Missing required tables: ${missing.join(", ")}`);
  }
}

async function assertColumnsExist(checks: TableColumnCheck[]) {
  for (const check of checks) {
    const result = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name = ANY($2::text[])`,
      [check.table, check.columns],
    );
    const present = new Set(result.rows.map((row) => String(row.column_name)));
    const missing = check.columns.filter((column) => !present.has(column));
    if (missing.length) {
      throw new Error(`Missing required columns on ${check.table}: ${missing.join(", ")}`);
    }
  }
}

async function assertIndexesExist(checks: IndexCheck[]) {
  for (const check of checks) {
    const result = await pool.query(
      `SELECT 1
       FROM pg_indexes
       WHERE schemaname='public'
         AND tablename=$1
         AND indexdef ILIKE $2
       LIMIT 1`,
      [check.table, check.pattern],
    );
    if (!result.rowCount) {
      throw new Error(`Missing required index on ${check.table}: ${check.description}`);
    }
  }
}

async function assertForeignKeysExist(checks: Array<{ table: string; column: string; references: string }>) {
  for (const check of checks) {
    const result = await pool.query(
      `SELECT 1
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_schema = kcu.constraint_schema
        AND rc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_schema = rc.unique_constraint_schema
        AND ccu.constraint_name = rc.unique_constraint_name
       WHERE kcu.table_schema='public'
         AND kcu.table_name=$1
         AND kcu.column_name=$2
         AND ccu.table_name=$3
       LIMIT 1`,
      [check.table, check.column, check.references],
    );
    if (!result.rowCount) {
      throw new Error(`Missing foreign key ${check.table}.${check.column} -> ${check.references}`);
    }
  }
}

export async function verifyCriticalSchemaOrThrow() {
  await assertSchemaObjectsOrThrow({
    tables: requiredTables,
    columns: requiredColumns,
    indexes: requiredIndexes,
    foreignKeys: requiredForeignKeys,
  });
}

export async function assertSchemaObjectsOrThrow(input: SchemaAssertionInput) {
  await assertTablesExist(input.tables || []);
  await assertColumnsExist(input.columns || []);
  await assertIndexesExist(input.indexes || []);
  await assertForeignKeysExist(input.foreignKeys || []);
}
