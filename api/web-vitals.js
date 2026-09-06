const MAX_BODY_BYTES = 16 * 1024;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_EVENTS = 5000;
const LIST_KEY = "webvitals:events:v1";

const ALLOWED_METRICS = new Set(["LCP", "INP", "CLS", "FCP", "TTFB"]);
const ALLOWED_DEVICES = new Set(["mobile", "tablet", "desktop", "unknown"]);
const ALLOWED_SOURCES = new Set(["facebook", "instagram", "meta", "other", "direct", "unknown"]);

function clean(value, maxLength = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function getAllowedOrigins() {
  return new Set([
    "https://flexiblest.com",
    "https://www.flexiblest.com"
  ]);
}

function setHeaders(req, res) {
  const origin = clean(req.headers.origin, 500);
  if (origin && getAllowedOrigins().has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function getRedisConfiguration() {
  const url = clean(process.env.KV_REST_API_URL, 2000).replace(/\/+$/, "");
  const token = clean(process.env.KV_REST_API_TOKEN, 4000);
  if (!url || !token) throw new Error("Redis environment variables are not configured.");
  return { url, token };
}

async function redisCommand(command) {
  const { url, token } = getRedisConfiguration();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
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
    if (!response.ok || !payload || Object.prototype.hasOwnProperty.call(payload, "error")) {
      throw new Error(payload?.error || `Redis returned HTTP ${response.status}.`);
    }
    return payload.result;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseBody(req) {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  if (typeof req.body === "string") {
    if (Buffer.byteLength(req.body, "utf8") > MAX_BODY_BYTES) throw new Error("body_too_large");
    return JSON.parse(req.body);
  }
  return {};
}

function normalizeEvent(input) {
  const metric = clean(input.metric, 10).toUpperCase();
  if (!ALLOWED_METRICS.has(metric)) throw new Error("invalid_metric");

  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0 || value > 120000) throw new Error("invalid_value");

  const path = clean(input.path, 200);
  if (!path.startsWith("/")) throw new Error("invalid_path");

  const deviceRaw = clean(input.device, 20).toLowerCase();
  const sourceRaw = clean(input.source, 20).toLowerCase();

  return {
    metric,
    value: Math.round(value * 1000) / 1000,
    path,
    device: ALLOWED_DEVICES.has(deviceRaw) ? deviceRaw : "unknown",
    source: ALLOWED_SOURCES.has(sourceRaw) ? sourceRaw : "unknown",
    inApp: Boolean(input.inApp),
    navigationType: clean(input.navigationType, 30),
    viewportWidth: Number.isFinite(Number(input.viewportWidth)) ? Math.max(0, Math.min(10000, Math.round(Number(input.viewportWidth)))) : 0,
    ts: Date.now()
  };
}

export default async function handler(req, res) {
  setHeaders(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  const origin = clean(req.headers.origin, 500);
  if (origin && !getAllowedOrigins().has(origin)) {
    return res.status(403).json({ ok: false, error: "origin_not_allowed" });
  }

  try {
    const event = normalizeEvent(parseBody(req));
    const serialized = JSON.stringify(event);

    await redisCommand(["RPUSH", LIST_KEY, serialized]);
    await redisCommand(["LTRIM", LIST_KEY, String(-MAX_EVENTS), "-1"]);
    await redisCommand(["EXPIRE", LIST_KEY, String(RETENTION_SECONDS)]);

    console.log("web_vital", event);
    return res.status(204).end();
  } catch (error) {
    const message = clean(error?.message, 100);
    const isClientError = [
      "body_too_large",
      "invalid_metric",
      "invalid_value",
      "invalid_path"
    ].includes(message);

    if (isClientError) return res.status(400).json({ ok: false, error: message });

    console.error("web_vitals_store_failed", message);
    return res.status(500).json({ ok: false, error: "store_failed" });
  }
}
