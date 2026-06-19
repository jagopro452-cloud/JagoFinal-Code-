const apiBase = process.env.PW_API_BASE_URL || "http://127.0.0.1:5014";
process.env.PW_API_BASE_URL = apiBase;
process.env.PW_ENV = process.env.PW_ENV || "live";

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const [{ LiveClient }, { runtime }, liveUtils] = await Promise.all([
    import("../tests/playwright/support/live-client.ts"),
    import("../tests/playwright/support/runtime.ts"),
    import("../tests/playwright/support/live-utils.ts"),
  ]);

  const {
    connectLiveSocket,
    waitForConnect,
    waitForSocketEvent,
    waitForSocketEventAny,
  } = liveUtils;

  const live = await LiveClient.create();

  try {
    const bootstrap = await live.seedTestAccounts();
    const customer = bootstrap.sessions?.customers?.find((entry) => entry.phone === runtime.liveCustomerPhone)?.session;
    const driverOne = bootstrap.sessions?.drivers?.find((entry) => entry.phone === "9100000002")?.session;
    const driverTwo = bootstrap.sessions?.drivers?.find((entry) => entry.phone === "9100000003")?.session;
    if (!customer || !driverOne || !driverTwo) {
      throw new Error("Seed bootstrap did not return reusable customer/driver sessions.");
    }

    const bike = await live.getCategoryByLabel("bike");
    const bikeDrivers = ["9100000001", "9100000002", "9100000003", "9100000004"];
    for (const phone of bikeDrivers) {
      const session = bootstrap.sessions?.drivers?.find((entry) => entry.phone === phone)?.session;
      if (!session) throw new Error(`Missing seeded driver session for ${phone}`);
      await live.setDriverOnlineStatus(session, { isOnline: false, lat: runtime.ridePickupLat, lng: runtime.ridePickupLng });
    }

    const customerActive = await live.getCustomerActiveTrip(customer).catch(() => null);
    const customerTripId = customerActive?.trip?.id || customerActive?.trip?.tripId;
    if (customerTripId) {
      await live.cancelCustomerTrip(customer, String(customerTripId), "QA race cleanup").catch(() => {});
    }

    const customerSocket = connectLiveSocket(customer.token, customer.user.id, "customer");
    const driverOneSocket = connectLiveSocket(driverOne.token, driverOne.user.id, "driver");
    const driverTwoSocket = connectLiveSocket(driverTwo.token, driverTwo.user.id, "driver");

    try {
      await Promise.all([
        waitForConnect(customerSocket, 15000),
        waitForConnect(driverOneSocket, 15000),
        waitForConnect(driverTwoSocket, 15000),
      ]);

      for (const socket of [driverOneSocket, driverTwoSocket]) {
        socket.emit("driver:online", {
          isOnline: true,
          lat: runtime.ridePickupLat,
          lng: runtime.ridePickupLng,
        });
        await waitForSocketEvent(socket, "driver:online_ack", 15000);
      }

      const tag = `[RACE-${Date.now()}]`;
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
      customerSocket.emit("customer:track_trip", { tripId });

      const incomingOne = await waitForSocketEventAny(driverOneSocket, ["incoming-trip", "trip:new_request"], 20000);
      let incomingTwo: any = null;
      try {
        incomingTwo = await waitForSocketEventAny(driverTwoSocket, ["incoming-trip", "trip:new_request"], 3000);
      } catch {
        incomingTwo = null;
      }

      const rejectedBy: string[] = [];
      driverOneSocket.once("driver:accept_trip_error", () => rejectedBy.push(driverOne.user.id));
      driverTwoSocket.once("driver:accept_trip_error", () => rejectedBy.push(driverTwo.user.id));

      driverOneSocket.emit("driver:accept_trip", { tripId });
      driverTwoSocket.emit("driver:accept_trip", { tripId });

      const assignment = await waitForSocketEventAny(customerSocket, ["trip:driver_assigned", "trip:accepted"], 25000);
      await sleep(1500);
      const customerActiveAfter = await live.getCustomerActiveTrip(customer);

      console.log("tripId=", tripId);
      console.log("incomingOne=", JSON.stringify(incomingOne));
      console.log("incomingTwo=", JSON.stringify(incomingTwo));
      console.log("assignment=", JSON.stringify(assignment));
      console.log("rejectedBy=", JSON.stringify(rejectedBy));
      console.log("customerActiveAfter=", JSON.stringify(customerActiveAfter));
    } finally {
      customerSocket.close();
      driverOneSocket.close();
      driverTwoSocket.close();
    }
  } finally {
    await live.dispose().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
