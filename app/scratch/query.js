require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT * FROM business_settings WHERE key_name ILIKE '%map%' OR key_name ILIKE '%google%'").then(res => {
  console.log(res.rows);
  pool.end();
}).catch(e => {
  console.error(e);
  pool.end();
});
