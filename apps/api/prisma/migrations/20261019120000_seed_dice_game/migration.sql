-- Seed data (hand-added, not expressible via Prisma's schema language):
-- Phase 10 adds Dice as a third game, implemented at src/games/dice/ (see
-- docs/decisions/ADR-025-dice-game-module.md). No schema change is needed
-- — the module's state lives in the existing opaque `Match.state` JSON
-- column, same as Tic-Tac-Toe and Checkers.
--
-- Seeded DISABLED: implementing the game is not the same as authorizing
-- its launch. Dice is a pure game of chance, so enabling it (and above
-- all enabling it for real money) needs the owner's separate legal and
-- payment-provider confirmation first — see ADR-025 and
-- docs/development/OUTSTANDING_WORK.md. Enabling is a deliberate catalog
-- change (`UPDATE "games" SET "enabled" = true WHERE "id" = 'dice'`), never
-- an implicit side effect of deploying this migration.
--
-- Unlike the Phase 7 Checkers seed, this row sets `turnTimeoutSeconds`
-- explicitly (ADR-024): a roll is a single tap, so 30 seconds is the
-- approved turn clock rather than the 60 seconds the board games use.
INSERT INTO "games" ("id", "displayName", "description", "minPlayers", "maxPlayers", "enabled", "version", "iconKey", "turnTimeoutSeconds", "createdAt", "updatedAt")
VALUES ('dice', 'Dice', 'Head-to-head dice duel — roll two dice each round, highest total wins the round, first to win two rounds takes the match.', 2, 2, false, 1, 'dice', 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
