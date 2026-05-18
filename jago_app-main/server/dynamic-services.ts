/**
 * Dynamic Services & Parcel Vehicles Engine
 * 
 * Controls service visibility per city, parcel vehicle configs,
 * and provides the unified API for customer/driver apps.
 */

import { db as rawDb } from "./db";
import { sql as rawSql } from "drizzle-orm";

// ════════════════════════════════════════════════════════════════════════════
//  DB TABLE INIT
// ════════════════════════════════════════════════════════════════════════════

export async function initDynamicServicesTables(): Promise<void> {
  // ── City-based service availability ─────────────────────────────────────
  await rawDb.execute(rawSql`
    CREATE TABLE IF NOT EXISTS city_services (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      city_name VARCHAR(100) NOT NULL,
      city_lat NUMERIC(10,7),
      city_lng NUMERIC(10,7),
      radius_km NUMERIC(8,2) DEFAULT 30,
      service_key VARCHAR(50) NOT NULL,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(city_name, service_key)
    );
    CREATE INDEX IF NOT EXISTS idx_city_services_city ON city_services(city_name);
    CREATE INDEX IF NOT EXISTS idx_city_services_key ON city_services(service_key);
  `).catch(() => {});

  // ── Service images (admin-uploadable) ──────────────────────────────────
  await rawDb.execute(rawSql`
    ALTER TABLE platform_services ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT '';
    ALTER TABLE platform_services ADD COLUMN IF NOT EXISTS short_description TEXT DEFAULT '';
    ALTER TABLE platform_services ADD COLUMN IF NOT EXISTS eta_label VARCHAR(50) DEFAULT '';
  `).catch(() => {});

  // ── Dynamic parcel vehicles ─────────────────────────────────────────────
  await rawDb.execute(rawSql`
    CREATE TABLE IF NOT EXISTS parcel_vehicle_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_key VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      subtitle VARCHAR(200) DEFAULT '',
      icon VARCHAR(20) DEFAULT '📦',
      image_url TEXT DEFAULT '',
      capacity_label VARCHAR(50) DEFAULT '',
      max_weight_kg NUMERIC(10,2) DEFAULT 10,
      suitable_items TEXT DEFAULT '',
      accent_color VARCHAR(20) DEFAULT '#2F7BFF',
      base_fare NUMERIC(10,2) DEFAULT 40,
      per_km NUMERIC(10,2) DEFAULT 12,
      per_kg NUMERIC(10,2) DEFAULT 4,
      load_charge NUMERIC(10,2) DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_parcel_vehicles_active ON parcel_vehicle_types(is_active);
  `).catch(() => {});

  // ── City-based parcel vehicle availability ──────────────────────────────
  await rawDb.execute(rawSql`
    CREATE TABLE IF NOT EXISTS city_parcel_vehicles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      city_name VARCHAR(100) NOT NULL,
      vehicle_key VARCHAR(50) NOT NULL,
      is_active BOOLEAN DEFAULT true,
      eta_minutes INTEGER DEFAULT 5,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(city_name, vehicle_key)
    );
  `).catch(() => {});

  // ── Seed default parcel vehicles ────────────────────────────────────────
  await rawDb.execute(rawSql`
    INSERT INTO parcel_vehicle_types
      (vehicle_key, name, subtitle, icon, capacity_label, max_weight_kg, suitable_items, accent_color,
       base_fare, per_km, per_kg, load_charge, is_active, sort_order)
    VALUES
      ('bike_parcel', 'Bike Parcel', 'Fast & lightweight delivery', '🏍️', 'Up to 10 kg', 10,
       'Documents · Small boxes · Groceries · Medicine', '#2F7BFF', 40, 12, 4, 0, true, 1),
      ('auto_parcel', 'Cargo Auto', 'Medium loads in 3-wheeler', '🛺', 'Up to 50 kg', 50,
       'Medium boxes · Small furniture · Shop supplies', '#F59E0B', 50, 13, 7, 0, true, 2),
      ('tata_ace', 'Mini Truck', 'Tata Ace · Medium goods', '🚛', 'Up to 500 kg', 500,
       'Furniture · Appliances · Bulk items · Shop stock', '#FF6B35', 150, 18, 2, 50, true, 3),
      ('bolero_cargo', 'Bolero Pickup', 'Heavy-duty pickup truck', '🚙', 'Up to 1,500 kg', 1500,
       'Construction · Heavy equipment · Large shipments', '#8B5CF6', 200, 22, 3, 80, true, 5),
      ('pickup_truck', 'Pickup Truck', 'Large heavy goods transport', '🛻', 'Up to 2,000 kg', 2000,
       'Heavy machinery · Construction · Business logistics', '#7C3AED', 200, 22, 1, 100, true, 4),
      ('tempo_407', 'Tempo 407', 'Large commercial goods transport', '🚚', 'Up to 2,500 kg', 2500,
       'Factory goods · Full shifting · Large shipments', '#0F766E', 800, 28, 1, 150, true, 6)
    ON CONFLICT (vehicle_key) DO NOTHING;
  `).catch(() => {});
  await rawDb.execute(rawSql`
    UPDATE parcel_vehicle_types
    SET is_active=false
    WHERE vehicle_key IN ('cargo_' || 'car', 'car_' || 'parcel', 'parcel_' || 'car')
  `).catch(() => {});

  // ── Seed default cities ─────────────────────────────────────────────────
  const defaultCities = [
    { name: 'Vijayawada', lat: 16.5062, lng: 80.6480 },
    { name: 'Hyderabad', lat: 17.3850, lng: 78.4867 },
    { name: 'Guntur', lat: 16.3067, lng: 80.4365 },
  ];
  const defaultServices = ['bike_ride', 'parcel_delivery'];

  for (const city of defaultCities) {
    for (const svc of defaultServices) {
      await rawDb.execute(rawSql`
        INSERT INTO city_services (city_name, city_lat, city_lng, service_key, is_active)
        VALUES (${city.name}, ${city.lat}, ${city.lng}, ${svc}, true)
        ON CONFLICT (city_name, service_key) DO NOTHING
      `).catch(() => {});
    }
  }

  console.log("[DYNAMIC-SVC] Tables and seeds initialized");
}

// ════════════════════════════════════════════════════════════════════════════
//  CITY DETECTION
// ════════════════════════════════════════════════════════════════════════════

interface CityMatch {
  cityName: string;
  lat: number;
  lng: number;
  radiusKm: number;
}

/**
 * Find the closest city for given coordinates.
 * Uses Haversine within the radius_km configured for each city.
 */
export async function detectCity(lat: number, lng: number): Promise<CityMatch | null> {
  try {
    const r = await rawDb.execute(rawSql`
      SELECT DISTINCT city_name, city_lat, city_lng, radius_km,
        (6371 * acos(
          cos(radians(${lat})) * cos(radians(city_lat)) *
          cos(radians(city_lng) - radians(${lng})) +
          sin(radians(${lat})) * sin(radians(city_lat))
        )) AS distance_km
      FROM city_services
      WHERE city_lat IS NOT NULL AND city_lng IS NOT NULL
      ORDER BY distance_km ASC
      LIMIT 1
    `);
    if (!r.rows.length) return null;
    const row = r.rows[0] as any;
    const dist = Number(row.distance_km) || 0;
    const radius = Number(row.radius_km) || 30;
    if (dist > radius) return null;
    return {
      cityName: row.city_name,
      lat: Number(row.city_lat),
      lng: Number(row.city_lng),
      radiusKm: radius,
    };
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  LOCATION-BASED SERVICES
// ════════════════════════════════════════════════════════════════════════════

export interface DynamicService {
  key: string;
  name: string;
  icon: string;
  color: string;
  description: string;
  shortDescription: string;
  imageUrl: string;
  etaLabel: string;
  category: string;
  revenueModel: string;
}

/**
 * Get services available at a given location.
 * Falls back to globally active services if no city match.
 */
export async function getServicesForLocation(
  lat?: number, lng?: number
): Promise<{ services: DynamicService[]; city: string | null }> {
  let cityName: string | null = null;

  if (lat && lng) {
    const city = await detectCity(lat, lng);
    cityName = city?.cityName || null;
  }

  let query;
  if (cityName) {
    // Get services active in this city
    query = rawSql`
      SELECT ps.service_key as key, ps.service_name as name, ps.icon, ps.color,
        ps.description, COALESCE(ps.short_description, '') as short_description,
        COALESCE(ps.image_url, '') as image_url, COALESCE(ps.eta_label, '') as eta_label,
        ps.service_category as category, ps.revenue_model
      FROM platform_services ps
      INNER JOIN city_services cs ON cs.service_key = ps.service_key
      WHERE ps.service_status = 'active'
        AND cs.city_name = ${cityName}
        AND cs.is_active = true
      ORDER BY ps.sort_order ASC
    `;
  } else {
    // No city match — return globally active services
    query = rawSql`
      SELECT service_key as key, service_name as name, icon, color,
        description, COALESCE(short_description, '') as short_description,
        COALESCE(image_url, '') as image_url, COALESCE(eta_label, '') as eta_label,
        service_category as category, revenue_model
      FROM platform_services
      WHERE service_status = 'active'
      ORDER BY sort_order ASC
    `;
  }

  const r = await rawDb.execute(query);
  const services: DynamicService[] = (r.rows as any[]).map(row => ({
    key: row.key,
    name: row.name,
    icon: row.icon || '🚗',
    color: row.color || '#2F80ED',
    description: row.description || '',
    shortDescription: row.short_description || '',
    imageUrl: row.image_url || '',
    etaLabel: row.eta_label || '',
    category: row.category || 'rides',
    revenueModel: row.revenue_model || 'commission',
  }));

  return { services, city: cityName };
}

// ════════════════════════════════════════════════════════════════════════════
//  DYNAMIC PARCEL VEHICLES
// ════════════════════════════════════════════════════════════════════════════

export interface ParcelVehicleType {
  key: string;
  name: string;
  subtitle: string;
  icon: string;
  imageUrl: string;
  capacityLabel: string;
  maxWeightKg: number;
  suitableItems: string;
  accentColor: string;
  baseFare: number;
  perKm: number;
  perKg: number;
  loadCharge: number;
  etaMinutes: number;
}

/**
 * Get parcel vehicles available at a location.
 * City-specific filtering with ETA, falls back to globally active vehicles.
 */
export async function getParcelVehiclesForLocation(
  lat?: number, lng?: number
): Promise<{ vehicles: ParcelVehicleType[]; city: string | null }> {
  let cityName: string | null = null;

  if (lat && lng) {
    const city = await detectCity(lat, lng);
    cityName = city?.cityName || null;
  }

  let query;
  if (cityName) {
    query = rawSql`
      SELECT pv.vehicle_key as key, pv.name, pv.subtitle, pv.icon,
        COALESCE(pv.image_url, '') as image_url, pv.capacity_label,
        pv.max_weight_kg, pv.suitable_items, pv.accent_color,
        pv.base_fare, pv.per_km, pv.per_kg, pv.load_charge,
        COALESCE(cpv.eta_minutes, 5) as eta_minutes
      FROM parcel_vehicle_types pv
      LEFT JOIN city_parcel_vehicles cpv
        ON cpv.vehicle_key = pv.vehicle_key AND cpv.city_name = ${cityName}
      WHERE pv.is_active = true
        AND (cpv.is_active IS NULL OR cpv.is_active = true)
      ORDER BY pv.sort_order ASC
    `;
  } else {
    query = rawSql`
      SELECT vehicle_key as key, name, subtitle, icon,
        COALESCE(image_url, '') as image_url, capacity_label,
        max_weight_kg, suitable_items, accent_color,
        base_fare, per_km, per_kg, load_charge, 5 as eta_minutes
      FROM parcel_vehicle_types
      WHERE is_active = true
      ORDER BY sort_order ASC
    `;
  }

  const r = await rawDb.execute(query);
  const vehicles: ParcelVehicleType[] = (r.rows as any[]).map(row => ({
    key: row.key,
    name: row.name,
    subtitle: row.subtitle || '',
    icon: row.icon || '📦',
    imageUrl: row.image_url || '',
    capacityLabel: row.capacity_label || '',
    maxWeightKg: Number(row.max_weight_kg) || 10,
    suitableItems: row.suitable_items || '',
    accentColor: row.accent_color || '#2F7BFF',
    baseFare: Number(row.base_fare) || 40,
    perKm: Number(row.per_km) || 12,
    perKg: Number(row.per_kg) || 4,
    loadCharge: Number(row.load_charge) || 0,
    etaMinutes: Number(row.eta_minutes) || 5,
  }));

  return { vehicles, city: cityName };
}

/**
 * Recommend best vehicle for given weight/dimensions.
 */
export function recommendVehicle(
  vehicles: ParcelVehicleType[], weightKg: number
): ParcelVehicleType | null {
  // Find smallest vehicle that can carry the weight
  const sorted = [...vehicles].sort((a, b) => a.maxWeightKg - b.maxWeightKg);
  return sorted.find(v => v.maxWeightKg >= weightKg) || sorted[sorted.length - 1] || null;
}

// ════════════════════════════════════════════════════════════════════════════
//  DRIVER SERVICE ELIGIBILITY
// ════════════════════════════════════════════════════════════════════════════

export interface DriverServiceConfig {
  services: DynamicService[];
  parcelVehicles: ParcelVehicleType[];
}

/**
 * Get services a driver is eligible for based on their vehicle type.
 */
export async function getDriverEligibleServices(
  driverId: string
): Promise<DriverServiceConfig> {
  // Determine driver's vehicle type
  const driverR = await rawDb.execute(rawSql`
    SELECT dd.vehicle_type, vc.name as vehicle_name, vc.vehicle_type as vehicle_type_code
    FROM users u
    LEFT JOIN driver_details dd ON dd.user_id = u.id
    LEFT JOIN vehicle_categories vc ON vc.id = dd.vehicle_category_id
    WHERE u.id = ${driverId}::uuid
  `);

  const driver = driverR.rows[0] as any;
  if (!driver) return { services: [], parcelVehicles: [] };

  const vehicleName = (driver.vehicle_name || driver.vehicle_type || '').toLowerCase();
  const vehicleCode = (driver.vehicle_type_code || '').toLowerCase();

  // Get all active services
  const svcR = await rawDb.execute(rawSql`
    SELECT service_key as key, service_name as name, icon, color,
      description, COALESCE(short_description, '') as short_description,
      COALESCE(image_url, '') as image_url, COALESCE(eta_label, '') as eta_label,
      service_category as category, revenue_model
    FROM platform_services WHERE service_status = 'active'
    ORDER BY sort_order ASC
  `);

  // Determine eligible services based on vehicle
  const allServices = (svcR.rows as any[]).map(row => ({
    key: row.key, name: row.name, icon: row.icon || '🚗', color: row.color || '#2F80ED',
    description: row.description || '', shortDescription: row.short_description || '',
    imageUrl: row.image_url || '', etaLabel: row.eta_label || '',
    category: row.category || 'rides', revenueModel: row.revenue_model || 'commission',
  }));

  const eligibleServices: DynamicService[] = [];
  const eligibleParcelKeys: string[] = [];

  for (const svc of allServices) {
    if (svc.category === 'rides') {
      // Match ride service to vehicle type
      if (svc.key === 'bike_ride' && (vehicleName.includes('bike') || vehicleCode === 'bike')) {
        eligibleServices.push(svc);
      } else if (svc.key === 'auto_ride' && (vehicleName.includes('auto') || vehicleCode === 'auto')) {
        eligibleServices.push(svc);
      } else if (['mini_car', 'sedan', 'suv'].includes(svc.key) &&
        (vehicleName.includes('car') || vehicleName.includes('sedan') || vehicleName.includes('suv') ||
         vehicleCode === 'car' || vehicleCode === 'sedan' || vehicleCode === 'suv')) {
        eligibleServices.push(svc);
      }
    } else if (svc.category === 'parcel') {
      // All drivers can do parcel based on their vehicle capacity
      eligibleServices.push(svc);
      if (vehicleName.includes('bike') || vehicleCode === 'bike') {
        eligibleParcelKeys.push('bike_parcel');
      }
      if (vehicleName.includes('auto') || vehicleCode === 'auto') {
        eligibleParcelKeys.push('auto_parcel');
      }
      if (vehicleName.includes('truck') || vehicleName.includes('ace') || vehicleName.includes('bolero')) {
        eligibleParcelKeys.push('tata_ace', 'bolero_cargo', 'pickup_truck', 'tempo_407');
      }
    } else if (svc.category === 'carpool') {
      // Carpool available for car/sedan/suv
      if (vehicleName.includes('car') || vehicleName.includes('sedan') || vehicleName.includes('suv') ||
          vehicleCode === 'car' || vehicleCode === 'sedan' || vehicleCode === 'suv') {
        eligibleServices.push(svc);
      }
    }
  }

  // Get matching parcel vehicles
  let parcelVehicles: ParcelVehicleType[] = [];
  if (eligibleParcelKeys.length > 0) {
    const parcelKeyArray = rawSql.raw(
      `ARRAY[${eligibleParcelKeys.map((key) => `'${key.replace(/'/g, "''")}'`).join(",")}]::text[]`
    );
    const pvR = await rawDb.execute(rawSql`
      SELECT vehicle_key as key, name, subtitle, icon,
        COALESCE(image_url, '') as image_url, capacity_label,
        max_weight_kg, suitable_items, accent_color,
        base_fare, per_km, per_kg, load_charge, 5 as eta_minutes
      FROM parcel_vehicle_types
      WHERE is_active = true AND vehicle_key = ANY(${parcelKeyArray})
      ORDER BY sort_order ASC
    `);
    parcelVehicles = (pvR.rows as any[]).map(row => ({
      key: row.key, name: row.name, subtitle: row.subtitle || '', icon: row.icon || '📦',
      imageUrl: row.image_url || '', capacityLabel: row.capacity_label || '',
      maxWeightKg: Number(row.max_weight_kg) || 10, suitableItems: row.suitable_items || '',
      accentColor: row.accent_color || '#2F7BFF', baseFare: Number(row.base_fare) || 40,
      perKm: Number(row.per_km) || 12, perKg: Number(row.per_kg) || 4,
      loadCharge: Number(row.load_charge) || 0, etaMinutes: Number(row.eta_minutes) || 5,
    }));
  }

  return { services: eligibleServices, parcelVehicles };
}

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN: CITY SERVICE MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

export async function getCitiesWithServices(): Promise<any[]> {
  const r = await rawDb.execute(rawSql`
    SELECT cs.city_name, cs.city_lat, cs.city_lng, cs.radius_km,
      json_agg(json_build_object(
        'service_key', cs.service_key,
        'is_active', cs.is_active,
        'service_name', COALESCE(ps.service_name, cs.service_key),
        'icon', COALESCE(ps.icon, '🚗')
      ) ORDER BY ps.sort_order) as services
    FROM city_services cs
    LEFT JOIN platform_services ps ON ps.service_key = cs.service_key
    GROUP BY cs.city_name, cs.city_lat, cs.city_lng, cs.radius_km
    ORDER BY cs.city_name
  `);
  return r.rows as any[];
}

export async function addCityService(
  cityName: string, cityLat: number, cityLng: number, serviceKey: string, radiusKm: number = 30
): Promise<void> {
  await rawDb.execute(rawSql`
    INSERT INTO city_services (city_name, city_lat, city_lng, service_key, radius_km, is_active)
    VALUES (${cityName}, ${cityLat}, ${cityLng}, ${serviceKey}, ${radiusKm}, true)
    ON CONFLICT (city_name, service_key) DO UPDATE SET is_active = true, updated_at = NOW()
  `);
}

export async function toggleCityService(
  cityName: string, serviceKey: string, isActive: boolean
): Promise<void> {
  await rawDb.execute(rawSql`
    UPDATE city_services SET is_active = ${isActive}, updated_at = NOW()
    WHERE city_name = ${cityName} AND service_key = ${serviceKey}
  `);
}

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN: PARCEL VEHICLE MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

export async function getAllParcelVehicles(): Promise<any[]> {
  const r = await rawDb.execute(rawSql`
    SELECT * FROM parcel_vehicle_types ORDER BY sort_order ASC
  `);
  return r.rows as any[];
}

export async function updateParcelVehicle(
  vehicleKey: string, updates: Record<string, any>
): Promise<void> {
  const fields: string[] = [];
  const { name, subtitle, icon, image_url, capacity_label, max_weight_kg,
    suitable_items, accent_color, base_fare, per_km, per_kg, load_charge,
    is_active, sort_order } = updates;

  // Build dynamic update
  await rawDb.execute(rawSql`
    UPDATE parcel_vehicle_types SET
      name = COALESCE(${name ?? null}, name),
      subtitle = COALESCE(${subtitle ?? null}, subtitle),
      icon = COALESCE(${icon ?? null}, icon),
      image_url = COALESCE(${image_url ?? null}, image_url),
      capacity_label = COALESCE(${capacity_label ?? null}, capacity_label),
      max_weight_kg = COALESCE(${max_weight_kg ?? null}, max_weight_kg),
      suitable_items = COALESCE(${suitable_items ?? null}, suitable_items),
      accent_color = COALESCE(${accent_color ?? null}, accent_color),
      base_fare = COALESCE(${base_fare ?? null}, base_fare),
      per_km = COALESCE(${per_km ?? null}, per_km),
      per_kg = COALESCE(${per_kg ?? null}, per_kg),
      load_charge = COALESCE(${load_charge ?? null}, load_charge),
      is_active = COALESCE(${is_active ?? null}, is_active),
      sort_order = COALESCE(${sort_order ?? null}, sort_order),
      updated_at = NOW()
    WHERE vehicle_key = ${vehicleKey}
  `);
}

export async function addParcelVehicle(data: Record<string, any>): Promise<any> {
  const r = await rawDb.execute(rawSql`
    INSERT INTO parcel_vehicle_types
      (vehicle_key, name, subtitle, icon, image_url, capacity_label, max_weight_kg,
       suitable_items, accent_color, base_fare, per_km, per_kg, load_charge, is_active, sort_order)
    VALUES
      (${data.vehicle_key}, ${data.name}, ${data.subtitle || ''}, ${data.icon || '📦'},
       ${data.image_url || ''}, ${data.capacity_label || ''}, ${data.max_weight_kg || 10},
       ${data.suitable_items || ''}, ${data.accent_color || '#2F7BFF'},
       ${data.base_fare || 40}, ${data.per_km || 12}, ${data.per_kg || 4},
       ${data.load_charge || 0}, ${data.is_active !== false}, ${data.sort_order || 99})
    RETURNING *
  `);
  return (r.rows as any[])[0];
}
