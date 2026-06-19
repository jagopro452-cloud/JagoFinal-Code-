import "dotenv/config";
import { Client as PgClient } from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { LiveClient } from "../tests/playwright/support/live-client";
import { connectLiveSocket, qaAddress, waitForConnect, waitForSocketEvent } from "../tests/playwright/support/live-utils";
import { runtime } from "../tests/playwright/support/runtime";
import { diagnoseDispatch } from "../server/dispatch-diag";
import { db as rawDb } from "../server/db";
import { sql as rawSql } from "drizzle-orm";
import {
  findEligibleDriversForDispatch,
  getDriverDispatchProfile,
  isDriverEligibleForDispatch,
  resolveDispatchRequirementsFromTrip,
} from "../server/dispatch-eligibility";

async function main() {
  const client = await LiveClient.create();
  const pg = new PgClient({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  let driverSocket: ReturnType<typeof connectLiveSocket> | null = null;
  try {
    const shared = await client.initializeSharedState();
    const customer = shared.actors.customerPrimary.session;
    const driver = shared.actors.driverBikePrimary.session;
    const bike = shared.categories.bike;

    await client.bestEffortCancelActiveTrip(customer, "dispatch compare cleanup");

    driverSocket = connectLiveSocket(driver.token, driver.user.id, "driver");
    await waitForConnect(driverSocket);
    driverSocket.emit("driver:online", {
      isOnline: true,
      lat: runtime.ridePickupLat,
      lng: runtime.ridePickupLng,
    });
    await waitForSocketEvent(driverSocket, "driver:online_ack");

    const booking = await client.bookRide(customer, {
      pickupAddress: qaAddress("dispatch compare pickup"),
      pickupLat: runtime.ridePickupLat,
      pickupLng: runtime.ridePickupLng,
      destinationAddress: qaAddress("dispatch compare destination"),
      destinationLat: runtime.rideDestinationLat,
      destinationLng: runtime.rideDestinationLng,
      vehicleCategoryId: bike.id,
      vehicleType: bike.vehicleType || bike.serviceType || bike.name.toLowerCase(),
      estimatedFare: 149,
      estimatedDistance: 5.4,
      paymentMethod: "cash",
      tripType: "normal",
    });

    const tripId = String(booking?.tripId || booking?.id || booking?.trip?.id);
    const driverId = String(driver.user.id);

    const requirements = await resolveDispatchRequirementsFromTrip(tripId);
    const profile = await getDriverDispatchProfile(driverId);
    const directEligibility = requirements
      ? await isDriverEligibleForDispatch(driverId, requirements)
      : null;
    const diag = await diagnoseDispatch(tripId, {
      includeEligible: true,
      includeRawData: true,
      simulate: true,
    });
    const strict = requirements
      ? await findEligibleDriversForDispatch({
          pickupLat: runtime.ridePickupLat,
          pickupLng: runtime.ridePickupLng,
          radiusKm: diag.radiusKm,
          excludeDriverIds: [],
          limit: 5,
          requirements,
        })
      : [];
    const relaxedStrict = requirements
      ? await findEligibleDriversForDispatch({
          pickupLat: runtime.ridePickupLat,
          pickupLng: runtime.ridePickupLng,
          radiusKm: diag.radiusKm,
          excludeDriverIds: [],
          limit: 5,
          requirements: {
            ...requirements,
            strictCategoryIds: null,
          },
        })
      : [];

    const db = await pg.query(
      `
      SELECT
        u.id,
        u.is_online,
        u.verification_status,
        u.current_trip_id,
        dl.is_online AS dl_online,
        dl.lat,
        dl.lng,
        dl.updated_at,
        EXTRACT(EPOCH FROM (NOW() - dl.updated_at))::int AS seconds_since_update,
        dd.vehicle_category_id,
        dd.service_eligibility,
        dd.approval_state
      FROM users u
      LEFT JOIN driver_locations dl ON dl.driver_id = u.id
      LEFT JOIN driver_details dd ON dd.user_id = u.id
      WHERE u.id = $1::uuid
      `,
      [driverId],
    );

    const candidateSql = await pg.query(
      `
      SELECT
        u.id, u.full_name, u.phone, u.rating, u.city,
        u.is_active, u.is_locked, u.current_trip_id, u.verification_status, u.is_online,
        dl.is_online as dl_online, dl.lat, dl.lng, dl.updated_at,
        dd.vehicle_category_id as vehicle_category_id,
        COALESCE(dd.vehicle_subcategory, '') as vehicle_subcategory,
        COALESCE(dd.service_eligibility, '{}'::text[]) as service_eligibility,
        dd.parcel_eligibility, dd.pool_eligibility, dd.outstation_eligibility, dd.intercity_eligibility,
        dd.seat_capacity, COALESCE(dd.approval_state, '') as approval_state,
        COALESCE(dd.city_eligibility, '{}'::text[]) as city_eligibility,
        COALESCE(vc.name, '') as vehicle_name,
        COALESCE(vc.vehicle_type, '') as vehicle_type_code,
        COALESCE(vc.total_seats, 0) as category_total_seats,
        COALESCE(vc.is_carpool, false) as category_is_carpool,
        COALESCE(vc.service_type, '') as category_service_type,
        SQRT(
          POW((dl.lat - $1) * 111.32, 2) +
          POW((dl.lng - $2) * 111.32 * COS(RADIANS($1)), 2)
        ) as distance_km
      FROM users u
      JOIN driver_locations dl ON dl.driver_id = u.id
      LEFT JOIN driver_details dd ON dd.user_id = u.id
      LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
      WHERE u.user_type = 'driver'
        AND u.is_active = true
        AND u.is_locked = false
        AND dl.is_online = true
        AND u.current_trip_id IS NULL
        AND dl.lat != 0 AND dl.lng != 0
        AND dl.updated_at > NOW() - INTERVAL '90 seconds'
        AND dd.vehicle_category_id = ANY($3::uuid[])
        AND SQRT(
          POW((dl.lat - $1) * 111.32, 2) +
          POW((dl.lng - $2) * 111.32 * COS(RADIANS($1)), 2)
        ) <= $4
      ORDER BY distance_km ASC
      LIMIT 20
      `,
      [
        runtime.ridePickupLat,
        runtime.ridePickupLng,
        requirements?.strictCategoryIds || [],
        diag.radiusKm,
      ],
    );
    const drizzleStrictCategoryIds = requirements?.strictCategoryIds || [];
    const drizzleCategoryClause = drizzleStrictCategoryIds.length
      ? drizzleStrictCategoryIds.length === 1
        ? rawSql`AND dd.vehicle_category_id = ${drizzleStrictCategoryIds[0]}::uuid`
        : rawSql`AND dd.vehicle_category_id IN (${rawSql.join(
            drizzleStrictCategoryIds.map((id) => rawSql`${id}::uuid`),
            rawSql`, `,
          )})`
      : requirements?.vehicleCategoryId
        ? rawSql`AND dd.vehicle_category_id = ${requirements.vehicleCategoryId}::uuid`
        : rawSql``;
    const drizzleCandidates = requirements
      ? await rawDb.execute(rawSql`
          SELECT
            u.id, u.full_name, u.phone, u.rating, u.city,
            u.is_active, u.is_locked, u.current_trip_id, u.verification_status, u.is_online,
            dl.is_online as dl_online, dl.lat, dl.lng, dl.updated_at,
            dd.vehicle_category_id as vehicle_category_id
          FROM users u
          JOIN driver_locations dl ON dl.driver_id = u.id
          LEFT JOIN driver_details dd ON dd.user_id = u.id
          LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
          WHERE u.user_type = 'driver'
            AND u.is_active = true
            AND u.is_locked = false
            AND dl.is_online = true
            AND u.current_trip_id IS NULL
            AND dl.lat != 0 AND dl.lng != 0
            AND dl.updated_at > NOW() - INTERVAL '90 seconds'
            ${drizzleCategoryClause}
            AND SQRT(
              POW((dl.lat - ${runtime.ridePickupLat}) * 111.32, 2) +
              POW((dl.lng - ${runtime.ridePickupLng}) * 111.32 * COS(RADIANS(${runtime.ridePickupLat})), 2)
            ) <= ${diag.radiusKm}
          ORDER BY SQRT(
            POW((dl.lat - ${runtime.ridePickupLat}) * 111.32, 2) +
            POW((dl.lng - ${runtime.ridePickupLng}) * 111.32 * COS(RADIANS(${runtime.ridePickupLat})), 2)
          ) ASC
          LIMIT 20
        `)
      : { rows: [] as any[] };

    const diagDriver = diag.drivers.find((entry) => entry.driverId === driverId) || null;

    const report = {
      tripId,
      driverId,
      requirements,
      profile,
      directEligibility,
      diagRadiusKm: diag.radiusKm,
      diagDriver,
      strictDriversCount: strict.length,
      strictDrivers: strict,
      relaxedStrictDriversCount: relaxedStrict.length,
      relaxedStrictDrivers: relaxedStrict,
      strictCandidateRows: candidateSql.rows,
      strictCandidateRowsViaDrizzle: drizzleCandidates.rows,
      dbDriver: db.rows[0] || null,
      incomingTrip: await client.getDriverIncomingTrip(driver),
    };

    const outPath = path.resolve("qa-evidence", "dispatch-compare.json");
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    driverSocket?.close();
    await pg.end().catch(() => {});
    await client.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).then(() => process.exit(0));
