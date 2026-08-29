import crypto from "node:crypto";

const COMETLY_API_URL =
  "https://app.cometly.com/public-api/v1/events/track";

const TEST_EMAIL = "cometly-server-test@example.com";
const TEST_URL = "https://flexiblest.com/secure-checkout";

function clean(value, maxLength = 500) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

function getConfiguredEventName() {
  return (
    clean(process.env.COMETLY_UPSELL_EVENT_NAME, 100) ||
    "custom_event_1"
  );
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  const configuredTestKey = clean(
    process.env.COMETLY_SERVER_TEST_KEY,
    400
  );

  // The route is disabled until a separate Vercel environment secret exists.
  // Never accept the secret, event data, or customer data in the URL or body.
  if (!configuredTestKey) {
    return res.status(404).json({
      ok: false,
      error: "Not found"
    });
  }

  if (!safeEqual(getBearerToken(req), configuredTestKey)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  const apiKey = clean(process.env.COMETLY_API_KEY, 4000);

  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      error: "Cometly API is not configured"
    });
  }

  const testId = `cometly-server-test-${crypto.randomUUID()}`;
  const event = {
    event_name: getConfiguredEventName(),
    email: TEST_EMAIL,
    first_name: "Cometly",
    last_name: "Server Test",
    event_time: new Date().toISOString(),
    url: TEST_URL,
    amount: 0,
    currency: "USD",
    order_id: testId,
    tracking_id: testId,
    idempotency_key: testId,
    profile_field_1: "server_test",
    profile_field_2: "accelstretch_paypro_flow",
    profile_field_3: "upsell_test"
  };

  try {
    const response = await fetch(COMETLY_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(event)
    });

    if (!response.ok) {
      console.error("COMETLY SERVER TEST REJECTED", {
        status: response.status,
        event_name: event.event_name,
        order_id: event.order_id
      });

      return res.status(502).json({
        ok: false,
        error: "Cometly rejected the test event"
      });
    }

    return res.status(200).json({
      ok: true,
      sent_to_cometly: true,
      event_name: event.event_name,
      test_id: testId
    });
  } catch (error) {
    console.error(
      "COMETLY SERVER TEST FAILED",
      error instanceof Error ? error.message : "Unknown error"
    );

    return res.status(502).json({
      ok: false,
      error: "Unable to reach Cometly"
    });
  }
}
