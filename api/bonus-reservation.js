import crypto from "crypto";

const BONUS_RESERVATION_SECONDS = 24 * 60 * 60;
const RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;
const LEGACY_COOKIE_NAME = "fs_bonus_reservation";

function clean(value) {
  return String(value || "").trim();
}

function reservationKey(reservationId) {
  return `bonus:reservation:${reservationId}`;
}

function createReservationId() {
  return `br_${crypto.randomBytes(16).toString("hex")}`;
}

function createAccessToken() {
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

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex < 0) {
      continue;
    }

    const cookieName = cookie.slice(0, separatorIndex).trim();

    if (cookieName !== name) {
      continue;
    }

    try {
      return decodeURIComponent(cookie.slice(separatorIndex + 1).trim());
    } catch (error) {
      return "";
    }
  }

  return "";
}

function getLegacyCredentials(req) {
  const value = getCookie(req, LEGACY_COOKIE_NAME);
  const separatorIndex = value.indexOf(".");

  if (separatorIndex < 0) {
    return { reservationId: "", accessToken: "" };
  }

  return {
    reservationId: value.slice(0, separatorIndex),
    accessToken: value.slice(separatorIndex + 1)
  };
}

function withBearerToken(req, accessToken) {
  return {
    headers: {
      ...(req.headers || {}),
      authorization: `Bearer ${accessToken}`
    }
  };
}

function setLegacyCookie(res, reservationId, accessToken) {
  const value = encodeURIComponent(`${reservationId}.${accessToken}`);

  res.setHeader(
    "Set-Cookie",
    `${LEGACY_COOKIE_NAME}=${value}; Path=/; Max-Age=${RECORD_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`
  );
}

function isValidReservationId(value) {
  return /^br_[a-f0-9]{32}$/.test(clean(value));
}

function getAllowedOrigins() {
  const origins = new Set([
    "https://flexiblest.com",
    "https://www.flexiblest.com"
  ]);

  clean(process.env.APP_BASE_URL)
    .split(",")
    .map(clean)
    .filter(Boolean)
    .forEach(function (origin) {
      origins.add(origin.replace(/\/+$/, ""));
    });

  clean(process.env.ALLOWED_ORIGINS)
    .split(",")
    .map(clean)
    .filter(Boolean)
    .forEach(function (origin) {
      origins.add(origin.replace(/\/+$/, ""));
    });

  return origins;
}

function setCors(req, res) {
  const origin = clean(req.headers.origin).replace(/\/+$/, "");
  const allowedOrigins = getAllowedOrigins();

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req) {
  if (
    req.body &&
    typeof req.body === "object" &&
    !Buffer.isBuffer(req.body)
  ) {
    return req.body;
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (error) {
      return {};
    }
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    return {};
  }
}

function getRedisConfiguration() {
  const url = clean(process.env.KV_REST_API_URL).replace(/\/+$/, "");
  const token = clean(process.env.KV_REST_API_TOKEN);

  if (!url || !token) {
    throw new Error("Redis environment variables are not configured.");
  }

  return { url, token };
}

async function redisCommand(command) {
  const configuration = getRedisConfiguration();

  const response = await fetch(configuration.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${configuration.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const payload = await response.json().catch(function () {
    return {};
  });

  if (!response.ok || payload.error) {
    throw new Error(
      clean(payload.error) || `Redis request failed with ${response.status}.`
    );
  }

  return payload.result;
}

async function readReservationRecord(key) {
  const result = await redisCommand(["GET", key]);

  if (!result) {
    return null;
  }

  if (typeof result === "object") {
    return result;
  }

  try {
    return JSON.parse(result);
  } catch (error) {
    return null;
  }
}

async function createReservationRecord(key, record) {
  const result = await redisCommand([
    "SET",
    key,
    JSON.stringify(record),
    "EX",
    String(RECORD_TTL_SECONDS),
    "NX"
  ]);

  return result === "OK";
}

async function writeReservationRecord(key, record) {
  const result = await redisCommand([
    "SET",
    key,
    JSON.stringify(record),
    "EX",
    String(RECORD_TTL_SECONDS)
  ]);

  if (result !== "OK") {
    throw new Error("Unable to save the bonus reservation.");
  }
}

async function refreshReservationTtl(key) {
  await redisCommand([
    "EXPIRE",
    key,
    String(RECORD_TTL_SECONDS)
  ]);
}

function getReservationState(record, nowMilliseconds) {
  const deadlineMilliseconds = Date.parse(record.deadline_at || "");

  if (!Number.isFinite(deadlineMilliseconds)) {
    return {
      status: "expired",
      remaining_seconds: 0
    };
  }

  const remainingSeconds = Math.max(
    0,
    Math.ceil((deadlineMilliseconds - nowMilliseconds) / 1000)
  );

  return {
    status: remainingSeconds > 0 ? "active" : "expired",
    remaining_seconds: remainingSeconds
  };
}

function buildReservationPayload(record, options) {
  const now = options.now;
  const state = getReservationState(record, now.getTime());
  const deadlineMilliseconds = Date.parse(record.deadline_at || "");

  return {
    ok: true,
    reservation_id: record.reservation_id,
    status: state.status,
    remaining_seconds: state.remaining_seconds,
    duration_seconds: BONUS_RESERVATION_SECONDS,
    deadline_at: record.deadline_at,
    expires_at: Number.isFinite(deadlineMilliseconds)
      ? deadlineMilliseconds
      : null,
    expires_at_ms: Number.isFinite(deadlineMilliseconds)
      ? deadlineMilliseconds
      : null,
    cycle_started_at: record.cycle_started_at,
    cycle_number: Number(record.cycle_number || 1),
    server_time: now.toISOString(),
    renewed: options.renewed === true
  };
}

async function authorizeReservation(req, body) {
  const reservationId = clean(body.reservation_id);
  const accessToken = getBearerToken(req);

  if (!isValidReservationId(reservationId) || !accessToken) {
    return {
      ok: false,
      statusCode: 401,
      error: "A valid reservation ID and access token are required."
    };
  }

  const key = reservationKey(reservationId);
  const record = await readReservationRecord(key);

  if (!record || !record.access_token_hash) {
    return {
      ok: false,
      statusCode: 404,
      error: "The bonus reservation was not found."
    };
  }

  const suppliedHash = hashAccessToken(accessToken);

  if (!safeEqual(suppliedHash, record.access_token_hash)) {
    return {
      ok: false,
      statusCode: 401,
      error: "The bonus reservation access token is invalid."
    };
  }

  return {
    ok: true,
    key,
    record
  };
}

async function createReservation() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reservationId = createReservationId();
    const accessToken = createAccessToken();
    const now = new Date();

    const deadlineAt = new Date(
      now.getTime() + BONUS_RESERVATION_SECONDS * 1000
    ).toISOString();

    const record = {
      version: 2,
      reservation_id: reservationId,
      access_token_hash: hashAccessToken(accessToken),
      status: "active",
      cycle_number: 1,
      cycle_started_at: now.toISOString(),
      deadline_at: deadlineAt,
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    };

    const created = await createReservationRecord(
      reservationKey(reservationId),
      record
    );

    if (created) {
      return {
        ...buildReservationPayload(record, {
          now,
          renewed: false
        }),
        access_token: accessToken
      };
    }
  }

  throw new Error("Unable to create a unique bonus reservation.");
}

async function getReservationStatus(req, body) {
  const authorization = await authorizeReservation(req, body);

  if (!authorization.ok) {
    return authorization;
  }

  const now = new Date();

  await refreshReservationTtl(authorization.key);

  return {
    ok: true,
    statusCode: 200,
    payload: buildReservationPayload(authorization.record, {
      now,
      renewed: false
    })
  };
}

async function renewReservation(req, body) {
  const authorization = await authorizeReservation(req, body);

  if (!authorization.ok) {
    return authorization;
  }

  const now = new Date();
  const currentState = getReservationState(
    authorization.record,
    now.getTime()
  );

  if (currentState.status === "active") {
    await refreshReservationTtl(authorization.key);

    return {
      ok: true,
      statusCode: 200,
      payload: buildReservationPayload(authorization.record, {
        now,
        renewed: false
      })
    };
  }

  const updatedRecord = {
    ...authorization.record,
    version: 2,
    status: "active",
    cycle_number: Number(authorization.record.cycle_number || 1) + 1,
    cycle_started_at: now.toISOString(),
    deadline_at: new Date(
      now.getTime() + BONUS_RESERVATION_SECONDS * 1000
    ).toISOString(),
    updated_at: now.toISOString()
  };

  await writeReservationRecord(authorization.key, updatedRecord);

  return {
    ok: true,
    statusCode: 200,
    payload: buildReservationPayload(updatedRecord, {
      now,
      renewed: true
    })
  };
}

async function getLegacyReservation(req, res) {
  const credentials = getLegacyCredentials(req);

  if (
    isValidReservationId(credentials.reservationId) &&
    credentials.accessToken
  ) {
    const result = await renewReservation(
      withBearerToken(req, credentials.accessToken),
      { reservation_id: credentials.reservationId }
    );

    if (result.ok) {
      setLegacyCookie(
        res,
        credentials.reservationId,
        credentials.accessToken
      );

      return {
        statusCode: 200,
        payload: result.payload
      };
    }
  }

  const created = await createReservation();
  const { access_token: accessToken, ...payload } = created;

  setLegacyCookie(res, created.reservation_id, accessToken);

  return {
    statusCode: 200,
    payload
  };
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, {
      ok: false,
      error: "Method not allowed."
    });
    return;
  }

  try {
    if (req.method === "GET") {
      const result = await getLegacyReservation(req, res);
      sendJson(res, result.statusCode, result.payload);
      return;
    }

    const body = await readRequestBody(req);
    const action = clean(body.action).toLowerCase();

    if (action === "create") {
      const result = await createReservation();
      sendJson(res, 201, result);
      return;
    }

    if (action === "status") {
      const result = await getReservationStatus(req, body);

      if (!result.ok) {
        sendJson(res, result.statusCode, {
          ok: false,
          error: result.error
        });
        return;
      }

      sendJson(res, result.statusCode, result.payload);
      return;
    }

    if (action === "renew") {
      let actionRequest = req;
      let actionBody = body;

      if (!clean(body.reservation_id) || !getBearerToken(req)) {
        const credentials = getLegacyCredentials(req);

        if (
          isValidReservationId(credentials.reservationId) &&
          credentials.accessToken
        ) {
          actionRequest = withBearerToken(req, credentials.accessToken);
          actionBody = {
            ...body,
            reservation_id: credentials.reservationId
          };
        } else {
          const legacyResult = await getLegacyReservation(req, res);
          sendJson(res, legacyResult.statusCode, legacyResult.payload);
          return;
        }
      }

      const result = await renewReservation(actionRequest, actionBody);

      if (!result.ok) {
        sendJson(res, result.statusCode, {
          ok: false,
          error: result.error
        });
        return;
      }

      const legacyCredentials = getLegacyCredentials(req);

      if (
        isValidReservationId(legacyCredentials.reservationId) &&
        legacyCredentials.accessToken
      ) {
        setLegacyCookie(
          res,
          legacyCredentials.reservationId,
          legacyCredentials.accessToken
        );
      }

      sendJson(res, result.statusCode, result.payload);
      return;
    }

    sendJson(res, 400, {
      ok: false,
      error: "Unsupported action."
    });
  } catch (error) {
    console.error(
      "BONUS RESERVATION ERROR",
      error instanceof Error ? error.message : "Unknown error"
    );

    sendJson(res, 500, {
      ok: false,
      error: "Unable to process the bonus reservation."
    });
  }
}
