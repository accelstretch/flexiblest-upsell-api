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

  if(script.includes('session["status"] = "paid"')) {
    const session = parseJson(redis.get(key));
    if (!session) return "MISSING";
    if (session.fs_checkout_intent_id !== args[1]) return "INTENT_MISMATCH";
    Object.assign(session, {status:"paid", checkout_completed:true, paypro_root_order_id:args[2], customer_email:args[4], amount:Number(args[9])});
    redis.set(key, JSON.stringify(session)); return JSON.stringify(session);
  }
  throw new Error("Unsupported Redis script");
}

for (const [key,id] of [["ACCELSTRETCH","2151012544"],["ROUTINE_QUICK_SHEETS","2151278593"],["LEAN_LIGHT","2151038529"],["ADVANCED_FAST_TRACK","2150621466"],["FAST_TRACK_CORE","2148399198"]]) process.env[`KAJABI_${key}_ACTIVATION_URL`] = `https://checkout.kajabi.com/webhooks/offers/${id}/secret/activate`;
const captured = [];
let cometStatus = 200;
let cometBody = "{}";
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

  if(String(url) === "https://app.cometly.com/public-api/v1/events/track") {
    captured.push(JSON.parse(options.body));
    return new Response(cometBody, {status:cometStatus});
  }
  if (String(url).startsWith("https://checkout.kajabi.com/webhooks/offers/")) return new Response("{}",{status:200});
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



// All network calls above are mocked; no real purchases or conversions.
for (const [offer,product,amount] of [["upsell_fasttrack57","133573","57"],["downsell_fasttrack37","133574","37"]]) {
  for (const format of ["ampersand", "comma", "encoded-comma", "object"]) {
    resetState(); captured.length=0;
    delete process.env.COMETLY_TEST_ORDER_IDS;
    const fields={processor:"paypro",funnel_id:"accelstretch_paypro_flow",offer_step:offer,fs_session_id:SESSION_ID,fs_checkout_intent_id:CHECKOUT_INTENT_ID,root_order_id:ROOT_ORDER_ID,source_product:"accelstretch"};
    let custom=Object.entries(fields).map(([k,v])=>`${k}=${v}`).join(format==="ampersand"?"&":",");
    if(format==="encoded-comma") custom=encodeURIComponent(custom);
    if(format==="object") custom=fields;
    const r=await sendUpsellIpn(custom,{productId:product,amount});
    assert.equal(r.body.secure_session_verified,true,`${offer}/${format}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.sent_to_cometly,false);
    assert.equal(captured.length,0);
    const status=await callReferenceCharge("status",amount==="57"?"fasttrack57":"fasttrack37");
    assert.equal(status.body.confirmed,true);
    assert.equal(status.body.amount,Number(amount));
    process.env.COMETLY_API_KEY="mock-cometly-key";
    process.env.COMETLY_TEST_ORDER_IDS="800001";
    const diagnostic=await sendUpsellIpn(custom,{productId:product,amount});
    assert.equal(diagnostic.body.sent_to_cometly,true);
    assert.equal(captured.length,1);
    assert.equal(captured[0].amount,0);
    assert.equal(captured[0].do_not_capi,true);
    assert.equal(captured[0].event_name,"custom_event_1");
    assert.match(captured[0].order_id,/^paypro-test-/);
    await sendUpsellIpn(custom,{productId:product,amount});
    assert.equal(captured.length,1,"diagnostic replay must deduplicate");
  }
}
delete process.env.COMETLY_TEST_ORDER_IDS;
resetState();
const missing=await sendUpsellIpn("",{productId:"133573"});
assert.equal(missing.body.reason,"secure_session_rejected","unknown metadata must not be treated as a bump");
console.log("PayPro upsell/downsell parsing and safe diagnostic regressions passed.");
