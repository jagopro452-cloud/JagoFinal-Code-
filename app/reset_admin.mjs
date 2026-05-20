import bcrypt from 'bcrypt';
import pg from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function resetAdmin() {
  const hash = await bcrypt.hash('123456', 10);
  console.log('New hash:', hash.substring(0, 30) + '...');

  const result = await pool.query(
    `UPDATE admins SET password=$1, is_active=true WHERE LOWER(email)='jago@jago.com' RETURNING id, email, is_active`,
    [hash]
  );

  if (result.rows.length === 0) {
    console.log('Admin not found — creating...');
    const ins = await pool.query(
      `INSERT INTO admins (name, email, password, role, is_active) VALUES ('Admin','jago@jago.com',$1,'superadmin',true) RETURNING id, email`,
      [hash]
    );
    console.log('Admin created:', ins.rows[0]);
  } else {
    console.log('Admin password updated:', result.rows[0]);
  }

  await pool.end();
}

resetAdmin().catch(e => { console.error(e); process.exit(1); });
