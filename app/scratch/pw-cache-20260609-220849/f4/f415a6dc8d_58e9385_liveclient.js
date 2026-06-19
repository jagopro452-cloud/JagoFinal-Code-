import { expect, request } from "@playwright/test";
import { runtime } from "./runtime";
import { readLiveSuiteState, updateLiveActorSession } from "./live-suite-state";
function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
}
async function readResponseBody(response) {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }
}
export class LiveClient {
  constructor(api) {
    this.api = api;
    this.cachedAdminSession = null;
    this.mobileSessionCache = new Map();
  }
  static async create() {
    const api = await request.newContext({
      baseURL: runtime.apiBaseURL,
      extraHTTPHeaders: {
        "content-type": "application/json",
        "x-jago-playwright-suite": "true"
      },
      ignoreHTTPSErrors: true
    });
    return new LiveClient(api);
  }
  async dispose() {
    await this.api.dispose();
  }
  async get(path, headers) {
    return this.api.get(path, {
      headers
    });
  }
  async post(path, data, headers) {
    return this.api.post(path, {
      data,
      headers
    });
  }
  async patch(path, data, headers) {
    return this.api.patch(path, {
      data,
      headers
    });
  }
  async seedTestAccounts() {
    const seedKey = runtime.adminResetKey || runtime.opsApiKey;
    if (seedKey) {
      const response = await this.requestWithBackoff(() => this.api.get("/api/ops/seed-test-accounts", {
        params: {
          key: seedKey
        },
        headers: {
          "x-ops-key": seedKey
        }
      }), {
        retries: 2,
        backoffMs: 2000,
        retryStatuses: [429]
      });
      if (response.ok()) {
        var _payload$adminSession;
        const payload = await response.json();
        if ((_payload$adminSession = payload.adminSession) !== null && _payload$adminSession !== void 0 && _payload$adminSession.token) {
          this.cachedAdminSession = payload.adminSession;
        }
        for (const entry of ((_payload$sessions = payload.sessions) === null || _payload$sessions === void 0 ? void 0 : _payload$sessions.customers) || []) {
          var _payload$sessions, _entry$session;
          if (entry !== null && entry !== void 0 && (_entry$session = entry.session) !== null && _entry$session !== void 0 && _entry$session.token && entry !== null && entry !== void 0 && entry.phone) {
            this.mobileSessionCache.set(this.getMobileCacheKey(entry.phone, "customer"), entry.session);
          }
        }
        for (const entry of ((_payload$sessions2 = payload.sessions) === null || _payload$sessions2 === void 0 ? void 0 : _payload$sessions2.drivers) || []) {
          var _payload$sessions2, _entry$session2;
          if (entry !== null && entry !== void 0 && (_entry$session2 = entry.session) !== null && _entry$session2 !== void 0 && _entry$session2.token && entry !== null && entry !== void 0 && entry.phone) {
            this.mobileSessionCache.set(this.getMobileCacheKey(entry.phone, "driver"), entry.session);
          }
        }
        return {
          ...payload,
          bootstrapMode: "seed"
        };
      }
      if (response.status() !== 403) {
        expect(response.ok()).toBeTruthy();
      }
    }
    return this.bootstrapQaAccounts();
  }
  async initializeSharedState() {
    var _bootstrap$adminSessi, _bootstrap$bootstrapM;
    const bootstrap = await this.seedTestAccounts();
    const [admin, bike, auto, cab, pool] = await Promise.all([(_bootstrap$adminSessi = bootstrap.adminSession) !== null && _bootstrap$adminSessi !== void 0 && _bootstrap$adminSessi.token ? Promise.resolve(bootstrap.adminSession) : this.loginAdmin(), this.getCategoryByLabel("bike"), this.getCategoryByLabel("auto"), this.getCategoryByLabel("cab"), this.tryGetCategoryByLabel("pool")]);
    const [customerPrimary, customerSecondary, driverBikePrimary, driverBikeSecondary, driverBikeTertiary, driverBikeQuaternary, driverAutoPrimary, driverCabPrimary] = await Promise.all([this.loginMobile(runtime.liveCustomerPhone, "customer"), this.loginMobile(runtime.liveCustomerPhone2, "customer"), this.loginMobile(runtime.liveDriverBikePhone, "driver"), this.loginMobile("9100000002", "driver"), this.loginMobile("9100000003", "driver"), this.loginMobile("9100000004", "driver"), this.loginMobile(runtime.liveDriverAutoPhone, "driver"), this.loginMobile(runtime.liveDriverCabPhone, "driver")]);
    return {
      version: 1,
      envName: runtime.envName,
      qaRunId: runtime.qaRunId,
      createdAt: new Date().toISOString(),
      bootstrapMode: (_bootstrap$bootstrapM = bootstrap.bootstrapMode) !== null && _bootstrap$bootstrapM !== void 0 ? _bootstrap$bootstrapM : "fallback",
      admin: {
        session: admin
      },
      categories: {
        bike,
        auto,
        cab,
        pool
      },
      actors: {
        customerPrimary: {
          label: "customer-primary",
          phone: runtime.liveCustomerPhone,
          session: customerPrimary
        },
        customerSecondary: {
          label: "customer-secondary",
          phone: runtime.liveCustomerPhone2,
          session: customerSecondary
        },
        driverBikePrimary: {
          label: "driver-bike-primary",
          phone: runtime.liveDriverBikePhone,
          session: driverBikePrimary
        },
        driverBikeSecondary: {
          label: "driver-bike-secondary",
          phone: "9100000002",
          session: driverBikeSecondary
        },
        driverBikeTertiary: {
          label: "driver-bike-tertiary",
          phone: "9100000003",
          session: driverBikeTertiary
        },
        driverBikeQuaternary: {
          label: "driver-bike-quaternary",
          phone: "9100000004",
          session: driverBikeQuaternary
        },
        driverAutoPrimary: {
          label: "driver-auto-primary",
          phone: runtime.liveDriverAutoPhone,
          session: driverAutoPrimary
        },
        driverCabPrimary: {
          label: "driver-cab-primary",
          phone: runtime.liveDriverCabPhone,
          session: driverCabPrimary
        }
      },
      artifacts: {
        tripIds: [],
        parcelOrderIds: [],
        outstationRideIds: [],
        notes: []
      }
    };
  }
  async getOpsReady() {
    expect(runtime.opsApiKey || runtime.adminResetKey).toBeTruthy();
    const response = await this.api.get("/api/ops/ready", {
      headers: {
        "x-ops-key": runtime.opsApiKey || runtime.adminResetKey
      }
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async loginAdmin(forceRefresh = false) {
    var _this$cachedAdminSess;
    if (!forceRefresh && (_this$cachedAdminSess = this.cachedAdminSession) !== null && _this$cachedAdminSess !== void 0 && _this$cachedAdminSess.token) {
      return this.cachedAdminSession;
    }
    if (!runtime.adminPassword) {
      try {
        var _state$admin$session;
        const state = await readLiveSuiteState();
        if ((_state$admin$session = state.admin.session) !== null && _state$admin$session !== void 0 && _state$admin$session.token) {
          this.cachedAdminSession = state.admin.session;
          return this.cachedAdminSession;
        }
      } catch {
        // Fall through to a direct login attempt.
      }
    }
    const response = await this.requestWithBackoff(() => this.api.post("/api/admin/login", {
      data: {
        email: runtime.adminEmail,
        password: runtime.adminPassword
      }
    }), {
      retries: 2,
      backoffMs: 5000,
      retryStatuses: [429]
    });
    const body = await response.json();
    if (response.status() === 202 && body !== null && body !== void 0 && body.requiresTwoFactor) {
      throw new Error("Admin login requires live OTP verification. Playwright cannot continue admin-authenticated checks without OTP access.");
    }
    expect(response.ok()).toBeTruthy();
    expect(body === null || body === void 0 ? void 0 : body.token).toBeTruthy();
    this.cachedAdminSession = body;
    return this.cachedAdminSession;
  }
  async adminGet(path) {
    let admin = await this.loginAdmin();
    let response = await this.api.get(path, {
      headers: authHeaders(admin.token)
    });
    if (response.status() === 401) {
      admin = await this.loginAdmin(true);
      response = await this.api.get(path, {
        headers: authHeaders(admin.token)
      });
    }
    return response;
  }
  async getRazorpayDiag(token) {
    const response = token ? await this.api.get("/api/diag/razorpay", {
      headers: authHeaders(token)
    }) : await this.adminGet("/api/diag/razorpay");
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async loginMobile(phone, userType, forceRefresh = false) {
    const cacheKey = this.getMobileCacheKey(phone, userType);
    const cached = this.mobileSessionCache.get(cacheKey);
    if (!forceRefresh && cached !== null && cached !== void 0 && cached.token) {
      return cached;
    }
    const response = await this.requestWithBackoff(() => this.api.post("/api/app/login-password", {
      data: {
        phone,
        password: runtime.liveMobilePassword,
        userType
      }
    }), {
      retries: 2,
      backoffMs: 4000,
      retryStatuses: [429]
    });
    expect(response.ok()).toBeTruthy();
    const session = await response.json();
    this.mobileSessionCache.set(cacheKey, session);
    return session;
  }
  async refreshMobileSession(session) {
    var _await$this$refreshMo;
    const refreshed = (_await$this$refreshMo = await this.refreshMobileAccessToken(session)) !== null && _await$this$refreshMo !== void 0 ? _await$this$refreshMo : await this.loginMobile(session.user.phone, session.user.userType, true);
    session.token = refreshed.token;
    session.refreshToken = refreshed.refreshToken;
    session.expiresAt = refreshed.expiresAt;
    session.user = refreshed.user;
    this.mobileSessionCache.set(this.getMobileCacheKey(session.user.phone, session.user.userType), session);
    await updateLiveActorSession(session.user.phone, session.user.userType, session);
    return session;
  }
  async registerMobile(params) {
    const response = await this.requestWithBackoff(() => this.api.post("/api/app/register", {
      data: params
    }), {
      retries: 2,
      backoffMs: 4000,
      retryStatuses: [429]
    });
    expect([200, 201, 409]).toContain(response.status());
    if (response.status() === 409) {
      return this.loginMobile(params.phone, params.userType);
    }
    const session = await response.json();
    this.mobileSessionCache.set(this.getMobileCacheKey(params.phone, params.userType), session);
    return session;
  }
  async updateDriverProfile(session, payload) {
    const response = await this.mobilePatch(session, "/api/app/driver/profile", payload);
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async approveDriver(adminToken, driverId, note) {
    const response = await this.api.patch(`/api/admin/drivers/${driverId}/verify-driver`, {
      data: {
        status: "approved",
        vehicleStatus: "approved",
        note
      },
      headers: authHeaders(adminToken)
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async getVehicleCategories() {
    let response = await this.api.get("/api/app/vehicle-categories");
    if (!response.ok()) {
      response = await this.api.get("/api/vehicle-categories");
    }
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    const list = Array.isArray(body) ? body : Array.isArray(body === null || body === void 0 ? void 0 : body.data) ? body.data : [];
    return list;
  }
  async getCategoryByLabel(label) {
    const categories = await this.getVehicleCategories();
    const normalized = label.toLowerCase();
    const category = categories.find(item => {
      const haystack = `${item.name} ${item.type || ""} ${item.vehicleType || ""} ${item.serviceType || ""}`.toLowerCase();
      if (normalized === "bike") return haystack.includes("bike") && !haystack.includes("parcel");
      if (normalized === "auto") return haystack.includes("auto");
      if (normalized === "cab") return haystack.includes("cab") || haystack.includes("sedan") || haystack.includes("car");
      if (normalized === "pool") return item.isCarpool === true || haystack.includes("pool") || haystack.includes("carpool");
      return false;
    });
    expect(category, `Missing vehicle category for ${label}`).toBeTruthy();
    return category;
  }
  async tryGetCategoryByLabel(label) {
    const categories = await this.getVehicleCategories();
    const normalized = label.toLowerCase();
    return categories.find(item => {
      const haystack = `${item.name} ${item.type || ""} ${item.vehicleType || ""} ${item.serviceType || ""}`.toLowerCase();
      if (normalized === "bike") return haystack.includes("bike") && !haystack.includes("parcel");
      if (normalized === "auto") return haystack.includes("auto");
      if (normalized === "cab") return haystack.includes("cab") || haystack.includes("sedan") || haystack.includes("car");
      if (normalized === "pool") return item.isCarpool === true || haystack.includes("pool") || haystack.includes("carpool");
      return false;
    }) || null;
  }
  async getNearbyDrivers(vehicleCategoryId) {
    const response = await this.api.get("/api/app/nearby-drivers", {
      params: {
        lat: runtime.ridePickupLat,
        lng: runtime.ridePickupLng,
        radius: 5,
        vehicleCategoryId
      }
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async bookRide(session, payload) {
    const response = await this.mobilePost(session, "/api/app/customer/book-ride", payload);
    if (!response.ok()) {
      const body = await readResponseBody(response);
      throw new Error(`bookRide failed with status ${response.status()}: ${JSON.stringify(body)}`);
    }
    return response.json();
  }
  async getCustomerActiveTrip(session) {
    const response = await this.mobileGet(session, "/api/app/customer/active-trip");
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async bestEffortCancelActiveTrip(session, reason) {
    try {
      const body = await this.getCustomerActiveTrip(session);
      const trip = (body === null || body === void 0 ? void 0 : body.trip) || (body === null || body === void 0 ? void 0 : body.activeTrip) || (body === null || body === void 0 ? void 0 : body.data) || null;
      const tripId = (trip === null || trip === void 0 ? void 0 : trip.id) || (body === null || body === void 0 ? void 0 : body.tripId) || null;
      const status = (trip === null || trip === void 0 ? void 0 : trip.currentStatus) || (trip === null || trip === void 0 ? void 0 : trip.status) || (body === null || body === void 0 ? void 0 : body.status) || null;
      if (!tripId || !status) return;
      if (["completed", "cancelled", "on_the_way", "payment_pending"].includes(String(status))) return;
      await this.cancelCustomerTrip(session, tripId, reason);
    } catch {
      // Cleanup should never break the suite.
    }
  }
  async getDriverIncomingTrip(session) {
    const response = await this.mobileGet(session, "/api/app/driver/incoming-trip");
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async getDriverActiveTrip(session) {
    const response = await this.mobileGet(session, "/api/app/driver/active-trip");
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async acceptTrip(session, tripId) {
    const response = await this.mobilePost(session, "/api/app/driver/accept-trip", {
      tripId
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async markArrived(session, tripId) {
    const response = await this.mobilePost(session, "/api/app/driver/arrived", {
      tripId
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async startTrip(session, tripId, pickupOtp) {
    const response = await this.mobilePost(session, "/api/app/driver/start-trip", {
      tripId,
      pickupOtp
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async completeTrip(session, tripId, actualFare) {
    const response = await this.mobilePost(session, "/api/app/driver/complete-trip", {
      tripId,
      actualFare,
      actualDistance: 8.5,
      tips: 0
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async cancelCustomerTrip(session, tripId, reason) {
    const response = await this.mobilePost(session, "/api/app/customer/cancel-trip", {
      tripId,
      reason
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async getCustomerTripReceipt(session, tripId) {
    const response = await this.mobileGet(session, `/api/app/customer/trip-receipt/${tripId}`);
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async getDriverTripReceipt(session, tripId) {
    const response = await this.mobileGet(session, `/api/app/driver/trip-receipt/${tripId}`);
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async getCustomerWallet(session) {
    const response = await this.mobileGet(session, "/api/app/customer/wallet");
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async createWalletOrder(session, amount) {
    const response = await this.mobilePost(session, "/api/app/customer/wallet/create-order", {
      amount
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async createRidePaymentOrder(session, amount, tripId) {
    const response = await this.mobilePost(session, "/api/app/customer/ride/create-order", {
      amount,
      tripId
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async verifyRidePaymentInvalid(session, orderId) {
    const response = await this.mobilePost(session, "/api/app/customer/ride/verify-payment", {
      razorpayOrderId: orderId,
      razorpayPaymentId: `pay_invalid_${Date.now()}`,
      razorpaySignature: "invalid_signature"
    });
    expect(response.status()).toBe(400);
    return response.json();
  }
  async quoteParcel(session, payload) {
    const response = await this.mobilePost(session, "/api/app/parcel/quote", payload);
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async bookParcel(session, payload) {
    const response = await this.mobilePost(session, "/api/app/parcel/book", payload);
    if (!response.ok()) {
      const body = await readResponseBody(response);
      throw new Error(`bookParcel failed with status ${response.status()}: ${JSON.stringify(body)}`);
    }
    return response.json();
  }
  async cancelParcel(session, orderId, reason) {
    const response = await this.mobilePost(session, `/api/app/parcel/${orderId}/cancel`, {
      reason
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async createOutstationRide(session, payload) {
    const response = await this.mobilePost(session, "/api/app/driver/outstation-pool/rides", payload);
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async searchOutstationRides(session, fromCity, toCity, date) {
    const response = await this.mobileGet(session, "/api/app/customer/outstation-pool/search", {
      fromCity,
      toCity,
      date
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async bookOutstationRide(session, payload) {
    const response = await this.mobilePost(session, "/api/app/customer/outstation-pool/book", payload);
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async deactivateOutstationRide(session, rideId, note) {
    const response = await this.mobilePatch(session, `/api/app/driver/outstation-pool/rides/${rideId}`, {
      isActive: false,
      status: "cancelled",
      note
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async getAdminOutstationRides(token) {
    const response = token ? await this.api.get("/api/admin/outstation-pool/rides", {
      headers: authHeaders(token)
    }) : await this.adminGet("/api/admin/outstation-pool/rides");
    if (response.status() === 401) {
      const retry = await this.adminGet("/api/admin/outstation-pool/rides");
      expect(retry.ok()).toBeTruthy();
      return retry.json();
    }
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async triggerSos(session, payload) {
    const response = await this.mobilePost(session, "/api/app/sos", payload);
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async triggerAiSos(session, payload) {
    const response = await this.mobilePost(session, "/api/app/ai/sos", payload);
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async getCustomerSupportChat(session) {
    const response = await this.mobileGet(session, "/api/app/customer/support-chat");
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async sendCustomerSupportChat(session, message) {
    const response = await this.mobilePost(session, "/api/app/customer/support-chat/send", {
      message
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async validateSharedState(state) {
    var _state$actors$custome, _state$actors$driverA;
    const checks = await Promise.all([this.api.get("/api/admin/system-health", {
      headers: authHeaders(state.admin.session.token)
    }), this.api.get("/api/app/customer/active-trip", {
      headers: authHeaders(state.actors.customerPrimary.session.token)
    }), this.api.get("/api/app/customer/active-trip", {
      headers: authHeaders(((_state$actors$custome = state.actors.customerSecondary) === null || _state$actors$custome === void 0 ? void 0 : _state$actors$custome.session.token) || state.actors.customerPrimary.session.token)
    }), this.api.get("/api/app/driver/active-trip", {
      headers: authHeaders(state.actors.driverBikePrimary.session.token)
    }), this.api.get("/api/app/driver/active-trip", {
      headers: authHeaders(((_state$actors$driverA = state.actors.driverAutoPrimary) === null || _state$actors$driverA === void 0 ? void 0 : _state$actors$driverA.session.token) || state.actors.driverBikePrimary.session.token)
    }), this.api.get("/api/app/driver/active-trip", {
      headers: authHeaders(state.actors.driverCabPrimary.session.token)
    })]);
    return checks.every(response => response.ok());
  }
  async mobileGet(session, path, params) {
    return this.requestWithMobileAuth(session, token => this.api.get(path, {
      params,
      headers: authHeaders(token)
    }));
  }
  async mobilePost(session, path, data) {
    return this.requestWithMobileAuth(session, token => this.api.post(path, {
      data,
      headers: authHeaders(token)
    }));
  }
  async mobilePatch(session, path, data) {
    return this.requestWithMobileAuth(session, token => this.api.patch(path, {
      data,
      headers: authHeaders(token)
    }));
  }
  async requestWithMobileAuth(session, factory) {
    let response = await factory(session.token);
    if (response.status() !== 401) {
      return response;
    }
    await this.refreshMobileSession(session);
    return factory(session.token);
  }
  async refreshMobileAccessToken(session) {
    const refreshToken = String(session.refreshToken || "").trim();
    const payload = decodeAccessToken(session.token);
    const deviceId = String((payload === null || payload === void 0 ? void 0 : payload.deviceId) || "").trim();
    if (!refreshToken || !deviceId) {
      return null;
    }
    const response = await this.api.post("/api/app/auth/refresh", {
      data: {
        refreshToken,
        deviceId
      },
      headers: {
        "content-type": "application/json",
        "x-device-id": deviceId
      }
    });
    if (!response.ok()) {
      return null;
    }
    const body = await response.json();
    if (!(body !== null && body !== void 0 && body.token)) {
      return null;
    }
    return {
      ...session,
      token: body.token,
      refreshToken: body.refreshToken || refreshToken
    };
  }
  async bootstrapQaAccounts() {
    const admin = await this.loginAdmin();
    const bikeCategory = await this.getCategoryByLabel("bike");
    const autoCategory = await this.getCategoryByLabel("auto");
    const cabCategory = await this.getCategoryByLabel("cab");
    const ensureCustomer = async (phone, fullName) => {
      const existing = await this.api.post("/api/app/login-password", {
        data: {
          phone,
          password: runtime.liveMobilePassword,
          userType: "customer"
        }
      });
      if (existing.ok()) {
        return existing.json();
      }
      if (existing.status() === 429) {
        throw new Error(`Customer bootstrap rate-limited for ${phone}. Wait for the production login window to reset before retrying.`);
      }
      if (existing.status() !== 404) {
        expect(existing.ok(), `Unexpected customer bootstrap status ${existing.status()} for ${phone}`).toBeTruthy();
      }
      return this.registerMobile({
        phone,
        password: runtime.liveMobilePassword,
        fullName,
        userType: "customer"
      });
    };
    const ensureDriver = async params => {
      const existing = await this.api.post("/api/app/login-password", {
        data: {
          phone: params.phone,
          password: runtime.liveMobilePassword,
          userType: "driver"
        }
      });
      let session;
      if (existing.ok()) {
        session = await existing.json();
      } else {
        if (existing.status() === 429) {
          throw new Error(`Driver bootstrap rate-limited for ${params.phone}. Wait for the production login window to reset before retrying.`);
        }
        if (existing.status() !== 404) {
          expect(existing.ok(), `Unexpected driver bootstrap status ${existing.status()} for ${params.phone}`).toBeTruthy();
        }
        session = await this.registerMobile({
          phone: params.phone,
          password: runtime.liveMobilePassword,
          fullName: params.fullName,
          userType: "driver"
        });
      }
      await this.updateDriverProfile(session, {
        fullName: params.fullName,
        vehicleNumber: params.vehicleNumber,
        vehicleModel: params.vehicleModel,
        vehicleCategoryId: params.vehicleCategoryId
      });
      await this.approveDriver(admin.token, session.user.id, `Playwright QA bootstrap for ${params.phone}`);
      return session;
    };
    const customers = await Promise.all([ensureCustomer(runtime.liveCustomerPhone, "JAGO QA Customer 1"), ensureCustomer(runtime.liveCustomerPhone2, "JAGO QA Customer 2")]);
    const drivers = await Promise.all([ensureDriver({
      phone: runtime.liveDriverBikePhone,
      fullName: "JAGO QA Driver Bike 1",
      vehicleCategoryId: bikeCategory.id,
      vehicleNumber: "TS01QA1001",
      vehicleModel: "Hero Splendor QA"
    }), ensureDriver({
      phone: "9100000002",
      fullName: "JAGO QA Driver Bike 2",
      vehicleCategoryId: bikeCategory.id,
      vehicleNumber: "TS01QA1002",
      vehicleModel: "Honda Shine QA"
    }), ensureDriver({
      phone: "9100000003",
      fullName: "JAGO QA Driver Bike 3",
      vehicleCategoryId: bikeCategory.id,
      vehicleNumber: "TS01QA1003",
      vehicleModel: "Bajaj Pulsar QA"
    }), ensureDriver({
      phone: "9100000004",
      fullName: "JAGO QA Driver Bike 4",
      vehicleCategoryId: bikeCategory.id,
      vehicleNumber: "TS01QA1004",
      vehicleModel: "TVS Apache QA"
    }), ensureDriver({
      phone: runtime.liveDriverAutoPhone,
      fullName: "JAGO QA Driver Auto 1",
      vehicleCategoryId: autoCategory.id,
      vehicleNumber: "TS09QA5001",
      vehicleModel: "Bajaj RE QA"
    }), ensureDriver({
      phone: runtime.liveDriverCabPhone,
      fullName: "JAGO QA Driver Cab 1",
      vehicleCategoryId: cabCategory.id,
      vehicleNumber: "TS07QA8001",
      vehicleModel: "Swift Dzire QA"
    })]);
    return {
      success: true,
      bootstrapMode: "fallback",
      fallback: true,
      admin: admin.admin.email,
      customers: customers.map(customer => customer.user.phone),
      drivers: drivers.map(driver => driver.user.phone)
    };
  }
  getMobileCacheKey(phone, userType) {
    return `${userType}:${phone}`;
  }
  async requestWithBackoff(factory, options) {
    let attempt = 0;
    for (;;) {
      const response = await factory();
      const status = this.readStatus(response);
      if (status === null || !options.retryStatuses.includes(status) || attempt >= options.retries) {
        return response;
      }
      const retryAfterMs = this.readRetryAfterMs(response);
      const delayMs = retryAfterMs !== null && retryAfterMs !== void 0 ? retryAfterMs : options.backoffMs * (attempt + 1);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
  readStatus(response) {
    if (!response || typeof response !== "object") return null;
    const candidate = response;
    if (typeof candidate.status === "function") {
      return Number(candidate.status());
    }
    if (typeof candidate.status === "number") {
      return candidate.status;
    }
    return null;
  }
  readRetryAfterMs(response) {
    if (!response || typeof response !== "object") return null;
    const candidate = response;
    if (typeof candidate.headers !== "function") return null;
    const headers = candidate.headers();
    const retryAfter = headers["retry-after"] || headers["Retry-After"];
    if (!retryAfter) return null;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isNaN(dateMs)) return null;
    return Math.max(1000, dateMs - Date.now());
  }
}
function decodeAccessToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJleHBlY3QiLCJyZXF1ZXN0IiwicnVudGltZSIsInJlYWRMaXZlU3VpdGVTdGF0ZSIsInVwZGF0ZUxpdmVBY3RvclNlc3Npb24iLCJhdXRoSGVhZGVycyIsInRva2VuIiwiQXV0aG9yaXphdGlvbiIsInJlYWRSZXNwb25zZUJvZHkiLCJyZXNwb25zZSIsImpzb24iLCJ0ZXh0IiwiTGl2ZUNsaWVudCIsImNvbnN0cnVjdG9yIiwiYXBpIiwiY2FjaGVkQWRtaW5TZXNzaW9uIiwibW9iaWxlU2Vzc2lvbkNhY2hlIiwiTWFwIiwiY3JlYXRlIiwibmV3Q29udGV4dCIsImJhc2VVUkwiLCJhcGlCYXNlVVJMIiwiZXh0cmFIVFRQSGVhZGVycyIsImlnbm9yZUhUVFBTRXJyb3JzIiwiZGlzcG9zZSIsImdldCIsInBhdGgiLCJoZWFkZXJzIiwicG9zdCIsImRhdGEiLCJwYXRjaCIsInNlZWRUZXN0QWNjb3VudHMiLCJzZWVkS2V5IiwiYWRtaW5SZXNldEtleSIsIm9wc0FwaUtleSIsInJlcXVlc3RXaXRoQmFja29mZiIsInBhcmFtcyIsImtleSIsInJldHJpZXMiLCJiYWNrb2ZmTXMiLCJyZXRyeVN0YXR1c2VzIiwib2siLCJfcGF5bG9hZCRhZG1pblNlc3Npb24iLCJwYXlsb2FkIiwiYWRtaW5TZXNzaW9uIiwiZW50cnkiLCJfcGF5bG9hZCRzZXNzaW9ucyIsInNlc3Npb25zIiwiY3VzdG9tZXJzIiwiX2VudHJ5JHNlc3Npb24iLCJzZXNzaW9uIiwicGhvbmUiLCJzZXQiLCJnZXRNb2JpbGVDYWNoZUtleSIsIl9wYXlsb2FkJHNlc3Npb25zMiIsImRyaXZlcnMiLCJfZW50cnkkc2Vzc2lvbjIiLCJib290c3RyYXBNb2RlIiwic3RhdHVzIiwidG9CZVRydXRoeSIsImJvb3RzdHJhcFFhQWNjb3VudHMiLCJpbml0aWFsaXplU2hhcmVkU3RhdGUiLCJfYm9vdHN0cmFwJGFkbWluU2Vzc2kiLCJfYm9vdHN0cmFwJGJvb3RzdHJhcE0iLCJib290c3RyYXAiLCJhZG1pbiIsImJpa2UiLCJhdXRvIiwiY2FiIiwicG9vbCIsIlByb21pc2UiLCJhbGwiLCJyZXNvbHZlIiwibG9naW5BZG1pbiIsImdldENhdGVnb3J5QnlMYWJlbCIsInRyeUdldENhdGVnb3J5QnlMYWJlbCIsImN1c3RvbWVyUHJpbWFyeSIsImN1c3RvbWVyU2Vjb25kYXJ5IiwiZHJpdmVyQmlrZVByaW1hcnkiLCJkcml2ZXJCaWtlU2Vjb25kYXJ5IiwiZHJpdmVyQmlrZVRlcnRpYXJ5IiwiZHJpdmVyQmlrZVF1YXRlcm5hcnkiLCJkcml2ZXJBdXRvUHJpbWFyeSIsImRyaXZlckNhYlByaW1hcnkiLCJsb2dpbk1vYmlsZSIsImxpdmVDdXN0b21lclBob25lIiwibGl2ZUN1c3RvbWVyUGhvbmUyIiwibGl2ZURyaXZlckJpa2VQaG9uZSIsImxpdmVEcml2ZXJBdXRvUGhvbmUiLCJsaXZlRHJpdmVyQ2FiUGhvbmUiLCJ2ZXJzaW9uIiwiZW52TmFtZSIsInFhUnVuSWQiLCJjcmVhdGVkQXQiLCJEYXRlIiwidG9JU09TdHJpbmciLCJjYXRlZ29yaWVzIiwiYWN0b3JzIiwibGFiZWwiLCJhcnRpZmFjdHMiLCJ0cmlwSWRzIiwicGFyY2VsT3JkZXJJZHMiLCJvdXRzdGF0aW9uUmlkZUlkcyIsIm5vdGVzIiwiZ2V0T3BzUmVhZHkiLCJmb3JjZVJlZnJlc2giLCJfdGhpcyRjYWNoZWRBZG1pblNlc3MiLCJhZG1pblBhc3N3b3JkIiwiX3N0YXRlJGFkbWluJHNlc3Npb24iLCJzdGF0ZSIsImVtYWlsIiwiYWRtaW5FbWFpbCIsInBhc3N3b3JkIiwiYm9keSIsInJlcXVpcmVzVHdvRmFjdG9yIiwiRXJyb3IiLCJhZG1pbkdldCIsImdldFJhem9ycGF5RGlhZyIsInVzZXJUeXBlIiwiY2FjaGVLZXkiLCJjYWNoZWQiLCJsaXZlTW9iaWxlUGFzc3dvcmQiLCJyZWZyZXNoTW9iaWxlU2Vzc2lvbiIsIl9hd2FpdCR0aGlzJHJlZnJlc2hNbyIsInJlZnJlc2hlZCIsInJlZnJlc2hNb2JpbGVBY2Nlc3NUb2tlbiIsInVzZXIiLCJyZWZyZXNoVG9rZW4iLCJleHBpcmVzQXQiLCJyZWdpc3Rlck1vYmlsZSIsInRvQ29udGFpbiIsInVwZGF0ZURyaXZlclByb2ZpbGUiLCJtb2JpbGVQYXRjaCIsImFwcHJvdmVEcml2ZXIiLCJhZG1pblRva2VuIiwiZHJpdmVySWQiLCJub3RlIiwidmVoaWNsZVN0YXR1cyIsImdldFZlaGljbGVDYXRlZ29yaWVzIiwibGlzdCIsIkFycmF5IiwiaXNBcnJheSIsIm5vcm1hbGl6ZWQiLCJ0b0xvd2VyQ2FzZSIsImNhdGVnb3J5IiwiZmluZCIsIml0ZW0iLCJoYXlzdGFjayIsIm5hbWUiLCJ0eXBlIiwidmVoaWNsZVR5cGUiLCJzZXJ2aWNlVHlwZSIsImluY2x1ZGVzIiwiaXNDYXJwb29sIiwiZ2V0TmVhcmJ5RHJpdmVycyIsInZlaGljbGVDYXRlZ29yeUlkIiwibGF0IiwicmlkZVBpY2t1cExhdCIsImxuZyIsInJpZGVQaWNrdXBMbmciLCJyYWRpdXMiLCJib29rUmlkZSIsIm1vYmlsZVBvc3QiLCJKU09OIiwic3RyaW5naWZ5IiwiZ2V0Q3VzdG9tZXJBY3RpdmVUcmlwIiwibW9iaWxlR2V0IiwiYmVzdEVmZm9ydENhbmNlbEFjdGl2ZVRyaXAiLCJyZWFzb24iLCJ0cmlwIiwiYWN0aXZlVHJpcCIsInRyaXBJZCIsImlkIiwiY3VycmVudFN0YXR1cyIsIlN0cmluZyIsImNhbmNlbEN1c3RvbWVyVHJpcCIsImdldERyaXZlckluY29taW5nVHJpcCIsImdldERyaXZlckFjdGl2ZVRyaXAiLCJhY2NlcHRUcmlwIiwibWFya0Fycml2ZWQiLCJzdGFydFRyaXAiLCJwaWNrdXBPdHAiLCJjb21wbGV0ZVRyaXAiLCJhY3R1YWxGYXJlIiwiYWN0dWFsRGlzdGFuY2UiLCJ0aXBzIiwiZ2V0Q3VzdG9tZXJUcmlwUmVjZWlwdCIsImdldERyaXZlclRyaXBSZWNlaXB0IiwiZ2V0Q3VzdG9tZXJXYWxsZXQiLCJjcmVhdGVXYWxsZXRPcmRlciIsImFtb3VudCIsImNyZWF0ZVJpZGVQYXltZW50T3JkZXIiLCJ2ZXJpZnlSaWRlUGF5bWVudEludmFsaWQiLCJvcmRlcklkIiwicmF6b3JwYXlPcmRlcklkIiwicmF6b3JwYXlQYXltZW50SWQiLCJub3ciLCJyYXpvcnBheVNpZ25hdHVyZSIsInRvQmUiLCJxdW90ZVBhcmNlbCIsImJvb2tQYXJjZWwiLCJjYW5jZWxQYXJjZWwiLCJjcmVhdGVPdXRzdGF0aW9uUmlkZSIsInNlYXJjaE91dHN0YXRpb25SaWRlcyIsImZyb21DaXR5IiwidG9DaXR5IiwiZGF0ZSIsImJvb2tPdXRzdGF0aW9uUmlkZSIsImRlYWN0aXZhdGVPdXRzdGF0aW9uUmlkZSIsInJpZGVJZCIsImlzQWN0aXZlIiwiZ2V0QWRtaW5PdXRzdGF0aW9uUmlkZXMiLCJyZXRyeSIsInRyaWdnZXJTb3MiLCJ0cmlnZ2VyQWlTb3MiLCJnZXRDdXN0b21lclN1cHBvcnRDaGF0Iiwic2VuZEN1c3RvbWVyU3VwcG9ydENoYXQiLCJtZXNzYWdlIiwidmFsaWRhdGVTaGFyZWRTdGF0ZSIsIl9zdGF0ZSRhY3RvcnMkY3VzdG9tZSIsIl9zdGF0ZSRhY3RvcnMkZHJpdmVyQSIsImNoZWNrcyIsImV2ZXJ5IiwicmVxdWVzdFdpdGhNb2JpbGVBdXRoIiwiZmFjdG9yeSIsInRyaW0iLCJkZWNvZGVBY2Nlc3NUb2tlbiIsImRldmljZUlkIiwiYmlrZUNhdGVnb3J5IiwiYXV0b0NhdGVnb3J5IiwiY2FiQ2F0ZWdvcnkiLCJlbnN1cmVDdXN0b21lciIsImZ1bGxOYW1lIiwiZXhpc3RpbmciLCJlbnN1cmVEcml2ZXIiLCJ2ZWhpY2xlTnVtYmVyIiwidmVoaWNsZU1vZGVsIiwic3VjY2VzcyIsImZhbGxiYWNrIiwibWFwIiwiY3VzdG9tZXIiLCJkcml2ZXIiLCJvcHRpb25zIiwiYXR0ZW1wdCIsInJlYWRTdGF0dXMiLCJyZXRyeUFmdGVyTXMiLCJyZWFkUmV0cnlBZnRlck1zIiwiZGVsYXlNcyIsInNldFRpbWVvdXQiLCJjYW5kaWRhdGUiLCJOdW1iZXIiLCJyZXRyeUFmdGVyIiwic2Vjb25kcyIsImlzRmluaXRlIiwiZGF0ZU1zIiwicGFyc2UiLCJpc05hTiIsIk1hdGgiLCJtYXgiLCJwYXJ0cyIsInNwbGl0IiwibGVuZ3RoIiwiQnVmZmVyIiwiZnJvbSIsInRvU3RyaW5nIl0sInNvdXJjZXMiOlsibGl2ZS1jbGllbnQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgZXhwZWN0LCByZXF1ZXN0LCB0eXBlIEFQSVJlcXVlc3RDb250ZXh0IH0gZnJvbSBcIkBwbGF5d3JpZ2h0L3Rlc3RcIjtcclxuaW1wb3J0IHsgcnVudGltZSB9IGZyb20gXCIuL3J1bnRpbWVcIjtcbmltcG9ydCB0eXBlIHsgU2hhcmVkTGl2ZVN1aXRlU3RhdGUgfSBmcm9tIFwiLi9saXZlLXN1aXRlLXN0YXRlXCI7XG5pbXBvcnQgeyByZWFkTGl2ZVN1aXRlU3RhdGUsIHVwZGF0ZUxpdmVBY3RvclNlc3Npb24gfSBmcm9tIFwiLi9saXZlLXN1aXRlLXN0YXRlXCI7XG5cclxuZXhwb3J0IHR5cGUgQWRtaW5TZXNzaW9uID0ge1xyXG4gIHRva2VuOiBzdHJpbmc7XHJcbiAgYWRtaW46IHtcclxuICAgIGlkOiBzdHJpbmc7XHJcbiAgICBuYW1lOiBzdHJpbmc7XHJcbiAgICBlbWFpbDogc3RyaW5nO1xyXG4gICAgcm9sZTogc3RyaW5nO1xyXG4gIH07XHJcbiAgZXhwaXJlc0F0OiBzdHJpbmc7XHJcbn07XHJcblxyXG5leHBvcnQgdHlwZSBNb2JpbGVTZXNzaW9uID0ge1xuICB0b2tlbjogc3RyaW5nO1xuICByZWZyZXNoVG9rZW4/OiBzdHJpbmc7XG4gIGV4cGlyZXNBdD86IHN0cmluZztcbiAgdXNlcjoge1xuICAgIGlkOiBzdHJpbmc7XG4gICAgZnVsbE5hbWU6IHN0cmluZztcbiAgICBwaG9uZTogc3RyaW5nO1xyXG4gICAgdXNlclR5cGU6IHN0cmluZztcclxuICAgIHdhbGxldEJhbGFuY2U/OiBudW1iZXI7XHJcbiAgfTtcbn07XG5cbnR5cGUgQWNjZXNzVG9rZW5QYXlsb2FkID0ge1xuICBzdWI/OiBzdHJpbmc7XG4gIHVzZXJUeXBlPzogc3RyaW5nO1xuICBkZXZpY2VJZD86IHN0cmluZztcbiAgdHlwPzogc3RyaW5nO1xuICBpYXQ/OiBudW1iZXI7XG4gIGV4cD86IG51bWJlcjtcbiAganRpPzogc3RyaW5nO1xufTtcblxudHlwZSBTZWVkQm9vdHN0cmFwUGF5bG9hZCA9IHtcbiAgYm9vdHN0cmFwTW9kZT86IFwic2VlZFwiIHwgXCJmYWxsYmFja1wiO1xuICBhZG1pblNlc3Npb24/OiBBZG1pblNlc3Npb247XG4gIHNlc3Npb25zPzoge1xuICAgIGN1c3RvbWVycz86IEFycmF5PHsgcGhvbmU6IHN0cmluZzsgc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiB8IG51bGwgfT47XG4gICAgZHJpdmVycz86IEFycmF5PHsgcGhvbmU6IHN0cmluZzsgc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiB8IG51bGwgfT47XG4gIH07XG59O1xuXHJcbmV4cG9ydCB0eXBlIFZlaGljbGVDYXRlZ29yeSA9IHtcclxuICBpZDogc3RyaW5nO1xyXG4gIG5hbWU6IHN0cmluZztcclxuICB0eXBlPzogc3RyaW5nO1xyXG4gIHZlaGljbGVUeXBlPzogc3RyaW5nO1xyXG4gIHNlcnZpY2VUeXBlPzogc3RyaW5nO1xyXG4gIGlzQ2FycG9vbD86IGJvb2xlYW47XHJcbn07XHJcblxyXG5mdW5jdGlvbiBhdXRoSGVhZGVycyh0b2tlbjogc3RyaW5nKSB7XHJcbiAgcmV0dXJuIHtcclxuICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHt0b2tlbn1gLFxyXG4gICAgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXHJcbiAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVhZFJlc3BvbnNlQm9keShyZXNwb25zZTogeyBqc29uOiAoKSA9PiBQcm9taXNlPHVua25vd24+OyB0ZXh0OiAoKSA9PiBQcm9taXNlPHN0cmluZz4gfSkge1xyXG4gIHRyeSB7XHJcbiAgICByZXR1cm4gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xyXG4gIH0gY2F0Y2gge1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmV0dXJuIGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBMaXZlQ2xpZW50IHtcbiAgY29uc3RydWN0b3IocHJpdmF0ZSByZWFkb25seSBhcGk6IEFQSVJlcXVlc3RDb250ZXh0KSB7fVxyXG4gIHByaXZhdGUgY2FjaGVkQWRtaW5TZXNzaW9uOiBBZG1pblNlc3Npb24gfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIHJlYWRvbmx5IG1vYmlsZVNlc3Npb25DYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBNb2JpbGVTZXNzaW9uPigpO1xyXG5cclxuICBzdGF0aWMgYXN5bmMgY3JlYXRlKCkge1xyXG4gICAgY29uc3QgYXBpID0gYXdhaXQgcmVxdWVzdC5uZXdDb250ZXh0KHtcclxuICAgICAgYmFzZVVSTDogcnVudGltZS5hcGlCYXNlVVJMLFxyXG4gICAgICBleHRyYUhUVFBIZWFkZXJzOiB7XHJcbiAgICAgICAgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXHJcbiAgICAgICAgXCJ4LWphZ28tcGxheXdyaWdodC1zdWl0ZVwiOiBcInRydWVcIixcclxuICAgICAgfSxcclxuICAgICAgaWdub3JlSFRUUFNFcnJvcnM6IHRydWUsXHJcbiAgICB9KTtcclxuICAgIHJldHVybiBuZXcgTGl2ZUNsaWVudChhcGkpO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgZGlzcG9zZSgpIHtcclxuICAgIGF3YWl0IHRoaXMuYXBpLmRpc3Bvc2UoKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGdldChwYXRoOiBzdHJpbmcsIGhlYWRlcnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KSB7XHJcbiAgICByZXR1cm4gdGhpcy5hcGkuZ2V0KHBhdGgsIHsgaGVhZGVycyB9KTtcclxuICB9XHJcblxyXG4gIGFzeW5jIHBvc3QocGF0aDogc3RyaW5nLCBkYXRhPzogdW5rbm93biwgaGVhZGVycz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pIHtcclxuICAgIHJldHVybiB0aGlzLmFwaS5wb3N0KHBhdGgsIHsgZGF0YSwgaGVhZGVycyB9KTtcclxuICB9XHJcblxyXG4gIGFzeW5jIHBhdGNoKHBhdGg6IHN0cmluZywgZGF0YT86IHVua25vd24sIGhlYWRlcnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KSB7XHJcbiAgICByZXR1cm4gdGhpcy5hcGkucGF0Y2gocGF0aCwgeyBkYXRhLCBoZWFkZXJzIH0pO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgc2VlZFRlc3RBY2NvdW50cygpIHtcbiAgICBjb25zdCBzZWVkS2V5ID0gcnVudGltZS5hZG1pblJlc2V0S2V5IHx8IHJ1bnRpbWUub3BzQXBpS2V5O1xyXG4gICAgaWYgKHNlZWRLZXkpIHtcclxuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnJlcXVlc3RXaXRoQmFja29mZihcclxuICAgICAgICAoKSA9PiB0aGlzLmFwaS5nZXQoXCIvYXBpL29wcy9zZWVkLXRlc3QtYWNjb3VudHNcIiwge1xyXG4gICAgICAgICAgcGFyYW1zOiB7XHJcbiAgICAgICAgICAgIGtleTogc2VlZEtleSxcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgICBoZWFkZXJzOiB7XHJcbiAgICAgICAgICAgIFwieC1vcHMta2V5XCI6IHNlZWRLZXksXHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIHsgcmV0cmllczogMiwgYmFja29mZk1zOiAyXzAwMCwgcmV0cnlTdGF0dXNlczogWzQyOV0gfSxcclxuICAgICAgKTtcclxuXHJcbiAgICAgIGlmIChyZXNwb25zZS5vaygpKSB7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBhd2FpdCByZXNwb25zZS5qc29uKCkgYXMgU2VlZEJvb3RzdHJhcFBheWxvYWQ7XG4gICAgICAgIGlmIChwYXlsb2FkLmFkbWluU2Vzc2lvbj8udG9rZW4pIHtcbiAgICAgICAgICB0aGlzLmNhY2hlZEFkbWluU2Vzc2lvbiA9IHBheWxvYWQuYWRtaW5TZXNzaW9uO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgcGF5bG9hZC5zZXNzaW9ucz8uY3VzdG9tZXJzIHx8IFtdKSB7XG4gICAgICAgICAgaWYgKGVudHJ5Py5zZXNzaW9uPy50b2tlbiAmJiBlbnRyeT8ucGhvbmUpIHtcbiAgICAgICAgICAgIHRoaXMubW9iaWxlU2Vzc2lvbkNhY2hlLnNldCh0aGlzLmdldE1vYmlsZUNhY2hlS2V5KGVudHJ5LnBob25lLCBcImN1c3RvbWVyXCIpLCBlbnRyeS5zZXNzaW9uKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBwYXlsb2FkLnNlc3Npb25zPy5kcml2ZXJzIHx8IFtdKSB7XG4gICAgICAgICAgaWYgKGVudHJ5Py5zZXNzaW9uPy50b2tlbiAmJiBlbnRyeT8ucGhvbmUpIHtcbiAgICAgICAgICAgIHRoaXMubW9iaWxlU2Vzc2lvbkNhY2hlLnNldCh0aGlzLmdldE1vYmlsZUNhY2hlS2V5KGVudHJ5LnBob25lLCBcImRyaXZlclwiKSwgZW50cnkuc2Vzc2lvbik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgLi4ucGF5bG9hZCxcbiAgICAgICAgICBib290c3RyYXBNb2RlOiBcInNlZWRcIiBhcyBjb25zdCxcbiAgICAgICAgfTtcbiAgICAgIH1cblxyXG4gICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzKCkgIT09IDQwMykge1xyXG4gICAgICAgIGV4cGVjdChyZXNwb25zZS5vaygpKS50b0JlVHJ1dGh5KCk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gdGhpcy5ib290c3RyYXBRYUFjY291bnRzKCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBpbml0aWFsaXplU2hhcmVkU3RhdGUoKTogUHJvbWlzZTxTaGFyZWRMaXZlU3VpdGVTdGF0ZT4ge1xyXG4gICAgY29uc3QgYm9vdHN0cmFwID0gYXdhaXQgdGhpcy5zZWVkVGVzdEFjY291bnRzKCk7XHJcbiAgICBjb25zdCBbYWRtaW4sIGJpa2UsIGF1dG8sIGNhYiwgcG9vbF0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICBib290c3RyYXAuYWRtaW5TZXNzaW9uPy50b2tlbiA/IFByb21pc2UucmVzb2x2ZShib290c3RyYXAuYWRtaW5TZXNzaW9uKSA6IHRoaXMubG9naW5BZG1pbigpLFxuICAgICAgdGhpcy5nZXRDYXRlZ29yeUJ5TGFiZWwoXCJiaWtlXCIpLFxuICAgICAgdGhpcy5nZXRDYXRlZ29yeUJ5TGFiZWwoXCJhdXRvXCIpLFxuICAgICAgdGhpcy5nZXRDYXRlZ29yeUJ5TGFiZWwoXCJjYWJcIiksXG4gICAgICB0aGlzLnRyeUdldENhdGVnb3J5QnlMYWJlbChcInBvb2xcIiksXHJcbiAgICBdKTtcclxuXHJcbiAgICBjb25zdCBbXHJcbiAgICAgIGN1c3RvbWVyUHJpbWFyeSxcclxuICAgICAgY3VzdG9tZXJTZWNvbmRhcnksXHJcbiAgICAgIGRyaXZlckJpa2VQcmltYXJ5LFxyXG4gICAgICBkcml2ZXJCaWtlU2Vjb25kYXJ5LFxyXG4gICAgICBkcml2ZXJCaWtlVGVydGlhcnksXHJcbiAgICAgIGRyaXZlckJpa2VRdWF0ZXJuYXJ5LFxyXG4gICAgICBkcml2ZXJBdXRvUHJpbWFyeSxcclxuICAgICAgZHJpdmVyQ2FiUHJpbWFyeSxcclxuICAgIF0gPSBhd2FpdCBQcm9taXNlLmFsbChbXHJcbiAgICAgIHRoaXMubG9naW5Nb2JpbGUocnVudGltZS5saXZlQ3VzdG9tZXJQaG9uZSwgXCJjdXN0b21lclwiKSxcclxuICAgICAgdGhpcy5sb2dpbk1vYmlsZShydW50aW1lLmxpdmVDdXN0b21lclBob25lMiwgXCJjdXN0b21lclwiKSxcclxuICAgICAgdGhpcy5sb2dpbk1vYmlsZShydW50aW1lLmxpdmVEcml2ZXJCaWtlUGhvbmUsIFwiZHJpdmVyXCIpLFxyXG4gICAgICB0aGlzLmxvZ2luTW9iaWxlKFwiOTEwMDAwMDAwMlwiLCBcImRyaXZlclwiKSxcclxuICAgICAgdGhpcy5sb2dpbk1vYmlsZShcIjkxMDAwMDAwMDNcIiwgXCJkcml2ZXJcIiksXHJcbiAgICAgIHRoaXMubG9naW5Nb2JpbGUoXCI5MTAwMDAwMDA0XCIsIFwiZHJpdmVyXCIpLFxyXG4gICAgICB0aGlzLmxvZ2luTW9iaWxlKHJ1bnRpbWUubGl2ZURyaXZlckF1dG9QaG9uZSwgXCJkcml2ZXJcIiksXHJcbiAgICAgIHRoaXMubG9naW5Nb2JpbGUocnVudGltZS5saXZlRHJpdmVyQ2FiUGhvbmUsIFwiZHJpdmVyXCIpLFxyXG4gICAgXSk7XHJcblxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgdmVyc2lvbjogMSxcclxuICAgICAgZW52TmFtZTogcnVudGltZS5lbnZOYW1lLFxyXG4gICAgICBxYVJ1bklkOiBydW50aW1lLnFhUnVuSWQsXHJcbiAgICAgIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxyXG4gICAgICBib290c3RyYXBNb2RlOiBib290c3RyYXAuYm9vdHN0cmFwTW9kZSA/PyBcImZhbGxiYWNrXCIsXHJcbiAgICAgIGFkbWluOiB7XHJcbiAgICAgICAgc2Vzc2lvbjogYWRtaW4sXHJcbiAgICAgIH0sXHJcbiAgICAgIGNhdGVnb3JpZXM6IHtcclxuICAgICAgICBiaWtlLFxyXG4gICAgICAgIGF1dG8sXHJcbiAgICAgICAgY2FiLFxyXG4gICAgICAgIHBvb2wsXHJcbiAgICAgIH0sXHJcbiAgICAgIGFjdG9yczoge1xyXG4gICAgICAgIGN1c3RvbWVyUHJpbWFyeTogeyBsYWJlbDogXCJjdXN0b21lci1wcmltYXJ5XCIsIHBob25lOiBydW50aW1lLmxpdmVDdXN0b21lclBob25lLCBzZXNzaW9uOiBjdXN0b21lclByaW1hcnkgfSxcclxuICAgICAgICBjdXN0b21lclNlY29uZGFyeTogeyBsYWJlbDogXCJjdXN0b21lci1zZWNvbmRhcnlcIiwgcGhvbmU6IHJ1bnRpbWUubGl2ZUN1c3RvbWVyUGhvbmUyLCBzZXNzaW9uOiBjdXN0b21lclNlY29uZGFyeSB9LFxyXG4gICAgICAgIGRyaXZlckJpa2VQcmltYXJ5OiB7IGxhYmVsOiBcImRyaXZlci1iaWtlLXByaW1hcnlcIiwgcGhvbmU6IHJ1bnRpbWUubGl2ZURyaXZlckJpa2VQaG9uZSwgc2Vzc2lvbjogZHJpdmVyQmlrZVByaW1hcnkgfSxcclxuICAgICAgICBkcml2ZXJCaWtlU2Vjb25kYXJ5OiB7IGxhYmVsOiBcImRyaXZlci1iaWtlLXNlY29uZGFyeVwiLCBwaG9uZTogXCI5MTAwMDAwMDAyXCIsIHNlc3Npb246IGRyaXZlckJpa2VTZWNvbmRhcnkgfSxcclxuICAgICAgICBkcml2ZXJCaWtlVGVydGlhcnk6IHsgbGFiZWw6IFwiZHJpdmVyLWJpa2UtdGVydGlhcnlcIiwgcGhvbmU6IFwiOTEwMDAwMDAwM1wiLCBzZXNzaW9uOiBkcml2ZXJCaWtlVGVydGlhcnkgfSxcclxuICAgICAgICBkcml2ZXJCaWtlUXVhdGVybmFyeTogeyBsYWJlbDogXCJkcml2ZXItYmlrZS1xdWF0ZXJuYXJ5XCIsIHBob25lOiBcIjkxMDAwMDAwMDRcIiwgc2Vzc2lvbjogZHJpdmVyQmlrZVF1YXRlcm5hcnkgfSxcclxuICAgICAgICBkcml2ZXJBdXRvUHJpbWFyeTogeyBsYWJlbDogXCJkcml2ZXItYXV0by1wcmltYXJ5XCIsIHBob25lOiBydW50aW1lLmxpdmVEcml2ZXJBdXRvUGhvbmUsIHNlc3Npb246IGRyaXZlckF1dG9QcmltYXJ5IH0sXHJcbiAgICAgICAgZHJpdmVyQ2FiUHJpbWFyeTogeyBsYWJlbDogXCJkcml2ZXItY2FiLXByaW1hcnlcIiwgcGhvbmU6IHJ1bnRpbWUubGl2ZURyaXZlckNhYlBob25lLCBzZXNzaW9uOiBkcml2ZXJDYWJQcmltYXJ5IH0sXHJcbiAgICAgIH0sXHJcbiAgICAgIGFydGlmYWN0czoge1xyXG4gICAgICAgIHRyaXBJZHM6IFtdLFxyXG4gICAgICAgIHBhcmNlbE9yZGVySWRzOiBbXSxcclxuICAgICAgICBvdXRzdGF0aW9uUmlkZUlkczogW10sXHJcbiAgICAgICAgbm90ZXM6IFtdLFxyXG4gICAgICB9LFxyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGdldE9wc1JlYWR5KCkge1xyXG4gICAgZXhwZWN0KHJ1bnRpbWUub3BzQXBpS2V5IHx8IHJ1bnRpbWUuYWRtaW5SZXNldEtleSkudG9CZVRydXRoeSgpO1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLmFwaS5nZXQoXCIvYXBpL29wcy9yZWFkeVwiLCB7XHJcbiAgICAgIGhlYWRlcnM6IHtcclxuICAgICAgICBcIngtb3BzLWtleVwiOiBydW50aW1lLm9wc0FwaUtleSB8fCBydW50aW1lLmFkbWluUmVzZXRLZXksXHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIGV4cGVjdChyZXNwb25zZS5vaygpKS50b0JlVHJ1dGh5KCk7XHJcbiAgICByZXR1cm4gcmVzcG9uc2UuanNvbigpO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgbG9naW5BZG1pbihmb3JjZVJlZnJlc2ggPSBmYWxzZSk6IFByb21pc2U8QWRtaW5TZXNzaW9uPiB7XG4gICAgaWYgKCFmb3JjZVJlZnJlc2ggJiYgdGhpcy5jYWNoZWRBZG1pblNlc3Npb24/LnRva2VuKSB7XG4gICAgICByZXR1cm4gdGhpcy5jYWNoZWRBZG1pblNlc3Npb247XG4gICAgfVxuXG4gICAgaWYgKCFydW50aW1lLmFkbWluUGFzc3dvcmQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgcmVhZExpdmVTdWl0ZVN0YXRlKCk7XG4gICAgICAgIGlmIChzdGF0ZS5hZG1pbi5zZXNzaW9uPy50b2tlbikge1xuICAgICAgICAgIHRoaXMuY2FjaGVkQWRtaW5TZXNzaW9uID0gc3RhdGUuYWRtaW4uc2Vzc2lvbjtcbiAgICAgICAgICByZXR1cm4gdGhpcy5jYWNoZWRBZG1pblNlc3Npb247XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBGYWxsIHRocm91Z2ggdG8gYSBkaXJlY3QgbG9naW4gYXR0ZW1wdC5cbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMucmVxdWVzdFdpdGhCYWNrb2ZmKFxuICAgICAgKCkgPT4gdGhpcy5hcGkucG9zdChcIi9hcGkvYWRtaW4vbG9naW5cIiwge1xyXG4gICAgICAgIGRhdGE6IHtcclxuICAgICAgICAgIGVtYWlsOiBydW50aW1lLmFkbWluRW1haWwsXHJcbiAgICAgICAgICBwYXNzd29yZDogcnVudGltZS5hZG1pblBhc3N3b3JkLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0pLFxyXG4gICAgICB7IHJldHJpZXM6IDIsIGJhY2tvZmZNczogNV8wMDAsIHJldHJ5U3RhdHVzZXM6IFs0MjldIH0sXHJcbiAgICApO1xyXG5cclxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XHJcbiAgICBpZiAocmVzcG9uc2Uuc3RhdHVzKCkgPT09IDIwMiAmJiBib2R5Py5yZXF1aXJlc1R3b0ZhY3Rvcikge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBZG1pbiBsb2dpbiByZXF1aXJlcyBsaXZlIE9UUCB2ZXJpZmljYXRpb24uIFBsYXl3cmlnaHQgY2Fubm90IGNvbnRpbnVlIGFkbWluLWF1dGhlbnRpY2F0ZWQgY2hlY2tzIHdpdGhvdXQgT1RQIGFjY2Vzcy5cIik7XHJcbiAgICB9XHJcblxyXG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcclxuICAgIGV4cGVjdChib2R5Py50b2tlbikudG9CZVRydXRoeSgpO1xyXG4gICAgdGhpcy5jYWNoZWRBZG1pblNlc3Npb24gPSBib2R5IGFzIEFkbWluU2Vzc2lvbjtcclxuICAgIHJldHVybiB0aGlzLmNhY2hlZEFkbWluU2Vzc2lvbjtcclxuICB9XHJcblxyXG4gIGFzeW5jIGFkbWluR2V0KHBhdGg6IHN0cmluZykge1xyXG4gICAgbGV0IGFkbWluID0gYXdhaXQgdGhpcy5sb2dpbkFkbWluKCk7XHJcbiAgICBsZXQgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLmFwaS5nZXQocGF0aCwge1xyXG4gICAgICBoZWFkZXJzOiBhdXRoSGVhZGVycyhhZG1pbi50b2tlbiksXHJcbiAgICB9KTtcclxuICAgIGlmIChyZXNwb25zZS5zdGF0dXMoKSA9PT0gNDAxKSB7XHJcbiAgICAgIGFkbWluID0gYXdhaXQgdGhpcy5sb2dpbkFkbWluKHRydWUpO1xyXG4gICAgICByZXNwb25zZSA9IGF3YWl0IHRoaXMuYXBpLmdldChwYXRoLCB7XHJcbiAgICAgICAgaGVhZGVyczogYXV0aEhlYWRlcnMoYWRtaW4udG9rZW4pLFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXNwb25zZTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGdldFJhem9ycGF5RGlhZyh0b2tlbjogc3RyaW5nKSB7XHJcbiAgICBjb25zdCByZXNwb25zZSA9IHRva2VuXHJcbiAgICAgID8gYXdhaXQgdGhpcy5hcGkuZ2V0KFwiL2FwaS9kaWFnL3Jhem9ycGF5XCIsIHsgaGVhZGVyczogYXV0aEhlYWRlcnModG9rZW4pIH0pXHJcbiAgICAgIDogYXdhaXQgdGhpcy5hZG1pbkdldChcIi9hcGkvZGlhZy9yYXpvcnBheVwiKTtcclxuICAgIGV4cGVjdChyZXNwb25zZS5vaygpKS50b0JlVHJ1dGh5KCk7XHJcbiAgICByZXR1cm4gcmVzcG9uc2UuanNvbigpO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgbG9naW5Nb2JpbGUocGhvbmU6IHN0cmluZywgdXNlclR5cGU6IFwiY3VzdG9tZXJcIiB8IFwiZHJpdmVyXCIsIGZvcmNlUmVmcmVzaCA9IGZhbHNlKTogUHJvbWlzZTxNb2JpbGVTZXNzaW9uPiB7XHJcbiAgICBjb25zdCBjYWNoZUtleSA9IHRoaXMuZ2V0TW9iaWxlQ2FjaGVLZXkocGhvbmUsIHVzZXJUeXBlKTtcclxuICAgIGNvbnN0IGNhY2hlZCA9IHRoaXMubW9iaWxlU2Vzc2lvbkNhY2hlLmdldChjYWNoZUtleSk7XHJcbiAgICBpZiAoIWZvcmNlUmVmcmVzaCAmJiBjYWNoZWQ/LnRva2VuKSB7XHJcbiAgICAgIHJldHVybiBjYWNoZWQ7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnJlcXVlc3RXaXRoQmFja29mZihcclxuICAgICAgKCkgPT4gdGhpcy5hcGkucG9zdChcIi9hcGkvYXBwL2xvZ2luLXBhc3N3b3JkXCIsIHtcclxuICAgICAgICBkYXRhOiB7XHJcbiAgICAgICAgICBwaG9uZSxcclxuICAgICAgICAgIHBhc3N3b3JkOiBydW50aW1lLmxpdmVNb2JpbGVQYXNzd29yZCxcclxuICAgICAgICAgIHVzZXJUeXBlLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0pLFxyXG4gICAgICB7IHJldHJpZXM6IDIsIGJhY2tvZmZNczogNF8wMDAsIHJldHJ5U3RhdHVzZXM6IFs0MjldIH0sXHJcbiAgICApO1xyXG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcclxuICAgIGNvbnN0IHNlc3Npb24gPSBhd2FpdCByZXNwb25zZS5qc29uKCkgYXMgTW9iaWxlU2Vzc2lvbjtcclxuICAgIHRoaXMubW9iaWxlU2Vzc2lvbkNhY2hlLnNldChjYWNoZUtleSwgc2Vzc2lvbik7XHJcbiAgICByZXR1cm4gc2Vzc2lvbjtcclxuICB9XHJcblxyXG4gIGFzeW5jIHJlZnJlc2hNb2JpbGVTZXNzaW9uKHNlc3Npb246IE1vYmlsZVNlc3Npb24pIHtcbiAgICBjb25zdCByZWZyZXNoZWQgPSBhd2FpdCB0aGlzLnJlZnJlc2hNb2JpbGVBY2Nlc3NUb2tlbihzZXNzaW9uKVxuICAgICAgPz8gYXdhaXQgdGhpcy5sb2dpbk1vYmlsZShzZXNzaW9uLnVzZXIucGhvbmUsIHNlc3Npb24udXNlci51c2VyVHlwZSBhcyBcImN1c3RvbWVyXCIgfCBcImRyaXZlclwiLCB0cnVlKTtcbiAgICBzZXNzaW9uLnRva2VuID0gcmVmcmVzaGVkLnRva2VuO1xuICAgIHNlc3Npb24ucmVmcmVzaFRva2VuID0gcmVmcmVzaGVkLnJlZnJlc2hUb2tlbjtcbiAgICBzZXNzaW9uLmV4cGlyZXNBdCA9IHJlZnJlc2hlZC5leHBpcmVzQXQ7XG4gICAgc2Vzc2lvbi51c2VyID0gcmVmcmVzaGVkLnVzZXI7XG4gICAgdGhpcy5tb2JpbGVTZXNzaW9uQ2FjaGUuc2V0KHRoaXMuZ2V0TW9iaWxlQ2FjaGVLZXkoc2Vzc2lvbi51c2VyLnBob25lLCBzZXNzaW9uLnVzZXIudXNlclR5cGUgYXMgXCJjdXN0b21lclwiIHwgXCJkcml2ZXJcIiksIHNlc3Npb24pO1xuICAgIGF3YWl0IHVwZGF0ZUxpdmVBY3RvclNlc3Npb24oc2Vzc2lvbi51c2VyLnBob25lLCBzZXNzaW9uLnVzZXIudXNlclR5cGUsIHNlc3Npb24pO1xuICAgIHJldHVybiBzZXNzaW9uO1xuICB9XG5cclxuICBhc3luYyByZWdpc3Rlck1vYmlsZShwYXJhbXM6IHtcclxuICAgIHBob25lOiBzdHJpbmc7XHJcbiAgICBwYXNzd29yZDogc3RyaW5nO1xyXG4gICAgZnVsbE5hbWU6IHN0cmluZztcclxuICAgIHVzZXJUeXBlOiBcImN1c3RvbWVyXCIgfCBcImRyaXZlclwiO1xyXG4gICAgZW1haWw/OiBzdHJpbmc7XHJcbiAgfSk6IFByb21pc2U8TW9iaWxlU2Vzc2lvbj4ge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnJlcXVlc3RXaXRoQmFja29mZihcclxuICAgICAgKCkgPT4gdGhpcy5hcGkucG9zdChcIi9hcGkvYXBwL3JlZ2lzdGVyXCIsIHtcclxuICAgICAgICBkYXRhOiBwYXJhbXMsXHJcbiAgICAgIH0pLFxyXG4gICAgICB7IHJldHJpZXM6IDIsIGJhY2tvZmZNczogNF8wMDAsIHJldHJ5U3RhdHVzZXM6IFs0MjldIH0sXHJcbiAgICApO1xyXG4gICAgZXhwZWN0KFsyMDAsIDIwMSwgNDA5XSkudG9Db250YWluKHJlc3BvbnNlLnN0YXR1cygpKTtcclxuICAgIGlmIChyZXNwb25zZS5zdGF0dXMoKSA9PT0gNDA5KSB7XHJcbiAgICAgIHJldHVybiB0aGlzLmxvZ2luTW9iaWxlKHBhcmFtcy5waG9uZSwgcGFyYW1zLnVzZXJUeXBlKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNlc3Npb24gPSBhd2FpdCByZXNwb25zZS5qc29uKCkgYXMgTW9iaWxlU2Vzc2lvbjtcclxuICAgIHRoaXMubW9iaWxlU2Vzc2lvbkNhY2hlLnNldCh0aGlzLmdldE1vYmlsZUNhY2hlS2V5KHBhcmFtcy5waG9uZSwgcGFyYW1zLnVzZXJUeXBlKSwgc2Vzc2lvbik7XHJcbiAgICByZXR1cm4gc2Vzc2lvbjtcclxuICB9XHJcblxyXG4gIGFzeW5jIHVwZGF0ZURyaXZlclByb2ZpbGUoc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgcGF5bG9hZDoge1xyXG4gICAgZnVsbE5hbWU/OiBzdHJpbmc7XHJcbiAgICBlbWFpbD86IHN0cmluZztcclxuICAgIHZlaGljbGVOdW1iZXI/OiBzdHJpbmc7XHJcbiAgICB2ZWhpY2xlTW9kZWw/OiBzdHJpbmc7XHJcbiAgICB2ZWhpY2xlQ2F0ZWdvcnlJZD86IHN0cmluZztcclxuICB9KSB7XHJcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMubW9iaWxlUGF0Y2goc2Vzc2lvbiwgXCIvYXBpL2FwcC9kcml2ZXIvcHJvZmlsZVwiLCBwYXlsb2FkKTtcclxuICAgIGV4cGVjdChyZXNwb25zZS5vaygpKS50b0JlVHJ1dGh5KCk7XHJcbiAgICByZXR1cm4gcmVzcG9uc2UuanNvbigpO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgYXBwcm92ZURyaXZlcihhZG1pblRva2VuOiBzdHJpbmcsIGRyaXZlcklkOiBzdHJpbmcsIG5vdGU6IHN0cmluZykge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLmFwaS5wYXRjaChgL2FwaS9hZG1pbi9kcml2ZXJzLyR7ZHJpdmVySWR9L3ZlcmlmeS1kcml2ZXJgLCB7XHJcbiAgICAgIGRhdGE6IHtcclxuICAgICAgICBzdGF0dXM6IFwiYXBwcm92ZWRcIixcclxuICAgICAgICB2ZWhpY2xlU3RhdHVzOiBcImFwcHJvdmVkXCIsXHJcbiAgICAgICAgbm90ZSxcclxuICAgICAgfSxcclxuICAgICAgaGVhZGVyczogYXV0aEhlYWRlcnMoYWRtaW5Ub2tlbiksXHJcbiAgICB9KTtcclxuICAgIGV4cGVjdChyZXNwb25zZS5vaygpKS50b0JlVHJ1dGh5KCk7XHJcbiAgICByZXR1cm4gcmVzcG9uc2UuanNvbigpO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgZ2V0VmVoaWNsZUNhdGVnb3JpZXMoKSB7XG4gICAgbGV0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5hcGkuZ2V0KFwiL2FwaS9hcHAvdmVoaWNsZS1jYXRlZ29yaWVzXCIpO1xuICAgIGlmICghcmVzcG9uc2Uub2soKSkge1xuICAgICAgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLmFwaS5nZXQoXCIvYXBpL3ZlaGljbGUtY2F0ZWdvcmllc1wiKTtcbiAgICB9XG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xuICAgIGNvbnN0IGxpc3QgPSBBcnJheS5pc0FycmF5KGJvZHkpID8gYm9keSA6IEFycmF5LmlzQXJyYXkoYm9keT8uZGF0YSkgPyBib2R5LmRhdGEgOiBbXTtcclxuICAgIHJldHVybiBsaXN0IGFzIFZlaGljbGVDYXRlZ29yeVtdO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgZ2V0Q2F0ZWdvcnlCeUxhYmVsKGxhYmVsOiBcImJpa2VcIiB8IFwiYXV0b1wiIHwgXCJjYWJcIiB8IFwicG9vbFwiKSB7XHJcbiAgICBjb25zdCBjYXRlZ29yaWVzID0gYXdhaXQgdGhpcy5nZXRWZWhpY2xlQ2F0ZWdvcmllcygpO1xyXG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IGxhYmVsLnRvTG93ZXJDYXNlKCk7XHJcbiAgICBjb25zdCBjYXRlZ29yeSA9IGNhdGVnb3JpZXMuZmluZCgoaXRlbSkgPT4ge1xyXG4gICAgICBjb25zdCBoYXlzdGFjayA9IGAke2l0ZW0ubmFtZX0gJHtpdGVtLnR5cGUgfHwgXCJcIn0gJHtpdGVtLnZlaGljbGVUeXBlIHx8IFwiXCJ9ICR7aXRlbS5zZXJ2aWNlVHlwZSB8fCBcIlwifWAudG9Mb3dlckNhc2UoKTtcclxuICAgICAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiYmlrZVwiKSByZXR1cm4gaGF5c3RhY2suaW5jbHVkZXMoXCJiaWtlXCIpICYmICFoYXlzdGFjay5pbmNsdWRlcyhcInBhcmNlbFwiKTtcclxuICAgICAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiYXV0b1wiKSByZXR1cm4gaGF5c3RhY2suaW5jbHVkZXMoXCJhdXRvXCIpO1xyXG4gICAgICBpZiAobm9ybWFsaXplZCA9PT0gXCJjYWJcIikgcmV0dXJuIGhheXN0YWNrLmluY2x1ZGVzKFwiY2FiXCIpIHx8IGhheXN0YWNrLmluY2x1ZGVzKFwic2VkYW5cIikgfHwgaGF5c3RhY2suaW5jbHVkZXMoXCJjYXJcIik7XHJcbiAgICAgIGlmIChub3JtYWxpemVkID09PSBcInBvb2xcIikgcmV0dXJuIGl0ZW0uaXNDYXJwb29sID09PSB0cnVlIHx8IGhheXN0YWNrLmluY2x1ZGVzKFwicG9vbFwiKSB8fCBoYXlzdGFjay5pbmNsdWRlcyhcImNhcnBvb2xcIik7XHJcbiAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH0pO1xyXG4gICAgZXhwZWN0KGNhdGVnb3J5LCBgTWlzc2luZyB2ZWhpY2xlIGNhdGVnb3J5IGZvciAke2xhYmVsfWApLnRvQmVUcnV0aHkoKTtcclxuICAgIHJldHVybiBjYXRlZ29yeSBhcyBWZWhpY2xlQ2F0ZWdvcnk7XHJcbiAgfVxyXG5cclxuICBhc3luYyB0cnlHZXRDYXRlZ29yeUJ5TGFiZWwobGFiZWw6IFwiYmlrZVwiIHwgXCJhdXRvXCIgfCBcImNhYlwiIHwgXCJwb29sXCIpIHtcclxuICAgIGNvbnN0IGNhdGVnb3JpZXMgPSBhd2FpdCB0aGlzLmdldFZlaGljbGVDYXRlZ29yaWVzKCk7XHJcbiAgICBjb25zdCBub3JtYWxpemVkID0gbGFiZWwudG9Mb3dlckNhc2UoKTtcclxuICAgIHJldHVybiBjYXRlZ29yaWVzLmZpbmQoKGl0ZW0pID0+IHtcclxuICAgICAgY29uc3QgaGF5c3RhY2sgPSBgJHtpdGVtLm5hbWV9ICR7aXRlbS50eXBlIHx8IFwiXCJ9ICR7aXRlbS52ZWhpY2xlVHlwZSB8fCBcIlwifSAke2l0ZW0uc2VydmljZVR5cGUgfHwgXCJcIn1gLnRvTG93ZXJDYXNlKCk7XHJcbiAgICAgIGlmIChub3JtYWxpemVkID09PSBcImJpa2VcIikgcmV0dXJuIGhheXN0YWNrLmluY2x1ZGVzKFwiYmlrZVwiKSAmJiAhaGF5c3RhY2suaW5jbHVkZXMoXCJwYXJjZWxcIik7XHJcbiAgICAgIGlmIChub3JtYWxpemVkID09PSBcImF1dG9cIikgcmV0dXJuIGhheXN0YWNrLmluY2x1ZGVzKFwiYXV0b1wiKTtcclxuICAgICAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiY2FiXCIpIHJldHVybiBoYXlzdGFjay5pbmNsdWRlcyhcImNhYlwiKSB8fCBoYXlzdGFjay5pbmNsdWRlcyhcInNlZGFuXCIpIHx8IGhheXN0YWNrLmluY2x1ZGVzKFwiY2FyXCIpO1xyXG4gICAgICBpZiAobm9ybWFsaXplZCA9PT0gXCJwb29sXCIpIHJldHVybiBpdGVtLmlzQ2FycG9vbCA9PT0gdHJ1ZSB8fCBoYXlzdGFjay5pbmNsdWRlcyhcInBvb2xcIikgfHwgaGF5c3RhY2suaW5jbHVkZXMoXCJjYXJwb29sXCIpO1xyXG4gICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9KSB8fCBudWxsO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgZ2V0TmVhcmJ5RHJpdmVycyh2ZWhpY2xlQ2F0ZWdvcnlJZDogc3RyaW5nKSB7XHJcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuYXBpLmdldChcIi9hcGkvYXBwL25lYXJieS1kcml2ZXJzXCIsIHtcclxuICAgICAgcGFyYW1zOiB7XHJcbiAgICAgICAgbGF0OiBydW50aW1lLnJpZGVQaWNrdXBMYXQsXHJcbiAgICAgICAgbG5nOiBydW50aW1lLnJpZGVQaWNrdXBMbmcsXHJcbiAgICAgICAgcmFkaXVzOiA1LFxyXG4gICAgICAgIHZlaGljbGVDYXRlZ29yeUlkLFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcbiAgICBleHBlY3QocmVzcG9uc2Uub2soKSkudG9CZVRydXRoeSgpO1xyXG4gICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGJvb2tSaWRlKHNlc3Npb246IE1vYmlsZVNlc3Npb24sIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XHJcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMubW9iaWxlUG9zdChzZXNzaW9uLCBcIi9hcGkvYXBwL2N1c3RvbWVyL2Jvb2stcmlkZVwiLCBwYXlsb2FkKTtcclxuICAgIGlmICghcmVzcG9uc2Uub2soKSkge1xyXG4gICAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZFJlc3BvbnNlQm9keShyZXNwb25zZSk7XHJcbiAgICAgIHRocm93IG5ldyBFcnJvcihgYm9va1JpZGUgZmFpbGVkIHdpdGggc3RhdHVzICR7cmVzcG9uc2Uuc3RhdHVzKCl9OiAke0pTT04uc3RyaW5naWZ5KGJvZHkpfWApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGdldEN1c3RvbWVyQWN0aXZlVHJpcChzZXNzaW9uOiBNb2JpbGVTZXNzaW9uKSB7XHJcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMubW9iaWxlR2V0KHNlc3Npb24sIFwiL2FwaS9hcHAvY3VzdG9tZXIvYWN0aXZlLXRyaXBcIik7XHJcbiAgICBleHBlY3QocmVzcG9uc2Uub2soKSkudG9CZVRydXRoeSgpO1xyXG4gICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGJlc3RFZmZvcnRDYW5jZWxBY3RpdmVUcmlwKHNlc3Npb246IE1vYmlsZVNlc3Npb24sIHJlYXNvbjogc3RyaW5nKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBib2R5ID0gYXdhaXQgdGhpcy5nZXRDdXN0b21lckFjdGl2ZVRyaXAoc2Vzc2lvbik7XHJcbiAgICAgIGNvbnN0IHRyaXAgPSBib2R5Py50cmlwIHx8IGJvZHk/LmFjdGl2ZVRyaXAgfHwgYm9keT8uZGF0YSB8fCBudWxsO1xyXG4gICAgICBjb25zdCB0cmlwSWQgPSB0cmlwPy5pZCB8fCBib2R5Py50cmlwSWQgfHwgbnVsbDtcclxuICAgICAgY29uc3Qgc3RhdHVzID0gdHJpcD8uY3VycmVudFN0YXR1cyB8fCB0cmlwPy5zdGF0dXMgfHwgYm9keT8uc3RhdHVzIHx8IG51bGw7XHJcbiAgICAgIGlmICghdHJpcElkIHx8ICFzdGF0dXMpIHJldHVybjtcclxuICAgICAgaWYgKFtcImNvbXBsZXRlZFwiLCBcImNhbmNlbGxlZFwiLCBcIm9uX3RoZV93YXlcIiwgXCJwYXltZW50X3BlbmRpbmdcIl0uaW5jbHVkZXMoU3RyaW5nKHN0YXR1cykpKSByZXR1cm47XHJcbiAgICAgIGF3YWl0IHRoaXMuY2FuY2VsQ3VzdG9tZXJUcmlwKHNlc3Npb24sIHRyaXBJZCwgcmVhc29uKTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAvLyBDbGVhbnVwIHNob3VsZCBuZXZlciBicmVhayB0aGUgc3VpdGUuXHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBhc3luYyBnZXREcml2ZXJJbmNvbWluZ1RyaXAoc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbikge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLm1vYmlsZUdldChzZXNzaW9uLCBcIi9hcGkvYXBwL2RyaXZlci9pbmNvbWluZy10cmlwXCIpO1xyXG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcclxuICAgIHJldHVybiByZXNwb25zZS5qc29uKCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBnZXREcml2ZXJBY3RpdmVUcmlwKHNlc3Npb246IE1vYmlsZVNlc3Npb24pIHtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5tb2JpbGVHZXQoc2Vzc2lvbiwgXCIvYXBpL2FwcC9kcml2ZXIvYWN0aXZlLXRyaXBcIik7XHJcbiAgICBleHBlY3QocmVzcG9uc2Uub2soKSkudG9CZVRydXRoeSgpO1xyXG4gICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGFjY2VwdFRyaXAoc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgdHJpcElkOiBzdHJpbmcpIHtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5tb2JpbGVQb3N0KHNlc3Npb24sIFwiL2FwaS9hcHAvZHJpdmVyL2FjY2VwdC10cmlwXCIsIHsgdHJpcElkIH0pO1xyXG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcclxuICAgIHJldHVybiByZXNwb25zZS5qc29uKCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBtYXJrQXJyaXZlZChzZXNzaW9uOiBNb2JpbGVTZXNzaW9uLCB0cmlwSWQ6IHN0cmluZykge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLm1vYmlsZVBvc3Qoc2Vzc2lvbiwgXCIvYXBpL2FwcC9kcml2ZXIvYXJyaXZlZFwiLCB7IHRyaXBJZCB9KTtcclxuICAgIGV4cGVjdChyZXNwb25zZS5vaygpKS50b0JlVHJ1dGh5KCk7XHJcbiAgICByZXR1cm4gcmVzcG9uc2UuanNvbigpO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgc3RhcnRUcmlwKHNlc3Npb246IE1vYmlsZVNlc3Npb24sIHRyaXBJZDogc3RyaW5nLCBwaWNrdXBPdHA6IHN0cmluZykge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLm1vYmlsZVBvc3Qoc2Vzc2lvbiwgXCIvYXBpL2FwcC9kcml2ZXIvc3RhcnQtdHJpcFwiLCB7IHRyaXBJZCwgcGlja3VwT3RwIH0pO1xyXG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcclxuICAgIHJldHVybiByZXNwb25zZS5qc29uKCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBjb21wbGV0ZVRyaXAoc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgdHJpcElkOiBzdHJpbmcsIGFjdHVhbEZhcmU6IG51bWJlcikge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLm1vYmlsZVBvc3Qoc2Vzc2lvbiwgXCIvYXBpL2FwcC9kcml2ZXIvY29tcGxldGUtdHJpcFwiLCB7XHJcbiAgICAgIHRyaXBJZCxcclxuICAgICAgYWN0dWFsRmFyZSxcclxuICAgICAgYWN0dWFsRGlzdGFuY2U6IDguNSxcclxuICAgICAgdGlwczogMCxcclxuICAgIH0pO1xyXG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcclxuICAgIHJldHVybiByZXNwb25zZS5qc29uKCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBjYW5jZWxDdXN0b21lclRyaXAoc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgdHJpcElkOiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nKSB7XHJcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMubW9iaWxlUG9zdChzZXNzaW9uLCBcIi9hcGkvYXBwL2N1c3RvbWVyL2NhbmNlbC10cmlwXCIsIHsgdHJpcElkLCByZWFzb24gfSk7XHJcbiAgICBleHBlY3QocmVzcG9uc2Uub2soKSkudG9CZVRydXRoeSgpO1xyXG4gICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGdldEN1c3RvbWVyVHJpcFJlY2VpcHQoc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgdHJpcElkOiBzdHJpbmcpIHtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5tb2JpbGVHZXQoc2Vzc2lvbiwgYC9hcGkvYXBwL2N1c3RvbWVyL3RyaXAtcmVjZWlwdC8ke3RyaXBJZH1gKTtcclxuICAgIGV4cGVjdChyZXNwb25zZS5vaygpKS50b0JlVHJ1dGh5KCk7XHJcbiAgICByZXR1cm4gcmVzcG9uc2UuanNvbigpO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgZ2V0RHJpdmVyVHJpcFJlY2VpcHQoc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgdHJpcElkOiBzdHJpbmcpIHtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5tb2JpbGVHZXQoc2Vzc2lvbiwgYC9hcGkvYXBwL2RyaXZlci90cmlwLXJlY2VpcHQvJHt0cmlwSWR9YCk7XHJcbiAgICBleHBlY3QocmVzcG9uc2Uub2soKSkudG9CZVRydXRoeSgpO1xyXG4gICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGdldEN1c3RvbWVyV2FsbGV0KHNlc3Npb246IE1vYmlsZVNlc3Npb24pIHtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5tb2JpbGVHZXQoc2Vzc2lvbiwgXCIvYXBpL2FwcC9jdXN0b21lci93YWxsZXRcIik7XHJcbiAgICBleHBlY3QocmVzcG9uc2Uub2soKSkudG9CZVRydXRoeSgpO1xyXG4gICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGNyZWF0ZVdhbGxldE9yZGVyKHNlc3Npb246IE1vYmlsZVNlc3Npb24sIGFtb3VudDogbnVtYmVyKSB7XHJcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMubW9iaWxlUG9zdChzZXNzaW9uLCBcIi9hcGkvYXBwL2N1c3RvbWVyL3dhbGxldC9jcmVhdGUtb3JkZXJcIiwgeyBhbW91bnQgfSk7XHJcbiAgICBleHBlY3QocmVzcG9uc2Uub2soKSkudG9CZVRydXRoeSgpO1xyXG4gICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIGNyZWF0ZVJpZGVQYXltZW50T3JkZXIoc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgYW1vdW50OiBudW1iZXIsIHRyaXBJZDogc3RyaW5nKSB7XHJcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMubW9iaWxlUG9zdChzZXNzaW9uLCBcIi9hcGkvYXBwL2N1c3RvbWVyL3JpZGUvY3JlYXRlLW9yZGVyXCIsIHsgYW1vdW50LCB0cmlwSWQgfSk7XHJcbiAgICBleHBlY3QocmVzcG9uc2Uub2soKSkudG9CZVRydXRoeSgpO1xyXG4gICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIHZlcmlmeVJpZGVQYXltZW50SW52YWxpZChzZXNzaW9uOiBNb2JpbGVTZXNzaW9uLCBvcmRlcklkOiBzdHJpbmcpIHtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5tb2JpbGVQb3N0KHNlc3Npb24sIFwiL2FwaS9hcHAvY3VzdG9tZXIvcmlkZS92ZXJpZnktcGF5bWVudFwiLCB7XHJcbiAgICAgICAgcmF6b3JwYXlPcmRlcklkOiBvcmRlcklkLFxyXG4gICAgICAgIHJhem9ycGF5UGF5bWVudElkOiBgcGF5X2ludmFsaWRfJHtEYXRlLm5vdygpfWAsXHJcbiAgICAgICAgcmF6b3JwYXlTaWduYXR1cmU6IFwiaW52YWxpZF9zaWduYXR1cmVcIixcclxuICAgIH0pO1xyXG4gICAgZXhwZWN0KHJlc3BvbnNlLnN0YXR1cygpKS50b0JlKDQwMCk7XHJcbiAgICByZXR1cm4gcmVzcG9uc2UuanNvbigpO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgcXVvdGVQYXJjZWwoc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5tb2JpbGVQb3N0KHNlc3Npb24sIFwiL2FwaS9hcHAvcGFyY2VsL3F1b3RlXCIsIHBheWxvYWQpO1xyXG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcclxuICAgIHJldHVybiByZXNwb25zZS5qc29uKCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBib29rUGFyY2VsKHNlc3Npb246IE1vYmlsZVNlc3Npb24sIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XHJcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMubW9iaWxlUG9zdChzZXNzaW9uLCBcIi9hcGkvYXBwL3BhcmNlbC9ib29rXCIsIHBheWxvYWQpO1xyXG4gICAgaWYgKCFyZXNwb25zZS5vaygpKSB7XHJcbiAgICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkUmVzcG9uc2VCb2R5KHJlc3BvbnNlKTtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBib29rUGFyY2VsIGZhaWxlZCB3aXRoIHN0YXR1cyAke3Jlc3BvbnNlLnN0YXR1cygpfTogJHtKU09OLnN0cmluZ2lmeShib2R5KX1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXNwb25zZS5qc29uKCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBjYW5jZWxQYXJjZWwoc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgb3JkZXJJZDogc3RyaW5nLCByZWFzb246IHN0cmluZykge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLm1vYmlsZVBvc3Qoc2Vzc2lvbiwgYC9hcGkvYXBwL3BhcmNlbC8ke29yZGVySWR9L2NhbmNlbGAsIHsgcmVhc29uIH0pO1xyXG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcclxuICAgIHJldHVybiByZXNwb25zZS5qc29uKCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBjcmVhdGVPdXRzdGF0aW9uUmlkZShzZXNzaW9uOiBNb2JpbGVTZXNzaW9uLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLm1vYmlsZVBvc3Qoc2Vzc2lvbiwgXCIvYXBpL2FwcC9kcml2ZXIvb3V0c3RhdGlvbi1wb29sL3JpZGVzXCIsIHBheWxvYWQpO1xyXG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcclxuICAgIHJldHVybiByZXNwb25zZS5qc29uKCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBzZWFyY2hPdXRzdGF0aW9uUmlkZXMoc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgZnJvbUNpdHk6IHN0cmluZywgdG9DaXR5OiBzdHJpbmcsIGRhdGU/OiBzdHJpbmcpIHtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5tb2JpbGVHZXQoc2Vzc2lvbiwgXCIvYXBpL2FwcC9jdXN0b21lci9vdXRzdGF0aW9uLXBvb2wvc2VhcmNoXCIsIHsgZnJvbUNpdHksIHRvQ2l0eSwgZGF0ZSB9KTtcclxuICAgIGV4cGVjdChyZXNwb25zZS5vaygpKS50b0JlVHJ1dGh5KCk7XHJcbiAgICByZXR1cm4gcmVzcG9uc2UuanNvbigpO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgYm9va091dHN0YXRpb25SaWRlKHNlc3Npb246IE1vYmlsZVNlc3Npb24sIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XHJcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMubW9iaWxlUG9zdChzZXNzaW9uLCBcIi9hcGkvYXBwL2N1c3RvbWVyL291dHN0YXRpb24tcG9vbC9ib29rXCIsIHBheWxvYWQpO1xyXG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcclxuICAgIHJldHVybiByZXNwb25zZS5qc29uKCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBkZWFjdGl2YXRlT3V0c3RhdGlvblJpZGUoc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgcmlkZUlkOiBzdHJpbmcsIG5vdGU6IHN0cmluZykge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLm1vYmlsZVBhdGNoKHNlc3Npb24sIGAvYXBpL2FwcC9kcml2ZXIvb3V0c3RhdGlvbi1wb29sL3JpZGVzLyR7cmlkZUlkfWAsIHtcclxuICAgICAgaXNBY3RpdmU6IGZhbHNlLFxyXG4gICAgICBzdGF0dXM6IFwiY2FuY2VsbGVkXCIsXHJcbiAgICAgIG5vdGUsXHJcbiAgICB9KTtcclxuICAgIGV4cGVjdChyZXNwb25zZS5vaygpKS50b0JlVHJ1dGh5KCk7XHJcbiAgICByZXR1cm4gcmVzcG9uc2UuanNvbigpO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgZ2V0QWRtaW5PdXRzdGF0aW9uUmlkZXModG9rZW46IHN0cmluZykge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSB0b2tlblxyXG4gICAgICA/IGF3YWl0IHRoaXMuYXBpLmdldChcIi9hcGkvYWRtaW4vb3V0c3RhdGlvbi1wb29sL3JpZGVzXCIsIHsgaGVhZGVyczogYXV0aEhlYWRlcnModG9rZW4pIH0pXHJcbiAgICAgIDogYXdhaXQgdGhpcy5hZG1pbkdldChcIi9hcGkvYWRtaW4vb3V0c3RhdGlvbi1wb29sL3JpZGVzXCIpO1xyXG4gICAgaWYgKHJlc3BvbnNlLnN0YXR1cygpID09PSA0MDEpIHtcclxuICAgICAgY29uc3QgcmV0cnkgPSBhd2FpdCB0aGlzLmFkbWluR2V0KFwiL2FwaS9hZG1pbi9vdXRzdGF0aW9uLXBvb2wvcmlkZXNcIik7XHJcbiAgICAgIGV4cGVjdChyZXRyeS5vaygpKS50b0JlVHJ1dGh5KCk7XHJcbiAgICAgIHJldHVybiByZXRyeS5qc29uKCk7XHJcbiAgICB9XHJcbiAgICBleHBlY3QocmVzcG9uc2Uub2soKSkudG9CZVRydXRoeSgpO1xyXG4gICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIHRyaWdnZXJTb3Moc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5tb2JpbGVQb3N0KHNlc3Npb24sIFwiL2FwaS9hcHAvc29zXCIsIHBheWxvYWQpO1xyXG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcclxuICAgIHJldHVybiByZXNwb25zZS5qc29uKCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyB0cmlnZ2VyQWlTb3Moc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbiwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5tb2JpbGVQb3N0KHNlc3Npb24sIFwiL2FwaS9hcHAvYWkvc29zXCIsIHBheWxvYWQpO1xyXG4gICAgZXhwZWN0KHJlc3BvbnNlLm9rKCkpLnRvQmVUcnV0aHkoKTtcclxuICAgIHJldHVybiByZXNwb25zZS5qc29uKCk7XHJcbiAgfVxyXG5cclxuICBhc3luYyBnZXRDdXN0b21lclN1cHBvcnRDaGF0KHNlc3Npb246IE1vYmlsZVNlc3Npb24pIHtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5tb2JpbGVHZXQoc2Vzc2lvbiwgXCIvYXBpL2FwcC9jdXN0b21lci9zdXBwb3J0LWNoYXRcIik7XHJcbiAgICBleHBlY3QocmVzcG9uc2Uub2soKSkudG9CZVRydXRoeSgpO1xyXG4gICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIHNlbmRDdXN0b21lclN1cHBvcnRDaGF0KHNlc3Npb246IE1vYmlsZVNlc3Npb24sIG1lc3NhZ2U6IHN0cmluZykge1xyXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLm1vYmlsZVBvc3Qoc2Vzc2lvbiwgXCIvYXBpL2FwcC9jdXN0b21lci9zdXBwb3J0LWNoYXQvc2VuZFwiLCB7IG1lc3NhZ2UgfSk7XHJcbiAgICBleHBlY3QocmVzcG9uc2Uub2soKSkudG9CZVRydXRoeSgpO1xyXG4gICAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcclxuICB9XHJcblxyXG4gIGFzeW5jIHZhbGlkYXRlU2hhcmVkU3RhdGUoc3RhdGU6IFNoYXJlZExpdmVTdWl0ZVN0YXRlKSB7XHJcbiAgICBjb25zdCBjaGVja3MgPSBhd2FpdCBQcm9taXNlLmFsbChbXHJcbiAgICAgIHRoaXMuYXBpLmdldChcIi9hcGkvYWRtaW4vc3lzdGVtLWhlYWx0aFwiLCB7XHJcbiAgICAgICAgaGVhZGVyczogYXV0aEhlYWRlcnMoc3RhdGUuYWRtaW4uc2Vzc2lvbi50b2tlbiksXHJcbiAgICAgIH0pLFxyXG4gICAgICB0aGlzLmFwaS5nZXQoXCIvYXBpL2FwcC9jdXN0b21lci9hY3RpdmUtdHJpcFwiLCB7XHJcbiAgICAgICAgaGVhZGVyczogYXV0aEhlYWRlcnMoc3RhdGUuYWN0b3JzLmN1c3RvbWVyUHJpbWFyeS5zZXNzaW9uLnRva2VuKSxcclxuICAgICAgfSksXHJcbiAgICAgIHRoaXMuYXBpLmdldChcIi9hcGkvYXBwL2N1c3RvbWVyL2FjdGl2ZS10cmlwXCIsIHtcclxuICAgICAgICBoZWFkZXJzOiBhdXRoSGVhZGVycyhzdGF0ZS5hY3RvcnMuY3VzdG9tZXJTZWNvbmRhcnk/LnNlc3Npb24udG9rZW4gfHwgc3RhdGUuYWN0b3JzLmN1c3RvbWVyUHJpbWFyeS5zZXNzaW9uLnRva2VuKSxcclxuICAgICAgfSksXHJcbiAgICAgIHRoaXMuYXBpLmdldChcIi9hcGkvYXBwL2RyaXZlci9hY3RpdmUtdHJpcFwiLCB7XHJcbiAgICAgICAgaGVhZGVyczogYXV0aEhlYWRlcnMoc3RhdGUuYWN0b3JzLmRyaXZlckJpa2VQcmltYXJ5LnNlc3Npb24udG9rZW4pLFxyXG4gICAgICB9KSxcclxuICAgICAgdGhpcy5hcGkuZ2V0KFwiL2FwaS9hcHAvZHJpdmVyL2FjdGl2ZS10cmlwXCIsIHtcclxuICAgICAgICBoZWFkZXJzOiBhdXRoSGVhZGVycyhzdGF0ZS5hY3RvcnMuZHJpdmVyQXV0b1ByaW1hcnk/LnNlc3Npb24udG9rZW4gfHwgc3RhdGUuYWN0b3JzLmRyaXZlckJpa2VQcmltYXJ5LnNlc3Npb24udG9rZW4pLFxyXG4gICAgICB9KSxcclxuICAgICAgdGhpcy5hcGkuZ2V0KFwiL2FwaS9hcHAvZHJpdmVyL2FjdGl2ZS10cmlwXCIsIHtcclxuICAgICAgICBoZWFkZXJzOiBhdXRoSGVhZGVycyhzdGF0ZS5hY3RvcnMuZHJpdmVyQ2FiUHJpbWFyeS5zZXNzaW9uLnRva2VuKSxcclxuICAgICAgfSksXHJcbiAgICBdKTtcclxuICAgIHJldHVybiBjaGVja3MuZXZlcnkoKHJlc3BvbnNlKSA9PiByZXNwb25zZS5vaygpKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgbW9iaWxlR2V0KFxyXG4gICAgc2Vzc2lvbjogTW9iaWxlU2Vzc2lvbixcclxuICAgIHBhdGg6IHN0cmluZyxcclxuICAgIHBhcmFtcz86IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IG51bWJlciB8IHVuZGVmaW5lZD4sXHJcbiAgKSB7XHJcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0V2l0aE1vYmlsZUF1dGgoc2Vzc2lvbiwgKHRva2VuKSA9PiB0aGlzLmFwaS5nZXQocGF0aCwge1xyXG4gICAgICBwYXJhbXMsXHJcbiAgICAgIGhlYWRlcnM6IGF1dGhIZWFkZXJzKHRva2VuKSxcclxuICAgIH0pKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgbW9iaWxlUG9zdChzZXNzaW9uOiBNb2JpbGVTZXNzaW9uLCBwYXRoOiBzdHJpbmcsIGRhdGE/OiB1bmtub3duKSB7XHJcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0V2l0aE1vYmlsZUF1dGgoc2Vzc2lvbiwgKHRva2VuKSA9PiB0aGlzLmFwaS5wb3N0KHBhdGgsIHtcclxuICAgICAgZGF0YSxcclxuICAgICAgaGVhZGVyczogYXV0aEhlYWRlcnModG9rZW4pLFxyXG4gICAgfSkpO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBhc3luYyBtb2JpbGVQYXRjaChzZXNzaW9uOiBNb2JpbGVTZXNzaW9uLCBwYXRoOiBzdHJpbmcsIGRhdGE/OiB1bmtub3duKSB7XHJcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0V2l0aE1vYmlsZUF1dGgoc2Vzc2lvbiwgKHRva2VuKSA9PiB0aGlzLmFwaS5wYXRjaChwYXRoLCB7XHJcbiAgICAgIGRhdGEsXHJcbiAgICAgIGhlYWRlcnM6IGF1dGhIZWFkZXJzKHRva2VuKSxcclxuICAgIH0pKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgcmVxdWVzdFdpdGhNb2JpbGVBdXRoKFxuICAgIHNlc3Npb246IE1vYmlsZVNlc3Npb24sXHJcbiAgICBmYWN0b3J5OiAodG9rZW46IHN0cmluZykgPT4gUHJvbWlzZTxhbnk+LFxyXG4gICkge1xyXG4gICAgbGV0IHJlc3BvbnNlID0gYXdhaXQgZmFjdG9yeShzZXNzaW9uLnRva2VuKTtcclxuICAgIGlmIChyZXNwb25zZS5zdGF0dXMoKSAhPT0gNDAxKSB7XHJcbiAgICAgIHJldHVybiByZXNwb25zZTtcclxuICAgIH1cclxuXHJcbiAgICBhd2FpdCB0aGlzLnJlZnJlc2hNb2JpbGVTZXNzaW9uKHNlc3Npb24pO1xyXG4gICAgcmV0dXJuIGZhY3Rvcnkoc2Vzc2lvbi50b2tlbik7XHJcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVmcmVzaE1vYmlsZUFjY2Vzc1Rva2VuKHNlc3Npb246IE1vYmlsZVNlc3Npb24pOiBQcm9taXNlPE1vYmlsZVNlc3Npb24gfCBudWxsPiB7XG4gICAgY29uc3QgcmVmcmVzaFRva2VuID0gU3RyaW5nKHNlc3Npb24ucmVmcmVzaFRva2VuIHx8IFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCBwYXlsb2FkID0gZGVjb2RlQWNjZXNzVG9rZW4oc2Vzc2lvbi50b2tlbik7XG4gICAgY29uc3QgZGV2aWNlSWQgPSBTdHJpbmcocGF5bG9hZD8uZGV2aWNlSWQgfHwgXCJcIikudHJpbSgpO1xuICAgIGlmICghcmVmcmVzaFRva2VuIHx8ICFkZXZpY2VJZCkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLmFwaS5wb3N0KFwiL2FwaS9hcHAvYXV0aC9yZWZyZXNoXCIsIHtcbiAgICAgIGRhdGE6IHtcbiAgICAgICAgcmVmcmVzaFRva2VuLFxuICAgICAgICBkZXZpY2VJZCxcbiAgICAgIH0sXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgIFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgICBcIngtZGV2aWNlLWlkXCI6IGRldmljZUlkLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGlmICghcmVzcG9uc2Uub2soKSkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKSBhcyB7IHRva2VuPzogc3RyaW5nOyByZWZyZXNoVG9rZW4/OiBzdHJpbmcgfTtcbiAgICBpZiAoIWJvZHk/LnRva2VuKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgLi4uc2Vzc2lvbixcbiAgICAgIHRva2VuOiBib2R5LnRva2VuLFxuICAgICAgcmVmcmVzaFRva2VuOiBib2R5LnJlZnJlc2hUb2tlbiB8fCByZWZyZXNoVG9rZW4sXG4gICAgfTtcbiAgfVxuXHJcbiAgcHJpdmF0ZSBhc3luYyBib290c3RyYXBRYUFjY291bnRzKCkge1xyXG4gICAgY29uc3QgYWRtaW4gPSBhd2FpdCB0aGlzLmxvZ2luQWRtaW4oKTtcclxuICAgIGNvbnN0IGJpa2VDYXRlZ29yeSA9IGF3YWl0IHRoaXMuZ2V0Q2F0ZWdvcnlCeUxhYmVsKFwiYmlrZVwiKTtcclxuICAgIGNvbnN0IGF1dG9DYXRlZ29yeSA9IGF3YWl0IHRoaXMuZ2V0Q2F0ZWdvcnlCeUxhYmVsKFwiYXV0b1wiKTtcclxuICAgIGNvbnN0IGNhYkNhdGVnb3J5ID0gYXdhaXQgdGhpcy5nZXRDYXRlZ29yeUJ5TGFiZWwoXCJjYWJcIik7XHJcblxyXG4gICAgY29uc3QgZW5zdXJlQ3VzdG9tZXIgPSBhc3luYyAocGhvbmU6IHN0cmluZywgZnVsbE5hbWU6IHN0cmluZykgPT4ge1xyXG4gICAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHRoaXMuYXBpLnBvc3QoXCIvYXBpL2FwcC9sb2dpbi1wYXNzd29yZFwiLCB7XHJcbiAgICAgICAgZGF0YToge1xyXG4gICAgICAgICAgcGhvbmUsXHJcbiAgICAgICAgICBwYXNzd29yZDogcnVudGltZS5saXZlTW9iaWxlUGFzc3dvcmQsXHJcbiAgICAgICAgICB1c2VyVHlwZTogXCJjdXN0b21lclwiLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0pO1xyXG4gICAgICBpZiAoZXhpc3Rpbmcub2soKSkge1xyXG4gICAgICAgIHJldHVybiBleGlzdGluZy5qc29uKCkgYXMgUHJvbWlzZTxNb2JpbGVTZXNzaW9uPjtcclxuICAgICAgfVxyXG4gICAgICBpZiAoZXhpc3Rpbmcuc3RhdHVzKCkgPT09IDQyOSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQ3VzdG9tZXIgYm9vdHN0cmFwIHJhdGUtbGltaXRlZCBmb3IgJHtwaG9uZX0uIFdhaXQgZm9yIHRoZSBwcm9kdWN0aW9uIGxvZ2luIHdpbmRvdyB0byByZXNldCBiZWZvcmUgcmV0cnlpbmcuYCk7XHJcbiAgICAgIH1cclxuICAgICAgaWYgKGV4aXN0aW5nLnN0YXR1cygpICE9PSA0MDQpIHtcclxuICAgICAgICBleHBlY3QoZXhpc3Rpbmcub2soKSwgYFVuZXhwZWN0ZWQgY3VzdG9tZXIgYm9vdHN0cmFwIHN0YXR1cyAke2V4aXN0aW5nLnN0YXR1cygpfSBmb3IgJHtwaG9uZX1gKS50b0JlVHJ1dGh5KCk7XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuIHRoaXMucmVnaXN0ZXJNb2JpbGUoe1xyXG4gICAgICAgIHBob25lLFxyXG4gICAgICAgIHBhc3N3b3JkOiBydW50aW1lLmxpdmVNb2JpbGVQYXNzd29yZCxcclxuICAgICAgICBmdWxsTmFtZSxcclxuICAgICAgICB1c2VyVHlwZTogXCJjdXN0b21lclwiLFxyXG4gICAgICB9KTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgZW5zdXJlRHJpdmVyID0gYXN5bmMgKHBhcmFtczoge1xyXG4gICAgICBwaG9uZTogc3RyaW5nO1xyXG4gICAgICBmdWxsTmFtZTogc3RyaW5nO1xyXG4gICAgICB2ZWhpY2xlQ2F0ZWdvcnlJZDogc3RyaW5nO1xyXG4gICAgICB2ZWhpY2xlTnVtYmVyOiBzdHJpbmc7XHJcbiAgICAgIHZlaGljbGVNb2RlbDogc3RyaW5nO1xyXG4gICAgfSkgPT4ge1xyXG4gICAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHRoaXMuYXBpLnBvc3QoXCIvYXBpL2FwcC9sb2dpbi1wYXNzd29yZFwiLCB7XHJcbiAgICAgICAgZGF0YToge1xyXG4gICAgICAgICAgcGhvbmU6IHBhcmFtcy5waG9uZSxcclxuICAgICAgICAgIHBhc3N3b3JkOiBydW50aW1lLmxpdmVNb2JpbGVQYXNzd29yZCxcclxuICAgICAgICAgIHVzZXJUeXBlOiBcImRyaXZlclwiLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0pO1xyXG5cclxuICAgICAgbGV0IHNlc3Npb246IE1vYmlsZVNlc3Npb247XHJcbiAgICAgIGlmIChleGlzdGluZy5vaygpKSB7XHJcbiAgICAgICAgc2Vzc2lvbiA9IGF3YWl0IGV4aXN0aW5nLmpzb24oKSBhcyBNb2JpbGVTZXNzaW9uO1xyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIGlmIChleGlzdGluZy5zdGF0dXMoKSA9PT0gNDI5KSB7XHJcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYERyaXZlciBib290c3RyYXAgcmF0ZS1saW1pdGVkIGZvciAke3BhcmFtcy5waG9uZX0uIFdhaXQgZm9yIHRoZSBwcm9kdWN0aW9uIGxvZ2luIHdpbmRvdyB0byByZXNldCBiZWZvcmUgcmV0cnlpbmcuYCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChleGlzdGluZy5zdGF0dXMoKSAhPT0gNDA0KSB7XHJcbiAgICAgICAgICBleHBlY3QoZXhpc3Rpbmcub2soKSwgYFVuZXhwZWN0ZWQgZHJpdmVyIGJvb3RzdHJhcCBzdGF0dXMgJHtleGlzdGluZy5zdGF0dXMoKX0gZm9yICR7cGFyYW1zLnBob25lfWApLnRvQmVUcnV0aHkoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2Vzc2lvbiA9IGF3YWl0IHRoaXMucmVnaXN0ZXJNb2JpbGUoe1xyXG4gICAgICAgICAgcGhvbmU6IHBhcmFtcy5waG9uZSxcclxuICAgICAgICAgIHBhc3N3b3JkOiBydW50aW1lLmxpdmVNb2JpbGVQYXNzd29yZCxcclxuICAgICAgICAgIGZ1bGxOYW1lOiBwYXJhbXMuZnVsbE5hbWUsXHJcbiAgICAgICAgICB1c2VyVHlwZTogXCJkcml2ZXJcIixcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG5cclxuICAgICAgYXdhaXQgdGhpcy51cGRhdGVEcml2ZXJQcm9maWxlKHNlc3Npb24sIHtcclxuICAgICAgICBmdWxsTmFtZTogcGFyYW1zLmZ1bGxOYW1lLFxyXG4gICAgICAgIHZlaGljbGVOdW1iZXI6IHBhcmFtcy52ZWhpY2xlTnVtYmVyLFxyXG4gICAgICAgIHZlaGljbGVNb2RlbDogcGFyYW1zLnZlaGljbGVNb2RlbCxcclxuICAgICAgICB2ZWhpY2xlQ2F0ZWdvcnlJZDogcGFyYW1zLnZlaGljbGVDYXRlZ29yeUlkLFxyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgdGhpcy5hcHByb3ZlRHJpdmVyKGFkbWluLnRva2VuLCBzZXNzaW9uLnVzZXIuaWQsIGBQbGF5d3JpZ2h0IFFBIGJvb3RzdHJhcCBmb3IgJHtwYXJhbXMucGhvbmV9YCk7XHJcbiAgICAgIHJldHVybiBzZXNzaW9uO1xyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBjdXN0b21lcnMgPSBhd2FpdCBQcm9taXNlLmFsbChbXHJcbiAgICAgIGVuc3VyZUN1c3RvbWVyKHJ1bnRpbWUubGl2ZUN1c3RvbWVyUGhvbmUsIFwiSkFHTyBRQSBDdXN0b21lciAxXCIpLFxyXG4gICAgICBlbnN1cmVDdXN0b21lcihydW50aW1lLmxpdmVDdXN0b21lclBob25lMiwgXCJKQUdPIFFBIEN1c3RvbWVyIDJcIiksXHJcbiAgICBdKTtcclxuXHJcbiAgICBjb25zdCBkcml2ZXJzID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xyXG4gICAgICBlbnN1cmVEcml2ZXIoe1xyXG4gICAgICAgIHBob25lOiBydW50aW1lLmxpdmVEcml2ZXJCaWtlUGhvbmUsXHJcbiAgICAgICAgZnVsbE5hbWU6IFwiSkFHTyBRQSBEcml2ZXIgQmlrZSAxXCIsXHJcbiAgICAgICAgdmVoaWNsZUNhdGVnb3J5SWQ6IGJpa2VDYXRlZ29yeS5pZCxcclxuICAgICAgICB2ZWhpY2xlTnVtYmVyOiBcIlRTMDFRQTEwMDFcIixcclxuICAgICAgICB2ZWhpY2xlTW9kZWw6IFwiSGVybyBTcGxlbmRvciBRQVwiLFxyXG4gICAgICB9KSxcclxuICAgICAgZW5zdXJlRHJpdmVyKHtcclxuICAgICAgICBwaG9uZTogXCI5MTAwMDAwMDAyXCIsXHJcbiAgICAgICAgZnVsbE5hbWU6IFwiSkFHTyBRQSBEcml2ZXIgQmlrZSAyXCIsXHJcbiAgICAgICAgdmVoaWNsZUNhdGVnb3J5SWQ6IGJpa2VDYXRlZ29yeS5pZCxcclxuICAgICAgICB2ZWhpY2xlTnVtYmVyOiBcIlRTMDFRQTEwMDJcIixcclxuICAgICAgICB2ZWhpY2xlTW9kZWw6IFwiSG9uZGEgU2hpbmUgUUFcIixcclxuICAgICAgfSksXHJcbiAgICAgIGVuc3VyZURyaXZlcih7XHJcbiAgICAgICAgcGhvbmU6IFwiOTEwMDAwMDAwM1wiLFxyXG4gICAgICAgIGZ1bGxOYW1lOiBcIkpBR08gUUEgRHJpdmVyIEJpa2UgM1wiLFxyXG4gICAgICAgIHZlaGljbGVDYXRlZ29yeUlkOiBiaWtlQ2F0ZWdvcnkuaWQsXHJcbiAgICAgICAgdmVoaWNsZU51bWJlcjogXCJUUzAxUUExMDAzXCIsXHJcbiAgICAgICAgdmVoaWNsZU1vZGVsOiBcIkJhamFqIFB1bHNhciBRQVwiLFxyXG4gICAgICB9KSxcclxuICAgICAgZW5zdXJlRHJpdmVyKHtcclxuICAgICAgICBwaG9uZTogXCI5MTAwMDAwMDA0XCIsXHJcbiAgICAgICAgZnVsbE5hbWU6IFwiSkFHTyBRQSBEcml2ZXIgQmlrZSA0XCIsXHJcbiAgICAgICAgdmVoaWNsZUNhdGVnb3J5SWQ6IGJpa2VDYXRlZ29yeS5pZCxcclxuICAgICAgICB2ZWhpY2xlTnVtYmVyOiBcIlRTMDFRQTEwMDRcIixcclxuICAgICAgICB2ZWhpY2xlTW9kZWw6IFwiVFZTIEFwYWNoZSBRQVwiLFxyXG4gICAgICB9KSxcclxuICAgICAgZW5zdXJlRHJpdmVyKHtcclxuICAgICAgICBwaG9uZTogcnVudGltZS5saXZlRHJpdmVyQXV0b1Bob25lLFxyXG4gICAgICAgIGZ1bGxOYW1lOiBcIkpBR08gUUEgRHJpdmVyIEF1dG8gMVwiLFxyXG4gICAgICAgIHZlaGljbGVDYXRlZ29yeUlkOiBhdXRvQ2F0ZWdvcnkuaWQsXHJcbiAgICAgICAgdmVoaWNsZU51bWJlcjogXCJUUzA5UUE1MDAxXCIsXHJcbiAgICAgICAgdmVoaWNsZU1vZGVsOiBcIkJhamFqIFJFIFFBXCIsXHJcbiAgICAgIH0pLFxyXG4gICAgICBlbnN1cmVEcml2ZXIoe1xyXG4gICAgICAgIHBob25lOiBydW50aW1lLmxpdmVEcml2ZXJDYWJQaG9uZSxcclxuICAgICAgICBmdWxsTmFtZTogXCJKQUdPIFFBIERyaXZlciBDYWIgMVwiLFxyXG4gICAgICAgIHZlaGljbGVDYXRlZ29yeUlkOiBjYWJDYXRlZ29yeS5pZCxcclxuICAgICAgICB2ZWhpY2xlTnVtYmVyOiBcIlRTMDdRQTgwMDFcIixcclxuICAgICAgICB2ZWhpY2xlTW9kZWw6IFwiU3dpZnQgRHppcmUgUUFcIixcclxuICAgICAgfSksXHJcbiAgICBdKTtcclxuXHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBzdWNjZXNzOiB0cnVlLFxyXG4gICAgICBib290c3RyYXBNb2RlOiBcImZhbGxiYWNrXCIgYXMgY29uc3QsXHJcbiAgICAgIGZhbGxiYWNrOiB0cnVlLFxyXG4gICAgICBhZG1pbjogYWRtaW4uYWRtaW4uZW1haWwsXHJcbiAgICAgIGN1c3RvbWVyczogY3VzdG9tZXJzLm1hcCgoY3VzdG9tZXIpID0+IGN1c3RvbWVyLnVzZXIucGhvbmUpLFxyXG4gICAgICBkcml2ZXJzOiBkcml2ZXJzLm1hcCgoZHJpdmVyKSA9PiBkcml2ZXIudXNlci5waG9uZSksXHJcbiAgICB9O1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBnZXRNb2JpbGVDYWNoZUtleShwaG9uZTogc3RyaW5nLCB1c2VyVHlwZTogXCJjdXN0b21lclwiIHwgXCJkcml2ZXJcIikge1xyXG4gICAgcmV0dXJuIGAke3VzZXJUeXBlfToke3Bob25lfWA7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIHJlcXVlc3RXaXRoQmFja29mZjxUPihcclxuICAgIGZhY3Rvcnk6ICgpID0+IFByb21pc2U8VD4sXHJcbiAgICBvcHRpb25zOiB7IHJldHJpZXM6IG51bWJlcjsgYmFja29mZk1zOiBudW1iZXI7IHJldHJ5U3RhdHVzZXM6IG51bWJlcltdIH0sXHJcbiAgKTogUHJvbWlzZTxUPiB7XHJcbiAgICBsZXQgYXR0ZW1wdCA9IDA7XHJcbiAgICBmb3IgKDs7KSB7XHJcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmFjdG9yeSgpO1xyXG4gICAgICBjb25zdCBzdGF0dXMgPSB0aGlzLnJlYWRTdGF0dXMocmVzcG9uc2UpO1xyXG4gICAgICBpZiAoc3RhdHVzID09PSBudWxsIHx8ICFvcHRpb25zLnJldHJ5U3RhdHVzZXMuaW5jbHVkZXMoc3RhdHVzKSB8fCBhdHRlbXB0ID49IG9wdGlvbnMucmV0cmllcykge1xyXG4gICAgICAgIHJldHVybiByZXNwb25zZTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCByZXRyeUFmdGVyTXMgPSB0aGlzLnJlYWRSZXRyeUFmdGVyTXMocmVzcG9uc2UpO1xyXG4gICAgICBjb25zdCBkZWxheU1zID0gcmV0cnlBZnRlck1zID8/IChvcHRpb25zLmJhY2tvZmZNcyAqIChhdHRlbXB0ICsgMSkpO1xyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCBkZWxheU1zKSk7XHJcbiAgICAgIGF0dGVtcHQgKz0gMTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIHByaXZhdGUgcmVhZFN0YXR1cyhyZXNwb25zZTogdW5rbm93bikge1xyXG4gICAgaWYgKCFyZXNwb25zZSB8fCB0eXBlb2YgcmVzcG9uc2UgIT09IFwib2JqZWN0XCIpIHJldHVybiBudWxsO1xyXG4gICAgY29uc3QgY2FuZGlkYXRlID0gcmVzcG9uc2UgYXMgeyBzdGF0dXM/OiB1bmtub3duIH07XHJcbiAgICBpZiAodHlwZW9mIGNhbmRpZGF0ZS5zdGF0dXMgPT09IFwiZnVuY3Rpb25cIikge1xyXG4gICAgICByZXR1cm4gTnVtYmVyKGNhbmRpZGF0ZS5zdGF0dXMoKSk7XHJcbiAgICB9XHJcbiAgICBpZiAodHlwZW9mIGNhbmRpZGF0ZS5zdGF0dXMgPT09IFwibnVtYmVyXCIpIHtcclxuICAgICAgcmV0dXJuIGNhbmRpZGF0ZS5zdGF0dXM7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbnVsbDtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgcmVhZFJldHJ5QWZ0ZXJNcyhyZXNwb25zZTogdW5rbm93bikge1xyXG4gICAgaWYgKCFyZXNwb25zZSB8fCB0eXBlb2YgcmVzcG9uc2UgIT09IFwib2JqZWN0XCIpIHJldHVybiBudWxsO1xyXG4gICAgY29uc3QgY2FuZGlkYXRlID0gcmVzcG9uc2UgYXMgeyBoZWFkZXJzPzogdW5rbm93biB9O1xyXG4gICAgaWYgKHR5cGVvZiBjYW5kaWRhdGUuaGVhZGVycyAhPT0gXCJmdW5jdGlvblwiKSByZXR1cm4gbnVsbDtcclxuICAgIGNvbnN0IGhlYWRlcnMgPSBjYW5kaWRhdGUuaGVhZGVycygpIGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBjb25zdCByZXRyeUFmdGVyID0gaGVhZGVyc1tcInJldHJ5LWFmdGVyXCJdIHx8IGhlYWRlcnNbXCJSZXRyeS1BZnRlclwiXTtcclxuICAgIGlmICghcmV0cnlBZnRlcikgcmV0dXJuIG51bGw7XHJcblxyXG4gICAgY29uc3Qgc2Vjb25kcyA9IE51bWJlcihyZXRyeUFmdGVyKTtcclxuICAgIGlmIChOdW1iZXIuaXNGaW5pdGUoc2Vjb25kcykgJiYgc2Vjb25kcyA+IDApIHtcclxuICAgICAgcmV0dXJuIHNlY29uZHMgKiAxXzAwMDtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBkYXRlTXMgPSBEYXRlLnBhcnNlKHJldHJ5QWZ0ZXIpO1xyXG4gICAgaWYgKE51bWJlci5pc05hTihkYXRlTXMpKSByZXR1cm4gbnVsbDtcclxuICAgIHJldHVybiBNYXRoLm1heCgxXzAwMCwgZGF0ZU1zIC0gRGF0ZS5ub3coKSk7XHJcbiAgfVxyXG59XG5cbmZ1bmN0aW9uIGRlY29kZUFjY2Vzc1Rva2VuKHRva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBBY2Nlc3NUb2tlblBheWxvYWQgfCBudWxsIHtcbiAgaWYgKCF0b2tlbikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBhcnRzID0gdG9rZW4uc3BsaXQoXCIuXCIpO1xuICBpZiAocGFydHMubGVuZ3RoIDwgMikgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UoQnVmZmVyLmZyb20ocGFydHNbMV0sIFwiYmFzZTY0dXJsXCIpLnRvU3RyaW5nKFwidXRmOFwiKSkgYXMgQWNjZXNzVG9rZW5QYXlsb2FkO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxTQUFTQSxNQUFNLEVBQUVDLE9BQU8sUUFBZ0Msa0JBQWtCO0FBQzFFLFNBQVNDLE9BQU8sUUFBUSxXQUFXO0FBRW5DLFNBQVNDLGtCQUFrQixFQUFFQyxzQkFBc0IsUUFBUSxvQkFBb0I7QUFzRC9FLFNBQVNDLFdBQVdBLENBQUNDLEtBQWEsRUFBRTtFQUNsQyxPQUFPO0lBQ0xDLGFBQWEsRUFBRSxVQUFVRCxLQUFLLEVBQUU7SUFDaEMsY0FBYyxFQUFFO0VBQ2xCLENBQUM7QUFDSDtBQUVBLGVBQWVFLGdCQUFnQkEsQ0FBQ0MsUUFBdUUsRUFBRTtFQUN2RyxJQUFJO0lBQ0YsT0FBTyxNQUFNQSxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQzlCLENBQUMsQ0FBQyxNQUFNO0lBQ04sSUFBSTtNQUNGLE9BQU8sTUFBTUQsUUFBUSxDQUFDRSxJQUFJLENBQUMsQ0FBQztJQUM5QixDQUFDLENBQUMsTUFBTTtNQUNOLE9BQU8sSUFBSTtJQUNiO0VBQ0Y7QUFDRjtBQUVBLE9BQU8sTUFBTUMsVUFBVSxDQUFDO0VBQ3RCQyxXQUFXQSxDQUFrQkMsR0FBc0IsRUFBRTtJQUFBLEtBQXhCQSxHQUFzQixHQUF0QkEsR0FBc0I7SUFBQSxLQUMzQ0Msa0JBQWtCLEdBQXdCLElBQUk7SUFBQSxLQUNyQ0Msa0JBQWtCLEdBQUcsSUFBSUMsR0FBRyxDQUF3QixDQUFDO0VBRmhCO0VBSXRELGFBQWFDLE1BQU1BLENBQUEsRUFBRztJQUNwQixNQUFNSixHQUFHLEdBQUcsTUFBTWIsT0FBTyxDQUFDa0IsVUFBVSxDQUFDO01BQ25DQyxPQUFPLEVBQUVsQixPQUFPLENBQUNtQixVQUFVO01BQzNCQyxnQkFBZ0IsRUFBRTtRQUNoQixjQUFjLEVBQUUsa0JBQWtCO1FBQ2xDLHlCQUF5QixFQUFFO01BQzdCLENBQUM7TUFDREMsaUJBQWlCLEVBQUU7SUFDckIsQ0FBQyxDQUFDO0lBQ0YsT0FBTyxJQUFJWCxVQUFVLENBQUNFLEdBQUcsQ0FBQztFQUM1QjtFQUVBLE1BQU1VLE9BQU9BLENBQUEsRUFBRztJQUNkLE1BQU0sSUFBSSxDQUFDVixHQUFHLENBQUNVLE9BQU8sQ0FBQyxDQUFDO0VBQzFCO0VBRUEsTUFBTUMsR0FBR0EsQ0FBQ0MsSUFBWSxFQUFFQyxPQUFnQyxFQUFFO0lBQ3hELE9BQU8sSUFBSSxDQUFDYixHQUFHLENBQUNXLEdBQUcsQ0FBQ0MsSUFBSSxFQUFFO01BQUVDO0lBQVEsQ0FBQyxDQUFDO0VBQ3hDO0VBRUEsTUFBTUMsSUFBSUEsQ0FBQ0YsSUFBWSxFQUFFRyxJQUFjLEVBQUVGLE9BQWdDLEVBQUU7SUFDekUsT0FBTyxJQUFJLENBQUNiLEdBQUcsQ0FBQ2MsSUFBSSxDQUFDRixJQUFJLEVBQUU7TUFBRUcsSUFBSTtNQUFFRjtJQUFRLENBQUMsQ0FBQztFQUMvQztFQUVBLE1BQU1HLEtBQUtBLENBQUNKLElBQVksRUFBRUcsSUFBYyxFQUFFRixPQUFnQyxFQUFFO0lBQzFFLE9BQU8sSUFBSSxDQUFDYixHQUFHLENBQUNnQixLQUFLLENBQUNKLElBQUksRUFBRTtNQUFFRyxJQUFJO01BQUVGO0lBQVEsQ0FBQyxDQUFDO0VBQ2hEO0VBRUEsTUFBTUksZ0JBQWdCQSxDQUFBLEVBQUc7SUFDdkIsTUFBTUMsT0FBTyxHQUFHOUIsT0FBTyxDQUFDK0IsYUFBYSxJQUFJL0IsT0FBTyxDQUFDZ0MsU0FBUztJQUMxRCxJQUFJRixPQUFPLEVBQUU7TUFDWCxNQUFNdkIsUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDMEIsa0JBQWtCLENBQzVDLE1BQU0sSUFBSSxDQUFDckIsR0FBRyxDQUFDVyxHQUFHLENBQUMsNkJBQTZCLEVBQUU7UUFDaERXLE1BQU0sRUFBRTtVQUNOQyxHQUFHLEVBQUVMO1FBQ1AsQ0FBQztRQUNETCxPQUFPLEVBQUU7VUFDUCxXQUFXLEVBQUVLO1FBQ2Y7TUFDRixDQUFDLENBQUMsRUFDRjtRQUFFTSxPQUFPLEVBQUUsQ0FBQztRQUFFQyxTQUFTLEVBQUUsSUFBSztRQUFFQyxhQUFhLEVBQUUsQ0FBQyxHQUFHO01BQUUsQ0FDdkQsQ0FBQztNQUVELElBQUkvQixRQUFRLENBQUNnQyxFQUFFLENBQUMsQ0FBQyxFQUFFO1FBQUEsSUFBQUMscUJBQUE7UUFDakIsTUFBTUMsT0FBTyxHQUFHLE1BQU1sQyxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUF5QjtRQUM3RCxLQUFBZ0MscUJBQUEsR0FBSUMsT0FBTyxDQUFDQyxZQUFZLGNBQUFGLHFCQUFBLGVBQXBCQSxxQkFBQSxDQUFzQnBDLEtBQUssRUFBRTtVQUMvQixJQUFJLENBQUNTLGtCQUFrQixHQUFHNEIsT0FBTyxDQUFDQyxZQUFZO1FBQ2hEO1FBQ0EsS0FBSyxNQUFNQyxLQUFLLElBQUksRUFBQUMsaUJBQUEsR0FBQUgsT0FBTyxDQUFDSSxRQUFRLGNBQUFELGlCQUFBLHVCQUFoQkEsaUJBQUEsQ0FBa0JFLFNBQVMsS0FBSSxFQUFFLEVBQUU7VUFBQSxJQUFBRixpQkFBQSxFQUFBRyxjQUFBO1VBQ3JELElBQUlKLEtBQUssYUFBTEEsS0FBSyxnQkFBQUksY0FBQSxHQUFMSixLQUFLLENBQUVLLE9BQU8sY0FBQUQsY0FBQSxlQUFkQSxjQUFBLENBQWdCM0MsS0FBSyxJQUFJdUMsS0FBSyxhQUFMQSxLQUFLLGVBQUxBLEtBQUssQ0FBRU0sS0FBSyxFQUFFO1lBQ3pDLElBQUksQ0FBQ25DLGtCQUFrQixDQUFDb0MsR0FBRyxDQUFDLElBQUksQ0FBQ0MsaUJBQWlCLENBQUNSLEtBQUssQ0FBQ00sS0FBSyxFQUFFLFVBQVUsQ0FBQyxFQUFFTixLQUFLLENBQUNLLE9BQU8sQ0FBQztVQUM3RjtRQUNGO1FBQ0EsS0FBSyxNQUFNTCxLQUFLLElBQUksRUFBQVMsa0JBQUEsR0FBQVgsT0FBTyxDQUFDSSxRQUFRLGNBQUFPLGtCQUFBLHVCQUFoQkEsa0JBQUEsQ0FBa0JDLE9BQU8sS0FBSSxFQUFFLEVBQUU7VUFBQSxJQUFBRCxrQkFBQSxFQUFBRSxlQUFBO1VBQ25ELElBQUlYLEtBQUssYUFBTEEsS0FBSyxnQkFBQVcsZUFBQSxHQUFMWCxLQUFLLENBQUVLLE9BQU8sY0FBQU0sZUFBQSxlQUFkQSxlQUFBLENBQWdCbEQsS0FBSyxJQUFJdUMsS0FBSyxhQUFMQSxLQUFLLGVBQUxBLEtBQUssQ0FBRU0sS0FBSyxFQUFFO1lBQ3pDLElBQUksQ0FBQ25DLGtCQUFrQixDQUFDb0MsR0FBRyxDQUFDLElBQUksQ0FBQ0MsaUJBQWlCLENBQUNSLEtBQUssQ0FBQ00sS0FBSyxFQUFFLFFBQVEsQ0FBQyxFQUFFTixLQUFLLENBQUNLLE9BQU8sQ0FBQztVQUMzRjtRQUNGO1FBQ0EsT0FBTztVQUNMLEdBQUdQLE9BQU87VUFDVmMsYUFBYSxFQUFFO1FBQ2pCLENBQUM7TUFDSDtNQUVBLElBQUloRCxRQUFRLENBQUNpRCxNQUFNLENBQUMsQ0FBQyxLQUFLLEdBQUcsRUFBRTtRQUM3QjFELE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7TUFDcEM7SUFDRjtJQUVBLE9BQU8sSUFBSSxDQUFDQyxtQkFBbUIsQ0FBQyxDQUFDO0VBQ25DO0VBRUEsTUFBTUMscUJBQXFCQSxDQUFBLEVBQWtDO0lBQUEsSUFBQUMscUJBQUEsRUFBQUMscUJBQUE7SUFDM0QsTUFBTUMsU0FBUyxHQUFHLE1BQU0sSUFBSSxDQUFDakMsZ0JBQWdCLENBQUMsQ0FBQztJQUMvQyxNQUFNLENBQUNrQyxLQUFLLEVBQUVDLElBQUksRUFBRUMsSUFBSSxFQUFFQyxHQUFHLEVBQUVDLElBQUksQ0FBQyxHQUFHLE1BQU1DLE9BQU8sQ0FBQ0MsR0FBRyxDQUFDLENBQ3ZELENBQUFULHFCQUFBLEdBQUFFLFNBQVMsQ0FBQ3BCLFlBQVksY0FBQWtCLHFCQUFBLGVBQXRCQSxxQkFBQSxDQUF3QnhELEtBQUssR0FBR2dFLE9BQU8sQ0FBQ0UsT0FBTyxDQUFDUixTQUFTLENBQUNwQixZQUFZLENBQUMsR0FBRyxJQUFJLENBQUM2QixVQUFVLENBQUMsQ0FBQyxFQUMzRixJQUFJLENBQUNDLGtCQUFrQixDQUFDLE1BQU0sQ0FBQyxFQUMvQixJQUFJLENBQUNBLGtCQUFrQixDQUFDLE1BQU0sQ0FBQyxFQUMvQixJQUFJLENBQUNBLGtCQUFrQixDQUFDLEtBQUssQ0FBQyxFQUM5QixJQUFJLENBQUNDLHFCQUFxQixDQUFDLE1BQU0sQ0FBQyxDQUNuQyxDQUFDO0lBRUYsTUFBTSxDQUNKQyxlQUFlLEVBQ2ZDLGlCQUFpQixFQUNqQkMsaUJBQWlCLEVBQ2pCQyxtQkFBbUIsRUFDbkJDLGtCQUFrQixFQUNsQkMsb0JBQW9CLEVBQ3BCQyxpQkFBaUIsRUFDakJDLGdCQUFnQixDQUNqQixHQUFHLE1BQU1iLE9BQU8sQ0FBQ0MsR0FBRyxDQUFDLENBQ3BCLElBQUksQ0FBQ2EsV0FBVyxDQUFDbEYsT0FBTyxDQUFDbUYsaUJBQWlCLEVBQUUsVUFBVSxDQUFDLEVBQ3ZELElBQUksQ0FBQ0QsV0FBVyxDQUFDbEYsT0FBTyxDQUFDb0Ysa0JBQWtCLEVBQUUsVUFBVSxDQUFDLEVBQ3hELElBQUksQ0FBQ0YsV0FBVyxDQUFDbEYsT0FBTyxDQUFDcUYsbUJBQW1CLEVBQUUsUUFBUSxDQUFDLEVBQ3ZELElBQUksQ0FBQ0gsV0FBVyxDQUFDLFlBQVksRUFBRSxRQUFRLENBQUMsRUFDeEMsSUFBSSxDQUFDQSxXQUFXLENBQUMsWUFBWSxFQUFFLFFBQVEsQ0FBQyxFQUN4QyxJQUFJLENBQUNBLFdBQVcsQ0FBQyxZQUFZLEVBQUUsUUFBUSxDQUFDLEVBQ3hDLElBQUksQ0FBQ0EsV0FBVyxDQUFDbEYsT0FBTyxDQUFDc0YsbUJBQW1CLEVBQUUsUUFBUSxDQUFDLEVBQ3ZELElBQUksQ0FBQ0osV0FBVyxDQUFDbEYsT0FBTyxDQUFDdUYsa0JBQWtCLEVBQUUsUUFBUSxDQUFDLENBQ3ZELENBQUM7SUFFRixPQUFPO01BQ0xDLE9BQU8sRUFBRSxDQUFDO01BQ1ZDLE9BQU8sRUFBRXpGLE9BQU8sQ0FBQ3lGLE9BQU87TUFDeEJDLE9BQU8sRUFBRTFGLE9BQU8sQ0FBQzBGLE9BQU87TUFDeEJDLFNBQVMsRUFBRSxJQUFJQyxJQUFJLENBQUMsQ0FBQyxDQUFDQyxXQUFXLENBQUMsQ0FBQztNQUNuQ3RDLGFBQWEsR0FBQU0scUJBQUEsR0FBRUMsU0FBUyxDQUFDUCxhQUFhLGNBQUFNLHFCQUFBLGNBQUFBLHFCQUFBLEdBQUksVUFBVTtNQUNwREUsS0FBSyxFQUFFO1FBQ0xmLE9BQU8sRUFBRWU7TUFDWCxDQUFDO01BQ0QrQixVQUFVLEVBQUU7UUFDVjlCLElBQUk7UUFDSkMsSUFBSTtRQUNKQyxHQUFHO1FBQ0hDO01BQ0YsQ0FBQztNQUNENEIsTUFBTSxFQUFFO1FBQ05yQixlQUFlLEVBQUU7VUFBRXNCLEtBQUssRUFBRSxrQkFBa0I7VUFBRS9DLEtBQUssRUFBRWpELE9BQU8sQ0FBQ21GLGlCQUFpQjtVQUFFbkMsT0FBTyxFQUFFMEI7UUFBZ0IsQ0FBQztRQUMxR0MsaUJBQWlCLEVBQUU7VUFBRXFCLEtBQUssRUFBRSxvQkFBb0I7VUFBRS9DLEtBQUssRUFBRWpELE9BQU8sQ0FBQ29GLGtCQUFrQjtVQUFFcEMsT0FBTyxFQUFFMkI7UUFBa0IsQ0FBQztRQUNqSEMsaUJBQWlCLEVBQUU7VUFBRW9CLEtBQUssRUFBRSxxQkFBcUI7VUFBRS9DLEtBQUssRUFBRWpELE9BQU8sQ0FBQ3FGLG1CQUFtQjtVQUFFckMsT0FBTyxFQUFFNEI7UUFBa0IsQ0FBQztRQUNuSEMsbUJBQW1CLEVBQUU7VUFBRW1CLEtBQUssRUFBRSx1QkFBdUI7VUFBRS9DLEtBQUssRUFBRSxZQUFZO1VBQUVELE9BQU8sRUFBRTZCO1FBQW9CLENBQUM7UUFDMUdDLGtCQUFrQixFQUFFO1VBQUVrQixLQUFLLEVBQUUsc0JBQXNCO1VBQUUvQyxLQUFLLEVBQUUsWUFBWTtVQUFFRCxPQUFPLEVBQUU4QjtRQUFtQixDQUFDO1FBQ3ZHQyxvQkFBb0IsRUFBRTtVQUFFaUIsS0FBSyxFQUFFLHdCQUF3QjtVQUFFL0MsS0FBSyxFQUFFLFlBQVk7VUFBRUQsT0FBTyxFQUFFK0I7UUFBcUIsQ0FBQztRQUM3R0MsaUJBQWlCLEVBQUU7VUFBRWdCLEtBQUssRUFBRSxxQkFBcUI7VUFBRS9DLEtBQUssRUFBRWpELE9BQU8sQ0FBQ3NGLG1CQUFtQjtVQUFFdEMsT0FBTyxFQUFFZ0M7UUFBa0IsQ0FBQztRQUNuSEMsZ0JBQWdCLEVBQUU7VUFBRWUsS0FBSyxFQUFFLG9CQUFvQjtVQUFFL0MsS0FBSyxFQUFFakQsT0FBTyxDQUFDdUYsa0JBQWtCO1VBQUV2QyxPQUFPLEVBQUVpQztRQUFpQjtNQUNoSCxDQUFDO01BQ0RnQixTQUFTLEVBQUU7UUFDVEMsT0FBTyxFQUFFLEVBQUU7UUFDWEMsY0FBYyxFQUFFLEVBQUU7UUFDbEJDLGlCQUFpQixFQUFFLEVBQUU7UUFDckJDLEtBQUssRUFBRTtNQUNUO0lBQ0YsQ0FBQztFQUNIO0VBRUEsTUFBTUMsV0FBV0EsQ0FBQSxFQUFHO0lBQ2xCeEcsTUFBTSxDQUFDRSxPQUFPLENBQUNnQyxTQUFTLElBQUloQyxPQUFPLENBQUMrQixhQUFhLENBQUMsQ0FBQzBCLFVBQVUsQ0FBQyxDQUFDO0lBQy9ELE1BQU1sRCxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUNLLEdBQUcsQ0FBQ1csR0FBRyxDQUFDLGdCQUFnQixFQUFFO01BQ3BERSxPQUFPLEVBQUU7UUFDUCxXQUFXLEVBQUV6QixPQUFPLENBQUNnQyxTQUFTLElBQUloQyxPQUFPLENBQUMrQjtNQUM1QztJQUNGLENBQUMsQ0FBQztJQUNGakMsTUFBTSxDQUFDUyxRQUFRLENBQUNnQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUNrQixVQUFVLENBQUMsQ0FBQztJQUNsQyxPQUFPbEQsUUFBUSxDQUFDQyxJQUFJLENBQUMsQ0FBQztFQUN4QjtFQUVBLE1BQU0rRCxVQUFVQSxDQUFDZ0MsWUFBWSxHQUFHLEtBQUssRUFBeUI7SUFBQSxJQUFBQyxxQkFBQTtJQUM1RCxJQUFJLENBQUNELFlBQVksS0FBQUMscUJBQUEsR0FBSSxJQUFJLENBQUMzRixrQkFBa0IsY0FBQTJGLHFCQUFBLGVBQXZCQSxxQkFBQSxDQUF5QnBHLEtBQUssRUFBRTtNQUNuRCxPQUFPLElBQUksQ0FBQ1Msa0JBQWtCO0lBQ2hDO0lBRUEsSUFBSSxDQUFDYixPQUFPLENBQUN5RyxhQUFhLEVBQUU7TUFDMUIsSUFBSTtRQUFBLElBQUFDLG9CQUFBO1FBQ0YsTUFBTUMsS0FBSyxHQUFHLE1BQU0xRyxrQkFBa0IsQ0FBQyxDQUFDO1FBQ3hDLEtBQUF5RyxvQkFBQSxHQUFJQyxLQUFLLENBQUM1QyxLQUFLLENBQUNmLE9BQU8sY0FBQTBELG9CQUFBLGVBQW5CQSxvQkFBQSxDQUFxQnRHLEtBQUssRUFBRTtVQUM5QixJQUFJLENBQUNTLGtCQUFrQixHQUFHOEYsS0FBSyxDQUFDNUMsS0FBSyxDQUFDZixPQUFPO1VBQzdDLE9BQU8sSUFBSSxDQUFDbkMsa0JBQWtCO1FBQ2hDO01BQ0YsQ0FBQyxDQUFDLE1BQU07UUFDTjtNQUFBO0lBRUo7SUFFQSxNQUFNTixRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUMwQixrQkFBa0IsQ0FDNUMsTUFBTSxJQUFJLENBQUNyQixHQUFHLENBQUNjLElBQUksQ0FBQyxrQkFBa0IsRUFBRTtNQUN0Q0MsSUFBSSxFQUFFO1FBQ0ppRixLQUFLLEVBQUU1RyxPQUFPLENBQUM2RyxVQUFVO1FBQ3pCQyxRQUFRLEVBQUU5RyxPQUFPLENBQUN5RztNQUNwQjtJQUNGLENBQUMsQ0FBQyxFQUNGO01BQUVyRSxPQUFPLEVBQUUsQ0FBQztNQUFFQyxTQUFTLEVBQUUsSUFBSztNQUFFQyxhQUFhLEVBQUUsQ0FBQyxHQUFHO0lBQUUsQ0FDdkQsQ0FBQztJQUVELE1BQU15RSxJQUFJLEdBQUcsTUFBTXhHLFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7SUFDbEMsSUFBSUQsUUFBUSxDQUFDaUQsTUFBTSxDQUFDLENBQUMsS0FBSyxHQUFHLElBQUl1RCxJQUFJLGFBQUpBLElBQUksZUFBSkEsSUFBSSxDQUFFQyxpQkFBaUIsRUFBRTtNQUN4RCxNQUFNLElBQUlDLEtBQUssQ0FBQyx1SEFBdUgsQ0FBQztJQUMxSTtJQUVBbkgsTUFBTSxDQUFDUyxRQUFRLENBQUNnQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUNrQixVQUFVLENBQUMsQ0FBQztJQUNsQzNELE1BQU0sQ0FBQ2lILElBQUksYUFBSkEsSUFBSSx1QkFBSkEsSUFBSSxDQUFFM0csS0FBSyxDQUFDLENBQUNxRCxVQUFVLENBQUMsQ0FBQztJQUNoQyxJQUFJLENBQUM1QyxrQkFBa0IsR0FBR2tHLElBQW9CO0lBQzlDLE9BQU8sSUFBSSxDQUFDbEcsa0JBQWtCO0VBQ2hDO0VBRUEsTUFBTXFHLFFBQVFBLENBQUMxRixJQUFZLEVBQUU7SUFDM0IsSUFBSXVDLEtBQUssR0FBRyxNQUFNLElBQUksQ0FBQ1EsVUFBVSxDQUFDLENBQUM7SUFDbkMsSUFBSWhFLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ0ssR0FBRyxDQUFDVyxHQUFHLENBQUNDLElBQUksRUFBRTtNQUN0Q0MsT0FBTyxFQUFFdEIsV0FBVyxDQUFDNEQsS0FBSyxDQUFDM0QsS0FBSztJQUNsQyxDQUFDLENBQUM7SUFDRixJQUFJRyxRQUFRLENBQUNpRCxNQUFNLENBQUMsQ0FBQyxLQUFLLEdBQUcsRUFBRTtNQUM3Qk8sS0FBSyxHQUFHLE1BQU0sSUFBSSxDQUFDUSxVQUFVLENBQUMsSUFBSSxDQUFDO01BQ25DaEUsUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDSyxHQUFHLENBQUNXLEdBQUcsQ0FBQ0MsSUFBSSxFQUFFO1FBQ2xDQyxPQUFPLEVBQUV0QixXQUFXLENBQUM0RCxLQUFLLENBQUMzRCxLQUFLO01BQ2xDLENBQUMsQ0FBQztJQUNKO0lBQ0EsT0FBT0csUUFBUTtFQUNqQjtFQUVBLE1BQU00RyxlQUFlQSxDQUFDL0csS0FBYSxFQUFFO0lBQ25DLE1BQU1HLFFBQVEsR0FBR0gsS0FBSyxHQUNsQixNQUFNLElBQUksQ0FBQ1EsR0FBRyxDQUFDVyxHQUFHLENBQUMsb0JBQW9CLEVBQUU7TUFBRUUsT0FBTyxFQUFFdEIsV0FBVyxDQUFDQyxLQUFLO0lBQUUsQ0FBQyxDQUFDLEdBQ3pFLE1BQU0sSUFBSSxDQUFDOEcsUUFBUSxDQUFDLG9CQUFvQixDQUFDO0lBQzdDcEgsTUFBTSxDQUFDUyxRQUFRLENBQUNnQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUNrQixVQUFVLENBQUMsQ0FBQztJQUNsQyxPQUFPbEQsUUFBUSxDQUFDQyxJQUFJLENBQUMsQ0FBQztFQUN4QjtFQUVBLE1BQU0wRSxXQUFXQSxDQUFDakMsS0FBYSxFQUFFbUUsUUFBK0IsRUFBRWIsWUFBWSxHQUFHLEtBQUssRUFBMEI7SUFDOUcsTUFBTWMsUUFBUSxHQUFHLElBQUksQ0FBQ2xFLGlCQUFpQixDQUFDRixLQUFLLEVBQUVtRSxRQUFRLENBQUM7SUFDeEQsTUFBTUUsTUFBTSxHQUFHLElBQUksQ0FBQ3hHLGtCQUFrQixDQUFDUyxHQUFHLENBQUM4RixRQUFRLENBQUM7SUFDcEQsSUFBSSxDQUFDZCxZQUFZLElBQUllLE1BQU0sYUFBTkEsTUFBTSxlQUFOQSxNQUFNLENBQUVsSCxLQUFLLEVBQUU7TUFDbEMsT0FBT2tILE1BQU07SUFDZjtJQUVBLE1BQU0vRyxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUMwQixrQkFBa0IsQ0FDNUMsTUFBTSxJQUFJLENBQUNyQixHQUFHLENBQUNjLElBQUksQ0FBQyx5QkFBeUIsRUFBRTtNQUM3Q0MsSUFBSSxFQUFFO1FBQ0pzQixLQUFLO1FBQ0w2RCxRQUFRLEVBQUU5RyxPQUFPLENBQUN1SCxrQkFBa0I7UUFDcENIO01BQ0Y7SUFDRixDQUFDLENBQUMsRUFDRjtNQUFFaEYsT0FBTyxFQUFFLENBQUM7TUFBRUMsU0FBUyxFQUFFLElBQUs7TUFBRUMsYUFBYSxFQUFFLENBQUMsR0FBRztJQUFFLENBQ3ZELENBQUM7SUFDRHhDLE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsTUFBTVQsT0FBTyxHQUFHLE1BQU16QyxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFrQjtJQUN0RCxJQUFJLENBQUNNLGtCQUFrQixDQUFDb0MsR0FBRyxDQUFDbUUsUUFBUSxFQUFFckUsT0FBTyxDQUFDO0lBQzlDLE9BQU9BLE9BQU87RUFDaEI7RUFFQSxNQUFNd0Usb0JBQW9CQSxDQUFDeEUsT0FBc0IsRUFBRTtJQUFBLElBQUF5RSxxQkFBQTtJQUNqRCxNQUFNQyxTQUFTLElBQUFELHFCQUFBLEdBQUcsTUFBTSxJQUFJLENBQUNFLHdCQUF3QixDQUFDM0UsT0FBTyxDQUFDLGNBQUF5RSxxQkFBQSxjQUFBQSxxQkFBQSxHQUN6RCxNQUFNLElBQUksQ0FBQ3ZDLFdBQVcsQ0FBQ2xDLE9BQU8sQ0FBQzRFLElBQUksQ0FBQzNFLEtBQUssRUFBRUQsT0FBTyxDQUFDNEUsSUFBSSxDQUFDUixRQUFRLEVBQTJCLElBQUksQ0FBQztJQUNyR3BFLE9BQU8sQ0FBQzVDLEtBQUssR0FBR3NILFNBQVMsQ0FBQ3RILEtBQUs7SUFDL0I0QyxPQUFPLENBQUM2RSxZQUFZLEdBQUdILFNBQVMsQ0FBQ0csWUFBWTtJQUM3QzdFLE9BQU8sQ0FBQzhFLFNBQVMsR0FBR0osU0FBUyxDQUFDSSxTQUFTO0lBQ3ZDOUUsT0FBTyxDQUFDNEUsSUFBSSxHQUFHRixTQUFTLENBQUNFLElBQUk7SUFDN0IsSUFBSSxDQUFDOUcsa0JBQWtCLENBQUNvQyxHQUFHLENBQUMsSUFBSSxDQUFDQyxpQkFBaUIsQ0FBQ0gsT0FBTyxDQUFDNEUsSUFBSSxDQUFDM0UsS0FBSyxFQUFFRCxPQUFPLENBQUM0RSxJQUFJLENBQUNSLFFBQWlDLENBQUMsRUFBRXBFLE9BQU8sQ0FBQztJQUNoSSxNQUFNOUMsc0JBQXNCLENBQUM4QyxPQUFPLENBQUM0RSxJQUFJLENBQUMzRSxLQUFLLEVBQUVELE9BQU8sQ0FBQzRFLElBQUksQ0FBQ1IsUUFBUSxFQUFFcEUsT0FBTyxDQUFDO0lBQ2hGLE9BQU9BLE9BQU87RUFDaEI7RUFFQSxNQUFNK0UsY0FBY0EsQ0FBQzdGLE1BTXBCLEVBQTBCO0lBQ3pCLE1BQU0zQixRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUMwQixrQkFBa0IsQ0FDNUMsTUFBTSxJQUFJLENBQUNyQixHQUFHLENBQUNjLElBQUksQ0FBQyxtQkFBbUIsRUFBRTtNQUN2Q0MsSUFBSSxFQUFFTztJQUNSLENBQUMsQ0FBQyxFQUNGO01BQUVFLE9BQU8sRUFBRSxDQUFDO01BQUVDLFNBQVMsRUFBRSxJQUFLO01BQUVDLGFBQWEsRUFBRSxDQUFDLEdBQUc7SUFBRSxDQUN2RCxDQUFDO0lBQ0R4QyxNQUFNLENBQUMsQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUNrSSxTQUFTLENBQUN6SCxRQUFRLENBQUNpRCxNQUFNLENBQUMsQ0FBQyxDQUFDO0lBQ3BELElBQUlqRCxRQUFRLENBQUNpRCxNQUFNLENBQUMsQ0FBQyxLQUFLLEdBQUcsRUFBRTtNQUM3QixPQUFPLElBQUksQ0FBQzBCLFdBQVcsQ0FBQ2hELE1BQU0sQ0FBQ2UsS0FBSyxFQUFFZixNQUFNLENBQUNrRixRQUFRLENBQUM7SUFDeEQ7SUFDQSxNQUFNcEUsT0FBTyxHQUFHLE1BQU16QyxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFrQjtJQUN0RCxJQUFJLENBQUNNLGtCQUFrQixDQUFDb0MsR0FBRyxDQUFDLElBQUksQ0FBQ0MsaUJBQWlCLENBQUNqQixNQUFNLENBQUNlLEtBQUssRUFBRWYsTUFBTSxDQUFDa0YsUUFBUSxDQUFDLEVBQUVwRSxPQUFPLENBQUM7SUFDM0YsT0FBT0EsT0FBTztFQUNoQjtFQUVBLE1BQU1pRixtQkFBbUJBLENBQUNqRixPQUFzQixFQUFFUCxPQU1qRCxFQUFFO0lBQ0QsTUFBTWxDLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQzJILFdBQVcsQ0FBQ2xGLE9BQU8sRUFBRSx5QkFBeUIsRUFBRVAsT0FBTyxDQUFDO0lBQ3BGM0MsTUFBTSxDQUFDUyxRQUFRLENBQUNnQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUNrQixVQUFVLENBQUMsQ0FBQztJQUNsQyxPQUFPbEQsUUFBUSxDQUFDQyxJQUFJLENBQUMsQ0FBQztFQUN4QjtFQUVBLE1BQU0ySCxhQUFhQSxDQUFDQyxVQUFrQixFQUFFQyxRQUFnQixFQUFFQyxJQUFZLEVBQUU7SUFDdEUsTUFBTS9ILFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ0ssR0FBRyxDQUFDZ0IsS0FBSyxDQUFDLHNCQUFzQnlHLFFBQVEsZ0JBQWdCLEVBQUU7TUFDcEYxRyxJQUFJLEVBQUU7UUFDSjZCLE1BQU0sRUFBRSxVQUFVO1FBQ2xCK0UsYUFBYSxFQUFFLFVBQVU7UUFDekJEO01BQ0YsQ0FBQztNQUNEN0csT0FBTyxFQUFFdEIsV0FBVyxDQUFDaUksVUFBVTtJQUNqQyxDQUFDLENBQUM7SUFDRnRJLE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsT0FBT2xELFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDeEI7RUFFQSxNQUFNZ0ksb0JBQW9CQSxDQUFBLEVBQUc7SUFDM0IsSUFBSWpJLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ0ssR0FBRyxDQUFDVyxHQUFHLENBQUMsNkJBQTZCLENBQUM7SUFDaEUsSUFBSSxDQUFDaEIsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsRUFBRTtNQUNsQmhDLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ0ssR0FBRyxDQUFDVyxHQUFHLENBQUMseUJBQXlCLENBQUM7SUFDMUQ7SUFDQXpCLE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsTUFBTXNELElBQUksR0FBRyxNQUFNeEcsUUFBUSxDQUFDQyxJQUFJLENBQUMsQ0FBQztJQUNsQyxNQUFNaUksSUFBSSxHQUFHQyxLQUFLLENBQUNDLE9BQU8sQ0FBQzVCLElBQUksQ0FBQyxHQUFHQSxJQUFJLEdBQUcyQixLQUFLLENBQUNDLE9BQU8sQ0FBQzVCLElBQUksYUFBSkEsSUFBSSx1QkFBSkEsSUFBSSxDQUFFcEYsSUFBSSxDQUFDLEdBQUdvRixJQUFJLENBQUNwRixJQUFJLEdBQUcsRUFBRTtJQUNwRixPQUFPOEcsSUFBSTtFQUNiO0VBRUEsTUFBTWpFLGtCQUFrQkEsQ0FBQ3dCLEtBQXVDLEVBQUU7SUFDaEUsTUFBTUYsVUFBVSxHQUFHLE1BQU0sSUFBSSxDQUFDMEMsb0JBQW9CLENBQUMsQ0FBQztJQUNwRCxNQUFNSSxVQUFVLEdBQUc1QyxLQUFLLENBQUM2QyxXQUFXLENBQUMsQ0FBQztJQUN0QyxNQUFNQyxRQUFRLEdBQUdoRCxVQUFVLENBQUNpRCxJQUFJLENBQUVDLElBQUksSUFBSztNQUN6QyxNQUFNQyxRQUFRLEdBQUcsR0FBR0QsSUFBSSxDQUFDRSxJQUFJLElBQUlGLElBQUksQ0FBQ0csSUFBSSxJQUFJLEVBQUUsSUFBSUgsSUFBSSxDQUFDSSxXQUFXLElBQUksRUFBRSxJQUFJSixJQUFJLENBQUNLLFdBQVcsSUFBSSxFQUFFLEVBQUUsQ0FBQ1IsV0FBVyxDQUFDLENBQUM7TUFDcEgsSUFBSUQsVUFBVSxLQUFLLE1BQU0sRUFBRSxPQUFPSyxRQUFRLENBQUNLLFFBQVEsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDTCxRQUFRLENBQUNLLFFBQVEsQ0FBQyxRQUFRLENBQUM7TUFDM0YsSUFBSVYsVUFBVSxLQUFLLE1BQU0sRUFBRSxPQUFPSyxRQUFRLENBQUNLLFFBQVEsQ0FBQyxNQUFNLENBQUM7TUFDM0QsSUFBSVYsVUFBVSxLQUFLLEtBQUssRUFBRSxPQUFPSyxRQUFRLENBQUNLLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSUwsUUFBUSxDQUFDSyxRQUFRLENBQUMsT0FBTyxDQUFDLElBQUlMLFFBQVEsQ0FBQ0ssUUFBUSxDQUFDLEtBQUssQ0FBQztNQUNuSCxJQUFJVixVQUFVLEtBQUssTUFBTSxFQUFFLE9BQU9JLElBQUksQ0FBQ08sU0FBUyxLQUFLLElBQUksSUFBSU4sUUFBUSxDQUFDSyxRQUFRLENBQUMsTUFBTSxDQUFDLElBQUlMLFFBQVEsQ0FBQ0ssUUFBUSxDQUFDLFNBQVMsQ0FBQztNQUN0SCxPQUFPLEtBQUs7SUFDZCxDQUFDLENBQUM7SUFDRnhKLE1BQU0sQ0FBQ2dKLFFBQVEsRUFBRSxnQ0FBZ0M5QyxLQUFLLEVBQUUsQ0FBQyxDQUFDdkMsVUFBVSxDQUFDLENBQUM7SUFDdEUsT0FBT3FGLFFBQVE7RUFDakI7RUFFQSxNQUFNckUscUJBQXFCQSxDQUFDdUIsS0FBdUMsRUFBRTtJQUNuRSxNQUFNRixVQUFVLEdBQUcsTUFBTSxJQUFJLENBQUMwQyxvQkFBb0IsQ0FBQyxDQUFDO0lBQ3BELE1BQU1JLFVBQVUsR0FBRzVDLEtBQUssQ0FBQzZDLFdBQVcsQ0FBQyxDQUFDO0lBQ3RDLE9BQU8vQyxVQUFVLENBQUNpRCxJQUFJLENBQUVDLElBQUksSUFBSztNQUMvQixNQUFNQyxRQUFRLEdBQUcsR0FBR0QsSUFBSSxDQUFDRSxJQUFJLElBQUlGLElBQUksQ0FBQ0csSUFBSSxJQUFJLEVBQUUsSUFBSUgsSUFBSSxDQUFDSSxXQUFXLElBQUksRUFBRSxJQUFJSixJQUFJLENBQUNLLFdBQVcsSUFBSSxFQUFFLEVBQUUsQ0FBQ1IsV0FBVyxDQUFDLENBQUM7TUFDcEgsSUFBSUQsVUFBVSxLQUFLLE1BQU0sRUFBRSxPQUFPSyxRQUFRLENBQUNLLFFBQVEsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDTCxRQUFRLENBQUNLLFFBQVEsQ0FBQyxRQUFRLENBQUM7TUFDM0YsSUFBSVYsVUFBVSxLQUFLLE1BQU0sRUFBRSxPQUFPSyxRQUFRLENBQUNLLFFBQVEsQ0FBQyxNQUFNLENBQUM7TUFDM0QsSUFBSVYsVUFBVSxLQUFLLEtBQUssRUFBRSxPQUFPSyxRQUFRLENBQUNLLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSUwsUUFBUSxDQUFDSyxRQUFRLENBQUMsT0FBTyxDQUFDLElBQUlMLFFBQVEsQ0FBQ0ssUUFBUSxDQUFDLEtBQUssQ0FBQztNQUNuSCxJQUFJVixVQUFVLEtBQUssTUFBTSxFQUFFLE9BQU9JLElBQUksQ0FBQ08sU0FBUyxLQUFLLElBQUksSUFBSU4sUUFBUSxDQUFDSyxRQUFRLENBQUMsTUFBTSxDQUFDLElBQUlMLFFBQVEsQ0FBQ0ssUUFBUSxDQUFDLFNBQVMsQ0FBQztNQUN0SCxPQUFPLEtBQUs7SUFDZCxDQUFDLENBQUMsSUFBSSxJQUFJO0VBQ1o7RUFFQSxNQUFNRSxnQkFBZ0JBLENBQUNDLGlCQUF5QixFQUFFO0lBQ2hELE1BQU1sSixRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUNLLEdBQUcsQ0FBQ1csR0FBRyxDQUFDLHlCQUF5QixFQUFFO01BQzdEVyxNQUFNLEVBQUU7UUFDTndILEdBQUcsRUFBRTFKLE9BQU8sQ0FBQzJKLGFBQWE7UUFDMUJDLEdBQUcsRUFBRTVKLE9BQU8sQ0FBQzZKLGFBQWE7UUFDMUJDLE1BQU0sRUFBRSxDQUFDO1FBQ1RMO01BQ0Y7SUFDRixDQUFDLENBQUM7SUFDRjNKLE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsT0FBT2xELFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDeEI7RUFFQSxNQUFNdUosUUFBUUEsQ0FBQy9HLE9BQXNCLEVBQUVQLE9BQWdDLEVBQUU7SUFDdkUsTUFBTWxDLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ3lKLFVBQVUsQ0FBQ2hILE9BQU8sRUFBRSw2QkFBNkIsRUFBRVAsT0FBTyxDQUFDO0lBQ3ZGLElBQUksQ0FBQ2xDLFFBQVEsQ0FBQ2dDLEVBQUUsQ0FBQyxDQUFDLEVBQUU7TUFDbEIsTUFBTXdFLElBQUksR0FBRyxNQUFNekcsZ0JBQWdCLENBQUNDLFFBQVEsQ0FBQztNQUM3QyxNQUFNLElBQUkwRyxLQUFLLENBQUMsK0JBQStCMUcsUUFBUSxDQUFDaUQsTUFBTSxDQUFDLENBQUMsS0FBS3lHLElBQUksQ0FBQ0MsU0FBUyxDQUFDbkQsSUFBSSxDQUFDLEVBQUUsQ0FBQztJQUM5RjtJQUNBLE9BQU94RyxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQ3hCO0VBRUEsTUFBTTJKLHFCQUFxQkEsQ0FBQ25ILE9BQXNCLEVBQUU7SUFDbEQsTUFBTXpDLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQzZKLFNBQVMsQ0FBQ3BILE9BQU8sRUFBRSwrQkFBK0IsQ0FBQztJQUMvRWxELE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsT0FBT2xELFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDeEI7RUFFQSxNQUFNNkosMEJBQTBCQSxDQUFDckgsT0FBc0IsRUFBRXNILE1BQWMsRUFBRTtJQUN2RSxJQUFJO01BQ0YsTUFBTXZELElBQUksR0FBRyxNQUFNLElBQUksQ0FBQ29ELHFCQUFxQixDQUFDbkgsT0FBTyxDQUFDO01BQ3RELE1BQU11SCxJQUFJLEdBQUcsQ0FBQXhELElBQUksYUFBSkEsSUFBSSx1QkFBSkEsSUFBSSxDQUFFd0QsSUFBSSxNQUFJeEQsSUFBSSxhQUFKQSxJQUFJLHVCQUFKQSxJQUFJLENBQUV5RCxVQUFVLE1BQUl6RCxJQUFJLGFBQUpBLElBQUksdUJBQUpBLElBQUksQ0FBRXBGLElBQUksS0FBSSxJQUFJO01BQ2pFLE1BQU04SSxNQUFNLEdBQUcsQ0FBQUYsSUFBSSxhQUFKQSxJQUFJLHVCQUFKQSxJQUFJLENBQUVHLEVBQUUsTUFBSTNELElBQUksYUFBSkEsSUFBSSx1QkFBSkEsSUFBSSxDQUFFMEQsTUFBTSxLQUFJLElBQUk7TUFDL0MsTUFBTWpILE1BQU0sR0FBRyxDQUFBK0csSUFBSSxhQUFKQSxJQUFJLHVCQUFKQSxJQUFJLENBQUVJLGFBQWEsTUFBSUosSUFBSSxhQUFKQSxJQUFJLHVCQUFKQSxJQUFJLENBQUUvRyxNQUFNLE1BQUl1RCxJQUFJLGFBQUpBLElBQUksdUJBQUpBLElBQUksQ0FBRXZELE1BQU0sS0FBSSxJQUFJO01BQzFFLElBQUksQ0FBQ2lILE1BQU0sSUFBSSxDQUFDakgsTUFBTSxFQUFFO01BQ3hCLElBQUksQ0FBQyxXQUFXLEVBQUUsV0FBVyxFQUFFLFlBQVksRUFBRSxpQkFBaUIsQ0FBQyxDQUFDOEYsUUFBUSxDQUFDc0IsTUFBTSxDQUFDcEgsTUFBTSxDQUFDLENBQUMsRUFBRTtNQUMxRixNQUFNLElBQUksQ0FBQ3FILGtCQUFrQixDQUFDN0gsT0FBTyxFQUFFeUgsTUFBTSxFQUFFSCxNQUFNLENBQUM7SUFDeEQsQ0FBQyxDQUFDLE1BQU07TUFDTjtJQUFBO0VBRUo7RUFFQSxNQUFNUSxxQkFBcUJBLENBQUM5SCxPQUFzQixFQUFFO0lBQ2xELE1BQU16QyxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUM2SixTQUFTLENBQUNwSCxPQUFPLEVBQUUsK0JBQStCLENBQUM7SUFDL0VsRCxNQUFNLENBQUNTLFFBQVEsQ0FBQ2dDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQ2tCLFVBQVUsQ0FBQyxDQUFDO0lBQ2xDLE9BQU9sRCxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQ3hCO0VBRUEsTUFBTXVLLG1CQUFtQkEsQ0FBQy9ILE9BQXNCLEVBQUU7SUFDaEQsTUFBTXpDLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQzZKLFNBQVMsQ0FBQ3BILE9BQU8sRUFBRSw2QkFBNkIsQ0FBQztJQUM3RWxELE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsT0FBT2xELFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDeEI7RUFFQSxNQUFNd0ssVUFBVUEsQ0FBQ2hJLE9BQXNCLEVBQUV5SCxNQUFjLEVBQUU7SUFDdkQsTUFBTWxLLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ3lKLFVBQVUsQ0FBQ2hILE9BQU8sRUFBRSw2QkFBNkIsRUFBRTtNQUFFeUg7SUFBTyxDQUFDLENBQUM7SUFDMUYzSyxNQUFNLENBQUNTLFFBQVEsQ0FBQ2dDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQ2tCLFVBQVUsQ0FBQyxDQUFDO0lBQ2xDLE9BQU9sRCxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQ3hCO0VBRUEsTUFBTXlLLFdBQVdBLENBQUNqSSxPQUFzQixFQUFFeUgsTUFBYyxFQUFFO0lBQ3hELE1BQU1sSyxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUN5SixVQUFVLENBQUNoSCxPQUFPLEVBQUUseUJBQXlCLEVBQUU7TUFBRXlIO0lBQU8sQ0FBQyxDQUFDO0lBQ3RGM0ssTUFBTSxDQUFDUyxRQUFRLENBQUNnQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUNrQixVQUFVLENBQUMsQ0FBQztJQUNsQyxPQUFPbEQsUUFBUSxDQUFDQyxJQUFJLENBQUMsQ0FBQztFQUN4QjtFQUVBLE1BQU0wSyxTQUFTQSxDQUFDbEksT0FBc0IsRUFBRXlILE1BQWMsRUFBRVUsU0FBaUIsRUFBRTtJQUN6RSxNQUFNNUssUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDeUosVUFBVSxDQUFDaEgsT0FBTyxFQUFFLDRCQUE0QixFQUFFO01BQUV5SCxNQUFNO01BQUVVO0lBQVUsQ0FBQyxDQUFDO0lBQ3BHckwsTUFBTSxDQUFDUyxRQUFRLENBQUNnQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUNrQixVQUFVLENBQUMsQ0FBQztJQUNsQyxPQUFPbEQsUUFBUSxDQUFDQyxJQUFJLENBQUMsQ0FBQztFQUN4QjtFQUVBLE1BQU00SyxZQUFZQSxDQUFDcEksT0FBc0IsRUFBRXlILE1BQWMsRUFBRVksVUFBa0IsRUFBRTtJQUM3RSxNQUFNOUssUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDeUosVUFBVSxDQUFDaEgsT0FBTyxFQUFFLCtCQUErQixFQUFFO01BQy9FeUgsTUFBTTtNQUNOWSxVQUFVO01BQ1ZDLGNBQWMsRUFBRSxHQUFHO01BQ25CQyxJQUFJLEVBQUU7SUFDUixDQUFDLENBQUM7SUFDRnpMLE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsT0FBT2xELFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDeEI7RUFFQSxNQUFNcUssa0JBQWtCQSxDQUFDN0gsT0FBc0IsRUFBRXlILE1BQWMsRUFBRUgsTUFBYyxFQUFFO0lBQy9FLE1BQU0vSixRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUN5SixVQUFVLENBQUNoSCxPQUFPLEVBQUUsK0JBQStCLEVBQUU7TUFBRXlILE1BQU07TUFBRUg7SUFBTyxDQUFDLENBQUM7SUFDcEd4SyxNQUFNLENBQUNTLFFBQVEsQ0FBQ2dDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQ2tCLFVBQVUsQ0FBQyxDQUFDO0lBQ2xDLE9BQU9sRCxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQ3hCO0VBRUEsTUFBTWdMLHNCQUFzQkEsQ0FBQ3hJLE9BQXNCLEVBQUV5SCxNQUFjLEVBQUU7SUFDbkUsTUFBTWxLLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQzZKLFNBQVMsQ0FBQ3BILE9BQU8sRUFBRSxrQ0FBa0N5SCxNQUFNLEVBQUUsQ0FBQztJQUMxRjNLLE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsT0FBT2xELFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDeEI7RUFFQSxNQUFNaUwsb0JBQW9CQSxDQUFDekksT0FBc0IsRUFBRXlILE1BQWMsRUFBRTtJQUNqRSxNQUFNbEssUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDNkosU0FBUyxDQUFDcEgsT0FBTyxFQUFFLGdDQUFnQ3lILE1BQU0sRUFBRSxDQUFDO0lBQ3hGM0ssTUFBTSxDQUFDUyxRQUFRLENBQUNnQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUNrQixVQUFVLENBQUMsQ0FBQztJQUNsQyxPQUFPbEQsUUFBUSxDQUFDQyxJQUFJLENBQUMsQ0FBQztFQUN4QjtFQUVBLE1BQU1rTCxpQkFBaUJBLENBQUMxSSxPQUFzQixFQUFFO0lBQzlDLE1BQU16QyxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUM2SixTQUFTLENBQUNwSCxPQUFPLEVBQUUsMEJBQTBCLENBQUM7SUFDMUVsRCxNQUFNLENBQUNTLFFBQVEsQ0FBQ2dDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQ2tCLFVBQVUsQ0FBQyxDQUFDO0lBQ2xDLE9BQU9sRCxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQ3hCO0VBRUEsTUFBTW1MLGlCQUFpQkEsQ0FBQzNJLE9BQXNCLEVBQUU0SSxNQUFjLEVBQUU7SUFDOUQsTUFBTXJMLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ3lKLFVBQVUsQ0FBQ2hILE9BQU8sRUFBRSx1Q0FBdUMsRUFBRTtNQUFFNEk7SUFBTyxDQUFDLENBQUM7SUFDcEc5TCxNQUFNLENBQUNTLFFBQVEsQ0FBQ2dDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQ2tCLFVBQVUsQ0FBQyxDQUFDO0lBQ2xDLE9BQU9sRCxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQ3hCO0VBRUEsTUFBTXFMLHNCQUFzQkEsQ0FBQzdJLE9BQXNCLEVBQUU0SSxNQUFjLEVBQUVuQixNQUFjLEVBQUU7SUFDbkYsTUFBTWxLLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ3lKLFVBQVUsQ0FBQ2hILE9BQU8sRUFBRSxxQ0FBcUMsRUFBRTtNQUFFNEksTUFBTTtNQUFFbkI7SUFBTyxDQUFDLENBQUM7SUFDMUczSyxNQUFNLENBQUNTLFFBQVEsQ0FBQ2dDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQ2tCLFVBQVUsQ0FBQyxDQUFDO0lBQ2xDLE9BQU9sRCxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQ3hCO0VBRUEsTUFBTXNMLHdCQUF3QkEsQ0FBQzlJLE9BQXNCLEVBQUUrSSxPQUFlLEVBQUU7SUFDdEUsTUFBTXhMLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ3lKLFVBQVUsQ0FBQ2hILE9BQU8sRUFBRSx1Q0FBdUMsRUFBRTtNQUNyRmdKLGVBQWUsRUFBRUQsT0FBTztNQUN4QkUsaUJBQWlCLEVBQUUsZUFBZXJHLElBQUksQ0FBQ3NHLEdBQUcsQ0FBQyxDQUFDLEVBQUU7TUFDOUNDLGlCQUFpQixFQUFFO0lBQ3ZCLENBQUMsQ0FBQztJQUNGck0sTUFBTSxDQUFDUyxRQUFRLENBQUNpRCxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM0SSxJQUFJLENBQUMsR0FBRyxDQUFDO0lBQ25DLE9BQU83TCxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQ3hCO0VBRUEsTUFBTTZMLFdBQVdBLENBQUNySixPQUFzQixFQUFFUCxPQUFnQyxFQUFFO0lBQzFFLE1BQU1sQyxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUN5SixVQUFVLENBQUNoSCxPQUFPLEVBQUUsdUJBQXVCLEVBQUVQLE9BQU8sQ0FBQztJQUNqRjNDLE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsT0FBT2xELFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDeEI7RUFFQSxNQUFNOEwsVUFBVUEsQ0FBQ3RKLE9BQXNCLEVBQUVQLE9BQWdDLEVBQUU7SUFDekUsTUFBTWxDLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ3lKLFVBQVUsQ0FBQ2hILE9BQU8sRUFBRSxzQkFBc0IsRUFBRVAsT0FBTyxDQUFDO0lBQ2hGLElBQUksQ0FBQ2xDLFFBQVEsQ0FBQ2dDLEVBQUUsQ0FBQyxDQUFDLEVBQUU7TUFDbEIsTUFBTXdFLElBQUksR0FBRyxNQUFNekcsZ0JBQWdCLENBQUNDLFFBQVEsQ0FBQztNQUM3QyxNQUFNLElBQUkwRyxLQUFLLENBQUMsaUNBQWlDMUcsUUFBUSxDQUFDaUQsTUFBTSxDQUFDLENBQUMsS0FBS3lHLElBQUksQ0FBQ0MsU0FBUyxDQUFDbkQsSUFBSSxDQUFDLEVBQUUsQ0FBQztJQUNoRztJQUNBLE9BQU94RyxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQ3hCO0VBRUEsTUFBTStMLFlBQVlBLENBQUN2SixPQUFzQixFQUFFK0ksT0FBZSxFQUFFekIsTUFBYyxFQUFFO0lBQzFFLE1BQU0vSixRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUN5SixVQUFVLENBQUNoSCxPQUFPLEVBQUUsbUJBQW1CK0ksT0FBTyxTQUFTLEVBQUU7TUFBRXpCO0lBQU8sQ0FBQyxDQUFDO0lBQ2hHeEssTUFBTSxDQUFDUyxRQUFRLENBQUNnQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUNrQixVQUFVLENBQUMsQ0FBQztJQUNsQyxPQUFPbEQsUUFBUSxDQUFDQyxJQUFJLENBQUMsQ0FBQztFQUN4QjtFQUVBLE1BQU1nTSxvQkFBb0JBLENBQUN4SixPQUFzQixFQUFFUCxPQUFnQyxFQUFFO0lBQ25GLE1BQU1sQyxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUN5SixVQUFVLENBQUNoSCxPQUFPLEVBQUUsdUNBQXVDLEVBQUVQLE9BQU8sQ0FBQztJQUNqRzNDLE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsT0FBT2xELFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDeEI7RUFFQSxNQUFNaU0scUJBQXFCQSxDQUFDekosT0FBc0IsRUFBRTBKLFFBQWdCLEVBQUVDLE1BQWMsRUFBRUMsSUFBYSxFQUFFO0lBQ25HLE1BQU1yTSxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUM2SixTQUFTLENBQUNwSCxPQUFPLEVBQUUsMENBQTBDLEVBQUU7TUFBRTBKLFFBQVE7TUFBRUMsTUFBTTtNQUFFQztJQUFLLENBQUMsQ0FBQztJQUN0SDlNLE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsT0FBT2xELFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDeEI7RUFFQSxNQUFNcU0sa0JBQWtCQSxDQUFDN0osT0FBc0IsRUFBRVAsT0FBZ0MsRUFBRTtJQUNqRixNQUFNbEMsUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDeUosVUFBVSxDQUFDaEgsT0FBTyxFQUFFLHdDQUF3QyxFQUFFUCxPQUFPLENBQUM7SUFDbEczQyxNQUFNLENBQUNTLFFBQVEsQ0FBQ2dDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQ2tCLFVBQVUsQ0FBQyxDQUFDO0lBQ2xDLE9BQU9sRCxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQ3hCO0VBRUEsTUFBTXNNLHdCQUF3QkEsQ0FBQzlKLE9BQXNCLEVBQUUrSixNQUFjLEVBQUV6RSxJQUFZLEVBQUU7SUFDbkYsTUFBTS9ILFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQzJILFdBQVcsQ0FBQ2xGLE9BQU8sRUFBRSx5Q0FBeUMrSixNQUFNLEVBQUUsRUFBRTtNQUNsR0MsUUFBUSxFQUFFLEtBQUs7TUFDZnhKLE1BQU0sRUFBRSxXQUFXO01BQ25COEU7SUFDRixDQUFDLENBQUM7SUFDRnhJLE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsT0FBT2xELFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDeEI7RUFFQSxNQUFNeU0sdUJBQXVCQSxDQUFDN00sS0FBYSxFQUFFO0lBQzNDLE1BQU1HLFFBQVEsR0FBR0gsS0FBSyxHQUNsQixNQUFNLElBQUksQ0FBQ1EsR0FBRyxDQUFDVyxHQUFHLENBQUMsa0NBQWtDLEVBQUU7TUFBRUUsT0FBTyxFQUFFdEIsV0FBVyxDQUFDQyxLQUFLO0lBQUUsQ0FBQyxDQUFDLEdBQ3ZGLE1BQU0sSUFBSSxDQUFDOEcsUUFBUSxDQUFDLGtDQUFrQyxDQUFDO0lBQzNELElBQUkzRyxRQUFRLENBQUNpRCxNQUFNLENBQUMsQ0FBQyxLQUFLLEdBQUcsRUFBRTtNQUM3QixNQUFNMEosS0FBSyxHQUFHLE1BQU0sSUFBSSxDQUFDaEcsUUFBUSxDQUFDLGtDQUFrQyxDQUFDO01BQ3JFcEgsTUFBTSxDQUFDb04sS0FBSyxDQUFDM0ssRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7TUFDL0IsT0FBT3lKLEtBQUssQ0FBQzFNLElBQUksQ0FBQyxDQUFDO0lBQ3JCO0lBQ0FWLE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsT0FBT2xELFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDeEI7RUFFQSxNQUFNMk0sVUFBVUEsQ0FBQ25LLE9BQXNCLEVBQUVQLE9BQWdDLEVBQUU7SUFDekUsTUFBTWxDLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ3lKLFVBQVUsQ0FBQ2hILE9BQU8sRUFBRSxjQUFjLEVBQUVQLE9BQU8sQ0FBQztJQUN4RTNDLE1BQU0sQ0FBQ1MsUUFBUSxDQUFDZ0MsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDa0IsVUFBVSxDQUFDLENBQUM7SUFDbEMsT0FBT2xELFFBQVEsQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDeEI7RUFFQSxNQUFNNE0sWUFBWUEsQ0FBQ3BLLE9BQXNCLEVBQUVQLE9BQWdDLEVBQUU7SUFDM0UsTUFBTWxDLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ3lKLFVBQVUsQ0FBQ2hILE9BQU8sRUFBRSxpQkFBaUIsRUFBRVAsT0FBTyxDQUFDO0lBQzNFM0MsTUFBTSxDQUFDUyxRQUFRLENBQUNnQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUNrQixVQUFVLENBQUMsQ0FBQztJQUNsQyxPQUFPbEQsUUFBUSxDQUFDQyxJQUFJLENBQUMsQ0FBQztFQUN4QjtFQUVBLE1BQU02TSxzQkFBc0JBLENBQUNySyxPQUFzQixFQUFFO0lBQ25ELE1BQU16QyxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUM2SixTQUFTLENBQUNwSCxPQUFPLEVBQUUsZ0NBQWdDLENBQUM7SUFDaEZsRCxNQUFNLENBQUNTLFFBQVEsQ0FBQ2dDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQ2tCLFVBQVUsQ0FBQyxDQUFDO0lBQ2xDLE9BQU9sRCxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQ3hCO0VBRUEsTUFBTThNLHVCQUF1QkEsQ0FBQ3RLLE9BQXNCLEVBQUV1SyxPQUFlLEVBQUU7SUFDckUsTUFBTWhOLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ3lKLFVBQVUsQ0FBQ2hILE9BQU8sRUFBRSxxQ0FBcUMsRUFBRTtNQUFFdUs7SUFBUSxDQUFDLENBQUM7SUFDbkd6TixNQUFNLENBQUNTLFFBQVEsQ0FBQ2dDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQ2tCLFVBQVUsQ0FBQyxDQUFDO0lBQ2xDLE9BQU9sRCxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUFDO0VBQ3hCO0VBRUEsTUFBTWdOLG1CQUFtQkEsQ0FBQzdHLEtBQTJCLEVBQUU7SUFBQSxJQUFBOEcscUJBQUEsRUFBQUMscUJBQUE7SUFDckQsTUFBTUMsTUFBTSxHQUFHLE1BQU12SixPQUFPLENBQUNDLEdBQUcsQ0FBQyxDQUMvQixJQUFJLENBQUN6RCxHQUFHLENBQUNXLEdBQUcsQ0FBQywwQkFBMEIsRUFBRTtNQUN2Q0UsT0FBTyxFQUFFdEIsV0FBVyxDQUFDd0csS0FBSyxDQUFDNUMsS0FBSyxDQUFDZixPQUFPLENBQUM1QyxLQUFLO0lBQ2hELENBQUMsQ0FBQyxFQUNGLElBQUksQ0FBQ1EsR0FBRyxDQUFDVyxHQUFHLENBQUMsK0JBQStCLEVBQUU7TUFDNUNFLE9BQU8sRUFBRXRCLFdBQVcsQ0FBQ3dHLEtBQUssQ0FBQ1osTUFBTSxDQUFDckIsZUFBZSxDQUFDMUIsT0FBTyxDQUFDNUMsS0FBSztJQUNqRSxDQUFDLENBQUMsRUFDRixJQUFJLENBQUNRLEdBQUcsQ0FBQ1csR0FBRyxDQUFDLCtCQUErQixFQUFFO01BQzVDRSxPQUFPLEVBQUV0QixXQUFXLENBQUMsRUFBQXNOLHFCQUFBLEdBQUE5RyxLQUFLLENBQUNaLE1BQU0sQ0FBQ3BCLGlCQUFpQixjQUFBOEkscUJBQUEsdUJBQTlCQSxxQkFBQSxDQUFnQ3pLLE9BQU8sQ0FBQzVDLEtBQUssS0FBSXVHLEtBQUssQ0FBQ1osTUFBTSxDQUFDckIsZUFBZSxDQUFDMUIsT0FBTyxDQUFDNUMsS0FBSztJQUNsSCxDQUFDLENBQUMsRUFDRixJQUFJLENBQUNRLEdBQUcsQ0FBQ1csR0FBRyxDQUFDLDZCQUE2QixFQUFFO01BQzFDRSxPQUFPLEVBQUV0QixXQUFXLENBQUN3RyxLQUFLLENBQUNaLE1BQU0sQ0FBQ25CLGlCQUFpQixDQUFDNUIsT0FBTyxDQUFDNUMsS0FBSztJQUNuRSxDQUFDLENBQUMsRUFDRixJQUFJLENBQUNRLEdBQUcsQ0FBQ1csR0FBRyxDQUFDLDZCQUE2QixFQUFFO01BQzFDRSxPQUFPLEVBQUV0QixXQUFXLENBQUMsRUFBQXVOLHFCQUFBLEdBQUEvRyxLQUFLLENBQUNaLE1BQU0sQ0FBQ2YsaUJBQWlCLGNBQUEwSSxxQkFBQSx1QkFBOUJBLHFCQUFBLENBQWdDMUssT0FBTyxDQUFDNUMsS0FBSyxLQUFJdUcsS0FBSyxDQUFDWixNQUFNLENBQUNuQixpQkFBaUIsQ0FBQzVCLE9BQU8sQ0FBQzVDLEtBQUs7SUFDcEgsQ0FBQyxDQUFDLEVBQ0YsSUFBSSxDQUFDUSxHQUFHLENBQUNXLEdBQUcsQ0FBQyw2QkFBNkIsRUFBRTtNQUMxQ0UsT0FBTyxFQUFFdEIsV0FBVyxDQUFDd0csS0FBSyxDQUFDWixNQUFNLENBQUNkLGdCQUFnQixDQUFDakMsT0FBTyxDQUFDNUMsS0FBSztJQUNsRSxDQUFDLENBQUMsQ0FDSCxDQUFDO0lBQ0YsT0FBT3VOLE1BQU0sQ0FBQ0MsS0FBSyxDQUFFck4sUUFBUSxJQUFLQSxRQUFRLENBQUNnQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0VBQ2xEO0VBRUEsTUFBYzZILFNBQVNBLENBQ3JCcEgsT0FBc0IsRUFDdEJ4QixJQUFZLEVBQ1pVLE1BQW9ELEVBQ3BEO0lBQ0EsT0FBTyxJQUFJLENBQUMyTCxxQkFBcUIsQ0FBQzdLLE9BQU8sRUFBRzVDLEtBQUssSUFBSyxJQUFJLENBQUNRLEdBQUcsQ0FBQ1csR0FBRyxDQUFDQyxJQUFJLEVBQUU7TUFDdkVVLE1BQU07TUFDTlQsT0FBTyxFQUFFdEIsV0FBVyxDQUFDQyxLQUFLO0lBQzVCLENBQUMsQ0FBQyxDQUFDO0VBQ0w7RUFFQSxNQUFjNEosVUFBVUEsQ0FBQ2hILE9BQXNCLEVBQUV4QixJQUFZLEVBQUVHLElBQWMsRUFBRTtJQUM3RSxPQUFPLElBQUksQ0FBQ2tNLHFCQUFxQixDQUFDN0ssT0FBTyxFQUFHNUMsS0FBSyxJQUFLLElBQUksQ0FBQ1EsR0FBRyxDQUFDYyxJQUFJLENBQUNGLElBQUksRUFBRTtNQUN4RUcsSUFBSTtNQUNKRixPQUFPLEVBQUV0QixXQUFXLENBQUNDLEtBQUs7SUFDNUIsQ0FBQyxDQUFDLENBQUM7RUFDTDtFQUVBLE1BQWM4SCxXQUFXQSxDQUFDbEYsT0FBc0IsRUFBRXhCLElBQVksRUFBRUcsSUFBYyxFQUFFO0lBQzlFLE9BQU8sSUFBSSxDQUFDa00scUJBQXFCLENBQUM3SyxPQUFPLEVBQUc1QyxLQUFLLElBQUssSUFBSSxDQUFDUSxHQUFHLENBQUNnQixLQUFLLENBQUNKLElBQUksRUFBRTtNQUN6RUcsSUFBSTtNQUNKRixPQUFPLEVBQUV0QixXQUFXLENBQUNDLEtBQUs7SUFDNUIsQ0FBQyxDQUFDLENBQUM7RUFDTDtFQUVBLE1BQWN5TixxQkFBcUJBLENBQ2pDN0ssT0FBc0IsRUFDdEI4SyxPQUF3QyxFQUN4QztJQUNBLElBQUl2TixRQUFRLEdBQUcsTUFBTXVOLE9BQU8sQ0FBQzlLLE9BQU8sQ0FBQzVDLEtBQUssQ0FBQztJQUMzQyxJQUFJRyxRQUFRLENBQUNpRCxNQUFNLENBQUMsQ0FBQyxLQUFLLEdBQUcsRUFBRTtNQUM3QixPQUFPakQsUUFBUTtJQUNqQjtJQUVBLE1BQU0sSUFBSSxDQUFDaUgsb0JBQW9CLENBQUN4RSxPQUFPLENBQUM7SUFDeEMsT0FBTzhLLE9BQU8sQ0FBQzlLLE9BQU8sQ0FBQzVDLEtBQUssQ0FBQztFQUMvQjtFQUVBLE1BQWN1SCx3QkFBd0JBLENBQUMzRSxPQUFzQixFQUFpQztJQUM1RixNQUFNNkUsWUFBWSxHQUFHK0MsTUFBTSxDQUFDNUgsT0FBTyxDQUFDNkUsWUFBWSxJQUFJLEVBQUUsQ0FBQyxDQUFDa0csSUFBSSxDQUFDLENBQUM7SUFDOUQsTUFBTXRMLE9BQU8sR0FBR3VMLGlCQUFpQixDQUFDaEwsT0FBTyxDQUFDNUMsS0FBSyxDQUFDO0lBQ2hELE1BQU02TixRQUFRLEdBQUdyRCxNQUFNLENBQUMsQ0FBQW5JLE9BQU8sYUFBUEEsT0FBTyx1QkFBUEEsT0FBTyxDQUFFd0wsUUFBUSxLQUFJLEVBQUUsQ0FBQyxDQUFDRixJQUFJLENBQUMsQ0FBQztJQUN2RCxJQUFJLENBQUNsRyxZQUFZLElBQUksQ0FBQ29HLFFBQVEsRUFBRTtNQUM5QixPQUFPLElBQUk7SUFDYjtJQUVBLE1BQU0xTixRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUNLLEdBQUcsQ0FBQ2MsSUFBSSxDQUFDLHVCQUF1QixFQUFFO01BQzVEQyxJQUFJLEVBQUU7UUFDSmtHLFlBQVk7UUFDWm9HO01BQ0YsQ0FBQztNQUNEeE0sT0FBTyxFQUFFO1FBQ1AsY0FBYyxFQUFFLGtCQUFrQjtRQUNsQyxhQUFhLEVBQUV3TTtNQUNqQjtJQUNGLENBQUMsQ0FBQztJQUVGLElBQUksQ0FBQzFOLFFBQVEsQ0FBQ2dDLEVBQUUsQ0FBQyxDQUFDLEVBQUU7TUFDbEIsT0FBTyxJQUFJO0lBQ2I7SUFFQSxNQUFNd0UsSUFBSSxHQUFHLE1BQU14RyxRQUFRLENBQUNDLElBQUksQ0FBQyxDQUE4QztJQUMvRSxJQUFJLEVBQUN1RyxJQUFJLGFBQUpBLElBQUksZUFBSkEsSUFBSSxDQUFFM0csS0FBSyxHQUFFO01BQ2hCLE9BQU8sSUFBSTtJQUNiO0lBRUEsT0FBTztNQUNMLEdBQUc0QyxPQUFPO01BQ1Y1QyxLQUFLLEVBQUUyRyxJQUFJLENBQUMzRyxLQUFLO01BQ2pCeUgsWUFBWSxFQUFFZCxJQUFJLENBQUNjLFlBQVksSUFBSUE7SUFDckMsQ0FBQztFQUNIO0VBRUEsTUFBY25FLG1CQUFtQkEsQ0FBQSxFQUFHO0lBQ2xDLE1BQU1LLEtBQUssR0FBRyxNQUFNLElBQUksQ0FBQ1EsVUFBVSxDQUFDLENBQUM7SUFDckMsTUFBTTJKLFlBQVksR0FBRyxNQUFNLElBQUksQ0FBQzFKLGtCQUFrQixDQUFDLE1BQU0sQ0FBQztJQUMxRCxNQUFNMkosWUFBWSxHQUFHLE1BQU0sSUFBSSxDQUFDM0osa0JBQWtCLENBQUMsTUFBTSxDQUFDO0lBQzFELE1BQU00SixXQUFXLEdBQUcsTUFBTSxJQUFJLENBQUM1SixrQkFBa0IsQ0FBQyxLQUFLLENBQUM7SUFFeEQsTUFBTTZKLGNBQWMsR0FBRyxNQUFBQSxDQUFPcEwsS0FBYSxFQUFFcUwsUUFBZ0IsS0FBSztNQUNoRSxNQUFNQyxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUMzTixHQUFHLENBQUNjLElBQUksQ0FBQyx5QkFBeUIsRUFBRTtRQUM5REMsSUFBSSxFQUFFO1VBQ0pzQixLQUFLO1VBQ0w2RCxRQUFRLEVBQUU5RyxPQUFPLENBQUN1SCxrQkFBa0I7VUFDcENILFFBQVEsRUFBRTtRQUNaO01BQ0YsQ0FBQyxDQUFDO01BQ0YsSUFBSW1ILFFBQVEsQ0FBQ2hNLEVBQUUsQ0FBQyxDQUFDLEVBQUU7UUFDakIsT0FBT2dNLFFBQVEsQ0FBQy9OLElBQUksQ0FBQyxDQUFDO01BQ3hCO01BQ0EsSUFBSStOLFFBQVEsQ0FBQy9LLE1BQU0sQ0FBQyxDQUFDLEtBQUssR0FBRyxFQUFFO1FBQzdCLE1BQU0sSUFBSXlELEtBQUssQ0FBQyx1Q0FBdUNoRSxLQUFLLGtFQUFrRSxDQUFDO01BQ2pJO01BQ0EsSUFBSXNMLFFBQVEsQ0FBQy9LLE1BQU0sQ0FBQyxDQUFDLEtBQUssR0FBRyxFQUFFO1FBQzdCMUQsTUFBTSxDQUFDeU8sUUFBUSxDQUFDaE0sRUFBRSxDQUFDLENBQUMsRUFBRSx3Q0FBd0NnTSxRQUFRLENBQUMvSyxNQUFNLENBQUMsQ0FBQyxRQUFRUCxLQUFLLEVBQUUsQ0FBQyxDQUFDUSxVQUFVLENBQUMsQ0FBQztNQUM5RztNQUNBLE9BQU8sSUFBSSxDQUFDc0UsY0FBYyxDQUFDO1FBQ3pCOUUsS0FBSztRQUNMNkQsUUFBUSxFQUFFOUcsT0FBTyxDQUFDdUgsa0JBQWtCO1FBQ3BDK0csUUFBUTtRQUNSbEgsUUFBUSxFQUFFO01BQ1osQ0FBQyxDQUFDO0lBQ0osQ0FBQztJQUVELE1BQU1vSCxZQUFZLEdBQUcsTUFBT3RNLE1BTTNCLElBQUs7TUFDSixNQUFNcU0sUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDM04sR0FBRyxDQUFDYyxJQUFJLENBQUMseUJBQXlCLEVBQUU7UUFDOURDLElBQUksRUFBRTtVQUNKc0IsS0FBSyxFQUFFZixNQUFNLENBQUNlLEtBQUs7VUFDbkI2RCxRQUFRLEVBQUU5RyxPQUFPLENBQUN1SCxrQkFBa0I7VUFDcENILFFBQVEsRUFBRTtRQUNaO01BQ0YsQ0FBQyxDQUFDO01BRUYsSUFBSXBFLE9BQXNCO01BQzFCLElBQUl1TCxRQUFRLENBQUNoTSxFQUFFLENBQUMsQ0FBQyxFQUFFO1FBQ2pCUyxPQUFPLEdBQUcsTUFBTXVMLFFBQVEsQ0FBQy9OLElBQUksQ0FBQyxDQUFrQjtNQUNsRCxDQUFDLE1BQU07UUFDTCxJQUFJK04sUUFBUSxDQUFDL0ssTUFBTSxDQUFDLENBQUMsS0FBSyxHQUFHLEVBQUU7VUFDN0IsTUFBTSxJQUFJeUQsS0FBSyxDQUFDLHFDQUFxQy9FLE1BQU0sQ0FBQ2UsS0FBSyxrRUFBa0UsQ0FBQztRQUN0STtRQUNBLElBQUlzTCxRQUFRLENBQUMvSyxNQUFNLENBQUMsQ0FBQyxLQUFLLEdBQUcsRUFBRTtVQUM3QjFELE1BQU0sQ0FBQ3lPLFFBQVEsQ0FBQ2hNLEVBQUUsQ0FBQyxDQUFDLEVBQUUsc0NBQXNDZ00sUUFBUSxDQUFDL0ssTUFBTSxDQUFDLENBQUMsUUFBUXRCLE1BQU0sQ0FBQ2UsS0FBSyxFQUFFLENBQUMsQ0FBQ1EsVUFBVSxDQUFDLENBQUM7UUFDbkg7UUFDQVQsT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDK0UsY0FBYyxDQUFDO1VBQ2xDOUUsS0FBSyxFQUFFZixNQUFNLENBQUNlLEtBQUs7VUFDbkI2RCxRQUFRLEVBQUU5RyxPQUFPLENBQUN1SCxrQkFBa0I7VUFDcEMrRyxRQUFRLEVBQUVwTSxNQUFNLENBQUNvTSxRQUFRO1VBQ3pCbEgsUUFBUSxFQUFFO1FBQ1osQ0FBQyxDQUFDO01BQ0o7TUFFQSxNQUFNLElBQUksQ0FBQ2EsbUJBQW1CLENBQUNqRixPQUFPLEVBQUU7UUFDdENzTCxRQUFRLEVBQUVwTSxNQUFNLENBQUNvTSxRQUFRO1FBQ3pCRyxhQUFhLEVBQUV2TSxNQUFNLENBQUN1TSxhQUFhO1FBQ25DQyxZQUFZLEVBQUV4TSxNQUFNLENBQUN3TSxZQUFZO1FBQ2pDakYsaUJBQWlCLEVBQUV2SCxNQUFNLENBQUN1SDtNQUM1QixDQUFDLENBQUM7TUFDRixNQUFNLElBQUksQ0FBQ3RCLGFBQWEsQ0FBQ3BFLEtBQUssQ0FBQzNELEtBQUssRUFBRTRDLE9BQU8sQ0FBQzRFLElBQUksQ0FBQzhDLEVBQUUsRUFBRSwrQkFBK0J4SSxNQUFNLENBQUNlLEtBQUssRUFBRSxDQUFDO01BQ3JHLE9BQU9ELE9BQU87SUFDaEIsQ0FBQztJQUVELE1BQU1GLFNBQVMsR0FBRyxNQUFNc0IsT0FBTyxDQUFDQyxHQUFHLENBQUMsQ0FDbENnSyxjQUFjLENBQUNyTyxPQUFPLENBQUNtRixpQkFBaUIsRUFBRSxvQkFBb0IsQ0FBQyxFQUMvRGtKLGNBQWMsQ0FBQ3JPLE9BQU8sQ0FBQ29GLGtCQUFrQixFQUFFLG9CQUFvQixDQUFDLENBQ2pFLENBQUM7SUFFRixNQUFNL0IsT0FBTyxHQUFHLE1BQU1lLE9BQU8sQ0FBQ0MsR0FBRyxDQUFDLENBQ2hDbUssWUFBWSxDQUFDO01BQ1h2TCxLQUFLLEVBQUVqRCxPQUFPLENBQUNxRixtQkFBbUI7TUFDbENpSixRQUFRLEVBQUUsdUJBQXVCO01BQ2pDN0UsaUJBQWlCLEVBQUV5RSxZQUFZLENBQUN4RCxFQUFFO01BQ2xDK0QsYUFBYSxFQUFFLFlBQVk7TUFDM0JDLFlBQVksRUFBRTtJQUNoQixDQUFDLENBQUMsRUFDRkYsWUFBWSxDQUFDO01BQ1h2TCxLQUFLLEVBQUUsWUFBWTtNQUNuQnFMLFFBQVEsRUFBRSx1QkFBdUI7TUFDakM3RSxpQkFBaUIsRUFBRXlFLFlBQVksQ0FBQ3hELEVBQUU7TUFDbEMrRCxhQUFhLEVBQUUsWUFBWTtNQUMzQkMsWUFBWSxFQUFFO0lBQ2hCLENBQUMsQ0FBQyxFQUNGRixZQUFZLENBQUM7TUFDWHZMLEtBQUssRUFBRSxZQUFZO01BQ25CcUwsUUFBUSxFQUFFLHVCQUF1QjtNQUNqQzdFLGlCQUFpQixFQUFFeUUsWUFBWSxDQUFDeEQsRUFBRTtNQUNsQytELGFBQWEsRUFBRSxZQUFZO01BQzNCQyxZQUFZLEVBQUU7SUFDaEIsQ0FBQyxDQUFDLEVBQ0ZGLFlBQVksQ0FBQztNQUNYdkwsS0FBSyxFQUFFLFlBQVk7TUFDbkJxTCxRQUFRLEVBQUUsdUJBQXVCO01BQ2pDN0UsaUJBQWlCLEVBQUV5RSxZQUFZLENBQUN4RCxFQUFFO01BQ2xDK0QsYUFBYSxFQUFFLFlBQVk7TUFDM0JDLFlBQVksRUFBRTtJQUNoQixDQUFDLENBQUMsRUFDRkYsWUFBWSxDQUFDO01BQ1h2TCxLQUFLLEVBQUVqRCxPQUFPLENBQUNzRixtQkFBbUI7TUFDbENnSixRQUFRLEVBQUUsdUJBQXVCO01BQ2pDN0UsaUJBQWlCLEVBQUUwRSxZQUFZLENBQUN6RCxFQUFFO01BQ2xDK0QsYUFBYSxFQUFFLFlBQVk7TUFDM0JDLFlBQVksRUFBRTtJQUNoQixDQUFDLENBQUMsRUFDRkYsWUFBWSxDQUFDO01BQ1h2TCxLQUFLLEVBQUVqRCxPQUFPLENBQUN1RixrQkFBa0I7TUFDakMrSSxRQUFRLEVBQUUsc0JBQXNCO01BQ2hDN0UsaUJBQWlCLEVBQUUyRSxXQUFXLENBQUMxRCxFQUFFO01BQ2pDK0QsYUFBYSxFQUFFLFlBQVk7TUFDM0JDLFlBQVksRUFBRTtJQUNoQixDQUFDLENBQUMsQ0FDSCxDQUFDO0lBRUYsT0FBTztNQUNMQyxPQUFPLEVBQUUsSUFBSTtNQUNicEwsYUFBYSxFQUFFLFVBQW1CO01BQ2xDcUwsUUFBUSxFQUFFLElBQUk7TUFDZDdLLEtBQUssRUFBRUEsS0FBSyxDQUFDQSxLQUFLLENBQUM2QyxLQUFLO01BQ3hCOUQsU0FBUyxFQUFFQSxTQUFTLENBQUMrTCxHQUFHLENBQUVDLFFBQVEsSUFBS0EsUUFBUSxDQUFDbEgsSUFBSSxDQUFDM0UsS0FBSyxDQUFDO01BQzNESSxPQUFPLEVBQUVBLE9BQU8sQ0FBQ3dMLEdBQUcsQ0FBRUUsTUFBTSxJQUFLQSxNQUFNLENBQUNuSCxJQUFJLENBQUMzRSxLQUFLO0lBQ3BELENBQUM7RUFDSDtFQUVRRSxpQkFBaUJBLENBQUNGLEtBQWEsRUFBRW1FLFFBQStCLEVBQUU7SUFDeEUsT0FBTyxHQUFHQSxRQUFRLElBQUluRSxLQUFLLEVBQUU7RUFDL0I7RUFFQSxNQUFjaEIsa0JBQWtCQSxDQUM5QjZMLE9BQXlCLEVBQ3pCa0IsT0FBd0UsRUFDNUQ7SUFDWixJQUFJQyxPQUFPLEdBQUcsQ0FBQztJQUNmLFNBQVM7TUFDUCxNQUFNMU8sUUFBUSxHQUFHLE1BQU11TixPQUFPLENBQUMsQ0FBQztNQUNoQyxNQUFNdEssTUFBTSxHQUFHLElBQUksQ0FBQzBMLFVBQVUsQ0FBQzNPLFFBQVEsQ0FBQztNQUN4QyxJQUFJaUQsTUFBTSxLQUFLLElBQUksSUFBSSxDQUFDd0wsT0FBTyxDQUFDMU0sYUFBYSxDQUFDZ0gsUUFBUSxDQUFDOUYsTUFBTSxDQUFDLElBQUl5TCxPQUFPLElBQUlELE9BQU8sQ0FBQzVNLE9BQU8sRUFBRTtRQUM1RixPQUFPN0IsUUFBUTtNQUNqQjtNQUNBLE1BQU00TyxZQUFZLEdBQUcsSUFBSSxDQUFDQyxnQkFBZ0IsQ0FBQzdPLFFBQVEsQ0FBQztNQUNwRCxNQUFNOE8sT0FBTyxHQUFHRixZQUFZLGFBQVpBLFlBQVksY0FBWkEsWUFBWSxHQUFLSCxPQUFPLENBQUMzTSxTQUFTLElBQUk0TSxPQUFPLEdBQUcsQ0FBQyxDQUFFO01BQ25FLE1BQU0sSUFBSTdLLE9BQU8sQ0FBRUUsT0FBTyxJQUFLZ0wsVUFBVSxDQUFDaEwsT0FBTyxFQUFFK0ssT0FBTyxDQUFDLENBQUM7TUFDNURKLE9BQU8sSUFBSSxDQUFDO0lBQ2Q7RUFDRjtFQUVRQyxVQUFVQSxDQUFDM08sUUFBaUIsRUFBRTtJQUNwQyxJQUFJLENBQUNBLFFBQVEsSUFBSSxPQUFPQSxRQUFRLEtBQUssUUFBUSxFQUFFLE9BQU8sSUFBSTtJQUMxRCxNQUFNZ1AsU0FBUyxHQUFHaFAsUUFBZ0M7SUFDbEQsSUFBSSxPQUFPZ1AsU0FBUyxDQUFDL0wsTUFBTSxLQUFLLFVBQVUsRUFBRTtNQUMxQyxPQUFPZ00sTUFBTSxDQUFDRCxTQUFTLENBQUMvTCxNQUFNLENBQUMsQ0FBQyxDQUFDO0lBQ25DO0lBQ0EsSUFBSSxPQUFPK0wsU0FBUyxDQUFDL0wsTUFBTSxLQUFLLFFBQVEsRUFBRTtNQUN4QyxPQUFPK0wsU0FBUyxDQUFDL0wsTUFBTTtJQUN6QjtJQUNBLE9BQU8sSUFBSTtFQUNiO0VBRVE0TCxnQkFBZ0JBLENBQUM3TyxRQUFpQixFQUFFO0lBQzFDLElBQUksQ0FBQ0EsUUFBUSxJQUFJLE9BQU9BLFFBQVEsS0FBSyxRQUFRLEVBQUUsT0FBTyxJQUFJO0lBQzFELE1BQU1nUCxTQUFTLEdBQUdoUCxRQUFpQztJQUNuRCxJQUFJLE9BQU9nUCxTQUFTLENBQUM5TixPQUFPLEtBQUssVUFBVSxFQUFFLE9BQU8sSUFBSTtJQUN4RCxNQUFNQSxPQUFPLEdBQUc4TixTQUFTLENBQUM5TixPQUFPLENBQUMsQ0FBMkI7SUFDN0QsTUFBTWdPLFVBQVUsR0FBR2hPLE9BQU8sQ0FBQyxhQUFhLENBQUMsSUFBSUEsT0FBTyxDQUFDLGFBQWEsQ0FBQztJQUNuRSxJQUFJLENBQUNnTyxVQUFVLEVBQUUsT0FBTyxJQUFJO0lBRTVCLE1BQU1DLE9BQU8sR0FBR0YsTUFBTSxDQUFDQyxVQUFVLENBQUM7SUFDbEMsSUFBSUQsTUFBTSxDQUFDRyxRQUFRLENBQUNELE9BQU8sQ0FBQyxJQUFJQSxPQUFPLEdBQUcsQ0FBQyxFQUFFO01BQzNDLE9BQU9BLE9BQU8sR0FBRyxJQUFLO0lBQ3hCO0lBRUEsTUFBTUUsTUFBTSxHQUFHaEssSUFBSSxDQUFDaUssS0FBSyxDQUFDSixVQUFVLENBQUM7SUFDckMsSUFBSUQsTUFBTSxDQUFDTSxLQUFLLENBQUNGLE1BQU0sQ0FBQyxFQUFFLE9BQU8sSUFBSTtJQUNyQyxPQUFPRyxJQUFJLENBQUNDLEdBQUcsQ0FBQyxJQUFLLEVBQUVKLE1BQU0sR0FBR2hLLElBQUksQ0FBQ3NHLEdBQUcsQ0FBQyxDQUFDLENBQUM7RUFDN0M7QUFDRjtBQUVBLFNBQVM4QixpQkFBaUJBLENBQUM1TixLQUF5QixFQUE2QjtFQUMvRSxJQUFJLENBQUNBLEtBQUssRUFBRSxPQUFPLElBQUk7RUFDdkIsTUFBTTZQLEtBQUssR0FBRzdQLEtBQUssQ0FBQzhQLEtBQUssQ0FBQyxHQUFHLENBQUM7RUFDOUIsSUFBSUQsS0FBSyxDQUFDRSxNQUFNLEdBQUcsQ0FBQyxFQUFFLE9BQU8sSUFBSTtFQUNqQyxJQUFJO0lBQ0YsT0FBT2xHLElBQUksQ0FBQzRGLEtBQUssQ0FBQ08sTUFBTSxDQUFDQyxJQUFJLENBQUNKLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRSxXQUFXLENBQUMsQ0FBQ0ssUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0VBQ3hFLENBQUMsQ0FBQyxNQUFNO0lBQ04sT0FBTyxJQUFJO0VBQ2I7QUFDRiIsImlnbm9yZUxpc3QiOltdfQ==