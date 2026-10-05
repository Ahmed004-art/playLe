# Monime Integration Setup — User Action Checklist

This document is for the PlayLe project owner, not for an automated
implementation step. It tracks what **you** need to do outside this
codebase before PlayLe can accept a real Monime deposit or send a real
Monime payout. See
[ADR-013](../decisions/ADR-013-payment-provider-abstraction.md) for why
the codebase itself cannot go further than it has.

**What's confirmed vs. not**: Monime is a real Sierra Leonean payment
aggregator — public sources describe it as unifying Orange Money,
Afrimoney, and Visa debit card payments behind one interface, with
payout to a local bank account, positioned as a Stripe/PayPal-equivalent
for Sierra Leone. No official developer documentation, API reference, or
signup/onboarding page was publicly findable at the time this was
written. **Every item below that isn't one of those confirmed facts is
marked `VERIFY WITH MONIME`** — do not treat it as settled until you've
confirmed it directly with Monime.

## PHASE A — No account required yet

Nothing to do yet. The codebase already has a working provider
abstraction (`ManualProvider`) that doesn't depend on Monime, so
development/testing is not blocked on any of the steps below.

## PHASE B — Create a Monime account

- `VERIFY WITH MONIME`: Where to sign up (their own website/app — no
  public developer portal URL was found). Whether a personal account is
  separate from a merchant/business account.

## PHASE C — Complete merchant/business verification

- `VERIFY WITH MONIME`: What business documents are required (business
  registration, tax ID, proof of address, director ID, etc. — standard
  for Sierra Leone payment aggregators, but not confirmed for Monime
  specifically).
- `VERIFY WITH MONIME`: Typical verification turnaround time.

## PHASE D — Confirm PlayLe's eligibility

Do not assume any of the following are automatically true — each is a
real business-model question only Monime can answer:

- `VERIFY WITH MONIME`: Whether a real-money **competitive gaming**
  platform (stakes + prize pool + platform fee) is a permitted use case
  under Monime's merchant terms. Payment aggregators in many markets
  restrict or specially-license gaming/gambling-adjacent merchants.
- `VERIFY WITH MONIME`: Whether PlayLe's **16+ age minimum** (rather than
  18+/21+) is compatible with Monime's own merchant eligibility rules —
  payment processors sometimes impose their own age floors independent
  of the merchant's.
- `VERIFY WITH MONIME`: Whether payout (not just collection) is available
  to PlayLe's merchant category, and under what conditions.

**If Monime's terms don't permit this use case, that is a legal/business
blocker independent of anything this codebase can fix — resolve this
before investing further integration effort.**

## PHASE E — Obtain sandbox/test credentials

- `VERIFY WITH MONIME`: Whether a sandbox/test environment exists
  separately from production, and how it's requested.
- `VERIFY WITH MONIME`: The exact credential names/types issued (API key,
  secret, merchant ID, etc.).

## PHASE F — Configure local environment variables

Once real credential names are confirmed (Phase E), they go in
`apps/api/.env` (never committed — see `.gitignore` and
`docs/architecture/SECURITY.md`):

```
PAYMENTS_PROVIDER=monime
MONIME_API_KEY=<sandbox key — VERIFY WITH MONIME this is the right field>
MONIME_WEBHOOK_SECRET=<VERIFY WITH MONIME this is the right field>
```

These two variable names are PlayLe's own placeholders (`apps/api/src/config/`)
— **not confirmed Monime field names**. Adjust them once Monime's actual
credential shape is known; this is a config-only change, not a
code-architecture change.

**Never commit real credentials.** Sandbox and production credentials
must be different values in different, never-committed `.env` files.

## PHASE G — Configure the webhook endpoint

PlayLe's webhook receiver already exists:
`POST /payments/webhooks/monime` (see `src/deposits/webhooks.controller.ts`).

- `VERIFY WITH MONIME`: Where/how you register this URL with Monime (a
  dashboard field, an API call, etc.).
- `VERIFY WITH MONIME`: The exact webhook signature scheme (header name,
  hashing algorithm, what's hashed) — `MonimeProvider.verifyWebhookSignature`
  currently **always rejects** every delivery until this is implemented
  against confirmed documentation. This is intentional — see ADR-013.
- You will need a publicly reachable HTTPS URL for this endpoint before
  Monime can deliver webhooks — not available on a local development
  machine without a tunneling tool (e.g. ngrok) or a deployed staging
  environment, neither of which exists yet in this project.

## PHASE H — Test deposits

Blocked until Phases B–G are complete. Once they are, the integration
work remaining in the codebase is:
1. Implement `MonimeProvider.initiateDeposit` against the confirmed
   request/response shape.
2. Implement `MonimeProvider.verifyWebhookSignature` against the
   confirmed signature scheme.
3. Add e2e coverage exercising the real sandbox (not just the existing
   `FakePaymentProvider`-based tests).

## PHASE I — Test payouts

- `VERIFY WITH MONIME`: Whether payout/withdrawal is a separate API
  surface from deposits, and what its request/response/status-callback
  shape is.
- Blocked until Phase D confirms payout eligibility and Phase E provides
  credentials with payout scope.

## PHASE J — Production onboarding

- `VERIFY WITH MONIME`: Fees, transaction limits (minimum/maximum per
  transaction, daily/monthly caps), and settlement timing for production.
- `VERIFY WITH MONIME`: Any additional security/compliance requirements
  for going live (e.g. PCI-adjacent requirements, additional KYC on
  PlayLe as a merchant).
- Confirm the items in
  "[Legal/Compliance](#legal-compliance-reminder)" below are separately
  resolved — Monime eligibility and PlayLe's own regulatory compliance
  are two different gates, both required.

## What payment methods are available in Sierra Leone (confirmed, general)

Public sources describe Monime as aggregating **Orange Money**,
**Afrimoney**, and **Visa debit cards** for collection, with payout to a
**local bank account**. `VERIFY WITH MONIME` whether this list is
complete/current and which of these (if any) are available to PlayLe's
specific merchant category.

## Legal/Compliance Reminder

This document only covers the Monime integration. It does not constitute
legal clearance to launch real-money gaming in Sierra Leone. Separately
verify, before production launch: Sierra Leone financial/payment
regulation, gaming/betting regulation, age-of-majority/consumer-protection
law, AML/KYC obligations, tax obligations, and data-privacy law. None of
these have been assessed by this implementation.
