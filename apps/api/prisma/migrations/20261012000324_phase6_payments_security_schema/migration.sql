-- CreateEnum
CREATE TYPE "ProviderOperationKind" AS ENUM ('DEPOSIT_INITIATE', 'DEPOSIT_STATUS_CHECK', 'PAYOUT_SUBMIT', 'PAYOUT_STATUS_CHECK');

-- CreateEnum
CREATE TYPE "ProviderOperationStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PaymentAnomalyType" AS ENUM ('DEPOSIT_CREDITED_WITHOUT_PROVIDER_CONFIRMATION', 'DEPOSIT_PROVIDER_CONFIRMED_NOT_CREDITED', 'WITHDRAWAL_PROVIDER_PAID_NOT_COMPLETED', 'WITHDRAWAL_COMPLETED_WITHOUT_PROVIDER_CONFIRMATION', 'DUPLICATE_PROVIDER_REFERENCE', 'AMOUNT_MISMATCH', 'STUCK_PROCESSING', 'ORPHAN_PROVIDER_EVENT', 'UNKNOWN_PAYOUT_OUTCOME', 'LEDGER_PROVIDER_DRIFT');

-- CreateEnum
CREATE TYPE "PaymentAnomalyStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "VerificationChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "VerificationPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PHONE_VERIFICATION');

-- CreateEnum
CREATE TYPE "ResponsibleGamingRestrictionType" AS ENUM ('SELF_EXCLUSION', 'DEPOSIT_LIMIT', 'STAKE_LIMIT', 'LOSS_LIMIT', 'COOLING_OFF');

-- CreateEnum
CREATE TYPE "ResponsibleGamingRestrictionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'LIFTED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DEPOSIT_COMPLETED', 'DEPOSIT_FAILED', 'WITHDRAWAL_SUBMITTED', 'WITHDRAWAL_COMPLETED', 'WITHDRAWAL_FAILED', 'SELF_EXCLUSION_ACTIVATED', 'PASSWORD_RESET_REQUESTED', 'VERIFICATION_CODE_ISSUED');

-- CreateEnum
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "DepositStatus" ADD VALUE 'EXPIRED';

-- AlterEnum
ALTER TYPE "WithdrawalStatus" ADD VALUE 'PROCESSING';

-- AlterTable
ALTER TABLE "provider_events" ADD COLUMN     "relatedWithdrawalId" TEXT;

-- CreateTable
CREATE TABLE "provider_operations" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" "ProviderOperationKind" NOT NULL,
    "relatedDepositId" TEXT,
    "relatedWithdrawalId" TEXT,
    "providerIdempotencyKey" TEXT NOT NULL,
    "status" "ProviderOperationStatus" NOT NULL DEFAULT 'PENDING',
    "requestSnapshot" JSONB,
    "responseSnapshot" JSONB,
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "provider_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_reconciliation_anomalies" (
    "id" TEXT NOT NULL,
    "type" "PaymentAnomalyType" NOT NULL,
    "relatedDepositId" TEXT,
    "relatedWithdrawalId" TEXT,
    "details" JSONB NOT NULL,
    "status" "PaymentAnomalyStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedByAdminId" TEXT,
    "resolutionNote" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "payment_reconciliation_anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "requestIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_challenges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "VerificationChannel" NOT NULL,
    "purpose" "VerificationPurpose" NOT NULL,
    "target" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_totp_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_totp_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" TEXT NOT NULL,
    "mfaTotpCredentialId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responsible_gaming_restrictions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ResponsibleGamingRestrictionType" NOT NULL,
    "status" "ResponsibleGamingRestrictionStatus" NOT NULL DEFAULT 'ACTIVE',
    "config" JSONB NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "liftedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responsible_gaming_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_operations_providerIdempotencyKey_key" ON "provider_operations"("providerIdempotencyKey");

-- CreateIndex
CREATE INDEX "provider_operations_status_idx" ON "provider_operations"("status");

-- CreateIndex
CREATE INDEX "provider_operations_relatedDepositId_idx" ON "provider_operations"("relatedDepositId");

-- CreateIndex
CREATE INDEX "provider_operations_relatedWithdrawalId_idx" ON "provider_operations"("relatedWithdrawalId");

-- CreateIndex
CREATE INDEX "payment_reconciliation_anomalies_status_idx" ON "payment_reconciliation_anomalies"("status");

-- CreateIndex
CREATE INDEX "payment_reconciliation_anomalies_type_idx" ON "payment_reconciliation_anomalies"("type");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

-- CreateIndex
CREATE INDEX "verification_challenges_userId_idx" ON "verification_challenges"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_totp_credentials_userId_key" ON "mfa_totp_credentials"("userId");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_mfaTotpCredentialId_idx" ON "mfa_recovery_codes"("mfaTotpCredentialId");

-- CreateIndex
CREATE INDEX "responsible_gaming_restrictions_userId_idx" ON "responsible_gaming_restrictions"("userId");

-- CreateIndex
CREATE INDEX "responsible_gaming_restrictions_status_idx" ON "responsible_gaming_restrictions"("status");

-- CreateIndex
CREATE INDEX "notification_outbox_status_idx" ON "notification_outbox"("status");

-- AddForeignKey
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_relatedWithdrawalId_fkey" FOREIGN KEY ("relatedWithdrawalId") REFERENCES "withdrawals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_operations" ADD CONSTRAINT "provider_operations_relatedDepositId_fkey" FOREIGN KEY ("relatedDepositId") REFERENCES "deposits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_operations" ADD CONSTRAINT "provider_operations_relatedWithdrawalId_fkey" FOREIGN KEY ("relatedWithdrawalId") REFERENCES "withdrawals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reconciliation_anomalies" ADD CONSTRAINT "payment_reconciliation_anomalies_relatedDepositId_fkey" FOREIGN KEY ("relatedDepositId") REFERENCES "deposits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reconciliation_anomalies" ADD CONSTRAINT "payment_reconciliation_anomalies_relatedWithdrawalId_fkey" FOREIGN KEY ("relatedWithdrawalId") REFERENCES "withdrawals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reconciliation_anomalies" ADD CONSTRAINT "payment_reconciliation_anomalies_resolvedByAdminId_fkey" FOREIGN KEY ("resolvedByAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_challenges" ADD CONSTRAINT "verification_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_totp_credentials" ADD CONSTRAINT "mfa_totp_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_mfaTotpCredentialId_fkey" FOREIGN KEY ("mfaTotpCredentialId") REFERENCES "mfa_totp_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsible_gaming_restrictions" ADD CONSTRAINT "responsible_gaming_restrictions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
