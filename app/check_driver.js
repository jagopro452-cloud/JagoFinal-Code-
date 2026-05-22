import { Client } from 'pg';
import fs from 'fs';

const connectString = process.env.DATABASE_URL;
if (!connectString) {
  throw new Error('DATABASE_URL is required');
}

async function check() {
  const client = new Client({ connectionString: connectString });
  await client.connect();

  console.log("== DRIVERS ==");
  const res = await client.query(`
    SELECT u.id, u.full_name, u.phone, u.is_online, u.user_type, u.is_active, u.is_locked, u.verification_status, u.current_trip_id,
           dl.lat, dl.lng, dl.is_online as dl_online, dl.updated_at as dl_updated, dd.vehicle_category_id
    FROM users u
    LEFT JOIN driver_locations dl ON dl.driver_id = u.id
    LEFT JOIN driver_details dd ON dd.user_id = u.id
    WHERE u.user_type = 'driver'
    ORDER BY u.created_at DESC
    LIMIT 10;
  `);
  
  // Optional fixture helper for local debugging only.
  if (process.env.ENABLE_DRIVER_FIXTURE === 'true' && res.rows.length > 0) {
    const driverId = res.rows[0].id;
    const vcId = process.env.TEST_VEHICLE_CATEGORY_ID;
    if (!vcId) {
      throw new Error('TEST_VEHICLE_CATEGORY_ID is required when ENABLE_DRIVER_FIXTURE=true');
    }
    
    await client.query(`UPDATE users SET is_online = true WHERE id = $1`, [driverId]);
    await client.query(`
      INSERT INTO driver_details (user_id, vehicle_category_id) 
      VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET vehicle_category_id = $2
    `, [driverId, vcId]);
    
    await client.query(`
      INSERT INTO driver_locations (driver_id, lat, lng, is_online, updated_at)
      VALUES ($1, 16.371, 80.527, true, NOW())
      ON CONFLICT (driver_id) DO UPDATE SET is_online = true, lat = 16.371, lng = 80.527, updated_at = NOW()
    `, [driverId]);
    
    console.log("Forced driver " + driverId + " online with category " + vcId);
  }

  console.log("== LATEST TRIPS == ");
  const trips = await client.query(`
    SELECT id, ref_id, customer_id, driver_id, vehicle_category_id, pickup_lat, pickup_lng, current_status, created_at
    FROM trip_requests
    ORDER BY created_at DESC
    LIMIT 3;
  `);
  for (const t of trips.rows) {
    console.log(t);
  }

  console.log("== SOCKET CONNECTIONS ==");
  // We can't see active socket connections easily from just DB, but we can see FCM tokens
  const fcm = await client.query(`
    SELECT user_id, fcm_token, updated_at FROM user_devices ORDER BY updated_at DESC LIMIT 5;
  `);
  fs.writeFileSync('check_output.json', JSON.stringify({ drivers: res.rows, trips: trips.rows, fcm: fcm.rows }, null, 2));

  await client.end();
}

check().then(() => {
  console.log("Done");
}).catch(console.error);
