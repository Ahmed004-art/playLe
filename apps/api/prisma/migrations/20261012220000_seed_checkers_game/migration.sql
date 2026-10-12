-- Seed data (hand-added, not expressible via Prisma's schema language):
-- Phase 7 adds Checkers as a second playable game, implemented at
-- src/games/checkers/ (see docs/decisions/ADR-022-checkers-game-module.md).
-- No schema change is needed — the module's state lives in the existing
-- opaque `Match.state` JSON column, same as Tic-Tac-Toe.
INSERT INTO "games" ("id", "displayName", "description", "minPlayers", "maxPlayers", "enabled", "version", "iconKey", "createdAt", "updatedAt")
VALUES ('checkers', 'Checkers', 'Classic 8x8 diagonal-capture strategy game — capture every piece, or leave your opponent with no legal move.', 2, 2, true, 1, 'checkers', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
