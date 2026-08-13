import crypto from "crypto";

const SESSION_TTL_SECONDS = 72 * 60 * 60;
const MAX_REQUEST_BODY_BYTES = 8 * 1024;
const MAX_UPDATE_ATTEMPTS = 4;

const DEFAULT_ALLOWED_ORIGINS = [
  "https://flexiblest.com",
  "https://www.flexiblest.com"
];

const COMPARE_AND_SET_SESSION_SCRIPT = `
local current = redis.call("GET", KEYS[1])

if not current then
  return 0
end

if current ~= ARGV[1] then
  return -1
end

redis.call("SET", KEYS[1], ARGV[2], "KEEPTTL")
return 1
`;

class ClientError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "ClientError";
    this.statusCode = statusCode;
  }
}

function funnelSessionKey(sessionId) {
  return `paypro:funnel:session:${sessionId}`;
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

function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || "").trim());

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "";
    }

    return parsed.origin;
  } catch {
    return "";
  }
}

function getAllowedOrigins() {
  const configuredOrigins = String(
    process.env.PAYPRO_FUNNEL_ALLOWED_ORIGINS || ""
  )
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  return new Set([
    ...DEFAULT_ALLOWED_ORIGINS.map(normalizeOrigin),
    ...configuredOrigins
  ]);
}

const ALLOWED_ORIGINS = getAllowedOrigins();

function applyResponseHeaders(req, res) {
  const requestOrigin = String(req.headers.origin || "").trim();
  const normalizedRequestOrigin = normalizeOrigin(requestOrigin);

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Vary", "Origin");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (
    normalizedRequestOrigin &&
    ALLOWED_ORIGINS.has(normalizedRequestOrigin)
  ) {
    res.setHeader("Access-Control-Allow-Origin", normalizedRequestOrigin);
  }
}

function isRequestOriginAllowed(req) {
  const requestOrigin = String(req.headers.origin || "").trim();

  // Requests without Origin are allowed for direct server-side testing.
  if (!requestOrigin) {
    return true;
  }

  const normalizedRequestOrigin = normalizeOrigin(requestOrigin);

  return (
    Boolean(normalizedRequestOrigin) &&
    ALLOWED_ORIGINS.has(normalizedRequestOrigin)
  );
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseRequestBody(req) {
  let body = req.body;

  if (body === undefined || body === null || body === "") {
    return {};
  }

  if (Buffer.isBuffer(body)) {
    if (body.length > MAX_REQUEST_BODY_BYTES) {
      throw new ClientError(413, "Request body is too large.");
    }

    body = body.toString("utf8");
  }

  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw new ClientError(413, "Request body is too large.");
    }

    try {
      body = JSON.parse(body);
    } catch {
      throw new ClientError(400, "Request body must contain valid JSON.");
    }
  }

  if (
    typeof body !== "object" ||
    Array.isArray(body) ||
    body === null
  ) {
    throw new ClientError(400, "Request body must be a JSON object.");
  }

  let serializedBody;

  try {
    serializedBody = JSON.stringify(body);
  } catch {
    throw new ClientError(400, "Request body must contain valid JSON.");
  }

  if (
    Buffer.byteLength(serializedBody, "utf8") >
    MAX_REQUEST_BODY_BYTES
  ) {
    throw new ClientError(413, "Request body is too large.");
  }

  return body;
}

function normalizeIdentifier(value) {
  const identifier = String(value || "").trim();

  if (
    identifier.length < 16 ||
    identifier.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(identifier)
  ) {
    return "";
  }

  return identifier;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();

  if (
    !email ||
    Buffer.byteLength(email, "utf8") > 254 ||
    /[\u0000-\u001f\u007f\s]/.test(email)
  ) {
    return "";
  }

  const atIndex = email.lastIndexOf("@");

  if (
    atIndex <= 0 ||
    atIndex !== email.indexOf("@") ||
    atIndex === email.length - 1
  ) {
    return "";
  }

  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  if (
    Buffer.byteLength(localPart, "utf8") > 64 ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    domain.length > 253 ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..")
  ) {
    return "";
  }

  const domainLabels = domain.split(".");

  if (domainLabels.length < 2) {
    return "";
  }

  const validDomain = domainLabels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );

  if (!validDomain || !/^[^\s@]+$/.test(localPart)) {
    return "";
  }

  return email;
}

function getRedisConfiguration() {
  const url = String(process.env.KV_REST_API_URL || "")
    .trim()
    .replace(/\/+$/, "");

  const token = String(process.env.KV_REST_API_TOKEN || "").trim();

  if (!url || !token) {
    throw new Error(
      "KV_REST_API_URL or KV_REST_API_TOKEN is not configured."
    );
  }

  return { url, token };
}

async function runRedisCommand(command) {
  const { url, token } = getRedisConfiguration();
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

    let payload;

    try {
      payload = await response.json();
    } catch {
      throw new Error("Redis returned a non-JSON response.");
    }

    if (!response.ok || payload.error) {
      throw new Error(
        `Redis command failed with HTTP ${response.status}.`
      );
    }

    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function createRedisSession(sessionId, session) {
  const result = await runRedisCommand([
    "SET",
    funnelSessionKey(sessionId),
    JSON.stringify(session),
    "EX",
    SESSION_TTL_SECONDS,
    "NX"
  ]);

  return result === "OK";
}

async function readRedisSession(sessionId) {
  const raw = await runRedisCommand([
    "GET",
    funnelSessionKey(sessionId)
  ]);

  if (raw === null || raw === undefined) {
    return null;
  }

  if (typeof raw !== "string") {
    throw new Error("Stored funnel session has an invalid format.");
  }

  let session;

  try {
    session = JSON.parse(raw);
  } catch {
    throw new Error("Stored funnel session contains invalid JSON.");
  }

  if (
    !session ||
    typeof session !== "object" ||
    Array.isArray(session)
  ) {
    throw new Error("Stored funnel session is not a JSON object.");
  }

  return { raw, session };
}

async function compareAndSetRedisSession(
  sessionId,
  previousRaw,
  updatedSession
) {
  const result = await runRedisCommand([
    "EVAL",
    COMPARE_AND_SET_SESSION_SCRIPT,
    1,
    funnelSessionKey(sessionId),
    previousRaw,
    JSON.stringify(updatedSession)
  ]);

  return Number(result);
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

  const storedHash = String(session.access_token_hash || "");
  const suppliedHash = hashAccessToken(accessToken);

  return (
    storedHash.length === 64 &&
    safeEqual(storedHash, suppliedHash)
  );
}

async function createFunnelSession() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sessionId = crypto.randomUUID();
    const checkoutIntentId = crypto.randomUUID();
    const accessToken = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + SESSION_TTL_SECONDS * 1000
    );

    const session = {
      schema_version: 1,
      fs_session_id: sessionId,
      fs_checkout_intent_id: checkoutIntentId,

      // Only the hash is persisted. The raw token is returned once.
      access_token_hash: hashAccessToken(accessToken),

      status: "pending",
      checkout_completed: false,
      checkout_email: null,
      checkout_email_captured_at: null,

      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: expiresAt.toISOString()
    };

    const created = await createRedisSession(sessionId, session);

    if (created) {
      return {
        fs_session_id: sessionId,
        fs_checkout_intent_id: checkoutIntentId,
        fs_funnel_access_token: accessToken,
        expires_in_seconds: SESSION_TTL_SECONDS
      };
    }
  }

  throw new Error("Unable to allocate a unique funnel session.");
}

async function saveCheckoutEmail(req, body) {
  const sessionId = normalizeIdentifier(body.fs_session_id);
  const checkoutIntentId = normalizeIdentifier(
    body.fs_checkout_intent_id
  );
  const accessToken = getBearerToken(req);
  const email = normalizeEmail(body.email);

  if (!sessionId || !checkoutIntentId) {
    throw new ClientError(
      400,
      "Valid funnel session identifiers are required."
    );
  }

  if (
    accessToken.length < 20 ||
    accessToken.length > 512
  ) {
    throw new ClientError(
      401,
      "Invalid or expired funnel credentials."
    );
  }

  if (!email) {
    throw new ClientError(
      400,
      "A valid checkout email address is required."
    );
  }

  for (
    let attempt = 0;
    attempt < MAX_UPDATE_ATTEMPTS;
    attempt += 1
  ) {
    const stored = await readRedisSession(sessionId);

    if (
      !stored ||
      !sessionCredentialsAreValid({
        session: stored?.session,
        sessionId,
        checkoutIntentId,
        accessToken
      })
    ) {
      throw new ClientError(
        401,
        "Invalid or expired funnel credentials."
      );
    }

    if (stored.session.checkout_email === email) {
      return;
    }

    const now = new Date().toISOString();

    const updatedSession = {
      ...stored.session,
      checkout_email: email,
      checkout_email_captured_at: now,
      updated_at: now
    };

    const updateResult = await compareAndSetRedisSession(
      sessionId,
      stored.raw,
      updatedSession
    );

    if (updateResult === 1) {
      return;
    }

    if (updateResult === 0) {
      throw new ClientError(
        401,
        "Invalid or expired funnel credentials."
      );
    }

    // A webhook or another authenticated request updated the
    // session between GET and SET. Reload it and try again.
  }

  throw new ClientError(
    409,
    "The funnel session changed during the request. Please retry."
  );
}

export default async function handler(req, res) {
  applyResponseHeaders(req, res);

  if (!isRequestOriginAllowed(req)) {
    return sendJson(res, 403, {
      ok: false,
      error: "Origin is not allowed."
    });
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type"
    );
    res.setHeader("Access-Control-Max-Age", "600");
    return res.end();
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
    const action = String(body.action || "create")
      .trim()
      .toLowerCase();

    if (action === "create") {
      const result = await createFunnelSession();

      return sendJson(res, 201, {
        ok: true,
        ...result
      });
    }

    if (action === "save_checkout_email") {
      await saveCheckoutEmail(req, body);

      return sendJson(res, 200, {
        ok: true,
        checkout_email_saved: true
      });
    }

    throw new ClientError(400, "Unsupported funnel-session action.");
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
