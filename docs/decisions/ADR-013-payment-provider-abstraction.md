# ADR-013: Payment Provider Abstraction & Monime Status

## Status
Accepted — Phase 3 (abstraction implemented; Monime integration pending verified access)

## Context
PlayLe's wallet/ledger (ADR-012) must never be rebuilt around a specific
payment processor's model. Monime is the intended first external
provider for Sierra Leone mobile-money deposits/payouts, but as of this
implementation:

- No official Monime developer documentation, API reference, endpoint
  list, request/response shapes, webhook format, or signature scheme was
  publicly findable (confirmed via web search — results returned generic
  Sierra-Leone-fintech marketing pages describing Monime's business
  model, not developer docs).
- No PlayLe Monime account, merchant verification, API credentials, or
  production/sandbox access exists.
- PlayLe's real-money 16+ competitive-gaming model has not been confirmed
  as eligible for Monime's service.

Per the Phase 3 specification, none of this may be guessed at or faked.

## Decision

### The abstraction
`src/payments/ports/payment-provider.port.ts` defines `PaymentProviderPort`
(`initiateDeposit`, `verifyWebhookSignature`). `DepositsService` and
`WithdrawalsService` depend only on this interface — never on a
provider-specific type or endpoint shape — selected via a DI token
(`PAYMENT_PROVIDER`) factory reading `PAYMENTS_PROVIDER` from config.

### Active implementation: `ManualProvider`
`PAYMENTS_PROVIDER=manual` (the default) is the real, active provider
today. It issues an internal reference and makes **no network call** —
deposits stay `PENDING` until confirmed out-of-band. This is an honest
reflection of current reality: PlayLe has no live payment gateway yet,
not a simulated success.

### `MonimeProvider`: a deliberately inert boundary
`MonimeProvider` (`PAYMENTS_PROVIDER=monime`) exists to prove the
architecture is ready, but:
- `initiateDeposit` **never makes a real HTTP call**, regardless of
  whether `MONIME_API_KEY` is configured — there is no verified endpoint
  to call. It returns `{ status: 'UNAVAILABLE' }` and logs why.
- `verifyWebhookSignature` **always fails closed** (`{ valid: false }`) —
  Monime's real signature scheme is unverified, so nothing can be
  trusted yet.

Both behaviors are unit-tested (`monime.provider.spec.ts`) to assert the
"no network call, no acceptance" contract holds even with credentials
present — guarding against a future edit accidentally wiring in an
unverified real call.

### Testing the architecture without a real provider
A deterministic `FakePaymentProvider` (test-only, `test/fake-payment-provider.ts`)
is bound in place of `PAYMENT_PROVIDER` in e2e tests. It's what proves the
full webhook → `ProviderEvent` → `DepositsService.completeFromProviderEvent`
→ `LedgerService.applyEntry` path genuinely works, independent of whether
Monime itself is reachable.

### Webhook endpoint
`POST /payments/webhooks/monime` exists, has no `JwtAuthGuard` (the
caller is external), and uses the app's `rawBody` capture
(`main.ts`'s `NestFactory.create(AppModule, { rawBody: true })`) so a
future real signature check can hash the exact bytes received. Every
delivery attempt — valid, invalid, or duplicate — is recorded in
`ProviderEvent` for audit, per the spec's webhook-security requirements.

## USER ACTION REQUIRED

See `docs/development/MONIME_SETUP.md` for the full phased checklist.
Summary: creating a Monime account, merchant/business verification,
confirming PlayLe's gaming model and 16+ age model are eligible, and
obtaining sandbox/production credentials are all steps **the project
owner must take outside this codebase** — none of this can be verified
or completed by an automated implementation. Every step whose details
aren't independently verifiable from public information is explicitly
marked `VERIFY WITH MONIME` in that document.

## Alternatives Considered
- **Implementing a best-guess Monime HTTP client** based on typical
  West-African payment-aggregator API conventions — explicitly rejected
  by the Phase 3 specification ("do not invent Monime APIs... do not put
  fake API calls... into production code") and by this ADR: a guessed
  integration that happens to compile is more dangerous than an honest
  gap, because it could silently fail against real traffic or, worse,
  appear to work against a sandbox that doesn't match production.
- **Skipping the provider abstraction until Monime access exists** —
  rejected: building `DepositsService`/`WithdrawalsService` directly
  against "no provider" would require a rewrite later; the interface
  costs little now and removes that risk.

## Consequences
- PlayLe cannot accept a real mobile-money deposit or send a real payout
  until `MonimeProvider` (or another provider) is implemented against
  verified documentation and credentials.
- Adding a second future provider (per the spec's "Provider B" scenario)
  means writing one new class implementing `PaymentProviderPort` — no
  change to `DepositsService`, `WithdrawalsService`, the wallet, or the
  ledger.
