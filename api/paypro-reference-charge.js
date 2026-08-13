import {
  createHash,
  randomUUID,
  timingSafeEqual
} from "node:crypto";

const PAYPRO_URL =
  "https://store.payproglobal.com/api/Orders/DoReferenceCharge";

const RECORD_TTL_SECONDS = 72 * 60 * 60;
const CHARGE_LOCK_SECONDS = 120;
const MAX_REQUEST_BODY_BYTES = 8 * 1024;

const OFFERS = {
  fasttrack57: {
    productId: 133573,
    amount: 57,
    currency: "USD",
    name: "Advanced Fast Track",
    offerStep: "upsell_fasttrack57",
    nextUrl:
      "https://flexiblest.com/order-complete"
  },

  fasttrack37: {
    productId: 133574,
    amount: 37,
    currency: "USD",
    name:
      "Flexibility And Recovery Fast Track Core - Final Offer",
    offerStep: "downsell_fasttrack37",
    nextUrl:
      "https://flexiblest.com/order-complete"
  }
};

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end

return 0
`;

function clean(value) {
  return String(value || "").trim();
}

function funnelSessionKey(sessionId) {
  return `paypro:funnel:session:${sessionId}`;
}

function hashAccessToken(token) {
  return createHash("sha256")
    .update(String(token || ""), "utf8")
    .digest("hex");
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

function getBearerToken(req) {
  const authorization = String(
    req.headers.authorization || ""
  );

  const match = authorization.match(
    /^Bearer\s+(.+)$/i
  );

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
  const requestOrigin = clean(
    req.headers.origin
  );

  const normalizedOrigin =
    normalizeOrigin(requestOrigin);

  if (
    normalizedOrigin &&
    ALLOWED_ORIGINS.has(normalizedOrigin)
  ) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      normalizedOrigin
    );
  }

  res.setHeader("Vary", "Origin");

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

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
  const requestOrigin = clean(
    req.headers.origin
  );

  if (!requestOrigin) {
    return true;
  }

  const normalizedOrigin =
    normalizeOrigin(requestOrigin);

  return (
    Boolean(normalizedOrigin) &&
    ALLOWED_ORIGINS.has(normalizedOrigin)
  );
}

function isValidIdentifier(value) {
  return (
    value.length >= 16 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function parseRequestBody(req) {
  let body = req.body;

  if (
    body === undefined ||
    body === null ||
    body === ""
  ) {
    return {};
  }

  if (Buffer.isBuffer(body)) {
    if (
      body.length > MAX_REQUEST_BODY_BYTES
    ) {
      throw new Error(
        "REQUEST_BODY_TOO_LARGE"
      );
    }

    body = body.toString("utf8");
  }

  if (typeof body === "string") {
    if (
      Buffer.byteLength(body, "utf8") >
      MAX_REQUEST_BODY_BYTES
    ) {
      throw new Error(
        "REQUEST_BODY_TOO_LARGE"
      );
    }

    try {
      body = JSON.parse(body);
    } catch {
      throw new Error(
        "INVALID_JSON_BODY"
      );
    }
  }

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    throw new Error(
      "INVALID_JSON_BODY"
    );
  }

  const serialized = JSON.stringify(body);

  if (
    Buffer.byteLength(serialized, "utf8") >
    MAX_REQUEST_BODY_BYTES
  ) {
    throw new Error(
      "REQUEST_BODY_TOO_LARGE"
    );
  }

  return body;
}

async function redisCommand(command) {
  const url = clean(
    process.env.KV_REST_API_URL
  ).replace(/\/+$/, "");

  const token = clean(
    process.env.KV_REST_API_TOKEN
  );

  if (!url || !token) {
    throw new Error(
      "Missing KV_REST_API_URL or KV_REST_API_TOKEN"
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(
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

    const data = await response
      .json()
      .catch(() => ({}));

    if (!response.ok || data.error) {
      throw new Error(
        `Redis command failed: ${
          data.error || response.status
        }`
      );
    }

    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}

function parseStoredRecord(value) {
  if (value === null || value === undefined) {
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
  const stored = await redisCommand([
    "GET",
    key
  ]);

  if (stored === null || stored === undefined) {
    return null;
  }

  const parsed = parseStoredRecord(stored);

  if (!parsed) {
    throw new Error(
      "Stored Redis record contains invalid JSON"
    );
  }

  return parsed;
}

function sessionCredentialsAreValid({
  session,
  sessionId,
  checkoutIntentId,
  accessToken
}) {
  if (
    !session ||
    !safeEqual(
      session.fs_session_id,
      sessionId
    ) ||
    !safeEqual(
      session.fs_checkout_intent_id,
      checkoutIntentId
    )
  ) {
    return false;
  }

  const storedHash = clean(
    session.access_token_hash
  );

  if (!/^[a-f0-9]{64}$/i.test(storedHash)) {
    return false;
  }

  const suppliedHash =
    hashAccessToken(accessToken);

  return safeEqual(
    storedHash.toLowerCase(),
    suppliedHash.toLowerCase()
  );
}

function isValidPayProOrderId(value) {
  const orderId = clean(value);

  if (!/^\d+$/.test(orderId)) {
    return false;
  }

  const numericOrderId = Number(orderId);

  return (
    Number.isSafeInteger(numericOrderId) &&
    numericOrderId > 0
  );
}

function isProcessedCharge(data) {
  const success =
    data?.isSuccess === true ||
    data?.IsSuccess === true;

  const status = clean(
    data?.response?.orderStatusName ||
      data?.Response?.OrderStatusName
  ).toLowerCase();

  return success && status === "processed";
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

async function releaseChargeLock(
  lockKey,
  lockToken
) {
  if (!lockKey || !lockToken) {
    return;
  }

  await redisCommand([
    "EVAL",
    RELEASE_LOCK_SCRIPT,
    1,
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

  try {
    let body;

    try {
      body = parseRequestBody(req);
    } catch (error) {
      if (
        error?.message ===
        "REQUEST_BODY_TOO_LARGE"
      ) {
        return res.status(413).json({
          ok: false,
          error: "Request body is too large."
        });
      }

      return res.status(400).json({
        ok: false,
        error:
          "Request body must contain valid JSON."
      });
    }

    const offerKey = clean(body.offer);
    const offer = OFFERS[offerKey];

    const sessionId = clean(
      body.fs_session_id
    );

    const checkoutIntentId = clean(
      body.fs_checkout_intent_id
    );

    const accessToken = getBearerToken(req);

    if (!offer) {
      return res.status(400).json({
        ok: false,
        error: "Unknown offer."
      });
    }

    if (
      !isValidIdentifier(sessionId) ||
      !isValidIdentifier(checkoutIntentId)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Valid funnel session identifiers are required."
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
      session.paypro_root_order_id
    );

    if (
      session.status !== "paid" ||
      session.checkout_completed !== true ||
      !isValidPayProOrderId(
        referencedOrderId
      )
    ) {
      return res.status(403).json({
        ok: false,
        charged: false,
        error:
          "The original checkout has not been verified."
      });
    }

    const resultKey =
      `paypro:charge-result:${sessionId}:${offerKey}`;

    const existingResult =
      parseStoredRecord(
        await redisCommand([
          "GET",
          resultKey
        ])
      );

    if (existingResult?.charged === true) {
      return res.status(200).json({
        ok: true,
        charged: true,
        already_charged: true,
        offer: offerKey,
        product_id: offer.productId,
        amount: offer.amount,
        currency: offer.currency,
        next_url: offer.nextUrl
      });
    }

    lockKey =
      `paypro:charge-lock:${sessionId}:${offerKey}`;

    lockToken = randomUUID();

    const lockResult = await redisCommand([
      "SET",
      lockKey,
      lockToken,
      "NX",
      "EX",
      CHARGE_LOCK_SECONDS
    ]);

    if (lockResult !== "OK") {
      return res.status(409).json({
        ok: false,
        charged: false,
        error:
          "This upgrade is already being processed."
      });
    }

    lockAcquired = true;

    const vendorAccountId = clean(
      process.env.PAYPRO_VENDOR_ACCOUNT_ID
    );

    const apiSecretKey = clean(
      process.env.PAYPRO_API_SECRET_KEY
    );

    if (
      !vendorAccountId ||
      !apiSecretKey ||
      !/^\d+$/.test(vendorAccountId)
    ) {
      throw new Error(
        "Missing or invalid PayPro API credentials"
      );
    }

    const numericVendorAccountId = Number(
      vendorAccountId
    );

    if (
      !Number.isSafeInteger(
        numericVendorAccountId
      ) ||
      numericVendorAccountId <= 0
    ) {
      throw new Error(
        "Invalid PayPro vendor account ID"
      );
    }

    const payload = {
      vendorAccountId:
        numericVendorAccountId,

      apiSecretKey,

      referencedOrderId:
        Number(referencedOrderId),

      productId: offer.productId,
      priceCurrencyCode: offer.currency,
      priceValue: offer.amount,
      referenceChargeName: offer.name,

      customFields: {
        processor: "paypro",
        funnel_id:
          "accelstretch_paypro_flow",
        offer_step: offer.offerStep,
        fs_session_id: sessionId,
        fs_checkout_intent_id:
          checkoutIntentId,
        root_order_id: referencedOrderId,
        source_product: "accelstretch"
      }
    };

    payProRequestStarted = true;

    const response = await fetch(
      PAYPRO_URL,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const responseText =
      await response.text();

    let responseData = {};

    try {
      responseData =
        JSON.parse(responseText);
    } catch {
      responseData = {
        raw: responseText
      };
    }

    const charged =
      response.ok &&
      isProcessedCharge(responseData);

    console.log(
      "PAYPRO SECURE REFERENCE CHARGE:",
      {
        offer: offerKey,
        product_id: offer.productId,
        amount: offer.amount,
        charged,
        http_status: response.status,
        has_secure_session: true
      }
    );

    if (!charged) {
      await releaseChargeLock(
        lockKey,
        lockToken
      );

      lockAcquired = false;

      return res.status(200).json({
        ok: true,
        charged: false,
        fallback: true,
        offer: offerKey,
        product_id: offer.productId,
        amount: offer.amount,
        currency: offer.currency,
        next_url: offer.nextUrl
      });
    }

    const chargeOrderId = clean(
      responseData?.response?.orderId ||
        responseData?.Response?.OrderId
    );

    await redisCommand([
      "SET",
      resultKey,
      JSON.stringify({
        charged: true,
        offer: offerKey,
        orderId: chargeOrderId,
        referencedOrderId,
        fs_session_id: sessionId,
        fs_checkout_intent_id:
          checkoutIntentId,
        productId: offer.productId,
        amount: offer.amount,
        currency: offer.currency,
        createdAt: new Date().toISOString()
      }),
      "EX",
      RECORD_TTL_SECONDS
    ]);

    await releaseChargeLock(
      lockKey,
      lockToken
    );

    lockAcquired = false;

    return res.status(200).json({
      ok: true,
      charged: true,
      fallback: false,
      offer: offerKey,
      product_id: offer.productId,
      amount: offer.amount,
      currency: offer.currency,
      next_url: offer.nextUrl
    });
  } catch (error) {
    /*
     * If the PayPro request has already started, keep the
     * short Redis lock until it expires. This reduces the
     * chance of an immediate duplicate charge when the
     * PayPro response was interrupted or ambiguous.
     */
    if (
      lockAcquired &&
      lockKey &&
      lockToken &&
      !payProRequestStarted
    ) {
      try {
        await releaseChargeLock(
          lockKey,
          lockToken
        );
      } catch {}
    }

    console.error(
      "PAYPRO REFERENCE CHARGE ERROR:",
      error instanceof Error
        ? error.message
        : "Unknown error"
    );

    return res.status(500).json({
      ok: false,
      charged: false,
      error:
        "Unable to process this upgrade right now."
    });
  }
}
