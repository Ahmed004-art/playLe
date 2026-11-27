import { ApiProperty } from '@nestjs/swagger';
import { WithdrawalStatus, type Withdrawal } from '@prisma/client';
import { toAmountString } from '../../common/money.js';

export class WithdrawalResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() amountMinor!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: WithdrawalStatus }) status!: WithdrawalStatus;
  @ApiProperty() destinationDetails!: Record<string, unknown>;
  @ApiProperty({ nullable: true, type: String }) reviewedByAdminId!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) reviewReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) providerReference!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) failureReason!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

/**
 * Admin view of a withdrawal: what an admin can do about its payout (see
 * `PayoutCheck` in withdrawals.service.ts). `null` once the withdrawal is no
 * longer APPROVED or PROCESSING.
 */
export class AdminWithdrawalResponseDto extends WithdrawalResponseDto {
  @ApiProperty({
    enum: ['NONE', 'CHECK_WITH_PROVIDER', 'UNVERIFIABLE'],
    nullable: true,
  })
  payoutCheck!: 'NONE' | 'CHECK_WITH_PROVIDER' | 'UNVERIFIABLE' | null;
}

export function toWithdrawalResponse(
  withdrawal: Withdrawal,
): WithdrawalResponseDto {
  return {
    id: withdrawal.id,
    amountMinor: toAmountString(withdrawal.amountMinor),
    currency: withdrawal.currency,
    status: withdrawal.status,
    destinationDetails: withdrawal.destinationDetails as Record<
      string,
      unknown
    >,
    reviewedByAdminId: withdrawal.reviewedByAdminId,
    reviewReason: withdrawal.reviewReason,
    providerReference: withdrawal.providerReference,
    failureReason: withdrawal.failureReason,
    createdAt: withdrawal.createdAt,
    updatedAt: withdrawal.updatedAt,
  };
}
