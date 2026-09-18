# PayPro actual order contribution

## What is recorded

The existing authenticated payment handler runs first. After a successful
response, the financial reporter reads GetOrderDetails using existing PayPro
credentials. It records the change in balanceVendorTotalAmount in USD against
its durable previous balance. This avoids assumptions about cumulative refund
IPN fields and already includes the processor commission retained after refund.
Order-item balances must agree with the order balance.

Positive changes use custom_event_2 (PayPro Net Earnings Increases); negative
changes use custom_event_3 (PayPro Net Earnings Decreases). Exclude both from
Gross Revenue and standard-event mappings. Each payload uses do_not_capi:true.
No checkout price, purchase event body, CAPI mapping, PayPro routing or Kajabi
access logic is changed. Original response codes/headers are retained, except
that a financial failure after successful fulfillment returns 503 for PayPro
retry. Existing purchase/fulfillment deduplication remains in place.

## Scope and interpretation

Applies to new qualifying orders created from 2026-09-18 19:00 UTC and received
after deployment; older orders are not backfilled. The five allowlisted product
IDs define the AccelStretch funnel. Mixed/unrelated orders are held.

Actual order contribution = earnings increase value - earnings decrease value
- advertising spend. Payout fees, fixed business overhead and future refunds
are not included. Do not call this complete business net profit.

A first unrefunded sale uses its order creation timestamp. Later changes use
the time recognized by the financial reporter, not a verified PayPro transaction
timestamp. LTV/ad attribution is Cometly's existing customer attribution, and
must be reconciled against source orders before scaling. A daily cash-flow
report and an acquisition-cohort report are different views.

The snapshot API was read directly for a sale with bump (net 38.07 USD), a
refunded main order (net -2.21 USD) and a refunded upsell (net -3.53 USD). All
matched the PayPro UI/Transactions report. This proves source-field meaning for
those records; live delivery/attribution and a real dispute still require checks.

## Reliability and limitations

Per-order leases serialize concurrent notifications. A pending event is stored
before sending, with a permanent idempotency key and timestamp; retries replay
that same event. A new snapshot is read only after any pending delivery finishes.
Repeated snapshots create no additional financial amount.

Financial failures are logged as PAYPRO FINANCIAL RECONCILIATION REQUIRED and
request a PayPro retry. PayPro retries are finite: inspect failed IPNs and retry
unresolved orders using the dedicated financial endpoint, so purchase/access
side effects do not need to run again. A stale API snapshot on a partial-refund
notification can require a later reconciliation; verify the first partial refund
and repeated partial refunds explicitly. There is no scheduled reconciliation
job in this release. Account payout fees remain separate.

## How to check after launch

1. Check the first 3-5 real paid orders, including a bump and upsell if purchased.
   PayPro net revenue for each order must equal the sum of Cometly earnings
   increases minus decreases for that order. Initial purchase count remains one;
   bumps must not add initial purchases. Every separate upsell order contributes
   its actual net earnings.
2. In Cometly Events Log, financial order names contain the original PayPro
   order ID. Confirm the customer/campaign attribution as well as the amount.
3. On a real refund, compare the decrease with the actual PayPro balance debit.
   After full refund, retained processing fees remain a loss. For two equal
   partial refunds, each debit must appear once. Do not manufacture a refund
   just to test reporting.
4. Check the first real chargeback and win against PayPro's transaction rows,
   including its nonrefundable 15 USD fee. Escalate any mismatch.
5. Compare a launch-to-date period in USD, using the same included orders and
   account IDs. Subtract advertising once. Account-wide payout fees are a
   separate expense; transferred payouts themselves are not an expense.
6. Inspect PayPro Reports > Others > IPN for failed deliveries. A successful IPN
   plus correct financial events is the initial acceptance check. Do not assume
   campaign totals alone prove completeness or attribution.

## Diagnostics and rollback

POST /api/paypro-financials accepts valid PayPro-signed bodies. With the JSON
boolean financial_dry_run:true it reads the order and returns only order ID,
net earnings, refunded amount and status; it sends no Cometly event. Ordinary
signed notifications reconcile only finances. GET is not allowed.

To stop reporting while preserving original processing, revert the wrapper
around purchaseHandler in api/paypro-webhook.js. Preserve Redis ledger keys
paypro:net:v2:* to prevent duplicate financial events after resuming. Do not
reset Cometly event slots or delete original purchase history.
