const { Pool } = require("pg");

(async () => {
  const url = "postgresql://postgres:postgres@localhost:5432/postgres";
  const pool = new Pool({ connectionString: url });
  const tables = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='franchisees'`,
  );
  console.log("franchisees table:", tables.rowCount);
  if (tables.rowCount) {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='franchisees' ORDER BY column_name`,
    );
    console.log(cols.rows.map((r) => r.column_name).join(", "));
  }
  await pool.end();
})();
