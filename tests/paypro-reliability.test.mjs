import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import referenceChargeHandler from
  "../api/paypro-reference-charge.js";
import manualCheckoutHandler from
  "../api/paypro-manual-checkout.js";
import webhookHandler from
  "../api/paypro-webhook.js";

const SESSION_ID =
  "session_1234567890abcdefghij";
const CHECKOUT_INTENT_ID =
  "intent_1234567890abcdefghij";
const ACCESS_TOKEN =
  "token_1234567890abcdefghijklmnopqrstuvwxyz";
const ROOT_ORDER_ID = "700001";
const VALIDATION_KEY = "test-validation-key";

process.env.KV_REST_API_URL = "https://redis.test";
process.env.KV_REST_API_TOKEN = "redis-token";
process.env.PAYPRO_VENDOR_ACCOUNT_ID = "172691";
process.env.PAYPRO_API_SECRET_KEY = "paypro-secret";
process.env.PAYPRO_VALIDATION_KEY = VALIDATION_KEY;
process.env.COMETLY_API_KEY = "cometly-test";

const redis = new Map();
let payProResponse = null;
let payProCallCount = 0;

function parseJson(value) {
  if (!value) {
    return null;
  }

  return typeof value === "string"
    ? JSON.parse(value)
    : value;
}

function handleRedisCommand(command) {
  const operation = String(command[0] || "").toUpperCase();

  if (operation === "GET") {
    return redis.has(command[1])
      ? redis.get(command[1])
      : null;
  }

  if (operation === "DEL") {
    const existed = redis.delete(command[1]);
    return existed ? 1 : 0;
  }

  if (operation === "SET") {
    const key = command[1];
    const value = command[2];
    const options = command.slice(3).map(String);

    if (
      options.some((option) => option.toUpperCase() === "NX") &&
      redis.has(key)
    ) {
      return null;
    }

    redis.set(key, value);
    return "OK";
  }

  if (operation !== "EVAL") {
    throw new Error(`Unsupported Redis operation: ${operation}`);
  }

  const script = String(command[1]);
  const key = command[3];
  const args = command.slice(4);

  if (script.includes("outcome = \"saved\"")) {
    const existing = parseJson(redis.get(key));

    if (existing?.charged === true) {
      return JSON.stringify({
        outcome: "existing",
        record: existing
      });
    }

    const record = parseJson(args[0]);
    redis.set(key, JSON.stringify(record));

    return JSON.stringify({
      outcome: "saved",
      record
    });
  }

  if (script.includes("local charged = existing")) {
    const existing = parseJson(redis.get(key));

    if (
      existing?.charged === true ||
      existing?.confirmedByIpn === true ||
      existing?.status === "confirmed"
    ) {
      return JSON.stringify(existing);
    }

    redis.set(key, String(args[0]));
    return String(args[0]);
  }

  if (script.includes("return redis.call(\"DEL\", KEYS[1])")) {
    if (redis.get(key) === args[0]) {
      redis.delete(key);
      return 1;
    }

    return 0;
  }

  throw new Error("Unsupported Redis script");
}

global.fetch = async function mockFetch(url, options = {}) {
  if (String(url) === process.env.KV_REST_API_URL) {
    const command = JSON.parse(options.body);
    const result = handleRedisCommand(command);

    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (
    String(url) ===
    "https://store.payproglobal.com/api/Orders/DoReferenceCharge"
  ) {
    payProCallCount += 1;

    return new Response(JSON.stringify(payProResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  throw new Error(`Unexpected fetch URL: ${url}`);
};

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,

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
    },

    end() {
      this.ended = true;
      return this;
    }
  };
}

function secureSessionRecord() {
  return {
    fs_session_id: SESSION_ID,
    fs_checkout_intent_id: CHECKOUT_INTENT_ID,
    access_token_hash: createHash("sha256")
      .update(ACCESS_TOKEN, "utf8")
      .digest("hex"),
    status: "paid",
    checkout_completed: true,
    paypro_root_order_id: ROOT_ORDER_ID,
    customer_email: "buyer@example.com"
  };
}

function resetState() {
  redis.clear();
  payProCallCount = 0;

  redis.set(
    `paypro:funnel:session:${SESSION_ID}`,
    JSON.stringify(secureSessionRecord())
  );
}

async function callReferenceCharge(
  action = "charge",
  offer = "fasttrack57"
) {
  const req = {
    method: "POST",
    headers: {
      origin: "https://flexiblest.com",
      authorization: `Bearer ${ACCESS_TOKEN}`
    },
    body: {
      action,
      offer,
      fs_session_id: SESSION_ID,
      fs_checkout_intent_id: CHECKOUT_INTENT_ID
    }
  };

  const res = createResponse();
  await referenceChargeHandler(req, res);
  return res;
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

async function sendUpsellIpn(
  customFields,
  {
    orderId = "800001",
    productId = "133573",
    amount = "57"
  } = {}
) {
  const body = {
    ORDER_ID: orderId,
    ORDER_STATUS: "Processed",
    ORDER_TOTAL_AMOUNT: amount,
    ORDER_CURRENCY_CODE: "USD",
    CUSTOMER_EMAIL: "buyer@example.com",
    CUSTOMER_FIRST_NAME: "Test",
    CUSTOMER_LAST_NAME: "Buyer",
    TEST_MODE: "1",
    IPN_TYPE_NAME: "OrderCharged",
    PRODUCT_ID: productId,
    ORDER_CUSTOM_FIELDS: customFields
  };

  body.SIGNATURE = signatureFor(body);

  const req = {
    method: "POST",
    headers: {},
    body
  };

  const res = createResponse();
  await webhookHandler(req, res);
  return res;
}

async function callManualCheckout(fallbackToken) {
  const req = {
    method: "POST",
    headers: {
      origin: "https://flexiblest.com",
      authorization: `Bearer ${ACCESS_TOKEN}`
    },
    body: {
      fallback_token: fallbackToken,
      fs_session_id: SESSION_ID,
      fs_checkout_intent_id: CHECKOUT_INTENT_ID
    }
  };

  const res = createResponse();
  await manualCheckoutHandler(req, res);
  return res;
}

async function testIpnAuthoritativeCharge() {
  resetState();

  payProResponse = {
    isSuccess: true,
    response: {
      orderId: 800001,
      orderStatusName: "Processed"
    }
  };

  const initial = await callReferenceCharge("charge");

  assert.equal(initial.statusCode, 202);
  assert.equal(initial.body.processing, true);
  assert.equal(initial.body.charged, false);
  assert.equal(payProCallCount, 1);

  const pendingStatus = await callReferenceCharge("status");
  assert.equal(pendingStatus.statusCode, 202);
  assert.equal(pendingStatus.body.processing, true);
  assert.equal(payProCallCount, 1);

  const webhook = await sendUpsellIpn(
    [
      `x-fs_session_id=${SESSION_ID}`,
      `x-fs_checkout_intent_id=${CHECKOUT_INTENT_ID}`,
      `x-root_order_id=${ROOT_ORDER_ID}`,
      "x-offer_step=upsell_fasttrack57"
    ].join("&")
  );

  assert.equal(webhook.statusCode, 200);
  assert.equal(webhook.body.secure_session_verified, true);
  assert.equal(webhook.body.charge_recovery_saved, true);

  const confirmedStatus = await callReferenceCharge("status");
  assert.equal(confirmedStatus.statusCode, 200);
  assert.equal(confirmedStatus.body.confirmed, true);
  assert.equal(confirmedStatus.body.charged, true);
  assert.equal(payProCallCount, 1);
}

async function testManualFallback() {
  resetState();

  payProResponse = {
    isSuccess: false,
    error:
      "PayPal billing agreement does not support reference charge"
  };

  const failedReferenceCharge =
    await callReferenceCharge("charge");

  assert.equal(failedReferenceCharge.statusCode, 200);
  assert.equal(failedReferenceCharge.body.fallback, true);
  assert.equal(
    typeof failedReferenceCharge.body.fallback_token,
    "string"
  );

  const fallbackToken =
    failedReferenceCharge.body.fallback_token;

  const manualCheckout =
    await callManualCheckout(fallbackToken);

  assert.equal(manualCheckout.statusCode, 200);
  assert.equal(manualCheckout.body.confirmed, false);
  assert.match(
    manualCheckout.body.checkout_url,
    /^https:\/\/store\.payproglobal\.com\/checkout\?/
  );
  assert.equal(
    manualCheckout.body.checkout_url.includes("buyer%40example.com"),
    false
  );
  assert.equal(
    manualCheckout.body.checkout_url.includes(SESSION_ID),
    false
  );
  assert.equal(
    manualCheckout.body.checkout_url.includes(ROOT_ORDER_ID),
    false
  );

  const webhook = await sendUpsellIpn(
    [
      `x-fallback_token=${fallbackToken}`,
      "x-offer_step=manual_upsell_fasttrack57"
    ].join("&")
  );

  assert.equal(webhook.statusCode, 200);
  assert.equal(webhook.body.secure_session_verified, true);

  const confirmedStatus = await callReferenceCharge("status");
  assert.equal(confirmedStatus.statusCode, 200);
  assert.equal(confirmedStatus.body.confirmed, true);
  assert.equal(confirmedStatus.body.charged, true);

  const repeatedWebhook = await sendUpsellIpn(
    [
      `x-fallback_token=${fallbackToken}`,
      "x-offer_step=manual_upsell_fasttrack57"
    ].join("&")
  );

  assert.equal(repeatedWebhook.statusCode, 200);
  assert.equal(
    repeatedWebhook.body.secure_session_verified,
    true
  );
}

async function testAmbiguousResponseCannotChargeTwice() {
  resetState();

  payProResponse = {
    response: {
      message: "The final API result is unavailable"
    }
  };

  const firstAttempt = await callReferenceCharge("charge");
  assert.equal(firstAttempt.statusCode, 202);
  assert.equal(firstAttempt.body.processing, true);
  assert.equal(firstAttempt.body.fallback, undefined);
  assert.equal(payProCallCount, 1);

  const secondAttempt = await callReferenceCharge("charge");
  assert.equal(secondAttempt.statusCode, 202);
  assert.equal(secondAttempt.body.processing, true);
  assert.equal(secondAttempt.body.fallback, undefined);
  assert.equal(payProCallCount, 1);

  const webhook = await sendUpsellIpn(
    [
      `x-fs_session_id=${SESSION_ID}`,
      `x-fs_checkout_intent_id=${CHECKOUT_INTENT_ID}`,
      `x-root_order_id=${ROOT_ORDER_ID}`,
      "x-offer_step=upsell_fasttrack57"
    ].join("&")
  );

  assert.equal(webhook.statusCode, 200);

  const resolvedStatus = await callReferenceCharge("status");
  assert.equal(resolvedStatus.statusCode, 200);
  assert.equal(resolvedStatus.body.confirmed, true);
  assert.equal(resolvedStatus.body.charged, true);
  assert.equal(payProCallCount, 1);
}

async function testFinalOfferUsesItsOwnOrder() {
  resetState();

  payProResponse = {
    isSuccess: false,
    error: "The stored payment method declined the new charge"
  };

  const failedReferenceCharge =
    await callReferenceCharge("charge", "fasttrack37");

  assert.equal(failedReferenceCharge.statusCode, 200);
  assert.equal(failedReferenceCharge.body.fallback, true);
  assert.equal(failedReferenceCharge.body.amount, 37);

  const fallbackToken =
    failedReferenceCharge.body.fallback_token;

  const manualCheckout =
    await callManualCheckout(fallbackToken);

  assert.equal(manualCheckout.statusCode, 200);
  assert.equal(manualCheckout.body.product_id, 133574);
  assert.equal(manualCheckout.body.amount, 37);
  assert.match(
    manualCheckout.body.checkout_url,
    /products%5B1%5D%5Bid%5D=133574/
  );

  const webhook = await sendUpsellIpn(
    [
      `x-fallback_token=${fallbackToken}`,
      "x-offer_step=manual_downsell_fasttrack37"
    ].join("&"),
    {
      orderId: "800037",
      productId: "133574",
      amount: "37"
    }
  );

  assert.equal(webhook.statusCode, 200);

  const confirmedStatus = await callReferenceCharge(
    "status",
    "fasttrack37"
  );

  assert.equal(confirmedStatus.statusCode, 200);
  assert.equal(confirmedStatus.body.confirmed, true);
  assert.equal(confirmedStatus.body.amount, 37);
  assert.equal(payProCallCount, 1);
}

await testIpnAuthoritativeCharge();
await testManualFallback();
await testAmbiguousResponseCannotChargeTwice();
await testFinalOfferUsesItsOwnOrder();

console.log("PayPro reliability simulations passed.");
