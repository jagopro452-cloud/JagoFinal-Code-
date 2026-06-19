const BASE_URL = "http://127.0.0.1:5000";
const PASSWORD = "Greeshmant@2023";

async function api(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function login(phone, userType) {
  return api("/api/app/login-password", {
    method: "POST",
    body: { phone, password: PASSWORD, userType },
  });
}

const driver = await login("9100000009", "driver");
const customer = await login("9000000001", "customer");

const diag = {
  driverLogin: driver.status,
  customerLogin: customer.status,
};

if (driver.status === 200) {
  const token = driver.data.token;
  const [eligible, categories, startNoCategory] = await Promise.all([
    api("/api/app/driver/eligible-services", { token }),
    api("/api/app/vehicle-categories", { token }),
    api("/api/app/driver/pool/session/start", { method: "POST", token, body: { maxSeats: 4 } }),
  ]);
  diag.driverEligible = eligible.data;
  diag.categories = Array.isArray(categories.data) ? categories.data.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    vehicleType: c.vehicleType,
    serviceType: c.serviceType,
    isCarpool: c.isCarpool,
  })) : categories.data;
  diag.startNoCategory = { status: startNoCategory.status, data: startNoCategory.data };
}

console.log(JSON.stringify(diag, null, 2));
