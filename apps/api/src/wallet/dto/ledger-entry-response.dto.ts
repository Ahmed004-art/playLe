import { ApiProperty } from '@nestjs/swagger';
import { LedgerEntryType } from '@prisma/client';
import { toAmountString } from '../../common/money.js';
import type { LedgerEntryWithRelations } from '../wallet.service.js';

export class LedgerEntryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: LedgerEntryType }) type!: LedgerEntryType;
  @ApiProperty() availableDeltaMinor!: string;
  @ApiProperty() heldDeltaMinor!: string;
  @ApiProperty() availableBalanceAfterMinor!: string;
  @ApiProperty() heldBalanceAfterMinor!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ nullable: true, type: String }) relatedDepositId!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) relatedWithdrawalId!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) providerReference!:
    string | null;
  @ApiProperty() createdAt!: Date;
}

export function toLedgerEntryResponse(
  entry: LedgerEntryWithRelations,
): LedgerEntryResponseDto {
  return {
    id: entry.id,
    type: entry.type as LedgerEntryType,
    availableDeltaMinor: toAmountString(entry.availableDeltaMinor),
    heldDeltaMinor: toAmountString(entry.heldDeltaMinor),
    availableBalanceAfterMinor: toAmountString(
      entry.availableBalanceAfterMinor,
    ),
    heldBalanceAfterMinor: toAmountString(entry.heldBalanceAfterMinor),
    currency: entry.currency,
    reason: entry.reason,
    relatedDepositId: entry.relatedDepositId,
    relatedWithdrawalId: entry.relatedWithdrawalId,
    providerReference: entry.providerReference,
    createdAt: entry.createdAt,
  };
}
