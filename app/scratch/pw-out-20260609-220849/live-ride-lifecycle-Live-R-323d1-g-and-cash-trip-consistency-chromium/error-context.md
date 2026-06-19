# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: live-ride-lifecycle.spec.ts >> Live Ride Lifecycle >> @live validates real auth, sockets, GPS, chat, reconnect recovery, SOS, calling, and cash-trip consistency
- Location: ..\..\..\jago-Updates-23-04-jago\jago-Updates-23-04-jago\jago_app-main\app\tests\playwright\specs\live-ride-lifecycle.spec.ts:22:3

# Error details

```
Error: expect(received).toBeTruthy()

Received: false
```

# Test source

```ts
  366 |     });
  367 |     expect(response.ok()).toBeTruthy();
  368 |     return response.json();
  369 |   }
  370 | 
  371 |   async getVehicleCategories() {
  372 |     let response = await this.api.get("/api/app/vehicle-categories");
  373 |     if (!response.ok()) {
  374 |       response = await this.api.get("/api/vehicle-categories");
  375 |     }
  376 |     expect(response.ok()).toBeTruthy();
  377 |     const body = await response.json();
  378 |     const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  379 |     return list as VehicleCategory[];
  380 |   }
  381 | 
  382 |   async getCategoryByLabel(label: "bike" | "auto" | "cab" | "pool") {
  383 |     const categories = await this.getVehicleCategories();
  384 |     const normalized = label.toLowerCase();
  385 |     const category = categories.find((item) => {
  386 |       const haystack = `${item.name} ${item.type || ""} ${item.vehicleType || ""} ${item.serviceType || ""}`.toLowerCase();
  387 |       if (normalized === "bike") return haystack.includes("bike") && !haystack.includes("parcel");
  388 |       if (normalized === "auto") return haystack.includes("auto");
  389 |       if (normalized === "cab") return haystack.includes("cab") || haystack.includes("sedan") || haystack.includes("car");
  390 |       if (normalized === "pool") return item.isCarpool === true || haystack.includes("pool") || haystack.includes("carpool");
  391 |       return false;
  392 |     });
  393 |     expect(category, `Missing vehicle category for ${label}`).toBeTruthy();
  394 |     return category as VehicleCategory;
  395 |   }
  396 | 
  397 |   async tryGetCategoryByLabel(label: "bike" | "auto" | "cab" | "pool") {
  398 |     const categories = await this.getVehicleCategories();
  399 |     const normalized = label.toLowerCase();
  400 |     return categories.find((item) => {
  401 |       const haystack = `${item.name} ${item.type || ""} ${item.vehicleType || ""} ${item.serviceType || ""}`.toLowerCase();
  402 |       if (normalized === "bike") return haystack.includes("bike") && !haystack.includes("parcel");
  403 |       if (normalized === "auto") return haystack.includes("auto");
  404 |       if (normalized === "cab") return haystack.includes("cab") || haystack.includes("sedan") || haystack.includes("car");
  405 |       if (normalized === "pool") return item.isCarpool === true || haystack.includes("pool") || haystack.includes("carpool");
  406 |       return false;
  407 |     }) || null;
  408 |   }
  409 | 
  410 |   async getNearbyDrivers(vehicleCategoryId: string) {
  411 |     const response = await this.api.get("/api/app/nearby-drivers", {
  412 |       params: {
  413 |         lat: runtime.ridePickupLat,
  414 |         lng: runtime.ridePickupLng,
  415 |         radius: 5,
  416 |         vehicleCategoryId,
  417 |       },
  418 |     });
  419 |     expect(response.ok()).toBeTruthy();
  420 |     return response.json();
  421 |   }
  422 | 
  423 |   async bookRide(session: MobileSession, payload: Record<string, unknown>) {
  424 |     const response = await this.mobilePost(session, "/api/app/customer/book-ride", payload);
  425 |     if (!response.ok()) {
  426 |       const body = await readResponseBody(response);
  427 |       throw new Error(`bookRide failed with status ${response.status()}: ${JSON.stringify(body)}`);
  428 |     }
  429 |     return response.json();
  430 |   }
  431 | 
  432 |   async getCustomerActiveTrip(session: MobileSession) {
  433 |     const response = await this.mobileGet(session, "/api/app/customer/active-trip");
  434 |     expect(response.ok()).toBeTruthy();
  435 |     return response.json();
  436 |   }
  437 | 
  438 |   async bestEffortCancelActiveTrip(session: MobileSession, reason: string) {
  439 |     try {
  440 |       const body = await this.getCustomerActiveTrip(session);
  441 |       const trip = body?.trip || body?.activeTrip || body?.data || null;
  442 |       const tripId = trip?.id || body?.tripId || null;
  443 |       const status = trip?.currentStatus || trip?.status || body?.status || null;
  444 |       if (!tripId || !status) return;
  445 |       if (["completed", "cancelled", "on_the_way", "payment_pending"].includes(String(status))) return;
  446 |       await this.cancelCustomerTrip(session, tripId, reason);
  447 |     } catch {
  448 |       // Cleanup should never break the suite.
  449 |     }
  450 |   }
  451 | 
  452 |   async getDriverIncomingTrip(session: MobileSession) {
  453 |     const response = await this.mobileGet(session, "/api/app/driver/incoming-trip");
  454 |     expect(response.ok()).toBeTruthy();
  455 |     return response.json();
  456 |   }
  457 | 
  458 |   async getDriverActiveTrip(session: MobileSession) {
  459 |     const response = await this.mobileGet(session, "/api/app/driver/active-trip");
  460 |     expect(response.ok()).toBeTruthy();
  461 |     return response.json();
  462 |   }
  463 | 
  464 |   async acceptTrip(session: MobileSession, tripId: string) {
  465 |     const response = await this.mobilePost(session, "/api/app/driver/accept-trip", { tripId });
> 466 |     expect(response.ok()).toBeTruthy();
      |                           ^ Error: expect(received).toBeTruthy()
  467 |     return response.json();
  468 |   }
  469 | 
  470 |   async markArrived(session: MobileSession, tripId: string) {
  471 |     const response = await this.mobilePost(session, "/api/app/driver/arrived", { tripId });
  472 |     expect(response.ok()).toBeTruthy();
  473 |     return response.json();
  474 |   }
  475 | 
  476 |   async startTrip(session: MobileSession, tripId: string, pickupOtp: string) {
  477 |     const response = await this.mobilePost(session, "/api/app/driver/start-trip", { tripId, pickupOtp });
  478 |     expect(response.ok()).toBeTruthy();
  479 |     return response.json();
  480 |   }
  481 | 
  482 |   async completeTrip(session: MobileSession, tripId: string, actualFare: number) {
  483 |     const response = await this.mobilePost(session, "/api/app/driver/complete-trip", {
  484 |       tripId,
  485 |       actualFare,
  486 |       actualDistance: 8.5,
  487 |       tips: 0,
  488 |     });
  489 |     expect(response.ok()).toBeTruthy();
  490 |     return response.json();
  491 |   }
  492 | 
  493 |   async cancelCustomerTrip(session: MobileSession, tripId: string, reason: string) {
  494 |     const response = await this.mobilePost(session, "/api/app/customer/cancel-trip", { tripId, reason });
  495 |     expect(response.ok()).toBeTruthy();
  496 |     return response.json();
  497 |   }
  498 | 
  499 |   async getCustomerTripReceipt(session: MobileSession, tripId: string) {
  500 |     const response = await this.mobileGet(session, `/api/app/customer/trip-receipt/${tripId}`);
  501 |     expect(response.ok()).toBeTruthy();
  502 |     return response.json();
  503 |   }
  504 | 
  505 |   async getDriverTripReceipt(session: MobileSession, tripId: string) {
  506 |     const response = await this.mobileGet(session, `/api/app/driver/trip-receipt/${tripId}`);
  507 |     expect(response.ok()).toBeTruthy();
  508 |     return response.json();
  509 |   }
  510 | 
  511 |   async getCustomerWallet(session: MobileSession) {
  512 |     const response = await this.mobileGet(session, "/api/app/customer/wallet");
  513 |     expect(response.ok()).toBeTruthy();
  514 |     return response.json();
  515 |   }
  516 | 
  517 |   async createWalletOrder(session: MobileSession, amount: number) {
  518 |     const response = await this.mobilePost(session, "/api/app/customer/wallet/create-order", { amount });
  519 |     expect(response.ok()).toBeTruthy();
  520 |     return response.json();
  521 |   }
  522 | 
  523 |   async createRidePaymentOrder(session: MobileSession, amount: number, tripId: string) {
  524 |     const response = await this.mobilePost(session, "/api/app/customer/ride/create-order", { amount, tripId });
  525 |     expect(response.ok()).toBeTruthy();
  526 |     return response.json();
  527 |   }
  528 | 
  529 |   async verifyRidePaymentInvalid(session: MobileSession, orderId: string) {
  530 |     const response = await this.mobilePost(session, "/api/app/customer/ride/verify-payment", {
  531 |         razorpayOrderId: orderId,
  532 |         razorpayPaymentId: `pay_invalid_${Date.now()}`,
  533 |         razorpaySignature: "invalid_signature",
  534 |     });
  535 |     expect(response.status()).toBe(400);
  536 |     return response.json();
  537 |   }
  538 | 
  539 |   async quoteParcel(session: MobileSession, payload: Record<string, unknown>) {
  540 |     const response = await this.mobilePost(session, "/api/app/parcel/quote", payload);
  541 |     expect(response.ok()).toBeTruthy();
  542 |     return response.json();
  543 |   }
  544 | 
  545 |   async bookParcel(session: MobileSession, payload: Record<string, unknown>) {
  546 |     const response = await this.mobilePost(session, "/api/app/parcel/book", payload);
  547 |     if (!response.ok()) {
  548 |       const body = await readResponseBody(response);
  549 |       throw new Error(`bookParcel failed with status ${response.status()}: ${JSON.stringify(body)}`);
  550 |     }
  551 |     return response.json();
  552 |   }
  553 | 
  554 |   async cancelParcel(session: MobileSession, orderId: string, reason: string) {
  555 |     const response = await this.mobilePost(session, `/api/app/parcel/${orderId}/cancel`, { reason });
  556 |     expect(response.ok()).toBeTruthy();
  557 |     return response.json();
  558 |   }
  559 | 
  560 |   async createOutstationRide(session: MobileSession, payload: Record<string, unknown>) {
  561 |     const response = await this.mobilePost(session, "/api/app/driver/outstation-pool/rides", payload);
  562 |     expect(response.ok()).toBeTruthy();
  563 |     return response.json();
  564 |   }
  565 | 
  566 |   async searchOutstationRides(session: MobileSession, fromCity: string, toCity: string, date?: string) {
```