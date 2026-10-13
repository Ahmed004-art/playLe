-- CreateIndex
CREATE INDEX "ledger_entries_userId_type_createdAt_idx" ON "ledger_entries"("userId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "settlement_entries_userId_role_createdAt_idx" ON "settlement_entries"("userId", "role", "createdAt");
