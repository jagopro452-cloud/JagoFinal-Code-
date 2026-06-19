const path = require("node:path");
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

async function check(url, label) {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='franchisees' AND column_name='state'`,
    );
    console.log(label, "state:", r.rows.length ? "yes" : "NO");
  } finally {
    await pool.end();
  }
}

(async () => {
  await check(process.env.DATABASE_URL, "jago(.env)");
  await check("postgresql://postgres:postgres@localhost:5432/postgres", "postgres(default)");
})();
