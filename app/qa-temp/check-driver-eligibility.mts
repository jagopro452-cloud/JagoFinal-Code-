import { pool } from "../server/db.ts";
import {
  getDriverDispatchProfile,
  isDriverEligibleForDispatch,
  resolveDispatchRequirementsFromTrip,
} from "../server/dispatch-eligibility.ts";

const tripId = process.argv[2];
const driverId = process.argv[3];

if (!tripId || !driverId) {
  console.error("usage: node --import tsx qa-temp/check-driver-eligibility.mts <tripId> <driverId>");
  process.exit(1);
}

async function main() {
  try {
    const requirements = await resolveDispatchRequirementsFromTrip(tripId);
    const profile = await getDriverDispatchProfile(driverId);
    const eligibility = requirements
      ? await isDriverEligibleForDispatch(driverId, requirements)
      : null;

    console.log(JSON.stringify({
      tripId,
      driverId,
      requirements,
      profile,
      eligibility,
    }, null, 2));
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
