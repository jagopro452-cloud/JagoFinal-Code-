const apiBase = process.env.PW_API_BASE_URL || "http://127.0.0.1:5013";
process.env.PW_API_BASE_URL = apiBase;
process.env.PW_ENV = process.env.PW_ENV || "live";

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const [{ LiveClient }, { runtime }] = await Promise.all([
    import("../tests/playwright/support/live-client.ts"),
    import("../tests/playwright/support/runtime.ts"),
  ]);
  const live = await LiveClient.create();

  try {
    const bootstrap = await live.seedTestAccounts();
    console.log("bootstrapMode=", bootstrap.bootstrapMode);
    const customer = bootstrap.sessions?.customers?.find((entry) => entry.phone === runtime.liveCustomerPhone)?.session;
    const driver = bootstrap.sessions?.drivers?.find((entry) => entry.phone === runtime.liveDriverBikePhone)?.session;
    if (!customer || !driver) {
      throw new Error("Seed bootstrap did not return reusable customer/driver sessions.");
    }
    const bike = await live.getCategoryByLabel("bike");

    const bikePhones = ["9100000001", "9100000002", "9100000003", "9100000004"];
    for (const phone of bikePhones) {
      const session = bootstrap.sessions?.drivers?.find((entry) => entry.phone === phone)?.session;
      if (!session) {
        throw new Error(`Missing seeded driver session for ${phone}`);
      }
      await live.setDriverOnlineStatus(session, { isOnline: false, lat: runtime.ridePickupLat, lng: runtime.ridePickupLng });
    }
    await live.setDriverOnlineStatus(driver, { isOnline: true, lat: runtime.ridePickupLat, lng: runtime.ridePickupLng });
    await sleep(1500);

    const tag = `[TRACE-${Date.now()}]`;
    const booking = await live.bookRide(customer, {
      pickupLat: runtime.ridePickupLat,
      pickupLng: runtime.ridePickupLng,
      pickupAddress: `${tag} Pickup`,
      destinationLat: runtime.rideDestinationLat,
      destinationLng: runtime.rideDestinationLng,
      destinationAddress: `${tag} Destination`,
      vehicleCategoryId: bike.id,
      paymentMethod: "cash",
      tripType: "normal",
      isScheduled: false,
    });

    const tripId = booking?.trip?.id || booking?.trip?.tripId;
    console.log("tripId=", tripId);

    for (let i = 0; i < 8; i++) {
      const [dispatchStatusResp, incoming, customerActive] = await Promise.all([
        live.get(`/api/app/dispatch/status/${tripId}`),
        live.getDriverIncomingTrip(driver),
        live.getCustomerActiveTrip(customer),
      ]);
      const dispatchStatus = await dispatchStatusResp.json().catch(() => null);

      console.log(`poll=${i + 1}`);
      console.log("dispatchStatus=", JSON.stringify(dispatchStatus));
      console.log("incoming=", JSON.stringify(incoming));
      console.log("customerActive=", JSON.stringify(customerActive));
      await sleep(2000);
    }
  } finally {
    await live.dispose().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
