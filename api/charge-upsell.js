export default async function handler(req, res) {
  const allowedOrigin = process.env.APP_BASE_URL || "";
  const origin = req.headers.origin || "";

  if (origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
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

  async function getTransaction(txnId) {
    if (!txnId || !txnId.startsWith("txn_")) return null;

    const r = await paddleFetch(`/transactions/${txnId}`, { method: "GET" });
    const d = await r.json();

    if (!r.ok) return null;
    return d?.data || null;
  }

  async function getCustomerIdFromEmail(email) {
    if (!email) return "";

    const r = await paddleFetch(`/customers?email=${encodeURIComponent(email)}`, {
      method: "GET"
    });
    const d = await r.json();

    if (!r.ok) return "";

    const customers = Array.isArray(d?.data) ? d.data : [];
    const exact = customers.find(
      c => String(c?.email || "").toLowerCase() === email
    );

    return exact?.id || customers[0]?.id || "";
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    const submittedCustomerId = String(body.paddle_customer_id || "").trim();
    const rootTxnId = String(body.root_txn_id || "").trim();
    const accessEmail = String(body.access_email || "").trim().toLowerCase();
    const priceId = String(body.price_id || "").trim();

    if (!priceId || !priceId.startsWith("pri_")) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid price_id"
      });
    }

    const rootTxn = await getTransaction(rootTxnId);

    let customerId = submittedCustomerId;
    if (!customerId || !customerId.startsWith("ctm_")) {
      customerId = rootTxn?.customer_id || "";
    }

    if (!customerId || !customerId.startsWith("ctm_")) {
      customerId = await getCustomerIdFromEmail(accessEmail);
    }

    const addressId = rootTxn?.address_id || "";

    if (!customerId || !customerId.startsWith("ctm_") || !addressId || !addressId.startsWith("add_")) {
      return res.status(200).json({
        ok: true,
        fallback: true,
        reason: "missing_customer_or_address",
        customer_id: customerId || "",
        address_id: addressId || ""
      });
    }

    const methodsRes = await paddleFetch(`/customers/${customerId}/payment-methods`, {
      method: "GET"
    });
    const methodsData = await methodsRes.json();

    if (!methodsRes.ok) {
      return res.status(200).json({
        ok: true,
        fallback: true,
        reason: "payment_methods_lookup_failed",
        raw: methodsData
      });
    }

    const methods = Array.isArray(methodsData?.data) ? methodsData.data : [];
    const activeMethod = methods.find(m => m && m.status === "active") || null;

    if (!activeMethod) {
      return res.status(200).json({
        ok: true,
        fallback: true,
        reason: "no_saved_payment_method",
        customer_id: customerId,
        address_id: addressId
      });
    }

    const txnRes = await paddleFetch(`/transactions`, {
      method: "POST",
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        customer_id: customerId,
        address_id: addressId,
        collection_mode: "automatic",
        custom_data: body.custom_data || {}
      })
    });

    const txnData = await txnRes.json();
    const txn = txnData?.data || {};
    const status = txn?.status || "";

    if (!txnRes.ok) {
      return res.status(200).json({
        ok: true,
        fallback: true,
        reason: "transaction_create_failed",
        raw: txnData
      });
    }

    return res.status(200).json({
      ok: true,
      charged: status === "completed",
      fallback: status !== "completed",
      transaction_id: txn.id || "",
      transaction_status: status,
      checkout_url: txn?.checkout?.url || "",
      customer_id: customerId,
      address_id: addressId,
      saved_payment_method_id: activeMethod.id || ""
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Server error"
    });
  }
}
