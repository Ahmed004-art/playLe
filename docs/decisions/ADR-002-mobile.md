# ADR-002: Mobile Framework — Flutter + Dart

## Status
Accepted — Phase 1

## Context
PlayLe launches on Android first, but the architecture must support iOS
shortly after without a rewrite. The app needs to support rich, animated,
game-like UI (boards, dice, real-time match state) and premium visual
polish across both platforms.

## Decision
Use **Flutter** with **Dart** (null safety enabled) for the mobile
application, targeting Android first while keeping the iOS project valid
and buildable from day one.

- Single codebase for Android and iOS avoids duplicated game-rendering and
  real-time logic across two native stacks.
- Flutter's rendering engine is well suited to the custom, animated,
  game-board UIs PlayLe will need (dice, checkers, ludo, etc.) compared to
  a standard native widget toolkit.
- Strong WebSocket and HTTP client support fits the server-authoritative
  real-time architecture.

## Alternatives Considered
- **Native Android (Kotlin) + native iOS (Swift) later** — doubles
  long-term implementation cost for game UIs and real-time state handling;
  rejected given the one-engineer implementation model and the requirement
  that iOS "follow shortly after" Android.
- **React Native** — viable alternative, but Flutter's custom-painting and
  animation performance is a better fit for game-board rendering, and the
  team has standardized on Flutter for this project.

## Consequences
- Flutter/Dart code cannot directly consume the TypeScript `packages/shared`
  contracts (see ADR-007 and `docs/architecture/PROJECT_STRUCTURE.md`).
  Cross-platform contracts will flow through OpenAPI-generated or
  hand-written Dart models in a later phase.
- The team must maintain Flutter/Dart tooling (Flutter SDK, Android SDK,
  and eventually Xcode for iOS builds) alongside the Node.js toolchain.
- iOS builds require a macOS build environment at release time; Phase 1
  only guarantees the iOS Xcode project remains valid, not that it has been
  built on this (Windows) development machine.
