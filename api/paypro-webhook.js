export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const data = req.body;

    // ===== BASIC FIELDS =====
    const email = data.CUSTOMER_EMAIL;
    const orderId = data.ORDER_ID;
    const productName = data.ORDER_ITEM_NAME;
    const sku = data.ORDER_ITEM_SKU;
    const value = parseFloat(data.ORDER_ITEM_TOTAL_AMOUNT || 0);
    const currency = data.ORDER_CURRENCY_CODE || 'USD';
    const paymentMethod = data.PAYMENT_METHOD_NAME;

    // ===== DEBUG LOG =====
    console.log('PAYPRO RAW:', data);

    // ===== MAP SKU → KAJABI OFFER =====
    const productMap = {
      'FS-ACCELSTRETCH-MAIN': 'KAJABI_OFFER_ID_MAIN',
      'FS-CHARTS-17': 'KAJABI_OFFER_ID_CHARTS',
      'FS-NUTRITION-12': 'KAJABI_OFFER_ID_NUTRITION',
      'FS-FASTTRACK-57': 'KAJABI_OFFER_ID_FASTTRACK',
      'FS-FASTTRACK-37': 'KAJABI_OFFER_ID_FASTTRACK_DOWN',
      'FS-BODYPLAN-27': 'KAJABI_OFFER_ID_BODYPLAN'
    };

    const kajabiOfferId = productMap[sku] || null;

    // ===== SEND TO COMETLY =====
    await fetch('https://api.cometly.com/api/v1/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.COMETLY_API_KEY}`
      },
      body: JSON.stringify({
        event_name: 'Purchase',
        email: email,
        value: value,
        currency: currency,
        event_id: orderId,
        properties: {
          product_name: productName,
          sku: sku,
          payment_method: paymentMethod
        }
      })
    });

    // ===== SEND TO ZAPIER (KAJABI ACCESS) =====
    await fetch(process.env.ZAPIER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        order_id: orderId,
        product_name: productName,
        sku: sku,
        kajabi_offer_id: kajabiOfferId
      })
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('WEBHOOK ERROR:', error);
    return res.status(500).json({ error: 'Webhook failed' });
  }
}
