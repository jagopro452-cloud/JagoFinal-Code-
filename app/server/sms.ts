import { getConf } from "./config-db";

function normalizeIndianPhone(phone: string): string {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length <= 10) return digits;
  return digits.slice(-10);
}

async function sendViaTwilio(phone: string, text: string): Promise<boolean> {
  const accountSid = await getConf("TWILIO_ACCOUNT_SID", "twilio_account_sid");
  const authToken = await getConf("TWILIO_AUTH_TOKEN", "twilio_auth_token");
  const fromNumber = await getConf("TWILIO_PHONE_NUMBER", "twilio_phone_number");
  if (!accountSid || !authToken || !fromNumber) return false;

  try {
    const twilioModule = await import("twilio");
    const twilioFactory = (twilioModule.default ?? twilioModule) as any;
    const client = twilioFactory(accountSid, authToken);
    await client.messages.create({
      body: text,
      from: fromNumber,
      to: `+91${phone}`,
    });
    return true;
  } catch (error: any) {
    console.warn(`[SMS] Twilio send failed: ${error?.message || error}`);
    return false;
  }
}

async function sendViaFast2Sms(phone: string, text: string): Promise<boolean> {
  const apiKey = await getConf("FAST2SMS_API_KEY", "fast2sms_api_key");
  if (!apiKey) return false;

  try {
    const response = await fetch("https://www.fast2sms.com/dev/bulkV2", {
      method: "POST",
      headers: {
        authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        route: "q",
        message: text,
        language: "english",
        flash: 0,
        numbers: phone,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`[SMS] Fast2SMS HTTP ${response.status}: ${body}`);
      return false;
    }

    const payload = await response.json().catch(() => null) as any;
    const ok = payload?.return === true || payload?.message?.some?.((item: string) => /sms sent/i.test(item));
    if (!ok) {
      console.warn(`[SMS] Fast2SMS rejected payload: ${JSON.stringify(payload)}`);
    }
    return !!ok;
  } catch (error: any) {
    console.warn(`[SMS] Fast2SMS send failed: ${error?.message || error}`);
    return false;
  }
}

export async function sendCustomSms(phone: string, text: string): Promise<boolean> {
  const normalizedPhone = normalizeIndianPhone(phone);
  if (normalizedPhone.length !== 10) {
    console.warn(`[SMS] Invalid phone for SMS: ${phone}`);
    return false;
  }

  if (String(process.env.AUTH_DEV_CONSOLE_SMS || "").trim().toLowerCase() === "true") {
    console.log(`[SMS-DEV] Sending to ${normalizedPhone}: ${text}`);
    return true;
  }

  if (await sendViaTwilio(normalizedPhone, text)) {
    console.log(`[SMS] Sent via Twilio to ${normalizedPhone}`);
    return true;
  }

  if (await sendViaFast2Sms(normalizedPhone, text)) {
    console.log(`[SMS] Sent via Fast2SMS to ${normalizedPhone}`);
    return true;
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(`[SMS-DEV] Sending to ${normalizedPhone}: ${text}`);
    return true;
  }

  console.warn(`[SMS] No SMS provider configured for ${normalizedPhone}`);
  return false;
}
