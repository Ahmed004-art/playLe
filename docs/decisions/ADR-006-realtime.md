# ADR-006: Real-Time Communication — WebSockets / Socket.IO

## Status
Accepted — Phase 1

## Context
Competitive matches (dice, checkers, ludo, etc.) require low-latency,
bidirectional communication between clients and a server-authoritative game
engine: player actions must reach the server quickly, and resulting state
changes must be pushed to all participants immediately.

## Decision
Use **WebSockets via Socket.IO** (`@nestjs/websockets` +
`@nestjs/platform-socket.io`) for real-time communication between the
Flutter mobile app and the NestJS API.

- Socket.IO provides reconnection handling, room/namespace support (useful
  for per-match channels), and graceful fallback behavior, reducing the
  amount of custom transport-layer code the team must write and maintain.
- First-class NestJS gateway support keeps real-time handlers inside the
  same modular, DI-driven architecture as the REST API.
- Works with a Redis adapter for multi-instance pub/sub fan-out in the
  future, consistent with ADR-005.

## Alternatives Considered
- **Raw WebSocket (`ws`)** — lighter weight, but reconnection, rooms, and
  fallback handling would need to be hand-built and maintained.
- **Server-Sent Events** — one-directional only; unsuitable for
  low-latency bidirectional player actions.
- **Polling** — too high latency for competitive real-time games; rejected.

## Consequences
- The server remains the sole authority over game state (see
  `docs/architecture/GAME_ENGINE.md`); clients only render state pushed by
  the server and send intended actions.
- Phase 1 establishes gateway infrastructure, connection lifecycle,
  authentication architecture, and event-naming conventions only — no
  actual game events are implemented.
- Horizontal scaling of WebSocket connections will require the Redis
  adapter for Socket.IO in a later phase.
