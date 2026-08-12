const COMPLETE_UPGRADE_URL = "https://flexiblest.com/complete-upgrade";

function clean(value) {
  return String(value || "").trim();
}

function setCors(req, res) {
  const origin = clean(req.headers.origin);
  const configured = clean(process.env.APP_BASE_URL);
  const allowed = new Set([
    "https://flexiblest.com",
    "https://www.flexiblest.com",
    ...configured.split(",").map(clean).filter(Boolean)
  ]);
  if (allowed.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

async function redisGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Missing KV_REST_API_URL or KV_REST_API_TOKEN");

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(["GET", key])
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(`Redis command failed: ${data.error || response.status}`);
  return data.result;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const sessionId = clean(req.query?.fs_session_id || req.query?.session_id);
    const checkoutIntentId = clean(req.query?.fs_checkout_intent_id || req.query?.checkout_intent_id);
    if (!sessionId) return res.status(400).json({ ok: false, error: "Missing fs_session_id" });
    if (sessionId.length > 200 || checkoutIntentId.length > 200) return res.status(400).json({ ok: false, error: "Invalid checkout identifier" });

    const stored = await redisGet(`paypro:checkout:session:${sessionId}`);
    if (!stored) return res.status(200).json({ ok: true, ready: false });

    let record;
    try {
      record = typeof stored === "string" ? JSON.parse(stored) : stored;
    } catch (error) {
      throw new Error("Stored checkout record is invalid");
    }

    if (record.sessionId !== sessionId) return res.status(200).json({ ok: true, ready: false });
    if (checkoutIntentId && record.checkoutIntentId && record.checkoutIntentId !== checkoutIntentId) {
      return res.status(200).json({ ok: true, ready: false });
    }

    return res.status(200).json({
      ok: true,
      ready: true,
      order_id: record.orderId,
      redirect_url: COMPLETE_UPGRADE_URL
    });
  } catch (err) {
    console.error("PAYPRO CHECKOUT STATUS ERROR:", err);
    return res.status(500).json({ ok: false, error: "Checkout status is temporarily unavailable" });
  }
}
