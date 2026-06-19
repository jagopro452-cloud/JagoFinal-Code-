require("dotenv").config({ path: ".env", override: true });
const { Pool } = require("pg");

async function audit(label, connectionString) {
  const pool = new Pool({ connectionString });
  const out = { label };

  const tables = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('franchisees','franchise_payouts','franchise_service_assignments','migrations','parcel_orders') ORDER BY tablename`,
  );
  out.tables = tables.rows.map((r) => r.tablename);

  if (out.tables.includes("franchisees")) {
    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='franchisees'
       ORDER BY ordinal_position`,
    );
    out.franchiseesColumns = cols.rows;
  }

  const idx = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname='public' AND tablename IN ('franchisees','franchise_payouts','franchise_service_assignments','parcel_orders')
     ORDER BY tablename, indexname`,
  );
  out.indexes = idx.rows;

  if (out.tables.includes("migrations")) {
    const mig = await pool.query(`SELECT name, applied_at FROM migrations ORDER BY name`);
    out.migrations = mig.rows;
  } else {
    out.migrations = null;
  }

  await pool.end();
  return out;
}

async function main() {
  const local = await audit("local", process.env.DATABASE_URL);
  console.log(JSON.stringify({ local }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
