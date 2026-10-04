# ADR-008: Server-Authoritative Game & Financial State

## Status
Accepted — Phase 1

## Context
PlayLe matches involve real money. Any client-side authority over game
outcomes or balances creates a direct path to cheating and financial fraud.

## Decision
The server is the **sole authority** over:

- Game session state (board state, turn order, valid moves, outcomes).
- Wallet balances and the financial ledger.
- Match results and prize-pool settlement.

Clients (mobile app, admin app) only:

1. Send intended actions to the server.
2. Render state that the server has validated and pushed.

No gameplay-affecting decision, balance change, or match outcome is ever
computed or trusted from client input directly. See the flow diagram in
`docs/architecture/GAME_ENGINE.md`.

## Alternatives Considered
- **Client-authoritative with server verification after the fact** —
  common in non-monetary casual games, but unacceptable here: a real-money
  platform cannot allow a compromised or modified client to determine its
  own win/loss or balance state even temporarily.
- **Hybrid (client predicts, server reconciles)** — reasonable for
  perceived responsiveness in later phases (client-side prediction of
  animations), but the reconciled, authoritative state must always come
  from the server. This remains compatible with this ADR and may be
  adopted as a UX optimization later without changing the authority model.

## Consequences
- All game and financial logic lives in the backend; the mobile app is a
  thin, honest renderer of server-pushed state plus an action sender.
- Every real-time action must be validated server-side before any state
  change or event emission (see WebSocket flow in Section 16 / ADR-006).
- This constrains future game implementations: a new game cannot ship
  with client-side win detection, even as a shortcut.
