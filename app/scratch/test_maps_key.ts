import { sql } from 'drizzle-orm';
import { db } from '../server/db';
import * as dotenv from 'dotenv';
dotenv.config();

async function check() {
  try {
    const r = await db.execute(sql`
      SELECT value FROM business_settings WHERE key_name IN ('google_maps_key', 'GOOGLE_MAPS_API_KEY') LIMIT 1
    `);
    console.log("DB Key:", r.rows[0]?.value);
    console.log("ENV Key:", process.env.GOOGLE_MAPS_API_KEY);
  } catch (e: any) {
    console.error(e.message);
  }
  process.exit();
}
check();
