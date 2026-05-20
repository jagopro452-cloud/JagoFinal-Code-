import { sql } from 'drizzle-orm';
import { db } from '../server/db';

async function check() {
  try {
    const r = await db.execute(sql`
      SELECT value FROM business_settings WHERE key_name IN ('google_maps_key', 'GOOGLE_MAPS_API_KEY') LIMIT 1
    `);
    console.log("DB Key:", r.rows[0]?.value);
    console.log("ENV Key:", process.env.GOOGLE_MAPS_API_KEY);
    
    // Also test google maps api!
    const key = r.rows[0]?.value?.trim() || process.env.GOOGLE_MAPS_API_KEY;
    const res = await fetch(`https://maps.googleapis.com/maps/api/place/autocomplete/json?input=bha&key=${key}`);
    const data = await res.json();
    console.log("Google Test:", data.status, data.error_message || "");
  } catch (e: any) {
    console.error(e.message);
  }
  process.exit();
}
check();
