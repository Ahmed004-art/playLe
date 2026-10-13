-- Seed data (hand-added, not expressible via Prisma's schema language):
-- Phase 9 adds a server-trusted turn-clock length to the game catalog
-- (see docs/decisions/ADR-024-match-lifecycle-integrity.md). Both
-- existing games get an explicit value rather than relying on the
-- column's NULL default staying unset by accident — 60 seconds is a
-- deliberately generous default for a simple turn-based move (not an
-- aggressive timeout that makes normal play unusable).
UPDATE "games" SET "turnTimeoutSeconds" = 60 WHERE "id" IN ('tic_tac_toe', 'checkers');
