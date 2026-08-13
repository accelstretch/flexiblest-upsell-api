import {
  createHash,
  timingSafeEqual
} from "node:crypto";

const PAYPRO_CHECKOUT_URL =
  "https://store.payproglobal.com/checkout";

const MAX_REQUEST_BODY_BYTES = 8 * 1024;

const OFFERS = {
  fasttrack57: {
    productId: 133573,
    amount: 57,
    currency: "USD",
    offerStep: "upsell_fasttrack57"
  },

  fasttrack37: {
    productId: 133574,
    amount: 37,
    currency: "USD",
    offerStep: "downsell_fasttrack37"
  }
};

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

function manualCheckoutKey(token) {
  return `paypro:manual-checkout:${token}`;
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

  return new Set([
    "https://flexiblest.com",
    "https://www.flexiblest.com",
    ...configured
      .split(",")
      .map(normalizeOrigin)
      .filter(Boolean)
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
  const parsed = parseStoredRecord(
    await redisCommand(["GET", key])
  );

  return parsed;
}

function validIdentifier(value) {
  const identifier = clean(value, 160);

  return (
    identifier.length >= 16 &&
    identifier.length <= 160 &&
    /^[A-Za-z0-9_-]+$/.test(identifier)
  );
}

function validFallbackToken(value) {
  const token = clean(value, 160);

  return (
    token.length >= 32 &&
    token.length <= 160 &&
    /^[A-Za-z0-9_-]+$/.test(token)
  );
}

function validSessionCredentials({
  session,
  sessionId,
  checkoutIntentId,
  accessToken
}) {
  const storedHash = clean(session?.access_token_hash, 128);

  return Boolean(
    session &&
    safeEqual(session.fs_session_id, sessionId) &&
    safeEqual(
      session.fs_checkout_intent_id,
      checkoutIntentId
    ) &&
    /^[a-f0-9]{64}$/i.test(storedHash) &&
    safeEqual(
      storedHash.toLowerCase(),
      hashAccessToken(accessToken).toLowerCase()
    )
  );
}

function getCheckoutPageTemplateId() {
  const configured = clean(
    process.env.PAYPRO_CHECKOUT_PAGE_TEMPLATE_ID || "21621",
    20
  );

  return /^\d+$/.test(configured) ? configured : "21621";
}

function buildCheckoutUrl(offer, fallbackToken) {
  const url = new URL(PAYPRO_CHECKOUT_URL);

  url.searchParams.set(
    "products[1][id]",
    String(offer.productId)
  );
  url.searchParams.set(
    "page-template",
    getCheckoutPageTemplateId()
  );
  url.searchParams.set("currency", offer.currency);
  url.searchParams.set("language", "EN");
  url.searchParams.set("all-payment-methods", "true");
  url.searchParams.set("parent-domain", "flexiblest.com");
  url.searchParams.set("x-fallback_token", fallbackToken);
  url.searchParams.set(
    "x-offer_step",
    `manual_${offer.offerStep}`
  );
  url.searchParams.set("x-source_product", "accelstretch");

  return url.toString();
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

  try {
    const body = parseRequestBody(req);
    const fallbackToken = clean(body.fallback_token, 160);
    const sessionId = clean(body.fs_session_id, 160);
    const checkoutIntentId = clean(
      body.fs_checkout_intent_id,
      160
    );
    const accessToken = getBearerToken(req);

    if (
      !validFallbackToken(fallbackToken) ||
      !validIdentifier(sessionId) ||
      !validIdentifier(checkoutIntentId)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Valid fallback credentials are required."
      });
    }

    if (
      accessToken.length < 20 ||
      accessToken.length > 512
    ) {
      return sendUnauthorized(res);
    }

    const [session, fallbackRecord] = await Promise.all([
      readJsonFromRedis(funnelSessionKey(sessionId)),
      readJsonFromRedis(manualCheckoutKey(fallbackToken))
    ]);

    if (
      !validSessionCredentials({
        session,
        sessionId,
        checkoutIntentId,
        accessToken
      })
    ) {
      return sendUnauthorized(res);
    }

    if (
      !fallbackRecord ||
      !safeEqual(fallbackRecord.fs_session_id, sessionId) ||
      !safeEqual(
        fallbackRecord.fs_checkout_intent_id,
        checkoutIntentId
      ) ||
      session.status !== "paid" ||
      session.checkout_completed !== true ||
      !safeEqual(
        fallbackRecord.referencedOrderId,
        session.paypro_root_order_id
      )
    ) {
      return res.status(403).json({
        ok: false,
        error: "The fallback checkout is invalid or expired."
      });
    }

    const offer = OFFERS[fallbackRecord.offer];

    if (
      !offer ||
      Number(fallbackRecord.productId) !== offer.productId
    ) {
      return res.status(403).json({
        ok: false,
        error: "The fallback checkout product is invalid."
      });
    }

    const chargeResult = await readJsonFromRedis(
      chargeResultKey(sessionId, fallbackRecord.offer)
    );

    if (
      chargeResult?.charged === true &&
      (
        chargeResult.confirmedByIpn === true ||
        chargeResult.status === "confirmed" ||
        !chargeResult.status
      )
    ) {
      return res.status(200).json({
        ok: true,
        charged: true,
        confirmed: true,
        offer: fallbackRecord.offer,
        product_id: offer.productId,
        amount: Number(chargeResult.amount) || offer.amount,
        currency: clean(chargeResult.currency, 20) || offer.currency
      });
    }

    if (fallbackRecord.status !== "ready") {
      return res.status(409).json({
        ok: false,
        charged: false,
        error: "The fallback checkout is no longer available."
      });
    }

    return res.status(200).json({
      ok: true,
      charged: false,
      confirmed: false,
      offer: fallbackRecord.offer,
      product_id: offer.productId,
      amount: offer.amount,
      currency: offer.currency,
      checkout_url: buildCheckoutUrl(offer, fallbackToken)
    });
  } catch (error) {
    console.error(
      "PAYPRO MANUAL CHECKOUT ERROR",
      error instanceof Error ? error.message : "Unknown error"
    );

    return res.status(500).json({
      ok: false,
      error: "Unable to load the fallback checkout."
    });
  }
}
