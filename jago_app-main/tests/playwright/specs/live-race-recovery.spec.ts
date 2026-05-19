import { expect, test } from "@playwright/test";
import type { Socket } from "socket.io-client";
import { LiveClient, type MobileSession } from "../support/live-client";
import { createManagedRideBooking, pickCustomerForRideBooking } from "../support/live-booking-manager";
import { createQaTag, runtime } from "../support/runtime";
import {
  connectLiveSocket,
  extractTripId,
  qaAddress,
  waitForConnect,
  waitForSocketEventAny,
  waitForSocketEvent,
} from "../support/live-utils";
import { markLiveBookingReleased, recordLiveArtifact, recordLiveNote, requireLiveSuiteState } from "../support/live-suite-state";

test.describe("Live Race And Recovery", () => {
  test.describe.configure({ mode: "serial" });

  test("@live validates driver accept race handling and prevents duplicate production claims", async () => {
    const client = await LiveClient.create();
    let customerSocket: Socket | null = null;
    let driverOneSocket: Socket | null = null;
    let driverTwoSocket: Socket | null = null;

    try {
      const sharedState = await requireLiveSuiteState();
      const customer = (await pickCustomerForRideBooking(client, "race-recovery")).session;
      const [driverOne, driverTwo] = await pickAvailableDrivers(client, [
        sharedState.actors.driverBikeSecondary.session,
        sharedState.actors.driverBikeTertiary.session,
        sharedState.actors.driverBikeQuaternary.session,
      ]);

      await client.bestEffortCancelActiveTrip(customer, createQaTag("race pre-cleanup"));

      customerSocket = await connectAuthenticatedSocket(client, customer, "customer");
      driverOneSocket = await connectAuthenticatedSocket(client, driverOne, "driver");
      driverTwoSocket = await connectAuthenticatedSocket(client, driverTwo, "driver");

      for (const socket of [driverOneSocket, driverTwoSocket]) {
        socket.emit("driver:online", {
          isOnline: true,
          lat: runtime.ridePickupLat,
          lng: runtime.ridePickupLng,
        });
        await waitForSocketEvent(socket, "driver:online_ack");
      }

      const bikeCategory = sharedState.categories.bike;
      const managed = await createManagedRideBooking(client, "race-recovery", () => ({
        pickupAddress: qaAddress("race pickup"),
        pickupLat: runtime.ridePickupLat,
        pickupLng: runtime.ridePickupLng,
        destinationAddress: qaAddress("race destination"),
        destinationLat: runtime.rideDestinationLat,
        destinationLng: runtime.rideDestinationLng,
        vehicleCategoryId: bikeCategory.id,
        vehicleType: bikeCategory.vehicleType || bikeCategory.serviceType || bikeCategory.name.toLowerCase(),
        estimatedFare: 179,
        estimatedDistance: 6.9,
        paymentMethod: "cash",
      }));
      const rideCustomer = managed.customer;
      const tripId = managed.tripId || extractTripId(managed.booking) || extractTripId(await client.getCustomerActiveTrip(rideCustomer));
      expect(tripId).toBeTruthy();
      await recordLiveArtifact("tripIds", String(tripId));
      customerSocket.emit("customer:track_trip", { tripId });

      const rejectedBy: string[] = [];

      driverOneSocket.once("driver:accept_trip_error", () => rejectedBy.push(driverOne.user.id));
      driverTwoSocket.once("driver:accept_trip_error", () => rejectedBy.push(driverTwo.user.id));

      driverOneSocket.emit("driver:accept_trip", { tripId });
      driverTwoSocket.emit("driver:accept_trip", { tripId });

      const assignment = await waitForSocketEventAny<any>(customerSocket, ["trip:driver_assigned", "trip:accepted"], 25_000);
      const claimedDriverId = assignment.payload?.driver?.id || assignment.payload?.driverId || null;
      expect(claimedDriverId).toBeTruthy();

      if (rejectedBy.length === 0) {
        await recordLiveNote(`Race validation saw backend single-claim resolution without socket error ack for trip ${tripId}.`);
      }

      const activeTrip = await client.getCustomerActiveTrip(rideCustomer);
      const claimedTrip = activeTrip?.trip || activeTrip?.activeTrip || activeTrip?.data || {};
      expect([driverOne.user.id, driverTwo.user.id]).toContain(claimedTrip?.driverId);
      expect(claimedTrip?.driverId).toBe(claimedDriverId);
      const cancel = await client.cancelCustomerTrip(rideCustomer, String(tripId), createQaTag("race cleanup cancel"));
      expect(cancel?.success).toBeTruthy();
      await markLiveBookingReleased(String(tripId));
    } finally {
      customerSocket?.close();
      driverOneSocket?.close();
      driverTwoSocket?.close();
      await client.dispose();
    }
  });
});

async function pickAvailableDrivers(client: LiveClient, sessions: Array<any>) {
  const available: Array<any> = [];
  for (const session of sessions) {
    const active = await client.getDriverActiveTrip(session);
    const trip = active?.trip || active?.activeTrip || active?.data || null;
    if (!trip?.id) {
      available.push(session);
    }
    if (available.length === 2) {
      return available as [any, any];
    }
  }
  throw new Error("Could not find two available QA drivers for race validation.");
}

async function connectAuthenticatedSocket(
  client: LiveClient,
  session: MobileSession,
  userType: "customer" | "driver",
) {
  let socket = connectLiveSocket(session.token, session.user.id, userType);
  try {
    await waitForConnect(socket, 10_000);
    return socket;
  } catch {
    socket.close();
    await client.refreshMobileSession(session);
    socket = connectLiveSocket(session.token, session.user.id, userType);
    await waitForConnect(socket, 20_000);
    return socket;
  }
}
