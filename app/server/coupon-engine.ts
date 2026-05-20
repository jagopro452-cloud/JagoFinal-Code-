import { db } from "./db";
import { sql } from "drizzle-orm";
import { validateRetentionPromo } from "./retention";

const rawDb = db;
const rawSql = sql;

export interface CouponApplicationResult {
  finalFare: number;
  discount: number;
  couponCode: string | null;
  originalFare: number;
}

export async function applyCoupon(
  userId: string,
  fare: number,
  couponCode?: string | null,
): Promise<CouponApplicationResult> {
  const originalFare = Math.max(0, Math.round(fare * 100) / 100);
  if (!couponCode || !String(couponCode).trim()) {
    return {
      finalFare: originalFare,
      discount: 0,
      couponCode: null,
      originalFare,
    };
  }

  const normalizedCode = String(couponCode).trim().toUpperCase();

  const retention = await validateRetentionPromo(userId, normalizedCode).catch(() => null);
  if (retention?.valid) {
    const discount = Math.min(originalFare, Number(retention.discountAmount) || 0);
    return {
      finalFare: Math.max(0, originalFare - discount),
      discount: Math.round(discount * 100) / 100,
      couponCode: normalizedCode,
      originalFare,
    };
  }

  const couponR = await rawDb.execute(rawSql`
    SELECT id, code, discount_type, discount_amount, max_discount_amount, min_trip_amount, total_usage_limit, limit_per_user
    FROM coupon_setups
    WHERE UPPER(code) = ${normalizedCode}
      AND is_active = true
      AND (end_date IS NULL OR end_date >= NOW())
    LIMIT 1
  `).catch(() => ({ rows: [] as any[] }));

  const coupon = couponR.rows[0] as any;
  if (!coupon) {
    return { finalFare: originalFare, discount: 0, couponCode: null, originalFare };
  }

  const minTripAmount = parseFloat(coupon.min_trip_amount || "0") || 0;
  if (originalFare < minTripAmount) {
    return { finalFare: originalFare, discount: 0, couponCode: null, originalFare };
  }

  if (coupon.total_usage_limit) {
    const usageR = await rawDb.execute(rawSql`
      SELECT COUNT(*) AS cnt FROM trip_requests
      WHERE coupon_code = ${normalizedCode} AND current_status != 'cancelled'
    `);
    const usedCount = parseInt((usageR.rows[0] as any)?.cnt || "0", 10);
    if (usedCount >= parseInt(coupon.total_usage_limit, 10)) {
      return { finalFare: originalFare, discount: 0, couponCode: null, originalFare };
    }
  }

  if (coupon.limit_per_user) {
    const userUsageR = await rawDb.execute(rawSql`
      SELECT COUNT(*) AS cnt FROM trip_requests
      WHERE coupon_code = ${normalizedCode}
        AND customer_id = ${userId}::uuid
        AND current_status != 'cancelled'
    `);
    const usedCount = parseInt((userUsageR.rows[0] as any)?.cnt || "0", 10);
    if (usedCount >= parseInt(coupon.limit_per_user, 10)) {
      return { finalFare: originalFare, discount: 0, couponCode: null, originalFare };
    }
  }

  const discountType = String(coupon.discount_type || "").toUpperCase();
  const couponValue = parseFloat(coupon.discount_amount || "0") || 0;
  let discount = 0;
  if (discountType === "PERCENT" || discountType === "PERCENTAGE") {
    discount = originalFare * couponValue / 100;
    if (coupon.max_discount_amount) {
      discount = Math.min(discount, parseFloat(coupon.max_discount_amount || "0") || discount);
    }
  } else if (discountType === "FLAT") {
    discount = couponValue;
  } else {
    discount = couponValue;
  }

  discount = Math.min(originalFare, Math.round(discount * 100) / 100);
  return {
    finalFare: Math.max(0, originalFare - discount),
    discount,
    couponCode: String(coupon.code || normalizedCode),
    originalFare,
  };
}
