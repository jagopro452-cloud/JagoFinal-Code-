import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function check() {
  const r = await db.execute(sql`SELECT key_name, value FROM business_settings WHERE key_name LIKE 'google_maps_key%' OR key_name LIKE 'GOOGLE_MAPS_API_KEY%'`);
  console.log(JSON.stringify(r.rows, null, 2));
  process.exit(0);
}
check();
