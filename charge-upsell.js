export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false });
    }

    const body = typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : req.body || {};

    const customerId = String(body.paddle_customer_id || "").trim();
    const rootTxnId = String(body.root_txn_id || "").trim();
    const priceId = String(body.price_id || "").trim();

    if (!priceId) {
      return res.status(400).json({
        ok: false,
        error: "Missing price_id"
      });
    }

    // fallback if no valid customer
    if (!customerId || !customerId.startsWith("ctm_")) {
      return res.status(200).json({
        ok: true,
        fallback: true
      });
    }

    // get saved payment methods
    const methodsRes = await fetch(`https://api.paddle.com/customers/${customerId}/payment-methods`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${process.env.PADDLE_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    const methodsData = await methodsRes.json();

    if (!methodsRes.ok) {
      return res.status(200).json({
        ok: true,
        fallback: true
      });
    }

    const methods = Array.isArray(methodsData?.data) ? methodsData.data : [];
    const active = methods.find(m => m.status === "active");

    if (!active) {
      return res.status(200).json({
        ok: true,
        fallback: true
      });
    }

    // 🔥 CREATE TRANSACTION (TRUE 1-CLICK)
    const txnRes = await fetch(`https://api.paddle.com/transactions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.PADDLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        items: [
          {
            price_id: priceId,
            quantity: 1
          }
        ],
        customer_id: customerId,
        collection_mode: "automatic"
      })
    });

    const txnData = await txnRes.json();

    if (!txnRes.ok) {
      return res.status(200).json({
        ok: true,
        fallback: true,
        error: txnData
      });
    }

    return res.status(200).json({
      ok: true,
      charged: true,
      transaction_id: txnData?.data?.id || ""
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
