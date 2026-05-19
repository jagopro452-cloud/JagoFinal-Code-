import { expect, test } from "@playwright/test";
import type { Socket } from "socket.io-client";
import { LiveClient, type MobileSession } from "../support/live-client";
import { createManagedRideBooking, getManagedCustomers } from "../support/live-booking-manager";
import { createQaTag, runtime } from "../support/runtime";
import {
  connectLiveSocket,
  expectSocketNoEvent,
  extractActiveTrip,
  extractTripId,
  qaAddress,
  qaNote,
  waitForConnect,
  waitForSocketEventAny,
  waitForSocketEvent,
} from "../support/live-utils";
import { markLiveBookingReleased, recordLiveArtifact, requireLiveSuiteState } from "../support/live-suite-state";

test.describe("Live Ride Lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  test("@live validates real auth, sockets, GPS, chat, reconnect recovery, SOS, calling, and cash-trip consistency", async () => {
    const client = await LiveClient.create();
    let customerSocket: Socket | null = null;
    let driverSocket: Socket | null = null;

    try {
      const sharedState = await requireLiveSuiteState();
      const managedCustomers = await getManagedCustomers(client);
      const driver = await pickAvailableDriver(client, [
        sharedState.actors.driverBikePrimary.session,
        sharedState.actors.driverBikeSecondary.session,
        sharedState.actors.driverBikeTertiary.session,
        sharedState.actors.driverBikeQuaternary.session,
      ]);

      for (const managedCustomer of managedCustomers) {
        await client.bestEffortCancelActiveTrip(managedCustomer.session, createQaTag("ride lifecycle pre-cleanup"));
      }

      const walletSnapshots = new Map<string, any>();
      for (const managedCustomer of managedCustomers) {
        walletSnapshots.set(
          managedCustomer.session.user.phone,
          await client.getCustomerWallet(managedCustomer.session),
        );
      }

      driverSocket = await connectAuthenticatedSocket(client, driver, "driver");

      driverSocket.emit("driver:online", {
        isOnline: true,
        lat: runtime.ridePickupLat,
        lng: runtime.ridePickupLng,
      });
      await waitForSocketEvent(driverSocket, "driver:online_ack");

      const bikeCategory = sharedState.categories.bike;
      const nearby = await client.getNearbyDrivers(bikeCategory.id);
      const nearbyIds = (nearby?.drivers || []).map((item: any) => item.id);
      expect(nearbyIds).toContain(driver.user.id);

      const managedRide = await createManagedRideBooking(client, "ride-lifecycle", () => ({
        pickupAddress: qaAddress("ride lifecycle pickup"),
        pickupLat: runtime.ridePickupLat,
        pickupLng: runtime.ridePickupLng,
        pickupShortName: qaNote("pickup short"),
        destinationAddress: qaAddress("ride lifecycle destination"),
        destinationLat: runtime.rideDestinationLat,
        destinationLng: runtime.rideDestinationLng,
        destinationShortName: qaNote("destination short"),
        vehicleCategoryId: bikeCategory.id,
        vehicleType: bikeCategory.vehicleType || bikeCategory.serviceType || bikeCategory.name.toLowerCase(),
        estimatedFare: 199,
        estimatedDistance: 8.5,
        paymentMethod: "cash",
        tripType: "normal",
        isForSomeoneElse: true,
        passengerName: qaNote("ride passenger"),
        passengerPhone: "9000000998",
      }));
      const customer = managedRide.customer;
      const customerWalletBefore = walletSnapshots.get(customer.user.phone) || await client.getCustomerWallet(customer);

      customerSocket = await connectAuthenticatedSocket(client, customer, "customer");

      const tripId = managedRide.tripId || extractTripId(managedRide.booking) || extractTripId(await client.getCustomerActiveTrip(customer));
      expect(tripId).toBeTruthy();
      await recordLiveArtifact("tripIds", String(tripId));
      customerSocket.emit("customer:track_trip", { tripId });

      const assignEventPromise = waitForSocketEventAny<any>(customerSocket, ["trip:driver_assigned", "trip:accepted"]);
      await client.acceptTrip(driver, String(tripId));
      const assignEvent = await assignEventPromise;
      expect(assignEvent.payload?.tripId).toBe(String(tripId));

      const activeTrip = extractActiveTrip(await client.getCustomerActiveTrip(customer));
      const pickupOtp = String(activeTrip?.pickupOtp || activeTrip?.pickup_otp || assignEvent.payload?.pickupOtp || "");
      expect(pickupOtp).toHaveLength(4);

      const callIncoming = waitForSocketEvent<any>(driverSocket, "call:incoming", 20_000);
      customerSocket.emit("call:initiate", {
        targetUserId: driver.user.id,
        tripId,
        callerName: customer.user.fullName,
      });
      const incomingCall = await callIncoming;
      expect(incomingCall?.tripId).toBe(String(tripId));

      await client.markArrived(driver, String(tripId));
      const arrived = await waitForSocketEvent<any>(customerSocket, "trip:status_update");
      expect(arrived?.status).toBe("arrived");

      await client.startTrip(driver, String(tripId), pickupOtp);

      driverSocket.emit("driver:location", {
        lat: runtime.ridePickupLat + 0.001,
        lng: runtime.ridePickupLng + 0.001,
        heading: 96,
        speed: 18,
        etaSeconds: 240,
        remainingDistanceMeters: 4200,
      });
      const firstLocation = await waitForSocketEvent<any>(customerSocket, "driver:location_update");
      expect(firstLocation?.tripId).toBe(String(tripId));

      customerSocket.emit("trip:send_message", {
        tripId,
        message: qaNote("socket chat message"),
        senderName: customer.user.fullName,
        senderType: "customer",
      });
      const chatEvent = await waitForSocketEvent<any>(driverSocket, "trip:new_message");
      expect(chatEvent?.message).toContain(runtime.qaRunId);

      const aiSosEvent = waitForSocketEvent<any>(driverSocket, "safety:sos", 20_000);
      await client.triggerAiSos(customer, {
        tripId,
        lat: runtime.ridePickupLat + 0.0012,
        lng: runtime.ridePickupLng + 0.0012,
        message: qaNote("AI SOS validation"),
      });
      const sos = await aiSosEvent;
      expect(sos?.tripId).toBe(String(tripId));

      await client.triggerSos(customer, {
        tripId,
        lat: runtime.ridePickupLat + 0.0013,
        lng: runtime.ridePickupLng + 0.0013,
        message: qaNote("Standard SOS validation"),
      });

      customerSocket.close();
      customerSocket = await connectAuthenticatedSocket(client, customer, "customer");
      customerSocket.emit("customer:track_trip", { tripId });
      await expectSocketNoEvent(customerSocket, "auth:error", 2_000);

      driverSocket.emit("driver:location", {
        lat: runtime.ridePickupLat + 0.002,
        lng: runtime.ridePickupLng + 0.002,
        heading: 110,
        speed: 24,
        etaSeconds: 120,
        remainingDistanceMeters: 1200,
      });
      const reconnectLocation = await waitForSocketEvent<any>(customerSocket, "driver:location_update");
      expect(reconnectLocation?.tripId).toBe(String(tripId));

      await client.completeTrip(driver, String(tripId), 199);
      await markLiveBookingReleased(String(tripId));
      const customerReceipt = await client.getCustomerTripReceipt(customer, String(tripId));
      const driverReceipt = await client.getDriverTripReceipt(driver, String(tripId));
      expect(customerReceipt?.receipt?.tripId || customerReceipt?.receipt?.orderId || customerReceipt?.tripId).toBeTruthy();
      expect(driverReceipt?.receipt?.tripId || driverReceipt?.receipt?.orderId || driverReceipt?.tripId).toBeTruthy();

      const customerWalletAfter = await client.getCustomerWallet(customer);
      expect(customerWalletAfter?.balance).toBe(customerWalletBefore?.balance);

      const supportSend = await client.sendCustomerSupportChat(customer, qaNote("support chat validation"));
      expect(supportSend?.success).toBeTruthy();
      const supportHistory = await client.getCustomerSupportChat(customer);
      const messages = supportHistory?.messages || [];
      expect(messages.some((item: any) => String(item.message || "").includes(runtime.qaRunId))).toBeTruthy();
    } finally {
      try {
        driverSocket?.emit("driver:online", { isOnline: false });
      } catch {
        // Best effort.
      }
      customerSocket?.close();
      driverSocket?.close();
      await client.dispose();
    }
  });
});

async function pickAvailableDriver(client: LiveClient, sessions: MobileSession[]) {
  for (const session of sessions) {
    const active = await client.getDriverActiveTrip(session);
    const activeTrip = active?.trip || active?.activeTrip || active?.data || null;
    if (!activeTrip?.id) {
      return session;
    }
  }
  throw new Error("No available QA driver found for live ride lifecycle.");
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
