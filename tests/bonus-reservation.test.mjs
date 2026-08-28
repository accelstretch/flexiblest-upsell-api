import assert from "node:assert/strict";

import bonusReservationHandler from "../api/bonus-reservation.js";

process.env.KV_REST_API_URL = "https://redis.test";
process.env.KV_REST_API_TOKEN = "redis-token";

const redis = new Map();

function handleRedisCommand(command) {
  const operation = String(command[0] || "").toUpperCase();
  const key = command[1];

  if (operation === "GET") {
    return redis.has(key) ? redis.get(key) : null;
  }

  if (operation === "SET") {
    const options = command.slice(3).map(String);

    if (
      options.some((option) => option.toUpperCase() === "NX") &&
      redis.has(key)
    ) {
      return null;
    }

    redis.set(key, command[2]);
    return "OK";
  }

  if (operation === "EXPIRE") {
    return redis.has(key) ? 1 : 0;
  }

  throw new Error(`Unsupported Redis operation: ${operation}`);
}

global.fetch = async function mockFetch(url, options = {}) {
  assert.equal(String(url), process.env.KV_REST_API_URL);

  const result = handleRedisCommand(JSON.parse(options.body));

  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};

function createResponse() {
  const headers = new Map();

  return {
    statusCode: 0,
    body: null,
    headers,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    end(value = "") {
      this.body = value ? JSON.parse(value) : null;
    }
  };
}

async function callHandler({ method = "GET", body = null, cookie = "", authorization = "" } = {}) {
  const req = {
    method,
    body,
    headers: {
      origin: "https://flexiblest.com",
      cookie,
      authorization
    }
  };
  const res = createResponse();

  await bonusReservationHandler(req, res);

  return res;
}

function cookiePair(setCookie) {
  return String(setCookie || "").split(";", 1)[0];
}

async function testLegacyPagesShareAndRenewOneReservation() {
  redis.clear();

  const salesPage = await callHandler();

  assert.equal(salesPage.statusCode, 200);
  assert.equal(
    salesPage.headers.get("access-control-allow-origin"),
    "https://flexiblest.com"
  );
  assert.equal(
    salesPage.headers.get("access-control-allow-credentials"),
    "true"
  );
  assert.match(salesPage.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  assert.match(salesPage.body.reservation_id, /^br_[a-f0-9]{32}$/);
  assert.equal(salesPage.body.status, "active");
  assert.equal(salesPage.body.expires_at, salesPage.body.expires_at_ms);

  const cookie = cookiePair(salesPage.headers.get("set-cookie"));
  const checkoutPage = await callHandler({ cookie });

  assert.equal(checkoutPage.statusCode, 200);
  assert.equal(checkoutPage.body.reservation_id, salesPage.body.reservation_id);
  assert.equal(checkoutPage.body.deadline_at, salesPage.body.deadline_at);

  const activeRenew = await callHandler({
    method: "POST",
    body: { action: "renew", duration_seconds: 86400 },
    cookie
  });

  assert.equal(activeRenew.statusCode, 200);
  assert.equal(activeRenew.body.deadline_at, salesPage.body.deadline_at);
  assert.equal(activeRenew.body.renewed, false);

  const key = `bonus:reservation:${salesPage.body.reservation_id}`;
  const expiredRecord = JSON.parse(redis.get(key));
  expiredRecord.deadline_at = new Date(Date.now() - 1000).toISOString();
  redis.set(key, JSON.stringify(expiredRecord));

  const restartedSalesPage = await callHandler({ cookie });

  assert.equal(restartedSalesPage.statusCode, 200);
  assert.equal(restartedSalesPage.body.reservation_id, salesPage.body.reservation_id);
  assert.equal(restartedSalesPage.body.cycle_number, 2);
  assert.equal(restartedSalesPage.body.renewed, true);
  assert.ok(restartedSalesPage.body.expires_at_ms > Date.now());
}

async function testBearerClientStillWorks() {
  redis.clear();

  const created = await callHandler({
    method: "POST",
    body: { action: "create" }
  });

  assert.equal(created.statusCode, 201);
  assert.match(created.body.access_token, /^[A-Za-z0-9_-]{20,512}$/);

  const status = await callHandler({
    method: "POST",
    body: {
      action: "status",
      reservation_id: created.body.reservation_id
    },
    authorization: `Bearer ${created.body.access_token}`
  });

  assert.equal(status.statusCode, 200);
  assert.equal(status.body.reservation_id, created.body.reservation_id);
  assert.equal(status.body.deadline_at, created.body.deadline_at);
}

await testLegacyPagesShareAndRenewOneReservation();
await testBearerClientStillWorks();

console.log("Bonus reservation synchronization simulations passed.");
