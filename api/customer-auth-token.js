export default async function handler(req, res) {
  // --- CORS ---
  const allowedOrigin = process.env.APP_BASE_URL || "";
  const origin = req.headers.origin || "";

  if (origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // --- METHOD CHECK ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : req.body || {};

    const customerId = (body.paddle_customer_id || "").trim();

    if (!customerId || !customerId.startsWith("ctm_")) {
      return res.status(400).json({
        ok: false,
        error: "Invalid paddle_customer_id"
      });
    }

    // --- CALL PADDLE API ---
    const response = await fetch(
      `https://api.paddle.com/customers/${customerId}/auth-token`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.PADDLE_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: data?.error?.detail || "Paddle error",
        raw: data
      });
    }

    return res.status(200).json({
      ok: true,
      paddle_customer_id: customerId,
      customer_auth_token: data?.data?.token || "",
      expires_at: data?.data?.expires_at || ""
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Server error"
    });
  }
}
