import { getConf } from "./config-db";

function normalizeIndianPhone(phone: string): string {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length <= 10) return digits;
  return digits.slice(-10);
}

type SmsMeta = {
  purpose?: string;
  userType?: string;
};

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

async function sendViaSmsLogin(phone: string, text: string, meta: SmsMeta = {}): Promise<boolean> {
  const apiUrl = await getConf("SMSLOGIN_API_URL", "smslogin_api_url");
  const apiKey = await getConf("SMSLOGIN_API_KEY", "smslogin_api_key");
  const senderId = await getConf("SMSLOGIN_SENDER_ID", "smslogin_sender_id");
  const route = await getConf("SMSLOGIN_ROUTE", "smslogin_route");
  const templateId = await getConf("SMSLOGIN_TEMPLATE_ID", "smslogin_template_id");
  const entityId = await getConf("SMSLOGIN_ENTITY_ID", "smslogin_entity_id");
  if (!apiUrl || !apiKey || !senderId) return false;

  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("sender_id", senderId);
  params.set("number", phone);
  params.set("message", text);
  params.set("purpose", meta.purpose || "transactional");
  params.set("user_type", meta.userType || "customer");
  if (route) params.set("route", route);
  if (templateId) params.set("template_id", templateId);
  if (entityId) params.set("entity_id", entityId);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`[SMS] SMSLogin HTTP ${response.status}: ${body}`);
      return false;
    }

    const raw = await response.text().catch(() => "");
    const body = raw.trim();
    if (!body) return true;

    try {
      const payload = JSON.parse(body) as any;
      const ok =
        payload?.success === true ||
        payload?.status === true ||
        String(payload?.status || "").toLowerCase() === "success" ||
        String(payload?.message || "").toLowerCase().includes("success");
      if (!ok) {
        console.warn(`[SMS] SMSLogin rejected payload: ${body}`);
      }
      return !!ok;
    } catch {
      const ok = /success|sent|queued|accepted/i.test(body);
      if (!ok) {
        console.warn(`[SMS] SMSLogin unexpected payload: ${body}`);
      }
      return ok;
    }
  } catch (error: any) {
    console.warn(`[SMS] SMSLogin send failed: ${error?.message || error}`);
    return false;
  }
}

export async function sendCustomSms(phone: string, text: string, meta: SmsMeta = {}): Promise<boolean> {
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

  if (await sendViaSmsLogin(normalizedPhone, text, meta)) {
    console.log(`[SMS] Sent via SMSLogin to ${normalizedPhone}`);
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
