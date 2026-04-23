export default async function handler(req, res) {
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

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const body = typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : req.body || {};

    const customerId = String(body.paddle_customer_id || "").trim();
    const accessEmail = String(body.access_email || "").trim().toLowerCase();
    const rootTxnId = String(body.root_txn_id || "").trim();

    if (!customerId || !customerId.startsWith("ctm_")) {
      return res.status(400).json({
        ok: false,
        error: "Invalid paddle_customer_id"
      });
    }

    const [authResponse, methodsResponse] = await Promise.all([
      fetch(`https://api.paddle.com/customers/${customerId}/auth-token`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.PADDLE_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      fetch(`https://api.paddle.com/customers/${customerId}/payment-methods`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${process.env.PADDLE_API_KEY}`,
          "Content-Type": "application/json"
        }
      })
    ]);

    const authData = await authResponse.json();
    const methodsData = await methodsResponse.json();

    if (!authResponse.ok) {
      return res.status(authResponse.status).json({
        ok: false,
        error: authData?.error?.detail || "Paddle auth-token error",
        raw: authData
      });
    }

    if (!methodsResponse.ok) {
      return res.status(methodsResponse.status).json({
        ok: false,
        error: methodsData?.error?.detail || "Paddle payment-methods error",
        raw: methodsData
      });
    }

    const methods = Array.isArray(methodsData?.data) ? methodsData.data : [];
    const activeMethods = methods.filter((m) => m && m.status === "active");
    const bestMethod = activeMethods[0] || null;

    return res.status(200).json({
      ok: true,
      paddle_client_token: process.env.PADDLE_CLIENT_TOKEN || "",
      paddle_customer_id: customerId,
      customer_auth_token: authData?.data?.token || "",
      expires_at: authData?.data?.expires_at || "",
      saved_payment_methods: methods,
      saved_payment_methods_count: methods.length,
      saved_payment_method_id: bestMethod?.id || "",
      saved_payment_method: bestMethod,
      access_email: accessEmail,
      root_txn_id: rootTxnId,
      final_thank_you_url: process.env.FINAL_THANK_YOU_URL || ""
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Server error"
    });
  }
}
