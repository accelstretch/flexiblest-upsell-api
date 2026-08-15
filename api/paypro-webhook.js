import {
  createHash,
  timingSafeEqual
} from "node:crypto";

const COMETLY_API_URL =
  "https://app.cometly.com/public-api/v1/events/track";

const MAIN_EVENT_NAME = "purchase";

const UPSELL_EVENT_NAME =
  process.env.COMETLY_UPSELL_EVENT_NAME ||
  "custom_event_1";

const MAIN_CHECKOUT_PRODUCT_ID = "133559";

const UPSELL_PRODUCT_IDS = new Set([
  "133573",
  "133574",
  "133575"
]);

const SESSION_TTL_SECONDS = 72 * 60 * 60;
const CHARGE_RESULT_TTL_SECONDS = 72 * 60 * 60;
const DUPLICATE_CHARGE_AUDIT_TTL_SECONDS =
  30 * 24 * 60 * 60;
const COMETLY_EVENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const COMETLY_LOCK_SECONDS = 120;
const KAJABI_DELIVERY_TTL_SECONDS =
  400 * 24 * 60 * 60;
const KAJABI_LOCK_SECONDS = 120;

const KAJABI_PRODUCT_OFFERS = {
  "133559": {
    offerKey: "accelstretch",
    offerId: "2151012544",
    activationEnv:
      "KAJABI_ACCELSTRETCH_ACTIVATION_URL",
    deactivationEnv:
      "KAJABI_ACCELSTRETCH_DEACTIVATION_URL"
  },
  "133565": {
    offerKey: "routine_quick_sheets",
    offerId: "2151278593",
    activationEnv:
      "KAJABI_ROUTINE_QUICK_SHEETS_ACTIVATION_URL",
    deactivationEnv:
      "KAJABI_ROUTINE_QUICK_SHEETS_DEACTIVATION_URL"
  },
  "133569": {
    offerKey: "lean_light",
    offerId: "2151038529",
    activationEnv:
      "KAJABI_LEAN_LIGHT_ACTIVATION_URL",
    deactivationEnv:
      "KAJABI_LEAN_LIGHT_DEACTIVATION_URL"
  },
  "133573": {
    offerKey: "advanced_fast_track",
    offerId: "2150621466",
    activationEnv:
      "KAJABI_ADVANCED_FAST_TRACK_ACTIVATION_URL",
    deactivationEnv:
      "KAJABI_ADVANCED_FAST_TRACK_DEACTIVATION_URL"
  },
  "133574": {
    offerKey: "fast_track_core",
    offerId: "2148399198",
    activationEnv:
      "KAJABI_FAST_TRACK_CORE_ACTIVATION_URL",
    deactivationEnv:
      "KAJABI_FAST_TRACK_CORE_DEACTIVATION_URL"
  }
};

const REFERENCE_CHARGE_OFFERS = {
  "133573": {
    offerKey: "fasttrack57",
    amount: 57,
    currency: "USD"
  },

  "133574": {
    offerKey: "fasttrack37",
    amount: 37,
    currency: "USD"
  }
};

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end

return 0
`;

const UPDATE_MAIN_SESSION_SCRIPT = `
local raw = redis.call("GET", KEYS[1])

if not raw then
  return "MISSING"
end

local ok, session = pcall(cjson.decode, raw)

if not ok or type(session) ~= "table" then
  return "INVALID"
end

if tostring(session["fs_session_id"] or "") ~= ARGV[1] then
  return "SESSION_MISMATCH"
end

if tostring(session["fs_checkout_intent_id"] or "") ~= ARGV[2] then
  return "INTENT_MISMATCH"
end

local tokenHash = tostring(session["access_token_hash"] or "")

if string.len(tokenHash) ~= 64 or
   string.match(tokenHash, "^[a-fA-F0-9]+$") == nil then
  return "INSECURE_SESSION"
end

local existingOrderId =
  tostring(session["paypro_root_order_id"] or "")

if existingOrderId ~= "" and existingOrderId ~= ARGV[3] then
  return "ORDER_MISMATCH"
end

session["status"] = "paid"
session["checkout_started"] = true
session["checkout_completed"] = true
session["paypro_root_order_id"] = ARGV[3]
session["product_id"] = ARGV[4]
session["customer_email"] = ARGV[5]
session["customer_first_name"] = ARGV[6]
session["customer_last_name"] = ARGV[7]
session["customer_phone"] = ARGV[8]
session["currency"] = ARGV[9]
session["amount"] = tonumber(ARGV[10]) or 0
session["paypro_ipn_type"] = ARGV[11]
session["paypro_order_status"] = ARGV[12]

if tostring(session["paid_at"] or "") == "" then
  session["paid_at"] = ARGV[13]
end

session["updated_at"] = ARGV[14]
session["expires_at"] = ARGV[15]

redis.call(
  "SET",
  KEYS[1],
  cjson.encode(session),
  "EX",
  ARGV[16]
)

return cjson.encode(session)
`;

const CONFIRM_CHARGE_RESULT_SCRIPT = `
local raw = redis.call("GET", KEYS[1])

if raw then
  local ok, existing = pcall(cjson.decode, raw)

  if ok and type(existing) == "table" and
     existing["charged"] == true then
    return cjson.encode({
      outcome = "existing",
      record = existing
    })
  end
end

local record = cjson.decode(ARGV[1])

redis.call(
  "SET",
  KEYS[1],
  ARGV[1],
  "EX",
  ARGV[2]
)

return cjson.encode({
  outcome = "saved",
  record = record
})
`;

function clean(value, maxLength = 2000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
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

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function funnelSessionKey(sessionId) {
  return `paypro:funnel:session:${sessionId}`;
}

function chargeResultKey(sessionId, offerKey) {
  return `paypro:charge-result:${sessionId}:${offerKey}`;
}

function manualCheckoutKey(token) {
  return `paypro:manual-checkout:${token}`;
}

function duplicateChargeAuditKey(
  sessionId,
  offerKey,
  orderId
) {
  return (
    `paypro:duplicate-charge:${sessionId}:` +
    `${offerKey}:${orderId}`
  );
}

function cometlySentKey(idempotencyKey) {
  return `paypro:cometly:sent:${idempotencyKey}`;
}

function cometlyLockKey(idempotencyKey) {
  return `paypro:cometly:lock:${idempotencyKey}`;
}

function kajabiSentKey(idempotencyKey) {
  return `paypro:kajabi:sent:${idempotencyKey}`;
}

function kajabiLockKey(idempotencyKey) {
  return `paypro:kajabi:lock:${idempotencyKey}`;
}

function isValidSessionIdentifier(value) {
  const identifier = clean(value, 160);

  return (
    identifier.length >= 20 &&
    identifier.length <= 160 &&
    /^[A-Za-z0-9_-]+$/.test(identifier)
  );
}

function isValidFallbackToken(value) {
  const token = clean(value, 160);

  return (
    token.length >= 32 &&
    token.length <= 160 &&
    /^[A-Za-z0-9_-]+$/.test(token)
  );
}

function isValidStoredAccessTokenHash(value) {
  return /^[a-f0-9]{64}$/i.test(clean(value, 128));
}

function pick(obj, keys, maxLength = 2000) {
  for (const key of keys) {
    const value = obj?.[key];

    if (
      value !== undefined &&
      value !== null &&
      clean(value, maxLength) !== ""
    ) {
      return clean(value, maxLength);
    }
  }

  return "";
}

function num(value) {
  const normalized = clean(value, 100)
    .replace(/\s/g, "")
    .replace(",", ".");

  const parsed = Number.parseFloat(normalized);

  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : 0;
}

function normalizeEmail(value) {
  return clean(value, 254).toLowerCase();
}

function validEmail(value) {
  const email = normalizeEmail(value);

  return (
    email.length >= 3 &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function maskEmail(value) {
  const email = normalizeEmail(value);

  if (!validEmail(email)) {
    return email ? "[invalid-email]" : "";
  }

  const atIndex = email.indexOf("@");
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  return `${local.slice(0, 2)}***@${domain}`;
}

function parseParamString(value) {
  const output = {};
  const input = String(value ?? "")
    .trim()
    .replace(/^\?/, "")
    .replace(/&amp;/gi, "&");

  if (!input || input.length > 50000) {
    return output;
  }

  try {
    const params = new URLSearchParams(input);

    params.forEach((paramValue, key) => {
      const normalizedKey = clean(key, 200);

      if (!normalizedKey) {
        return;
      }

      output[normalizedKey] = clean(paramValue, 4000);

      if (normalizedKey.startsWith("x-")) {
        output[normalizedKey.slice(2)] =
          clean(paramValue, 4000);
      }
    });
  } catch {}

  return output;
}

function normalizeBody(body) {
  if (!body) {
    return {};
  }

  if (isPlainObject(body)) {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    return parseParamString(body.toString("utf8"));
  }

  if (typeof body === "string") {
    const trimmed = body.trim();

    if (!trimmed) {
      return {};
    }

    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);

        return isPlainObject(parsed)
          ? parsed
          : {};
      } catch {}
    }

    return parseParamString(trimmed);
  }

  return {};
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
    ...raw
  };
}

function verifyPayProSignature(data) {
  const validationKey = clean(
    process.env.PAYPRO_VALIDATION_KEY,
    4000
  );

  if (!validationKey) {
    throw new Error("Missing PAYPRO_VALIDATION_KEY");
  }

  const received = pick(
    data,
    ["SIGNATURE"],
    128
  ).toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(received)) {
    return false;
  }

  const signedValue =
    clean(data.ORDER_ID, 200) +
    clean(data.ORDER_STATUS, 200) +
    clean(data.ORDER_TOTAL_AMOUNT, 200) +
    clean(data.CUSTOMER_EMAIL, 254) +
    validationKey +
    clean(data.TEST_MODE, 50) +
    clean(data.IPN_TYPE_NAME, 200);

  const expected = createHash("sha256")
    .update(signedValue, "utf8")
    .digest("hex");

  return safeEqual(received, expected);
}

function getOfferStep(data) {
  return pick(
    data,
    ["x-offer_step", "offer_step", "OFFER_STEP"],
    200
  ).toLowerCase();
}

function isCheckoutMain(data) {
  const step = getOfferStep(data);

  return !step || step === "checkout_main";
}

function isMainProductIpn(data) {
  return (
    isCheckoutMain(data) &&
    pick(data, ["PRODUCT_ID"], 100) ===
      MAIN_CHECKOUT_PRODUCT_ID
  );
}

function isCheckoutBumpIpn(data) {
  const productId = pick(data, ["PRODUCT_ID"], 100);

  return (
    isCheckoutMain(data) &&
    Boolean(productId) &&
    productId !== MAIN_CHECKOUT_PRODUCT_ID
  );
}

function isUpsellIpn(data) {
  const productId = pick(data, ["PRODUCT_ID"], 100);

  if (UPSELL_PRODUCT_IDS.has(productId)) {
    return true;
  }

  const step = getOfferStep(data);

  return [
    "upsell",
    "downsell",
    "fasttrack",
    "fast_track",
    "fast-track"
  ].some((part) => step.includes(part));
}

function getMainAmount(data) {
  return (
    num(data.ORDER_TOTAL_AMOUNT) ||
    num(data.ORDER_TOTAL_AMOUNT_SHOWN) ||
    num(data.ORDER_TOTAL_AMOUNT_WITH_TAXES_SHOWN) ||
    num(data.ORDER_TOTAL_BALANCE_CURRENCY_AMOUNT) ||
    num(data.ORDER_ITEM_TOTAL_AMOUNT)
  );
}

function getUpsellAmount(data) {
  return (
    num(data.ORDER_TOTAL_AMOUNT) ||
    num(data.ORDER_ITEM_TOTAL_AMOUNT) ||
    num(data.ORDER_ITEM_BALANCE_CURRENCY_TOTAL_AMOUNT) ||
    num(data.ORDER_TOTAL_AMOUNT_SHOWN) ||
    num(data.ORDER_TOTAL_BALANCE_CURRENCY_AMOUNT)
  );
}

function getCurrency(data) {
  return (
    pick(data, ["ORDER_CURRENCY_CODE"], 20) ||
    pick(data, ["VENDOR_BALANCE_CURRENCY_CODE"], 20) ||
    "USD"
  ).toUpperCase();
}

function getEventTime(data) {
  const raw = pick(
    data,
    ["ORDER_PLACED_TIME_UTC"],
    200
  );

  if (!raw) {
    return new Date().toISOString();
  }

  const direct = new Date(raw);

  if (!Number.isNaN(direct.getTime())) {
    return direct.toISOString();
  }

  const assumedUtc = new Date(`${raw} UTC`);

  return Number.isNaN(assumedUtc.getTime())
    ? new Date().toISOString()
    : assumedUtc.toISOString();
}

function cleanPageUrl(value) {
  const input = clean(value, 4000);

  if (!input) {
    return "";
  }

  try {
    const url = new URL(input);

    if (
      url.protocol !== "https:" &&
      url.protocol !== "http:"
    ) {
      return "";
    }

    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function getRequestIp(req) {
  const forwarded =
    req.headers["x-vercel-forwarded-for"] ||
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    "";

  return clean(String(forwarded).split(",")[0], 100);
}

function isTestMode(data) {
  return ["1", "true", "yes"].includes(
    pick(data, ["TEST_MODE"], 20).toLowerCase()
  );
}

async function redisCommand(command) {
  const url = clean(
    process.env.KV_REST_API_URL,
    2000
  ).replace(/\/+$/, "");

  const token = clean(
    process.env.KV_REST_API_TOKEN,
    4000
  );

  if (!url || !token) {
    throw new Error(
      "Missing KV_REST_API_URL or KV_REST_API_TOKEN"
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    8000
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(command),
      signal: controller.signal
    });

    const payload = await response
      .json()
      .catch(() => null);

    if (
      !response.ok ||
      !payload ||
      Object.prototype.hasOwnProperty.call(
        payload,
        "error"
      )
    ) {
      throw new Error(
        `Redis command failed: ${
          payload?.error || response.status
        }`
      );
    }

    return payload.result;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseStoredRecord(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (isPlainObject(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);

    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readJsonFromRedis(key) {
  const stored = await redisCommand(["GET", key]);

  if (stored === null || stored === undefined) {
    return null;
  }

  const parsed = parseStoredRecord(stored);

  if (!parsed) {
    throw new Error(
      "Stored funnel session contains invalid JSON"
    );
  }

  return parsed;
}

async function writeJsonToRedis(key, value, ttlSeconds) {
  await redisCommand([
    "SET",
    key,
    JSON.stringify(value),
    "EX",
    String(ttlSeconds)
  ]);
}

function sessionIdentityMatches(
  session,
  sessionId,
  checkoutIntentId
) {
  return Boolean(
    session &&
    safeEqual(session.fs_session_id, sessionId) &&
    safeEqual(
      session.fs_checkout_intent_id,
      checkoutIntentId
    ) &&
    isValidStoredAccessTokenHash(
      session.access_token_hash
    )
  );
}

function getSessionIdentifiers(data) {
  return {
    sessionId: pick(
      data,
      ["x-fs_session_id", "fs_session_id"],
      160
    ),
    checkoutIntentId: pick(
      data,
      [
        "x-fs_checkout_intent_id",
        "fs_checkout_intent_id"
      ],
      160
    )
  };
}

function getCustomer(data) {
  return {
    email: normalizeEmail(
      pick(
        data,
        [
          "CUSTOMER_EMAIL",
          "billing-email",
          "x-grant_email",
          "grant_email",
          "x-kajabi_email",
          "kajabi_email"
        ],
        254
      )
    ),
    firstName: pick(
      data,
      ["CUSTOMER_FIRST_NAME"],
      100
    ),
    lastName: pick(
      data,
      ["CUSTOMER_LAST_NAME"],
      100
    ),
    fullName: pick(
      data,
      ["CUSTOMER_NAME"],
      220
    ),
    phone: pick(
      data,
      ["CUSTOMER_PHONE"],
      100
    )
  };
}

async function persistMainCheckout(data) {
  const { sessionId, checkoutIntentId } =
    getSessionIdentifiers(data);

  const orderId = pick(data, ["ORDER_ID"], 200);
  const productId = pick(data, ["PRODUCT_ID"], 100);

  if (
    !isValidSessionIdentifier(sessionId) ||
    !isValidSessionIdentifier(checkoutIntentId) ||
    !/^\d+$/.test(orderId)
  ) {
    return {
      authorized: false,
      reason: "missing_or_invalid_identifiers"
    };
  }

  const customer = getCustomer(data);

  if (!validEmail(customer.email)) {
    return {
      authorized: false,
      reason: "missing_or_invalid_customer_email"
    };
  }

  const now = new Date();
  const updatedAt = now.toISOString();

  const expiresAt = new Date(
    now.getTime() + SESSION_TTL_SECONDS * 1000
  ).toISOString();

  const paidAt = getEventTime(data);
  const key = funnelSessionKey(sessionId);

  const result = await redisCommand([
    "EVAL",
    UPDATE_MAIN_SESSION_SCRIPT,
    "1",
    key,
    sessionId,
    checkoutIntentId,
    orderId,
    productId,
    customer.email,
    customer.firstName,
    customer.lastName,
    customer.phone,
    getCurrency(data),
    String(getMainAmount(data)),
    pick(data, ["IPN_TYPE_NAME"], 200),
    pick(data, ["ORDER_STATUS"], 200),
    paidAt,
    updatedAt,
    expiresAt,
    String(SESSION_TTL_SECONDS)
  ]);

  const rejectionReasons = new Set([
    "MISSING",
    "INVALID",
    "SESSION_MISMATCH",
    "INTENT_MISMATCH",
    "INSECURE_SESSION",
    "ORDER_MISMATCH"
  ]);

  if (rejectionReasons.has(result)) {
    return {
      authorized: false,
      reason: result.toLowerCase()
    };
  }

  const session = parseStoredRecord(result);

  if (
    !sessionIdentityMatches(
      session,
      sessionId,
      checkoutIntentId
    ) ||
    !safeEqual(session.paypro_root_order_id, orderId)
  ) {
    throw new Error(
      "Redis returned an invalid updated funnel session"
    );
  }

  return {
    authorized: true,
    session,
    sessionId,
    checkoutIntentId,
    orderId
  };
}

async function authorizeUpsell(data) {
  const { sessionId, checkoutIntentId } =
    getSessionIdentifiers(data);

  const rootOrderId = pick(
    data,
    [
      "x-root_order_id",
      "root_order_id",
      "x-parent_order_id",
      "parent_order_id"
    ],
    200
  );

  if (
    !isValidSessionIdentifier(sessionId) ||
    !isValidSessionIdentifier(checkoutIntentId) ||
    !/^\d+$/.test(rootOrderId)
  ) {
    return {
      authorized: false,
      reason: "missing_or_invalid_upsell_identifiers"
    };
  }

  const session = await readJsonFromRedis(
    funnelSessionKey(sessionId)
  );

  if (
    !sessionIdentityMatches(
      session,
      sessionId,
      checkoutIntentId
    ) ||
    session.status !== "paid" ||
    session.checkout_completed !== true ||
    !safeEqual(
      session.paypro_root_order_id,
      rootOrderId
    )
  ) {
    return {
      authorized: false,
      reason: "secure_root_session_mismatch"
    };
  }

  return {
    authorized: true,
    session,
    sessionId,
    checkoutIntentId,
    rootOrderId
  };
}

async function authorizeManualUpsell(data) {
  const fallbackToken = pick(
    data,
    ["x-fallback_token", "fallback_token"],
    160
  );

  if (!isValidFallbackToken(fallbackToken)) {
    return {
      authorized: false,
      reason: "missing_or_invalid_fallback_token"
    };
  }

  const fallbackRecord = await readJsonFromRedis(
    manualCheckoutKey(fallbackToken)
  );

  if (
    !fallbackRecord ||
    !["ready", "confirmed"].includes(fallbackRecord.status) ||
    !isValidSessionIdentifier(
      fallbackRecord.fs_session_id
    ) ||
    !isValidSessionIdentifier(
      fallbackRecord.fs_checkout_intent_id
    )
  ) {
    return {
      authorized: false,
      reason: "invalid_or_expired_fallback_record"
    };
  }

  const productId = pick(data, ["PRODUCT_ID"], 100);
  const offer = REFERENCE_CHARGE_OFFERS[productId];

  if (
    !offer ||
    Number(fallbackRecord.productId) !== Number(productId) ||
    !safeEqual(fallbackRecord.offer, offer.offerKey)
  ) {
    return {
      authorized: false,
      reason: "fallback_product_mismatch"
    };
  }

  const session = await readJsonFromRedis(
    funnelSessionKey(fallbackRecord.fs_session_id)
  );

  if (
    !sessionIdentityMatches(
      session,
      fallbackRecord.fs_session_id,
      fallbackRecord.fs_checkout_intent_id
    ) ||
    session.status !== "paid" ||
    session.checkout_completed !== true ||
    !safeEqual(
      session.paypro_root_order_id,
      fallbackRecord.referencedOrderId
    )
  ) {
    return {
      authorized: false,
      reason: "fallback_secure_session_mismatch"
    };
  }

  return {
    authorized: true,
    manualFallback: true,
    fallbackToken,
    session,
    sessionId: fallbackRecord.fs_session_id,
    checkoutIntentId:
      fallbackRecord.fs_checkout_intent_id,
    rootOrderId: fallbackRecord.referencedOrderId
  };
}

async function markManualCheckoutConfirmed(
  fallbackToken,
  offerKey,
  orderId
) {
  if (!isValidFallbackToken(fallbackToken)) {
    return;
  }

  const key = manualCheckoutKey(fallbackToken);
  const existingRecord = await readJsonFromRedis(key);

  if (!existingRecord) {
    return;
  }

  await writeJsonToRedis(
    key,
    {
      ...existingRecord,
      status: "confirmed",
      offer: offerKey,
      confirmedOrderId: orderId,
      confirmedAt: new Date().toISOString()
    },
    CHARGE_RESULT_TTL_SECONDS
  );
}

async function persistUpsellChargeResult(
  data,
  authorization
) {
  const orderId = pick(data, ["ORDER_ID"], 200);
  const productId = pick(data, ["PRODUCT_ID"], 100);
  const offer = REFERENCE_CHARGE_OFFERS[productId];

  if (!offer) {
    return {
      applicable: false,
      saved: false,
      duplicate: false
    };
  }

  if (!/^\d+$/.test(orderId)) {
    throw new Error(
      "Confirmed upsell contains an invalid PayPro order ID"
    );
  }

  const sessionId = clean(
    authorization.sessionId,
    160
  );

  const checkoutIntentId = clean(
    authorization.checkoutIntentId,
    160
  );

  const referencedOrderId = clean(
    authorization.rootOrderId,
    200
  );

  const resultKey = chargeResultKey(
    sessionId,
    offer.offerKey
  );

  const record = {
    status: "confirmed",
    charged: true,
    confirmedByIpn: true,
    offer: offer.offerKey,
    orderId,
    referencedOrderId,
    fs_session_id: sessionId,
    fs_checkout_intent_id: checkoutIntentId,
    productId: Number(productId),
    amount: getUpsellAmount(data) || offer.amount,
    currency: getCurrency(data) || offer.currency,
    createdAt: getEventTime(data),
    recordedBy: "paypro_webhook"
  };

  if (authorization.manualFallback === true) {
    record.manualFallback = true;
  }

  const confirmationResult = parseStoredRecord(
    await redisCommand([
    "EVAL",
    CONFIRM_CHARGE_RESULT_SCRIPT,
    "1",
    resultKey,
    JSON.stringify(record),
    String(CHARGE_RESULT_TTL_SECONDS)
  ])
  );

  if (
    confirmationResult?.outcome === "saved"
  ) {
    if (
      authorization.manualFallback === true &&
      isValidFallbackToken(
        authorization.fallbackToken
      )
    ) {
      await markManualCheckoutConfirmed(
        authorization.fallbackToken,
        offer.offerKey,
        orderId
      );
    }

    return {
      applicable: true,
      saved: true,
      alreadyRecorded: false,
      duplicate: false,
      offerKey: offer.offerKey
    };
  }

  const existingRecord = parseStoredRecord(
    confirmationResult?.record
  );

  if (existingRecord?.charged !== true) {
    throw new Error(
      "Existing upsell charge result is invalid"
    );
  }

  const existingOrderId = clean(
    existingRecord.orderId,
    200
  );

  if (
    authorization.manualFallback === true &&
    isValidFallbackToken(
      authorization.fallbackToken
    ) &&
    existingOrderId &&
    safeEqual(existingOrderId, orderId)
  ) {
    await markManualCheckoutConfirmed(
      authorization.fallbackToken,
      offer.offerKey,
      orderId
    );
  }

  const duplicate = Boolean(
    existingOrderId &&
    !safeEqual(existingOrderId, orderId)
  );

  if (duplicate) {
    await redisCommand([
      "SET",
      duplicateChargeAuditKey(
        sessionId,
        offer.offerKey,
        orderId
      ),
      JSON.stringify({
        duplicate_charge_detected: true,
        offer: offer.offerKey,
        first_order_id: existingOrderId,
        duplicate_order_id: orderId,
        referenced_order_id: referencedOrderId,
        product_id: productId,
        detected_at: new Date().toISOString()
      }),
      "EX",
      String(DUPLICATE_CHARGE_AUDIT_TTL_SECONDS)
    ]);
  }

  return {
    applicable: true,
    saved: false,
    alreadyRecorded: !duplicate,
    duplicate,
    offerKey: offer.offerKey,
    existingOrderId
  };
}

function getAttributionValue(session, data, keys) {
  const attribution = isPlainObject(session?.attribution)
    ? session.attribution
    : {};

  for (const key of keys) {
    const value = clean(attribution[key], 2000);

    if (value) {
      return value;
    }
  }

  const payProKeys = [];

  keys.forEach((key) => {
    payProKeys.push(`x-${key}`, key);
  });

  return pick(data, payProKeys, 2000);
}

function getEventUrl(session, data) {
  const requestContext = isPlainObject(
    session?.request_context
  )
    ? session.request_context
    : {};

  const attribution = isPlainObject(session?.attribution)
    ? session.attribution
    : {};

  return (
    cleanPageUrl(requestContext.page_url) ||
    cleanPageUrl(attribution.latest_page_url) ||
    cleanPageUrl(attribution.landing_page_url) ||
    cleanPageUrl(
      pick(data, [
        "x-checkout_page_url",
        "checkout_page_url",
        "ORDER_REFERRER_URL"
      ])
    ) ||
    "https://flexiblest.com/secure-checkout"
  );
}

function buildCometlyEvent(data, req, session, kind) {
  const customer = getCustomer(data);

  const email = validEmail(customer.email)
    ? customer.email
    : normalizeEmail(session.customer_email);

  if (!validEmail(email)) {
    throw new Error(
      "PayPro purchase event does not contain a valid email"
    );
  }

  const orderId = pick(data, ["ORDER_ID"], 200);
  const productId = pick(data, ["PRODUCT_ID"], 100);
  const upsell = kind === "upsell";

  const sessionId = clean(
    session.fs_session_id,
    160
  );

  const checkoutIntentId = clean(
    session.fs_checkout_intent_id,
    160
  );

  const rootOrderId = clean(
    session.paypro_root_order_id,
    200
  );

  const cometToken = getAttributionValue(
    session,
    data,
    ["comet_token", "cometly_token"]
  );

  const fingerprint = getAttributionValue(
    session,
    data,
    ["comet_fingerprint", "cometly_fingerprint", "fingerprint"]
  );

  const cometlyClickId = getAttributionValue(
    session,
    data,
    ["cometly_click_id", "cometly_id"]
  );

  const fbclid = getAttributionValue(
    session,
    data,
    ["fbclid"]
  );

  const fbc = getAttributionValue(
    session,
    data,
    ["fbc", "_fbc"]
  );

  const fbp = getAttributionValue(
    session,
    data,
    ["fbp", "_fbp"]
  );

  const gclid = getAttributionValue(
    session,
    data,
    ["gclid"]
  );

  const ttclid = getAttributionValue(
    session,
    data,
    ["ttclid"]
  );

  const utmSource = getAttributionValue(
    session,
    data,
    ["utm_source"]
  );

  const utmMedium = getAttributionValue(
    session,
    data,
    ["utm_medium"]
  );

  const utmCampaign = getAttributionValue(
    session,
    data,
    ["utm_campaign"]
  );

  const utmContent = getAttributionValue(
    session,
    data,
    ["utm_content"]
  );

  const utmTerm = getAttributionValue(
    session,
    data,
    ["utm_term"]
  );

  const requestContext = isPlainObject(
    session.request_context
  )
    ? session.request_context
    : {};

  const amount = upsell
    ? getUpsellAmount(data)
    : getMainAmount(data);

  const idempotencyKey = upsell
    ? `paypro-${orderId}-${productId}`
    : `paypro-${orderId}-purchase`;

  const firstName =
    customer.firstName ||
    clean(session.customer_first_name, 100);

  const lastName =
    customer.lastName ||
    clean(session.customer_last_name, 100);

  return {
    event_name: upsell
      ? UPSELL_EVENT_NAME
      : MAIN_EVENT_NAME,

    email,
    first_name: firstName,
    last_name: lastName,

    full_name:
      customer.fullName ||
      clean(`${firstName} ${lastName}`, 220),

    phone:
      customer.phone ||
      clean(session.customer_phone, 100),

    ip:
      pick(data, ["CUSTOMER_IP"], 100) ||
      clean(requestContext.ip_address, 100) ||
      getRequestIp(req),

    user_agent:
      clean(requestContext.user_agent, 1500) ||
      clean(req.headers["user-agent"], 1500),

    comet_token: cometToken,
    fingerprint,

    event_time: getEventTime(data),
    url: getEventUrl(session, data),

    amount,
    currency: getCurrency(data),

    order_id: orderId,

    order_name:
      pick(data, ["ORDER_ITEM_NAME"], 500) ||
      (upsell
        ? "PayPro Upsell"
        : "AccelStretch System"),

    tracking_id:
      cometlyClickId ||
      cometToken ||
      checkoutIntentId ||
      fbc ||
      fbp ||
      fbclid ||
      email ||
      orderId,

    checkout_token: checkoutIntentId,
    is_upsell: upsell,

    upsell_common_id: rootOrderId || orderId,
    idempotency_key: idempotencyKey,

    comet_source: utmSource,
    comet_network: utmSource,
    comet_campaign: utmCampaign,
    comet_ad_group: utmContent,
    comet_ad_id: fbclid,
    comet_keyword: utmTerm,
    comet_type: utmMedium,

    profile_field_1: "paypro",

    profile_field_2:
      clean(session.funnel_id, 200) ||
      "accelstretch_paypro_flow",

    profile_field_3:
      getOfferStep(data) ||
      (upsell ? "upsell" : "checkout_main"),

    profile_field_4: productId,
    profile_field_5: pick(data, ["ORDER_ITEM_SKU"], 300),
    profile_field_6: pick(data, ["ORDER_ITEM_NAME"], 500),
    profile_field_7: pick(data, ["PAYMENT_METHOD_NAME"], 200),

    profile_field_8: pick(
      data,
      [
        "CUSTOMER_COUNTRY_CODE",
        "CUSTOMER_COUNTRY_CODE_BY_IP"
      ],
      20
    ),

    profile_field_9: pick(
      data,
      ["x-selected_order_bumps", "selected_order_bumps"],
      500
    ),

    profile_field_10: fbclid,
    profile_field_11: fbc,
    profile_field_12: fbp,
    profile_field_13: gclid,
    profile_field_14: ttclid,
    profile_field_15: "secure_session_v1",

    fs_session_id: sessionId,
    fs_checkout_intent_id: checkoutIntentId
  };
}

async function releaseLock(lockKey, lockToken) {
  if (!lockKey || !lockToken) {
    return;
  }

  await redisCommand([
    "EVAL",
    RELEASE_LOCK_SCRIPT,
    "1",
    lockKey,
    lockToken
  ]);
}

function isFullItemRefund(data) {
  const itemTotal = num(data.ORDER_ITEM_TOTAL_AMOUNT);
  const itemRefunded = num(data.ORDER_ITEM_REFUNDED);

  return (
    itemTotal > 0 &&
    itemRefunded + 0.005 >= itemTotal
  );
}

function getKajabiAccessAction(data) {
  const ipnType = pick(
    data,
    ["IPN_TYPE_NAME"],
    200
  ).toLowerCase();

  if (
    ipnType === "ordercharged" ||
    ipnType === "orderchargedbackwon"
  ) {
    return "activate";
  }

  if (
    ipnType === "orderrefunded" ||
    ipnType === "orderchargedback"
  ) {
    return "deactivate";
  }

  if (
    ipnType === "orderpartiallyrefunded" &&
    isFullItemRefund(data)
  ) {
    return "deactivate";
  }

  return "";
}

function getKajabiWebhookUrl(offer, action) {
  const envName = action === "activate"
    ? offer.activationEnv
    : offer.deactivationEnv;

  const raw = clean(process.env[envName], 5000);

  if (!raw) {
    throw new Error(`Missing ${envName}`);
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${envName}`);
  }

  if (
    url.protocol !== "https:" ||
    ![
      "checkout.kajabi.com",
      "checkout.newkajabi.com"
    ].includes(url.hostname.toLowerCase()) ||
    !url.pathname.includes("/webhooks/offers/")
  ) {
    throw new Error(`Untrusted ${envName}`);
  }

  if (
    action === "activate" &&
    offer.offerKey === "accelstretch"
  ) {
    url.searchParams.set(
      "send_offer_grant_email",
      "true"
    );
  }

  return url;
}

function kajabiResponseAlreadyApplied(status, body) {
  if (![400, 409, 422].includes(status)) {
    return false;
  }

  const message = clean(body, 2000).toLowerCase();

  return [
    "already been granted",
    "already granted",
    "already activated",
    "already deactivated",
    "already revoked"
  ].some((part) => message.includes(part));
}

async function processKajabiAccess(data) {
  const productId = pick(data, ["PRODUCT_ID"], 100);
  const offer = KAJABI_PRODUCT_OFFERS[productId];

  if (!offer) {
    return {
      applicable: false,
      delivered: false
    };
  }

  const action = getKajabiAccessAction(data);

  if (!action) {
    return {
      applicable: true,
      delivered: false,
      skipped: true,
      reason:
        pick(data, ["IPN_TYPE_NAME"], 200)
          .toLowerCase() === "orderpartiallyrefunded"
          ? "partial_item_refund"
          : "non_access_ipn"
    };
  }

  if (isTestMode(data)) {
    return {
      applicable: true,
      action,
      delivered: false,
      skipped: true,
      reason: "test_mode"
    };
  }

  const customer = getCustomer(data);

  if (!validEmail(customer.email)) {
    throw new Error(
      "Kajabi fulfillment requires a valid customer email"
    );
  }

  const fullName =
    customer.fullName ||
    clean(
      `${customer.firstName} ${customer.lastName}`,
      220
    ) ||
    "Customer";

  const orderId = pick(data, ["ORDER_ID"], 200);
  const orderItemId =
    pick(data, ["ORDER_ITEM_ID"], 200) ||
    productId;
  const ipnType = pick(
    data,
    ["IPN_TYPE_NAME"],
    200
  ).toLowerCase();

  if (!/^\d+$/.test(orderId)) {
    throw new Error(
      "Kajabi fulfillment requires a valid PayPro order ID"
    );
  }

  const idempotencyKey = [
    orderId,
    orderItemId,
    offer.offerKey,
    ipnType
  ].join(":");

  const sentKey = kajabiSentKey(idempotencyKey);
  const existing = parseStoredRecord(
    await redisCommand(["GET", sentKey])
  );

  if (existing?.delivered === true) {
    return {
      applicable: true,
      action,
      delivered: true,
      alreadyDelivered: true,
      offerId: offer.offerId
    };
  }

  const lockKey = kajabiLockKey(idempotencyKey);
  const lockToken = createHash("sha256")
    .update(
      `${idempotencyKey}:${Date.now()}:${Math.random()}`,
      "utf8"
    )
    .digest("hex");

  const lockResult = await redisCommand([
    "SET",
    lockKey,
    lockToken,
    "NX",
    "EX",
    String(KAJABI_LOCK_SECONDS)
  ]);

  if (lockResult !== "OK") {
    return {
      applicable: true,
      action,
      delivered: false,
      processing: true,
      offerId: offer.offerId
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      10000
    );

    let response;
    let responseText = "";

    try {
      response = await fetch(
        getKajabiWebhookUrl(offer, action),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: fullName,
            email: customer.email,
            external_user_id: customer.email
          }),
          signal: controller.signal
        }
      );

      responseText = await response.text();
    } finally {
      clearTimeout(timeoutId);
    }

    if (
      !response.ok &&
      !kajabiResponseAlreadyApplied(
        response.status,
        responseText
      )
    ) {
      console.error("KAJABI WEBHOOK REJECTED", {
        status: response.status,
        action,
        offer_id: offer.offerId,
        order_id: orderId,
        order_item_id: orderItemId
      });

      throw new Error(
        `Kajabi rejected ${action} with HTTP ${response.status}`
      );
    }

    await redisCommand([
      "SET",
      sentKey,
      JSON.stringify({
        delivered: true,
        action,
        offer_id: offer.offerId,
        order_id: orderId,
        order_item_id: orderItemId,
        ipn_type: ipnType,
        delivered_at: new Date().toISOString()
      }),
      "EX",
      String(KAJABI_DELIVERY_TTL_SECONDS)
    ]);

    await releaseLock(lockKey, lockToken);

    console.log("KAJABI ACCESS UPDATED", {
      action,
      offer_id: offer.offerId,
      order_id: orderId,
      order_item_id: orderItemId
    });

    return {
      applicable: true,
      action,
      delivered: true,
      alreadyDelivered: false,
      offerId: offer.offerId
    };
  } catch (error) {
    try {
      await releaseLock(lockKey, lockToken);
    } catch {}

    throw error;
  }
}

async function sendCometlyEvent(event) {
  const apiKey = clean(
    process.env.COMETLY_API_KEY,
    4000
  );

  if (!apiKey) {
    throw new Error("Missing COMETLY_API_KEY");
  }

  const sentKey = cometlySentKey(
    event.idempotency_key
  );

  const existingResult = parseStoredRecord(
    await redisCommand(["GET", sentKey])
  );

  if (existingResult?.sent === true) {
    return {
      sent: true,
      alreadySent: true
    };
  }

  const lockKey = cometlyLockKey(
    event.idempotency_key
  );

  const lockToken = createHash("sha256")
    .update(
      `${event.idempotency_key}:${Date.now()}:${Math.random()}`,
      "utf8"
    )
    .digest("hex");

  const lockResult = await redisCommand([
    "SET",
    lockKey,
    lockToken,
    "NX",
    "EX",
    String(COMETLY_LOCK_SECONDS)
  ]);

  if (lockResult !== "OK") {
    return {
      sent: false,
      processing: true
    };
  }

  try {
    const controller = new AbortController();

    const timeoutId = setTimeout(
      () => controller.abort(),
      10000
    );

    let response;
    let responseText = "";

    try {
      response = await fetch(COMETLY_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(event),
        signal: controller.signal
      });

      responseText = await response.text();
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      console.error("COMETLY EVENT REJECTED", {
        status: response.status,
        event_name: event.event_name,
        order_id: event.order_id,
        response: clean(responseText, 1000)
      });

      throw new Error(
        `Cometly rejected event with HTTP ${response.status}`
      );
    }

    await redisCommand([
      "SET",
      sentKey,
      JSON.stringify({
        sent: true,
        event_name: event.event_name,
        order_id: event.order_id,
        sent_at: new Date().toISOString()
      }),
      "EX",
      String(COMETLY_EVENT_TTL_SECONDS)
    ]);

    await releaseLock(lockKey, lockToken);

    return {
      sent: true,
      alreadySent: false
    };
  } catch (error) {
    try {
      await releaseLock(lockKey, lockToken);
    } catch {}

    throw error;
  }
}

function buildSafeLog(data) {
  const { sessionId, checkoutIntentId } =
    getSessionIdentifiers(data);

  return {
    order_id: pick(data, ["ORDER_ID"], 200),
    product_id: pick(data, ["PRODUCT_ID"], 100),
    order_item_id: pick(data, ["ORDER_ITEM_ID"], 200),
    order_status: pick(data, ["ORDER_STATUS"], 200),
    ipn_type: pick(data, ["IPN_TYPE_NAME"], 200),
    test_mode: pick(data, ["TEST_MODE"], 20),
    customer_email: maskEmail(data.CUSTOMER_EMAIL),
    has_session_id: Boolean(sessionId),
    has_checkout_intent_id: Boolean(checkoutIntentId),
    offer_step: getOfferStep(data),
    has_checkout_query_string: Boolean(
      clean(data.CHECKOUT_QUERY_STRING, 10)
    ),
    has_order_custom_fields: Boolean(
      clean(data.ORDER_CUSTOM_FIELDS, 10)
    )
  };
}

function sendSkipped(res, reason, extra = {}) {
  return res.status(200).json({
    ok: true,
    skipped: true,
    sent_to_cometly: false,
    reason,
    ...extra
  });
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );

  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const data = mergePayProData(req.body);

    console.log(
      "PAYPRO IPN RECEIVED",
      buildSafeLog(data)
    );

    if (!verifyPayProSignature(data)) {
      console.error(
        "PAYPRO WEBHOOK SIGNATURE REJECTED",
        {
          order_id: pick(data, ["ORDER_ID"], 200),
          ipn_type: pick(data, ["IPN_TYPE_NAME"], 200),
          has_signature: Boolean(
            pick(data, ["SIGNATURE"], 128)
          )
        }
      );

      return res.status(401).json({
        ok: false,
        error: "Invalid PayPro signature"
      });
    }

    const kajabiAccess = await processKajabiAccess(data);

    const status = pick(
      data,
      ["ORDER_STATUS"],
      200
    ).toLowerCase();

    const ipnType = pick(
      data,
      ["IPN_TYPE_NAME"],
      200
    ).toLowerCase();

    if (status && status !== "processed") {
      return sendSkipped(
        res,
        "non_processed_order",
        {
          kajabi_access_updated:
            kajabiAccess.delivered === true,
          kajabi_action: kajabiAccess.action || ""
        }
      );
    }

    if (ipnType && ipnType !== "ordercharged") {
      return sendSkipped(res, "non_charge_ipn", {
        kajabi_access_updated:
          kajabiAccess.delivered === true,
        kajabi_action: kajabiAccess.action || ""
      });
    }

    const orderId = pick(data, ["ORDER_ID"], 200);
    const productId = pick(data, ["PRODUCT_ID"], 100);

    if (isCheckoutBumpIpn(data)) {
      return sendSkipped(
        res,
        "checkout_bump_item_ipn",
        {
          order_id: orderId,
          product_id: productId,
          kajabi_access_updated:
            kajabiAccess.delivered === true,
          kajabi_already_updated:
            kajabiAccess.alreadyDelivered === true
        }
      );
    }

    let authorization;
    let eventKind;

    const fallbackToken = pick(
      data,
      ["x-fallback_token", "fallback_token"],
      160
    );

    if (isMainProductIpn(data)) {
      authorization = await persistMainCheckout(data);
      eventKind = "main";
    } else if (
      isUpsellIpn(data) &&
      isValidFallbackToken(fallbackToken)
    ) {
      authorization = await authorizeManualUpsell(data);
      eventKind = "upsell";
    } else if (isUpsellIpn(data)) {
      authorization = await authorizeUpsell(data);
      eventKind = "upsell";
    } else {
      return sendSkipped(
        res,
        "unrecognized_product_or_offer_step",
        {
          order_id: orderId,
          product_id: productId
        }
      );
    }

    if (!authorization.authorized) {
      console.warn(
        "PAYPRO SECURE SESSION REJECTED",
        {
          order_id: orderId,
          product_id: productId,
          event_kind: eventKind,
          reason: authorization.reason
        }
      );

      return sendSkipped(
        res,
        "secure_session_rejected",
        {
          order_id: orderId,
          product_id: productId
        }
      );
    }

    console.log(
      "PAYPRO SECURE SESSION VERIFIED",
      {
        order_id: orderId,
        product_id: productId,
        event_kind: eventKind,
        checkout_completed:
          authorization.session.checkout_completed === true
      }
    );

    if (isTestMode(data)) {
      let testChargeRecovery = null;

      if (eventKind === "upsell") {
        testChargeRecovery =
          await persistUpsellChargeResult(
            data,
            authorization
          );
      }

      return res.status(200).json({
        ok: true,
        test_mode: true,
        mapping_saved: eventKind === "main",
        charge_recovery_saved:
          testChargeRecovery?.saved === true,
        secure_session_verified: true,
        kajabi_access_updated: false,
        kajabi_test_skipped:
          kajabiAccess.reason === "test_mode",
        sent_to_cometly: false
      });
    }

    let chargeRecovery = null;

    if (eventKind === "upsell") {
      chargeRecovery =
        await persistUpsellChargeResult(
          data,
          authorization
        );

      if (chargeRecovery.duplicate) {
        console.error(
          "PAYPRO DUPLICATE UPSELL CHARGE DETECTED",
          {
            order_id: orderId,
            original_order_id:
              chargeRecovery.existingOrderId,
            product_id: productId,
            offer: chargeRecovery.offerKey
          }
        );

        return res.status(200).json({
          ok: true,
          duplicate_charge_detected: true,
          secure_session_verified: true,
          kajabi_access_updated:
            kajabiAccess.delivered === true,
          sent_to_cometly: false,
          order_id: orderId
        });
      }

      console.log(
        "PAYPRO UPSELL CHARGE RECOVERY SAVED",
        {
          order_id: orderId,
          product_id: productId,
          offer: chargeRecovery.offerKey || "",
          applicable: chargeRecovery.applicable,
          saved: chargeRecovery.saved,
          already_recorded:
            chargeRecovery.alreadyRecorded === true
        }
      );
    }

    const event = buildCometlyEvent(
      data,
      req,
      authorization.session,
      eventKind
    );

    console.log("COMETLY EVENT PREPARED", {
      event_name: event.event_name,
      order_id: event.order_id,
      amount: event.amount,
      currency: event.currency,
      email: maskEmail(event.email),
      has_first_name: Boolean(event.first_name),
      has_last_name: Boolean(event.last_name),
      has_phone: Boolean(event.phone),
      has_comet_token: Boolean(event.comet_token),
      has_fingerprint: Boolean(event.fingerprint),
      has_ip: Boolean(event.ip),
      has_user_agent: Boolean(event.user_agent),
      url: event.url
    });

    const delivery = await sendCometlyEvent(event);

    if (delivery.processing) {
      return res.status(200).json({
        ok: true,
        sent_to_cometly: false,
        processing: true,
        secure_session_verified: true,
        kajabi_access_updated:
          kajabiAccess.delivered === true,
        event_name: event.event_name,
        order_id: event.order_id
      });
    }

    return res.status(200).json({
      ok: true,
      mapping_saved: eventKind === "main",
      secure_session_verified: true,
      kajabi_access_updated:
        kajabiAccess.delivered === true,
      kajabi_already_updated:
        kajabiAccess.alreadyDelivered === true,
      charge_recovery_saved:
        chargeRecovery?.saved === true,
      sent_to_cometly: delivery.sent,
      already_sent: delivery.alreadySent,
      event_name: event.event_name,
      order_id: event.order_id
    });
  } catch (error) {
    console.error(
      "PAYPRO WEBHOOK ERROR",
      error instanceof Error
        ? error.message
        : "Unknown error"
    );

    return res.status(500).json({
      ok: false,
      error: "Webhook processing failed"
    });
  }
}
