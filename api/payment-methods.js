export default async function handler(req, res) {
  const allowedOrigin = process.env.APP_BASE_URL || "";
  const origin = req.headers.origin || "";

  if (origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const customerId = String(req.query.paddle_customer_id || "").trim();

    if (!customerId || !customerId.startsWith("ctm_")) {
      return res.status(400).json({
        ok: false,
        error: "Invalid paddle_customer_id"
      });
    }

    const response = await fetch(
      `https://api.paddle.com/customers/${customerId}/payment-methods`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${process.env.PADDLE_API_KEY}`,
          "Content-Type": "application/json"
        }
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

    const methods = Array.isArray(data?.data) ? data.data : [];
    const activeMethods = methods.filter((m) => m && m.status === "active");
    const bestMethod = activeMethods[0] || null;

    return res.status(200).json({
      ok: true,
      paddle_customer_id: customerId,
      saved_payment_methods: methods,
      best_saved_payment_method_id: bestMethod?.id || "",
      best_saved_payment_method: bestMethod
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Server error"
    });
  }
}
