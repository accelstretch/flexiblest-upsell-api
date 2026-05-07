const COMETLY_API_URL = "https://app.cometly.com/public-api/v1/events/track";

function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== "") {
      return String(obj[key]).trim();
    }
  }
  return "";
}

function num(value) {
  const n = parseFloat(String(value || "0").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function isUpsell(raw) {
  const step = pick(raw, ["x-offer_step", "offer_step", "OFFER_STEP"]).toLowerCase();
  const sku = pick(raw, ["ORDER_ITEM_SKU"]).toLowerCase();
  const productId = pick(raw, ["PRODUCT_ID"]);

  if (step.includes("upsell") || step.includes("downsell") || step.includes("fast_track") || step.includes("bodyplan")) return true;
  if (sku.includes("upsl") || sku.includes("upsell") || sku.includes("downsell")) return true;

  return ["133573", "133574", "133575"].includes(productId);
}

function buildEvent(raw, req) {
  const orderId = pick(raw, ["ORDER_ID"]);
  const itemId = pick(raw, ["ORDER_ITEM_ID"]);
  const productId = pick(raw, ["PRODUCT_ID"]);
  const email = pick(raw, ["CUSTOMER_EMAIL", "x-grant_email", "x-kajabi_email"]);
  const upsell = isUpsell(raw);

  const amount =
    num(raw.ORDER_ITEM_BALANCE_CURRENCY_TOTAL_AMOUNT) ||
    num(raw.ORDER_ITEM_TOTAL_AMOUNT) ||
    num(raw.ORDER_TOTAL_AMOUNT_SHOWN) ||
    num(raw.ORDER_TOTAL_AMOUNT_WITH_TAXES_SHOWN);

  const currency =
    pick(raw, ["VENDOR_BALANCE_CURRENCY_CODE"]) ||
    pick(raw, ["ORDER_CURRENCY_CODE"]) ||
    "USD";

  const eventTimeRaw = pick(raw, ["ORDER_PLACED_TIME_UTC"]);
  const eventTime = eventTimeRaw ? new Date(eventTimeRaw + " UTC").toISOString() : new Date().toISOString();

  const trackingId =
    pick(raw, ["x-cometly_click_id", "cometly_click_id", "x-fs_session_id", "fs_session_id"]) ||
    email ||
    orderId;

  return {
    event_name: upsell ? "custom_event_1" : "purchase",
    email,
    ip: pick(raw, ["CUSTOMER_IP"]) || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "",
    user_agent: req.headers["user-agent"] || "",
    event_time: eventTime,
    url: pick(raw, ["x-checkout_page_url", "checkout_page_url", "ORDER_REFERRER_URL"]) || "",
    amount,
    order_id: itemId ? `${orderId}-${itemId}` : orderId,
    order_name: pick(raw, ["ORDER_ITEM_NAME"]) || "PayPro Order",
    tracking_id: trackingId,
    checkout_token: pick(raw, ["x-fs_checkout_intent_id", "fs_checkout_intent_id"]),
    is_upsell: upsell,
    upsell_common_id: pick(raw, ["x-root_order_id", "root_order_id", "x-fs_session_id", "fs_session_id"]) || orderId,
    idempotency_key: itemId ? `paypro-${orderId}-${itemId}` : `paypro-${orderId}-${productId}`,

    first_name: pick(raw, ["CUSTOMER_FIRST_NAME"]),
    last_name: pick(raw, ["CUSTOMER_LAST_NAME"]),
    full_name: pick(raw, ["CUSTOMER_NAME"]),
    phone: pick(raw, ["CUSTOMER_PHONE"]),

    comet_source: pick(raw, ["x-utm_source", "utm_source"]),
    comet_network: pick(raw, ["x-utm_source", "utm_source"]),
    comet_campaign: pick(raw, ["x-utm_campaign", "utm_campaign"]),
    comet_ad_group: pick(raw, ["x-utm_content", "utm_content"]),
    comet_ad_id: pick(raw, ["x-fbclid", "fbclid"]),
    comet_keyword: pick(raw, ["x-utm_term", "utm_term"]),
    comet_type: pick(raw, ["x-utm_medium", "utm_medium"]),

    profile_field_1: "paypro",
    profile_field_2: pick(raw, ["x-funnel_id", "funnel_id"]),
    profile_field_3: pick(raw, ["x-offer_step", "offer_step"]) || (upsell ? "upsell" : "checkout_main"),
    profile_field_4: productId,
    profile_field_5: pick(raw, ["ORDER_ITEM_SKU"]),
    profile_field_6: pick(raw, ["ORDER_ITEM_NAME"]),
    profile_field_7: pick(raw, ["PAYMENT_METHOD_NAME"]),
    profile_field_8: pick(raw, ["CUSTOMER_COUNTRY_CODE", "CUSTOMER_COUNTRY_CODE_BY_IP"]),
    profile_field_9: pick(raw, ["x-selected_order_bumps", "selected_order_bumps"]),
    profile_field_10: pick(raw, ["x-fbclid", "fbclid"]),
    profile_field_11: pick(raw, ["x-fbc", "fbc"]),
    profile_field_12: pick(raw, ["x-fbp", "fbp"]),
    profile_field_13: pick(raw, ["x-gclid", "gclid"]),
    profile_field_14: pick(raw, ["x-ttclid", "ttclid"]),
    profile_field_15: pick(raw, ["CHECKOUT_QUERY_STRING"])
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const raw = req.body || {};
    console.log("PAYPRO RAW:", raw);

    const apiKey = process.env.COMETLY_API_KEY;
    if (!apiKey) {
      console.error("Missing COMETLY_API_KEY");
      return res.status(500).json({ ok: false, error: "Missing COMETLY_API_KEY" });
    }

    const status = pick(raw, ["ORDER_STATUS"]);
    const ipnType = pick(raw, ["IPN_TYPE_NAME"]);

    if (status && status !== "Processed") {
      return res.status(200).json({ ok: true, skipped: "Non processed order" });
    }

    if (ipnType && ipnType !== "OrderCharged") {
      return res.status(200).json({ ok: true, skipped: "Non charge IPN" });
    }

    const event = buildEvent(raw, req);

    const response = await fetch(COMETLY_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(event)
    });

    const text = await response.text();
    console.log("COMETLY RESPONSE:", response.status, text);

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: "Cometly rejected event",
        status: response.status,
        response: text
      });
    }

    return res.status(200).json({ ok: true, sent_to_cometly: true });
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}
