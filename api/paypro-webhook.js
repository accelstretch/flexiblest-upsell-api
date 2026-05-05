export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({
      ok: true,
      message: "PayPro webhook endpoint active"
    });
  }

  try {
    const raw = typeof req.body === "string" ? req.body : req.body || {};
    const data = typeof raw === "string" ? parseFormBody(raw) : raw;

    const sku = clean(data.ORDER_ITEM_SKU);
    const eventType = clean(data.IPN_TYPE_NAME);
    const testMode = clean(data.TEST_MODE) === "1";

    const productMap = {
      "FS-AS-29": {
        kajabi_id: "ADD_KAJABI_ID",
        name: "AccelStretch System",
        type: "main"
      },
      "FS-CHARTS-17": {
        kajabi_id: "ADD_KAJABI_ID",
        name: "Printable Routine Charts",
        type: "bump"
      },
      "FS-JOINT-12": {
        kajabi_id: "ADD_KAJABI_ID",
        name: "Joint Support Nutrition Plan",
        type: "bump"
      },
      "FS-FTREC-UP57": {
        kajabi_id: "ADD_KAJABI_ID",
        name: "Fast Track Body Recovery System",
        type: "upsell"
      },
      "FS-FTREC-DS37": {
        kajabi_id: "ADD_KAJABI_ID",
        name: "Fast Track Body Recovery Final Offer",
        type: "downsell"
      },
      "FS-BODYPLAN-27": {
        kajabi_id: "ADD_KAJABI_ID",
        name: "21-Day Body Transformation Plan",
        type: "upsell"
      }
    };

    const mapped = productMap[sku] || {};

    const normalized = {
      processor: "payproglobal",
      test_mode: testMode,
      event_type: eventType,

      order_id: clean(data.ORDER_ID),
      product_id: clean(data.PRODUCT_ID),
      order_item_id: clean(data.ORDER_ITEM_ID),
      sku,
      product_name: clean(data.ORDER_ITEM_NAME) || mapped.name || "",
      product_type: mapped.type || "",

      customer_id: clean(data.CUSTOMER_ID),
      email: clean(data.CUSTOMER_EMAIL).toLowerCase(),
      first_name: clean(data.CUSTOMER_FIRST_NAME),
      last_name: clean(data.CUSTOMER_LAST_NAME),
      country: clean(data.CUSTOMER_COUNTRY_CODE),
      country_name: clean(data.CUSTOMER_COUNTRY_NAME),
      ip: clean(data.CUSTOMER_IP),

      currency: clean(data.ORDER_CURRENCY_CODE),
      value: number(data.ORDER_ITEM_TOTAL_AMOUNT),
      total_shown: number(data.ORDER_TOTAL_AMOUNT_SHOWN),
      total_with_taxes_shown: number(data.ORDER_TOTAL_AMOUNT_WITH_TAXES_SHOWN),
      tax_amount: number(data.ORDER_TAXES_AMOUNT),

      payment_method: clean(data.PAYMENT_METHOD_NAME),
      placed_time_utc: clean(data.ORDER_PLACED_TIME_UTC),

      kajabi_id: mapped.kajabi_id || "",
      raw_custom_fields: clean(data.ORDER_CUSTOM_FIELDS),
      checkout_query_string: clean(data.CHECKOUT_QUERY_STRING),

      order_status: clean(data.ORDER_STATUS),
      order_status_id: clean(data.ORDER_STATUS_ID),
      ipn_type_id: clean(data.IPN_TYPE_ID),
      product_quantity: number(data.PRODUCT_QUANTITY),
      order_items_count: number(data.ORDER_ITEMS_COUNT),
      bundled_items_count: number(data.BUNDLED_ITEMS_COUNT)
    };

    console.log("PAYPRO_NORMALIZED", JSON.stringify(normalized));

    if (process.env.COMETLY_API_KEY && process.env.COMETLY_EVENT_URL) {
      await sendToCometly(normalized);
    }

    if (
      process.env.ZAPIER_PAYPRO_ACCESS_WEBHOOK_URL &&
      normalized.kajabi_id &&
      normalized.kajabi_id !== "ADD_KAJABI_ID"
    ) {
      await sendToZapier(normalized);
    }

    return res.status(200).json({
      ok: true,
      received: true,
      sku,
      event_type: eventType,
      test_mode: testMode
    });
  } catch (err) {
    console.error("PAYPRO_WEBHOOK_ERROR", err);

    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}

function clean(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function number(v) {
  const n = parseFloat(clean(v));
  return Number.isFinite(n) ? n : 0;
}

function parseFormBody(body) {
  const params = new URLSearchParams(body);
  const obj = {};
  for (const [key, value] of params.entries()) {
    obj[key] = value;
  }
  return obj;
}

async function sendToZapier(payload) {
  await fetch(process.env.ZAPIER_PAYPRO_ACCESS_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function sendToCometly(payload) {
  const eventName = isRefund(payload.event_type) ? "Refund" : "Purchase";

  const cometlyPayload = {
    event_name: eventName,
    email: payload.email,
    event_time: payload.placed_time_utc,
    value: payload.value,
    currency: payload.currency,
    product_name: payload.product_name,
    product_id: payload.product_id,
    order_id: payload.order_id,
    external_id: payload.order_item_id,
    custom_data: {
      processor: payload.processor,
      sku: payload.sku,
      product_type: payload.product_type,
      payment_method: payload.payment_method,
      country: payload.country,
      test_mode: payload.test_mode,
      order_status: payload.order_status,
      order_status_id: payload.order_status_id,
      ipn_type_id: payload.ipn_type_id
    }
  };

  await fetch(process.env.COMETLY_EVENT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.COMETLY_API_KEY}`
    },
    body: JSON.stringify(cometlyPayload)
  });
}

function isRefund(eventType) {
  return String(eventType || "").toLowerCase().includes("refund");
}
