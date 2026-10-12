import { ApiProperty } from '@nestjs/swagger';
import { DepositStatus, type Deposit } from '@prisma/client';
import { toAmountString } from '../../common/money.js';
import type { DepositPaymentInstructions } from '../deposits.service.js';

export class DepositPaymentInstructionsDto {
  @ApiProperty({ required: false }) ussdCode?: string;
  @ApiProperty({ required: false }) expiresAt?: string;
}

export class DepositResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() amountMinor!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: DepositStatus }) status!: DepositStatus;
  @ApiProperty() provider!: string;
  @ApiProperty({ nullable: true, type: String }) providerReference!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) failureReason!: string | null;
  @ApiProperty({ required: false, type: DepositPaymentInstructionsDto })
  paymentInstructions?: DepositPaymentInstructionsDto;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export function toDepositResponse(
  deposit: Deposit,
  paymentInstructions?: DepositPaymentInstructions | null,
): DepositResponseDto {
  return {
    id: deposit.id,
    amountMinor: toAmountString(deposit.amountMinor),
    currency: deposit.currency,
    status: deposit.status,
    provider: deposit.provider,
    providerReference: deposit.providerReference,
    failureReason: deposit.failureReason,
    ...(paymentInstructions ? { paymentInstructions } : {}),
    createdAt: deposit.createdAt,
    updatedAt: deposit.updatedAt,
  };
}
