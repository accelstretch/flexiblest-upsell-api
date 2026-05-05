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
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  const PADDLE_API_BASE = "https://api.paddle.com";

  const ALLOWED_PRICES = {
    "pri_01kq0sap0vx78bkgfs5m1b3q7z": {
      code: "39-AS-MAIN",
      name: "AccelStretch"
    },
    "pri_01kq4je7258mrqgasxsazyw3tr": {
      code: "AS-CMS-BUMP47",
      name: "Body Recovery System"
    },
    "pri_01kq4jtdnfqvmxx244g75sqyvq": {
      code: "AS-FFT-BUMP17",
      name: "Flexibility Fast Track"
    }
  };

  const MAIN_PRICE_ID = "pri_01kq0sap0vx78bkgfs5m1b3q7z";

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

  function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");
  }

  function normalizeItems(rawItems) {
    const items = Array.isArray(rawItems) ? rawItems : [];

    const cleaned = items
      .map(item => ({
        price_id: String(item.price_id || item.priceId || "").trim(),
        quantity: Number(item.quantity || 1)
      }))
      .filter(item => item.price_id && item.quantity > 0);

    const hasMain = cleaned.some(item => item.price_id === MAIN_PRICE_ID);

    if (!hasMain) {
      cleaned.unshift({
        price_id: MAIN_PRICE_ID,
        quantity: 1
      });
    }

    const deduped = [];
    const seen = new Set();

    for (const item of cleaned) {
      if (!ALLOWED_PRICES[item.price_id]) continue;
      if (seen.has(item.price_id)) continue;

      seen.add(item.price_id);
      deduped.push({
        price_id: item.price_id,
        quantity: 1
      });
    }

    return deduped;
  }

  async function findCustomerByEmail(email) {
    if (!validEmail(email)) return "";

    const response = await paddleFetch(
      `/customers?email=${encodeURIComponent(email)}`,
      { method: "GET" }
    );

    const data = await response.json();
    if (!response.ok) return "";

    const customers = Array.isArray(data?.data) ? data.data : [];
    const exact = customers.find(
      c => String(c?.email || "").toLowerCase() === email
    );

    return exact?.id || customers[0]?.id || "";
  }

  async function createCustomer(email) {
    if (!validEmail(email)) return "";

    const response = await paddleFetch("/customers", {
      method: "POST",
      body: JSON.stringify({
        email: email
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return "";
    }

    return data?.data?.id || "";
  }

  async function getOrCreateCustomerId(email) {
    if (!validEmail(email)) return "";

    const existing = await findCustomerByEmail(email);
    if (existing && existing.startsWith("ctm_")) return existing;

    const created = await createCustomer(email);
    if (created && created.startsWith("ctm_")) return created;

    return "";
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    const accessEmail = normalizeEmail(body.access_email || body.email || "");
    const items = normalizeItems(body.items);

    if (!items.length) {
      return res.status(400).json({
        ok: false,
        error: "No valid checkout items"
      });
    }

    const customerId = await getOrCreateCustomerId(accessEmail);

    const selectedPriceIds = items.map(item => item.price_id);
    const selectedInternalCodes = selectedPriceIds.map(
      id => ALLOWED_PRICES[id]?.code || id
    );

    const transactionBody = {
      items: items,
      collection_mode: "automatic",
      custom_data: {
        processor: "paddle",
        funnel: "accelstretch_paddle_order_bump_method",
        grant_email: accessEmail || "",
        source_product: "accelstretch-system",
        offer_step: "checkout_main",
        checkout_path: body.checkout_path || "/checkout-accelstretch",
        sales_page_path: body.sales_page_path || "/accelstretch-system",
        fs_session_id: body.fs_session_id || "",
        fs_checkout_intent_id: body.fs_checkout_intent_id || "",
        selected_price_ids: selectedPriceIds,
        selected_internal_codes: selectedInternalCodes
      }
    };

    if (customerId) {
      transactionBody.customer_id = customerId;
    }

    const transactionResponse = await paddleFetch("/transactions", {
      method: "POST",
      body: JSON.stringify(transactionBody)
    });

    const transactionData = await transactionResponse.json();

    if (!transactionResponse.ok) {
      return res.status(transactionResponse.status).json({
        ok: false,
        error: transactionData?.error?.detail || "Paddle transaction create failed",
        raw: transactionData
      });
    }

    const txn = transactionData?.data || {};

    return res.status(200).json({
      ok: true,
      transaction_id: txn.id || "",
      transaction_status: txn.status || "",
      checkout_url: txn?.checkout?.url || "",
      paddle_customer_id: txn.customer_id || customerId || "",
      access_email: accessEmail || "",
      selected_price_ids: selectedPriceIds,
      selected_internal_codes: selectedInternalCodes,
      raw_transaction: txn
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Server error"
    });
  }
}
