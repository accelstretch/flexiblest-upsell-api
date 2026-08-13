import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";

const PAYPRO_REFERENCE_CHARGE_URL =
  "https://store.payproglobal.com/api/Orders/DoReferenceCharge";

const RECORD_TTL_SECONDS = 72 * 60 * 60;
const MANUAL_CHECKOUT_TTL_SECONDS = 72 * 60 * 60;
const CHARGE_LOCK_SECONDS = 120;
const MAX_REQUEST_BODY_BYTES = 8 * 1024;

const OFFERS = {
  fasttrack57: {
    productId: 133573,
    amount: 57,
    currency: "USD",
    name: "Advanced Fast Track",
    offerStep: "upsell_fasttrack57",
    nextUrl: "https://flexiblest.com/order-complete"
  },

  fasttrack37: {
    productId: 133574,
    amount: 37,
    currency: "USD",
    name:
      "Flexibility And Recovery Fast Track Core - Final Offer",
    offerStep: "downsell_fasttrack37",
    nextUrl: "https://flexiblest.com/order-complete"
  }
};

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end

return 0
`;

const WRITE_STATUS_IF_UNCONFIRMED_SCRIPT = `
local raw = redis.call("GET", KEYS[1])

if raw then
  local ok, existing = pcall(cjson.decode, raw)

  if ok and type(existing) == "table" then
    local charged = existing["charged"] == true
    local confirmed =
      existing["confirmedByIpn"] == true or
      tostring(existing["status"] or "") == "confirmed"

    if charged or confirmed then
      return raw
    end
  end
end

redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
return ARGV[1]
`;

function clean(value, maxLength = 4000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function funnelSessionKey(sessionId) {
  return `paypro:funnel:session:${sessionId}`;
}

function chargeResultKey(sessionId, offerKey) {
  return `paypro:charge-result:${sessionId}:${offerKey}`;
}

function chargeLockKey(sessionId, offerKey) {
  return `paypro:charge-lock:${sessionId}:${offerKey}`;
}

function manualCheckoutKey(token) {
  return `paypro:manual-checkout:${token}`;
}

function manualCheckoutIndexKey(sessionId, offerKey) {
  return `paypro:manual-checkout-index:${sessionId}:${offerKey}`;
}

function hashAccessToken(token) {
  return createHash("sha256")
    .update(String(token || ""), "utf8")
    .digest("hex");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(clean(value));

    if (
      parsed.protocol !== "https:" &&
      parsed.protocol !== "http:"
    ) {
      return "";
    }

    return parsed.origin;
  } catch {
    return "";
  }
}

function getAllowedOrigins() {
  const configured = [
    process.env.APP_BASE_URL,
    process.env.PAYPRO_FUNNEL_ALLOWED_ORIGINS
  ]
    .filter(Boolean)
    .join(",");

  const configuredOrigins = configured
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  return new Set([
    "https://flexiblest.com",
    "https://www.flexiblest.com",
    ...configuredOrigins
  ]);
}

const ALLOWED_ORIGINS = getAllowedOrigins();

function setCors(req, res) {
  const normalizedOrigin = normalizeOrigin(req.headers.origin);

  if (normalizedOrigin && ALLOWED_ORIGINS.has(normalizedOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", normalizedOrigin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type"
  );
  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, max-age=0, must-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function isOriginAllowed(req) {
  const requestOrigin = clean(req.headers.origin);

  if (!requestOrigin) {
    return true;
  }

  const normalizedOrigin = normalizeOrigin(requestOrigin);

  return Boolean(
    normalizedOrigin && ALLOWED_ORIGINS.has(normalizedOrigin)
  );
}

function isValidIdentifier(value) {
  const identifier = clean(value, 160);

  return (
    identifier.length >= 16 &&
    identifier.length <= 160 &&
    /^[A-Za-z0-9_-]+$/.test(identifier)
  );
}

function isValidManualCheckoutToken(value) {
  const token = clean(value, 160);

  return (
    token.length >= 32 &&
    token.length <= 160 &&
    /^[A-Za-z0-9_-]+$/.test(token)
  );
}

function parseRequestBody(req) {
  let body = req.body;

  if (body === undefined || body === null || body === "") {
    return {};
  }

  if (Buffer.isBuffer(body)) {
    if (body.length > MAX_REQUEST_BODY_BYTES) {
      throw new Error("REQUEST_BODY_TOO_LARGE");
    }

    body = body.toString("utf8");
  }

  if (typeof body === "string") {
    if (
      Buffer.byteLength(body, "utf8") >
      MAX_REQUEST_BODY_BYTES
    ) {
      throw new Error("REQUEST_BODY_TOO_LARGE");
    }

    try {
      body = JSON.parse(body);
    } catch {
      throw new Error("INVALID_JSON_BODY");
    }
  }

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    throw new Error("INVALID_JSON_BODY");
  }

  if (
    Buffer.byteLength(JSON.stringify(body), "utf8") >
    MAX_REQUEST_BODY_BYTES
  ) {
    throw new Error("REQUEST_BODY_TOO_LARGE");
  }

  return body;
}

async function redisCommand(command) {
  const url = clean(process.env.KV_REST_API_URL)
    .replace(/\/+$/, "");

  const token = clean(process.env.KV_REST_API_TOKEN);

  if (!url || !token) {
    throw new Error(
      "Missing KV_REST_API_URL or KV_REST_API_TOKEN"
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

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

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.error) {
      throw new Error(
        `Redis command failed: ${data.error || response.status}`
      );
    }

    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}

function parseStoredRecord(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);

    return (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    )
      ? parsed
      : null;
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
    throw new Error("Stored Redis record contains invalid JSON");
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

function sessionCredentialsAreValid({
  session,
  sessionId,
  checkoutIntentId,
  accessToken
}) {
  if (
    !session ||
    !safeEqual(session.fs_session_id, sessionId) ||
    !safeEqual(
      session.fs_checkout_intent_id,
      checkoutIntentId
    )
  ) {
    return false;
  }

  const storedHash = clean(session.access_token_hash, 128);

  if (!/^[a-f0-9]{64}$/i.test(storedHash)) {
    return false;
  }

  return safeEqual(
    storedHash.toLowerCase(),
    hashAccessToken(accessToken).toLowerCase()
  );
}

function isValidPayProOrderId(value) {
  const orderId = clean(value, 100);

  if (!/^\d+$/.test(orderId)) {
    return false;
  }

  const numericOrderId = Number(orderId);

  return (
    Number.isSafeInteger(numericOrderId) &&
    numericOrderId > 0
  );
}

function payProBoolean(data, key) {
  return data?.[key] === true || data?.[key] === false
    ? data[key]
    : null;
}

function getPayProSuccess(data) {
  return (
    payProBoolean(data, "isSuccess") ??
    payProBoolean(data, "IsSuccess")
  );
}

function getPayProStatus(data) {
  return clean(
    data?.response?.orderStatusName ||
      data?.Response?.OrderStatusName,
    100
  ).toLowerCase();
}

function getPayProOrderId(data) {
  return clean(
    data?.response?.orderId ||
      data?.Response?.OrderId,
    100
  );
}

function isProcessedCharge(data) {
  return (
    getPayProSuccess(data) === true &&
    getPayProStatus(data) === "processed"
  );
}

function isExplicitChargeFailure(data) {
  const success = getPayProSuccess(data);
  const status = getPayProStatus(data);

  return (
    success === false ||
    ["canceled", "cancelled", "declined", "failed"].includes(
      status
    )
  );
}

function isConfirmedResult(record) {
  return Boolean(
    record &&
    record.charged === true &&
    (
      record.confirmedByIpn === true ||
      record.status === "confirmed" ||
      !record.status
    )
  );
}

async function createManualCheckout({
  sessionId,
  checkoutIntentId,
  referencedOrderId,
  offerKey,
  offer
}) {
  const indexKey = manualCheckoutIndexKey(sessionId, offerKey);
  let token = clean(await redisCommand(["GET", indexKey]), 160);
  let record = null;

  if (isValidManualCheckoutToken(token)) {
    record = await readJsonFromRedis(manualCheckoutKey(token));

    if (
      !record ||
      !safeEqual(record.fs_session_id, sessionId) ||
      !safeEqual(
        record.fs_checkout_intent_id,
        checkoutIntentId
      ) ||
      !safeEqual(record.offer, offerKey) ||
      Number(record.productId) !== offer.productId
    ) {
      token = "";
      record = null;
    }
  }

  if (!token) {
    token = randomBytes(32).toString("base64url");

    record = {
      status: "ready",
      tokenVersion: 1,
      offer: offerKey,
      productId: offer.productId,
      amount: offer.amount,
      currency: offer.currency,
      fs_session_id: sessionId,
      fs_checkout_intent_id: checkoutIntentId,
      referencedOrderId,
      createdAt: new Date().toISOString()
    };

    await writeJsonToRedis(
      manualCheckoutKey(token),
      record,
      MANUAL_CHECKOUT_TTL_SECONDS
    );

    await redisCommand([
      "SET",
      indexKey,
      token,
      "EX",
      String(MANUAL_CHECKOUT_TTL_SECONDS)
    ]);
  }

  const resultRecord = {
    status: "manual_checkout_required",
    charged: false,
    confirmedByIpn: false,
    offer: offerKey,
    productId: offer.productId,
    amount: offer.amount,
    currency: offer.currency,
    fallbackToken: token,
    updatedAt: new Date().toISOString()
  };

  const storedResult = parseStoredRecord(
    await redisCommand([
      "EVAL",
      WRITE_STATUS_IF_UNCONFIRMED_SCRIPT,
      "1",
      chargeResultKey(sessionId, offerKey),
      JSON.stringify(resultRecord),
      String(RECORD_TTL_SECONDS)
    ])
  );

  if (isConfirmedResult(storedResult)) {
    return {
      ...storedResult,
      alreadyConfirmed: true,
      fallbackToken: ""
    };
  }

  return {
    ...resultRecord,
    fallbackToken: token
  };
}

function publicResult(record, offerKey, offer) {
  if (isConfirmedResult(record)) {
    return {
      httpStatus: 200,
      body: {
        ok: true,
        charged: true,
        confirmed: true,
        processing: false,
        offer: offerKey,
        product_id: offer.productId,
        amount: Number(record.amount) || offer.amount,
        currency: clean(record.currency, 20) || offer.currency,
        next_url: offer.nextUrl
      }
    };
  }

  if (
    record?.status === "manual_checkout_required" &&
    isValidManualCheckoutToken(
      record.fallbackToken || record.fallback_token
    )
  ) {
    return {
      httpStatus: 200,
      body: {
        ok: true,
        charged: false,
        confirmed: false,
        processing: false,
        fallback: true,
        offer: offerKey,
        product_id: offer.productId,
        amount: offer.amount,
        currency: offer.currency,
        fallback_token:
          record.fallbackToken || record.fallback_token
      }
    };
  }

  if (
    record?.status === "awaiting_ipn" ||
    record?.status === "charge_requested" ||
    record?.status === "api_result_ambiguous"
  ) {
    return {
      httpStatus: 202,
      body: {
        ok: true,
        charged: false,
        confirmed: false,
        processing: true,
        confirmation_pending: true,
        offer: offerKey,
        product_id: offer.productId,
        amount: offer.amount,
        currency: offer.currency
      }
    };
  }

  return {
    httpStatus: 200,
    body: {
      ok: true,
      charged: false,
      confirmed: false,
      processing: false,
      offer: offerKey,
      product_id: offer.productId,
      amount: offer.amount,
      currency: offer.currency
    }
  };
}

function sendUnauthorized(res) {
  res.setHeader(
    "WWW-Authenticate",
    'Bearer realm="PayPro funnel"'
  );

  return res.status(401).json({
    ok: false,
    error: "Invalid or expired funnel credentials."
  });
}

async function releaseChargeLock(lockKey, lockToken) {
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

export default async function handler(req, res) {
  setCors(req, res);

  if (!isOriginAllowed(req)) {
    return res.status(403).json({
      ok: false,
      error: "Origin is not allowed."
    });
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");

    return res.status(405).json({
      ok: false,
      error: "Method not allowed."
    });
  }

  let lockKey = "";
  let lockToken = "";
  let lockAcquired = false;
  let payProRequestStarted = false;
  let activeResultKey = "";
  let activeOfferKey = "";
  let activeOffer = null;

  try {
    let body;

    try {
      body = parseRequestBody(req);
    } catch (error) {
      if (error?.message === "REQUEST_BODY_TOO_LARGE") {
        return res.status(413).json({
          ok: false,
          error: "Request body is too large."
        });
      }

      return res.status(400).json({
        ok: false,
        error: "Request body must contain valid JSON."
      });
    }

    const action = clean(body.action || "charge", 40).toLowerCase();
    const offerKey = clean(body.offer, 80);
    const offer = OFFERS[offerKey];
    const sessionId = clean(body.fs_session_id, 160);
    const checkoutIntentId = clean(
      body.fs_checkout_intent_id,
      160
    );
    const accessToken = getBearerToken(req);

    activeOfferKey = offerKey;
    activeOffer = offer;

    if (!offer) {
      return res.status(400).json({
        ok: false,
        error: "Unknown offer."
      });
    }

    if (!["charge", "status"].includes(action)) {
      return res.status(400).json({
        ok: false,
        error: "Unknown action."
      });
    }

    if (
      !isValidIdentifier(sessionId) ||
      !isValidIdentifier(checkoutIntentId)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Valid funnel session identifiers are required."
      });
    }

    if (
      accessToken.length < 20 ||
      accessToken.length > 512
    ) {
      return sendUnauthorized(res);
    }

    const session = await readJsonFromRedis(
      funnelSessionKey(sessionId)
    );

    if (
      !sessionCredentialsAreValid({
        session,
        sessionId,
        checkoutIntentId,
        accessToken
      })
    ) {
      return sendUnauthorized(res);
    }

    const referencedOrderId = clean(
      session.paypro_root_order_id,
      100
    );

    if (
      session.status !== "paid" ||
      session.checkout_completed !== true ||
      !isValidPayProOrderId(referencedOrderId)
    ) {
      return res.status(403).json({
        ok: false,
        charged: false,
        error: "The original checkout has not been verified."
      });
    }

    activeResultKey = chargeResultKey(sessionId, offerKey);
    const existingResult = await readJsonFromRedis(activeResultKey);
    const existingPublicResult = publicResult(
      existingResult,
      offerKey,
      offer
    );

    if (
      action === "status" ||
      isConfirmedResult(existingResult) ||
      existingResult?.status === "manual_checkout_required" ||
      existingResult?.status === "awaiting_ipn" ||
      existingResult?.status === "charge_requested" ||
      existingResult?.status === "api_result_ambiguous"
    ) {
      return res
        .status(existingPublicResult.httpStatus)
        .json(existingPublicResult.body);
    }

    lockKey = chargeLockKey(sessionId, offerKey);
    lockToken = randomUUID();

    const lockResult = await redisCommand([
      "SET",
      lockKey,
      lockToken,
      "NX",
      "EX",
      String(CHARGE_LOCK_SECONDS)
    ]);

    if (lockResult !== "OK") {
      return res.status(409).json({
        ok: false,
        charged: false,
        processing: true,
        error: "This upgrade is already being processed."
      });
    }

    lockAcquired = true;

    const vendorAccountId = clean(
      process.env.PAYPRO_VENDOR_ACCOUNT_ID,
      40
    );
    const apiSecretKey = clean(
      process.env.PAYPRO_API_SECRET_KEY,
      4000
    );

    if (
      !vendorAccountId ||
      !apiSecretKey ||
      !/^\d+$/.test(vendorAccountId)
    ) {
      throw new Error("Missing or invalid PayPro API credentials");
    }

    const numericVendorAccountId = Number(vendorAccountId);

    if (
      !Number.isSafeInteger(numericVendorAccountId) ||
      numericVendorAccountId <= 0
    ) {
      throw new Error("Invalid PayPro vendor account ID");
    }

    const payload = {
      vendorAccountId: numericVendorAccountId,
      apiSecretKey,
      referencedOrderId: Number(referencedOrderId),
      productId: offer.productId,
      priceCurrencyCode: offer.currency,
      priceValue: offer.amount,
      referenceChargeName: offer.name,
      customFields: {
        processor: "paypro",
        funnel_id: "accelstretch_paypro_flow",
        offer_step: offer.offerStep,
        fs_session_id: sessionId,
        fs_checkout_intent_id: checkoutIntentId,
        root_order_id: referencedOrderId,
        source_product: "accelstretch"
      }
    };

    await writeJsonToRedis(
      activeResultKey,
      {
        status: "charge_requested",
        charged: false,
        confirmedByIpn: false,
        offer: offerKey,
        referencedOrderId,
        fs_session_id: sessionId,
        fs_checkout_intent_id: checkoutIntentId,
        productId: offer.productId,
        amount: offer.amount,
        currency: offer.currency,
        createdAt: new Date().toISOString()
      },
      RECORD_TTL_SECONDS
    );

    payProRequestStarted = true;

    const response = await fetch(PAYPRO_REFERENCE_CHARGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    let responseData = {};

    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { raw: clean(responseText, 1000) };
    }

    const apiProcessed = response.ok && isProcessedCharge(responseData);
    const explicitFailure = isExplicitChargeFailure(responseData);
    console.log("PAYPRO SECURE REFERENCE CHARGE", {
      offer: offerKey,
      product_id: offer.productId,
      amount: offer.amount,
      api_processed: apiProcessed,
      explicit_failure: explicitFailure,
      manual_checkout_recommended: explicitFailure,
      http_status: response.status,
      has_secure_session: true
    });

    if (apiProcessed) {
      const chargeOrderId = getPayProOrderId(responseData);

      const confirmedResult = parseStoredRecord(
        await redisCommand([
          "EVAL",
          WRITE_STATUS_IF_UNCONFIRMED_SCRIPT,
          "1",
          activeResultKey,
          JSON.stringify({
            status: "awaiting_ipn",
            charged: false,
            confirmedByIpn: false,
            apiAccepted: true,
            offer: offerKey,
            orderId: chargeOrderId,
            referencedOrderId,
            fs_session_id: sessionId,
            fs_checkout_intent_id: checkoutIntentId,
            productId: offer.productId,
            amount: offer.amount,
            currency: offer.currency,
            createdAt: new Date().toISOString()
          }),
          String(RECORD_TTL_SECONDS)
        ])
      );

      await releaseChargeLock(lockKey, lockToken);
      lockAcquired = false;

      const result = publicResult(
        confirmedResult,
        offerKey,
        offer
      );

      return res.status(result.httpStatus).json(result.body);
    }

    if (explicitFailure) {
      const fallbackResult = await createManualCheckout({
        sessionId,
        checkoutIntentId,
        referencedOrderId,
        offerKey,
        offer
      });

      await releaseChargeLock(lockKey, lockToken);
      lockAcquired = false;

      if (fallbackResult.alreadyConfirmed === true) {
        const confirmed = publicResult(
          fallbackResult,
          offerKey,
          offer
        );

        return res
          .status(confirmed.httpStatus)
          .json(confirmed.body);
      }

      return res.status(200).json({
        ok: true,
        charged: false,
        confirmed: false,
        processing: false,
        fallback: true,
        offer: offerKey,
        product_id: offer.productId,
        amount: offer.amount,
        currency: offer.currency,
        fallback_token: fallbackResult.fallbackToken
      });
    }

    const ambiguousResult = parseStoredRecord(
      await redisCommand([
        "EVAL",
        WRITE_STATUS_IF_UNCONFIRMED_SCRIPT,
        "1",
        activeResultKey,
        JSON.stringify({
          status: "api_result_ambiguous",
          charged: false,
          confirmedByIpn: false,
          offer: offerKey,
          referencedOrderId,
          fs_session_id: sessionId,
          fs_checkout_intent_id: checkoutIntentId,
          productId: offer.productId,
          amount: offer.amount,
          currency: offer.currency,
          createdAt: new Date().toISOString()
        }),
        String(RECORD_TTL_SECONDS)
      ])
    );

    await releaseChargeLock(lockKey, lockToken);
    lockAcquired = false;

    const result = publicResult(
      ambiguousResult,
      offerKey,
      offer
    );

    return res.status(result.httpStatus).json(result.body);
  } catch (error) {
    if (
      payProRequestStarted &&
      activeResultKey &&
      activeOffer
    ) {
      try {
        await redisCommand([
          "EVAL",
          WRITE_STATUS_IF_UNCONFIRMED_SCRIPT,
          "1",
          activeResultKey,
          JSON.stringify({
            status: "api_result_ambiguous",
            charged: false,
            confirmedByIpn: false,
            offer: activeOfferKey,
            productId: activeOffer.productId,
            amount: activeOffer.amount,
            currency: activeOffer.currency,
            createdAt: new Date().toISOString()
          }),
          String(RECORD_TTL_SECONDS)
        ]);
      } catch {}
    }

    if (
      lockAcquired &&
      lockKey &&
      lockToken &&
      !payProRequestStarted
    ) {
      try {
        await releaseChargeLock(lockKey, lockToken);
      } catch {}
    }

    console.error(
      "PAYPRO REFERENCE CHARGE ERROR",
      error instanceof Error ? error.message : "Unknown error"
    );

    if (payProRequestStarted && activeOffer) {
      return res.status(202).json({
        ok: true,
        charged: false,
        confirmed: false,
        processing: true,
        confirmation_pending: true,
        offer: activeOfferKey,
        product_id: activeOffer.productId,
        amount: activeOffer.amount,
        currency: activeOffer.currency
      });
    }

    return res.status(500).json({
      ok: false,
      charged: false,
      error: "Unable to process this upgrade right now."
    });
  }
}
