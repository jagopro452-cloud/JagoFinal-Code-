const apiBase = process.env.PW_API_BASE_URL || "http://127.0.0.1:5014";
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
    const customer = bootstrap.sessions?.customers?.find((entry) => entry.phone === runtime.liveCustomerPhone)?.session;
    const driver = bootstrap.sessions?.drivers?.find((entry) => entry.phone === runtime.liveDriverBikePhone)?.session;
    if (!customer || !driver) {
      throw new Error("Seed bootstrap did not return reusable customer/driver sessions.");
    }
    const bike = await live.getCategoryByLabel("bike");

    const bikePhones = ["9100000001", "9100000002", "9100000003", "9100000004"];
    for (const phone of bikePhones) {
      const session = bootstrap.sessions?.drivers?.find((entry) => entry.phone === phone)?.session;
      if (!session) throw new Error(`Missing seeded driver session for ${phone}`);
      await live.setDriverOnlineStatus(session, { isOnline: false, lat: runtime.ridePickupLat, lng: runtime.ridePickupLng });
    }
    await live.setDriverOnlineStatus(driver, { isOnline: true, lat: runtime.ridePickupLat, lng: runtime.ridePickupLng });
    await sleep(1500);

    const tag = `[ACCEPT-${Date.now()}]`;
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
    if (!tripId) throw new Error("Booking did not return trip id");

    let incoming: any = null;
    for (let i = 0; i < 10; i++) {
      incoming = await live.getDriverIncomingTrip(driver);
      if (incoming?.trip?.tripId === tripId || incoming?.trip?.id === tripId) {
        break;
      }
      await sleep(1000);
    }

    console.log("tripId=", tripId);
    console.log("incoming=", JSON.stringify(incoming));
    if (!incoming?.trip) {
      throw new Error("Driver never received incoming trip");
    }

    const accepted = await live.acceptTrip(driver, tripId);
    await sleep(1000);
    const customerActive = await live.getCustomerActiveTrip(customer);
    const driverActive = await live.getDriverActiveTrip(driver);

    console.log("accepted=", JSON.stringify(accepted));
    console.log("customerActive=", JSON.stringify(customerActive));
    console.log("driverActive=", JSON.stringify(driverActive));
  } finally {
    await live.dispose().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
