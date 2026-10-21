# ADR-019: Production Payment Integration (Monime), Webhooks & Reconciliation

## Status
Accepted — Phase 6 (real deposit/payout integration implemented against
verified Monime documentation; webhook *signature verification* remains
fail-closed pending one unverifiable fact — see "Open/Unverified" below)

## Context

ADR-013 (Phase 3) left `MonimeProvider` deliberately inert because no
official Monime documentation was reachable at the time. For Phase 6,
direct fetches of `docs.monime.io` (current API version `caph-2025-08-23`)
and the official `monimesl/monime-developer-apis` GitHub repository's
OpenAPI spec produced verified facts. See
`docs/development/PHASE_6_CHECKLIST.md` §0 for the complete table and its
sources, with dates. This ADR records the resulting architecture; it does
not re-derive the facts themselves.

## Decision

### Deposits: Payment Codes, not Checkout Sessions
Monime offers two deposit mechanisms: Checkout Sessions (hosted redirect,
web-oriented) and Payment Codes (a USSD code the customer dials — no
redirect). PlayLe is a native mobile app with no in-app browser flow for
payments, so **Payment Codes** (`POST /v1/payment-codes`) is the
implemented mechanism. Checkout Sessions is left unimplemented as a
documented future option, not a gap — see checklist item 2.

### Payouts: the existing Withdrawal state machine, extended
Per the Phase 6 spec's explicit instruction, no second balance-changing
service was introduced. `WithdrawalsService.approve()` now calls a new
`submitPayout()` immediately after the review transition — the same
"create the row, then call the provider as a separate, non-transactional
step" pattern `DepositsService.create()` already used for deposits. A new
`WithdrawalStatus.PROCESSING` sits between `APPROVED` and the terminal
states while a live payout is in flight.

### The provider port grew, not replaced
`PaymentProviderPort` (ADR-013) gained `initiatePayout`,
`checkPayoutStatus`, and `checkDepositStatus` alongside the existing
`initiateDeposit`/`verifyWebhookSignature`. Every outbound call now
carries a `providerIdempotencyKey`, minted once and persisted on a new
`ProviderOperation` row — a retry of the *same* PlayLe-side attempt
reuses that key rather than minting a fresh one, so Monime's own
idempotency guarantee (verified: `Idempotency-Key` header, 24h fast path,
indefinite dedup, `409 idempotency_key_in_use` on a body-mismatched
retry) actually does its job.

### The exactly-once-money rule: never retry a payout with a new key
A network error during payout submission means the real-world outcome is
genuinely unknown — the request may have reached Monime before the
connection dropped. `WithdrawalsService.submitPayout()` catches this,
records the `ProviderOperation` as `UNKNOWN`, and moves the withdrawal to
`PROCESSING` — **never** back to `APPROVED` for a fresh retry with a new
idempotency key. Resolution is only ever: (a) a webhook arrives later and
resolves it normally, (b) `checkPayoutStatus` is used to query the
provider about *that exact operation*, or (c) an admin resolves it by
hand after reconciling out-of-band — `WithdrawalsService.complete`/`fail`
now also accept the `PROCESSING` state for exactly this case, still
mandatory-reason, still audited, never a "just mark it paid" shortcut.

### Webhook routing without a double-insert race
A single endpoint (`POST /payments/webhooks/monime`) receives both
deposit and payout events. The controller calls
`provider.verifyWebhookSignature` once to classify the event (by the
abstract `eventType` prefix, `deposit.*` vs `payout.*`), then dispatches
to exactly one of `DepositsService.processProviderWebhook`/
`WithdrawalsService.processProviderWebhook` — each of which
independently re-verifies and persists its own `ProviderEvent` row.
Dispatching to only one avoids a race where both services could attempt
to insert the same `(provider, providerEventId)` row and the "loser"
would be wrongly treated as a duplicate.

### Completion events: the reported amount and currency must match (amendment)
A deposit is always credited with its own **stored** amount, never a value
taken from an event. So a verified `deposit.completed` event for a different
amount or currency would still credit the full stored amount for money that
was never paid. `WebhookDepositPayload` therefore has two optional fields,
which a provider that reports what was paid sets, always together:

- `amountMinor` — the **paid** amount (not the amount a payment was
  configured for) as a canonical non-negative decimal-integer **string** of
  minor units (`^(0|[1-9][0-9]*)$`). Never a JS number: a number cannot
  represent every amount, and a `BigInt` is not JSON-safe in the stored
  event payload. It is validated as a string before any `BigInt` conversion.
- `currency` — an upper-case 3-letter ISO code.

`DepositsService.processProviderWebhook` checks them **before** claiming or
crediting. Neither field present is a provider that does not report them
(unchanged behaviour: fake/manual providers). Otherwise both must be present,
well-formed, and equal to the deposit's `amountMinor` and `currency`. On any
failure — malformed, only one field, or a mismatch — the event is stored as
`REJECTED` and linked to the deposit, and the deposit is left exactly as it
was: `PENDING`, not claimed, not `FAILED`, no ledger credit, no notification,
no automatic refund. Because nothing is consumed, a later valid completion
event (a different provider event id) still completes it exactly once through
the existing conditional claim. Replaying the same event id, rejected or not,
is stopped at the unique `(provider, providerEventId)` index and changes
nothing further. Failed and expired events carry no amount requirement.

Operators find a rejected completion through
`PaymentReconciliationService.findRejectedCompletions`, which reports a
`REJECTED` `deposit.completed` event on a not-yet-`COMPLETED` deposit as an
`AMOUNT_MISMATCH` anomaly (an existing, previously unused
`PaymentAnomalyType` — no migration), once per deposit. It stops being
reported when a later valid event completes the deposit. A real payment that
was rejected is **not** credited automatically: an operator must reconcile it
with the provider.

### Payment reconciliation — a new, separate concern
`PaymentReconciliationService` (`src/payments/`) is explicitly distinct
from `settlement/reconciliation.service.ts` (Phase 5's match-financial
reconciliation, which never touches provider state). It runs ten
read-only checks (deposit credited without confirmation, deposit
confirmed not credited, rejected completion events — the amendment above —
withdrawal paid not completed, withdrawal
completed without confirmation, duplicate provider reference, stuck
`PROCESSING`, `UNKNOWN` payout outcomes, orphan provider events,
per-record ledger/provider drift) and only ever *records* a
`PaymentReconciliationAnomaly` row for human review — it never mutates
money or historical records. `STAKE_LIMIT`/`DEPOSIT_LIMIT`-style amount
checks are per-action ceilings, not rolling-period sums (see ADR-021).

### Production activation guardrails
Selecting `PAYMENTS_PROVIDER=monime` is not enough on its own for a
*live* call to happen. `MonimeProvider` inspects the configured token's
prefix: `mon_test_...` always runs (test credentials are safe by
design); a non-test `mon_...` token additionally requires
`MONIME_LIVE_PAYMENTS_ENABLED=true`. This means flipping one
configuration value by accident can never silently start making real
payment-provider calls — two independent, deliberate choices are
required. There is no fallback to `ManualProvider`/a fake provider
during a live operation: an unready `MonimeProvider` returns
`UNAVAILABLE`/`FAILED`, never a fabricated success.

## Open/Unverified — kept fail-closed, not guessed

The exact byte string Monime's `Monime-Signature` header HMAC-SHA256
covers is not verifiable against any source reachable during this
implementation (the official HMAC-verification guide page renders only a
client-side loading placeholder to automated fetches, and no SDK source
was reachable either). The algorithm itself **is** confirmed (the
official OpenAPI schema names a `hmac256` verification method).
`MonimeProvider.verifyWebhookSignature` therefore **always returns
invalid** — extending, never weakening, the exact fail-closed stance
Phase 3 shipped. The payload-*parsing* logic
(`parseMonimeWebhookPayload`) is implemented and unit-tested independently
of the signature check — but see the next paragraph: the completed-payment
part of it is provisional, so the HMAC computation is **not** the only work
remaining.

**The Monime paid-amount field path is provisional and unverified.**
`MonimeProvider` maps `payment_code.completed` to a deposit completion only
if the event carries `data.progress.totalPaymentSum` (`{ currency, value }`,
`value` an integer in the currency's minor unit, `SLE 1 = 100`) — the amount
actually **paid**. It deliberately never uses `data.amount`, the payment
code's *configured* amount, as a substitute: that says what was asked for, not
what was paid. If the paid total is absent or malformed the parsed payload is
`null`, the event is stored `IGNORED` (and shows as an
`ORPHAN_PROVIDER_EVENT`) and nothing is completed — fail-closed. These field
names come from Monime's public documentation (the webhook "Structure and
Events" page, whose `data` is the REST Payment Code object), **not from a
captured delivery**, and the documentation is internally inconsistent (sample
payloads are `apiVersion 2024-08-01`, the object pages `caph-2025-08-23`, and
they name the processed-payment field differently) and silent on partial and
over-payments, fees and whether our own reference is echoed. Before the parser
is treated as finalized, one real Test-mode `payment_code.completed` delivery
must be captured and checked for: the actual paid-amount field and its name;
whether the paid amount can differ from the configured one; the currency
fields; and whether our reference or only the payment-code id is echoed. Until
then, together with the signature gap above, **the Monime integration is not
production-ready**.

## USER ACTION REQUIRED

See `docs/development/PHASE_6_CHECKLIST.md` §1 for the full table.
Summary: confirm PlayLe's business model is Monime-eligible; create a
Monime Space and a **Test** Personal Access Token (sufficient for
everything in this phase); capture one real Test-mode webhook delivery
(via `monime-cli`'s Webhook Inspector) or otherwise confirm the HMAC
canonical string; confirm Payment Codes vs. Checkout Sessions as the
intended UX; confirm the payout destination field names
(`destination.providerId` + type-specific field) against one real test
payout before any live use.

## Alternatives Considered
- **Guessing the HMAC canonical string from a similarly-named but
  unrelated provider's documented scheme** (a web search for "Monime
  webhook signature" surfaced results about "MONEI", an unrelated
  Spanish payment company) — explicitly rejected; recognized and flagged
  as a fabrication trap during implementation.
- **Implementing Checkout Sessions instead of/alongside Payment Codes**
  — deferred, not rejected; Payment Codes alone matches the current
  mobile-only product surface with no over-building.
- **A single `LIVE_PAYMENTS_ENABLED` flag covering everything** —
  rejected per the spec's explicit "no single flag enables every
  capability" guardrail; test-vs-live readiness and
  `REAL_MONEY_GAMING_ENABLED`/`ELIGIBILITY_POLICY_CONFIGURED` (ADR-021)
  are kept independent.

## Consequences
- PlayLe can accept a real Monime **test**-mode deposit/payout today,
  end-to-end, once the owner supplies a Space id and test token — no
  further code changes required for that.
- A live Monime deposit cannot be credited automatically until the
  webhook signature gap is resolved; a live payout can be *submitted*
  but its webhook-driven confirmation has the same gap. Both still fail
  closed rather than fabricating success.
- Adding a second future payment provider means one new
  `PaymentProviderPort` implementation — no change to
  `DepositsService`/`WithdrawalsService`/the ledger/reconciliation.
