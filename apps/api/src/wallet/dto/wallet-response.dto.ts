import { ApiProperty } from '@nestjs/swagger';
import type { Wallet } from '@prisma/client';
import { toAmountString } from '../../common/money.js';

export class WalletResponseDto {
  @ApiProperty({
    description: 'Spendable/withdrawable balance, in minor units.',
  })
  availableBalanceMinor!: string;

  @ApiProperty({
    description:
      'Reserved balance (e.g. a pending withdrawal), in minor units.',
  })
  heldBalanceMinor!: string;

  @ApiProperty({ description: 'availableBalanceMinor + heldBalanceMinor.' })
  totalBalanceMinor!: string;

  @ApiProperty({ example: 'SLE' })
  currency!: string;

  @ApiProperty()
  updatedAt!: Date;
}

export function toWalletResponse(wallet: Wallet): WalletResponseDto {
  return {
    availableBalanceMinor: toAmountString(wallet.availableBalanceMinor),
    heldBalanceMinor: toAmountString(wallet.heldBalanceMinor),
    totalBalanceMinor: toAmountString(
      wallet.availableBalanceMinor + wallet.heldBalanceMinor,
    ),
    currency: wallet.currency,
    updatedAt: wallet.updatedAt,
  };
}
