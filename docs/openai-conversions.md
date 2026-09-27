# OpenAI purchase integration

Adds an independent, main-checkout-only `order_created` sender. Meta/Cometly payload construction, PayPro payment APIs, redirects, Kajabi and financial reconciliation remain unchanged. Bumps are included in the main total; upsells have no OpenAI purchase emitter in this release.

## Data path

The current sales/checkout head bridges capture OpenAI attribution in separate `fs_openai_attribution_v1` storage and top-level `openai` request data. The checkout footer, initial text/plain request, existing late-save authentication, Cometly fields and PayPro query builder remain unchanged. No new script download, timer, browser purchase, or OpenAI network wait is added. First-party checkout-link decoration handles unavailable browser storage.

`allowed` follows the already-installed OpenAI pixel's default-enabled state, honoring explicit stored/queued denial and the optional `fsOpenAIMeasurementAllowed=false` site hook. This does not change the site's consent UI or establish legal consent. No new identifier types beyond click/browser reference, hashed buyer email and the existing valid browser IP/UA are collected for delivery. Withdrawal before delivery can be saved through an authenticated OpenAI-only action even after payment. It cannot recall an event already accepted by the provider or guarantee cancellation of a request concurrently in flight.

The existing authenticated main-order Redis transaction stores the original payment facts in the paid session and attempts a separate seven-day OpenAI job/queue write using `redis.pcall`. No extra network request is added to that handler. Secondary write errors cannot change its response. The worker can reconstruct a missing queue job from the paid session (72-hour recovery window). First delivery freezes the payload; retry cannot change the event ID, time, amount or currency. Remote duplicate acceptance uses the same OpenAI pixel/event/ID. Completion retains a minimal 400-day tombstone, deleting the job and its matching data. Jobs expire after seven days; stale events are never timestamped as new.

The worker runs every five minutes on Vercel Pro. It requires `CRON_SECRET`, uses owned 120-second leases, retries timeouts/429/5xx with backoff, and retries review/configuration failures hourly without recording delivery success. It records redacted aggregate health at `paypro:openai:v1:health`; Vercel errors use `OPENAI_QUEUE_RETRY_REQUIRED`. A health record is not an externally configured alert. Persistent store loss or a queue failure combined with more than 72 hours of worker outage requires PayPro reconciliation; automated full PayPro order-list reconciliation is not included. No exactly-once network guarantee is claimed.

## Production configuration

- `OPENAI_CONVERSIONS_API_KEY`: conversion key, production server secret only.
- `OPENAI_ADS_PIXEL_ID`: `A1Nsu2bZxSoHkyp7AgwtEu`.
- `OPENAI_ADS_MODE`: `validate`, then `live` after validation. Missing/other disables delivery.
- `CRON_SECRET`: random high-entropy production secret. Vercel attaches it as Bearer authentication to cron requests. Do not overwrite an existing cron secret used elsewhere.

`VERCEL_ENV` must equal `production`; preview deliveries are disabled even if other production integration credentials are shared by the existing project. The OpenAI key must never be copied to preview/browser code. No changes to pre-existing environment variables are required.

Authenticated `GET /api/openai-conversions-worker?validate_only=1` submits a fixed non-customer fixture with explicit `validate_only:true`, returns only acceptance/status, and never writes an event/job. Never remove the flag for this fixture. Ordinary worker requests process eligible real orders only. Validation mode does not mark real jobs sent.

## Verification and rollout

Run `node --test tests/*.test.mjs`. New tests cover eligibility, amounts, UTC time, hashing, consent, browser storage/link fallback and authentication. Separate workspace tests execute actual Lua with fakeredis/lupa, plus the real worker with that store and a mocked OpenAI sender, covering transient failures, duplicates, crash recovery, validation mode and preview gating.

Deploy backend first, configure production secrets, run protected validation-only check, then publish only the reviewed sales/checkout head edits. Compare exact saved/published blocks to backups; footer and sitewide tracking blocks must match. No synthetic purchase should be sent to production measurement. Observe a subsequent genuine paid order; API acceptance is not evidence of ad attribution. Page-speed measurement is deliberately deferred.

Rollback: set `OPENAI_ADS_MODE=disabled` and redeploy (stops delivery); restore the two backed-up page heads if needed. Original backend baseline: `729afd94d544e9a1d07b9e8ac081db61f4487c0a`. Keep rollback secrets private. Existing PayPro/Cometly delivery does not depend on the OpenAI worker.
