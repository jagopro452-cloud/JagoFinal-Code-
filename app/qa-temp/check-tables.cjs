const { Pool } = require("pg");

async function check(url, label) {
  const pool = new Pool({ connectionString: url });
  const r = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('parcel_orders','franchisees','trip_requests') ORDER BY tablename`,
  );
  console.log(label, r.rows.map((x) => x.tablename).join(", ") || "(none)");
  await pool.end();
}

(async () => {
  await check("postgresql://postgres:postgres@localhost:5432/jago", "jago");
  await check("postgresql://postgres:postgres@localhost:5432/postgres", "postgres");
})();
