const PAYPRO_URL = "https://store.payproglobal.com/api/Orders/DoReferenceCharge";
const RECORD_TTL_SECONDS = 72 * 60 * 60;
const CHARGE_LOCK_SECONDS = 120;

const OFFERS = {
  fasttrack57: {
    productId: 133573,
    amount: 57,
    currency: "USD",
    name: "Advanced Fast Track",
    offerStep: "upsell_fasttrack57",
    nextUrl: "https://flexiblest.com/order-complete"
  },
  fasttrack37: {
    productId: 133574,
    amount: 37,
    currency: "USD",
    name: "Flexibility And Recovery Fast Track Core - Final Offer",
    offerStep: "downsell_fasttrack37",
    nextUrl: "https://flexiblest.com/order-complete"
  }
};

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

  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

async function redisCommand(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error("Missing KV_REST_API_URL or KV_REST_API_TOKEN");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(`Redis command failed: ${data.error || response.status}`);
  }

  return data.result;
}

function parseStoredRecord(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function isProcessedCharge(data) {
  const success = data?.isSuccess === true || data?.IsSuccess === true;
  const status = clean(
    data?.response?.orderStatusName ||
    data?.Response?.OrderStatusName
  ).toLowerCase();

  return success && status === "processed";
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  let lockKey = "";
  let lockAcquired = false;

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const offerKey = clean(body.offer);
    const sessionId = clean(body.fs_session_id);
    const checkoutIntentId = clean(body.fs_checkout_intent_id);
    const offer = OFFERS[offerKey];

    if (!offer) {
      return res.status(400).json({ ok: false, error: "Unknown offer" });
    }

    if (!sessionId || sessionId.length > 200 || checkoutIntentId.length > 200) {
      return res.status(400).json({ ok: false, error: "Missing or invalid checkout session" });
    }

    const checkoutValue = await redisCommand(["GET", `paypro:checkout:session:${sessionId}`]);
    const checkout = parseStoredRecord(checkoutValue);

    if (!checkout || clean(checkout.sessionId) !== sessionId || !clean(checkout.orderId)) {
      return res.status(403).json({ ok: false, error: "Checkout session not verified" });
    }

    if (
      checkoutIntentId &&
      checkout.checkoutIntentId &&
      clean(checkout.checkoutIntentId) !== checkoutIntentId
    ) {
      return res.status(403).json({ ok: false, error: "Checkout intent does not match" });
    }

    const referencedOrderId = clean(checkout.orderId);
    const resultKey = `paypro:charge-result:${sessionId}:${offerKey}`;
    const existingResult = parseStoredRecord(await redisCommand(["GET", resultKey]));

    if (existingResult?.charged === true) {
      return res.status(200).json({
        ok: true,
        charged: true,
        already_charged: true,
        offer: offerKey,
        product_id: offer.productId,
        amount: offer.amount,
        currency: offer.currency,
        next_url: offer.nextUrl
      });
    }

    lockKey = `paypro:charge-lock:${sessionId}:${offerKey}`;
    const lockResult = await redisCommand([
      "SET",
      lockKey,
      new Date().toISOString(),
      "NX",
      "EX",
      CHARGE_LOCK_SECONDS
    ]);

    if (lockResult !== "OK") {
      return res.status(409).json({
        ok: false,
        charged: false,
        error: "This upgrade is already being processed"
      });
    }

    lockAcquired = true;

    const vendorAccountId = process.env.PAYPRO_VENDOR_ACCOUNT_ID;
    const apiSecretKey = process.env.PAYPRO_API_SECRET_KEY;

    if (!vendorAccountId || !apiSecretKey) {
      throw new Error("Missing PayPro API credentials");
    }

    const payload = {
      vendorAccountId: Number(vendorAccountId),
      apiSecretKey,
      referencedOrderId: Number(referencedOrderId),
      productId: offer.productId,
      priceCurrencyCode: offer.currency,
      priceValue: offer.amount,
      referenceChargeName: offer.name,
      customFields: {
        processor: "paypro",
        funnel_id: "accelstretch_paypro_flow",
        offer_step: offer.offerStep,
        fs_session_id: sessionId,
        fs_checkout_intent_id: checkoutIntentId || clean(checkout.checkoutIntentId),
        root_order_id: referencedOrderId,
        source_product: "accelstretch"
      }
    };

    const response = await fetch(PAYPRO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let data = {};

    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }

    const charged = response.ok && isProcessedCharge(data);

    console.log("PAYPRO REFERENCE CHARGE:", {
      offer: offerKey,
      referenced_order_id: referencedOrderId,
      product_id: offer.productId,
      amount: offer.amount,
      charged,
      http_status: response.status
    });

    if (!charged) {
      await redisCommand(["DEL", lockKey]);
      lockAcquired = false;

      return res.status(200).json({
        ok: true,
        charged: false,
        fallback: true,
        offer: offerKey,
        product_id: offer.productId,
        amount: offer.amount,
        currency: offer.currency,
        next_url: offer.nextUrl
      });
    }

    const chargeOrderId = clean(
      data?.response?.orderId ||
      data?.Response?.OrderId
    );

    await redisCommand([
      "SET",
      resultKey,
      JSON.stringify({
        charged: true,
        orderId: chargeOrderId,
        referencedOrderId,
        productId: offer.productId,
        amount: offer.amount,
        currency: offer.currency,
        createdAt: new Date().toISOString()
      }),
      "EX",
      RECORD_TTL_SECONDS
    ]);

    await redisCommand(["DEL", lockKey]);
    lockAcquired = false;

    return res.status(200).json({
      ok: true,
      charged: true,
      fallback: false,
      offer: offerKey,
      product_id: offer.productId,
      amount: offer.amount,
      currency: offer.currency,
      next_url: offer.nextUrl
    });
  } catch (err) {
    if (lockAcquired && lockKey) {
      try {
        await redisCommand(["DEL", lockKey]);
      } catch (cleanupError) {}
    }

    console.error("PAYPRO REFERENCE CHARGE ERROR:", err);
    return res.status(500).json({ ok: false, error: "Unable to process this upgrade right now" });
  }
}

