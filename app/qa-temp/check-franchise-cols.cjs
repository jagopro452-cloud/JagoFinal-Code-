const path = require("node:path");
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='franchisees'
     ORDER BY column_name`,
  );
  console.log("DB:", process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@"));
  console.log("columns:", r.rows.map((x) => x.column_name).join(", "));
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
