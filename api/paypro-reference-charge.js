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

  const PAYPRO_URL =
    "https://store.payproglobal.com/api/Orders/DoReferenceCharge";

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

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    const offerKey = clean(body.offer);
    const referencedOrderId = clean(body.order_id);
    const sessionId = clean(body.fs_session_id);

    const offer = OFFERS[offerKey];

    if (!offer) {
      return res.status(400).json({
        ok: false,
        error: "Unknown offer"
      });
    }

    if (!referencedOrderId) {
      return res.status(400).json({
        ok: false,
        error: "Missing order_id"
      });
    }

    const vendorAccountId =
      process.env.PAYPRO_VENDOR_ACCOUNT_ID;

    const apiSecretKey =
      process.env.PAYPRO_API_SECRET_KEY;

    if (!vendorAccountId || !apiSecretKey) {
      return res.status(500).json({
        ok: false,
        error: "Missing PayPro API credentials"
      });
    }

    const payload = {
      vendorAccountId: Number(vendorAccountId),
      apiSecretKey: apiSecretKey,
      referencedOrderId: Number(referencedOrderId),
      productId: offer.productId,
      priceCurrencyCode: offer.currency,
      priceValue: offer.amount,
      referenceChargeName: offer.name,
      customFields: {
        processor: "paypro",
        funnel_id: "accelstretch_paypro_flow",
        offer_step: offer.offerStep,
        fs_session_id: sessionId || "",
        root_order_id: referencedOrderId,
        source_product: "accelstretch"
      }
    };

    const response = await fetch(PAYPRO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();

    let data = {};

    try {
      data = JSON.parse(text);
    } catch (error) {
      data = {
        raw: text
      };
    }

    const isSuccess =
      data?.isSuccess === true ||
      data?.IsSuccess === true;

    console.log("PAYPRO REFERENCE CHARGE:", {
      offer: offerKey,
      referenced_order_id: referencedOrderId,
      product_id: offer.productId,
      amount: offer.amount,
      is_success: isSuccess,
      http_status: response.status
    });

    if (!response.ok || !isSuccess) {
      return res.status(200).json({
        ok: true,
        charged: false,
        fallback: true,
        offer: offerKey,
        product_id: offer.productId,
        amount: offer.amount,
        currency: offer.currency,
        next_url: offer.nextUrl,
        paypro_response: data
      });
    }

    return res.status(200).json({
      ok: true,
      charged: true,
      fallback: false,
      offer: offerKey,
      product_id: offer.productId,
      amount: offer.amount,
      currency: offer.currency,
      next_url: offer.nextUrl,
      paypro_response: data
    });
  } catch (err) {
    console.error("PAYPRO REFERENCE CHARGE ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: String(
        err && err.message ? err.message : err
      )
    });
  }
}
