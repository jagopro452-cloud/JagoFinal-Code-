import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function run() {
  const r = await db.execute(sql`SELECT name FROM popular_locations LIMIT 10`);
  console.log(JSON.stringify(r.rows, null, 2));
  process.exit(0);
}
run();
