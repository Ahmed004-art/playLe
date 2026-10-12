# Phase 7 Implementation Checklist — Repository Audit, Game Design
# System & Checkers

Living checklist, updated as each item lands. See the Phase 7 report
(delivered in chat at the end of this phase) for the authoritative
end-state summary, and `docs/development/OUTSTANDING_WORK.md` for the
durable cross-phase register this phase both fed into and consulted.

## 0. Stage A — Repository Audit

- [x] Verified git state (branch, working tree, HEAD, recent commits)
      directly — not assumed from any prior report.
- [x] Independently re-verified the owner-supplied Phase 6 CI claim
      (run `38296384444`) via the GitHub API: `head_sha` matches HEAD,
      `conclusion: success`, all three jobs individually `success`.
      Accurate.
- [x] Surveyed the mobile design system/Tic-Tac-Toe implementation (via
      a dedicated Explore agent, verified line-by-line): confirmed the
      design system was close to nonexistent (8 colors, 4 text styles,
      no spacing/radius/duration tokens), the only shared widget was
      `StatusBadge`, and all of Tic-Tac-Toe's generic chrome was private
      inside one file.
- [x] Surveyed the backend game-platform architecture (via a dedicated
      Explore agent, verified line-by-line): confirmed `GameModule`/
      `GameRegistry`/matchmaking/challenges/realtime/settlement are
      genuinely game-agnostic, and surfaced two real pre-existing race
      conditions (see item 12 in `OUTSTANDING_WORK.md`) plus several
      lower-severity gaps (no turn timer, binary `GameResult`,
      matchmaking's `WAITING`-blind "already in a match" check).
- [x] Both race conditions fixed and reverified (47 existing tests
      passing) *before* any Checkers-specific work began.
- [x] Audit report (verified architecture, existing components,
      defects, test counts, outstanding work, proposed plan) delivered
      in chat before implementation started.

## 1. Stage B — Shared Mobile Game Design System

- [x] `AppSpacing`/`AppRadii`/`AppMotion` tokens
      (`apps/mobile/lib/core/theme/`) — **Complete**. Replace the
      previously-hardcoded 4/6/8/10/12/16/20/24/32 spacing values and
      10/14/16/20 radii with a fixed scale.
- [x] Board/piece/king color tokens added to `AppColors` — **Complete**:
      `boardLight`/`boardDark`/`pieceP1`/`pieceP2`/`kingAccent`.
      Deliberately restrained: pieces reuse the existing primary/
      secondary "player 1 / player 2" convention Tic-Tac-Toe's X/O
      already established, rather than inventing new per-game colors.
- [x] `FilledButton`/`OutlinedButton` explicitly themed — **Complete**.
      The previous `elevatedButtonTheme` was dead code (no screen uses
      `ElevatedButton`); replaced with themes for the buttons every
      screen actually uses.
- [x] Missing text styles (`headlineSmall`/`titleSmall`/`labelSmall`)
      added to the theme — **Complete**; screens already used them and
      were silently falling back to untouched Material 3 defaults.
- [x] Shared `LoadingView`/`ErrorRetryView`/`EmptyStateView`
      (`apps/mobile/lib/core/widgets/`) — **Complete**, consolidating
      three previously copy-pasted patterns. Wired into `MatchScreen`
      (the generic match entry point every game goes through).
- [x] `SurfaceCard` (`apps/mobile/lib/core/widgets/surface_card.dart`)
      — **Complete**, consolidating the repeated "surface container"
      pattern (not yet adopted by every pre-existing call site —
      intentionally scoped to new/touched code, not a drive-by rewrite
      of unrelated screens).
- [x] Generic match chrome extracted out of Tic-Tac-Toe into
      `apps/mobile/lib/core/match/widgets/` — **Complete**:
      `MatchStatusBar`, `MatchStakeStatusBar`, `MatchResultBanner`,
      `FinancialResultBanner`, `DisputeReasonDialog`. `TicTacToeScreen`
      rewritten to use them; all 15 pre-existing Tic-Tac-Toe tests still
      pass unchanged, proving the extraction was behavior-preserving.
      Checkers reuses every one of these directly.

## 2. Stage C — Checkers Backend

- [x] `GameModule` contract re-read in full before writing any code —
      confirmed via the audit above.
- [x] `apps/api/src/games/checkers/checkers.types.ts` — **Complete**:
      `CheckersState` (explicit `currentTurn`/`mustContinueFrom`/
      `movesSinceProgress`, unlike Tic-Tac-Toe's derived turn), `Coord`,
      `CheckersPiece`, `CheckersMove`, `DRAW_NO_PROGRESS_LIMIT`.
- [x] `apps/api/src/games/checkers/checkers.module-impl.ts` —
      **Complete**: standard American/English rules (non-flying kings,
      forward-only men, mandatory capture, forced multi-jump
      continuation, promotion-ends-the-turn, the 40-move no-progress
      draw rule) — see
      [ADR-022](../decisions/ADR-022-checkers-game-module.md) for every
      rule choice and its rationale.
- [x] Registered in `GamesModule`'s `GAME_MODULES` factory array,
      mirroring `TicTacToeModule` exactly — **Complete**. Zero changes
      to `GameRegistry`, `MatchesService`, matchmaking, challenges, or
      realtime.
- [x] Seed migration `20261012220000_seed_checkers_game` — **Complete**,
      applied and verified against the local Postgres test database
      (hand-written INSERT, same pattern as the original `tic_tac_toe`
      seed). No schema/column changes — Checkers reuses the existing
      opaque `Match.state` JSON column.
- [x] Unit test suite,
      `checkers.module-impl.spec.ts` — **Complete, 35/35 passing**.
      Covers every bullet in the master prompt's rules checklist:
      initial setup/player assignment, valid/invalid moves, out-of-turn,
      malformed payloads, mandatory capture, multi-jump continuation
      (including rejecting a wrong-piece or simple-move attempt mid-
      continuation), king promotion (including the "promotion ends the
      turn even with a further jump available" rule), king
      forward/backward movement, win by no-remaining-pieces, win by
      no-legal-move, the 40-move draw, the no-progress-counter reset
      rule, and state serialization round-trip.
- [x] E2e test suite, `apps/api/test/checkers.e2e-spec.ts` — **Complete,
      17/17 passing** against real Postgres, through the real HTTP
      API (not a second test harness): game catalog, initial board/turn
      via `GET /matches/:id`, a real opening move, out-of-turn
      rejection, non-diagonal rejection, malformed-payload rejection,
      non-participant 404, mandatory-capture enforcement via REST,
      multi-jump continuation via REST (including proving the opponent
      cannot move mid-continuation), king promotion via REST, rejection
      of any move after completion, idempotent retry, concurrent-move
      race (exactly one accepted), **a staked win settling through the
      exact same `SettlementService` math Tic-Tac-Toe already proves**
      (pool 2000, fee 200, winner receives 1800), **a staked draw
      refunding both players** via the existing settlement path, and
      forfeiture via the existing disconnect/abandonment sweep
      (`MatchTimeoutService.sweep()` called directly, mirroring
      `match-stakes.e2e-spec.ts`'s own convention).
- [x] Two pre-existing bugs found during the audit, fixed before
      Checkers-specific work began (see `OUTSTANDING_WORK.md` item 12):
      `MatchTimeoutService`'s two sweep `updateMany` calls lacked a
      status guard; `ChallengesService.accept` emitted before its
      transaction committed. Both fixed, both reverified against the
      existing 47-test matches/match-stakes/realtime suite.

## 3. Stage C — Checkers Mobile UI

- [x] `apps/mobile/lib/features/checkers/checkers_models.dart` —
      **Complete**: typed parse of the opaque `Match.state` JSON into
      `CheckersBoardState`/`CheckersPiece`/`Coord`.
- [x] `checkers_board.dart` — **Complete**: 8x8 board, correct light/
      dark square rendering, pieces colored absolutely by seat (the
      same convention as Tic-Tac-Toe's X/O — both players see identical
      colors; only the status bar's "Your pieces" label differs per
      viewer), a king crown icon with a brief entrance animation,
      selection-ring highlighting, legal-move dot hints (cosmetic-only —
      the server independently re-validates every move, exactly like
      Tic-Tac-Toe's `findWinningLine`), and board flipping so each
      player always sees their own pieces at the bottom.
- [x] `checkers_screen.dart` — **Complete**: tap-to-select/tap-to-move
      interaction, forced-continuation handling (selection locked to the
      piece that must continue jumping, with "Continue your jump —
      another capture is available" guidance text), haptics, reuses
      every extracted shared-chrome widget (status bar, stake strip,
      plain and financial result banners, dispute dialog) identically
      to Tic-Tac-Toe.
- [x] Wired into `MatchScreen`'s dispatch
      (`apps/mobile/lib/features/games/match_screen.dart`) — one new
      `case 'checkers'`, same pattern as Tic-Tac-Toe's own case; the
      `onMove` adapter builds `{from: {row,col}, to: {row,col}}`.
- [x] Mobile test suite — **Complete**: `checkers_board_test.dart` (8
      tests: piece/king rendering, tap→coordinate mapping including
      through the flip, disabled-board no-op, the cosmetic legal-
      destination calculator for a man's step/jump and a king's
      backward move) and `checkers_screen_test.dart` (13 tests: turn
      text, select-then-tap submits the move payload, multi-jump
      continuation guidance and piece-locking, disabled-once-finished,
      plain and financial win/draw banners, free-play vs. staked stake-
      bar visibility, the dispute flow) — **21/21 passing**.
      Tic-Tac-Toe's own 15 tests (and all 83 other pre-existing mobile
      tests) still pass unchanged — **98/98 pre-existing + 21 new =
      119/119**.
- [x] `flutter analyze` — **Complete, 0 issues**.
- [x] `dart format --set-exit-if-changed` — **Complete, clean**.
- [x] `flutter build apk --debug` — **Complete, succeeded**.

## 4. Full-repository verification

- [x] Backend: lint, typecheck, format check, build, 133+35=168 unit
      tests, 147+17=164 non-Redis-dependent e2e tests (the remaining 10
      require a local Redis this sandbox doesn't have — pre-existing,
      documented, passes in CI's real Redis service container) — all
      passing locally.
- [x] Admin: lint, typecheck, build, 31 tests — all passing (Phase 7
      touched zero admin files; this is a regression check, not new
      work).
- [x] Mobile: analyze, format check, 119 tests, Android debug build —
      all passing.
- [ ] Real GitHub Actions run — pending the commit/push below; will be
      independently verified via the GitHub API (not assumed from a
      local pass) before this phase is declared complete.

## 5. Documentation

- [x] [ADR-022](../decisions/ADR-022-checkers-game-module.md) — the
      Checkers rules engine and design-system extraction decisions.
- [x] `docs/development/OUTSTANDING_WORK.md` (new) — the durable,
      cross-phase register: every Phase 6 item preserved verbatim-in-
      substance, plus the two fixed race conditions and the lower-
      severity gaps found during this phase's audit.
- [x] `CLAUDE.md`, `README.md` — Current Phase, "What NOT to Build Yet",
      and the roadmap updated for Phase 7.
- [x] `docs/architecture/GAME_ENGINE.md` — Checkers marked implemented;
      the "why a common interface" section updated to cite a second,
      materially different game as proof.
- [x] `docs/architecture/PROJECT_STRUCTURE.md`,
      `docs/architecture/OVERVIEW.md` — new directories/design-system
      pieces listed.
- [x] `docs/database/README.md` — the one seed migration documented;
      explicit that no schema changed.
- [x] `docs/api/README.md` — the game-platform endpoints' table updated
      to note Checkers' `payload` shape; Phase Scope updated.
- [x] `docs/architecture/SECURITY.md` — Phase 7 banner/dependency-audit
      update added; **two stale claims found and corrected** during this
      pass (the mobile sessions UI and the `qr_flutter` dependency were
      both already shipped in Phase 6 but still described as missing —
      fixed per this phase's "verify, don't assume" mandate).

This file is updated as each item lands; see the final Phase 7 report
for the authoritative end-state.
