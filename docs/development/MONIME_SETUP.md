# Monime Integration Setup — User Action Checklist

This document is for the PlayLe project owner, not for an automated
implementation step. It tracks what **you** need to do outside this
codebase before PlayLe can accept a real Monime deposit or send a real
Monime payout. See
[ADR-019](../decisions/ADR-019-production-payments.md) for the resulting
architecture and
[docs/development/PHASE_6_CHECKLIST.md](PHASE_6_CHECKLIST.md) §0 for the
full verified-facts table with sources.

**Phase 3 → Phase 6 update**: as of Phase 3, no official Monime developer
documentation was reachable, so `MonimeProvider` was a deliberately inert
stub. For Phase 6, `docs.monime.io` (current API version
`caph-2025-08-23`) and the official `monimesl/monime-developer-apis`
GitHub repository's OpenAPI spec were fetched directly and verified. The
real integration (Payment Codes for deposits, Payouts for withdrawals,
status polling) is now implemented. **Webhook signatures are now verified**
(2026-11-27) using Monime's documented scheme; see action 3.

## Owner actions required

### 1. Confirm PlayLe's business model is eligible

Payment aggregators in many markets restrict or specially-license
gaming/gambling-adjacent merchants. `VERIFY WITH MONIME` (contact their
support/sales): whether a real-money competitive-gaming platform
(stakes + prize pool + platform fee) is a permitted use case, whether
PlayLe's age-gate model is compatible with Monime's own merchant
eligibility rules, and whether payout (not just collection) is available
to PlayLe's merchant category. **If Monime's terms don't permit this use
case, that is a legal/business blocker independent of anything this
codebase can fix.**

### 2. Create a Monime Space and a test Personal Access Token

Sign in at the Monime dashboard and create a **Space** (you'll get a
`spc-...` id — this is the `Monime-Space-Id` header value every API call
requires). Generate a **Personal Access Token** — a test token is
prefixed `mon_test_...` and is safe to use immediately; PlayLe's
`MonimeProvider` always permits a test token to make real calls against
Monime's test environment (no separate "enable live" flag needed for
test tokens — see ADR-019 "production activation guardrails"). A
**live** token (`mon_...`, no `_test_`) additionally requires setting
`MONIME_LIVE_PAYMENTS_ENABLED=true` before PlayLe will use it for a real
call — do not set that until you intend to go live.

Put these in `apps/api/.env` (never committed):

```
PAYMENTS_PROVIDER=monime
MONIME_API_KEY=mon_test_...         # or mon_... once genuinely ready for live
MONIME_SPACE_ID=spc_...
MONIME_BASE_URL=https://api.monime.io   # same URL for test and live — the token decides
MONIME_LIVE_PAYMENTS_ENABLED=false  # only "true" once you mean to go live
```

### 3. Create the Test webhook and set its secret

PlayLe verifies Monime's documented signature: header
`Monime-Signature: t=<unix seconds>,v1=<base64>`, where the value is
HMAC-SHA256, keyed with the webhook's secret, over `<t>_<raw body>`
(underscore), rejected if `t` is over 300 s old or over 60 s ahead. Sources:
docs.monime.io "Webhooks > HMAC verification" and Monime's own
`monimesl/MonimeGateway_odoo` (`utils/webhook_validation.py`).

In the Monime dashboard, Test mode, Developer > Webhooks > Create webhook:
- URL: `https://<public API host>/api/v1/payments/webhooks/monime` (HTTPS,
  publicly reachable; `localhost` is refused).
- API release `caph`; verification method **HMAC (HS256)**, not ECDSA.
- Events: `payment_code.completed`, `payment_code.expired`,
  `payment_code.processed`, `payout.completed`, `payout.failed`.
- Keep the generated secret (32-100 characters) and put it in the API's
  secret settings as `MONIME_WEBHOOK_SECRET`. Never commit it or paste it
  into chat.

**Still to confirm with the first real Test delivery**: Monime's documented
caph `payment_code.completed` sample carries only the code's configured
`data.amount`, not the amount paid. PlayLe credits only on a paid amount
(`progress.totalPaymentSum`, `processedPaymentData.amount` or
`paymentData.amount`), so a completion shaped like that sample is stored
(IGNORED, with its full body) and reported as `ORPHAN_PROVIDER_EVENT`
instead of being credited. Inspect the stored event, then map the real
paid-amount field.

### 4. Confirm Payment Codes vs. Checkout Sessions

PlayLe implements **Payment Codes** (a USSD code the customer dials — no
redirect), matching a native mobile app with no in-app browser payment
flow. Checkout Sessions (hosted redirect) is Monime's other deposit
mechanism, left unimplemented as a documented future option. Confirm
this matches your intended product UX before relying on it for real
traffic.

### 5. Confirm the payout destination field names with one real test payout

The current `caph-2025-08-23` docs page and the matching OpenAPI spec
show `destination: { type, providerId, ...type-specific field }` (e.g.
`momo` + `providerId: 'm17'|'m18'` + `phoneNumber`, or `bank` +
`providerId: 'slb001'|'slb004'|'slb007'` + `accountNumber`). An older
`2024-08-01` spec version showed different field names
(`providerCode`/`accountId`). PlayLe implements the current shape as
authoritative; confirm it with one real **test** payout before any live
use. `MonimeProvider` only maps a payout destination it recognizes
exactly (plus one legacy convenience mapping, `{method: 'ORANGE_MONEY',
phoneNumber}` → `m17`, the one provider id Monime's own docs describe —
"Orange Money SL") — any other destination shape is refused
(`UNAVAILABLE`), never guessed.

### 6. Decide the real-money eligibility policy

Separate from Monime itself — see
[ADR-021](../decisions/ADR-021-eligibility-and-responsible-gaming.md).
`REAL_MONEY_GAMING_ENABLED` and `ELIGIBILITY_POLICY_CONFIGURED` both stay
`false` in any real deployment until you've determined (with real legal
advice) the actual minimum age, jurisdiction restrictions, and any KYC
requirements, and set `REAL_MONEY_MINIMUM_AGE` accordingly.

### 7. Supply email/SMS delivery credentials (or confirm none exist yet)

Password-reset and verification codes are currently delivered only via
`FakeDeliveryAdapter` (logs + in-memory record, never a real send) — see
`src/notifications/`. No real email/SMS provider is integrated. If/when
you have credentials for one, a new `DeliveryPort` implementation is the
only code change needed (same provider-abstraction pattern as
payments).

## What's confirmed vs. not (verified during Phase 6)

**Confirmed** (fetched directly from `docs.monime.io` and the official
OpenAPI spec): auth headers (`Authorization: Bearer <token>` +
`Monime-Space-Id`), token format (`mon_...` live, `mon_test_...` test,
same base URL for both), `Idempotency-Key` semantics, the Payment Code
and Payout request/response schemas (field names, types, enums),
confirmed webhook event names (`payment_code.created/expired/processed/completed`,
`payout.failed/completed/delayed`), and the webhook signature algorithm
(HMAC-SHA256).

**Not confirmed** (see owner actions above): business-model eligibility,
the exact HMAC canonical string, and whether the payout destination
field names are stable across the API version used in production.

## Legal/Compliance Reminder

This document only covers the Monime integration. It does not constitute
legal clearance to launch real-money gaming in Sierra Leone. Separately
verify, before production launch: Sierra Leone financial/payment
regulation, gaming/betting regulation, age-of-majority/consumer-protection
law, AML/KYC obligations, tax obligations, and data-privacy law. None of
these have been assessed by this implementation.
