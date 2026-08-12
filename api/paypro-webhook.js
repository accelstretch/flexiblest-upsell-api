import { createHash, timingSafeEqual } from "node:crypto";

const COMETLY_API_URL = "https://app.cometly.com/public-api/v1/events/track";
const MAIN_EVENT_NAME = "purchase";
const UPSELL_EVENT_NAME = process.env.COMETLY_UPSELL_EVENT_NAME || "custom_event_1";
const MAIN_CHECKOUT_PRODUCT_ID = "133559";
const CHECKOUT_TTL_SECONDS = 72 * 60 * 60;

const SECRET_QUERY_KEYS = ["secret-key", "secret_key", "key", "hash", "signature"];
const PII_QUERY_KEYS_TO_MASK = ["billing-email", "x-grant_email", "x-kajabi_email", "email"];

function safeString(value) {
  return String(value ?? "").trim();
}

function pick(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && safeString(value) !== "") return safeString(value);
  }
  return "";
}

function num(value) {
  const n = parseFloat(safeString(value).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function maskEmail(email) {
  const clean = safeString(email);
  if (!clean || !clean.includes("@")) return clean;
  const [name, domain] = clean.split("@");
  return `${name.slice(0, 2)}***@${domain}`;
}

function parseParamString(value) {
  const out = {};
  const input = safeString(value).replace(/^\?/, "").replace(/&amp;/gi, "&");
  if (!input) return out;

  try {
    const params = new URLSearchParams(input);
    params.forEach((paramValue, key) => {
      out[key] = paramValue;
      if (key.startsWith("x-")) out[key.slice(2)] = paramValue;
    });
  } catch (error) {}

  return out;
}

function normalizeBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  return parseParamString(body);
}

function mergePayProData(input) {
  const raw = normalizeBody(input);
  const queryData = parseParamString(raw.CHECKOUT_QUERY_STRING);
  const customFieldData = parseParamString(raw.ORDER_CUSTOM_FIELDS);

  return {
    ...queryData,
    ...customFieldData,
    ...raw,
    _query: queryData,
    _customFields: customFieldData
  };
}

function verifyPayProSignature(data) {
  const validationKey = process.env.PAYPRO_VALIDATION_KEY;

  if (!validationKey) {
    throw new Error("Missing PAYPRO_VALIDATION_KEY");
  }

  const received = pick(data, ["SIGNATURE"]).toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(received)) {
    return false;
  }

  const signedValue =
    safeString(data.ORDER_ID) +
    safeString(data.ORDER_STATUS) +
    safeString(data.ORDER_TOTAL_AMOUNT) +
    safeString(data.CUSTOMER_EMAIL) +
    validationKey +
    safeString(data.TEST_MODE) +
    safeString(data.IPN_TYPE_NAME);

  const expected = createHash("sha256")
    .update(signedValue, "utf8")
    .digest("hex");

  const receivedBuffer = Buffer.from(received, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

function sanitizeQueryString(value) {
  const input = safeString(value).replace(/^\?/, "").replace(/&amp;/gi, "&");
  if (!input) return "";

  try {
    const params = new URLSearchParams(input);
    SECRET_QUERY_KEYS.forEach((key) => {
      if (params.has(key)) params.set(key, "[removed]");
    });
    PII_QUERY_KEYS_TO_MASK.forEach((key) => {
      if (params.has(key)) params.set(key, maskEmail(params.get(key)));
    });
    return params.toString();
  } catch (error) {
    return "[unparseable_query_string]";
  }
}

function getOfferStep(data) {
  return pick(data, ["x-offer_step", "offer_step", "OFFER_STEP"]).toLowerCase();
}

function isCheckoutMain(data) {
  const step = getOfferStep(data);
  return !step || step === "checkout_main";
}

function shouldSkipCheckoutBumpIpn(data) {
  const productId = pick(data, ["PRODUCT_ID"]);
  return isCheckoutMain(data) && productId && productId !== MAIN_CHECKOUT_PRODUCT_ID;
}

function isUpsell(data) {
  const step = getOfferStep(data);
  const sku = pick(data, ["ORDER_ITEM_SKU"]).toLowerCase();
  const productId = pick(data, ["PRODUCT_ID"]);
  if (["upsell", "downsell", "fast_track", "complete_fast_track", "fast-track", "bodyplan"].some((part) => step.includes(part))) return true;
  if (["upsl", "upsell", "downsell"].some((part) => sku.includes(part))) return true;
  return ["133573", "133574", "133575"].includes(productId);
}

function getCheckoutMainAmount(data) {
  return num(pick(data, ["x-total", "total"])) || num(data.ORDER_TOTAL_AMOUNT_SHOWN) ||
    num(data.ORDER_TOTAL_AMOUNT_WITH_TAXES_SHOWN) || num(data.ORDER_TOTAL_BALANCE_CURRENCY_AMOUNT) ||
    num(data.ORDER_ITEM_BALANCE_CURRENCY_TOTAL_AMOUNT) || num(data.ORDER_ITEM_TOTAL_AMOUNT);
}

function getItemAmount(data) {
  return num(data.ORDER_ITEM_BALANCE_CURRENCY_TOTAL_AMOUNT) || num(data.ORDER_ITEM_TOTAL_AMOUNT) ||
    num(data.ORDER_TOTAL_BALANCE_CURRENCY_AMOUNT) || num(data.ORDER_TOTAL_AMOUNT_SHOWN) ||
    num(data.ORDER_TOTAL_AMOUNT_WITH_TAXES_SHOWN);
}

function getAmount(data) {
  return isCheckoutMain(data) ? getCheckoutMainAmount(data) : getItemAmount(data);
}

function getCurrency(data) {
  return pick(data, ["VENDOR_BALANCE_CURRENCY_CODE"]) || pick(data, ["ORDER_CURRENCY_CODE"]) || "USD";
}

function getEventTime(data) {
  const raw = pick(data, ["ORDER_PLACED_TIME_UTC"]);
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw + " UTC");
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

async function redisCommand(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Missing KV_REST_API_URL or KV_REST_API_TOKEN");

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(`Redis command failed: ${data.error || response.status}`);
  return data.result;
}

async function persistMainCheckout(data) {
  if (!isCheckoutMain(data) || pick(data, ["PRODUCT_ID"]) !== MAIN_CHECKOUT_PRODUCT_ID) return false;

  const sessionId = pick(data, ["x-fs_session_id", "fs_session_id"]);
  const checkoutIntentId = pick(data, ["x-fs_checkout_intent_id", "fs_checkout_intent_id"]);
  const orderId = pick(data, ["ORDER_ID"]);
  if (!sessionId || !orderId) {
    console.error("PAYPRO MAIN CHECKOUT MAPPING MISSING IDENTIFIERS", {
      has_session_id: Boolean(sessionId),
      has_checkout_intent_id: Boolean(checkoutIntentId),
      has_order_id: Boolean(orderId)
    });
    throw new Error("Main checkout webhook is missing fs_session_id or ORDER_ID");
  }

  const record = JSON.stringify({
    orderId,
    sessionId,
    checkoutIntentId,
    productId: MAIN_CHECKOUT_PRODUCT_ID,
    status: "processed",
    createdAt: new Date().toISOString()
  });

  await redisCommand(["SET", `paypro:checkout:session:${sessionId}`, record, "EX", CHECKOUT_TTL_SECONDS]);
  console.log("PAYPRO CHECKOUT MAPPING SAVED", {
    order_id: orderId,
    has_session_id: true,
    has_checkout_intent_id: Boolean(checkoutIntentId),
    ttl_seconds: CHECKOUT_TTL_SECONDS
  });
  return true;
}

function buildEvent(raw, req) {
  const data = mergePayProData(raw);
  const orderId = pick(data, ["ORDER_ID"]);
  const itemId = pick(data, ["ORDER_ITEM_ID"]);
  const productId = pick(data, ["PRODUCT_ID"]);
  const email = pick(data, ["CUSTOMER_EMAIL", "x-grant_email", "grant_email", "x-kajabi_email", "kajabi_email", "billing-email"]);
  const upsell = isUpsell(data);
  const sessionId = pick(data, ["x-fs_session_id", "fs_session_id"]);
  const checkoutIntentId = pick(data, ["x-fs_checkout_intent_id", "fs_checkout_intent_id"]);
  const cometlyClickId = pick(data, ["x-cometly_click_id", "cometly_click_id", "cometly_id"]);
  const fbclid = pick(data, ["x-fbclid", "fbclid"]);
  const fbc = pick(data, ["x-fbc", "fbc"]);
  const fbp = pick(data, ["x-fbp", "fbp"]);
  const trackingId = cometlyClickId || sessionId || checkoutIntentId || fbc || fbp || fbclid || email || orderId;

  return {
    event_name: upsell ? UPSELL_EVENT_NAME : MAIN_EVENT_NAME,
    email,
    ip: pick(data, ["CUSTOMER_IP"]) || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "",
    user_agent: req.headers["user-agent"] || "",
    event_time: getEventTime(data),
    url: pick(data, ["x-checkout_page_url", "checkout_page_url", "ORDER_REFERRER_URL"]) || "",
    amount: getAmount(data),
    currency: getCurrency(data),
    order_id: itemId ? `${orderId}-${itemId}` : orderId,
    order_name: pick(data, ["ORDER_ITEM_NAME"]) || "PayPro Order",
    tracking_id: trackingId,
    checkout_token: checkoutIntentId,
    is_upsell: upsell,
    upsell_common_id: pick(data, ["x-root_order_id", "root_order_id", "x-parent_order_id", "parent_order_id"]) || sessionId || orderId,
    idempotency_key: itemId ? `paypro-${orderId}-${itemId}` : `paypro-${orderId}-${productId}`,
    first_name: pick(data, ["CUSTOMER_FIRST_NAME"]),
    last_name: pick(data, ["CUSTOMER_LAST_NAME"]),
    full_name: pick(data, ["CUSTOMER_NAME"]),
    phone: pick(data, ["CUSTOMER_PHONE"]),
    comet_source: pick(data, ["x-utm_source", "utm_source"]),
    comet_network: pick(data, ["x-utm_source", "utm_source"]),
    comet_campaign: pick(data, ["x-utm_campaign", "utm_campaign"]),
    comet_ad_group: pick(data, ["x-utm_content", "utm_content"]),
    comet_ad_id: fbclid,
    comet_keyword: pick(data, ["x-utm_term", "utm_term"]),
    comet_type: pick(data, ["x-utm_medium", "utm_medium"]),
    profile_field_1: "paypro",
    profile_field_2: pick(data, ["x-funnel_id", "funnel_id"]),
    profile_field_3: pick(data, ["x-offer_step", "offer_step"]) || (upsell ? "upsell" : "checkout_main"),
    profile_field_4: productId,
    profile_field_5: pick(data, ["ORDER_ITEM_SKU"]),
    profile_field_6: pick(data, ["ORDER_ITEM_NAME"]),
    profile_field_7: pick(data, ["PAYMENT_METHOD_NAME"]),
    profile_field_8: pick(data, ["CUSTOMER_COUNTRY_CODE", "CUSTOMER_COUNTRY_CODE_BY_IP"]),
    profile_field_9: pick(data, ["x-selected_order_bumps", "selected_order_bumps"]),
    profile_field_10: fbclid,
    profile_field_11: fbc,
    profile_field_12: fbp,
    profile_field_13: pick(data, ["x-gclid", "gclid"]),
    profile_field_14: pick(data, ["x-ttclid", "ttclid"]),
    profile_field_15: sanitizeQueryString(data.CHECKOUT_QUERY_STRING)
  };
}

function buildSafeLog(raw) {
  const data = mergePayProData(raw);
  return {
    ORDER_ID: data.ORDER_ID,
    PRODUCT_ID: data.PRODUCT_ID,
    ORDER_ITEM_ID: data.ORDER_ITEM_ID,
    ORDER_ITEM_NAME: data.ORDER_ITEM_NAME,
    ORDER_ITEM_SKU: data.ORDER_ITEM_SKU,
    ORDER_STATUS: data.ORDER_STATUS,
    IPN_TYPE_NAME: data.IPN_TYPE_NAME,
    TEST_MODE: data.TEST_MODE,
    CUSTOMER_EMAIL: maskEmail(data.CUSTOMER_EMAIL),
    PAYMENT_METHOD_NAME: data.PAYMENT_METHOD_NAME,
    ORDER_CURRENCY_CODE: data.ORDER_CURRENCY_CODE,
    VENDOR_BALANCE_CURRENCY_CODE: data.VENDOR_BALANCE_CURRENCY_CODE,
    ORDER_ITEM_TOTAL_AMOUNT: data.ORDER_ITEM_TOTAL_AMOUNT,
    ORDER_TOTAL_AMOUNT_SHOWN: data.ORDER_TOTAL_AMOUNT_SHOWN,
    ORDER_CUSTOM_FIELDS: sanitizeQueryString(data.ORDER_CUSTOM_FIELDS),
    CHECKOUT_QUERY_STRING: sanitizeQueryString(data.CHECKOUT_QUERY_STRING)
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const raw = normalizeBody(req.body);
    console.log("PAYPRO SAFE RAW:", buildSafeLog(raw));
    const data = mergePayProData(raw);

    if (!verifyPayProSignature(data)) {
      console.error("PAYPRO WEBHOOK SIGNATURE REJECTED", {
        has_signature: Boolean(pick(data, ["SIGNATURE"])),
        order_id: pick(data, ["ORDER_ID"]),
        ipn_type: pick(data, ["IPN_TYPE_NAME"])
      });

      return res.status(401).json({
        ok: false,
        error: "Invalid PayPro signature"
      });
    }

    const status = pick(data, ["ORDER_STATUS"]);
    const ipnType = pick(data, ["IPN_TYPE_NAME"]);
    const productId = pick(data, ["PRODUCT_ID"]);
    const orderId = pick(data, ["ORDER_ID"]);
    const itemId = pick(data, ["ORDER_ITEM_ID"]);

    if (status && status !== "Processed") return res.status(200).json({ ok: true, skipped: "Non processed order" });
    if (ipnType && ipnType !== "OrderCharged") return res.status(200).json({ ok: true, skipped: "Non charge IPN" });

    const mappingSaved = await persistMainCheckout(data);

    if (shouldSkipCheckoutBumpIpn(data)) {
      console.log("PAYPRO CHECKOUT BUMP IPN SKIPPED:", {
        ORDER_ID: orderId, PRODUCT_ID: productId, ORDER_ITEM_ID: itemId,
        ORDER_ITEM_NAME: data.ORDER_ITEM_NAME, ORDER_ITEM_SKU: data.ORDER_ITEM_SKU
      });
      return res.status(200).json({
        ok: true, sent_to_cometly: false, mapping_saved: mappingSaved, skipped: true,
        reason: "checkout_bump_item_ipn_skipped", order_id: orderId, product_id: productId, item_id: itemId
      });
    }

    const apiKey = process.env.COMETLY_API_KEY;
    if (!apiKey) throw new Error("Missing COMETLY_API_KEY");
    const event = buildEvent(raw, req);

    console.log("COMETLY PAYLOAD SAFE:", {
      event_name: event.event_name, email: maskEmail(event.email), amount: event.amount,
      currency: event.currency, order_id: event.order_id, is_upsell: event.is_upsell,
      tracking_id: event.tracking_id ? "[present]" : "",
      checkout_token: event.checkout_token ? "[present]" : "",
      profile_field_2: event.profile_field_2, profile_field_3: event.profile_field_3
    });

    const response = await fetch(COMETLY_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(event)
    });
    const text = await response.text();
    console.log("COMETLY RESPONSE:", response.status, text);
    if (!response.ok) return res.status(500).json({ ok: false, error: "Cometly rejected event", status: response.status, response: text });

    return res.status(200).json({ ok: true, mapping_saved: mappingSaved, sent_to_cometly: true, event_name: event.event_name, order_id: event.order_id });
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
