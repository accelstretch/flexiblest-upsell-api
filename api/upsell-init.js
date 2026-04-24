export default async function handler(req, res) {
  const allowedOrigin = process.env.APP_BASE_URL || "";
  const origin = req.headers.origin || "";

  if (origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
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

  const PADDLE_API_BASE = "https://api.paddle.com";

  async function paddleFetch(path, options = {}) {
    return fetch(PADDLE_API_BASE + path, {
      ...options,
      headers: {
        Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
  }

  async function getCustomerIdFromTransaction(transactionId) {
    if (!transactionId || !transactionId.startsWith("txn_")) return "";

    const response = await paddleFetch(`/transactions/${transactionId}`, {
      method: "GET"
    });

    const data = await response.json();

    if (!response.ok) {
      return "";
    }

    return data?.data?.customer_id || "";
  }

  async function getCustomerIdFromEmail(email) {
    if (!email) return "";

    const response = await paddleFetch(
      `/customers?email=${encodeURIComponent(email)}`,
      { method: "GET" }
    );

    const data = await response.json();

    if (!response.ok) {
      return "";
    }

    const customers = Array.isArray(data?.data) ? data.data : [];
    const exact = customers.find(
      (c) => String(c?.email || "").toLowerCase() === email
    );

    return exact?.id || customers[0]?.id || "";
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    const submittedCustomerId = String(body.paddle_customer_id || "").trim();
    const accessEmail = String(body.access_email || "").trim().toLowerCase();
    const rootTxnId = String(body.root_txn_id || "").trim();

    let customerId = submittedCustomerId;

    if (!customerId || !customerId.startsWith("ctm_")) {
      customerId = await getCustomerIdFromTransaction(rootTxnId);
    }

    if (!customerId || !customerId.startsWith("ctm_")) {
      customerId = await getCustomerIdFromEmail(accessEmail);
    }

    if (!customerId || !customerId.startsWith("ctm_")) {
      return res.status(400).json({
        ok: false,
        error: "Unable to resolve Paddle customer",
        received: {
          submitted_customer_id: submittedCustomerId,
          access_email: accessEmail,
          root_txn_id: rootTxnId
        }
      });
    }

    const [authResponse, methodsResponse] = await Promise.all([
      paddleFetch(`/customers/${customerId}/auth-token`, {
        method: "POST",
        body: JSON.stringify({})
      }),
      paddleFetch(`/customers/${customerId}/payment-methods`, {
        method: "GET"
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
      customer_auth_token:
        authData?.data?.customer_auth_token ||
        authData?.data?.token ||
        "",
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
