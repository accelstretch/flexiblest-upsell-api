import crypto from "crypto";

const BONUS_RESERVATION_SECONDS = 2 * 60 * 60 + 58 * 60;
const RECORD_TTL_SECONDS = 24 * 60 * 60;
const MAX_REQUEST_BODY_BYTES = 8 * 1024;

class ClientError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "ClientError";
    this.statusCode = statusCode;
  }
}

function clean(value) {
  return String(value || "").trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validReservationId(value) {
  return /^br_[a-f0-9]{32}$/.test(clean(value));
}

function makeReservationId() {
  return `br_${crypto.randomUUID().replace(/-/g, "")}`;
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

function reservationKey(reservationId) {
  return `bonus:reservation:${reservationId}`;
}

function getAllowedOrigins() {
  const configured = [
    process.env.APP_BASE_URL,
    process.env.ALLOWED_ORIGINS,
    process.env.WEBFLOW_ALLOWED_ORIGINS
  ]
    .filter(Boolean)
    .flatMap(function (value) {
      return String(value).split(",");
    })
    .map(clean)
    .filter(Boolean);

  return new Set([
    "https://flexiblest.com",
    "https://www.flexiblest.com",
    ...configured
  ]);
}

function setCors(req, res) {
  const origin = clean(req.headers.origin);

  if (!origin) {
    return;
  }

  if (!getAllowedOrigins().has(origin)) {
    throw new ClientError(403, "Origin is not allowed.");
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req) {
  if (isPlainObject(req.body)) {
    const serialized = JSON.stringify(req.body);

    if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw new ClientError(413, "Request body is too large.");
    }

    return req.body;
  }

  if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : req.body;

    if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw new ClientError(413, "Request body is too large.");
    }

    try {
      const parsed = JSON.parse(rawBody || "{}");

      if (!isPlainObject(parsed)) {
        throw new Error("Invalid JSON object.");
      }

      return parsed;
    } catch (error) {
      throw new ClientError(400, "Request body must be valid JSON.");
    }
  }

  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new ClientError(413, "Request body is too large.");
    }

    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");

  try {
    const parsed = JSON.parse(rawBody || "{}");

    if (!isPlainObject(parsed)) {
      throw new Error("Invalid JSON object.");
    }

    return parsed;
  } catch (error) {
    throw new ClientError(400, "Request body must be valid JSON.");
  }
}

async function redisCommand(args) {
  const redisUrl = clean(process.env.KV_REST_API_URL).replace(/\/$/, "");
  const redisToken = clean(process.env.KV_REST_API_TOKEN);

  if (!redisUrl || !redisToken) {
    throw new Error("Redis environment variables are missing.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(function () {
    controller.abort();
  }, 8000);

  try {
    const commandUrl =
      redisUrl +
      "/" +
      args.map(function (value) {
        return encodeURIComponent(String(value));
      }).join("/");

    const response = await fetch(commandUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${redisToken}`
      },
      cache: "no-store",
      signal: controller.signal
    });

    const data = await response.json().catch(function () {
      return {};
    });

    if (!response.ok || data.error) {
      throw new Error(
        `Redis command failed: ${clean(data.error) || response.status}`
      );
    }

    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function readReservation(reservationId) {
  const result = await redisCommand(["GET", reservationKey(reservationId)]);

  if (!result) {
    return null;
  }

  try {
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    return isPlainObject(parsed) ? parsed : null;
  } catch (error) {
    throw new Error("Stored bonus reservation is invalid.");
  }
}

async function createReservationRecord(key, record) {
  const result = await redisCommand([
    "SET",
    key,
    JSON.stringify(record),
    "EX",
    RECORD_TTL_SECONDS,
    "NX"
  ]);

  return result === "OK";
}

function getReservationState(record, nowMs) {
  const deadlineMs = Date.parse(clean(record.deadline_at));

  if (!Number.isFinite(deadlineMs)) {
    throw new Error("Stored bonus reservation deadline is invalid.");
  }

  const bonusEligible = nowMs < deadlineMs;

  return {
    status: bonusEligible ? "active" : "expired",
    bonus_eligible: bonusEligible,
    remaining_seconds: bonusEligible
      ? Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000))
      : 0
  };
}

async function createBonusReservation() {
  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const deadlineAt = new Date(
    nowMs + BONUS_RESERVATION_SECONDS * 1000
  ).toISOString();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const reservationId = makeReservationId();
    const accessToken = makeAccessToken();

    const record = {
      version: 1,
      bonus_reservation_id: reservationId,
      access_token_hash: hashAccessToken(accessToken),
      created_at: createdAt,
      deadline_at: deadlineAt,
      status: "active",
      updated_at: createdAt
    };

    const created = await createReservationRecord(
      reservationKey(reservationId),
      record
    );

    if (created) {
      return {
        bonus_reservation_id: reservationId,
        bonus_reservation_access_token: accessToken,
        created_at: createdAt,
        deadline_at: deadlineAt,
        duration_seconds: BONUS_RESERVATION_SECONDS,
        server_time: createdAt,
        status: "active",
        bonus_eligible: true,
        remaining_seconds: BONUS_RESERVATION_SECONDS
      };
    }
  }

  throw new Error("Unable to allocate a unique bonus reservation.");
}

async function getBonusReservationStatus(req, body) {
  const reservationId = clean(body.bonus_reservation_id);
  const accessToken = getBearerToken(req);

  if (!validReservationId(reservationId) || !accessToken) {
    throw new ClientError(401, "Invalid reservation credentials.");
  }

  const record = await readReservation(reservationId);

  if (
    !record ||
    !safeEqual(hashAccessToken(accessToken), record.access_token_hash)
  ) {
    throw new ClientError(401, "Invalid reservation credentials.");
  }

  const nowMs = Date.now();
  const serverTime = new Date(nowMs).toISOString();
  const state = getReservationState(record, nowMs);

  return {
    bonus_reservation_id: reservationId,
    created_at: clean(record.created_at),
    deadline_at: clean(record.deadline_at),
    duration_seconds: BONUS_RESERVATION_SECONDS,
    server_time: serverTime,
    ...state
  };
}

export default async function handler(req, res) {
  try {
    setCors(req, res);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      return sendJson(res, 405, {
        ok: false,
        error: "Method not allowed."
      });
    }

    const body = await readRequestBody(req);
    const action = clean(body.action).toLowerCase();

    if (action === "create") {
      const reservation = await createBonusReservation();

      return sendJson(res, 201, {
        ok: true,
        ...reservation
      });
    }

    if (action === "status") {
      const reservation = await getBonusReservationStatus(req, body);

      return sendJson(res, 200, {
        ok: true,
        ...reservation
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
      "BONUS RESERVATION ERROR",
      error instanceof Error ? error.message : "Unknown error"
    );

    return sendJson(res, 500, {
      ok: false,
      error: "Unable to process the bonus reservation request."
    });
  }
}
