import crypto from "crypto";

const SESSION_TTL_SECONDS = 72 * 60 * 60;
const MAX_REQUEST_BODY_BYTES = 32 * 1024;

const FUNNEL_ID = "accelstretch_paypro_flow";
const SOURCE_PRODUCT = "accelstretch";
const INITIAL_OFFER_STEP = "checkout_main";

class ClientError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "ClientError";
    this.statusCode = statusCode;
  }
}

function clean(value, maxLength = 500) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
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

function normalizeName(value) {
  return clean(value, 100);
}

function validIdentifier(value) {
  return /^[A-Za-z0-9_-]{20,160}$/.test(clean(value, 160));
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function makeOpaqueId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function makeAccessToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashAccessToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""), "utf8")
    .digest("hex");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

function funnelSessionKey(sessionId) {
  return `paypro:funnel:session:${sessionId}`;
}

function getRedisConfiguration() {
  const url = clean(process.env.KV_REST_API_URL, 2000).replace(/\/+$/, "");
  const token = clean(process.env.KV_REST_API_TOKEN, 4000);

  if (!url || !token) {
    throw new Error("Redis environment variables are not configured.");
  }

  return { url, token };
}

async function redisCommand(command) {
  const { url, token } = getRedisConfiguration();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

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

    const payload = await response.json().catch(() => null);

    if (
      !response.ok ||
      !payload ||
      Object.prototype.hasOwnProperty.call(payload, "error")
    ) {
      const redisMessage =
        payload && payload.error
          ? clean(payload.error, 500)
          : `Redis returned HTTP ${response.status}.`;

      throw new Error(redisMessage);
    }

    return payload.result;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJsonFromRedis(key) {
  const result = await redisCommand(["GET", key]);

  if (result === null || result === undefined || result === "") {
    return null;
  }

  if (isPlainObject(result)) {
    return result;
  }

  try {
    const parsed = JSON.parse(String(result));
    return isPlainObject(parsed) ? parsed : null;
  } catch (error) {
    throw new Error("The stored funnel session is not valid JSON.");
  }
}

async function writeNewJsonToRedis(key, value, ttlSeconds) {
  const result = await redisCommand([
    "SET",
    key,
    JSON.stringify(value),
    "EX",
    String(ttlSeconds),
    "NX"
  ]);

  return result === "OK";
}

function getAllowedOrigins() {
  const origins = new Set([
    "https://flexiblest.com",
    "https://www.flexiblest.com"
  ]);

  const configuredValues = [
    process.env.APP_BASE_URL,
    process.env.ALLOWED_ORIGINS,
    process.env.WEBFLOW_ALLOWED_ORIGINS
  ]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map((value) => clean(value, 2000))
    .filter(Boolean);

  configuredValues.forEach((value) => {
    try {
      const url = new URL(value);

      if (url.protocol === "https:" || url.protocol === "http:") {
        origins.add(url.origin);
      }
    } catch (error) {}
  });

  return origins;
}

function setCors(req, res) {
  const origin = clean(req.headers.origin, 2000);
  const allowedOrigins = getAllowedOrigins();
  const originAllowed = !origin || allowedOrigins.has(origin);

  if (origin && originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");

  return originAllowed;
}

function sendJson(res, statusCode, body) {
  res.status(statusCode).json(body);
}

function parseRequestBody(req) {
  if (req.body === undefined || req.body === null || req.body === "") {
    return {};
  }

  let body = req.body;

  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw new ClientError(413, "Request body is too large.");
    }

    try {
      body = JSON.parse(body);
    } catch (error) {
      throw new ClientError(400, "Request body must be valid JSON.");
    }
  } else {
    let serialized;

    try {
      serialized = JSON.stringify(body);
    } catch (error) {
      throw new ClientError(400, "Request body must be valid JSON.");
    }

    if (
      Buffer.byteLength(serialized || "", "utf8") >
      MAX_REQUEST_BODY_BYTES
    ) {
      throw new ClientError(413, "Request body is too large.");
    }
  }

  if (!isPlainObject(body)) {
    throw new ClientError(400, "Request body must be a JSON object.");
  }

  return body;
}

function getRequestIp(req) {
  const forwarded =
    req.headers["x-vercel-forwarded-for"] ||
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    "";

  return clean(String(forwarded).split(",")[0], 100);
}

function cleanPageUrl(value) {
  const input = clean(value, 4000);

  if (!input) {
    return "";
  }

  try {
    const url = new URL(input);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "";
    }

    /*
     * Deliberately exclude the query string and fragment.
     * Click IDs and UTM values are stored separately below.
     * This prevents email, name, or other personal query parameters
     * from being retained as event-source URLs.
     */
    return `${url.origin}${url.pathname}`;
  } catch (error) {
    return "";
  }
}

function sanitizeAttribution(body) {
  const nested = isPlainObject(body.attribution)
    ? body.attribution
    : isPlainObject(body.attribution_data)
      ? body.attribution_data
      : {};

  function valueFor(...keys) {
    for (const key of keys) {
      if (nested[key] !== undefined && nested[key] !== null) {
        return nested[key];
      }

      if (body[key] !== undefined && body[key] !== null) {
        return body[key];
      }
    }

    return "";
  }

  const fields = {
    comet_token: clean(
      valueFor("comet_token", "cometly_token"),
      1000
    ),
    comet_fingerprint: clean(
      valueFor("comet_fingerprint", "cometly_fingerprint"),
      1000
    ),
    cometly_click_id: clean(
      valueFor("cometly_click_id", "cometly_id"),
      500
    ),

    fbclid: clean(valueFor("fbclid"), 1000),
    fbc: clean(valueFor("fbc", "_fbc"), 1000),
    fbp: clean(valueFor("fbp", "_fbp"), 1000),

    gclid: clean(valueFor("gclid"), 1000),
    gbraid: clean(valueFor("gbraid"), 1000),
    wbraid: clean(valueFor("wbraid"), 1000),
    ttclid: clean(valueFor("ttclid"), 1000),

    utm_source: clean(valueFor("utm_source"), 300),
    utm_medium: clean(valueFor("utm_medium"), 300),
    utm_campaign: clean(valueFor("utm_campaign"), 500),
    utm_content: clean(valueFor("utm_content"), 500),
    utm_term: clean(valueFor("utm_term"), 500),

    campaign_id: clean(
      valueFor("campaign_id", "utm_campaign_id"),
      300
    ),
    adset_id: clean(valueFor("adset_id"), 300),
    ad_id: clean(valueFor("ad_id"), 300),
    placement: clean(valueFor("placement"), 300),
    site_source_name: clean(valueFor("site_source_name"), 100),

    landing_page_url: cleanPageUrl(
      valueFor("landing_page_url")
    ),
    latest_page_url: cleanPageUrl(
      valueFor("latest_page_url", "page_url")
    ),
    referrer_url: cleanPageUrl(
      valueFor("referrer_url", "referrer")
    )
  };

  const result = {};

  Object.entries(fields).forEach(([key, value]) => {
    if (value) {
      result[key] = value;
    }
  });

  return result;
}

function getRequestContext(req, body) {
  return {
    ip_address: getRequestIp(req),
    user_agent: clean(req.headers["user-agent"], 1500),
    accept_language: clean(req.headers["accept-language"], 500),
    page_url: cleanPageUrl(
      body.page_url || body.checkout_page_url
    ),
    referrer_url: cleanPageUrl(
      body.referrer_url || body.referrer
    )
  };
}

async function createFunnelSession(req, body) {
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + SESSION_TTL_SECONDS * 1000
  ).toISOString();

  const attribution = sanitizeAttribution(body);
  const requestContext = getRequestContext(req, body);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sessionId = makeOpaqueId("fsess");
    const checkoutIntentId = makeOpaqueId("fchk");
    const accessToken = makeAccessToken();
    const accessTokenHash = hashAccessToken(accessToken);

    const session = {
      schema_version: 1,
      session_type: "paypro_funnel",

      fs_session_id: sessionId,
      fs_checkout_intent_id: checkoutIntentId,
      access_token_hash: accessTokenHash,

      funnel_id: FUNNEL_ID,
      source_product: SOURCE_PRODUCT,
      offer_step: INITIAL_OFFER_STEP,

      status: "created",
      checkout_started: true,
      checkout_completed: false,

      /*
       * These remain empty until a valid parent-page form is added,
       * or until PayPro sends the final identity in its validated IPN.
       */
      checkout_email: null,
      checkout_first_name: null,
      checkout_last_name: null,
      precheckout_identity_captured: false,

      paypro_root_order_id: null,
      product_id: null,
      customer_email: null,
      customer_first_name: null,
      customer_last_name: null,
      currency: null,
      amount: null,

      attribution,
      request_context: requestContext,

      created_at: createdAt,
      updated_at: createdAt,
      expires_at: expiresAt
    };

    const key = funnelSessionKey(sessionId);
    const created = await writeNewJsonToRedis(
      key,
      session,
      SESSION_TTL_SECONDS
    );

    if (created) {
      return {
        fs_session_id: sessionId,
        fs_checkout_intent_id: checkoutIntentId,
        fs_funnel_access_token: accessToken,
        expires_in: SESSION_TTL_SECONDS,
        expires_at: expiresAt
      };
    }
  }

  throw new Error("Unable to create a unique funnel session.");
}

const SAVE_CHECKOUT_IDENTITY_SCRIPT = `
local raw = redis.call("GET", KEYS[1])

if not raw then
  return "MISSING"
end

local ok, session = pcall(cjson.decode, raw)

if not ok or type(session) ~= "table" then
  return "INVALID"
end

if tostring(session["fs_checkout_intent_id"] or "") ~= ARGV[1] then
  return "INTENT_MISMATCH"
end

if tostring(session["access_token_hash"] or "") ~= ARGV[2] then
  return "TOKEN_MISMATCH"
end

if session["checkout_completed"] == true or session["status"] == "paid" then
  return "COMPLETED"
end

session["checkout_email"] = ARGV[3]
session["precheckout_identity_captured"] = true
session["precheckout_identity_captured_at"] = ARGV[7]

if ARGV[4] ~= "" then
  session["checkout_first_name"] = ARGV[4]
end

if ARGV[5] ~= "" then
  session["checkout_last_name"] = ARGV[5]
end

if ARGV[6] ~= "" and ARGV[6] ~= "{}" then
  local attributionOk, incomingAttribution =
    pcall(cjson.decode, ARGV[6])

  if attributionOk and type(incomingAttribution) == "table" then
    if type(session["attribution"]) ~= "table" then
      session["attribution"] = {}
    end

    for key, value in pairs(incomingAttribution) do
      if value ~= nil and tostring(value) ~= "" then
        session["attribution"][key] = value
      end
    end
  end
end

session["updated_at"] = ARGV[7]
session["expires_at"] = ARGV[8]

redis.call(
  "SET",
  KEYS[1],
  cjson.encode(session),
  "EX",
  ARGV[9]
)

return "OK"
`;

async function saveCheckoutEmail(req, body) {
  const sessionId = clean(body.fs_session_id, 160);
  const checkoutIntentId = clean(
    body.fs_checkout_intent_id,
    160
  );
  const accessToken = getBearerToken(req);
  const email = normalizeEmail(
    body.email || body.checkout_email
  );
  const firstName = normalizeName(
    body.first_name || body.checkout_first_name
  );
  const lastName = normalizeName(
    body.last_name || body.checkout_last_name
  );

  if (
    !validIdentifier(sessionId) ||
    !validIdentifier(checkoutIntentId) ||
    !accessToken ||
    accessToken.length > 500
  ) {
    throw new ClientError(
      401,
      "Invalid funnel session credentials."
    );
  }

  if (!validEmail(email)) {
    throw new ClientError(
      400,
      "A valid checkout email address is required."
    );
  }

  const key = funnelSessionKey(sessionId);
  const session = await readJsonFromRedis(key);

  if (
    !session ||
    session.fs_checkout_intent_id !== checkoutIntentId
  ) {
    throw new ClientError(
      401,
      "Invalid funnel session credentials."
    );
  }

  const providedHash = hashAccessToken(accessToken);
  const storedHash = clean(session.access_token_hash, 128);

  if (!storedHash || !safeEqual(providedHash, storedHash)) {
    throw new ClientError(
      401,
      "Invalid funnel session credentials."
    );
  }

  if (
    session.checkout_completed === true ||
    session.status === "paid"
  ) {
    throw new ClientError(
      409,
      "This checkout session has already been completed."
    );
  }

  const attribution = sanitizeAttribution(body);
  const now = new Date();
  const updatedAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + SESSION_TTL_SECONDS * 1000
  ).toISOString();

  const result = await redisCommand([
    "EVAL",
    SAVE_CHECKOUT_IDENTITY_SCRIPT,
    "1",
    key,
    checkoutIntentId,
    providedHash,
    email,
    firstName,
    lastName,
    JSON.stringify(attribution),
    updatedAt,
    expiresAt,
    String(SESSION_TTL_SECONDS)
  ]);

  if (result === "COMPLETED") {
    throw new ClientError(
      409,
      "This checkout session has already been completed."
    );
  }

  if (
    result === "MISSING" ||
    result === "INTENT_MISMATCH" ||
    result === "TOKEN_MISMATCH"
  ) {
    throw new ClientError(
      401,
      "Invalid funnel session credentials."
    );
  }

  if (result !== "OK") {
    throw new Error(
      "Unable to update the secure funnel session."
    );
  }
}

export default async function handler(req, res) {
  const originAllowed = setCors(req, res);

  if (!originAllowed) {
    return sendJson(res, 403, {
      ok: false,
      error: "Origin is not allowed."
    });
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");

    return sendJson(res, 405, {
      ok: false,
      error: "Method not allowed."
    });
  }

  try {
    const body = parseRequestBody(req);
    const action = clean(body.action || "create", 50).toLowerCase();

    if (action === "create") {
      const result = await createFunnelSession(req, body);

      return sendJson(res, 201, {
        ok: true,
        ...result
      });
    }

    if (action === "save_checkout_email") {
      await saveCheckoutEmail(req, body);

      return sendJson(res, 200, {
        ok: true,
        checkout_email_saved: true,
        checkout_identity_saved: true
      });
    }

    throw new ClientError(400, "Unsupported action.");
  } catch (error) {
    if (error instanceof ClientError) {
      return sendJson(res, error.statusCode, {
        ok: false,
        error: error.message
      });
    }

    console.error(
      "PAYPRO FUNNEL SESSION ERROR",
      error instanceof Error ? error.message : "Unknown error"
    );

    return sendJson(res, 500, {
      ok: false,
      error: "Unable to process the funnel session request."
    });
  }
}
