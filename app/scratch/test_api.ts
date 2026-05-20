import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function testSearch() {
  const r = await db.execute(sql`SELECT value FROM business_settings WHERE key_name = 'google_maps_key'`);
  const apiKey = (r.rows[0] as any)?.value;
  
  if (!apiKey) {
    console.log("No API key found in DB");
    return;
  }

  const query = "man";
  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(query)}&key=${apiKey}`;
  
  console.log(`Testing URL: ${url.replace(apiKey, 'REDACTED')}`);
  
  const response = await fetch(url, {
    headers: { 'Referer': 'https://jagopro.org' }
  });
  
  const data = await response.json() as any;
  console.log("Response Status:", response.status);
  console.log("Response Body Data Status:", data.status);
  if (data.error_message) console.log("Error Message:", data.error_message);
  console.log("Predictions count:", data.predictions?.length || 0);
  if (data.predictions?.length > 0) {
    console.log("First prediction:", data.predictions[0].description);
  }
  
  process.exit(0);
}

testSearch();
