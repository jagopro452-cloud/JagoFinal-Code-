import { db } from '../server/db';
import { sql } from 'drizzle-orm';

async function checkKeys() {
  try {
    const res = await db.execute(sql`SELECT key_name, value FROM business_settings WHERE key_name ILIKE '%map%' OR key_name ILIKE '%rapid%' OR key_name ILIKE '%api%'`);
    console.log(res.rows);
  } catch (e: any) {
    console.error(e.message);
  }
  process.exit();
}

checkKeys();
