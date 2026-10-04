# ADR-010: Platform & Market Strategy

## Status
Accepted — Phase 1

## Context
PlayLe is a Sierra Leone-first social gaming platform with real-money
staking. The initial platform, currency, and payment rails must be chosen
without locking the architecture into a single market or player count.

## Decision
- **Market**: Launch targeting Sierra Leone. Currency handling, mobile-money
  providers, and localization start Sierra-Leone-specific but are modeled
  so additional currencies/countries can be added later without a rewrite
  (e.g. currency is a field/config, not a hardcoded assumption baked into
  business logic).
- **Currency**: Sierra Leonean Leone (SLE) is the initial and only
  supported currency in early phases.
- **Payments**: Deposits/withdrawals will integrate Sierra Leone
  mobile-money providers (e.g. Orange Money, Africell Money). Withdrawals
  require administrator approval initially (manual review before
  automation). None of this is implemented in Phase 1.
- **Mobile platform**: Android first. The Flutter architecture keeps iOS
  buildable from day one (ADR-002) so iOS can follow shortly after launch.
- **Match sizes**: Architecture supports 2, 3, and 4-player matches from
  the start, modeled so larger player counts can be added later without
  restructuring match/ledger data models (player count is a parameter, not
  a hardcoded 1v1 assumption).
- **External games**: The architecture anticipates eventually organizing
  competitions around external games (e.g. Free Fire) where PlayLe manages
  players/stakes/results rather than running the game itself. Not
  implemented or assumed to have a uniform API in Phase 1 (see
  `docs/architecture/GAME_ENGINE.md`, Section 27 of the project spec).

## Alternatives Considered
- **Multi-currency from day one** — adds real complexity (FX, provider
  integrations) with no current market need; rejected for Phase 1 in favor
  of a currency model that doesn't *prevent* it later.
- **iOS and Android simultaneously** — rejected; Android-first matches the
  target market's device landscape and lets the team validate the product
  before taking on iOS App Store review/build overhead.

## Consequences
- Any code that assumes "the currency" or "two players" as a hardcoded
  constant is an architecture smell and should be flagged, not extended.
- Payment provider integration is isolated behind a Payments module
  boundary (not implemented yet) so providers can be added/swapped per
  market.
- Admin-approved withdrawals imply an admin review queue/workflow in the
  future Admin + Withdrawals modules; automation is an explicit future
  phase, not a Phase 1 assumption.
