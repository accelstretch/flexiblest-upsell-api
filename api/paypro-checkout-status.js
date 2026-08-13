import {
  createHash,
  timingSafeEqual
} from "node:crypto";

const COMPLETE_UPGRADE_URL =
  "https://flexiblest.com/complete-upgrade";

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
    "GET, OPTIONS"
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

  // Allows direct server-side monitoring and testing.
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

function getSingleQueryValue(value) {
  if (Array.isArray(value)) {
    return "";
  }

  return clean(value);
}

function isValidIdentifier(value) {
  return (
    value.length >= 16 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
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

async function readJsonFromRedis(key) {
  const stored = await redisCommand([
    "GET",
    key
  ]);

  if (stored === null || stored === undefined) {
    return null;
  }

  if (
    typeof stored === "object" &&
    !Array.isArray(stored)
  ) {
    return stored;
  }

  if (typeof stored !== "string") {
    throw new Error(
      "Stored funnel session has an invalid format"
    );
  }

  try {
    const parsed = JSON.parse(stored);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        "Stored funnel session is not an object"
      );
    }

    return parsed;
  } catch {
    throw new Error(
      "Stored funnel session contains invalid JSON"
    );
  }
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

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");

    return res.status(405).json({
      ok: false,
      error: "Method not allowed."
    });
  }

  try {
    const sessionId = getSingleQueryValue(
      req.query?.fs_session_id
    );

    const checkoutIntentId =
      getSingleQueryValue(
        req.query?.fs_checkout_intent_id
      );

    const accessToken = getBearerToken(req);

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

    const ready =
      session.status === "paid" &&
      session.checkout_completed === true &&
      Boolean(
        clean(session.paypro_root_order_id)
      );

    if (!ready) {
      return res.status(200).json({
        ok: true,
        ready: false
      });
    }

    return res.status(200).json({
      ok: true,
      ready: true,
      redirect_url: COMPLETE_UPGRADE_URL
    });
  } catch (error) {
    console.error(
      "PAYPRO CHECKOUT STATUS ERROR:",
      error instanceof Error
        ? error.message
        : "Unknown error"
    );

    return res.status(500).json({
      ok: false,
      error:
        "Checkout status is temporarily unavailable."
    });
  }
}
