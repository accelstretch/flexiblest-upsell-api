# PayPro purchase attribution repair — 2026-09-19

Production baseline: fa533722246eeb931c5a2394ef3b6ab1f5c1db27 (financial reporting retained).

## Changes
- Remove fbclid fallback for comet_ad_id. For Meta sources, only numeric canonical/explicit ad_id candidates qualify; malformed canonical values do not mask valid aliases. Never infer an ad ID from an arbitrary utm_term.
- Preserve fbclid/fbc/fbp in existing profile fields 10/11/12. Order amounts, currencies, product and customer data, event types, timestamps and idempotency logic are unchanged.
- Accept fingerprint alias and skip blank alias values in funnel-session attribution sanitization.
- Add authenticated save_attribution action, using existing atomic session update, rejecting paid sessions, and preserving email/names. No new endpoint or public diagnostic endpoint.
- Update only the existing attribution bridge in the sales and secure-checkout page heads. Use installed pixel cometToken() and async cometFingerprint(); refresh before session requests, event calls, and insertion of new PayPro iframes. Save late pixel data into the secure session without reloading an active payment iframe. Session identifiers remain in sessionStorage; access tokens are never added to PayPro URLs.
- Keep complete iframe URLs instead of truncating them at 2000 characters.

## Verification
24 Node tests pass (existing suites plus nine attribution checks). Browser-script simulations cover delayed pixel readiness, PayPro custom fields, mounted iframe protection, long URL preservation. Backend checks cover canonical and malformed ad IDs, separate Meta identifiers, session and webhook fingerprint aliases, authentication, paid-session rejection, purchase/upsell amount and deduplication fields.
`attribution-test-payload.json` is a locally generated synthetic fixture, not a delivered sale or conversion.

Webflow before/after head blocks and extracted test scripts are under webflow/. Only bridge blocks differ. Existing checkout footer and upsell pages are not modified.

## Limits
Previously delivered order 44388243 is not replayed or modified. Missing historical visitor identifiers cannot be fabricated. Browser blocking or unavailable pixel identifiers can still leave them absent. Live Cometly attribution/Meta reporting requires a subsequent genuine purchase or a separately authorized test-order workflow.

## Primary documentation
- https://help.cometly.com/en/articles/8029516-setup-url-parameters-for-all-channels
- https://help.cometly.com/en/articles/8216068-zoho-forms-form-tracking
