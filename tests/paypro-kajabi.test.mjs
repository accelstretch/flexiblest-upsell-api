import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import webhookHandler from
  "../api/paypro-webhook.js";

const VALIDATION_KEY = "kajabi-test-validation-key";

process.env.KV_REST_API_URL = "https://redis.test";
process.env.KV_REST_API_TOKEN = "redis-token";
process.env.PAYPRO_VALIDATION_KEY = VALIDATION_KEY;
process.env.COMETLY_API_KEY = "cometly-test";

const offers = [
  {
    productId: "133559",
    offerId: "2151012544",
    activationEnv: "KAJABI_ACCELSTRETCH_ACTIVATION_URL",
    deactivationEnv: "KAJABI_ACCELSTRETCH_DEACTIVATION_URL"
  },
  {
    productId: "133565",
    offerId: "2151278593",
    activationEnv:
      "KAJABI_ROUTINE_QUICK_SHEETS_ACTIVATION_URL",
    deactivationEnv:
      "KAJABI_ROUTINE_QUICK_SHEETS_DEACTIVATION_URL"
  },
  {
    productId: "133569",
    offerId: "2151038529",
    activationEnv: "KAJABI_LEAN_LIGHT_ACTIVATION_URL",
    deactivationEnv: "KAJABI_LEAN_LIGHT_DEACTIVATION_URL"
  },
  {
    productId: "133573",
    offerId: "2150621466",
    activationEnv:
      "KAJABI_ADVANCED_FAST_TRACK_ACTIVATION_URL",
    deactivationEnv:
      "KAJABI_ADVANCED_FAST_TRACK_DEACTIVATION_URL"
  },
  {
    productId: "133574",
    offerId: "2148399198",
    activationEnv:
      "KAJABI_FAST_TRACK_CORE_ACTIVATION_URL",
    deactivationEnv:
      "KAJABI_FAST_TRACK_CORE_DEACTIVATION_URL"
  }
];

offers.forEach((offer) => {
  process.env[offer.activationEnv] =
    `https://checkout.kajabi.com/webhooks/offers/${offer.offerId}/secret/activate`;
  process.env[offer.deactivationEnv] =
    `https://checkout.kajabi.com/webhooks/offers/${offer.offerId}/secret/deactivate`;
});

const redis = new Map();
const kajabiCalls = [];

function handleRedisCommand(command) {
  const operation = String(command[0] || "").toUpperCase();

  if (operation === "GET") {
    return redis.has(command[1])
      ? redis.get(command[1])
      : null;
  }

  if (operation === "SET") {
    const key = command[1];
    const options = command.slice(3).map(String);

    if (
      options.some((value) => value.toUpperCase() === "NX") &&
      redis.has(key)
    ) {
      return null;
    }

    redis.set(key, command[2]);
    return "OK";
  }

  if (operation === "EVAL") {
    const key = command[3];
    const token = command[4];

    if (redis.get(key) === token) {
      redis.delete(key);
      return 1;
    }

    return 0;
  }

  throw new Error(`Unsupported Redis operation: ${operation}`);
}

global.fetch = async function mockFetch(url, options = {}) {
  const target = String(url);

  if (target === process.env.KV_REST_API_URL) {
    const command = JSON.parse(options.body);

    return new Response(
      JSON.stringify({ result: handleRedisCommand(command) }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  if (target.startsWith("https://checkout.kajabi.com/")) {
    kajabiCalls.push({
      url: target,
      method: options.method,
      headers: options.headers,
      body: JSON.parse(options.body)
    });

    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  throw new Error(`Unexpected fetch URL: ${target}`);
};

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,

    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(value) {
      this.body = value;
      return this;
    }
  };
}

function signatureFor(body) {
  return createHash("sha256")
    .update(
      body.ORDER_ID +
        body.ORDER_STATUS +
        body.ORDER_TOTAL_AMOUNT +
        body.CUSTOMER_EMAIL +
        VALIDATION_KEY +
        body.TEST_MODE +
        body.IPN_TYPE_NAME,
      "utf8"
    )
    .digest("hex");
}

async function sendIpn({
  productId,
  orderId,
  orderItemId,
  ipnType = "OrderCharged",
  orderStatus = "Processed",
  itemTotal = "29",
  itemRefunded = "0"
}) {
  const body = {
    ORDER_ID: orderId,
    ORDER_ITEM_ID: orderItemId,
    ORDER_STATUS: orderStatus,
    ORDER_TOTAL_AMOUNT: itemTotal,
    ORDER_ITEM_TOTAL_AMOUNT: itemTotal,
    ORDER_ITEM_REFUNDED: itemRefunded,
    ORDER_CURRENCY_CODE: "USD",
    CUSTOMER_EMAIL: "BUYER@EXAMPLE.COM",
    CUSTOMER_FIRST_NAME: "Test",
    CUSTOMER_LAST_NAME: "Buyer",
    CUSTOMER_NAME: "Test Buyer",
    TEST_MODE: "0",
    IPN_TYPE_NAME: ipnType,
    PRODUCT_ID: productId,
    ORDER_CUSTOM_FIELDS: "x-offer_step=kajabi_test"
  };

  body.SIGNATURE = signatureFor(body);

  const res = createResponse();

  await webhookHandler(
    { method: "POST", headers: {}, body },
    res
  );

  return res;
}

async function testAllOfferActivations() {
  redis.clear();
  kajabiCalls.length = 0;

  for (let index = 0; index < offers.length; index += 1) {
    const offer = offers[index];

    const response = await sendIpn({
      productId: offer.productId,
      orderId: String(910000 + index),
      orderItemId: String(920000 + index)
    });

    assert.equal(response.statusCode, 200);
  }

  assert.equal(kajabiCalls.length, offers.length);

  kajabiCalls.forEach((call, index) => {
    assert.match(call.url, new RegExp(offers[index].offerId));
    assert.match(call.url, /\/activate/);

    if (offers[index].productId === "133559") {
      assert.match(
        call.url,
        /send_offer_grant_email=true/
      );
    } else {
      assert.equal(
        call.url.includes("send_offer_grant_email"),
        false
      );
    }
    assert.equal(call.method, "POST");
    assert.deepEqual(call.body, {
      name: "Test Buyer",
      email: "buyer@example.com",
      external_user_id: "buyer@example.com"
    });
  });
}

async function testDuplicateProtection() {
  redis.clear();
  kajabiCalls.length = 0;

  const input = {
    productId: "133565",
    orderId: "930001",
    orderItemId: "930101"
  };

  await sendIpn(input);
  await sendIpn(input);

  assert.equal(kajabiCalls.length, 1);
}

async function testRefundAndChargebackLifecycle() {
  redis.clear();
  kajabiCalls.length = 0;

  await sendIpn({
    productId: "133569",
    orderId: "940001",
    orderItemId: "940101",
    ipnType: "OrderPartiallyRefunded",
    orderStatus: "Processed",
    itemTotal: "19",
    itemRefunded: "5"
  });

  assert.equal(kajabiCalls.length, 0);

  await sendIpn({
    productId: "133569",
    orderId: "940001",
    orderItemId: "940101",
    ipnType: "OrderPartiallyRefunded",
    orderStatus: "Refunded",
    itemTotal: "19",
    itemRefunded: "19"
  });

  assert.equal(kajabiCalls.length, 1);
  assert.match(kajabiCalls[0].url, /\/deactivate$/);

  await sendIpn({
    productId: "133573",
    orderId: "950001",
    orderItemId: "950101",
    ipnType: "OrderChargedBack",
    orderStatus: "Chargeback",
    itemTotal: "57"
  });

  assert.equal(kajabiCalls.length, 2);
  assert.match(kajabiCalls[1].url, /\/deactivate$/);

  await sendIpn({
    productId: "133573",
    orderId: "950001",
    orderItemId: "950101",
    ipnType: "OrderChargedBackWon",
    orderStatus: "Processed",
    itemTotal: "57"
  });

  assert.equal(kajabiCalls.length, 3);
  assert.match(kajabiCalls[2].url, /\/activate$/);
}

await testAllOfferActivations();
await testDuplicateProtection();
await testRefundAndChargebackLifecycle();

console.log("PayPro to Kajabi lifecycle simulations passed.");
