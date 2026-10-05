import { ApiProperty } from '@nestjs/swagger';
import { DepositStatus, type Deposit } from '@prisma/client';
import { toAmountString } from '../../common/money.js';

export class DepositResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() amountMinor!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: DepositStatus }) status!: DepositStatus;
  @ApiProperty() provider!: string;
  @ApiProperty({ nullable: true, type: String }) providerReference!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) failureReason!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export function toDepositResponse(deposit: Deposit): DepositResponseDto {
  return {
    id: deposit.id,
    amountMinor: toAmountString(deposit.amountMinor),
    currency: deposit.currency,
    status: deposit.status,
    provider: deposit.provider,
    providerReference: deposit.providerReference,
    failureReason: deposit.failureReason,
    createdAt: deposit.createdAt,
    updatedAt: deposit.updatedAt,
  };
}
