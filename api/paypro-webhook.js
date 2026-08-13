import { createHash, timingSafeEqual } from "node:crypto";

const COMETLY_API_URL =
  "https://app.cometly.com/public-api/v1/events/track";

const MAIN_EVENT_NAME = "purchase";

const UPSELL_EVENT_NAME =
  process.env.COMETLY_UPSELL_EVENT_NAME || "custom_event_1";

const MAIN_CHECKOUT_PRODUCT_ID = "133559";
const CHECKOUT_TTL_SECONDS = 72 * 60 * 60;

const SECRET_QUERY_KEYS = [
  "secret-key",
  "secret_key",
  "key",
  "hash",
  "signature"
];

const PII_QUERY_KEYS_TO_MASK = [
  "billing-email",
  "x-grant_email",
  "x-kajabi_email",
  "email"
];

function safeString(value) {
  return String(value ?? "").trim();
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(
    String(left || ""),
    "utf8"
  );

  const rightBuffer = Buffer.from(
    String(right || ""),
    "utf8"
  );

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function funnelSessionKey(sessionId) {
  return `paypro:funnel:session:${sessionId}`;
}

function isValidSessionIdentifier(value) {
  const identifier = safeString(value);

  return (
    identifier.length >= 16 &&
    identifier.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(identifier)
  );
}

function isValidStoredAccessTokenHash(value) {
  return /^[a-f0-9]{64}$/i.test(safeString(value));
}

function pick(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];

    if (
      value !== undefined &&
      value !== null &&
      safeString(value) !== ""
    ) {
      return safeString(value);
    }
  }

  return "";
}

function num(value) {
  const parsed = parseFloat(
    safeString(value).replace(",", ".")
  );

  return Number.isFinite(parsed) ? parsed : 0;
}

function maskEmail(email) {
  const clean = safeString(email);

  if (!clean || !clean.includes("@")) {
    return clean;
  }

  const [name, domain] = clean.split("@");

  return `${name.slice(0, 2)}***@${domain}`;
}

function parseParamString(value) {
  const output = {};

  const input = safeString(value)
    .replace(/^\?/, "")
    .replace(/&amp;/gi, "&");

  if (!input) {
    return output;
  }

  try {
    const params = new URLSearchParams(input);

    params.forEach((paramValue, key) => {
      output[key] = paramValue;

      if (key.startsWith("x-")) {
        output[key.slice(2)] = paramValue;
      }
    });
  } catch {}

  return output;
}

function normalizeBody(body) {
  if (!body) {
    return {};
  }

  if (typeof body === "object") {
    return body;
  }

  return parseParamString(body);
}

function mergePayProData(input) {
  const raw = normalizeBody(input);
  const queryData = parseParamString(
    raw.CHECKOUT_QUERY_STRING
  );

  const customFieldData = parseParamString(
    raw.ORDER_CUSTOM_FIELDS
  );

  return {
    ...customFieldData,
    ...queryData,
    ...raw,
    _query: queryData,
    _customFields: customFieldData
  };
}

function verifyPayProSignature(data) {
  const validationKey =
    process.env.PAYPRO_VALIDATION_KEY;

  if (!validationKey) {
    throw new Error("Missing PAYPRO_VALIDATION_KEY");
  }

  const received = pick(data, ["SIGNATURE"])
    .toLowerCase();

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

  const receivedBuffer = Buffer.from(
    received,
    "hex"
  );

  const expectedBuffer = Buffer.from(
    expected,
    "hex"
  );

  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

function sanitizeQueryString(value) {
  const input = safeString(value)
    .replace(/^\?/, "")
    .replace(/&amp;/gi, "&");

  if (!input) {
    return "";
  }

  try {
    const params = new URLSearchParams(input);

    SECRET_QUERY_KEYS.forEach((key) => {
      if (params.has(key)) {
        params.set(key, "[removed]");
      }
    });

    PII_QUERY_KEYS_TO_MASK.forEach((key) => {
      if (params.has(key)) {
        params.set(
          key,
          maskEmail(params.get(key))
        );
      }
    });

    return params.toString();
  } catch {
    return "[unparseable_query_string]";
  }
}

function getOfferStep(data) {
  return pick(data, [
    "x-offer_step",
    "offer_step",
    "OFFER_STEP"
  ]).toLowerCase();
}

function isCheckoutMain(data) {
  const step = getOfferStep(data);

  return !step || step === "checkout_main";
}

function shouldSkipCheckoutBumpIpn(data) {
  const productId = pick(data, ["PRODUCT_ID"]);

  return (
    isCheckoutMain(data) &&
    productId &&
    productId !== MAIN_CHECKOUT_PRODUCT_ID
  );
}

function isUpsell(data) {
  const step = getOfferStep(data);

  const sku = pick(data, [
    "ORDER_ITEM_SKU"
  ]).toLowerCase();

  const productId = pick(data, ["PRODUCT_ID"]);

  const upsellStepParts = [
    "upsell",
    "downsell",
    "fast_track",
    "complete_fast_track",
    "fast-track",
    "bodyplan"
  ];

  if (
    upsellStepParts.some((part) =>
      step.includes(part)
    )
  ) {
    return true;
  }

  const upsellSkuParts = [
    "upsl",
    "upsell",
    "downsell"
  ];

  if (
    upsellSkuParts.some((part) =>
      sku.includes(part)
    )
  ) {
    return true;
  }

  return [
    "133573",
    "133574",
    "133575"
  ].includes(productId);
}

function getCheckoutMainAmount(data) {
  return (
    num(pick(data, ["x-total", "total"])) ||
    num(data.ORDER_TOTAL_AMOUNT_SHOWN) ||
    num(
      data.ORDER_TOTAL_AMOUNT_WITH_TAXES_SHOWN
    ) ||
    num(
      data.ORDER_TOTAL_BALANCE_CURRENCY_AMOUNT
    ) ||
    num(
      data.ORDER_ITEM_BALANCE_CURRENCY_TOTAL_AMOUNT
    ) ||
    num(data.ORDER_ITEM_TOTAL_AMOUNT)
  );
}

function getItemAmount(data) {
  return (
    num(
      data.ORDER_ITEM_BALANCE_CURRENCY_TOTAL_AMOUNT
    ) ||
    num(data.ORDER_ITEM_TOTAL_AMOUNT) ||
    num(
      data.ORDER_TOTAL_BALANCE_CURRENCY_AMOUNT
    ) ||
    num(data.ORDER_TOTAL_AMOUNT_SHOWN) ||
    num(
      data.ORDER_TOTAL_AMOUNT_WITH_TAXES_SHOWN
    )
  );
}

function getAmount(data) {
  return isCheckoutMain(data)
    ? getCheckoutMainAmount(data)
    : getItemAmount(data);
}

function getCurrency(data) {
  return (
    pick(data, [
      "VENDOR_BALANCE_CURRENCY_CODE"
    ]) ||
    pick(data, ["ORDER_CURRENCY_CODE"]) ||
    "USD"
  );
}

function getEventTime(data) {
  const raw = pick(data, [
    "ORDER_PLACED_TIME_UTC"
  ]);

  if (!raw) {
    return new Date().toISOString();
  }

  const parsed = new Date(`${raw} UTC`);

  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString();
}

async function redisCommand(command) {
  const url = safeString(
    process.env.KV_REST_API_URL
  ).replace(/\/+$/, "");

  const token = safeString(
    process.env.KV_REST_API_TOKEN
  );

  if (!url || !token) {
    throw new Error(
      "Missing KV_REST_API_URL or KV_REST_API_TOKEN"
